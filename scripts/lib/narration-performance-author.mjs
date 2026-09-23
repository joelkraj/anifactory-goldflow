import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  isCodexCacheCompatible,
  readCodexCallMetadata,
  runCodexCli,
} from "./codex-cli-runner.mjs";
import {
  NARRATION_BOUNDARY_CLASSES,
  narrationSourceRefKey,
  normalizeNarrationPerformanceIntent,
  punctuationInsensitiveTokens,
  validateActionableNarrationDirection,
} from "./narration-performance-contract.mjs";
import { contentProfilePlannerRole } from "./content-profiles.mjs";

function sha256(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex");
}

export function extractNarrationPerformanceJsonForTests(content) {
  const raw = String(content ?? "").trim();
  try {
    return { value: JSON.parse(raw), syntax_repair: null };
  } catch {}
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return { value: JSON.parse(fenced[1]), syntax_repair: null };
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const candidate = raw.slice(start, end + 1);
    try { return { value: JSON.parse(candidate), syntax_repair: null }; } catch {}
    // Preserve the raw provider output and correct only a missing final unit
    // object brace. All source-word and coverage validators still run below.
    if (candidate.endsWith("}]}") && (candidate.match(/\{/g)?.length ?? 0) === (candidate.match(/\}/g)?.length ?? 0) + 1) {
      return { value: JSON.parse(`${candidate.slice(0, -2)}}]}`), syntax_repair: "missing_final_unit_object_brace" };
    }
  }
  throw new Error("Narration performance author did not return valid JSON.");
}

