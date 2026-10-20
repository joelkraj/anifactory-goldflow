import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  AUTOMATED_RETAKE_AUTHORIZED_BY,
  AutomatedRetakeEvidenceError,
  authoredBoundaryFragments,
  buildAutomatedRetakeEvidence,
  nextAutomatedRetakeEvidencePath,
  writeAutomatedRetakeEvidence,
} from "../lib/narration-automated-retake-evidence.mjs";
import { canonicalQwenBatchSha256 } from "../lib/qwen-liam-batch-contract.mjs";
import {
  isAutomatedRetakeLoopBlockForTests,
  runAutomatedNarrationRetakeLoopForTests,
  validateConfirmedRetryEvidenceForTests,
} from "../narration-tts-episode.mjs";
import {
  bindNarrationProviderUnitAsrReuse,
  buildNarrationProviderUnitAsrContract,
  validateNarrationProviderUnitAsrReuse,
} from "../lib/narration-provider-unit-asr-reuse.mjs";
import { buildNarrationQualityContract } from "../lib/narration-quality-contract.mjs";

const sha = (value) => createHash("sha256").update(String(value)).digest("hex");
const SCRIPT_SHA = sha("script");
const PLAN_SHA = sha("plan-canonical");
const PLAN_FILE_SHA = sha("plan-file");

function blockedReport({ attempt = 1, blockedIds = ["u1", "u3"], allIds = ["u1", "u2", "u3"] } = {}) {
  return {
    schema: "goldflow_narration_tts_report_v1",
    status: "blocked",
    source_script_hash: SCRIPT_SHA,
    narration_generation_plan_sha256: PLAN_SHA,
    narration_generation_plan_file_sha256: PLAN_FILE_SHA,
    provider_output_manifest_path: null,
    full_stream_qa_status: "not_run_due_to_unit_blockers",
    results: allIds.map((id) => ({
      unit_id: id,
      attempt: blockedIds.includes(id) ? attempt : 1,
      audio_sha256: sha(`audio-${id}`),
      synthesis_identity_sha256: sha(`identity-${id}`),
      selected_qa: { status: blockedIds.includes(id) ? "blocked" : "passed", audio_sha256: sha(`audio-${id}`) },
      qa_status: blockedIds.includes(id) ? "blocked" : "passed",
    })),
    blockers: blockedIds.flatMap((id) => [
      { code: "narration_unsettled_raw_audio_edge", severity: "blocker", unit_id: id, tail_50ms_rms_dbfs: -33.7 },
      ...(id === "u3" ? [{ code: "narration_confirmed_final_word_missing", severity: "blocker", unit_id: id }] : []),
    ]),
  };
}

async function episodeFixture(report) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-retake-loop-"));
  const reportPath = path.join(dir, "narration_tts_report_ep_01.json");
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
  return { dir, reportPath, reportSha256: sha(JSON.stringify(report, null, 2)) };
}

