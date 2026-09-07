import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  authorNarrationPerformanceDirection,
  narrationPerformancePacketPlanForTests,
} from "../lib/narration-performance-author.mjs";
import { contentProfileForIdentity } from "../lib/content-profiles.mjs";
import { compileNarrationProviderRequest } from "../lib/narration-provider-adapter.mjs";

const atomicUnits = [{
  segment_id: "voice_seg_01",
  source_unit_refs: [{ segment_id: "voice_seg_01", unit_index: 1 }],
  spoken_text: "Could the same powers change the outcome?",
  kind: "narration",
  source_speaker: "NARRATOR",
}];
const packetFor = (contentProfile) => narrationPerformancePacketPlanForTests(
  atomicUnits, { contentProfile },
)[0];
const legacy = packetFor(undefined);
// Captured before profile routing existed: preserve complete bytes, not merely
// selected phrases, so historical/manhwa content-addressed caches remain valid.
assert.equal(legacy.prompt_sha256, "98b8a8cb03da6bf92075c8c8982e83182bf5eccf76be1723c8297be0985899c4");
assert.equal(legacy.prompt_bytes, 3585);
const manhwa = contentProfileForIdentity({});
assert.equal(packetFor(manhwa).prompt, legacy.prompt);
assert.equal(packetFor({
  ...manhwa,
  planner_roles: { narration_performance: "an unrelated role" },
  voice: { performance_directives: ["An unrelated directive."] },
}).prompt, legacy.prompt);

const documentary = contentProfileForIdentity({ content_profile: "asset_afterlife_v1" });
const neutral = packetFor(documentary);
assert.doesNotMatch(neutral.prompt, /YouTube manhwa recap|energetic recap cadence/);
assert.match(neutral.prompt, /locked content profile/);
assert.match(neutral.prompt, /"content_profile":"asset_afterlife_v1"/);
assert.match(neutral.prompt, /Preserve all spoken words in exact order/);
assert.notEqual(neutral.packet_id, legacy.packet_id);

const embedded = {
  ...structuredClone(documentary),
  version: "fixture-locked-voice-1",
  planner_roles: {
    ...documentary.planner_roles,
    narration_performance: "a thoughtful host exploring an evidence-backed question with the audience",
  },
  voice: {
    performance_directives: [
      "Let the opening question sound curious rather than pre-announced.",
      "Keep uncertainty audible without adding words or fake hesitations.",
    ],
  },
};
const identity = {
  content_profile: "asset_afterlife_v1",
  content_profile_config: embedded,
};
const lockedProfile = contentProfileForIdentity(identity);
const directed = packetFor(lockedProfile);
assert.match(directed.prompt, /a thoughtful host exploring an evidence-backed question/);
assert.match(directed.prompt, /Let the opening question sound curious/);
assert.match(directed.prompt, /"version":"fixture-locked-voice-1"/);
assert.doesNotMatch(directed.prompt, /YouTube manhwa recap|energetic recap cadence/);
assert.notEqual(directed.prompt_sha256, neutral.prompt_sha256);
assert.notEqual(directed.packet_id, neutral.packet_id);
assert.notEqual(packetFor({
  ...lockedProfile,
  voice: { performance_directives: ["A different locked delivery direction."] },
}).prompt_sha256, directed.prompt_sha256);
assert.notEqual(packetFor({ ...lockedProfile, version: "fixture-locked-voice-2" }).packet_id, directed.packet_id);
assert.equal(createHash("sha256").update(directed.prompt).digest("hex"), directed.prompt_sha256);
assert.equal(directed.prompt_bytes, Buffer.byteLength(directed.prompt));
lockedProfile.voice.performance_directives.push("Mutated only on a resolved copy.");
assert.equal(embedded.voice.performance_directives.length, 2);

// The official caller must resolve the immutable identity before authoring and
// pass that selected profile; command flags or mutable profile files are not a
// competing voice-direction source.
const caller = await fs.readFile(new URL("../voice-direction-gate.mjs", import.meta.url), "utf8");
const main = caller.slice(caller.indexOf("async function main()"));
const resolvedAt = main.indexOf("const contentProfile = contentProfileForIdentity(runIdentity);");
const authorAt = main.indexOf("await authorNarrationPerformanceDirection({");
assert.ok(resolvedAt >= 0 && resolvedAt < authorAt);
assert.match(main.slice(authorAt, main.indexOf("});", authorAt)), /\n\s*contentProfile,/);

