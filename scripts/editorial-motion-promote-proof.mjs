#!/usr/bin/env node

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const flags = parseFlags(process.argv.slice(2));

function parseFlags(parts) {
  const parsed = {};
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (!part.startsWith("--")) continue;
    const key = part.slice(2);
    const value = parts[index + 1] && !parts[index + 1].startsWith("--") ? parts[index + 1] : "true";
    parsed[key] = value;
    if (value !== "true") index += 1;
  }
  return parsed;
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function hashFile(filePath) {
  return createHash("sha256").update(await fs.readFile(filePath)).digest("hex");
}

function assertPassed(plan, label) {
  if (plan?.status !== "passed") throw new Error(`Missing passed ${label}.`);
}

function uniqueMap(rows, field, label) {
  const map = new Map();
  for (const row of rows) {
    const id = String(row?.[field] ?? "");
    if (!id) throw new Error(`${label} contains a row without ${field}.`);
    if (map.has(id)) throw new Error(`${label} contains duplicate ${field}: ${id}`);
    map.set(id, row);
  }
  return map;
}

function countBehavior(rows, behavior) {
  return rows.filter((row) => String(row?.behavior ?? "") === behavior).length;
}

export function promoteEditorialMotionPlans({
  baseMotionPlan,
  proofMotionPlan,
  baseTransitionPlan,
  proofTransitionPlan,
  scopeEndSec,
  variantLabel = "editorial-motion",
}) {
  assertPassed(baseMotionPlan, "base motion plan");
  assertPassed(proofMotionPlan, "proof motion plan");
  assertPassed(baseTransitionPlan, "base transition plan");
  assertPassed(proofTransitionPlan, "proof transition plan");
  if (!(Number(scopeEndSec) > 0)) throw new Error("scopeEndSec must be greater than zero.");

  const baseIntents = baseMotionPlan.motion_intents ?? [];
  const proofIntents = proofMotionPlan.motion_intents ?? [];
  const baseById = uniqueMap(baseIntents, "image_id", "Base motion plan");
  const proofById = uniqueMap(proofIntents, "image_id", "Proof motion plan");
  const scopedBaseIds = baseIntents
    .filter((row) => Number(row.start_sec ?? 0) < Number(scopeEndSec))
    .map((row) => String(row.image_id));
  const scopedBaseSet = new Set(scopedBaseIds);

  for (const imageId of scopedBaseIds) {
    if (!proofById.has(imageId)) throw new Error(`Proof motion plan is missing in-scope image: ${imageId}`);
  }
  for (const [imageId, row] of proofById) {
    if (!baseById.has(imageId)) throw new Error(`Proof motion plan contains unknown image: ${imageId}`);
    if (!scopedBaseSet.has(imageId) || Number(row.start_sec ?? 0) >= Number(scopeEndSec)) {
      throw new Error(`Proof motion plan contains out-of-scope image: ${imageId}`);
    }
  }

  let restoredTimingCount = 0;
  const motionIntents = baseIntents.map((base) => {
    const imageId = String(base.image_id);
    if (!scopedBaseSet.has(imageId)) return base;
    const proof = proofById.get(imageId);
    if (
      Number(proof.start_sec) !== Number(base.start_sec)
      || Number(proof.duration_sec) !== Number(base.duration_sec)
    ) restoredTimingCount += 1;
    return {
      ...base,
      ...proof,
      image_id: base.image_id,
      scene_id: base.scene_id,
      visual_beat_id: base.visual_beat_id,
      start_sec: base.start_sec,
      duration_sec: base.duration_sec,
      promoted_from_proof: variantLabel,
    };
  });

  const untouchedMotionIntents = motionIntents.filter((row) => !scopedBaseSet.has(String(row.image_id)));
  const expectedUntouched = baseIntents.filter((row) => !scopedBaseSet.has(String(row.image_id)));
  if (JSON.stringify(untouchedMotionIntents) !== JSON.stringify(expectedUntouched)) {
    throw new Error("Promotion modified an out-of-scope motion intent.");
  }
  if (motionIntents.length !== baseIntents.length) throw new Error("Promotion changed the full motion-intent count.");

  const proofTransitions = proofTransitionPlan.transition_events ?? [];
  const retainedBaseTransitions = (baseTransitionPlan.transition_events ?? [])
    .filter((row) => Number(row.start_sec ?? 0) >= Number(scopeEndSec));
  for (const event of proofTransitions) {
    if (!baseById.has(String(event.from_image_id)) || !baseById.has(String(event.to_image_id))) {
      throw new Error(`Proof transition references an unknown full-timeline image: ${event.from_image_id} -> ${event.to_image_id}`);
    }
    if (Number(event.start_sec ?? 0) >= Number(scopeEndSec)) {
      throw new Error(`Proof transition is outside the approved scope: ${event.to_image_id}`);
    }
  }
  const transitionEvents = [...proofTransitions, ...retainedBaseTransitions]
    .sort((left, right) => Number(left.start_sec ?? 0) - Number(right.start_sec ?? 0));
  uniqueMap(transitionEvents, "to_image_id", "Promoted transition plan");

  const now = new Date().toISOString();
  const motionPlan = {
    ...baseMotionPlan,
    schema: "goldflow_motion_edit_plan_v2",
    status: "passed",
    scope: { kind: "full_episode_variant", promoted_scope_start_sec: 0, promoted_scope_end_sec: Number(scopeEndSec) },
    policy: "Operator-approved bounded editorial motion replaces only matching opening cuts; full-timeline identities and timing remain authoritative from the base plan.",
    motion_intent_count: motionIntents.length,
    keyframed_motion_intent_count: motionIntents.filter((row) => Array.isArray(row.motion_keyframes)).length,
    static_hold_count: countBehavior(motionIntents, "static_hold"),
    layered_parallax_count: motionIntents.filter((row) => row.depth_treatment?.mode === "layered_parallax").length,
    motion_intents: motionIntents,
    updated_at: now,
  };
  const transitionPlan = {
    ...baseTransitionPlan,
    schema: "goldflow_transition_edit_plan_v2",
    status: "passed",
    scope: { kind: "full_episode_variant", promoted_scope_start_sec: 0, promoted_scope_end_sec: Number(scopeEndSec) },
    policy: "Operator-approved proof transitions replace only boundaries inside the promoted opening scope; later base transitions remain unchanged.",
    transition_sfx_enabled: transitionEvents.some((event) => Boolean(event.transition_sfx)),
    transition_event_count: transitionEvents.length,
    transition_events: transitionEvents,
    updated_at: now,
  };
  const metrics = {
    promoted_motion_intent_count: scopedBaseIds.length,
    untouched_motion_intent_count: expectedUntouched.length,
    restored_full_timeline_timing_count: restoredTimingCount,
    proof_transition_event_count: proofTransitions.length,
    retained_base_transition_event_count: retainedBaseTransitions.length,
    full_transition_event_count: transitionEvents.length,
    static_hold_count: motionPlan.static_hold_count,
    layered_parallax_count: motionPlan.layered_parallax_count,
  };
  return { motionPlan, transitionPlan, metrics };
}