export function narrationUnitHasTerminalPunctuationForTests(text) {
  return /[.!?…][\"'”’)]*$/.test(String(text ?? "").trim());
}

export const NARRATION_PERFORMANCE_TARGET_ATOMS = 96;

function segmentChunks(
  atomicUnits,
  maximumAtoms = NARRATION_PERFORMANCE_TARGET_ATOMS,
) {
  const segments = [];
  for (const unit of atomicUnits) {
    const segmentId = String(unit.segment_id ?? unit.source_segment_ids?.[0] ?? "");
    let row = segments.at(-1);
    if (!row || row.segment_id !== segmentId) {
      row = { segment_id: segmentId, units: [] };
      segments.push(row);
    }
    row.units.push(unit);
  }
  const chunks = [];
  let current = [];
  for (const segment of segments) {
    if (current.length && current.length + segment.units.length > maximumAtoms) {
      chunks.push(current);
      current = [];
    }
    if (segment.units.length > maximumAtoms) {
      if (current.length) chunks.push(current);
      for (let index = 0; index < segment.units.length; index += maximumAtoms) {
        chunks.push(segment.units.slice(index, index + maximumAtoms));
      }
      current = [];
      continue;
    }
    current.push(...segment.units);
  }
  if (current.length) chunks.push(current);
  return chunks;
}

function narrationEditorialDirection(contentProfile) {
  // Preserve the historical prompt bytes and content-addressed packets for
  // legacy/manhwa runs. Explicit other profiles must not inherit that cadence.
  if (!contentProfile?.id || contentProfile.id === "manhwa_recap_v1") {
    return {
      role: "the provider-neutral narration performance editor for a fast, emotional YouTube manhwa recap",
      cadence: "Use grouping and punctuation to create energetic recap cadence, clean emotional turns, clear dialogue, and natural breath points without melodramatic pauses after every sentence.",
      continuity: "Keep tightly connected action sentences flowing. Separate quoted dialogue when it improves clarity.",
      profileContext: "",
    };
  }
  const role = contentProfilePlannerRole(
    contentProfile,
    "narration_performance",
    "a provider-neutral narration performance editor for the locked content profile",
  );
  const directives = Array.isArray(contentProfile?.voice?.performance_directives)
    ? contentProfile.voice.performance_directives.map(String).map((value) => value.trim()).filter(Boolean)
    : [];
  return {
    role,
    cadence: "Use grouping and punctuation for natural phrasing and clear thought boundaries appropriate to the locked content profile. Preserve the approved text's questions, qualifications, and emphasis; do not impose a recap cadence or add melodramatic pauses.",
    continuity: "Keep tightly connected thoughts flowing. Separate quoted dialogue when it improves clarity.",
    profileContext: `\nLocked narration editorial contract (authoring guidance, not a provider instruction channel; exact-word and capability rules still apply):\n${JSON.stringify({
      content_profile: contentProfile.id,
      version: contentProfile.version ?? null,
      content_family: contentProfile.content_family ?? null,
      narration_performance_role: role,
      performance_directives: directives,
    })}\n`,
  };
}

function promptForChunk(units, chunkIndex, chunkCount, contentProfile = null) {
  const direction = narrationEditorialDirection(contentProfile);
  const atoms = units.map((unit) => {
    const mergeBarrier = unit.source_merge_barrier === true
      || unit.risk_flags?.includes("system_ui_atomic")
      || unit.risk_flags?.includes("speaker_or_performance_turn")
      || unit.risk_flags?.includes("tts_override_applied");
    const speaker = String(unit.source_speaker ?? "").trim();
    const kind = String(unit.kind ?? "").trim();
    return {
      source_ref_key: narrationSourceRefKey(unit.source_unit_refs?.[0]),
      segment_id: unit.segment_id,
      spoken_text: unit.spoken_text,
      word_count: punctuationInsensitiveTokens(unit.spoken_text).length,
      ...(kind && kind !== "narration" ? { kind } : {}),
      ...(speaker && speaker !== "NARRATOR" ? { source_speaker: speaker } : {}),
      ...(mergeBarrier ? { merge_barrier: true } : {}),
    };
  });
  return `You are ${direction.role}.

The output will be compiled through a capability adapter. Every model receives exact spoken text, punctuation, sentence-complete grouping, semantic boundary timing, and a locked voice. Models with an instruction channel also receive your restrained performance intent. Models without one still benefit from your punctuation, grouping, and boundary classes.

Return JSON only in this exact shape:
{"chapters":[{"segment_id":"voice_seg_01","dramatic_function":"concise function","audience_effect":"concise effect","energy_start":2,"energy_end":3,"tension_peak":3,"intimacy":2,"pace":"steady_forward","reveal_weight":2,"transition_from_previous":"concise handoff","avoidance":"likely bad read"}],"units":[{"source_ref_keys":["voice_seg_01:u001"],"spoken_text":"Exact same spoken words with authored punctuation.","dialogue_separation":"preserve","boundary_after":"sentence","performance_intent":{"energy":"controlled","tension":"neutral","intimacy":"standard","pace":"steady_forward","emphasis":[],"pause_strategy":"punctuation_led","style_tags":[]}}]}

Binding rules:
- Preserve every source_ref_key exactly once and in the supplied order.
- Keep each output unit inside one segment_id.
- A merge_barrier atom must remain a standalone output unit.
- Omitted kind/source_speaker/merge_barrier fields mean ordinary narrator narration with no merge barrier.
- Prefer 20-42 words when adjacent sentences belong to one breath and one dramatic thought. Treat 48 words as a soft ceiling and 60 as the hard ceiling. Never split a source sentence to hit a target.
- Every output unit must contain at most 60 spoken words and end with terminal punctuation.
- Preserve all spoken words in exact order. You may change punctuation and capitalization only.
- ${direction.cadence}
- ${direction.continuity}
- boundary_after must be one of continuation, clause, sentence, emphasized_sentence, paragraph, reveal, episode_end. Use reveal only for a genuine disclosure/turn, paragraph for a scene or idea reset, emphasized_sentence sparingly, and ordinary sentence for most joins. Only the final output unit of the final packet may use episode_end.
- performance_intent enums: energy=restrained|low|controlled|high|urgent; tension=neutral|warm|cold|social_pressure|high; intimacy=distant|standard|close; pace=measured|steady|steady_forward|precise|fast; pause_strategy=minimal|punctuation_led|short_precise|reveal_weighted.
- emphasis may contain at most eight short phrases copied exactly from spoken_text. style_tags may contain at most six terse non-spoken descriptors. Do not write dialogue or stage directions into either field.
- Do not emit stage directions, emotion tags, SSML, instructions, commentary, or unsupported controls.
- Return exactly one chapters row for every distinct segment_id present in this packet, in first-seen order. Numeric fields are integers 1-5; pace is measured, steady, steady_forward, precise, or fast. Keep all chapter text fields terse. When a long segment spans packets, describe only this packet's local movement while preserving the same segment_id.${direction.profileContext}

Packet ${chunkIndex + 1} of ${chunkCount}:
Atomic spoken units:
${JSON.stringify(atoms)}`;
}

function validateProsodySpine(parsed, atomicUnits) {
  const rows = Array.isArray(parsed?.chapters) ? parsed.chapters : [];
  const expected = [...new Set(atomicUnits.map((unit) => String(unit.segment_id ?? "")).filter(Boolean))];
  const actual = rows.map((row) => String(row?.segment_id ?? ""));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("Narration chapter prosody spine changed segment coverage or ordering.");
  }
  const allowedPace = new Set(["measured", "steady", "steady_forward", "precise", "fast"]);
  for (const row of rows) {
    for (const field of ["dramatic_function", "audience_effect", "transition_from_previous", "avoidance"]) {
      if (!String(row?.[field] ?? "").trim()) throw new Error(`Narration chapter prosody spine lacks ${field}.`);
    }
    for (const field of ["energy_start", "energy_end", "tension_peak", "intimacy", "reveal_weight"]) {
      const value = Number(row?.[field]);
      if (!Number.isInteger(value) || value < 1 || value > 5) throw new Error(`Narration chapter prosody spine has invalid ${field}.`);
    }
    if (!allowedPace.has(String(row?.pace ?? ""))) throw new Error("Narration chapter prosody spine has invalid pace.");
  }
  return rows.map((row) => ({
    segment_id: String(row.segment_id),
    dramatic_function: String(row.dramatic_function).trim(),
    audience_effect: String(row.audience_effect).trim(),
    energy_start: Number(row.energy_start),
    energy_end: Number(row.energy_end),
    tension_peak: Number(row.tension_peak),
    intimacy: Number(row.intimacy),
    pace: String(row.pace),
    reveal_weight: Number(row.reveal_weight),
    transition_from_previous: String(row.transition_from_previous).trim(),
    avoidance: String(row.avoidance).trim(),
  }));
}