test("the writer authors evidence the retake gate accepts without a hand file", async () => {
  const report = blockedReport();
  const { reportPath, reportSha256 } = await episodeFixture(report);
  const evidence = buildAutomatedRetakeEvidence({
    priorReport: report, priorReportSha256: reportSha256, priorReportPath: reportPath,
    sourceScriptSha256: SCRIPT_SHA, planSha256: PLAN_SHA, planFileSha256: PLAN_FILE_SHA,
    qualityContractSha256: sha("contract"), authorizedAt: "2026-10-20T00:00:00.000Z",
  });
  assert.equal(evidence.schema, "goldflow_confirmed_tts_retry_evidence_v2");
  assert.equal(evidence.evidence_basis, "reviewed_automated_delivery_qa");
  assert.equal(evidence.human_listening_performed, false);
  assert.equal(evidence.authorized_by, AUTOMATED_RETAKE_AUTHORIZED_BY);
  assert.equal(evidence.authorized_by, "automated:delivery_qa_v1");
  assert.equal(evidence.maximum_attempts_per_unit, 1);
  assert.ok(evidence.operator_reason.length >= 40);
  assert.equal(evidence.attestation, undefined);
  assert.deepEqual(evidence.confirmed_units.map((row) => row.unit_id), ["u1", "u3"]);
  assert.deepEqual(evidence.confirmed_units[1].reviewed_blocker_codes,
    ["narration_confirmed_final_word_missing", "narration_unsettled_raw_audio_edge"]);
  assert.equal(evidence.confirmed_units[0].selected_qa_sha256, canonicalQwenBatchSha256(report.results[0].selected_qa));
  assert.equal(evidence.recovery_authorization.writer.schema, "goldflow_automated_retake_evidence_writer_v1");
  // The same shape the existing automated recovery_authorization uses.
  assert.deepEqual(
    Object.keys(evidence.recovery_authorization).sort(),
    ["authorization_origin", "authorized_by", "evidence_basis", "human_listening_performed", "user_listening_claimed", "writer"],
  );
  const validated = validateConfirmedRetryEvidenceForTests({
    evidence, requestedUnitIds: ["u1", "u3"], planSha256: PLAN_SHA, priorReport: report,
    priorReportSha256: reportSha256, currentCandidates: report.results,
    sourceScriptSha256: SCRIPT_SHA, planFileSha256: PLAN_FILE_SHA,
  });
  assert.equal(validated.length, 2);
  assert.ok(validated.every((row) => row.evidence_basis === "reviewed_automated_delivery_qa" && row.human_listening_performed === false));
});

test("the writer refuses a stale report, a second take and a passed unit", async () => {
  const report = blockedReport();
  const { reportPath, reportSha256 } = await episodeFixture(report);
  const base = { priorReport: report, priorReportSha256: reportSha256, priorReportPath: reportPath, sourceScriptSha256: SCRIPT_SHA, planSha256: PLAN_SHA, planFileSha256: PLAN_FILE_SHA };
  assert.throws(() => buildAutomatedRetakeEvidence({ ...base, planSha256: sha("other") }), (error) => error.code === "automated_retake_report_not_current");
  assert.throws(() => buildAutomatedRetakeEvidence({ ...base, priorReport: { ...report, status: "passed" } }), (error) => error.code === "automated_retake_requires_blocked_report");
  const secondTake = blockedReport({ attempt: 2 });
  assert.throws(
    () => buildAutomatedRetakeEvidence({ ...base, priorReport: secondTake }),
    (error) => error instanceof AutomatedRetakeEvidenceError && error.code === "automated_retake_cap_reached",
  );
  assert.throws(() => buildAutomatedRetakeEvidence({ ...base, unitIds: ["u1"] }), (error) => error.code === "automated_retake_scope_mismatch");
});

test("evidence files are versioned and never overwritten", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-retake-evidence-"));
  const first = await nextAutomatedRetakeEvidencePath(dir, "ep_01");
  assert.equal(path.basename(first.path), "narration_confirmed_retry_evidence_ep_01.json");
  await fs.writeFile(first.path, "{}");
  const second = await nextAutomatedRetakeEvidencePath(dir, "ep_01");
  assert.equal(path.basename(second.path), "narration_confirmed_retry_evidence_ep_01_r2.json");
  const written = await writeAutomatedRetakeEvidence(dir, "ep_01", { a: 1 });
  assert.equal(written.revision, 2);
  assert.equal(await fs.readFile(first.path, "utf8"), "{}", "the earlier file is untouched");
});

test("boundary fragments are exact sentence splits that rejoin to the spoken text", () => {
  const text = "At nine that night the discharge papers came. The bill was stapled to the back. Four hundred dollars. Patient responsible.";
  const tail = authoredBoundaryFragments(text, ["narration_confirmed_final_word_missing"]);
  assert.deepEqual(tail.fragments, [
    "At nine that night the discharge papers came. The bill was stapled to the back. Four hundred dollars.",
    "Patient responsible.",
  ]);
  assert.equal(tail.policy, "isolate_final_sentence");
  const opening = authoredBoundaryFragments(text, ["narration_confirmed_opening_token_mismatch"]);
  assert.deepEqual(opening.fragments[0], "At nine that night the discharge papers came.");
  const middle = authoredBoundaryFragments(text, ["narration_unsettled_raw_audio_edge"]);
  assert.equal(middle.fragments.join(" "), text);
  assert.equal(middle.fragments.length, 2);
  assert.equal(authoredBoundaryFragments("One sentence only, no boundary", ["x"]), null);
  assert.equal(authoredBoundaryFragments("\"Code blue, four twelve!\" Lily shouted. He ran.", ["narration_confirmed_final_word_missing"]).fragments[1], "He ran.");
});

