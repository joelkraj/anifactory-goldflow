function references(row) {
  return Array.isArray(row.reference_requirements) ? row.reference_requirements : [];
}

function visiblePeople(row) {
  const manifest = row.shot_manifest ?? {};
  return Array.isArray(row.physically_visible_entity_ids)
    ? row.physically_visible_entity_ids.length
    : Array.isArray(manifest.visible_characters) ? manifest.visible_characters.length : 0;
}

function shotSize(row) {
  return String(row.sequence_grammar?.shot_size ?? "").toLowerCase();
}

function isClose(row) {
  return /\b(close|detail|insert|macro)\b/.test(shotSize(row));
}

function isWide(row) {
  return /\b(wide|long|establish)\b/.test(shotSize(row))
    || /\b(establish|environment)\b/.test(String(row.suggested_shot_job ?? "").toLowerCase());
}

function hasLocation(row) {
  const manifest = row.shot_manifest ?? {};
  return references(row).some(ref => ref.kind === "location")
    || Boolean(manifest.location_ref_id || manifest.location_contract_id);
}

function hasContact(row) {
  const manifest = row.shot_manifest ?? {};
  return manifest.shot_job === "physical_action"
    || (manifest.anatomy_contracts ?? []).some(contract => contract.visibility_required === true);
}

function hasObjectDetail(row) {
  const manifest = row.shot_manifest ?? {};
  return references(row).some(ref => ["prop", "ui", "equipment"].includes(ref.kind))
    || (manifest.equipment_contracts ?? []).length > 0
    || (manifest.visible_props ?? []).length > 0;
}

function hasNonhuman(row) {
  return references(row).some(ref => {
    const subtype = String(ref.identity_subtype ?? "").toLowerCase();
    return (ref.kind === "character_state" && subtype && !["human", "person"].includes(subtype))
      || ["robot", "creature", "vehicle"].includes(ref.kind);
  });
}

function humanReferenceCount(row) {
  return references(row).filter(ref =>
    ref.kind === "character_state" && (!ref.identity_subtype || ref.identity_subtype === "human")).length;
}

function hasVisibleState(row) {
  const entities = Object.values(row.active_state_constraints?.entities ?? {});
  return entities.some(state => state && typeof state === "object"
    && ["wardrobe", "injury", "possession", "visible_state", "status"].some(key => Boolean(state[key])));
}

/** Choose one paid collage probe and seven different production risks across the runtime. */
export function chooseNativeValidationRows(rows) {
  const eligible = rows.filter(row => row.image_generation_required !== false
    && row.image_id && references(row).length > 0);
  if (eligible.length < 8) throw new Error("Fal collage validation needs at least eight distinct reference-backed production shots.");

  const ordered = [...eligible].sort((a, b) =>
    (Number(a.start_sec) || 0) - (Number(b.start_sec) || 0)
    || a.image_id.localeCompare(b.image_id));
  const lastTime = Math.max(...ordered.map(row => Number(row.start_sec) || 0));
  const position = row => lastTime > 0
    ? (Number(row.start_sec) || 0) / lastTime
    : ordered.indexOf(row) / Math.max(1, ordered.length - 1);
  const selected = [];
  const used = new Set();
  const select = (category, target, strict, broad = () => true) => {
    let candidates = ordered.filter(row => !used.has(row.image_id) && strict(row));
    let matched = true;
    if (!candidates.length) {
      candidates = ordered.filter(row => !used.has(row.image_id) && broad(row));
      matched = false;
    }
    if (!candidates.length) {
      candidates = ordered.filter(row => !used.has(row.image_id));
      matched = false;
    }
    candidates.sort((a, b) => {
      const score = row => Math.abs(position(row) - target)
        + (selected.some(item => item.row.scene_id && item.row.scene_id === row.scene_id) ? 0.20 : 0)
        + (selected.some(item => Math.abs(position(item.row) - position(row)) < 0.04) ? 0.12 : 0);
      return score(a) - score(b) || a.image_id.localeCompare(b.image_id);
    });
    const row = candidates[0];
    used.add(row.image_id);
    selected.push({ row, category, category_matched: matched });
  };

  select("opening_identity", 0, row => row === ordered[0]);
  select("paired_human_identity", 0.15, row => humanReferenceCount(row) >= 2);
  select("dense_cast", 0.28, row => humanReferenceCount(row) >= 3 || visiblePeople(row) >= 4,
    row => humanReferenceCount(row) >= 2);
  select("close_object_or_hand", 0.40, row => isClose(row) && (hasObjectDetail(row) || hasContact(row)),
    row => isClose(row) || hasObjectDetail(row));
  select("nonhuman_or_device", 0.52, hasNonhuman,
    row => hasObjectDetail(row) && (row.shot_manifest?.equipment_contracts ?? []).length > 0);
  select("wide_environment", 0.64, row => isWide(row) && hasLocation(row),
    row => isWide(row) || hasLocation(row));
  select("physical_contact", 0.78, hasContact,
    row => (row.shot_manifest?.equipment_contracts ?? []).length > 0);
  select("late_character_state", 0.94, row => position(row) >= 0.8 && humanReferenceCount(row) > 0 && hasVisibleState(row),
    row => position(row) >= 0.8 && humanReferenceCount(row) > 0);
  return selected;
}