const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-narration-profile-test-"));
try {
  let submittedPrompt = null;
  const result = await authorNarrationPerformanceDirection({
    atomicUnits,
    sourceScriptSha256: "a".repeat(64),
    episodeDir: scratch,
    repoRoot: path.resolve(new URL("../..", import.meta.url).pathname),
    contentProfile: contentProfileForIdentity(identity),
    provider: "fixture-no-network",
    model: "fixture-no-model",
    plannerExecutor: async ({ prompt }) => {
      assert.equal(submittedPrompt, null, "one provider-free fixture invocation");
      const marker = JSON.parse(await fs.readFile(path.join(scratch, "narration_editorial_contract.json"), "utf8"));
      assert.equal(marker.mode, "profile_directed_v1", "contract is durable before submission");
      submittedPrompt = prompt;
      return {
        provider: "fixture-no-network",
        model: "fixture-no-model",
        content: JSON.stringify({
          chapters: [{
            segment_id: "voice_seg_01",
            dramatic_function: "Explore the question.",
            audience_effect: "Curiosity.",
            energy_start: 2,
            energy_end: 2,
            tension_peak: 2,
            intimacy: 3,
            pace: "measured",
            reveal_weight: 1,
            transition_from_previous: "Opening.",
            avoidance: "Do not imply certainty.",
          }],
          units: [{
            source_ref_keys: ["voice_seg_01:u001"],
            spoken_text: atomicUnits[0].spoken_text,
            dialogue_separation: "preserve",
            boundary_after: "episode_end",
            performance_intent: {
              energy: "controlled", tension: "warm", intimacy: "close",
              pace: "measured", emphasis: [], pause_strategy: "punctuation_led",
              style_tags: [],
            },
          }],
        }),
      };
    },
  });
  assert.equal(submittedPrompt, directed.prompt);
  assert.equal(result.artifact.authoring.calls[0].prompt_sha256, directed.prompt_sha256);
  assert.equal(result.artifact.authoring.calls[0].packet_id, directed.packet_id);
  assert.equal(result.artifact.units[0].spoken_text, atomicUnits[0].spoken_text);
  assert.equal(result.artifact.authoring.editorial_contract.mode, "profile_directed_v1");

  let unexpectedCalls = 0;
  const noSubmission = async () => { unexpectedCalls += 1; throw new Error("unexpected creative submission"); };
  const mismatchOptions = {
    atomicUnits, sourceScriptSha256: "a".repeat(64), episodeDir: scratch,
    repoRoot: scratch, contentProfile: { ...embedded, version: "changed-after-first-submission" },
    plannerExecutor: noSubmission,
  };
  await assert.rejects(() => authorNarrationPerformanceDirection(mismatchOptions), /editorial contract is malformed or changed/);
  // Simulate an interruption after the durable marker but before the aggregate.
  await fs.unlink(path.join(scratch, "narration_actionable_direction.json"));
  await assert.rejects(() => authorNarrationPerformanceDirection(mismatchOptions), /editorial contract is malformed or changed/);
  await fs.writeFile(path.join(scratch, "narration_editorial_contract.json"), "{broken-json");
  await assert.rejects(() => authorNarrationPerformanceDirection(mismatchOptions), SyntaxError);
  assert.equal(unexpectedCalls, 0);

  // Editorial guidance is not an effective Qwen Base instruction or speed API.
  const qwen = compileNarrationProviderRequest({
    unit_id: "fixture-unit",
    spoken_text: atomicUnits[0].spoken_text,
    performance_intent: result.artifact.units[0].performance_intent,
  }, { provider: "qwen_local", nativeSpeed: 0.9 });
  assert.equal(qwen.request.text, atomicUnits[0].spoken_text);
  assert.equal(qwen.request.instruction, undefined);
  assert.equal(qwen.request.native_speed, undefined);
  assert.ok(qwen.capability_losses.some((row) => row.reason === "provider_has_no_instruction_channel"));
  assert.ok(qwen.capability_losses.some((row) => row.control === "native_speed"));
} finally {
  await fs.rm(scratch, { recursive: true, force: true });
}

