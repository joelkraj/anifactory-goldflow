import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { canonicalQwenBatchSha256, qwenBatchBindingByUnit, QWEN_LIAM_INCOMPLETE_UNIT_RESUME_MODE } from "./qwen-liam-batch-contract.mjs";
import { candidateDisposition } from "./tts-selection-policy.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fileHash = async (filePath) => sha256(await fs.readFile(filePath));
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".."
    && !path.isAbsolute(relative);
}

function required(condition, message) {
  if (!condition) throw new Error(`Interrupted Qwen adoption refused: ${message}`);
}

// This verifies an operator inventory against the original runner evidence. It
// never treats a generated WAV as accepted; the caller must run ordinary unit
// and voice QA and record its decision before a resume can be authorized.
export async function verifyInterruptedQwenInventory({
  inventoryPath,
  episodeDir,
  outputDir,
  identityPath,
  planPath,
  scriptPath,
  gatePath,
  units,
  policy,
  batchPlan,
  planSha256,
} = {}) {
  const root = path.resolve(episodeDir);
  const inventoryFile = path.resolve(inventoryPath);
  required(inside(root, inventoryFile), "inventory must be episode-local");
  const inventoryBytes = await fs.readFile(inventoryFile);
  const inventory = JSON.parse(inventoryBytes.toString("utf8"));
  required(inventory.schema === "anifactory_operator_interrupted_qwen_triage_inventory_v1"
    && inventory.production_stage_passed === false
    && inventory.qa_acceptance_recorded === false,
  "inventory must be an unaccepted interrupted-Qwen triage record");
  required(path.resolve(inventory.episode_dir) === root, "episode identity differs");
  for (const [label, recordedPath, actualPath, recordedHash] of [
    ["identity", inventory.run_identity_path, identityPath, inventory.run_identity_file_sha256],
    ["plan", inventory.narration_generation_plan_path, planPath, inventory.narration_generation_plan_file_sha256],
    ["script", inventory.source_script_path, scriptPath, inventory.source_script_sha256],
    ["original gate", inventory.pre_synthesis_gate_path, gatePath, inventory.pre_synthesis_gate_file_sha256],
  ]) {
    required(path.resolve(recordedPath) === path.resolve(actualPath), `${label} path differs`);
    required(await fileHash(actualPath) === recordedHash, `${label} hash differs`);
  }
  const gate = JSON.parse(await fs.readFile(gatePath, "utf8"));
  required(gate.gate_sha256 === inventory.pre_synthesis_gate_sha256
    && gate.status === "passed"
    && gate.model_load_performed === true
    && gate.synthesis_invoked === true,
  "original gate does not prove real synthesis under the locked identity");
  required(inventory.narration_generation_plan_canonical_sha256 === planSha256
    && inventory.batch_plan_sha256 === batchPlan.batch_plan_sha256,
  "plan or cohort binding differs");
  for (const field of ["provider", "model_id", "model_revision", "voice_id", "voice_sha256", "voice_continuity_contract"]) {
    required(inventory[field] === policy.primary[field], `${field} differs from the locked voice`);
  }
  const jobPath = path.resolve(inventory.original_job_path);
  const eventsPath = path.resolve(inventory.cohort_events_path);
  required(inside(path.join(outputDir, "jobs"), jobPath)
    && inside(path.join(outputDir, "runs"), eventsPath),
  "original job or cohort ledger is outside the TTS output tree");
  required(await fileHash(jobPath) === inventory.original_job_file_sha256
    && await fileHash(eventsPath) === inventory.cohort_events_file_sha256,
  "original job or cohort ledger hash differs");
  const job = JSON.parse(await fs.readFile(jobPath, "utf8"));
  const expectedIds = units.map((unit) => String(unit.unit_id));
  const jobIds = (job.jobs ?? []).map((unit) => String(unit.unit_id));
  required(same(jobIds, expectedIds)
    && job.schema === "goldflow_narration_tts_jobs_v2"
    && job.provider === policy.primary.provider
    && job.model_id === policy.primary.model_id
    && job.model_revision === policy.primary.model_revision
    && job.voice_id === policy.primary.voice_id
    && job.voice_sha256 === policy.primary.voice_sha256
    && job.voice_continuity_contract === policy.primary.voice_continuity_contract
    && job.batch_plan_sha256 === batchPlan.batch_plan_sha256
    && same(job.batch_plan, batchPlan)
    && same(job.synthesis_contract, policy.synthesis_contract)
    && job.narration_generation_plan_sha256 === planSha256
    && job.narration_generation_plan_file_sha256 === inventory.narration_generation_plan_file_sha256
    && job.run_identity_file_sha256 === inventory.run_identity_file_sha256
    && job.source_script_sha256 === inventory.source_script_sha256
    && job.pre_synthesis_gate?.gate_sha256 === inventory.pre_synthesis_gate_sha256
    && job.pre_synthesis_gate?.file_sha256 === inventory.pre_synthesis_gate_file_sha256,
  "original jobs do not match the locked plan, voice, and gate");
  const bindings = qwenBatchBindingByUnit(batchPlan);
  for (let index = 0; index < units.length; index += 1) {
    required(job.jobs[index].spoken_text_sha256 === units[index].spoken_text_sha256
      && same(job.jobs[index].synthesis_cohort, bindings.get(expectedIds[index])),
    `original job ${expectedIds[index]} differs from the current unit`);
  }
  const rawEvents = (await fs.readFile(eventsPath, "utf8")).split("\n").filter(Boolean).map(JSON.parse);
  const eventIds = new Set();
  const generated = new Map();
  for (const event of rawEvents) {
    required(event.schema === "goldflow_local_tts_cohort_event_v1"
      && event.event === "cohort_complete"
      && event.jobs_sha256 === inventory.original_job_file_sha256
      && event.batch_plan_sha256 === batchPlan.batch_plan_sha256
      && !eventIds.has(event.cohort_id),
    "cohort ledger contains a stale, duplicate, or incomplete event");
    eventIds.add(event.cohort_id);
    const cohort = (batchPlan.cohorts ?? []).find((row) => row.cohort_id === event.cohort_id);
    required(cohort?.cohort_sha256 === event.cohort_sha256
      && Number(cohort.cohort_index) === Number(event.cohort_index)
      && same((event.results ?? []).map((row) => row.unit_id).sort(),
        cohort.members.map((row) => row.unit_id).sort()),
    `cohort ${event.cohort_id} does not match its complete batch`);
    for (const result of event.results) {
      required(!generated.has(String(result.unit_id)), `duplicate output ${result.unit_id}`);
      generated.set(String(result.unit_id), result);
    }
  }
  const listed = inventory.generated_unaccepted_units ?? [];
  required(rawEvents.length === inventory.complete_cohort_count
    && listed.length === inventory.generated_unaccepted_unit_count
    && listed.length === generated.size
    && inventory.job_unit_count === units.length,
  "inventory counts do not match completed cohorts");
  const listedIds = new Set();
  const verified = [];
  for (const row of listed) {
    const id = String(row.unit_id);
    const result = generated.get(id);
    const binding = bindings.get(id);
    required(!listedIds.has(id) && result && binding && row.status === "generated_unaccepted_pending_qa",
      `unlisted, duplicate, or already-accepted unit ${id}`);
    listedIds.add(id);
    const sidecarPath = path.resolve(row.sidecar_path);
    const wavPath = path.resolve(row.wav_path);
    required(inside(path.join(outputDir, "units", policy.primary.provider), sidecarPath)
      && inside(path.join(outputDir, "units", policy.primary.provider), wavPath)
      && sidecarPath === wavPath.replace(/\.wav$/iu, ".json")
      && sidecarPath === path.resolve(result.sidecar_path)
      && wavPath === path.resolve(result.output_path),
    `unit ${id} paths differ from the original cohort result`);
    required(await fileHash(sidecarPath) === row.sidecar_file_sha256
      && await fileHash(wavPath) === row.wav_sha256,
    `unit ${id} WAV or sidecar changed`);
    const sidecar = JSON.parse(await fs.readFile(sidecarPath, "utf8"));
    required(sidecar.status === "generated"
      && result.status === "generated"
      && sidecar.unit_id === id
      && result.unit_id === id
      && sidecar.output_sha256 === row.wav_sha256
      && result.output_sha256 === row.wav_sha256
      && sidecar.spoken_text_sha256 === row.spoken_text_sha256
      && result.spoken_text_sha256 === row.spoken_text_sha256
      && sidecar.spoken_text_sha256 === units.find((unit) => unit.unit_id === id)?.spoken_text_sha256
      && sidecar.synthesis_identity_sha256 === row.synthesis_identity_sha256
      && result.synthesis_identity_sha256 === row.synthesis_identity_sha256
      && sidecar.synthesis_identity_sha256 === canonicalQwenBatchSha256(sidecar.synthesis_identity)
      && canonicalQwenBatchSha256(sidecar.synthesis_identity)
        === canonicalQwenBatchSha256(result.synthesis_identity)
      && sidecar.batch_plan_sha256 === batchPlan.batch_plan_sha256
      && sidecar.provider === policy.primary.provider
      && sidecar.model_id === policy.primary.model_id
      && sidecar.voice_id === policy.primary.voice_id
      && result.provider === policy.primary.provider
      && result.model_id === policy.primary.model_id
      && result.voice_id === policy.primary.voice_id
      && sidecar.cohort_id === binding.cohort_id
      && sidecar.cohort_sha256 === binding.cohort_sha256
      && result.cohort_id === binding.cohort_id
      && result.cohort_sha256 === binding.cohort_sha256
      && row.original_order_index === expectedIds.indexOf(id)
      && Number(row.sample_count) === Number(sidecar.sample_count)
      && Number(result.sample_count) === Number(sidecar.sample_count)
      && Number(result.seed) === Number(sidecar.seed)
      && sidecar.token_limit_reached === false
      && Number(sidecar.generated_token_count) < Number(sidecar.effective_token_limit)
      && Number(sidecar.duration_sec) > 0,
    `unit ${id} is not a valid complete first take`);
    verified.push({ unit_id: id, result, sidecar, sidecar_path: sidecarPath,
      sidecar_sha256: row.sidecar_file_sha256, wav_path: wavPath, wav_sha256: row.wav_sha256 });
  }
  required(listedIds.size === generated.size, "cohort output is absent from inventory");
  const remaining = expectedIds.filter((id) => !listedIds.has(id));
  required(same(remaining, inventory.never_submitted_unit_ids)
    && remaining.length === inventory.never_submitted_unit_count,
  "never-submitted IDs are not the exact current-plan remainder");
  const unitFiles = (await fs.readdir(path.join(outputDir, "units", policy.primary.provider)))
    .filter((name) => /\.(?:wav|json)$/iu.test(name))
    .map((name) => path.join(outputDir, "units", policy.primary.provider, name));
  const expectedFiles = new Set(verified.flatMap((row) => [row.sidecar_path, row.wav_path]));
  required(unitFiles.length === expectedFiles.size
    && unitFiles.every((filePath) => expectedFiles.has(filePath)),
  "TTS output tree includes an unreviewed or unlisted WAV/sidecar");
  return { inventory, inventory_path: inventoryFile,
    inventory_sha256: sha256(inventoryBytes), original_job_path: jobPath,
    original_job_sha256: inventory.original_job_file_sha256,
    cohort_events_path: eventsPath,
    cohort_events_sha256: inventory.cohort_events_file_sha256,
    verified_units: verified, never_submitted_unit_ids: remaining };
}

