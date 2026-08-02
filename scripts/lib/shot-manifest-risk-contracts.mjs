function text(value) {
  return String(value ?? "").trim();
}

function nullableBoolean(value) {
  if (value === true || value === false) return value;
  return null;
}

function boundedVisibleCount(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 8 ? parsed : null;
}

export function sanitizeAnatomyContracts(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((row) => row && typeof row === "object" && text(row.entity))
    .map((row) => ({
      entity: text(row.entity),
      identity_ref_id: text(row.identity_ref_id) || null,
      body_invariant: text(row.body_invariant ?? row.invariant) || null,
      expected_visible_hands: boundedVisibleCount(row.expected_visible_hands),
      missing_limb: text(row.missing_limb) || null,
      prosthetic_allowed: nullableBoolean(row.prosthetic_allowed),
      visibility_required: nullableBoolean(row.visibility_required),
      reason: text(row.reason) || null,
    }));
}

export function sanitizeEquipmentContracts(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((row) => row && typeof row === "object" && text(row.owner) && text(row.item))
    .map((row) => ({
      owner: text(row.owner),
      item: text(row.item),
      visible_count: boundedVisibleCount(row.visible_count),
      hand_assignment: text(row.hand_assignment) || null,
      holder_state: text(row.holder_state) || null,
      contact_target: text(row.contact_target) || null,
      extras_allowed: nullableBoolean(row.extras_allowed),
      reason: text(row.reason) || null,
    }));
}

export function anatomyContractIsComplete(row) {
  return Boolean(
    row
    && text(row.entity)
    && text(row.body_invariant)
    && boundedVisibleCount(row.expected_visible_hands) !== null
    && nullableBoolean(row.visibility_required) !== null
    && (!text(row.missing_limb) || nullableBoolean(row.prosthetic_allowed) !== null)
  );
}

export function equipmentContractIsComplete(row) {
  return Boolean(
    row
    && text(row.owner)
    && text(row.item)
    && boundedVisibleCount(row.visible_count) !== null
    && text(row.hand_assignment)
    && text(row.holder_state)
    && nullableBoolean(row.extras_allowed) !== null
  );
}

export function completeAnatomyContracts(value) {
  return sanitizeAnatomyContracts(value).filter(anatomyContractIsComplete);
}

export function completeEquipmentContracts(value) {
  return sanitizeEquipmentContracts(value).filter(equipmentContractIsComplete);
}

function promptRiskText(prompt) {
  const manifest = prompt?.shot_manifest ?? {};
  return [
    prompt?.provider_prompt,
    prompt?.modelslab_image_prompt,
    prompt?.image_prompt,
    prompt?.visual_beat_action,
    manifest?.foreground_action,
    manifest?.continuity_notes,
    ...(manifest?.visible_props ?? []),
  ].filter(Boolean).join(" ");
}

export function promptHasImmutableAnatomyRisk(prompt) {
  const manifest = prompt?.shot_manifest ?? {};
  if (sanitizeAnatomyContracts(manifest.anatomy_contracts).length) return true;
  return /\b(?:amputat(?:ed|ion)|missing (?:left |right )?(?:hand|arm|forearm|leg|foot|limb)|no (?:left |right )?(?:wrist|hand|arm|forearm|leg|foot)|residual (?:left |right )?(?:arm|limb)|prosthetic|one[- ]handed|one[- ]armed|integrated (?:bell|crown|crystal|wheel|blade|shell)|bell[- ](?:headed|chested)|extra limbs?|exact limb count)\b/i.test(promptRiskText(prompt));
}

export function promptHasHandGeometryRisk(prompt) {
  const manifest = prompt?.shot_manifest ?? {};
  if (sanitizeAnatomyContracts(manifest.anatomy_contracts).length) return true;
  const riskText = promptRiskText(prompt);
  return /\b(?:grab|grasp|grip|clutch|hold|carry|catch|restrain|pin|shove|push|pull|drag|lift|rescue|escort|wrestle|punch|strike|slap|shake hands?|handshake|handoff|hand off|pass(?:es|ed|ing)?|offer|receive|take(?:s|n|ing)?|give|touch|reach|point|write|type|tap|dial|drink|aim|draw|swing|block|parry|stab|slash)\b/i.test(riskText);
}

export function promptHasEquipmentGeometryRisk(prompt) {
  const manifest = prompt?.shot_manifest ?? {};
  if (sanitizeEquipmentContracts(manifest.equipment_contracts).length) return true;
  const job = text(manifest.shot_job).toLowerCase();
  const riskText = promptRiskText(prompt);
  const hasWeapon = /\b(?:sword|blade|bow|arrow|spear|pike|hammer|axe|dagger|shield|weapon|rifle|pistol|gun|staff|mace|scabbard|sheath|quiver)\b/i.test(riskText);
  const hasHandledProp = /\b(?:phone|smartphone|tablet|laptop|pen|pencil|document|paper|letter|envelope|card|coin|key|book|scroll|cup|glass|bottle|bag|briefcase|box|package|microphone|camera|remote|tool|rope|chain|leash|torch|lantern|tray|steering wheel)\b/i.test(riskText);
  const handlingAction = job === "physical_action"
    || /\b(?:attack|strike|stab|slash|shoot|grip|grasp|swing|block|parry|draw|wield|hold|carry|clutch|raise|aim|offer|pass|handoff|hand off|receive|take|give|write|type|tap|dial|drink|read|open|use|operate|steer)\b/i.test(riskText);
  return hasWeapon || (hasHandledProp && handlingAction);
}