const historyScratch = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-narration-history-test-"));
try {
  const historyUnits = Array.from({ length: 97 }, (_, index) => ({
    segment_id: "voice_seg_history",
    source_unit_refs: [{ segment_id: "voice_seg_history", unit_index: index + 1 }],
    spoken_text: `Exact historical sentence ${index + 1}.`,
    kind: "narration", source_speaker: "NARRATOR",
  }));
  const oldPackets = narrationPerformancePacketPlanForTests(historyUnits);
  const newPackets = narrationPerformancePacketPlanForTests(historyUnits, { contentProfile: documentary });
  assert.equal(oldPackets.length, 2);
  assert.notEqual(oldPackets[1].packet_id, newPackets[1].packet_id);
  const sourceHash = "b".repeat(64);
  const digest = (value) => createHash("sha256").update(value).digest("hex");
  const packetManifestHash = digest(JSON.stringify(oldPackets.map((packet) => ({
    packet_id: packet.packet_id, prompt_sha256: packet.prompt_sha256,
    source_ref_keys: packet.source_ref_keys,
  }))));
  const responseFor = (packet, index) => JSON.stringify({
    chapters: [{
      segment_id: "voice_seg_history", dramatic_function: "Continue the historical narration.",
      audience_effect: "Clarity.", energy_start: 2, energy_end: 2, tension_peak: 2,
      intimacy: 2, pace: "steady_forward", reveal_weight: 1,
      transition_from_previous: "Continue.", avoidance: "Avoid a cadence reset.",
    }],
    units: packet.chunk.map((unit, unitIndex) => ({
      source_ref_keys: [packet.source_ref_keys[unitIndex]],
      spoken_text: unit.spoken_text, dialogue_separation: "preserve",
      boundary_after: index === oldPackets.length - 1 && unitIndex === packet.chunk.length - 1
        ? "episode_end" : "sentence",
      performance_intent: {
        energy: "controlled", tension: "neutral", intimacy: "standard", pace: "steady_forward",
        emphasis: [], pause_strategy: "punctuation_led", style_tags: [],
      },
    })),
  });
  for (const historyKind of ["blocked", "interrupted"]) {
    const fixtureDir = path.join(historyScratch, historyKind);
    const callDir = path.join(fixtureDir, "_codex_calls", "narration-performance-author");
    await fs.mkdir(callDir, { recursive: true });
    const passedPath = path.join(callDir, `${oldPackets[0].packet_id}.json`);
    const passedBytes = responseFor(oldPackets[0], 0);
    const passedMetadata = JSON.stringify({
      status: "passed", provider: "codex_cli", model: "gpt-5.6-sol",
      reasoning_effort: "medium", stage_name: "narration_performance",
      prompt_sha256: oldPackets[0].prompt_sha256,
    });
    await fs.writeFile(passedPath, passedBytes);
    await fs.writeFile(`${passedPath}.meta.json`, passedMetadata);
    if (historyKind === "blocked") {
      await fs.writeFile(path.join(fixtureDir, "narration_actionable_direction.json"), JSON.stringify({
        schema: "goldflow_narration_actionable_direction_v3", status: "blocked",
        source_script_sha256: sourceHash,
        authoring: { calls: [{ packet_id: oldPackets[0].packet_id, status: "passed" }] },
        repair_scope: {
          packet_manifest_sha256: packetManifestHash,
          failed_packet_ids: [oldPackets[1].packet_id],
        },
      }));
    }
    let repairCalls = 0;
    const recovered = await authorNarrationPerformanceDirection({
      atomicUnits: historyUnits, sourceScriptSha256: sourceHash,
      episodeDir: fixtureDir, repoRoot: fixtureDir,
      contentProfile: documentary, provider: "codex_cli", model: "gpt-5.6-sol",
      ...(historyKind === "blocked" ? {
        repairPacketIds: [oldPackets[1].packet_id], repairReason: "Reviewed only the historical failed packet.",
      } : {}),
      plannerExecutor: async ({ prompt }) => {
        repairCalls += 1;
        assert.ok(prompt.startsWith(oldPackets[1].prompt));
        assert.doesNotMatch(prompt, /Locked narration editorial contract/);
        const marker = JSON.parse(await fs.readFile(path.join(fixtureDir, "narration_editorial_contract.json"), "utf8"));
        assert.equal(marker.mode, "legacy_manhwa_prompt_v1");
        return { content: responseFor(oldPackets[1], 1), provider: "codex_cli", model: "gpt-5.6-sol" };
      },
    });
    assert.equal(repairCalls, 1, "only the unresolved historical packet reaches the fixture planner");
    assert.equal(recovered.artifact.authoring.calls[0].reused, true);
    assert.deepEqual(recovered.artifact.authoring.calls.map((row) => row.packet_id), oldPackets.map((row) => row.packet_id));
    assert.equal(recovered.artifact.authoring.editorial_contract.mode, "legacy_manhwa_prompt_v1");
    assert.equal(await fs.readFile(passedPath, "utf8"), passedBytes, "passed chunk remains byte-identical");
    assert.equal(await fs.readFile(`${passedPath}.meta.json`, "utf8"), passedMetadata, "passed provider receipt remains byte-identical");
    assert.equal(recovered.artifact.units.length, historyUnits.length);
  }
  const corruptDir = path.join(historyScratch, "corrupt");
  await fs.mkdir(corruptDir);
  let corruptCalls = 0;
  const corruptOptions = {
    atomicUnits, sourceScriptSha256: sourceHash, episodeDir: corruptDir, repoRoot: corruptDir,
    contentProfile: documentary,
    plannerExecutor: async () => { corruptCalls += 1; throw new Error("unexpected submission"); },
  };
  const corruptPath = path.join(corruptDir, "narration_actionable_direction.json");
  await fs.writeFile(corruptPath, "{broken-json");
  await assert.rejects(() => authorNarrationPerformanceDirection(corruptOptions), SyntaxError);
  await fs.writeFile(corruptPath, "{}");
  await assert.rejects(() => authorNarrationPerformanceDirection(corruptOptions), /Malformed existing narration/);
  assert.equal(corruptCalls, 0, "malformed history never becomes a new creative attempt");
} finally {
  await fs.rm(historyScratch, { recursive: true, force: true });
}

console.log("Narration performance profile routing tests passed (provider-free).");
