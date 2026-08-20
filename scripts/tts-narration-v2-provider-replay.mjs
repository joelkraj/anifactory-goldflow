#!/usr/bin/env node

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  compileNarrationProviderRequest,
} from "./lib/narration-provider-adapter.mjs";
import { buildNarrationQualityContract } from "./lib/narration-quality-contract.mjs";
import {
  buildNarrationTextIr,
  validateNarrationTextIr,
} from "./lib/narration-text-ir.mjs";
import {
  DEFAULT_NARRATOR_VOICE_ID,
  defaultNarrationVoiceProviderOptions,
  qwenPrimaryLockForVoice,
} from "./lib/narration-tts-policy.mjs";

const DEFAULT_UNIT_IDS = Object.freeze([
  "repeated_word_integrity",
  "attribution_and_action_integrity",
  "goblin_join_left",
  "goblin_join_combined",
  "afterlife_join_right",
]);

function parseFlags(parts) {
  const flags = {};
  for (let index = 0; index < parts.length; index += 1) {
    if (!parts[index].startsWith("--")) continue;
    const key = parts[index].slice(2);
    flags[key] = parts[index + 1] && !parts[index + 1].startsWith("--")
      ? parts[++index]
      : "true";
  }
  return flags;
}

function sha256(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex");
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "plan_sha256")
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]),
  );
}

