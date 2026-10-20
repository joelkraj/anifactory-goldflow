// Prompt rows may attach a character-state alias whose approved raster is its
// source target's. Resolve only through the exact character_state_refs link;
// the caller still verifies the approved hash of the resolved ID.
export function falStateSourceMap(characterStateRefs = {}) {
  return new Map((characterStateRefs.character_state_refs ?? [])
    .filter((item) => item.state_ref_id && item.source_ref_id)
    .map((item) => [item.state_ref_id, item.source_ref_id]));
}

export function resolveFalApprovedRefId(requested, approvedHashes = {}, sourceByState = new Map()) {
  if (approvedHashes[requested]) return requested;
  return sourceByState.get(requested) ?? requested;
}