async function main() {
  if (!flags["episode-dir"]) throw new Error("--episode-dir is required.");
  if (!flags["proof-motion-plan"]) throw new Error("--proof-motion-plan is required.");
  if (!flags["proof-transition-plan"]) throw new Error("--proof-transition-plan is required.");
  if (!flags["output-dir"]) throw new Error("--output-dir is required.");

  const episodeDir = path.resolve(flags["episode-dir"]);
  const episode = String(flags.episode ?? path.basename(episodeDir) ?? "ep_01");
  const variantLabel = String(flags["variant-label"] ?? "editorial-motion").trim().replace(/[^a-zA-Z0-9._-]+/g, "-");
  const scopeEndSec = Number(flags["scope-end-sec"] ?? 60);
  const outputDir = path.resolve(flags["output-dir"]);
  const baseMotionPath = path.resolve(flags["base-motion-plan"] ?? path.join(episodeDir, `motion_edit_plan_${episode}.json`));
  const baseTransitionPath = path.resolve(flags["base-transition-plan"] ?? path.join(episodeDir, `transition_edit_plan_${episode}.json`));
  const proofMotionPath = path.resolve(flags["proof-motion-plan"]);
  const proofTransitionPath = path.resolve(flags["proof-transition-plan"]);
  const motionOutputPath = path.join(outputDir, `motion_edit_plan_${episode}-${variantLabel}-full.json`);
  const transitionOutputPath = path.join(outputDir, `transition_edit_plan_${episode}-${variantLabel}-full.json`);
  const reportOutputPath = path.join(outputDir, `editorial_motion_promotion_${variantLabel}_report.json`);

  const [baseMotionPlan, proofMotionPlan, baseTransitionPlan, proofTransitionPlan] = await Promise.all([
    readJson(baseMotionPath),
    readJson(proofMotionPath),
    readJson(baseTransitionPath),
    readJson(proofTransitionPath),
  ]);
  const promoted = promoteEditorialMotionPlans({
    baseMotionPlan,
    proofMotionPlan,
    baseTransitionPlan,
    proofTransitionPlan,
    scopeEndSec,
    variantLabel,
  });
  const sourcePaths = [baseMotionPath, proofMotionPath, baseTransitionPath, proofTransitionPath];
  const sourceHashes = Object.fromEntries(await Promise.all(
    sourcePaths.map(async (filePath) => [filePath, await hashFile(filePath)]),
  ));
  promoted.motionPlan.source_hashes = sourceHashes;
  promoted.transitionPlan.source_hashes = sourceHashes;
  await writeJson(motionOutputPath, promoted.motionPlan);
  await writeJson(transitionOutputPath, promoted.transitionPlan);
  const report = {
    schema: "goldflow_editorial_motion_promotion_v1",
    status: "passed",
    episode_dir: episodeDir,
    variant_label: variantLabel,
    scope_end_sec: scopeEndSec,
    motion_plan_path: motionOutputPath,
    transition_plan_path: transitionOutputPath,
    ...promoted.metrics,
    source_hashes: sourceHashes,
    updated_at: new Date().toISOString(),
  };
  await writeJson(reportOutputPath, report);
  console.log(JSON.stringify(report, null, 2));
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
