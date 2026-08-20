#!/usr/bin/env node

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  codexCallMetadataPath,
  runCodexCli,
} from "./lib/codex-cli-runner.mjs";
import { parseJsonObjectFromPlannerOutput } from "./lib/json-output-repair.mjs";
import {
  sourceModelContract,
  validateSourceModelReceipt,
} from "./lib/source-model-policy.mjs";
import { sourceViewerPanel } from "./lib/source-viewer-profile-bank.mjs";
import {
  MIXED_VIEWER_SHADOW_MANIFEST_SCHEMA,
  MIXED_VIEWER_SHADOW_REPORT_SCHEMA,
  aggregateMixedViewerShadow,
  validateMixedViewerShadowManifest,
  validateMixedViewerShadowReport,
} from "./lib/source-mixed-viewer-shadow-contract.mjs";
import {
  buildMixedViewerCalibrationPolicy,
  validateMixedViewerCalibrationPolicy,
} from "./lib/source-mixed-viewer-calibration-contract.mjs";

const DATA_ROOT = process.env.ANIFACTORY_DATA_ROOT || "/Users/joel/AniFactoryData";

function parseFlags(parts) {
  const flags = {};
  for (let index = 0; index < parts.length; index += 1) {
    if (!parts[index].startsWith("--")) continue;
    const key = parts[index].slice(2);
    const next = parts[index + 1];
    flags[key] = next && !next.startsWith("--") ? next : "true";
    if (flags[key] !== "true") index += 1;
  }
  return flags;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJsonAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporary, filePath);
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  const failures = [];
  let cursor = 0;
  async function runner() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      try {
        results[index] = await worker(items[index], index);
      } catch (error) {
        failures.push({
          index,
          item: items[index],
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, runner));
  return { results, failures };
}

function providerForIndex(index) {
  return index % 2 === 0 ? "chatgpt_web" : "gemini_web";
}