function unchangedSpokenTextLineage(unitId, text) {
  const lineage = {
    schema: "goldflow_spoken_text_lineage_v1",
    policy: "Exact unchanged source-to-provider proof lineage.",
    components: [{
      source_unit_id: unitId,
      source_text: text,
      source_text_sha256: sha256(text),
      compiled_spoken_text: text,
      compiled_spoken_text_sha256: sha256(text),
      transformation_receipts: [],
    }],
    pre_direction_spoken_text: text,
    pre_direction_spoken_text_sha256: sha256(text),
    final_transformations: [],
    final_spoken_text: text,
    final_spoken_text_sha256: sha256(text),
  };
  return {
    ...lineage,
    lineage_sha256: sha256(JSON.stringify(lineage)),
  };
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  if (!flags["proof-root"] || !flags["output-dir"]) {
    throw new Error("--proof-root and --output-dir are required.");
  }
  const proofRoot = path.resolve(flags["proof-root"]);
  const outputDir = path.resolve(flags["output-dir"]);
  const phaseDir = path.join(proofRoot, flags.phase ?? "final");
  const variantId = flags.variant ?? "baseline_dry_batch4";
  const selectedIds = String(flags["unit-ids"] ?? DEFAULT_UNIT_IDS.join(","))
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const [generationManifest, generationReport] = await Promise.all([
    readJson(path.join(phaseDir, "generation_manifest.json")),
    readJson(path.join(phaseDir, "generation_report.json")),
  ]);
  const manifestVariant = generationManifest.variants.find(
    (row) => row.id === variantId,
  );
  const reportVariant = generationReport.variants.find(
    (row) => row.id === variantId,
  );
  if (!manifestVariant || !reportVariant) {
    throw new Error(`Missing proof variant ${variantId}.`);
  }
  const manifestUnitById = new Map(
    manifestVariant.units.map((row) => [String(row.id), row]),
  );
  const resultById = new Map(
    reportVariant.results.map((row) => [String(row.unit_id), row]),
  );
  const missing = selectedIds.filter(
    (unitId) => !manifestUnitById.has(unitId) || !resultById.has(unitId),
  );
  if (missing.length) throw new Error(`Missing replay unit(s): ${missing.join(", ")}.`);

  const primaryLock = qwenPrimaryLockForVoice(
    DEFAULT_NARRATOR_VOICE_ID,
    "joel_ref_03_dry_deadpan",
  );
  const qualityContract = buildNarrationQualityContract({
    provider: primaryLock.provider,
    modelId: primaryLock.model_id,
    modelRevision: primaryLock.model_revision,
  });
  const voiceProviderOptions = defaultNarrationVoiceProviderOptions({
    provider: "qwen_local",
    voiceId: DEFAULT_NARRATOR_VOICE_ID,
    referenceVariantId: "joel_ref_03_dry_deadpan",
    narrationQualityContract: qualityContract,
  });
  const sourceText = selectedIds.map(
    (unitId) => manifestUnitById.get(unitId).text,
  ).join("\n\n");
  const sourceScriptHash = sha256(sourceText);
  const units = selectedIds.map((unitId, index) => {
    const source = manifestUnitById.get(unitId);
    const performanceIntent = {
      energy: source.category === "delivery" ? "high" : "controlled",
      tension: source.category === "join_pair" ? "social_pressure" : "neutral",
      intimacy: "standard",
      pace: "steady_forward",
      pause_strategy: source.category === "join_pair"
        ? "short_precise"
        : "punctuation_led",
      emphasis: [],
      style_tags: ["dry", "precise", "premium_recap"],
      source: "provider_replay_proof_v1",
    };
    const stableUnitId = `proof_u${String(index + 1).padStart(3, "0")}_${unitId}`;
    const base = {
      unit_id: stableUnitId,
      order_index: index,
      segment_id: `proof_seg_${String(index + 1).padStart(3, "0")}`,
      source_segment_ids: [`proof_seg_${String(index + 1).padStart(3, "0")}`],
      source_unit_refs: [{
        source_unit_id: stableUnitId,
        segment_id: `proof_seg_${String(index + 1).padStart(3, "0")}`,
        unit_index: 1,
        source_text: source.text,
        source_text_sha256: sha256(source.text),
        caption_text: source.text,
        caption_text_sha256: sha256(source.text),
      }],
      source_text: source.text,
      caption_text: source.text,
      spoken_text: source.text,
      tts_spoken_text: source.text,
      spoken_text_sha256: sha256(source.text),
      spoken_text_transformations: [],
      spoken_text_lineage: unchangedSpokenTextLineage(stableUnitId, source.text),
      word_count: source.text.trim().split(/\s+/u).length,
      boundary_after: index === selectedIds.length - 1
        ? "episode_end"
        : source.category === "join_pair" ? "reveal" : "paragraph",
      performance_intent: performanceIntent,
      provider_controls: {
        primary: {
          provider: primaryLock.provider,
          model_id: primaryLock.model_id,
          model_revision: primaryLock.model_revision,
          voice_id: primaryLock.voice_id,
          voice_sha256: primaryLock.voice_sha256,
          voice_continuity_contract: primaryLock.voice_continuity_contract,
          native_speed: null,
        },
      },
    };
    return {
      ...base,
      provider_request: compileNarrationProviderRequest(base, {
        provider: primaryLock.provider,
        modelId: primaryLock.model_id,
        modelRevision: primaryLock.model_revision,
        voiceId: primaryLock.voice_id,
        voiceSha256: primaryLock.voice_sha256,
        voiceContinuityContract: primaryLock.voice_continuity_contract,
        referenceAudioPath: primaryLock.reference_audio_path,
        referenceText: primaryLock.reference_text,
        seed: Number(manifestVariant.seed) + index,
      }),
    };
  });
  const planBase = {
    schema: "goldflow_narration_generation_plan_v2",
    status: "passed",
    proof_only: true,
    source_script_hash: sourceScriptHash,
    primary_provider: primaryLock.provider,
    narrator_voice_id: primaryLock.voice_id,
    provider_controls: {
      primary: voiceProviderOptions.primary,
    },
    provider_neutral_unit_grouping: {
      preferred_words_min: 20,
      preferred_words_max: 42,
      soft_words_max: 48,
      hard_words_max: 60,
      sentence_complete: true,
      semantic_boundary_classes: true,
      performance_intent_required: true,
    },
    units,
  };
  const plan = {
    ...planBase,
    plan_sha256: sha256(JSON.stringify(canonicalize(planBase))),
  };
  const narrationTextIr = buildNarrationTextIr({
    sourceScriptSha256: sourceScriptHash,
    generationPlanSha256: plan.plan_sha256,
    units,
  });
  const narrationTextIrValidation = validateNarrationTextIr(
    narrationTextIr,
    units,
    {
      sourceScriptSha256: sourceScriptHash,
      generationPlanSha256: plan.plan_sha256,
    },
  );
  if (narrationTextIrValidation.status !== "passed") {
    throw new Error(
      `Provider replay narration text lineage failed: ${JSON.stringify(narrationTextIrValidation.findings)}`,
    );
  }
  const identity = {
    schema: "goldflow_run_identity_v2",
    run_intent: "proof",
    episode: "ep_proof",
    title: "Narration Quality V2 Provider-Neutral Qwen Replay",
    tts_provider: "qwen_local",
    tts_fallback_provider: null,
    narrator_voice_id: primaryLock.voice_id,
    tts_native_speed: null,
    model_versions: {
      tts_model: primaryLock.model_id,
      tts_model_revision: primaryLock.model_revision,
    },
    voice_provider_options: voiceProviderOptions,
    narration_quality_contract: qualityContract,
  };
  const providerResults = {
    schema: "goldflow_provider_replay_input_v1",
    status: "passed",
    provider: primaryLock.provider,
    model_id: primaryLock.model_id,
    model_revision: primaryLock.model_revision,
    voice_id: primaryLock.voice_id,
    voice_sha256: primaryLock.voice_sha256,
    voice_continuity_contract: primaryLock.voice_continuity_contract,
    source_generation_report: path.join(phaseDir, "generation_report.json"),
    creative_submissions_performed: 0,
    results: units.map((unit, index) => {
      const sourceResult = resultById.get(selectedIds[index]);
      return {
        unit_id: unit.unit_id,
        audio_path: sourceResult.output_path,
        audio_sha256: sourceResult.output_sha256,
        token_limit_reached: sourceResult.token_limit_reached === true,
        provider_receipt: {
          mode: "immutable_existing_qwen_output_replay",
          source_variant_id: variantId,
          source_unit_id: selectedIds[index],
          creative_submission_performed: false,
        },
      };
    }),
  };
  await fs.mkdir(outputDir, { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(outputDir, "script_clean.md"), `${sourceText}\n`, "utf8"),
    writeJson(path.join(outputDir, "run_identity.json"), identity),
    writeJson(path.join(outputDir, "narration_generation_plan.json"), plan),
    writeJson(path.join(outputDir, "narration_text_ir.json"), narrationTextIr),
    writeJson(path.join(outputDir, "provider-results.json"), providerResults),
    writeJson(path.join(outputDir, "replay_proof_manifest.json"), {
      schema: "goldflow_narration_provider_replay_proof_v1",
      status: "ready",
      proof_root: proofRoot,
      output_dir: outputDir,
      variant_id: variantId,
      selected_source_unit_ids: selectedIds,
      replay_unit_ids: units.map((unit) => unit.unit_id),
      source_script_hash: sourceScriptHash,
      narration_generation_plan_sha256: plan.plan_sha256,
      quality_contract_sha256: qualityContract.contract_sha256,
      creative_submissions_performed: 0,
    }),
  ]);
  console.log(JSON.stringify({
    status: "ready",
    output_dir: outputDir,
    unit_count: units.length,
    source_unit_ids: selectedIds,
    creative_submissions_performed: 0,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