export async function verifyInterruptedQwenAdoptionReceipt({
  receiptPath,
  episodeDir,
  outputDir,
  identityPath,
  planPath,
  scriptPath,
  reportPath,
  unitQaPath,
  units,
  planSha256,
  requireCanonicalPartial = true,
  requireExactOutputSet = true,
} = {}) {
  const root = path.resolve(episodeDir);
  const target = path.resolve(receiptPath);
  required(inside(root, target), "adoption receipt must be episode-local");
  const receipt = JSON.parse(await fs.readFile(target, "utf8"));
  required(receipt.schema === "goldflow_interrupted_qwen_adoption_v1"
    && receipt.status === "passed_partial"
    && path.resolve(receipt.episode_dir) === root,
  "adoption receipt status or episode differs");
  for (const [label, recordedPath, actualPath, recordedHash] of [
    ["identity", receipt.run_identity_path, identityPath, receipt.run_identity_file_sha256],
    ["plan", receipt.narration_generation_plan_path, planPath, receipt.narration_generation_plan_file_sha256],
    ["script", receipt.source_script_path, scriptPath, receipt.source_script_sha256],
  ]) {
    required(path.resolve(recordedPath) === path.resolve(actualPath), `${label} path differs`);
    required(await fileHash(actualPath) === recordedHash, `${label} hash differs`);
  }
  for (const [label, recordedPath, recordedHash, canonicalPath] of [
    ["partial report", receipt.partial_report_path, receipt.partial_report_file_sha256, reportPath],
    ["partial unit QA", receipt.partial_unit_qa_path, receipt.partial_unit_qa_file_sha256, unitQaPath],
  ]) {
    required(inside(root, path.resolve(recordedPath)), `${label} archive must be episode-local`);
    required(await fileHash(recordedPath) === recordedHash, `${label} archive hash differs`);
    if (requireCanonicalPartial) {
      required(path.resolve(receipt[`canonical_${label === "partial report" ? "report" : "unit_qa"}_path`])
        === path.resolve(canonicalPath)
        && await fileHash(canonicalPath) === recordedHash,
      `${label} canonical checkpoint changed before resume`);
    }
  }
  required(receipt.narration_generation_plan_canonical_sha256 === planSha256,
    "adoption receipt plan differs");
  required(await fileHash(receipt.inventory_path) === receipt.inventory_file_sha256
    && await fileHash(receipt.original_job_path) === receipt.original_job_file_sha256
    && await fileHash(receipt.cohort_events_path) === receipt.cohort_events_file_sha256
    && await fileHash(receipt.adoption_qa_path) === receipt.adoption_qa_file_sha256
    && inside(root, path.resolve(receipt.original_pre_synthesis_gate_path))
    && await fileHash(receipt.original_pre_synthesis_gate_path)
      === receipt.original_pre_synthesis_gate_file_sha256,
  "adoption source evidence changed");
  const originalJob = JSON.parse(await fs.readFile(receipt.original_job_path, "utf8"));
  const archivedGate = JSON.parse(await fs.readFile(receipt.original_pre_synthesis_gate_path, "utf8"));
  required(originalJob.pre_synthesis_gate?.file_sha256
      === receipt.original_pre_synthesis_gate_file_sha256
    && originalJob.pre_synthesis_gate?.gate_sha256
      === receipt.original_pre_synthesis_gate_sha256
    && archivedGate.gate_sha256 === receipt.original_pre_synthesis_gate_sha256,
  "original job no longer binds the archived authorization gate");
  const report = JSON.parse(await fs.readFile(receipt.partial_report_path, "utf8"));
  const unitQa = JSON.parse(await fs.readFile(receipt.partial_unit_qa_path, "utf8"));
  required(report.schema === "goldflow_narration_tts_report_v1"
    && report.status === "interrupted_adoption_partial"
    && unitQa.schema === "goldflow_narration_tts_unit_qa_v1"
    && unitQa.status === "interrupted_adoption_partial"
    && report.recovery_scope?.adoption_receipt_path === target
    && unitQa.recovery_scope?.adoption_receipt_path === target,
  "partial report or QA is not the adoption checkpoint");
  const ids = units.map((unit) => String(unit.unit_id));
  const acceptedIds = receipt.accepted_unit_ids ?? [];
  const accepted = new Set(acceptedIds);
  required(accepted.size === acceptedIds.length
    && same(acceptedIds, ids.filter((id) => accepted.has(id)))
    && same(receipt.never_submitted_unit_ids, ids.filter((id) => !accepted.has(id)))
    && same((report.results ?? []).map((row) => row.unit_id), acceptedIds)
    && same((unitQa.selected_units ?? []).map((row) => row.unit_id), acceptedIds)
    && same((unitQa.candidates ?? []).map((row) => row.unit_id), acceptedIds),
  "partial selections do not partition the current plan");
  const artifacts = receipt.accepted_artifacts ?? [];
  required(artifacts.length === acceptedIds.length
    && same(artifacts.map((row) => row.unit_id), acceptedIds),
  "accepted artifact list differs");
  for (const row of artifacts) {
    const result = report.results.find((entry) => entry.unit_id === row.unit_id);
    const selection = unitQa.selected_units.find((entry) => entry.unit_id === row.unit_id);
    required(inside(root, path.resolve(row.audio_path))
      && inside(root, path.resolve(row.synthesis_sidecar_path))
      && result?.audio_path === row.audio_path
      && result?.audio_sha256 === row.audio_sha256
      && selection?.audio_path === row.audio_path
      && selection?.audio_sha256 === row.audio_sha256
      && result?.synthesis_identity_sha256
        === selection?.synthesis_identity_sha256
      && candidateDisposition(selection?.qa, "qwen_local").accepted
      && await fileHash(row.audio_path) === row.audio_sha256
      && await fileHash(row.synthesis_sidecar_path) === row.synthesis_sidecar_sha256,
    `adopted artifact ${row.unit_id} changed`);
  }
  if (requireExactOutputSet) {
    const unitDir = path.join(outputDir, "units", "qwen_local");
    const actualFiles = (await fs.readdir(unitDir))
      .filter((name) => /\.(?:wav|json)$/iu.test(name))
      .map((name) => path.join(unitDir, name));
    const expectedFiles = new Set(artifacts.flatMap((row) => [
      path.resolve(row.audio_path), path.resolve(row.synthesis_sidecar_path),
    ]));
    required(actualFiles.length === expectedFiles.size
      && actualFiles.every((filePath) => expectedFiles.has(filePath)),
    "unit output tree contains a newly submitted but unadopted file");
  }
  return { receipt, report, unitQa, receipt_path: target, receipt_sha256: await fileHash(target) };
}

