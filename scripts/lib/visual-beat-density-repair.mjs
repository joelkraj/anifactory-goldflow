import { createHash } from "node:crypto";
import { groupingLockHash, retentionRailForTime } from "./editorial-beat-director.mjs";
import { normalizeVisualBeatQuality, visualBeatQualityContractFindings } from "./visual-beat-quality-contract.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const only = (value, allowed) => object(value) && Object.keys(value).every((key) => allowed.includes(key));
const isHash = (value) => /^[a-f0-9]{64}$/u.test(String(value ?? ""));
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const nonempty = (value, max = 1200) => typeof value === "string" && value.trim() === value
  && value.length > 0 && value.length <= max;
const atomRange = (id) => String(id).match(/^atom_w(\d{6})_w(\d{6})$/u)?.slice(1).map(Number);

export function visualBeatDensityRepairAdmission(status = {}, flags = {}) {
  const deny = (reason) => ({ allowed: false, reason });
  if (!only(flags, ["episode-dir", "repair-spec", "beat-ids"])) return deny("unsupported_density_repair_flag");
  if (!nonempty(flags["episode-dir"], 4096) || !nonempty(flags["repair-spec"], 4096)
    || !/^beat_w\d{6}_w\d{6}$/u.test(String(flags["beat-ids"] ?? ""))) {
    return deny("exact_episode_spec_and_single_beat_id_required");
  }
  if (status.episode_dir !== flags["episode-dir"] || status.identity?.schema !== "goldflow_run_identity_v2"
    || status.media_workflow?.id !== "generated_visuals_v1") return deny("episode_identity_or_workflow_mismatch");
  if (status.current_stage !== "visual_beat_plan" || status.current_stage_state !== "failed") {
    return deny("density_repair_requires_failed_visual_beat_stage");
  }
  const beat = status.stage_ledger?.find((row) => row.stage === "visual_beat_plan");
  const refs = status.stage_ledger?.find((row) => row.stage === "visual_reference_plan");
  if (beat?.state !== "failed" || refs?.state !== "missing") return deny("downstream_reference_plan_must_be_missing");
  return { allowed: true, reason: "failed_closed_timeline_exact_atom_split" };
}

export function validateDensityRepairSpec(spec, expectedBeatId) {
  if (!only(spec, ["schema", "status", "episode_dir", "run_identity_sha256", "source_script_sha256",
    "timed_scene_plan_sha256", "word_timing_sha256", "story_fact_ledger_sha256",
    "failed_visual_beat_plan_sha256", "planner_chunk_ledger_sha256", "visual_beat_id",
    "source_atom_ids", "split_after_atom_id", "first_frame", "second_frame", "approved_by", "review_note"])
    || spec.schema !== "goldflow_visual_beat_density_repair_v1" || spec.status !== "approved"
    || spec.visual_beat_id !== expectedBeatId || !nonempty(spec.episode_dir, 4096)
    || !nonempty(spec.approved_by, 120) || !nonempty(spec.review_note)
    || !["run_identity_sha256", "source_script_sha256", "timed_scene_plan_sha256", "word_timing_sha256",
      "story_fact_ledger_sha256", "failed_visual_beat_plan_sha256", "planner_chunk_ledger_sha256"]
      .every((key) => isHash(spec[key]))
    || !Array.isArray(spec.source_atom_ids) || spec.source_atom_ids.length < 2
    || spec.source_atom_ids.length > 20 || new Set(spec.source_atom_ids).size !== spec.source_atom_ids.length
    || spec.source_atom_ids.some((id) => !atomRange(id))
    || !spec.source_atom_ids.slice(0, -1).includes(spec.split_after_atom_id)
    || ![spec.first_frame, spec.second_frame].every((frame) => only(frame,
      ["visual_beat_action", "visual_beat_action_evidence", "visual_beat_focus",
        "visual_job", "suggested_shot_job", "local_continuity_note", "visual_information_delta",
        "sequence_grammar", "spatial_continuity", "audiovisual_intent"]))) {
    throw new Error("Density repair spec is incomplete or contains unsupported fields.");
  }
  for (const frame of [spec.first_frame, spec.second_frame]) {
    for (const key of ["visual_beat_action", "visual_beat_action_evidence", "visual_beat_focus", "visual_job",
      "suggested_shot_job", "local_continuity_note"]) {
      if (!nonempty(frame[key], 800)) throw new Error(`Density repair frame lacks ${key}.`);
    }
    for (const key of ["visual_information_delta", "sequence_grammar", "spatial_continuity", "audiovisual_intent"]) {
      if (!object(frame[key])) throw new Error(`Density repair frame lacks ${key}.`);
    }
  }
  const ranges = spec.source_atom_ids.map(atomRange);
  if (ranges.some((range, index) => index > 0 && range[0] !== ranges[index - 1][1] + 1)) {
    throw new Error("Density repair source atoms are not contiguous.");
  }
  const expectedId = `beat_w${String(ranges[0][0]).padStart(6, "0")}_w${String(ranges.at(-1)[1]).padStart(6, "0")}`;
  if (expectedId !== expectedBeatId) throw new Error("Density repair source atoms do not match exact beat ID.");
}

