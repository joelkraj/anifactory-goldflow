// Pure editorial-plan checks only. No media, provider, workflow or approval operations.
export const TRUE_CRIME_PROOF_PLAN_SCHEMA = "goldflow_true_crime_editorial_proof_plan_v1";

const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value) => typeof value === "string" && value.trim().length > 0;
const finite = (value) => typeof value === "number" && Number.isFinite(value);
const unique = (values) => [...new Set(values)];
const ID = /^[A-Za-z][A-Za-z0-9_-]*$/;
const EPSILON = 0.001;

/**
 * Validates the shape and internal consistency of a roughly two-minute paper edit.
 * Claims, declared word verification and use-basis notes are NOT adjudicated here.
 * A valid result remains an editorial draft with production_ready: false.
 */
export function validateTrueCrimeProofPlan(plan) {
  const errors = [];
  const unresolved = [];
  const fail = (path, code) => errors.push(`${path}: ${code}`);
  const pending = (code, path, detail) => unresolved.push({ code, path, detail });
  const keys = (value, allowed, path) => {
    if (!record(value)) { fail(path, "expected_object"); return false; }
    for (const key of Object.keys(value)) {
      if (!allowed.includes(key)) fail(`${path}.${key}`, "unsupported_field_in_editorial_plan");
    }
    return true;
  };
  const requiredText = (value, path) => { if (!text(value)) fail(path, "nonempty_string_required"); };
  const choice = (value, allowed, path) => { if (!allowed.includes(value)) fail(path, "invalid_value"); };
  const rows = (value, path) => {
    if (!Array.isArray(value) || value.length === 0) { fail(path, "nonempty_array_required"); return []; }
    return value;
  };
  const indexRows = (value, path) => {
    const index = new Map();
    rows(value, path).forEach((row, i) => {
      if (!record(row) || !ID.test(row.id ?? "")) fail(`${path}[${i}].id`, "invalid_id");
      else if (index.has(row.id)) fail(`${path}[${i}].id`, "duplicate_id");
      else index.set(row.id, row);
    });
    return index;
  };
  const refs = (value, index, path) => {
    const ids = rows(value, path);
    const valid = ids.filter((id) => typeof id === "string");
    if (new Set(valid).size !== valid.length) fail(path, "duplicate_reference");
    ids.forEach((id, i) => {
      if (typeof id !== "string" || !index.has(id)) fail(`${path}[${i}]`, "unknown_reference");
    });
    return valid;
  };

  if (!keys(plan, ["schema", "status", "production_eligible", "title", "working_channel", "case_name",
    "target_duration_sec", "sources", "claims", "scenes", "readiness"], "plan")) {
    return { valid: false, errors, unresolved_readiness: [], production_ready: false };
  }
  choice(plan.schema, [TRUE_CRIME_PROOF_PLAN_SCHEMA], "plan.schema");
  choice(plan.status, ["editorial_draft"], "plan.status");
  choice(plan.production_eligible, [false], "plan.production_eligible");
  requiredText(plan.title, "plan.title");
  for (const key of ["working_channel", "case_name"]) {
    if (Object.hasOwn(plan, key)) requiredText(plan[key], `plan.${key}`);
  }
  // This range is an editorial budget, never a render duration or proof identity.
  if (!finite(plan.target_duration_sec) || plan.target_duration_sec < 90 || plan.target_duration_sec > 150) {
    fail("plan.target_duration_sec", "approximately_two_minutes_required_90_to_150_seconds");
  }

  const sources = indexRows(plan.sources, "plan.sources");
  const claims = indexRows(plan.claims, "plan.claims");
  indexRows(plan.scenes, "plan.scenes");

  for (const [id, source] of sources) {
    const at = `source.${id}`;
    keys(source, ["id", "url", "title", "kind", "locator", "planned_use", "acquisition_status", "use_basis_status", "use_basis_note"], at);
    for (const key of ["title", "kind", "locator"]) requiredText(source[key], `${at}.${key}`);
    try {
      if (!text(source.url)) throw new Error("missing URL");
      const url = new URL(source.url);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password
        || [...url.searchParams.keys()].some((key) => /^(?:token|access_token|api_key|signature|sig|x-amz-.+|x-goog-.+)$/i.test(key))) {
        throw new Error("not a public reference URL");
      }
    } catch { fail(`${at}.url`, "public_http_reference_required_without_credentials_or_signed_query"); }
    choice(source.acquisition_status, ["not_acquired", "research_copy", "reference_only"], `${at}.acquisition_status`);
    choice(source.planned_use, ["evidence_only", "media_candidate"], `${at}.planned_use`);
    choice(source.use_basis_status, ["unresolved", "documented"], `${at}.use_basis_status`);
    if (Object.hasOwn(source, "use_basis_note")) requiredText(source.use_basis_note, `${at}.use_basis_note`);
    if (source.use_basis_status === "documented") requiredText(source.use_basis_note, `${at}.use_basis_note`);
    else if (source.planned_use === "media_candidate") pending("source_use_basis", at, "Record the applicable basis for the selected use; online availability alone does not establish it.");
    if (source.planned_use === "media_candidate" && ["not_acquired", "reference_only"].includes(source.acquisition_status)) {
      pending("source_acquisition", at, "Acquire or replace the selected source under the eventual supported scope; this entry is a reference, not an accepted media asset.");
    } else if (source.planned_use === "media_candidate" && source.acquisition_status === "research_copy") {
      pending("research_copy_media_binding", at, "The research copy exists; any selected production use still needs exact-file binding and review under its supported route.");
    }
  }

  for (const [id, claim] of claims) {
    const at = `claim.${id}`;
    keys(claim, ["id", "text", "source_ids"], at);
    requiredText(claim.text, `${at}.text`);
    refs(claim.source_ids, sources, `${at}.source_ids`);
  }

  let previousEnd = 0;
  const sceneRows = Array.isArray(plan.scenes) ? plan.scenes : [];
  sceneRows.forEach((scene, i) => {
    const at = `scene.${scene?.id ?? i}`;
    if (!keys(scene, ["id", "start_sec", "end_sec", "claim_ids", "source_ids", "picture", "audio"], at)) return;
    if (!finite(scene.start_sec) || !finite(scene.end_sec) || scene.start_sec < 0 || scene.end_sec <= scene.start_sec) {
      fail(at, "positive_finite_scene_interval_required");
    } else {
      if (Math.abs(scene.start_sec - previousEnd) > EPSILON) fail(at, scene.start_sec < previousEnd ? "scene_overlap_or_out_of_order" : "scene_coverage_gap");
      if (finite(plan.target_duration_sec) && scene.end_sec > plan.target_duration_sec + EPSILON) fail(at, "scene_exceeds_target");
      previousEnd = scene.end_sec;
    }
    const sceneSources = refs(scene.source_ids, sources, `${at}.source_ids`);
    const sceneClaims = refs(scene.claim_ids, claims, `${at}.claim_ids`);
    for (const id of sceneClaims) {
      const supporting = claims.get(id)?.source_ids;
      if (Array.isArray(supporting) && supporting.length && !supporting.some((sourceId) => sceneSources.includes(sourceId))) {
        fail(`${at}.claim_ids`, `claim_without_supporting_scene_source_${id}`);
      }
    }
    if (keys(scene.picture, ["origin", "description", "label"], `${at}.picture`)) {
      choice(scene.picture.origin, ["original", "recreated", "authored"], `${at}.picture.origin`);
      requiredText(scene.picture.description, `${at}.picture.description`);
      if (Object.hasOwn(scene.picture, "label")) requiredText(scene.picture.label, `${at}.picture.label`);
      if (scene.picture.origin === "recreated" && !/\b(?:recreation|recreated|reconstruction|illustration|illustrative)\b/i.test(scene.picture.label ?? "")) {
        fail(`${at}.picture.label`, "recreated_picture_disclosure_required");
      }
      if (scene.picture.origin === "original" && /\b(?:recreation|recreated|reconstruction)\b/i.test(scene.picture.label ?? "")) {
        fail(`${at}.picture.label`, "original_picture_label_conflict");
      }
    }
    if (keys(scene.audio, ["origin", "text_mode", "text", "source_ids", "exact_words_verified", "label"], `${at}.audio`)) {
      const audio = scene.audio;
      choice(audio.origin, ["original", "recreated", "narration"], `${at}.audio.origin`);
      choice(audio.text_mode, ["quote", "paraphrase", "document_reading"], `${at}.audio.text_mode`);
      requiredText(audio.text, `${at}.audio.text`);
      choice(audio.exact_words_verified, [true, false], `${at}.audio.exact_words_verified`);
      const audioSources = refs(audio.source_ids, sources, `${at}.audio.source_ids`);
      for (const id of audioSources) if (!sceneSources.includes(id)) fail(`${at}.audio.source_ids`, "audio_source_missing_from_scene");
      if (Object.hasOwn(audio, "label")) requiredText(audio.label, `${at}.audio.label`);
      if (audio.text_mode === "paraphrase" && audio.origin !== "narration") fail(`${at}.audio`, "paraphrase_must_be_narration");
      if (audio.text_mode === "paraphrase" && audio.exact_words_verified !== false) fail(`${at}.audio`, "paraphrase_is_not_a_verified_verbatim_quote");
      if (audio.text_mode === "quote" && !["original", "recreated"].includes(audio.origin)) fail(`${at}.audio`, "quoted_dialogue_requires_original_or_recreated_origin");
      if (audio.text_mode === "quote" && audio.exact_words_verified === false) {
        pending("exact_quote_words", `${at}.audio`, "Check the complete quoted words and context against the cited recording or exact transcript before selecting this quotation.");
      }
      if (audio.origin === "recreated" && !/^AUDIO RECREATION\b/i.test(audio.label ?? "")) fail(`${at}.audio.label`, "audio_recreation_disclosure_required");
      if (audio.origin === "original" && /\b(?:recreation|recreated|document reading)\b/i.test(audio.label ?? "")) fail(`${at}.audio.label`, "original_audio_label_conflict");
      if (audio.text_mode === "document_reading") {
        if (audio.origin !== "narration" || audio.exact_words_verified !== true) fail(`${at}.audio`, "document_reading_requires_narration_and_verified_exact_words");
        if (!/^DOCUMENT READING\s*(?:—|–|:)\s*\S/i.test(audio.label ?? "")) fail(`${at}.audio.label`, "document_reading_source_label_required");
      }
    }
  });
  if (sceneRows.length && finite(plan.target_duration_sec) && Math.abs(previousEnd - plan.target_duration_sec) > EPSILON) fail("plan.scenes", "scene_coverage_does_not_reach_target");

  if (keys(plan.readiness, ["voice", "voice_note", "execution_route"], "plan.readiness")) {
    choice(plan.readiness.voice, ["unresolved", "selected"], "plan.readiness.voice");
    if (Object.hasOwn(plan.readiness, "voice_note")) requiredText(plan.readiness.voice_note, "plan.readiness.voice_note");
    if (plan.readiness.voice === "selected") requiredText(plan.readiness.voice_note, "plan.readiness.voice_note");
    else pending("voice_selection", "plan.readiness.voice", "Select narrator and any reconstruction cast before a scoped audition.");
    choice(plan.readiness.execution_route, ["unsupported"], "plan.readiness.execution_route");
  }
  pending("factual_and_source_context_review", "plan", "A reviewer must check actual source support, selected words, scope and context; structural validation does not perform that review.");
  pending("supported_execution_route", "plan.readiness.execution_route", "Implement and validate an applicable hybrid proof route, then lock exact scope, files, voices and required approvals before media execution.");
  pending("timing_and_listening_review", "plan", "These scene times are an editorial budget; complete speech, source context and final duration need actual listening and edit review.");
  return { valid: errors.length === 0, errors: unique(errors), unresolved_readiness: unresolved, production_ready: false };
}