function validateChunkResult(parsed, atomicUnits, chunkIndex, chunkCount) {
  const chapters = validateProsodySpine(parsed, atomicUnits);
  const expected = atomicUnits.map((unit) => narrationSourceRefKey(unit.source_unit_refs?.[0]));
  const rows = Array.isArray(parsed?.units) ? parsed.units : [];
  const actual = rows.flatMap((row) => Array.isArray(row.source_ref_keys) ? row.source_ref_keys.map(String) : []);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("Narration performance author changed source-ref coverage or ordering.");
  }
  const byKey = new Map(atomicUnits.map((unit) => [narrationSourceRefKey(unit.source_unit_refs?.[0]), unit]));
  for (const row of rows) {
    const keys = row.source_ref_keys.map(String);
    const sourceRows = keys.map((key) => byKey.get(key));
    if (new Set(sourceRows.map((unit) => unit.segment_id)).size !== 1) {
      throw new Error("Narration performance author crossed a voice segment.");
    }
    if (keys.length > 1 && sourceRows.some((unit) => (
      unit.source_merge_barrier === true
      || unit.risk_flags?.includes("system_ui_atomic")
      || unit.risk_flags?.includes("speaker_or_performance_turn")
      || unit.risk_flags?.includes("tts_override_applied")
    ))) {
      throw new Error("Narration performance author crossed an atomic performance barrier.");
    }
    const expectedWords = sourceRows.flatMap((unit) => punctuationInsensitiveTokens(unit.spoken_text));
    const actualWords = punctuationInsensitiveTokens(row.spoken_text);
    if (JSON.stringify(actualWords) !== JSON.stringify(expectedWords)) {
      throw new Error(`Narration performance author changed spoken words for ${keys.join(",")}.`);
    }
    if (actualWords.length > 60) throw new Error(`Narration unit exceeds 60 words: ${keys.join(",")}.`);
    if (!narrationUnitHasTerminalPunctuationForTests(row.spoken_text)) {
      throw new Error(`Narration unit lacks terminal punctuation: ${keys.join(",")}.`);
    }
    if (!NARRATION_BOUNDARY_CLASSES.includes(String(row.boundary_after ?? ""))) {
      throw new Error(`Narration boundary class is invalid: ${keys.join(",")}.`);
    }
    const isGlobalFinal = chunkIndex === chunkCount - 1
      && row === rows.at(-1);
    if (isGlobalFinal && row.boundary_after !== "episode_end") {
      throw new Error("The final narration unit must use boundary_after=episode_end.");
    }
    if (!isGlobalFinal && row.boundary_after === "episode_end") {
      throw new Error("Only the final narration unit may use boundary_after=episode_end.");
    }
    const normalizedIntent = normalizeNarrationPerformanceIntent(
      row.performance_intent,
    );
    for (const field of ["energy", "tension", "intimacy", "pace", "pause_strategy"]) {
      if (normalizedIntent[field] !== row.performance_intent?.[field]) {
        throw new Error(`Narration performance intent ${field} is invalid: ${keys.join(",")}.`);
      }
    }
  }
  return {
    chapters,
    units: rows.map((row) => ({
      source_ref_keys: row.source_ref_keys.map(String),
      spoken_text: String(row.spoken_text).trim(),
      dialogue_separation: String(row.dialogue_separation ?? "preserve").trim() || "preserve",
      boundary_after: String(row.boundary_after),
      performance_intent: normalizeNarrationPerformanceIntent(
        row.performance_intent,
      ),
    })),
  };
}