function spanBeat(base, selected, episode) {
  const first = selected[0], last = selected.at(-1);
  const start = Number(first.start_sec), end = Number(last.end_sec);
  const firstWord = Number(first.source_word_start_index), lastWord = Number(last.source_word_end_index);
  return {
    ...structuredClone(base),
    visual_beat_id: `beat_w${String(firstWord).padStart(6, "0")}_w${String(lastWord).padStart(6, "0")}`,
    image_id_hint: `${episode}-w${String(firstWord).padStart(6, "0")}-w${String(lastWord).padStart(6, "0")}`,
    source_atom_ids: selected.map((atom) => atom.atom_id),
    source_word_start_index: firstWord,
    source_word_end_index: lastWord,
    start_sec: start,
    end_sec: end,
    duration_sec: Number((end - start).toFixed(3)),
    visual_beat_script_excerpt: selected.map((atom) => atom.text).join(" ").replace(/\s+/gu, " ").trim(),
  };
}

export function splitReviewedVisualBeat(beats, atoms, spec, episode, timingContract) {
  validateDensityRepairSpec(spec, spec.visual_beat_id);
  const index = beats.findIndex((beat) => beat.visual_beat_id === spec.visual_beat_id);
  if (index < 0 || beats.filter((beat) => beat.visual_beat_id === spec.visual_beat_id).length !== 1) {
    throw new Error("Density repair target beat is missing or duplicate.");
  }
  const original = beats[index];
  if (!same(original.source_atom_ids, spec.source_atom_ids)) throw new Error("Density repair atom grouping changed.");
  const byId = new Map(atoms.map((atom) => [atom.atom_id, atom]));
  const selected = spec.source_atom_ids.map((id) => byId.get(id));
  if (selected.some((atom) => !atom)) throw new Error("Density repair source atom is missing.");
  const cut = spec.source_atom_ids.indexOf(spec.split_after_atom_id) + 1;
  const first = spanBeat(original, selected.slice(0, cut), episode);
  const second = spanBeat(original, selected.slice(cut), episode);
  if (second.start_sec <= first.start_sec || first.visual_beat_id === second.visual_beat_id
    || beats.some((beat) => [first.visual_beat_id, second.visual_beat_id].includes(beat.visual_beat_id))) {
    throw new Error("Density repair split does not produce two new ordered beat IDs.");
  }
  const nextStart = Number(beats[index + 1]?.start_sec ?? second.end_sec);
  const firstHold = second.start_sec - first.start_sec;
  const secondHold = nextStart - second.start_sec;
  const firstMax = retentionRailForTime(first.start_sec, timingContract).max_sec;
  const secondMax = retentionRailForTime(second.start_sec, timingContract).max_sec;
  if (!(firstHold > 0 && secondHold > 0 && firstHold <= firstMax + 0.1 && secondHold <= secondMax + 0.1)) {
    throw new Error(`Density repair split still exceeds visual hold ceiling: ${firstHold}s/${secondHold}s.`);
  }
  // Both frame interpretations are supplied by the reviewed structured spec.
  for (const [frame, authored] of [[first, spec.first_frame], [second, spec.second_frame]]) {
    const inheritedQuality = Object.fromEntries([
      "visual_information_delta", "sequence_grammar", "spatial_continuity", "audiovisual_intent",
    ].map((key) => [key, structuredClone(frame[key] ?? {})]));
    Object.assign(frame, structuredClone(authored));
    for (const key of Object.keys(inheritedQuality)) {
      frame[key] = { ...inheritedQuality[key], ...structuredClone(authored[key]) };
    }
    Object.assign(frame, normalizeVisualBeatQuality(frame));
    frame.visual_novelty_directive = frame.visual_beat_focus;
    const evidence = frame.visual_beat_action_evidence.toLowerCase().replace(/[\p{P}\p{S}]+/gu, " ").replace(/\s+/gu, " ").trim();
    const excerpt = frame.visual_beat_script_excerpt.toLowerCase().replace(/[\p{P}\p{S}]+/gu, " ").replace(/\s+/gu, " ").trim();
    if (!excerpt.includes(evidence)) throw new Error(`Density repair action evidence is absent from ${frame.visual_beat_id} exact script span.`);
  }
  const qualityBlockers = visualBeatQualityContractFindings([first, second], {
    analyticsEvidenceIds: original.retention_reset?.evidence_ids ?? [],
    emphasisMomentIds: original.audiovisual_intent?.emphasis_moment_ids ?? [],
  }).filter((finding) => finding.severity === "blocker");
  if (qualityBlockers.length) {
    throw new Error(`Density repair frames violate visual quality contract: ${qualityBlockers.map((finding) => finding.code).join(", ")}.`);
  }
  const output = [...beats.slice(0, index), first, second, ...beats.slice(index + 1)];
  if (!same(output.slice(0, index), beats.slice(0, index))
    || !same(output.slice(index + 2), beats.slice(index + 1))) {
    throw new Error("Density repair changed an untargeted beat.");
  }
  return { beats: output, before_grouping_lock_sha256: groupingLockHash(beats),
    after_grouping_lock_sha256: groupingLockHash(output),
    prior_visual_beat_id: original.visual_beat_id,
    new_visual_beat_ids: [first.visual_beat_id, second.visual_beat_id],
    hold_seconds: [Number(firstHold.toFixed(3)), Number(secondHold.toFixed(3))] };
}

export function reviewedChunkPrompt({ basePrompt, recoveryGeneration, priorError }) {
  return recoveryGeneration > 0
    ? `${basePrompt}\n\nExact failed-atom recovery ${recoveryGeneration}: the prior packet for only these atoms failed structural validation with: ${priorError}. Return one complete corrected JSON packet for these same atoms. Timing goals remain advisory; repair only structural coverage, ordering, transition, identity, evidence, or state-contract errors.`
    : basePrompt;
}

export function reviewedChunkInputHash(options) { return sha256(reviewedChunkPrompt(options)); }
