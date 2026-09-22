// Presentation only: preserve every JSON value, row, field and literal ID. This
// never chooses assets or changes the persisted reference/source artifacts.
const ROWS = "goldflow_literal_rows_v1";
const OBJECT = "goldflow_literal_object_v1";
const json = (value) => JSON.stringify(value);
const bytes = (value) => Buffer.byteLength(json(value), "utf8");

export function compactReferencePromptValue(value) {
  if (Array.isArray(value)) {
    const rows = value.map(compactReferencePromptValue);
    if (rows.length < 2 || value.some((row) => !row || typeof row !== "object" || Array.isArray(row))) return rows;
    const keys = Object.keys(rows[0]);
    // Do not conflate absent fields with explicit null/false/empty values.
    if (!rows.every((row) => json(Object.keys(row)) === json(keys))) return rows;
    const fields = [], constants = Object.create(null), sameAs = Object.create(null);
    for (const [index, key] of keys.entries()) {
      const earlier = keys.slice(0, index);
      const identical = earlier.find((field) => rows.every((row) => json(row[key]) === json(row[field])));
      const singleton = earlier.find((field) => rows.every((row) => (
        Array.isArray(row[key]) && row[key].length === 1 && json(row[key][0]) === json(row[field])
      )));
      if (identical !== undefined) sameAs[key] = identical;
      else if (singleton !== undefined) sameAs[key] = [singleton];
      else if (rows.every((row) => json(row[key]) === json(rows[0][key]))) constants[key] = rows[0][key];
      else fields.push(key);
    }
    const table = {
      format: ROWS,
      ...(Object.keys(constants).length ? { constants } : {}),
      fields,
      ...(Object.keys(sameAs).length ? { same_as: sameAs } : {}),
      rows: rows.map((row) => fields.map((field) => row[field])),
    };
    return bytes(table) < bytes(rows) ? table : rows;
  }
  if (value && typeof value === "object") {
    const encoded = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, compactReferencePromptValue(item)]));
    // A source object may itself use these strings. Escape it rather than
    // mistaking authored data for a table during lossless reconstruction.
    return [ROWS, OBJECT].includes(value.format) ? { format: OBJECT, value: encoded } : encoded;
  }
  return value;
}

export function expandReferencePromptValue(value) {
  if (Array.isArray(value)) return value.map(expandReferencePromptValue);
  if (!value || typeof value !== "object") return value;
  if (value.format === OBJECT) return Object.fromEntries(Object.entries(value.value).map(([key, item]) => [key, expandReferencePromptValue(item)]));
  if (value.format === ROWS) return value.rows.map((cells) => {
    if (cells.length !== value.fields.length) throw new Error("Reference prompt table column count changed");
    const row = { ...value.constants, ...Object.fromEntries(value.fields.map((field, index) => [field, cells[index]])) };
    for (const [field, source] of Object.entries(value.same_as ?? {})) {
      const sourceField = Array.isArray(source) ? source[0] : source;
      if (!Object.hasOwn(row, sourceField)) throw new Error("Reference prompt table alias source missing");
      Object.defineProperty(row, field, { value: Array.isArray(source) ? [row[sourceField]] : row[sourceField], enumerable: true });
    }
    return expandReferencePromptValue(row);
  });
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expandReferencePromptValue(item)]));
}

export const REFERENCE_PROMPT_TABLE_INSTRUCTION = "Lossless JSON tables: format=goldflow_literal_rows_v1 means one object per rows entry; fields names the columns; constants apply to every row; same_as copies the named field in that row (a one-item array wraps it in an array). All text and IDs are literal and retain their original meaning. format=goldflow_literal_object_v1 escapes an authored object in value. These are presentation aliases, never permission to merge identities, scopes or author decisions.";
