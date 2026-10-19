// Sample-exact narration retime: when reviewed retakes change unit lengths, every pause keeps
// its exact sample count and each unit's interior scales linearly to its new length. Mapping is
// monotonic, so scene, keyframe and word order and contiguity are preserved; no planner, image,
// tempo or trimming change is involved.

import { promises as fs } from "node:fs";
import { sha256File } from "./file-hash.mjs";

export const NARRATION_RETIME_SPEC_SCHEMA = "goldflow_narration_retime_spec_v1";
export const NARRATION_RETIME_RECEIPT_SCHEMA = "goldflow_narration_retime_receipt_v1";
const RATE = 24000;
const TIME_KEYS = new Set(["start_sec", "end_sec", "at_sec"]);

export function narrationRetimeAdmission(status = {}, flags = {}) {
  const deny = (reason) => ({ allowed: false, reason });
  const keys = Object.keys(flags ?? {});
  if (keys.length !== 2 || !keys.includes("episode-dir") || !keys.includes("spec")) return deny("exact_episode_dir_and_spec_required");
  if (status.identity?.schema !== "goldflow_run_identity_v2" || status.media_workflow?.id !== "generated_visuals_v1") return deny("unsupported_identity_or_workflow");
  if (status.identity?.render_profile !== "panel_composition_v1") return deny("panel_composition_render_required");
  // The retime replaces the render, so it gates on the passed composition plan and a final QA
  // that passed on this production rather than on a render a code change may have staled.
  const state = (stage) => status.stage_ledger?.find((row) => row.stage === stage)?.state;
  if (state("motion_edit_plan") !== "passed") return deny("passed_panel_composition_plan_required");
  if (state("final_qa") !== "passed") return deny("passed_final_qa_required");
  return { allowed: true, reason: "exact_reviewed_narration_retime" };
}

// oldUnits/newUnits/gaps are sample counts per unit (gaps[k] follows unit k).
export function buildRetimeMap(oldUnits, newUnits, gaps) {
  if (oldUnits.length !== newUnits.length || gaps.length < oldUnits.length - 1) throw new Error("Retime layout lengths differ.");
  const rows = []; let oldOffset = 0; let newOffset = 0;
  oldUnits.forEach((oldSamples, k) => {
    if (!(oldSamples > 0 && newUnits[k] > 0)) throw new Error(`Unit ${k} has no samples.`);
    const gap = k < gaps.length ? gaps[k] : 0;
    rows.push({ oldStart: oldOffset, oldUnit: oldSamples, newStart: newOffset, newUnit: newUnits[k], gap });
    oldOffset += oldSamples + gap; newOffset += newUnits[k] + gap;
  });
  return { rows, oldTotal: oldOffset, newTotal: newOffset };
}

export function mapSample(map, sample) {
  const { rows } = map;
  if (sample <= 0) return sample;
  if (sample >= map.oldTotal) return map.newTotal + (sample - map.oldTotal);
  let lo = 0; let hi = rows.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (rows[mid].oldStart <= sample) lo = mid; else hi = mid - 1; }
  const row = rows[lo]; const inside = sample - row.oldStart;
  if (inside < row.oldUnit) return row.newStart + inside * row.newUnit / row.oldUnit;
  return row.newStart + row.newUnit + (inside - row.oldUnit);
}

export const mapSeconds = (map, sec) => Number((mapSample(map, sec * RATE) / RATE).toFixed(6));

function remapTimes(value, map) {
  if (Array.isArray(value)) return value.map((row) => remapTimes(row, map));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key,
    TIME_KEYS.has(key) && typeof child === "number" ? mapSeconds(map, child) : remapTimes(child, map)]));
}

export function retimeTimeline(timeline, map, audio) {
  const scenes = remapTimes(timeline.scenes, map);
  return { ...timeline, scenes, duration_sec: Number((map.newTotal / RATE).toFixed(6)), audio: { ...timeline.audio, ...audio } };
}

export function retimeWordTiming(wordTiming, map, audio) {
  const words = (wordTiming.words ?? []).map((word) => ({ ...word,
    start_sec: mapSeconds(map, word.start_sec), end_sec: mapSeconds(map, word.end_sec) }));
  return { ...wordTiming, words, audio_duration_sec: Number((map.newTotal / RATE).toFixed(6)),
    narration_audio_path: audio.path, narration_audio_hash: audio.sha256 };
}

// Render-side loader: the receipt must bind the exact current panel plan, its timeline, the
// canonical word timing, audio bed and stitch report; it then supplies the retimed timeline,
// word timing and mastered audio. Original artifacts stay hash-bound and untouched.
export async function loadNarrationRetimeForRender({ receiptPath, panelPlan, wordTimingPath, audioBedReportPath, audioStitchReportPath }) {
  const need = (ok, message) => { if (!ok) throw new Error(`Narration retime receipt: ${message}.`); };
  const receiptSha256 = await sha256File(receiptPath);
  const receipt = JSON.parse(await fs.readFile(receiptPath, "utf8"));
  need(receipt.schema === NARRATION_RETIME_RECEIPT_SCHEMA && receipt.status === "passed", "schema/status invalid");
  const bound = receipt.bindings ?? {};
  need(bound.panel_plan_path === panelPlan.planPath && bound.panel_plan_sha256 === await sha256File(panelPlan.planPath), "panel plan changed");
  need(bound.timeline_sha256 === panelPlan.plan.timeline.sha256, "panel timeline changed");
  for (const [key, file] of [["word_timing", wordTimingPath], ["audio_bed_report", audioBedReportPath], ["stitch_report", audioStitchReportPath]]) {
    need(bound[`${key}_path`] && await fs.realpath(bound[`${key}_path`]) === await fs.realpath(file) && bound[`${key}_sha256`] === await sha256File(file), `${key} changed`);
  }
  for (const key of ["timeline", "word_timing", "master", "mastering_report"]) {
    need(receipt.outputs?.[key]?.path && await sha256File(receipt.outputs[key].path) === receipt.outputs[key].sha256, `${key} output changed`);
  }
  const read = async (key) => JSON.parse(await fs.readFile(receipt.outputs[key].path, "utf8"));
  const [timeline, wordTiming, mastering] = await Promise.all([read("timeline"), read("word_timing"), read("mastering_report")]);
  need(mastering.status === "passed" && mastering.output_sha256 === receipt.outputs.master.sha256, "mastering report does not bind the master");
  need(timeline.audio?.sha256 === receipt.outputs.master.sha256 && wordTiming.narration_audio_hash === receipt.outputs.master.sha256, "retimed artifacts do not bind the master");
  return { receipt, receiptPath, receiptSha256, timeline, wordTiming, mastering,
    audio: { path: receipt.outputs.master.path, sha256: receipt.outputs.master.sha256 }, durationSec: timeline.duration_sec,
    sourceHashes: { [receiptPath]: receiptSha256, ...Object.fromEntries(Object.values(receipt.outputs).map((row) => [row.path, row.sha256])) } };
}