test("the loop block detector matches only the two finalize block messages", () => {
  assert.ok(isAutomatedRetakeLoopBlockForTests(new Error("Provider-neutral delivery QA blocked 36 unit(s).")));
  assert.ok(isAutomatedRetakeLoopBlockForTests(new Error("Canonical full-stream delivery QA blocked: narration_confirmed_word_omission")));
  assert.equal(isAutomatedRetakeLoopBlockForTests(new Error("Locked Qwen identity or prior report binding is stale.")), false);
});

test("phase 1: a delivery block on the initial pass writes evidence and re-enters once with the retake flags", async () => {
  const report = blockedReport();
  const { dir, reportPath, reportSha256 } = await episodeFixture(report);
  const contract = buildNarrationQualityContract({ deliveryQaPolicy: { acceptance_mode: "automated_asr_v1" } });
  const reentries = [];
  await runAutomatedNarrationRetakeLoopForTests({
    error: new Error("Provider-neutral delivery QA blocked 2 unit(s)."),
    flags: { "episode-dir": dir }, retakeDepth: 0, episodeDir: dir, episode: "ep_01", reportPath,
    planPath: path.join(dir, "plan.json"), identityPath: path.join(dir, "run_identity.json"), scriptPath: path.join(dir, "script.md"),
    scriptHash: SCRIPT_SHA, planSha256: PLAN_SHA, planFileSha256: PLAN_FILE_SHA, identityFileSha256: sha("id"),
    identity: {}, plan: { units: [] }, scriptBuffer: Buffer.from("script"), narrationQualityContract: contract,
    invocationId: "test-invocation", requestedRecoveryScope: null,
    reenter: async (flags, context) => { reentries.push({ flags, context }); },
  });
  assert.equal(reentries.length, 1);
  const [{ flags, context }] = reentries;
  assert.equal(flags["confirmed-retry-unit-ids"], "u1,u3");
  assert.equal(path.basename(flags["confirmed-retry-evidence"]), "narration_confirmed_retry_evidence_ep_01.json");
  assert.equal(context.retakeDepth, 1);
  assert.equal(context.preloaded.planFileSha256, PLAN_FILE_SHA);
  const evidence = JSON.parse(await fs.readFile(flags["confirmed-retry-evidence"], "utf8"));
  assert.equal(evidence.pre_retry_narration_report_sha256, reportSha256);
  assert.equal(evidence.authorized_by, "automated:delivery_qa_v1");
  const receipts = await fs.readdir(path.join(dir, "reports", "narration_automated_retake_loop"));
  assert.equal(receipts.length, 1);
  assert.match(receipts[0], /-retake\.json$/u);
  const receipt = JSON.parse(await fs.readFile(path.join(dir, "reports", "narration_automated_retake_loop", receipts[0]), "utf8"));
  assert.equal(receipt.blocked_report_sha256, reportSha256);
  assert.equal(receipt.human_listening_performed, false);
  assert.equal(receipt.maximum_attempts_per_unit, 1);
});

