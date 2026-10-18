import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { narrationSourceRefKey } from "./narration-performance-contract.mjs";

export const NARRATION_SOURCE_STRUCTURE_SCHEMA = "goldflow_narration_source_structure_v1";
export const NARRATION_SOURCE_STRUCTURE_ATTESTATION = "source_narrative_structure_reviewed";
const SHA256 = /^[a-f0-9]{64}$/;

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function narrationSourceStructureSha256(value) {
  const { structure_sha256: _hash, ...payload } = value ?? {};
  return sha256(JSON.stringify(canonical(payload)));
}

function planUnits(plan) {
  return Array.isArray(plan?.units) ? plan.units : (plan?.segments ?? []).flatMap((segment) =>
    segment.generation_units ?? segment.narration_generation_units ?? segment.qwen_generation_units ?? []);
}

export function narrationSourceChapterStarts(map, plan) {
  const units = planUnits(plan);
  if (!units.length) throw new Error("Narration source structure requires a nonempty generation plan.");
  if (!map.chapters?.length) return [];
  const starts = new Map();
  for (const [index, unit] of units.entries()) {
    const ref = unit.source_unit_refs?.[0];
    if (!ref?.segment_id || !Number.isInteger(ref.unit_index)) continue;
    const key = narrationSourceRefKey(ref);
    if (starts.has(key)) throw new Error("Narration source structure chapter anchor is ambiguous.");
    starts.set(key, { unit_id: unit.unit_id, index });
  }
  const seen = new Set();
  let previousIndex = -1;
  return (map.chapters ?? []).map((chapter, index) => {
    const id = String(chapter?.chapter_id ?? "").trim();
    const key = String(chapter?.first_source_ref_key ?? "").trim();
    const start = starts.get(key);
    if (!id || seen.has(id) || !key || !start?.unit_id || start.index <= previousIndex
      || (index === 0 && start.index !== 0)) {
      throw new Error("Narration source structure chapter anchors must identify ordered, distinct synthesis-unit starts, including the first unit.");
    }
    seen.add(id);
    previousIndex = start.index;
    return { chapter_id: id, first_source_ref_key: key, ...start };
  });
}

export function assertNarrationSourceStructure(map, {
  plan, sourceScriptSha256, generationPlanSha256, generationPlanFileSha256,
} = {}) {
  if (map?.schema !== NARRATION_SOURCE_STRUCTURE_SCHEMA || map?.status !== "approved"
    || map?.structure_sha256 !== narrationSourceStructureSha256(map)) {
    throw new Error("Narration source structure map is missing, invalid, or hash-stale.");
  }
  for (const [field, expected] of [
    ["source_script_sha256", sourceScriptSha256],
    ["narration_generation_plan_sha256", generationPlanSha256],
    ["narration_generation_plan_file_sha256", generationPlanFileSha256],
  ]) {
    if (!SHA256.test(String(expected ?? "")) || map[field] !== expected) {
      throw new Error(`Narration source structure ${field} is missing or does not match current provenance.`);
    }
  }
  if (!String(map.reviewer ?? "").trim() || !String(map.note ?? "").trim()
    || map.attestation !== NARRATION_SOURCE_STRUCTURE_ATTESTATION) {
    throw new Error("Narration source structure requires an explicit source review and evidence note.");
  }
  if (!Array.isArray(map.chapters)
    || !["continuous_narrative", "explicit_chapters"].includes(map.structure_kind)
    || (map.structure_kind === "continuous_narrative" && map.chapters.length !== 0)
    || (map.structure_kind === "explicit_chapters" && map.chapters.length === 0)) {
    throw new Error("Narration source structure must declare continuous narration or explicit chapters.");
  }
  narrationSourceChapterStarts(map, plan);
  return map;
}

export function buildNarrationSourceStructure({
  plan, sourceScriptSha256, generationPlanSha256, generationPlanFileSha256,
  structureKind, chapters = [], reviewer, note,
} = {}) {
  const map = {
    schema: NARRATION_SOURCE_STRUCTURE_SCHEMA,
    status: "approved",
    structure_kind: structureKind,
    source_script_sha256: sourceScriptSha256,
    narration_generation_plan_sha256: generationPlanSha256,
    narration_generation_plan_file_sha256: generationPlanFileSha256,
    reviewer: String(reviewer ?? "").trim(),
    note: String(note ?? "").trim(),
    attestation: NARRATION_SOURCE_STRUCTURE_ATTESTATION,
    chapters,
    policy: "Declared narrative structure only; technical voice segments and prosody rows do not establish chapters. No source, synthesis request, audio, or delivery-review waiver is authorized.",
  };
  map.structure_sha256 = narrationSourceStructureSha256(map);
  return assertNarrationSourceStructure(map, { plan, sourceScriptSha256, generationPlanSha256, generationPlanFileSha256 });
}

export async function loadNarrationSourceStructure(options = {}) {
  const { episodeDir, episode, expectedBinding } = options;
  const mapPath = path.join(episodeDir, `narration_source_structure_${episode}.json`);
  let bytes;
  try {
    bytes = await fs.readFile(mapPath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    if (expectedBinding) throw new Error("Narration source structure sidecar required by the sample manifest is missing.");
    return null;
  }
  const map = assertNarrationSourceStructure(JSON.parse(bytes.toString("utf8")), options);
  const binding = { path: mapPath, file_sha256: sha256(bytes), map };
  if (Object.hasOwn(options, "expectedBinding")
    && JSON.stringify(canonical(binding)) !== JSON.stringify(canonical(expectedBinding))) {
    throw new Error("Narration subjective source structure binding is stale; refresh its sample manifest without changing audio.");
  }
  return binding;
}