// The original resident runner was interrupted before it could write a final
// report. Its completed cohort ledger and QA-accepted partial checkpoint are
// the only valid substitute, paired with one exact serial runner for the
// never-submitted complement. Later exact-unit repairs may replace a selected
// waveform, but cannot erase either original synthesis record.
export async function verifyInterruptedQwenFinalRun({
  episodeDir, outputDir, identityPath, planPath, scriptPath,
  reportPath, unitQaPath, units, planSha256, batchPlan, policy, finalReport,
} = {}) {
  const root = path.resolve(episodeDir);
  const episode = path.basename(root);
  const receiptPath = path.join(root, `narration_interrupted_qwen_adoption_${episode}.json`);
  const checked = await verifyInterruptedQwenAdoptionReceipt({
    receiptPath, episodeDir: root, outputDir, identityPath, planPath,
    scriptPath, reportPath, unitQaPath, units, planSha256,
    requireCanonicalPartial: false, requireExactOutputSet: false,
  });
  const { receipt } = checked;
  required(receipt.accepted_unit_ids.length > 0
    && receipt.never_submitted_unit_ids.length > 0
    && receipt.never_submitted_unit_ids.length + receipt.accepted_unit_ids.length === units.length,
  "final synthesis must preserve a nonempty adopted/remaining partition");
  const runs = finalReport?.synthesis_runs ?? [];
  const originalRuns = runs.filter((run) => run?.status === "interrupted_after_completed_cohorts");
  required(originalRuns.length === 1
    && Number(originalRuns[0].attempt) === 1
    && originalRuns[0].synthesis_mode === policy.synthesis_contract.mode
    && originalRuns[0].jobs_path === receipt.original_job_path
    && originalRuns[0].jobs_sha256 === receipt.original_job_file_sha256
    && originalRuns[0].cohort_events_path === receipt.cohort_events_path
    && originalRuns[0].cohort_events_sha256 === receipt.cohort_events_file_sha256
    && originalRuns[0].runner_report_path == null,
  "original interrupted cohort run is missing or altered");
  const resumeRuns = runs.filter((run) => run?.synthesis_mode
    === QWEN_LIAM_INCOMPLETE_UNIT_RESUME_MODE);
  required(resumeRuns.length === 1
    && Number(resumeRuns[0].attempt) === 1
    && resumeRuns[0].batch_plan_sha256 === batchPlan.batch_plan_sha256,
  "exactly one serial never-submitted resume run is required");
  const resume = resumeRuns[0];
  required(inside(path.join(outputDir, "runs"), path.resolve(resume.report_path))
    && await fileHash(resume.report_path) === resume.report_sha256,
  "resume runner report path/hash differs");
  const runner = JSON.parse(await fs.readFile(resume.report_path, "utf8"));
  const remaining = receipt.never_submitted_unit_ids;
  required(runner.status === "passed"
    && runner.synthesis_mode === QWEN_LIAM_INCOMPLETE_UNIT_RESUME_MODE
    && same(runner.synthesis_contract, policy.synthesis_contract)
    && runner.batch_plan_sha256 === batchPlan.batch_plan_sha256
    && runner.provider === policy.primary.provider
    && runner.model_id === policy.primary.model_id
    && runner.model_revision === policy.primary.model_revision
    && runner.voice_id === policy.primary.voice_id
    && runner.voice_sha256 === policy.primary.voice_sha256
    && Number(runner.model_load_count) === 1
    && Number(runner.resident_model_count) === 1
    && Number(runner.model_instance_concurrency) === 1
    && runner.continuous_batching === false
    && runner.token_limit_acceptance_allowed === false
    && Number(runner.accepted_token_limit_result_count) === 0
    && runner.results_restored_to_original_order === true
    && same(runner.original_order_unit_ids, remaining)
    && same((runner.results ?? []).map((row) => row.unit_id), remaining),
  "serial resume runner identity, coverage, or execution policy differs");
  const jobsPath = path.resolve(runner.jobs_path);
  const gateArchivePath = path.join(root, `narration_tts_interrupted_resume_gate_${episode}.json`);
  required(inside(path.join(outputDir, "jobs"), jobsPath)
    && await fileHash(jobsPath) === runner.jobs_sha256
    && await fileHash(gateArchivePath) === runner.pre_synthesis_gate_file_sha256,
  "serial resume job or immutable authorization gate changed");
  const jobs = JSON.parse(await fs.readFile(jobsPath, "utf8"));
  const gate = JSON.parse(await fs.readFile(gateArchivePath, "utf8"));
  required(jobs.schema === "goldflow_narration_tts_jobs_v2"
    && jobs.synthesis_mode === QWEN_LIAM_INCOMPLETE_UNIT_RESUME_MODE
    && same(jobs.synthesis_contract, policy.synthesis_contract)
    && jobs.batch_plan_sha256 === batchPlan.batch_plan_sha256
    && jobs.narration_generation_plan_sha256 === planSha256
    && jobs.run_identity_file_sha256 === receipt.run_identity_file_sha256
    && jobs.source_script_sha256 === receipt.source_script_sha256
    && jobs.pre_synthesis_gate?.file_sha256 === runner.pre_synthesis_gate_file_sha256
    && jobs.pre_synthesis_gate?.gate_sha256 === runner.pre_synthesis_gate_sha256
    && gate.gate_sha256 === runner.pre_synthesis_gate_sha256
    && gate.status === "passed"
    && gate.scope?.mode === "interrupted_full_synthesis_resume_preserving_accepted_units"
    && gate.scope?.evidence_path === receiptPath
    && gate.scope?.evidence_sha256 === checked.receipt_sha256
    && same(gate.scope?.preserved_unit_ids, receipt.accepted_unit_ids)
    && same(gate.scope?.authorized_synthesis_unit_ids, remaining)
    && same((jobs.jobs ?? []).map((row) => row.unit_id), remaining),
  "serial resume jobs or gate lack exact adoption authorization");
  const bindings = qwenBatchBindingByUnit(batchPlan);
  const plannedById = new Map(units.map((unit) => [String(unit.unit_id), unit]));
  const selectedById = new Map((finalReport.results ?? []).map((row) => [String(row.unit_id), row]));
  for (const [index, unitId] of remaining.entries()) {
    const job = jobs.jobs[index];
    const result = runner.results[index];
    const selected = selectedById.get(unitId);
    const binding = bindings.get(unitId);
    const expected = plannedById.get(unitId);
    const provenance = job?.recovery_provenance;
    required(provenance?.schema === "goldflow_qwen_incomplete_unit_resume_provenance_v1"
      && provenance.resume_mode === QWEN_LIAM_INCOMPLETE_UNIT_RESUME_MODE
      && provenance.unit_id === unitId
      && provenance.spoken_text_sha256 === expected?.spoken_text_sha256
      && provenance.batch_plan_sha256 === batchPlan.batch_plan_sha256
      && provenance.origin_cohort_id === binding?.cohort_id
      && provenance.origin_cohort_sha256 === binding?.cohort_sha256
      && provenance.pre_synthesis_gate_sha256 === runner.pre_synthesis_gate_sha256
      && result?.status === "generated"
      && result.spoken_text_sha256 === expected?.spoken_text_sha256
      && result.recovery_provenance
      && same(result.recovery_provenance, provenance)
      && result.synthesis_identity?.recovery_provenance
      && same(result.synthesis_identity.recovery_provenance, provenance)
      && result.token_limit_reached === false
      && Number(result.generated_token_count) < Number(result.effective_token_limit)
      && Number(result.effective_token_limit) > 0
      && inside(path.join(outputDir, "units", "qwen_local"), path.resolve(result.output_path))
      && inside(path.join(outputDir, "units", "qwen_local"), path.resolve(result.sidecar_path))
      && path.resolve(result.sidecar_path) === path.resolve(result.output_path).replace(/\.wav$/iu, ".json")
      && await fileHash(result.output_path) === result.output_sha256,
    `serial resume result ${unitId} differs from its job or generated waveform`);
    const sidecar = JSON.parse(await fs.readFile(result.sidecar_path, "utf8"));
    required(sidecar.unit_id === unitId
      && sidecar.output_sha256 === result.output_sha256
      && sidecar.synthesis_identity_sha256 === result.synthesis_identity_sha256
      && same(sidecar.recovery_provenance, provenance),
    `serial resume sidecar ${unitId} differs`);
    if (selected?.synthesis_mode === QWEN_LIAM_INCOMPLETE_UNIT_RESUME_MODE) {
      required(selected.audio_sha256 === result.output_sha256
        && selected.synthesis_identity_sha256 === result.synthesis_identity_sha256,
      `selected serial unit ${unitId} differs from the original resume`);
    }
  }
  for (const artifact of receipt.accepted_artifacts) {
    const selected = selectedById.get(artifact.unit_id);
    if (selected?.synthesis_mode === policy.synthesis_contract.mode) {
      required(selected.audio_sha256 === artifact.audio_sha256
        && selected.audio_path === artifact.audio_path,
      `adopted first take ${artifact.unit_id} was silently replaced`);
    }
  }
  return { receipt, runner, adopted_unit_ids: receipt.accepted_unit_ids,
    resumed_unit_ids: remaining };
}