test("hard stop: a unit that already consumed its retake is refused with a structured blocker, never re-entered", async () => {
  const report = blockedReport({ attempt: 2 });
  const { dir, reportPath } = await episodeFixture(report);
  const contract = buildNarrationQualityContract({ deliveryQaPolicy: { acceptance_mode: "automated_asr_v1" } });
  let reentered = 0;
  await assert.rejects(
    runAutomatedNarrationRetakeLoopForTests({
      error: new Error("Provider-neutral delivery QA blocked 2 unit(s)."),
      flags: {}, retakeDepth: 0, episodeDir: dir, episode: "ep_01", reportPath,
      planPath: "", identityPath: "", scriptPath: "", scriptHash: SCRIPT_SHA, planSha256: PLAN_SHA, planFileSha256: PLAN_FILE_SHA,
      identityFileSha256: sha("id"), identity: {}, plan: { units: [] }, scriptBuffer: Buffer.alloc(0), narrationQualityContract: contract,
      invocationId: "test-cap", requestedRecoveryScope: null,
      reenter: async () => { reentered += 1; },
    }),
    (error) => error.code === "automated_retake_cap_reached" && error.structured_blocker.code === "automated_retake_cap_reached",
  );
  assert.equal(reentered, 0);
  const receipts = await fs.readdir(path.join(dir, "reports", "narration_automated_retake_loop"));
  assert.match(receipts[0], /-retake-refused\.json$/u);
});

test("phase 2: after the retake pass blocks again, one authored boundary repair runs; a still-blocked repair stops with no third attempt", async () => {
  const report = blockedReport({ attempt: 2, blockedIds: ["u3"] });
  report.provider_output_manifest_path = null;
  const { dir, reportPath } = await episodeFixture(report);
  const manifestPath = path.join(dir, "narration_provider_output_manifest_ep_01.json");
  await fs.writeFile(manifestPath, "{}");
  await fs.writeFile(path.join(dir, "narration_unit_delivery_qa_ep_01.json"), JSON.stringify({
    status: "blocked",
    units: [{ unit_id: "u3", audio_sha256: sha("audio-u3"), decision: { status: "blocked", blockers: [{ code: "narration_confirmed_final_word_missing" }] } }],
  }));
  const plan = { units: [{ unit_id: "u3", spoken_text: "The bill came that night. Patient responsible.", spoken_text_sha256: sha("The bill came that night. Patient responsible.") }] };
  const contract = buildNarrationQualityContract({ deliveryQaPolicy: { acceptance_mode: "automated_asr_v1" } });
  const repairCalls = [];
  let reentered = 0;
  const run = (repairImpl) => runAutomatedNarrationRetakeLoopForTests({
    error: new Error("Provider-neutral delivery QA blocked 1 unit(s)."),
    flags: {}, retakeDepth: 1, episodeDir: dir, episode: "ep_01", reportPath,
    planPath: "", identityPath: "", scriptPath: "", scriptHash: SCRIPT_SHA, planSha256: PLAN_SHA, planFileSha256: PLAN_FILE_SHA,
    identityFileSha256: sha("id"), identity: {}, plan, scriptBuffer: Buffer.alloc(0), narrationQualityContract: contract,
    invocationId: "test-boundary", requestedRecoveryScope: { requested_unit_ids: ["u3"] },
    reenter: async () => { reentered += 1; },
    repairBoundaryModule: async () => ({ main: async (parts, options) => { repairCalls.push({ parts, options }); return repairImpl(); } }),
  });
  await run(async () => undefined);
  assert.equal(repairCalls.length, 1);
  assert.equal(reentered, 0);
  const specPath = repairCalls[0].parts[repairCalls[0].parts.indexOf("--spec") + 1];
  assert.equal(path.basename(specPath), "narration_exact_boundary_repair_spec_ep_01_auto.json");
  const spec = JSON.parse(await fs.readFile(specPath, "utf8"));
  assert.equal(spec.reviewer, "automated:delivery_qa_v1");
  assert.equal(spec.human_listening_performed, false);
  assert.deepEqual(spec.units[0].fragments, ["The bill came that night.", "Patient responsible."]);
  assert.equal(spec.units[0].fragments.join(" "), plan.units[0].spoken_text, "no text rewrite");
  assert.equal(spec.prior_report_file_sha256, sha(await fs.readFile(reportPath, "utf8")));
  assert.equal(repairCalls[0].options.inProcessAuthorization.schema, "goldflow_narration_automated_retake_loop_receipt_v1");

  await assert.rejects(
    run(async () => { throw new Error("Provider-neutral delivery QA blocked 1 unit(s)."); }),
    (error) => error.code === "boundary_repair_still_blocked" && /no third attempt, no text rewrite, no skip/u.test(error.message),
  );
  assert.equal(repairCalls.length, 2, "exactly one repair per pass, never a loop");
  assert.equal(reentered, 0, "no further synthesis re-entry after the one retake");
  const receipts = (await fs.readdir(path.join(dir, "reports", "narration_automated_retake_loop"))).sort();
  assert.ok(receipts.some((name) => name.endsWith("-stop.json")));
  const stop = JSON.parse(await fs.readFile(path.join(dir, "reports", "narration_automated_retake_loop", receipts.find((name) => name.endsWith("-stop.json"))), "utf8"));
  assert.equal(stop.no_third_attempt, true);
  assert.equal(stop.text_rewrite, false);
});

