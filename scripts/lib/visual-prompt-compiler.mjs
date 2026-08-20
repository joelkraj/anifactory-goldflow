import { createHash } from "node:crypto";

export const VISUAL_PROMPT_COMPILER_CONTRACT = "goldflow_visual_prompt_compiler_v1";

const PROVIDER_PROFILES = Object.freeze({
  "google-flow": Object.freeze({
    compiler_id: "google_flow_scene_compiler_v1",
    soft_char_budget: 4_800,
    lead: "Render this as one decisive cinematic story frame.",
    reference_language: "Use the ordered reference attachments only for the identities, state, objects, environments, and visual language assigned to them.",
  }),
  "google-gemini": Object.freeze({
    compiler_id: "google_gemini_scene_compiler_v1",
    soft_char_budget: 5_600,
    lead: "Create one coherent story frame that makes the decisive event immediately readable.",
    reference_language: "Preserve the identity and continuity of each explicitly mapped reference attachment; never exchange one attachment's role with another.",
  }),
  chatgpt: Object.freeze({
    compiler_id: "chatgpt_image_scene_compiler_v1",
    soft_char_budget: 5_600,
    lead: "Create one visually coherent story frame centered on the decisive action and emotional consequence.",
    reference_language: "Treat the ordered reference attachments as continuity evidence for only their assigned subjects and elements.",
  }),
});