function blindedPacket({ persona, candidate, reference, candidateTitle, referenceTitle }) {
  const candidateLabel = persona.order === "candidate_first" ? "A" : "B";
  const referenceLabel = candidateLabel === "A" ? "B" : "A";
  const scriptA = candidateLabel === "A"
    ? { title: candidateTitle, text: candidate }
    : { title: referenceTitle, text: reference };
  const scriptB = candidateLabel === "B"
    ? { title: candidateTitle, text: candidate }
    : { title: referenceTitle, text: reference };
  return `You are one simulated cold YouTube manhwa-recap viewer. Stay strictly inside this viewing psychology:\n${persona.brief}\n\nThis is a blinded prediction exercise, not a writing workshop and not a politeness exercise. Compare the complete title-plus-script experiences below as spoken longform videos at roughly 190 words per minute. Predict behavior, not literary prestige. A title is part of the package; the script must satisfy what that title makes you expect. Do not reward length.\n\nFor the CANDIDATE only, predict the earliest second at which you would seriously consider leaving, first-30-second retention, first-60-second retention, average percentage viewed, average view duration in seconds, and full-story satisfaction from 1 to 5. Use one short contiguous verbatim CANDIDATE excerpt for the leave point. Estimate times from spoken word position, not paragraph count.\n\nChoose package_preference as candidate, reference, or tie. Support it with one short contiguous verbatim excerpt from the preferred script; for a tie use the candidate. Choose recommendation as accept only when the candidate is genuinely competitive enough to publish, reject when it materially loses the viewing experience, or uncertain when the evidence is balanced.\n\nCatastrophic vetoes are rare. Use only these types: deception when the package promise is materially false, incoherence when causal understanding collapses, missing_payoff when the clicked promise never receives a satisfying result, or severe_confusion when a cold listener cannot track the story. Every veto needs a short exact candidate excerpt and a concrete viewer reason. An ordinary weak span is not catastrophic.\n\nEvery anchor must be a contiguous verbatim substring from its matching script. Do not paraphrase, splice, add ellipses, or modernize punctuation. Before returning, search every anchor against the supplied text. Return JSON only using exactly this shape:\n{\n  "schema": "${MIXED_VIEWER_SHADOW_REPORT_SCHEMA}",\n  "persona_id": "${persona.id}",\n  "provider_family": "PROVIDER_FILLED_BY_ORCHESTRATOR",\n  "script_label_map": { "candidate": "${candidateLabel}", "reference": "${referenceLabel}" },\n  "package_preference": "candidate|reference|tie",\n  "package_reason_exact_anchor": "...",\n  "predictions": {\n    "predicted_leave_point_sec": 0,\n    "leave_point_exact_anchor": "...",\n    "predicted_30_sec_retention_percent": 0,\n    "predicted_60_sec_retention_percent": 0,\n    "predicted_average_percentage_viewed": 0,\n    "predicted_average_view_duration_sec": 0,\n    "full_story_satisfaction": 1\n  },\n  "recommendation": "accept|reject|uncertain",\n  "confidence": "low|medium|high",\n  "catastrophic_vetoes": [{ "type": "deception|incoherence|missing_payoff|severe_confusion", "exact_anchor": "...", "reason": "..." }],\n  "one_sentence_verdict": "..."\n}\n\nSCRIPT A TITLE: ${scriptA.title}\nSCRIPT A TEXT:\n${scriptA.text}\n\nSCRIPT B TITLE: ${scriptB.title}\nSCRIPT B TEXT:\n${scriptB.text}`;
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const developmentSlug = String(flags["development-slug"] ?? "").trim();
  const developmentDir = flags["development-dir"]
    ? path.resolve(flags["development-dir"])
    : developmentSlug
      ? path.join(DATA_ROOT, "channels", String(flags.channel ?? "53rebirth"), "source_development", developmentSlug)
      : null;
  const roomContract = developmentDir
    ? await readJson(path.join(developmentDir, "source_room_contract.json"))
    : null;
  const productionGate = String(flags["production-gate"] ?? "false") === "true"
    || roomContract?.mixed_viewer_panel_required === true;
  const inferredCandidate = developmentDir
    ? path.join(developmentDir, "script_narration_polished.txt")
    : null;
  const inferredReference = developmentDir
    ? path.join(developmentDir, "reference_outlier_transcript.txt")
    : null;
  const inferredOutput = developmentDir
    ? path.join(developmentDir, "mixed_viewer_panel")
    : null;
  const inferredSeed = roomContract?.mixed_viewer_panel_seed ?? null;
  if (!(flags.candidate ?? inferredCandidate)
    || !(flags.reference ?? inferredReference)
    || !(flags["output-dir"] ?? inferredOutput)
    || !(flags["panel-seed"] ?? inferredSeed)) {
    throw new Error("Usage: goldflow source mixed-viewer-panel --development-slug <slug> [--channel <channel>] or --candidate <txt> --reference <txt> --output-dir <dir> --panel-seed <seed> [--candidate-title <title>] [--reference-title <title>] [--concurrency 5]");
  }
  const candidatePath = path.resolve(flags.candidate ?? inferredCandidate);
  const referencePath = path.resolve(flags.reference ?? inferredReference);
  const outputDir = path.resolve(flags["output-dir"] ?? inferredOutput);
  const candidateTitle = String(flags["candidate-title"] ?? "Candidate title").trim();
  const referenceTitle = String(flags["reference-title"] ?? "Reference title").trim();
  const panelSeed = String(flags["panel-seed"] ?? inferredSeed).trim();
  const concurrency = Math.max(1, Math.min(10, Number.parseInt(flags.concurrency ?? "5", 10) || 5));
  const [candidate, reference] = await Promise.all([
    fs.readFile(candidatePath, "utf8"),
    fs.readFile(referencePath, "utf8"),
  ]);
  const candidateSha256 = sha256(candidate);
  const referenceSha256 = sha256(reference);
  const learningLedgerPath = flags["learning-ledger"]
    ? path.resolve(flags["learning-ledger"])
    : roomContract?.source_learning_ledger_path
      ? path.resolve(roomContract.source_learning_ledger_path)
      : null;
  const learningLedgerBytes = learningLedgerPath
    ? await fs.readFile(learningLedgerPath).catch(() => null)
    : null;
  const learningLedger = learningLedgerBytes
    ? JSON.parse(learningLedgerBytes.toString("utf8"))
    : null;
  const calibrationApproval = flags["calibration-approval"]
    ? await readJson(path.resolve(flags["calibration-approval"]))
    : null;
  const calibrationPolicyPath = path.join(outputDir, "calibration_policy.json");
  const existingCalibrationPolicy = await readJson(calibrationPolicyPath);
  const calibrationPolicy = buildMixedViewerCalibrationPolicy({
    learningLedger,
    learningLedgerSha256: learningLedgerBytes ? sha256(learningLedgerBytes) : null,
    approval: calibrationApproval,
    createdAt: existingCalibrationPolicy?.created_at ?? new Date().toISOString(),
  });
  const calibrationValidation = validateMixedViewerCalibrationPolicy(calibrationPolicy, {
    learningLedgerSha256: learningLedgerBytes ? sha256(learningLedgerBytes) : null,
  });
  if (!calibrationValidation.done) {
    throw new Error(`Mixed viewer calibration policy blocked: ${calibrationValidation.blockers.join(", ")}`);
  }
  await writeJsonAtomic(calibrationPolicyPath, calibrationPolicy);
  const calibrationPolicyFileSha256 = sha256(await fs.readFile(calibrationPolicyPath));
  const mode = productionGate
    ? calibrationPolicy.production_mode
    : String(flags.mode ?? "shadow_non_blocking");
  const personas = sourceViewerPanel(panelSeed);
  const assignments = personas.map((persona, index) => ({
    ...persona,
    provider_family: providerForIndex(index),
  }));
  const inputBinding = {
    schema: "goldflow_mixed_viewer_shadow_input_v1",
    mode,
    production_gate: productionGate,
    calibration_policy_path: calibrationPolicyPath,
    calibration_policy_sha256: calibrationPolicyFileSha256,
    candidate_path: candidatePath,
    candidate_sha256: candidateSha256,
    candidate_title: candidateTitle,
    reference_path: referencePath,
    reference_sha256: referenceSha256,
    reference_title: referenceTitle,
    panel_seed: panelSeed,
    assignments: assignments.map((row) => ({
      persona_id: row.id,
      panel_role: row.panel_role,
      order: row.order,
      provider_family: row.provider_family,
    })),
  };
  const inputPath = path.join(outputDir, "input_manifest.json");
  const existingInput = await readJson(inputPath);
  if (existingInput && JSON.stringify(existingInput) !== JSON.stringify(inputBinding)) {
    throw new Error("Existing mixed-viewer directory is bound to different scripts, titles, providers, or panel seed.");
  }
  if (!existingInput) await writeJsonAtomic(inputPath, inputBinding);

  const execution = await mapWithConcurrency(assignments, concurrency, async (persona) => {
    const reportPath = path.join(outputDir, "reports", `${persona.id}.json`);
    const rawPath = path.join(outputDir, "raw", `${persona.id}.txt`);
    const prompt = blindedPacket({ persona, candidate, reference, candidateTitle, referenceTitle });
    const stageName = `source_mixed_viewer_shadow_${persona.provider_family}`;
    const contract = sourceModelContract({ provider: persona.provider_family }, { stageName });
    const existingReport = await readJson(reportPath);
    if (existingReport) {
      const reportValidation = validateMixedViewerShadowReport(existingReport, { candidateText: candidate, referenceText: reference });
      if (!reportValidation.done) throw new Error(`Existing ${persona.id} report invalid: ${reportValidation.blockers.join(", ")}`);
      const metadata = await readJson(codexCallMetadataPath(rawPath));
      const receiptValidation = validateSourceModelReceipt(metadata, { expectedContract: contract });
      if (!receiptValidation.done || metadata?.output_sha256 !== sha256(await fs.readFile(rawPath))) {
        throw new Error(`Existing ${persona.id} report lacks a valid provider receipt.`);
      }
      return {
        persona_id: persona.id,
        provider_family: persona.provider_family,
        model: contract.model,
        reasoning_effort: contract.reasoning_effort,
        report_path: reportPath,
        report_sha256: sha256(await fs.readFile(reportPath)),
        raw_output_path: rawPath,
        raw_output_sha256: metadata.output_sha256,
        receipt_path: codexCallMetadataPath(rawPath),
        receipt_sha256: sha256(await fs.readFile(codexCallMetadataPath(rawPath))),
        reused: true,
      };
    }
    const call = await runCodexCli({
      prompt,
      stageName,
      repoRoot: path.resolve("."),
      outputPath: rawPath,
      provider: contract.provider,
      model: contract.model,
      reasoningEffort: contract.reasoning_effort,
      verbosity: "low",
      timeoutMs: 1_800_000,
    });
    const receiptValidation = validateSourceModelReceipt(call, { expectedContract: contract });
    if (!receiptValidation.done) throw new Error(`${persona.id} provider receipt invalid: ${receiptValidation.blockers.join(", ")}`);
    const parsed = parseJsonObjectFromPlannerOutput(call.content).value;
    const report = {
      ...parsed,
      schema: MIXED_VIEWER_SHADOW_REPORT_SCHEMA,
      persona_id: persona.id,
      provider_family: persona.provider_family,
      script_label_map: {
        candidate: persona.order === "candidate_first" ? "A" : "B",
        reference: persona.order === "candidate_first" ? "B" : "A",
      },
    };
    const validation = validateMixedViewerShadowReport(report, { candidateText: candidate, referenceText: reference });
    if (!validation.done) throw new Error(`${persona.id} report invalid: ${validation.blockers.join(", ")}`);
    await writeJsonAtomic(reportPath, report);
    return {
      persona_id: persona.id,
      provider_family: persona.provider_family,
      model: call.model,
      reasoning_effort: call.reasoning_effort,
      report_path: reportPath,
      report_sha256: sha256(await fs.readFile(reportPath)),
      raw_output_path: rawPath,
      raw_output_sha256: sha256(await fs.readFile(rawPath)),
      receipt_path: codexCallMetadataPath(rawPath),
      receipt_sha256: sha256(await fs.readFile(codexCallMetadataPath(rawPath))),
      reused: false,
    };
  });

  if (execution.failures.length) {
    const failurePath = path.join(outputDir, "mixed_viewer_shadow_failures.json");
    await writeJsonAtomic(failurePath, {
      schema: "goldflow_mixed_viewer_shadow_failures_v1",
      status: "incomplete",
      input_manifest_sha256: sha256(await fs.readFile(inputPath)),
      failures: execution.failures.map((row) => ({ persona_id: row.item?.id ?? null, message: row.message })),
      completed_persona_ids: execution.results.filter(Boolean).map((row) => row.persona_id),
    });
    throw new Error(`Mixed viewer shadow incomplete: ${execution.failures.map((row) => row.item?.id).join(", ")}`);
  }
  const receipts = execution.results;
  const reports = await Promise.all(receipts.map((row) => readJson(row.report_path)));
  const aggregate = aggregateMixedViewerShadow(reports, { candidateSha256, referenceSha256, mode });
  if (aggregate.blockers.length) throw new Error(`Mixed viewer aggregate blocked: ${aggregate.blockers.join(", ")}`);
  const aggregatePath = path.join(outputDir, "aggregate.json");
  await writeJsonAtomic(aggregatePath, aggregate);
  const manifest = {
    schema: MIXED_VIEWER_SHADOW_MANIFEST_SCHEMA,
    status: "completed",
    mode,
    selection_authority: calibrationPolicy.selection_authority,
    calibration_policy_path: calibrationPolicyPath,
    calibration_policy_sha256: calibrationPolicyFileSha256,
    input_manifest_path: inputPath,
    input_manifest_sha256: sha256(await fs.readFile(inputPath)),
    candidate_sha256: candidateSha256,
    reference_sha256: referenceSha256,
    panel_seed: panelSeed,
    concurrency,
    receipts,
    aggregate_path: aggregatePath,
    aggregate_sha256: sha256(await fs.readFile(aggregatePath)),
    completed_at: new Date().toISOString(),
  };
  const manifestValidation = validateMixedViewerShadowManifest(manifest, {
    requireProductionGate: productionGate,
    calibrationPolicySha256: calibrationPolicyFileSha256,
  });
  if (!manifestValidation.done) throw new Error(`Mixed viewer manifest blocked: ${manifestValidation.blockers.join(", ")}`);
  const manifestPath = path.join(outputDir, "manifest.json");
  await writeJsonAtomic(manifestPath, manifest);
  console.log(JSON.stringify({
    status: "completed",
    mode,
    manifest_path: manifestPath,
    aggregate_path: aggregatePath,
    shadow_decision: aggregate.shadow_decision,
    calibrated_decision: mode === "calibrated_decision_support"
      ? aggregate.calibrated_decision
      : null,
    next_action: productionGate ? "viewer-tournament" : null,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
