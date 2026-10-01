import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { transcriptQaForTests } from "../modelslab-qwen-episode-audio.mjs";
import { narrationSynthesisIdentitySha256 } from "./narration-provider-adapter.mjs";

export const APPEND_ONLY_TAIL_SCHEMA = "goldflow_narration_append_only_tail_evidence_v1";
export const APPEND_ONLY_TAIL_MODE = "exact_append_only_silence_tail_v1";
export function appendOnlyTailGuardAdmission(status, command, subcommand, flags = {}) {
  if (command !== "tts" || subcommand !== "complete-tail") {
    return { applicable: false, allowed: false };
  }
  const expected = `node bin/goldflow.mjs tts complete-tail --episode-dir ${status?.episode_dir} --evidence ${flags.evidence}`;
  const allowed = status?.current_stage === "qwen_tts_stitch"
    && status.current_stage_state === "blocked"
    && Object.keys(flags).sort().join(",") === "episode-dir,evidence"
    && flags["episode-dir"] === status.episode_dir
    && path.isAbsolute(String(flags.evidence ?? ""))
    && path.resolve(flags.evidence).startsWith(`${path.resolve(status.episode_dir)}${path.sep}`)
    && status.next_command_shape === expected;
  return { applicable: true, allowed,
    reason: allowed ? null : "Tail completion requires the exact current hash-bound status command." };
}
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const inside = (root, name) => path.isAbsolute(String(name ?? ""))
  && path.resolve(name).startsWith(`${path.resolve(root)}${path.sep}`);
const same = (a, b) => isDeepStrictEqual(a, b);
const sorted = (values) => [...values].sort();
const exactIds = (a, b) => Array.isArray(a) && Array.isArray(b)
  && new Set(a).size === a.length && same(sorted(a), sorted(b));
const cleanQa = (source, heard) => {
  const qa = transcriptQaForTests(source, heard, { blockAnySubstitution: false });
  return qa.deletions === 0 && qa.insertions === 0 && qa.substitutions === 0
    && qa.first_token_ok === true && qa.last_token_ok === true;
};
const lastWord = (value) => String(value ?? "").match(/[\p{L}\p{N}]+(?=[^\p{L}\p{N}]*$)/u)?.[0]?.toLowerCase() ?? null;

// The raw Qwen unit format is deliberately narrow. This route never decodes,
// resamples, trims, fades or changes one original PCM sample.
export function pcm16MonoWavFactsForTests(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 46
    || bytes.toString("ascii", 0, 4) !== "RIFF"
    || bytes.toString("ascii", 8, 12) !== "WAVE"
    || bytes.toString("ascii", 12, 16) !== "fmt "
    || bytes.readUInt32LE(16) !== 16
    || bytes.readUInt16LE(20) !== 1
    || bytes.readUInt16LE(22) !== 1
    || bytes.readUInt32LE(24) !== 24000
    || bytes.readUInt16LE(32) !== 2
    || bytes.readUInt16LE(34) !== 16
    || bytes.toString("ascii", 36, 40) !== "data"
    || bytes.readUInt32LE(4) !== bytes.length - 8
    || bytes.readUInt32LE(40) !== bytes.length - 44
    || (bytes.length - 44) % 2 !== 0) {
    throw new Error("Tail completion requires canonical 24-kHz mono PCM16 WAV with a 44-byte header.");
  }
  const sampleCount = (bytes.length - 44) / 2;
  const sample = (index) => bytes.readInt16LE(44 + index * 2);
  const dbfs = (value) => value > 0 ? 20 * Math.log10(value / 32768) : null;
  let power = 0;
  for (let i = Math.max(0, sampleCount - 1200); i < sampleCount; i += 1) {
    power += sample(i) ** 2;
  }
  const tailSize = Math.min(1200, sampleCount);
  return {
    sample_count: sampleCount,
    duration_sec: sampleCount / 24000,
    last_sample_dbfs: dbfs(Math.abs(sample(sampleCount - 1))),
    tail_50ms_rms_dbfs: dbfs(Math.sqrt(power / tailSize)),
  };
}