// A serial interrupted-resume runner may finish writing every unit and its
// immutable report before the controller reaches QA. Replaying that completed
// report is safe only when the original adoption, the exact complement, the
// authorization gate, every waveform/sidecar, and the whole output set agree.
// This helper is read-only; the caller may materialize the truthful empty
// cohort ledger only after it passes.
export async function verifyCompletedInterruptedQwenRunner({
  runnerReportPath, receiptPath, episodeDir, outputDir,
  identityPath, planPath, scriptPath, reportPath, unitQaPath,
  units, planSha256, batchPlan, policy,
} = {}) {
  const root = path.resolve(episodeDir);
  const completedPath = path.resolve(runnerReportPath);
  required(inside(path.join(outputDir, "runs"), completedPath),
    "completed runner report must be episode-local");
  const adoption = await verifyInterruptedQwenAdoptionReceipt({
    receiptPath, episodeDir, outputDir, identityPath, planPath, scriptPath,
    reportPath, unitQaPath, units, planSha256,
    requireExactOutputSet: false,
  });
  const runnerBytes = await fs.readFile(completedPath);
  const runner = JSON.parse(runnerBytes.toString("utf8"));
  const runnerSha256 = sha256(runnerBytes);
  const expectedEventsPath = completedPath.replace(/\.json$/iu, "-cohorts.jsonl");
  required(runner.schema === "goldflow_local_tts_production_run_v2"
    && runner.status === "passed"
    && runner.synthesis_mode === QWEN_LIAM_INCOMPLETE_UNIT_RESUME_MODE
    && Number(runner.cohort_event_count) === 0
    && same(runner.cohort_executions ?? [], [])
    && path.resolve(runner.cohort_event_path) === expectedEventsPath
    && Number(runner.job_count) === adoption.receipt.never_submitted_unit_ids.length
    && Number(runner.result_count) === adoption.receipt.never_submitted_unit_ids.length
    && Number(runner.failed_result_count) === 0,
  "completed runner is not the exact zero-cohort successful serial complement");
  const eventStat = await fs.stat(expectedEventsPath).catch(() => null);
  required(!eventStat || (eventStat.isFile() && eventStat.size === 0),
    "serial cohort event ledger is not empty");
  await verifyInterruptedQwenFinalRun({
    episodeDir, outputDir, identityPath, planPath, scriptPath,
    reportPath, unitQaPath, units, planSha256, batchPlan, policy,
    finalReport: {
      synthesis_runs: [
        ...(adoption.report.synthesis_runs ?? []),
        {
          attempt: 1,
          synthesis_mode: QWEN_LIAM_INCOMPLETE_UNIT_RESUME_MODE,
          batch_plan_sha256: batchPlan.batch_plan_sha256,
          report_path: completedPath,
          report_sha256: runnerSha256,
        },
      ],
      results: [],
    },
  });
  const expectedFiles = new Set((adoption.receipt.accepted_artifacts ?? [])
    .flatMap((row) => [row.audio_path, row.synthesis_sidecar_path])
    .concat((runner.results ?? []).flatMap((row) => [row.output_path, row.sidecar_path]))
    .map((filePath) => path.resolve(filePath)));
  const unitDir = path.join(outputDir, "units", "qwen_local");
  const actualFiles = (await fs.readdir(unitDir))
    .filter((name) => /\.(?:wav|json)$/iu.test(name))
    .map((name) => path.join(unitDir, name));
  required(expectedFiles.size === 2 * units.length
    && actualFiles.length === expectedFiles.size
    && actualFiles.every((filePath) => expectedFiles.has(path.resolve(filePath))),
  "completed runner output tree contains a missing, duplicate, or unbound file");
  return {
    runner,
    runner_path: completedPath,
    runner_sha256: runnerSha256,
    jobs_path: path.resolve(runner.jobs_path),
    jobs_sha256: runner.jobs_sha256,
    cohort_events_path: expectedEventsPath,
    empty_cohort_events_sha256: sha256(""),
    adoption_receipt_path: adoption.receipt_path,
    adoption_receipt_sha256: adoption.receipt_sha256,
    accepted_unit_ids: adoption.receipt.accepted_unit_ids,
    resumed_unit_ids: adoption.receipt.never_submitted_unit_ids,
  };
}