test("finalize reuses narrate's unit ASR only on the exact three-way binding for table-bound identities", () => {
  const asrContract = buildNarrationProviderUnitAsrContract({ model: "small.en" });
  const words = [{ word: "hello", start_sec: 0, end_sec: 0.4 }];
  const providerUnitQa = {
    policy_version: "tts_output_qa_v1", audio_sha256: sha("wav"),
    transcript: { engine: "faster_whisper", model: "small.en", device: "cpu", compute_type: "int8_float32", asr_contract: asrContract, asr_contract_sha256: asrContract.contract_sha256, asr_engine_version: "1.2.1", recognized_text: "hello", recognized_words: words },
  };
  const bound = bindNarrationProviderUnitAsrReuse({ providerUnitQa, unitId: "u1", audioSha256: sha("wav"), narrationQualityContractSha256: sha("c"), spokenFormEquivalencesSha256: sha("table") });
  assert.equal(bound.primary_asr_reuse_binding.spoken_form_equivalences_sha256, sha("table"));
  assert.equal(bound.primary_asr_reuse_binding.asr_engine_version, "1.2.1");
  const qaSha = (qa) => createHash("sha256").update(JSON.stringify(qa)).digest("hex");
  const check = (overrides) => validateNarrationProviderUnitAsrReuse({
    unitId: "u1", audioSha256: sha("wav"), audioHashVerified: true, providerUnitQa: bound, providerUnitQaSha256: qaSha(bound),
    narrationQualityContractSha256: sha("c"), expectedAsrContract: asrContract, providerUnitQaContentSha256: qaSha,
    expectedSpokenFormEquivalencesSha256: sha("table"), expectedAsrEngineVersion: "1.2.1", ...overrides,
  });
  assert.equal(check({}).status, "reused");
  assert.ok(check({ expectedSpokenFormEquivalencesSha256: sha("edited-table") }).findings.some((f) => f.code === "provider_unit_asr_spoken_form_equivalences_mismatch"));
  assert.ok(check({ expectedAsrEngineVersion: "1.3.0" }).findings.some((f) => f.code === "provider_unit_asr_engine_version_mismatch"));
  assert.ok(check({ audioSha256: sha("other-wav") }).findings.some((f) => f.code === "provider_unit_asr_audio_binding_invalid"));
  // Legacy identities (no bound table) keep the existing two-way binding.
  const legacyQa = structuredClone(providerUnitQa);
  delete legacyQa.transcript.asr_engine_version;
  const legacyBound = bindNarrationProviderUnitAsrReuse({ providerUnitQa: legacyQa, unitId: "u1", audioSha256: sha("wav"), narrationQualityContractSha256: sha("c") });
  assert.equal(legacyBound.primary_asr_reuse_binding.spoken_form_equivalences_sha256, null);
  assert.equal(validateNarrationProviderUnitAsrReuse({
    unitId: "u1", audioSha256: sha("wav"), audioHashVerified: true, providerUnitQa: legacyBound, providerUnitQaSha256: qaSha(legacyBound),
    narrationQualityContractSha256: sha("c"), expectedAsrContract: asrContract, providerUnitQaContentSha256: qaSha,
  }).status, "reused");
});