function cleanText(value) {
  return String(value ?? "").replace(/\r\n?/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function normalizeProvider(value) {
  const normalized = cleanText(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (["google-flow", "flow", "google"].includes(normalized)) return "google-flow";
  if (["google-gemini", "gemini", "gemini-images"].includes(normalized)) return "google-gemini";
  if (["chatgpt", "chatgpt-web", "openai"].includes(normalized)) return "chatgpt";
  throw new Error(`Unsupported visual prompt compiler provider: ${value}.`);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function unique(values) {
  return [...new Set(values.map(cleanText).filter(Boolean))];
}

function sentence(value) {
  const text = cleanText(value);
  if (!text) return "";
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

function stagingSummary(manifest) {
  const rows = Array.isArray(manifest?.character_staging) ? manifest.character_staging : [];
  return rows.map((row) => {
    const name = cleanText(row?.name ?? row?.character ?? row?.character_name);
    const position = cleanText(row?.screen_position);
    const pose = cleanText(row?.pose);
    if (!name) return "";
    return [name, position ? `at ${position}` : "", pose].filter(Boolean).join(", ");
  }).filter(Boolean).join("; ");
}

function anatomySummary(manifest) {
  const rows = Array.isArray(manifest?.anatomy_contracts) ? manifest.anatomy_contracts : [];
  return rows.map((row) => {
    const entity = cleanText(row?.entity);
    const invariant = cleanText(row?.body_invariant);
    const hands = Number.isFinite(Number(row?.expected_visible_hands))
      ? `${Number(row.expected_visible_hands)} visible hand${Number(row.expected_visible_hands) === 1 ? "" : "s"}`
      : "";
    const missing = cleanText(row?.missing_limb);
    const prosthetic = row?.prosthetic_allowed === false && missing ? "no prosthetic" : "";
    return [entity, invariant, hands, missing ? `missing ${missing}` : "", prosthetic].filter(Boolean).join(": ");
  }).filter(Boolean).join("; ");
}

function equipmentSummary(manifest) {
  const rows = Array.isArray(manifest?.equipment_contracts) ? manifest.equipment_contracts : [];
  return rows.map((row) => {
    const owner = cleanText(row?.owner);
    const item = cleanText(row?.item);
    const count = Number.isFinite(Number(row?.visible_count)) ? `${Number(row.visible_count)} visible` : "";
    const hand = cleanText(row?.hand_assignment);
    const holder = cleanText(row?.holder_state);
    const contact = cleanText(row?.contact_target);
    return [owner, [count, item].filter(Boolean).join(" "), hand, holder, contact ? `contacting ${contact}` : ""].filter(Boolean).join(": ");
  }).filter(Boolean).join("; ");
}

function continuitySummary(manifest) {
  const spatial = manifest?.spatial_continuity ?? {};
  const values = [
    spatial.eyeline_axis ? `eyeline axis ${spatial.eyeline_axis}` : "",
    spatial.primary_screen_position ? `primary at ${spatial.primary_screen_position}` : "",
    spatial.primary_facing ? `primary facing ${spatial.primary_facing}` : "",
    spatial.counterparty_or_threat_position ? `counterparty or threat at ${spatial.counterparty_or_threat_position}` : "",
    spatial.travel_direction ? `travel direction ${spatial.travel_direction}` : "",
    spatial.object_geography ? `object geography ${spatial.object_geography}` : "",
    manifest?.continuity_notes,
  ];
  return unique(values).join("; ");
}

function referenceSummary(references) {
  return (Array.isArray(references) ? references : []).map((reference, index) => {
    const slot = Number(reference?.slot ?? index + 1);
    const refId = cleanText(reference?.ref_id) || `reference_${slot}`;
    const purpose = cleanText(reference?.purpose ?? reference?.slot_purpose);
    return `Attachment ${slot} = ${refId}${purpose ? ` (${purpose})` : ""}`;
  }).join("; ");
}

function contractLines(manifest) {
  if (!manifest || typeof manifest !== "object") return [];
  const visible = unique([
    ...(Array.isArray(manifest.visible_characters) ? manifest.visible_characters : []),
    ...(Array.isArray(manifest.visible_entities) ? manifest.visible_entities : []),
  ]);
  const props = unique(Array.isArray(manifest.visible_props) ? manifest.visible_props : []);
  const ui = unique(Array.isArray(manifest.ui_elements) ? manifest.ui_elements : []);
  const lines = [
    ["DECISIVE ACTION", sentence(manifest.foreground_action)],
    ["VISIBLE SUBJECTS", visible.join(", ")],
    ["STAGING", stagingSummary(manifest)],
    ["SHOT", unique([manifest.shot_job, manifest.shot_size, manifest.camera_angle, manifest.vantage]).join("; ")],
    ["LOCATION CONTINUITY", unique([manifest.location_contract_id, manifest.location_ref_id]).join("; ")],
    ["SPATIAL CONTINUITY", continuitySummary(manifest)],
    ["BODY INVARIANTS", anatomySummary(manifest)],
    ["OBJECT GEOMETRY", equipmentSummary(manifest)],
    ["VISIBLE PROPS", props.join(", ")],
    ["SCREEN OR UI", ui.join(", ")],
  ];
  return lines.filter(([, value]) => cleanText(value));
}

function essentialExclusions(manifest) {
  const rows = [];
  const mentioned = unique(Array.isArray(manifest?.mentioned_only_characters) ? manifest.mentioned_only_characters : []);
  if (mentioned.length) rows.push(`Mentioned only, not physically or screen visible: ${mentioned.join(", ")}`);
  const forbidden = unique(Array.isArray(manifest?.forbidden_ref_ids) ? manifest.forbidden_ref_ids : []);
  if (forbidden.length) rows.push(`Do not use these out-of-scope reference identities or states: ${forbidden.join(", ")}`);
  return rows;
}

function compileBody({ profile, neutralPrompt, manifest, references }) {
  const sections = [profile.lead];
  const refMap = referenceSummary(references);
  if (refMap) sections.push(`${profile.reference_language}\n${refMap}.`);
  const lines = contractLines(manifest);
  if (lines.length) sections.push(lines.map(([label, value]) => `${label}: ${value}`).join("\n"));
  sections.push(`SCENE DESCRIPTION:\n${neutralPrompt}`);
  const exclusions = essentialExclusions(manifest);
  if (exclusions.length) sections.push(`ESSENTIAL EXCLUSIONS:\n${exclusions.map(sentence).join("\n")}`);
  return cleanText(sections.join("\n\n"));
}

export function compileVisualPrompt({ provider, neutralPrompt, shotManifest = null, orderedReferences = [], assetId = null }) {
  const normalizedProvider = normalizeProvider(provider);
  const profile = PROVIDER_PROFILES[normalizedProvider];
  const sourcePrompt = cleanText(neutralPrompt);
  if (!sourcePrompt) throw new Error(`Visual prompt compiler received an empty neutral prompt${assetId ? ` for ${assetId}` : ""}.`);
  const prompt = compileBody({ profile, neutralPrompt: sourcePrompt, manifest: shotManifest, references: orderedReferences });
  const promptSha256 = sha256(prompt);
  const neutralPromptSha256 = sha256(sourcePrompt);
  const lineLabels = contractLines(shotManifest).map(([label]) => label);
  const receipt = {
    schema: VISUAL_PROMPT_COMPILER_CONTRACT,
    compiler_id: profile.compiler_id,
    compiler_version: 1,
    provider: normalizedProvider,
    asset_id: cleanText(assetId) || null,
    neutral_prompt_sha256: neutralPromptSha256,
    compiled_prompt_sha256: promptSha256,
    ordered_reference_hashes: (Array.isArray(orderedReferences) ? orderedReferences : []).map((row) => ({
      slot: Number(row?.slot ?? 0),
      ref_id: cleanText(row?.ref_id) || null,
      sha256: cleanText(row?.sha256) || null,
    })),
    section_order: [
      "provider_lead",
      ...(orderedReferences.length ? ["reference_binding"] : []),
      ...(lineLabels.length ? ["manifest_contract"] : []),
      "neutral_scene_description",
      ...(essentialExclusions(shotManifest).length ? ["essential_exclusions"] : []),
    ],
    manifest_contract_labels: lineLabels,
    neutral_char_count: sourcePrompt.length,
    compiled_char_count: prompt.length,
    compiled_word_count: prompt.split(/\s+/).filter(Boolean).length,
    soft_char_budget: profile.soft_char_budget,
    soft_budget_exceeded: prompt.length > profile.soft_char_budget,
    content_policy: "deterministic_ordering_only_no_story_rewrite_no_creative_truncation",
  };
  return { prompt, prompt_sha256: promptSha256, receipt };
}

export function validateVisualPromptCompilerReceipt({ prompt, receipt, neutralPrompt, provider, orderedReferences = [] }) {
  const findings = [];
  const sourcePrompt = cleanText(neutralPrompt);
  const normalizedProvider = normalizeProvider(provider);
  if (receipt?.schema !== VISUAL_PROMPT_COMPILER_CONTRACT) findings.push("compiler_receipt_schema_invalid");
  if (receipt?.provider !== normalizedProvider) findings.push("compiler_receipt_provider_mismatch");
  if (receipt?.neutral_prompt_sha256 !== sha256(sourcePrompt)) findings.push("compiler_neutral_prompt_hash_mismatch");
  if (receipt?.compiled_prompt_sha256 !== sha256(cleanText(prompt))) findings.push("compiler_output_hash_mismatch");
  if (!cleanText(prompt).includes(sourcePrompt)) findings.push("compiler_neutral_prompt_not_preserved");
  const expectedReferences = (Array.isArray(orderedReferences) ? orderedReferences : []).map((row) => ({
    slot: Number(row?.slot ?? 0),
    ref_id: cleanText(row?.ref_id) || null,
    sha256: cleanText(row?.sha256) || null,
  }));
  if (JSON.stringify(receipt?.ordered_reference_hashes ?? []) !== JSON.stringify(expectedReferences)) {
    findings.push("compiler_reference_binding_mismatch");
  }
  return findings;
}

export function visualPromptCompilerProfiles() {
  return structuredClone(PROVIDER_PROFILES);
}