async function runPool(items, concurrency, worker) {
  const output = new Array(items.length);
  let cursor = 0;
  async function runWorker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      output[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, runWorker));
  return output;
}

async function authoredChunk({
  chunk,
  index,
  chunkCount,
  callDir,
  repoRoot,
  provider,
  model,
  reasoningEffort,
  contentProfile = null,
  repairReason = null,
  allowCreativeSubmission = true,
  plannerExecutor = runCodexCli,
}) {
  const packetPrompt = promptForChunk(chunk, index, chunkCount, contentProfile);
  const prompt = repairReason
    ? `${packetPrompt}\n\nEXACT-PACKET REPAIR: The operator reviewed the failed packet and requested one replacement submission for this packet only. Review note: ${String(repairReason).trim()} Preserve the exact source-ref and word contract above; return the complete packet once.`
    : packetPrompt;
  const promptBytes = Buffer.byteLength(prompt, "utf8");
  const promptHash = sha256(prompt);
  const packetId = `performance_packet_${String(index + 1).padStart(3, "0")}_${sha256(packetPrompt).slice(0, 12)}`;
  const outputPath = path.join(
    callDir,
    `${packetId}${repairReason ? `.repair_${promptHash.slice(0, 12)}` : ""}.json`,
  );
  const stageName = "narration_performance";
  const metadata = await readCodexCallMetadata(outputPath);
  let content = isCodexCacheCompatible(metadata, {
    model,
    reasoningEffort,
    promptHash,
    provider,
    stageName,
    planningOverrideStage: "voice_plan",
  })
    ? await fs.readFile(outputPath, "utf8").catch(() => null)
    : null;
  let call = null;
  try {
    if (promptBytes > NARRATION_PERFORMANCE_SAFE_MAX_BYTES) {
      throw new Error(
        `${packetId} final serialized prompt is ${promptBytes} bytes; safe ceiling is ${NARRATION_PERFORMANCE_SAFE_MAX_BYTES} bytes.`,
      );
    }
    if (!content) {
      if (!allowCreativeSubmission) {
        throw new Error(`${packetId} has no compatible passed cache and is outside the exact repair scope.`);
      }
      const requestedTimeoutMs = Number(process.env.ANIFACTORY_NARRATION_PERFORMANCE_TIMEOUT_MS ?? 480_000);
      const timeoutMs = Math.min(
        480_000,
        Number.isFinite(requestedTimeoutMs) && requestedTimeoutMs > 0 ? requestedTimeoutMs : 480_000,
      );
      call = await plannerExecutor({
        prompt,
        stageName,
        repoRoot,
        outputPath,
        provider,
        model,
        reasoningEffort: "medium",
        timeoutMs,
      });
      content = call.content;
    }
    const parsedContent = extractNarrationPerformanceJsonForTests(content);
    const result = validateChunkResult(parsedContent.value, chunk, index, chunkCount);
    return {
      packet_id: packetId,
      packet_index: index,
      status: "passed",
      chapters: result.chapters,
      units: result.units,
      source_ref_keys: chunk.map((unit) => narrationSourceRefKey(unit.source_unit_refs?.[0])),
      provider: call?.provider ?? metadata?.provider ?? "content_addressed_cache",
      model: call?.model ?? metadata?.model ?? model ?? "identity_locked_model",
      reasoning_effort: "medium",
      output_path: outputPath,
      prompt_sha256: promptHash,
      prompt_bytes: promptBytes,
      reused: call === null,
      exact_repair: Boolean(repairReason),
      json_syntax_repair: parsedContent.syntax_repair,
    };
  } catch (error) {
    return {
      packet_id: packetId,
      packet_index: index,
      status: "failed",
      chapters: [],
      units: [],
      source_ref_keys: chunk.map((unit) => narrationSourceRefKey(unit.source_unit_refs?.[0])),
      provider: call?.provider ?? metadata?.provider ?? provider ?? "codex_cli",
      model: call?.model ?? metadata?.model ?? model ?? "identity_locked_model",
      reasoning_effort: "medium",
      output_path: outputPath,
      prompt_sha256: promptHash,
      prompt_bytes: promptBytes,
      reused: call === null && Boolean(content),
      exact_repair: Boolean(repairReason),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export const NARRATION_PERFORMANCE_SAFE_MAX_BYTES = 48_000;

export function narrationPerformancePacketPlanForTests(
  atomicUnits,
  {
    maximumAtoms = NARRATION_PERFORMANCE_TARGET_ATOMS,
    maxPromptBytes = NARRATION_PERFORMANCE_SAFE_MAX_BYTES,
    contentProfile = null,
  } = {},
) {
  const ceiling = Math.min(
    NARRATION_PERFORMANCE_SAFE_MAX_BYTES,
    Math.max(1_000, Number(maxPromptBytes) || NARRATION_PERFORMANCE_SAFE_MAX_BYTES),
  );
  let chunks = segmentChunks(atomicUnits, maximumAtoms);
  for (;;) {
    const chunkCount = chunks.length;
    let changed = false;
    const next = [];
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      const promptBytes = Buffer.byteLength(promptForChunk(chunk, index, chunkCount, contentProfile), "utf8");
      if (promptBytes <= ceiling) {
        next.push(chunk);
        continue;
      }
      if (chunk.length < 2) {
        const sourceRef = narrationSourceRefKey(chunk[0]?.source_unit_refs?.[0]) ?? "unknown";
        throw new Error(`Narration performance packet for ${sourceRef} is ${promptBytes} bytes; safe ceiling is ${ceiling} bytes.`);
      }
      const midpoint = Math.ceil(chunk.length / 2);
      next.push(chunk.slice(0, midpoint), chunk.slice(midpoint));
      changed = true;
    }
    chunks = next;
    if (!changed) break;
  }
  return chunks.map((chunk, index) => {
    const prompt = promptForChunk(chunk, index, chunks.length, contentProfile);
    return {
      packet_id: `performance_packet_${String(index + 1).padStart(3, "0")}_${sha256(prompt).slice(0, 12)}`,
      packet_index: index,
      prompt,
      prompt_sha256: sha256(prompt),
      prompt_bytes: Buffer.byteLength(prompt, "utf8"),
      source_ref_keys: chunk.map((unit) => narrationSourceRefKey(unit.source_unit_refs?.[0])),
      chunk,
    };
  });
}

function narrationPacketManifestSha256(packets) {
  return sha256(JSON.stringify(packets.map((packet) => ({
    packet_id: packet.packet_id,
    prompt_sha256: packet.prompt_sha256,
    source_ref_keys: packet.source_ref_keys,
  }))));
}

async function readOptionalJsonEvidence(filePath) {
  let bytes;
  try {
    bytes = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  const value = JSON.parse(bytes);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Malformed narration performance evidence: ${filePath}`);
  }
  return value;
}

function editorialContract({ mode, contentProfile, sourceScriptSha256, packets }) {
  return {
    schema: "goldflow_narration_editorial_contract_v1",
    version: "2026-09-06.1",
    mode,
    source_script_sha256: sourceScriptSha256,
    direction_sha256: sha256(JSON.stringify(narrationEditorialDirection(contentProfile))),
    packet_manifest_sha256: narrationPacketManifestSha256(packets),
  };
}

function assertEditorialContractMatches(actual, expected) {
  const keys = Object.keys(expected);
  if (Object.keys(actual ?? {}).length !== keys.length
    || keys.some((key) => actual?.[key] !== expected[key])) {
    throw new Error("Narration editorial contract is malformed or changed; preserve the prior packet contract and stop for reviewed recovery before creative submission.");
  }
}

export async function authorNarrationPerformanceDirection({
  atomicUnits,
  sourceScriptSha256,
  episodeDir,
  repoRoot,
  provider = null,
  model = null,
  reasoningEffort = "medium",
  concurrency = 8,
  contentProfile = null,
  repairPacketIds = [],
  repairReason = null,
  plannerExecutor = runCodexCli,
} = {}) {
  if (!Array.isArray(atomicUnits) || !atomicUnits.length) {
    throw new Error("Narration performance author requires atomic spoken units.");
  }
  const callDir = path.join(episodeDir, "_codex_calls", "narration-performance-author");
  const artifactPath = path.join(episodeDir, "narration_actionable_direction.json");
  const contractPath = path.join(episodeDir, "narration_editorial_contract.json");
  const existing = await readOptionalJsonEvidence(artifactPath);
  const storedContract = await readOptionalJsonEvidence(contractPath);
  if (existing && (!new Set(["goldflow_narration_actionable_direction_v1", "goldflow_narration_actionable_direction_v2", "goldflow_narration_actionable_direction_v3"]).has(existing.schema)
    || !new Set(["approved", "blocked"]).has(existing.status))) {
    throw new Error("Malformed existing narration performance artifact; stop for reviewed recovery.");
  }
  if (existing && existing.source_script_sha256 !== sourceScriptSha256) {
    throw new Error(`${existing.status === "blocked" ? "Blocked n" : "N"}arration performance artifact belongs to a different script hash.`);
  }
  let hasCallHistory = false;
  try {
    // Even an empty existing directory may be an interrupted historical attempt.
    await fs.readdir(callDir);
    hasCallHistory = true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (!storedContract && existing?.authoring?.editorial_contract) {
    throw new Error("Narration editorial contract marker is missing from a contract-bound artifact; stop for reviewed recovery.");
  }
  const legacyMode = "legacy_manhwa_prompt_v1";
  const profileMode = "profile_directed_v1";
  if (storedContract && ![legacyMode, profileMode].includes(storedContract.mode)) {
    throw new Error("Narration editorial contract has an unsupported mode; stop before creative submission.");
  }
  const mode = storedContract?.mode
    ?? ((existing || hasCallHistory || !contentProfile?.id || contentProfile.id === "manhwa_recap_v1")
      ? legacyMode : profileMode);
  // Historical aggregate artifacts and interrupted packet caches predate profile
  // direction. Their original prompt, IDs and repair scope must remain intact.
  const effectiveContentProfile = mode === legacyMode ? null : contentProfile;
  const packets = narrationPerformancePacketPlanForTests(atomicUnits, { contentProfile: effectiveContentProfile });
  const boundEditorialContract = editorialContract({
    mode, contentProfile: effectiveContentProfile, sourceScriptSha256, packets,
  });
  if (storedContract) assertEditorialContractMatches(storedContract, boundEditorialContract);
  if (existing?.authoring?.editorial_contract) {
    assertEditorialContractMatches(existing.authoring.editorial_contract, boundEditorialContract);
  }
  const packetIds = new Set(packets.map((packet) => packet.packet_id));
  const requestedRepairs = [...new Set(
    (Array.isArray(repairPacketIds) ? repairPacketIds : [])
      .map(String)
      .map((value) => value.trim())
      .filter(Boolean),
  )];
  const unknownRepairs = requestedRepairs.filter((packetId) => !packetIds.has(packetId));
  if (unknownRepairs.length) {
    throw new Error(`Unknown narration performance packet IDs: ${unknownRepairs.join(", ")}.`);
  }
  if (requestedRepairs.length && !String(repairReason ?? "").trim()) {
    throw new Error("Exact narration performance repair requires repairReason evidence.");
  }
  if (existing?.status === "blocked" && !requestedRepairs.length) {
    const failedPacketIds = existing?.repair_scope?.failed_packet_ids ?? [];
    throw new Error(
      `Narration performance author is blocked on exact packets: ${failedPacketIds.join(", ") || "unknown"}. `
      + "Pass exact repairPacketIds with reviewed repairReason; unscoped resubmission is forbidden.",
    );
  }
  if (requestedRepairs.length) {
    if (existing?.status !== "blocked") {
      throw new Error("Exact narration performance repair requires an existing blocked artifact.");
    }
    const packetManifestSha256 = narrationPacketManifestSha256(packets);
    if (existing?.repair_scope?.packet_manifest_sha256 !== packetManifestSha256) {
      throw new Error("Blocked narration performance repair scope does not match the current packet manifest.");
    }
    const failedPacketIds = new Set(
      (Array.isArray(existing?.repair_scope?.failed_packet_ids)
        ? existing.repair_scope.failed_packet_ids
        : [])
        .map(String),
    );
    const unauthorizedRepairs = requestedRepairs.filter((packetId) => !failedPacketIds.has(packetId));
    if (unauthorizedRepairs.length) {
      throw new Error(
        `Narration performance repair IDs were not failed in the blocked artifact: ${unauthorizedRepairs.join(", ")}. Passed packets are immutable.`,
      );
    }
  }
  // Persist the contract before the first packet can be submitted. A crash
  // before the aggregate artifact therefore cannot silently change direction.
  if (!storedContract) {
    await fs.mkdir(episodeDir, { recursive: true });
    try {
      await fs.writeFile(contractPath, `${JSON.stringify(boundEditorialContract, null, 2)}\n`, { flag: "wx" });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      assertEditorialContractMatches(await readOptionalJsonEvidence(contractPath), boundEditorialContract);
    }
  }
  await fs.mkdir(callDir, { recursive: true });
  const repairSet = new Set(requestedRepairs);
  const previouslyPassed = new Map((existing?.authoring?.calls ?? [])
    .filter((call) => call.status === "passed")
    .map((call) => [call.packet_id, call]));
  const calls = await runPool(
    packets,
    Math.max(1, Math.min(8, Number(concurrency) || 8)),
    async (packet, index) => {
      const prior = !repairSet.has(packet.packet_id) ? previouslyPassed.get(packet.packet_id) : null;
      if (prior) {
        if (prior.packet_index !== index
          || JSON.stringify(prior.source_ref_keys) !== JSON.stringify(packet.source_ref_keys)
          || path.dirname(prior.output_path) !== callDir) {
          throw new Error(`Previously passed narration packet binding changed: ${packet.packet_id}.`);
        }
        const metadata = await readCodexCallMetadata(prior.output_path);
        if (!isCodexCacheCompatible(metadata, {
          model, reasoningEffort: "medium", promptHash: prior.prompt_sha256,
          provider, stageName: "narration_performance", planningOverrideStage: "voice_plan",
        })) {
          throw new Error(`Previously passed narration packet cache is incompatible: ${packet.packet_id}.`);
        }
        const content = await fs.readFile(prior.output_path, "utf8");
        const parsed = extractNarrationPerformanceJsonForTests(content);
        const result = validateChunkResult(parsed.value, packet.chunk, index, packets.length);
        return { ...prior, chapters: result.chapters, units: result.units, reused: true,
          json_syntax_repair: parsed.syntax_repair };
      }
      return authoredChunk({
      chunk: packet.chunk,
      index,
      chunkCount: packets.length,
      callDir,
      repoRoot,
      provider,
      model,
      reasoningEffort: "medium",
      contentProfile: effectiveContentProfile,
      repairReason: repairSet.has(packet.packet_id) ? repairReason : null,
      allowCreativeSubmission: existing?.status !== "blocked" || repairSet.has(packet.packet_id),
      plannerExecutor,
      });
    },
  );
  const failedCalls = calls.filter((call) => call.status !== "passed");
  const passedCalls = calls.filter((call) => call.status === "passed");
  const providers = [...new Set(passedCalls.map((call) => call.provider))];
  const models = [...new Set(passedCalls.map((call) => call.model))];
  const chapterBySegment = new Map();
  for (const call of passedCalls.sort((left, right) => left.packet_index - right.packet_index)) {
    for (const chapter of call.chapters) {
      if (!chapterBySegment.has(chapter.segment_id)) chapterBySegment.set(chapter.segment_id, chapter);
    }
  }
  const chapterProsody = [...chapterBySegment.values()];
  const artifact = {
    schema: "goldflow_narration_actionable_direction_v3",
    status: failedCalls.length ? "blocked" : "approved",
    generated_at: new Date().toISOString(),
    source_script_sha256: sourceScriptSha256,
    authoring: {
      kind: "llm_authored",
      editorial_contract: boundEditorialContract,
      provider: providers.join("+") || "planning_room",
      model: models.join("+") || "identity_locked_model",
      controls: [
        "punctuation",
        "sentence_complete_unit_boundaries",
        "dialogue_separation",
        "semantic_boundary_class",
        "performance_intent",
      ],
      capability_compilation_required: true,
      packet_policy: {
        one_creative_submission_per_packet: true,
        automatic_creative_retry: false,
        automatic_cross_provider_failover: false,
        content_addressed_reuse: true,
        exact_packet_repair_only: true,
        safe_max_prompt_bytes: NARRATION_PERFORMANCE_SAFE_MAX_BYTES,
        concurrency: Math.max(1, Math.min(8, Number(concurrency) || 8)),
        reasoning_effort: "medium",
      },
      calls: calls.map(({ units: _units, chapters: _chapters, ...call }) => call),
    },
    chapter_prosody_spine: {
      schema: "goldflow_narration_chapter_prosody_spine_v1",
      status: failedCalls.length ? "blocked" : "approved",
      chapters: chapterProsody,
    },
    units: passedCalls
      .sort((left, right) => left.packet_index - right.packet_index)
      .flatMap((call) => call.units),
    repair_scope: {
      packet_manifest_sha256: narrationPacketManifestSha256(packets),
      failed_packet_ids: failedCalls.map((call) => call.packet_id),
      failed_source_ref_keys: failedCalls.flatMap((call) => call.source_ref_keys),
      submitted_repair_packet_ids: requestedRepairs,
      repair_reason: requestedRepairs.length ? String(repairReason).trim() : null,
      unscoped_resubmission_forbidden: true,
    },
  };
  await fs.writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  if (failedCalls.length) {
    throw new Error(
      `Narration performance author failed exact packet scope: ${failedCalls.map((call) => call.packet_id).join(", ")}. `
      + `Passed packets were preserved in ${artifactPath}; no automatic creative retry was submitted.`,
    );
  }
  const validation = validateActionableNarrationDirection({
    artifact,
    atomicUnits,
    sourceScriptSha256,
    hardWordMax: 60,
  });
  if (validation.status !== "passed") {
    throw new Error(`Authored narration performance map failed final validation: ${JSON.stringify(validation.findings)}`);
  }
  return { artifact, artifactPath, callCount: calls.length };
}