export function appendOnlySilentTailForTests(source, padSamples) {
  pcm16MonoWavFactsForTests(source);
  if (!Number.isInteger(padSamples) || padSamples < 2400 || padSamples > 7200) {
    throw new Error("Tail completion pad must be 100–300 ms at 24 kHz.");
  }
  const output = Buffer.alloc(source.length + padSamples * 2);
  source.copy(output);
  output.writeUInt32LE(output.length - 8, 4);
  output.writeUInt32LE(output.length - 44, 40);
  return output;
}

export function validateAppendOnlyTailScopeForTests({ evidence, episodeDir,
  report, delivery, manifest, plan, hashes, audioFacts = {},
} = {}) {
  const blocked = [...new Set((report?.blockers ?? []).map((row) => row.unit_id))];
  const evidenceIds = (evidence?.units ?? []).map((row) => row.unit_id);
  const held = blocked.filter((id) => !evidenceIds.includes(id));
  const planById = new Map((plan?.units ?? []).map((row) => [row.unit_id, row]));
  const qaById = new Map((delivery?.units ?? []).map((row) => [row.unit_id, row]));
  const outputById = new Map((manifest?.units ?? []).map((row) => [row.unit_id, row]));
  if (evidence?.schema !== APPEND_ONLY_TAIL_SCHEMA
    || evidence.status !== "reviewed_automated_evidence"
    || evidence.human_listening_performed !== false
    || evidence.audio_synthesis_authorized !== false
    || evidence.method !== "append_zero_pcm16_samples_only"
    || evidence.episode_dir !== episodeDir
    || evidence.source_script_sha256 !== report?.source_script_hash
    || evidence.source_script_sha256 !== plan?.source_script_hash
    || evidence.narration_generation_plan_sha256 !== plan?.plan_sha256
    || evidence.narration_generation_plan_file_sha256 !== hashes?.plan
    || evidence.run_identity_file_sha256 !== hashes?.identity
    || evidence.prior_report_file_sha256 !== hashes?.report
    || evidence.prior_delivery_file_sha256 !== hashes?.delivery
    || evidence.prior_manifest_file_sha256 !== hashes?.manifest
    || report?.provider_output_manifest_sha256 !== hashes?.manifest
    || report?.narration_generation_plan_sha256 !== undefined
      && report.narration_generation_plan_sha256 !== plan?.plan_sha256
    || report?.status !== "blocked" || delivery?.status !== "blocked"
    || report?.full_stream_qa_status !== "not_run_due_to_unit_blockers"
    || manifest?.status !== "passed" || manifest?.provider !== "qwen_local"
    || !Array.isArray(evidence?.units) || evidence.units.length < 1
    || evidence.units.length > 4 || !exactIds(evidence.blocked_unit_ids, blocked)
    || !exactIds(evidence.preserved_blocked_unit_ids, held)
    || !exactIds((delivery.blockers ?? []).map((row) => `${row.unit_id}|${row.code}`),
      (report.blockers ?? []).map((row) => `${row.unit_id}|${row.code}`))) {
    throw new Error("Tail completion evidence is stale, broad, or not bound to blocked Qwen audio.");
  }
  for (const row of evidence.units) {
    const planUnit = planById.get(row.unit_id);
    const selected = outputById.get(row.unit_id);
    const qa = qaById.get(row.unit_id);
    const metric = qa?.acoustic_qa?.metrics;
    const edge = qa?.decision?.blockers?.[0];
    const medium = row.medium_asr;
    const words = medium?.recognized_words;
    const last = words?.at(-1);
    const facts = audioFacts[row.unit_id];
    if (!planUnit || !selected || !qa || !facts
      || row.spoken_text_sha256 !== planUnit.spoken_text_sha256
      || row.source_audio_sha256 !== selected.audio_sha256
      || row.source_audio_sha256 !== qa.audio_sha256
      || row.source_synthesis_identity_sha256 !== selected.synthesis_identity_sha256
      || row.source_audio_path !== selected.audio_path
    || selected.status !== "accepted" || selected.token_limit_reached !== false
    || !inside(episodeDir, selected.audio_path)
      || qa.decision.status !== "blocked" || qa.decision.blockers.length !== 1
      || edge?.code !== "narration_unsettled_raw_audio_edge"
      || edge.source_code !== "tts_audio_tail_not_settled"
      || (report.blockers ?? []).filter((item) => item.unit_id === row.unit_id).length !== 1
      || qa.edge_alignment?.status !== "passed"
      || !cleanQa(planUnit.spoken_text, qa.primary_recognized_text)
      || medium?.contract?.engine !== "faster_whisper"
      || medium.contract.model !== "medium"
      || medium.contract.device !== "cpu"
      || medium.contract.compute_type !== "int8_float32"
      || medium.contract.beam_size !== 5
      || medium.contract.vad_filter !== false
      || medium.contract.word_timestamps !== true
      || !cleanQa(planUnit.spoken_text, medium.recognized_text)
      || !Array.isArray(words) || !words.length
      || lastWord(last?.word) !== lastWord(planUnit.spoken_text)
      || !Number.isFinite(Number(last?.probability))
      || Number(last.probability) < 0.95
      || Number(last?.end_sec) > facts.duration_sec + 0.02
      || Number(last?.end_sec) < facts.duration_sec - 0.25
      || !Number.isInteger(row.pad_sample_count)
      || row.pad_sample_count < 2400 || row.pad_sample_count > 7200
      || facts.sample_count !== metric?.sample_count
      || Math.abs(facts.last_sample_dbfs - metric?.last_sample_dbfs) > 0.25
      || Math.abs(facts.tail_50ms_rms_dbfs - metric?.tail_50ms_rms_dbfs) > 0.25
      || facts.last_sample_dbfs > -40
      || facts.tail_50ms_rms_dbfs > -40
      || Number(metric?.clipping_sample_count) !== 0
      || metric?.trailing_silence_sec !== 0
      || qa.acoustic_qa.findings.some((finding) =>
        finding.code === "tts_audio_endpoint_discontinuity")
      || String(row.review_note ?? "").trim().length < 40) {
      throw new Error(`Tail completion has an unsafe or unproven exact unit: ${row.unit_id}.`);
    }
  }
  return { selected_unit_ids: evidenceIds, preserved_blocked_unit_ids: held,
    preserved_unit_count: manifest.units.length - evidenceIds.length };
}

export async function verifyAppendOnlyTailSelection({ episodeDir, report,
  manifest, plan, expectedManifestPath = null } = {}) {
  const history = (manifest?.repair_history ?? []).filter((row) =>
    row?.mode === APPEND_ONLY_TAIL_MODE);
  if (history.length !== 1) return null;
  const record = history[0];
  const requestPath = record.request_path;
  const resultPath = record.result_path;
  const evidencePath = record.evidence_path;
  if (![requestPath, resultPath, evidencePath].every((name) => inside(episodeDir, name))) {
    throw new Error("Append-only tail provenance escaped the episode.");
  }
  const [requestBytes, resultBytes, evidenceBytes] = await Promise.all([
    fs.readFile(requestPath), fs.readFile(resultPath), fs.readFile(evidencePath),
  ]);
  if (sha(requestBytes) !== record.request_file_sha256
    || sha(resultBytes) !== record.result_file_sha256
    || sha(evidenceBytes) !== record.evidence_file_sha256
    || expectedManifestPath && path.resolve(expectedManifestPath)
      !== path.resolve(record.output_manifest_path)) {
    throw new Error("Append-only tail request/result/evidence is hash-stale.");
  }
  const request = JSON.parse(requestBytes), result = JSON.parse(resultBytes);
  const evidence = JSON.parse(evidenceBytes);
  if (request.schema !== "goldflow_narration_append_only_tail_request_v1"
    || result.schema !== "goldflow_narration_append_only_tail_result_v1"
    || result.status !== "passed"
    || request.episode_dir !== episodeDir
    || !inside(episodeDir, request.evidence_path)
    || !inside(episodeDir, result.request_path)
    || result.request_path !== requestPath
    || resultPath !== record.result_path
    || request.evidence_file_sha256 !== record.evidence_file_sha256
    || request.evidence_path !== evidencePath
    || result.request_file_sha256 !== record.request_file_sha256
    || !exactIds(request.unit_ids, result.units.map((row) => row.unit_id))
    || request.plan_sha256 !== plan?.plan_sha256
    || request.source_script_sha256 !== report?.source_script_hash
    || request.prior_manifest_file_sha256 !== record.prior_manifest_file_sha256
    || evidence.prior_report_file_sha256 !== request.prior_report_file_sha256
    || evidence.prior_delivery_file_sha256 !== request.prior_delivery_file_sha256
    || evidence.prior_manifest_file_sha256 !== request.prior_manifest_file_sha256
    || !exactIds(request.unit_ids, evidence.units?.map((row) => row.unit_id))
    || !exactIds(request.preserved_blocked_unit_ids,
      result.preserved_blocked_unit_ids)) {
    throw new Error("Append-only tail result does not bind its source, plan or request.");
  }
  const priorDir = path.dirname(requestPath);
  const [priorBytes, priorReportBytes, priorDeliveryBytes] = await Promise.all([
    fs.readFile(path.join(priorDir, "prior_manifest.json")),
    fs.readFile(path.join(priorDir, "prior_report.json")),
    fs.readFile(path.join(priorDir, "prior_delivery.json")),
  ]);
  if (sha(priorBytes) !== record.prior_manifest_file_sha256
    || sha(priorReportBytes) !== request.prior_report_file_sha256
    || sha(priorDeliveryBytes) !== request.prior_delivery_file_sha256) {
    throw new Error("Append-only tail prior artifact snapshots are stale.");
  }
  const prior = JSON.parse(priorBytes);
  const byId = new Map(prior.units.map((row) => [row.unit_id, row]));
  const repaired = new Map(result.units.map((row) => [row.unit_id, row]));
  if (manifest.units.length !== prior.units.length || byId.size !== prior.units.length) {
    throw new Error("Append-only tail manifest changed unit count or identities.");
  }
  const previousBlocked = [...new Set((JSON.parse(priorReportBytes).blockers ?? [])
    .map((row) => row.unit_id))];
  if (!exactIds(evidence.blocked_unit_ids, previousBlocked)
    || !exactIds(evidence.preserved_blocked_unit_ids,
      previousBlocked.filter((id) => !request.unit_ids.includes(id)))
    || result.preserved_unit_count !== prior.units.length - request.unit_ids.length
    || repaired.size !== request.unit_ids.length) {
    throw new Error("Append-only tail selected and preserved unit sets differ.");
  }
  for (const row of manifest.units) {
    const old = byId.get(row.unit_id);
    if (!old) throw new Error(`Append-only tail omitted ${row.unit_id}.`);
    const selected = repaired.get(row.unit_id);
    if (!selected) {
      if (!same(row, old)) throw new Error(`Append-only tail changed unrequested ${row.unit_id}.`);
      continue;
    }
    if (![old.audio_path, row.audio_path, selected.output_audio_path,
      selected.source_audio_path].every((name) => inside(episodeDir, name))) {
      throw new Error(`Append-only tail selected audio escaped the episode: ${row.unit_id}.`);
    }
    const [originalBytes, amendedBytes] = await Promise.all([
      fs.readFile(old.audio_path), fs.readFile(row.audio_path),
    ]);
    const sourceFacts = pcm16MonoWavFactsForTests(originalBytes);
    const outputFacts = pcm16MonoWavFactsForTests(amendedBytes);
    const expected = appendOnlySilentTailForTests(originalBytes, selected.pad_sample_count);
    const identity = row.synthesis_identity;
    const recovery = row.recovery_provenance;
    const expectedIdentity = {
      schema: "goldflow_narration_append_only_tail_identity_v1",
      provider: old.provider, model_id: old.model_id,
      model_revision: old.model_revision, voice_id: old.voice_id,
      voice_sha256: old.voice_sha256,
      voice_continuity_contract: old.voice_continuity_contract,
      unit_id: old.unit_id, spoken_text_sha256: old.spoken_text_sha256,
      source_synthesis_identity_sha256: old.synthesis_identity_sha256,
      source_audio_sha256: old.audio_sha256,
      output_audio_sha256: row.audio_sha256,
      pad_sample_count: selected.pad_sample_count,
      request_file_sha256: record.request_file_sha256,
    };
    const expectedRow = structuredClone(old);
    Object.assign(expectedRow, {
      audio_path: row.audio_path, audio_sha256: row.audio_sha256,
      duration_sec: outputFacts.duration_sec,
      synthesis_mode: APPEND_ONLY_TAIL_MODE,
      recovery_provenance: recovery,
      synthesis_identity: expectedIdentity,
      synthesis_identity_sha256: narrationSynthesisIdentitySha256(expectedIdentity),
      runner_report_path: resultPath,
      runner_report_sha256: record.result_file_sha256,
      provider_receipt: null, provider_unit_qa: null,
      provider_unit_qa_sha256: null,
    });
    if (sha(originalBytes) !== old.audio_sha256
      || sha(amendedBytes) !== row.audio_sha256
      || !expected.equals(amendedBytes)
      || outputFacts.sample_count !== sourceFacts.sample_count + selected.pad_sample_count
      || selected.source_audio_sha256 !== old.audio_sha256
      || selected.source_audio_path !== old.audio_path
      || selected.source_sample_count !== sourceFacts.sample_count
      || selected.output_sample_count !== outputFacts.sample_count
      || selected.output_audio_sha256 !== row.audio_sha256
      || selected.output_audio_path !== row.audio_path
      || row.synthesis_mode !== APPEND_ONLY_TAIL_MODE
      || !same(identity, expectedIdentity)
      || !same(row, expectedRow)
      || identity?.schema !== "goldflow_narration_append_only_tail_identity_v1"
      || identity.source_synthesis_identity_sha256 !== old.synthesis_identity_sha256
      || identity.source_audio_sha256 !== old.audio_sha256
      || identity.output_audio_sha256 !== row.audio_sha256
      || identity.pad_sample_count !== selected.pad_sample_count
      || row.synthesis_identity_sha256 !== narrationSynthesisIdentitySha256(identity)
      || recovery?.schema !== "goldflow_narration_append_only_tail_provenance_v1"
      || recovery.request_path !== requestPath
      || recovery.request_file_sha256 !== record.request_file_sha256
      || recovery.result_path !== resultPath
      || recovery.result_file_sha256 !== record.result_file_sha256
      || recovery.source_audio_sha256 !== old.audio_sha256
      || recovery.source_synthesis_identity_sha256 !== old.synthesis_identity_sha256
      || recovery.pad_sample_count !== selected.pad_sample_count
      || recovery.human_listening_performed !== false
      || recovery.audio_synthesis_performed !== false
      || row.provider_unit_qa !== null || row.provider_unit_qa_sha256 !== null
      || row.attempt !== old.attempt || row.generated_token_count !== old.generated_token_count
      || row.spoken_text_sha256 !== old.spoken_text_sha256) {
      throw new Error(`Append-only tail selected unit is not a pure extension: ${row.unit_id}.`);
    }
  }
  return { repaired_unit_ids: [...repaired.keys()], prior_manifest_file_sha256:
    record.prior_manifest_file_sha256 };
}
