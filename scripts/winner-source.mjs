#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  runCodexCli,
} from "./lib/codex-cli-runner.mjs";
import {
  sourceModelContract,
  validateSourceModelReceipt,
} from "./lib/source-model-policy.mjs";
import {
  WINNER_EVIDENCE_SNAPSHOT_SCHEMA,
  WINNER_IDEATION_SCHEMA,
  WINNER_SCRIPT_GENERATION_REPORT_SCHEMA,
  WINNER_SOURCE_ROOM_PROFILE,
  WINNER_STORY_BLUEPRINT_APPROVAL_SCHEMA,
  WINNER_STORY_BLUEPRINT_SCHEMA,
  WINNER_SOURCE_RELEASE_SCHEMA,
  buildWinnerPackageContract,
  deterministicWinnerScriptReview,
  evaluateWinnerIdeation,
  extractJsonObject,
  normalizeWinnerNarration,
  sha256Text,
  validateSourceEvidenceSnapshot,
  validateWinnerFormula,
  validateWinnerPackageContract,
  validateWinnerScriptGate,
  validateWinnerStoryBlueprintApproval,
  validateWinnerSourceRelease,
} from "./lib/winner-source-contract.mjs";
import {
  WINNER_AUDIENCE_FEEDBACK_CONTRACT_VERSION,
  WINNER_BLUEPRINT_AUDIENCE_AUDIT_SCHEMA,
  WINNER_DEVELOPMENT_DIAGNOSTIC_SCHEMA,
  WINNER_DIAGNOSTIC_PASS_IDS,
  WINNER_OPENING_APPROVAL_SCHEMA,
  WINNER_REVISION_REPORT_SCHEMA,
  WINNER_RETENTION_MAP_SCHEMA,
  WINNER_STORY_BLUEPRINT_V2_SCHEMA,
  assembleWinnerScriptWithApprovedOpening,
  reviewWinnerOpening,
  usesWinnerAudienceFeedbackContract,
  validateWinnerBlueprintAudienceAudit,
  validateWinnerDevelopmentDiagnostic,
  validateWinnerBlueprintForPackage,
  validateWinnerOpeningApproval,
  validateWinnerRetentionMap,
  validateWinnerRevisionReport,
} from "./lib/winner-source-room-contract.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataRoot = process.env.ANIFACTORY_DATA_ROOT || "/Users/joel/AniFactoryData";
const action = process.argv[2] ?? "help";
const flags = parseFlags(process.argv.slice(3));
const channel = String(flags.channel ?? "53rebirth").trim();
const developmentSlug = String(flags["development-slug"] ?? flags.slug ?? "").trim();
const defaultFormulaPath = path.join(repoRoot, "docs", "channel_formulas", "53rebirth_winner_formula_v1.json");
const defaultEvidenceSnapshotPath = path.join(repoRoot, "docs", "channel_formulas", "53rebirth_source_evidence_snapshot_v1.json");
const formulaPath = path.resolve(flags.formula ?? defaultFormulaPath);
const defaultStockpilePath = path.join(dataRoot, "channels", channel, "source_development", "premise_stockpile.json");
const defaultResearchPoolPath = path.join(
  dataRoot,
  "channels",
  channel,
  "source_development",
  "research",
  "2026-08-01-winner-concepts-v1",
  "ranked_premise_research_pool.json",
);

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

function isTrue(value) {
  return /^(?:true|1|yes)$/i.test(String(value ?? ""));
}

function required(value, label) {
  if (!String(value ?? "").trim()) throw new Error(`Missing required ${label}.`);
  return String(value).trim();
}

function developmentDirectory() {
  if (flags["development-dir"]) return path.resolve(flags["development-dir"]);
  required(developmentSlug, "--development-slug <stable-slug>");
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(developmentSlug)) {
    throw new Error(`Invalid --development-slug ${developmentSlug}. Use letters, numbers, dots, underscores, and hyphens.`);
  }
  return path.join(dataRoot, "channels", channel, "source_development", developmentSlug);
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function fileSha256(filePath) {
  return sha256Text(await fs.readFile(filePath));
}

function extractTextPrompt(markdown) {
  const match = String(markdown ?? "").match(/```text\s*\n([\s\S]*?)\n```/i);
  if (!match) throw new Error("Prompt template does not contain one ```text fenced prompt.");
  return match[1].trim();
}

async function readFormula() {
  const formulaBytes = await fs.readFile(formulaPath);
  const formula = JSON.parse(formulaBytes.toString("utf8"));
  const validation = validateWinnerFormula(formula);
  if (!validation.done) throw new Error(`Winner formula is invalid: ${validation.blockers.join(", ")}`);
  if (formula.channel !== channel) throw new Error(`Winner formula channel ${formula.channel} does not match --channel ${channel}.`);
  return { formula, formulaSha256: sha256Text(formulaBytes), formulaBytes };
}

async function recentTitles() {
  const ledgerPath = path.resolve(flags["recent-ledger"] ?? path.join(dataRoot, "channels", channel, "youtube_upload_ledger.json"));
  if (!(await exists(ledgerPath))) return { ledgerPath: null, titles: [] };
  const ledger = await readJson(ledgerPath);
  const titles = [...new Set((ledger.entries ?? []).map((row) => String(row?.title ?? "").trim()).filter(Boolean))].slice(-12);
  return { ledgerPath, titles };
}

async function operatorCreativeBrief() {
  const briefPath = flags.brief ? path.resolve(flags.brief) : null;
  const inlineBrief = String(flags["creative-brief"] ?? "").trim();
  if (briefPath && inlineBrief) throw new Error("Use either --brief <path> or --creative-brief <text>, not both.");
  if (briefPath) {
    const text = String(await fs.readFile(briefPath, "utf8")).trim();
    if (!text) throw new Error(`Operator creative brief is empty: ${briefPath}`);
    return { text, sourcePath: briefPath };
  }
  return { text: inlineBrief, sourcePath: null };
}

async function premiseResearchContext() {
  const stockpilePath = path.resolve(flags.stockpile ?? defaultStockpilePath);
  const researchPoolPath = path.resolve(flags["research-pool"] ?? defaultResearchPoolPath);
  const evidenceSnapshotPath = path.resolve(flags["evidence-snapshot"] ?? defaultEvidenceSnapshotPath);
  const defaultWebResearchPath = path.join(developmentDirectory(), "source_web_research_report.md");
  const webResearchPath = path.resolve(flags["research-report"] ?? defaultWebResearchPath);
  const stockpile = await exists(stockpilePath) ? await readJson(stockpilePath) : null;
  const researchPool = await exists(researchPoolPath) ? await readJson(researchPoolPath) : null;
  const evidenceSnapshot = await exists(evidenceSnapshotPath) ? await readJson(evidenceSnapshotPath) : null;
  const webResearchReport = await exists(webResearchPath) ? String(await fs.readFile(webResearchPath, "utf8")).trim() : null;
  if (evidenceSnapshot) {
    const validation = validateSourceEvidenceSnapshot(evidenceSnapshot);
    if (!validation.done) throw new Error(`Source evidence snapshot is invalid: ${validation.blockers.join(", ")}`);
    if (evidenceSnapshot.schema !== WINNER_EVIDENCE_SNAPSHOT_SCHEMA || evidenceSnapshot.channel !== channel) {
      throw new Error(`Source evidence snapshot does not match channel ${channel}.`);
    }
  }
  const researchConceptSignatures = (researchPool?.concepts ?? []).slice(0, 100).map((row) => ({
    id: row.id,
    lane: row.lane,
    title: row.title,
    status: row.status,
    related_stockpile_id: row.related_stockpile_id ?? null,
    disposition_note: row.note ?? null,
  }));
  return {
    stockpilePath: stockpile ? stockpilePath : null,
    stockpileSha256: stockpile ? await fileSha256(stockpilePath) : null,
    researchPoolPath: researchPool ? researchPoolPath : null,
    researchPoolSha256: researchPool ? await fileSha256(researchPoolPath) : null,
    evidenceSnapshotPath: evidenceSnapshot ? evidenceSnapshotPath : null,
    evidenceSnapshotSha256: evidenceSnapshot ? await fileSha256(evidenceSnapshotPath) : null,
    webResearchPath: webResearchReport ? webResearchPath : null,
    webResearchSha256: webResearchReport ? await fileSha256(webResearchPath) : null,
    modelContext: {
      evidence_snapshot: evidenceSnapshot,
      current_web_research: webResearchReport ? {
        role: "cited_current_research_context",
        report_path: webResearchPath,
        report_sha256: await fileSha256(webResearchPath),
        report_markdown: webResearchReport,
      } : null,
      stockpile: stockpile ? {
        ranking_rule: stockpile.ranking_rule,
        instruction: "Only concepts explicitly promoted by the current operator creative brief are mandatory finalists. Active and pending entries are historical editorial context. Published and rejected entries are duplicate/reskin exclusions.",
        active: stockpile.active ?? [],
        pending_research: stockpile.pending_research ?? [],
        published: stockpile.published ?? [],
        rejected: stockpile.rejected ?? [],
        research_dispositions: stockpile.research_dispositions ?? [],
      } : null,
      ranked_research_pool: researchPool ? {
        role: "duplicate_and_reskin_detection_only",
        warning: "These are synthetic premise signatures, not measured audience evidence. Their ranks and AI editorial scores are intentionally omitted so they cannot anchor selection. Use the evidence snapshot for demand and use this list only to avoid repeating old concepts.",
        provenance: researchPool.provenance,
        concept_count: researchPool.concept_count,
        concept_signatures: researchConceptSignatures,
      } : null,
    },
  };
}

function rawHttpsUrls(value) {
  return [...new Set(
    [...String(value ?? "").matchAll(/https:\/\/[^\s<>()\[\]{}"']+/g)]
      .map((match) => match[0].replace(/[.,;:!?]+$/g, "")),
  )];
}

async function research() {
  const developmentDir = developmentDirectory();
  const { formula, formulaSha256 } = await readFormula();
  const recent = await recentTitles();
  const creativeBrief = await operatorCreativeBrief();
  const premiseContext = await premiseResearchContext();
  const template = extractTextPrompt(await fs.readFile(path.join(repoRoot, "docs", "prompts", "manhwa_recap_source_research_v1.md"), "utf8"));
  const question = creativeBrief.text || "Refresh the evidence for packages, openings, story structures, and satisfaction patterns most likely to grow this manhwa recap channel now.";
  const prompt = `${template.replaceAll("CHANNEL", channel)}

RESEARCH AS-OF DATE
${new Date().toISOString().slice(0, 10)}

OPERATOR RESEARCH QUESTION
${question}

BINDING CURRENT CHANNEL FORMULA JSON
Treat this as the current hypothesis set to test, not as proof.
${JSON.stringify(packagingFormulaForModel(formula), null, 2)}

CURRENT MEASURED EVIDENCE SNAPSHOT JSON
${JSON.stringify(premiseContext.modelContext.evidence_snapshot, null, 2)}

RECENT CHANNEL TITLES JSON
${JSON.stringify(recent.titles, null, 2)}
`;
  const promptPath = path.join(developmentDir, "source_web_research_prompt.md");
  const outputPath = path.join(developmentDir, "source_web_research_report.md");
  const receiptPath = path.join(developmentDir, "source_web_research_receipt.json");
  await fs.mkdir(developmentDir, { recursive: true });
  await fs.writeFile(promptPath, `${prompt.trim()}\n`, "utf8");
  const response = await modelResponse({
    prompt,
    stageName: "winner_source_deep_research",
    outputPath,
    responsePath: flags["response-path"] ?? null,
    timeoutMs: Number(flags["timeout-ms"] ?? 3_600_000),
  });
  const report = String(response.content ?? "").trim();
  const urls = rawHttpsUrls(report);
  const minimumCitations = Math.max(1, Number(flags["minimum-citations"] ?? 5));
  const blockers = [];
  if (report.length < 1_000) blockers.push("research_report_too_short");
  if (urls.length < minimumCitations) blockers.push("insufficient_exported_source_urls");
  const receipt = {
    schema: "goldflow_source_web_research_receipt_v1",
    status: blockers.length ? "blocked" : "passed",
    channel,
    development_slug: developmentSlug,
    research_mode: `${response.source_model_contract.provider}_planning_room_research`,
    source_model_contract: response.source_model_contract,
    research_question: question,
    operator_brief_path: creativeBrief.sourcePath,
    operator_brief_sha256: creativeBrief.text ? sha256Text(creativeBrief.text) : null,
    formula_path: formulaPath,
    formula_sha256: formulaSha256,
    evidence_snapshot_path: premiseContext.evidenceSnapshotPath,
    evidence_snapshot_sha256: premiseContext.evidenceSnapshotSha256,
    recent_ledger_path: recent.ledgerPath,
    prompt_path: promptPath,
    prompt_sha256: sha256Text(prompt),
    report_path: outputPath,
    report_sha256: await fileSha256(outputPath),
    exported_source_url_count: urls.length,
    exported_source_urls: urls,
    minimum_source_urls: minimumCitations,
    blockers,
    completed_at: new Date().toISOString(),
  };
  await writeJson(receiptPath, receipt);
  console.log(JSON.stringify({
    status: receipt.status,
    research_report_path: outputPath,
    research_receipt_path: receiptPath,
    exported_source_url_count: urls.length,
    blockers,
    next_required_action: blockers.length
      ? "inspect or exact-scope rerun the research report; do not promote unsupported findings"
      : "review the cited dossier, then curate accepted measured findings into the versioned evidence snapshot",
  }, null, 2));
  if (blockers.length) throw new Error(`Source research is blocked: ${blockers.join(", ")}`);
}

async function modelResponse({
  prompt,
  stageName,
  outputPath,
  responsePath = null,
  timeoutMs = 1_200_000,
}) {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  if (responsePath) {
    const resolved = path.resolve(responsePath);
    const content = await fs.readFile(resolved, "utf8");
    await fs.writeFile(outputPath, content, "utf8");
    const metadata = {
      schema: "goldflow_external_model_response_v1",
      status: "passed",
      stage_name: stageName,
      response_source_path: resolved,
      response_source_sha256: sha256Text(content),
      output_path: outputPath,
      imported_at: new Date().toISOString(),
    };
    await writeJson(`${outputPath}.meta.json`, metadata);
    const response = { content, ...metadata };
    return { ...response, source_model_contract: sourceModelReceipt(response, stageName) };
  }
  const sourceRuntime = sourceModelContract(flags, { stageName });
  const response = await runCodexCli({
    prompt,
    stageName,
    repoRoot,
    outputPath,
    provider: sourceRuntime.provider,
    model: sourceRuntime.model,
    reasoningEffort: sourceRuntime.reasoning_effort,
    verbosity: flags.verbosity ?? "medium",
    timeoutMs,
  });
  return { ...response, source_model_contract: sourceModelReceipt(response, stageName) };
}

async function resumePassedModelResponse({ prompt, stageName, outputPath }) {
  const metadataPath = `${outputPath}.meta.json`;
  if (!await exists(outputPath) || !await exists(metadataPath)) {
    throw new Error(`Cannot resume ${stageName}: passed output or metadata is missing.`);
  }
  const [content, metadata] = await Promise.all([
    fs.readFile(outputPath, "utf8"),
    readJson(metadataPath),
  ]);
  const blockers = [];
  if (metadata?.status !== "passed") blockers.push("prior_model_output_not_passed");
  if (metadata?.stage_name !== stageName) blockers.push("prior_model_stage_mismatch");
  if (metadata?.prompt_sha256 !== sha256Text(prompt)) blockers.push("prior_model_prompt_hash_mismatch");
  if (metadata?.normalized_output_sha256 !== sha256Text(content)) blockers.push("prior_model_output_hash_mismatch");
  const expectedContract = sourceModelContract(flags, { stageName });
  const receiptValidation = validateSourceModelReceipt(metadata, { expectedContract });
  blockers.push(...receiptValidation.blockers);
  if (blockers.length) {
    throw new Error(`Cannot resume ${stageName}: ${[...new Set(blockers)].join(", ")}`);
  }
  return {
    content,
    ...metadata,
    source_model_contract: sourceModelReceipt(metadata, stageName),
    resumed_without_resubmission: true,
  };
}

function sourceModelReceipt(response, stageName) {
  const contract = sourceModelContract(flags, { stageName });
  if (response?.provider === "external_response" || response?.schema === "goldflow_external_model_response_v1") {
    return {
      ...contract,
      execution_mode: "external_response_import",
      receipt_validation: "not_applicable_diagnostic_import",
    };
  }
  const validation = validateSourceModelReceipt(response, { expectedContract: contract });
  if (!validation.done) throw new Error(`Source model receipt violated the stage-routed planning-room contract: ${validation.blockers.join(", ")}`);
  return {
    ...contract,
    execution_mode: contract.provider.endsWith("_web") ? "live_authenticated_web" : "live_planning_runner",
    receipt_validation: "passed",
    transport: response.transport ?? null,
    studio_job_id: response.studio_job_id ?? null,
    bridge_receipt_path: response.bridge_receipt_path ?? null,
    conversation_url: response.conversation_url ?? null,
  };
}

function protectedCreativeCandidate(candidate) {
  const protectedFields = [
    "id", "title", "title_contract", "thumbnail", "premise", "core_advantage",
    "story_contract", "dramatic_contract", "differentiation", "evidence_ids",
  ];
  return Object.fromEntries(protectedFields.map((field) => [field, candidate?.[field]]));
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]));
  }
  return value;
}

function assertJudgePreservedCandidates(draft, judged) {
  const draftCandidates = draft?.candidates ?? [];
  const judgedCandidates = judged?.candidates ?? [];
  if (draftCandidates.length !== judgedCandidates.length) throw new Error("Packaging selector changed the candidate count.");
  for (let index = 0; index < draftCandidates.length; index += 1) {
    const before = protectedCreativeCandidate(draftCandidates[index]);
    const after = protectedCreativeCandidate(judgedCandidates[index]);
    if (sha256Text(JSON.stringify(canonicalJson(before))) !== sha256Text(JSON.stringify(canonicalJson(after)))) {
      throw new Error(`Packaging selector changed protected creative fields for candidate ${before.id ?? index}.`);
    }
  }
}

function candidateBoardMarkdown(document, report, formula) {
  const rows = [...(document.candidates ?? [])].sort((left, right) =>
    Number(left?.pairwise_rank ?? 999) - Number(right?.pairwise_rank ?? 999)
    || Number(right?.computed?.weighted_score ?? 0) - Number(left?.computed?.weighted_score ?? 0));
  const lines = [
    `# Winner Candidate Board — ${document.development_slug}`,
    "",
    `Formula: **${formula.formula_name}** (${formula.version})`,
    "",
    `Status: **${report.status.toUpperCase()}** — ${report.eligible_candidate_count}/${report.candidate_count} eligible`,
    "",
    `Reversal engines: ${(report.reversal_engines ?? []).map((row) => `${row.id}=${row.type}`).join("; ") || "unavailable"}`,
    "",
  ];
  for (const candidate of rows) {
    const decisiveApplications = Array.isArray(candidate.core_advantage?.decisive_applications)
      ? candidate.core_advantage.decisive_applications
      : [];
    const firstProof = decisiveApplications.find((row) => row?.role === "first_proof");
    const lateProof = decisiveApplications.find((row) => row?.role === "climax_or_late_scale_proof");
    lines.push(
      `## ${candidate.pairwise_rank ?? "?"}. ${candidate.title}`,
      "",
      `- Deterministic weighted score: ${candidate.computed?.weighted_score ?? "n/a"}/100`,
      `- Pairwise wins: ${candidate.pairwise_wins ?? "n/a"}`,
      `- Eligible: ${candidate.computed?.eligible ? "yes" : "no"}`,
      `- Thumbnail: **${candidate.thumbnail?.main_text ?? ""}** — ${candidate.thumbnail?.dominant_proof ?? ""}`,
      `- Additive proof: ${candidate.thumbnail?.additive_fact ?? ""}`,
      `- Reversal engine: ${candidate.core_advantage?.type ?? ""} — ${candidate.core_advantage?.core_capability ?? ""}`,
      `- Execution bridge: ${candidate.core_advantage?.execution_bridge ?? ""}`,
      `- First application: ${firstProof?.result ?? candidate.core_advantage?.first_visible_proof ?? ""} — ${firstProof?.dominance_proof ?? ""}`,
      `- Late-scale application: ${lateProof?.result ?? ""} — ${lateProof?.dominance_proof ?? ""}`,
      `- Causal scale path: ${candidate.core_advantage?.causal_scale_path ?? ""}`,
      `- Emotional promise: ${candidate.dramatic_contract?.emotional_promise ?? "not supplied"}`,
      `- Central relationship question: ${candidate.dramatic_contract?.central_relationship_question ?? "not supplied"}`,
      `- Midpoint human transformation: ${candidate.dramatic_contract?.midpoint_human_transformation ?? "not supplied"}`,
      `- Procedural risk: ${candidate.dramatic_contract?.procedural_risk ?? "not supplied"}`,
      `- Click transfer hypothesis: ${candidate.evidence_hypothesis?.click_transfer ?? "not supplied"}`,
      `- Watch transfer hypothesis: ${candidate.evidence_hypothesis?.watch_transfer ?? "not supplied"}`,
      `- Failure analogue: ${candidate.evidence_hypothesis?.failure_analogue ?? "not supplied"}`,
      `- Selection judgment: ${candidate.selection_rationale ?? ""}`,
      `- Blockers: ${(candidate.computed?.blockers ?? []).join(", ") || "none"}`,
      `- Advisory score warnings: ${(candidate.computed?.warnings ?? []).join(", ") || "none"}`,
      "",
      candidate.premise ?? "",
      "",
    );
  }
  return `${lines.join("\n").trim()}\n`;
}

function packagingFormulaForModel(formula) {
  const copy = structuredClone(formula);
  delete copy.retention_architecture;
  return copy;
}

async function ideate() {
  const developmentDir = developmentDirectory();
  const { formula, formulaSha256 } = await readFormula();
  const recent = await recentTitles();
  const creativeBrief = await operatorCreativeBrief();
  const premiseContext = await premiseResearchContext();
  const ideationTemplate = extractTextPrompt(await fs.readFile(path.join(repoRoot, "docs", "prompts", "manhwa_recap_packaging_first_ideation_v1.md"), "utf8"));
  const modelFormula = packagingFormulaForModel(formula);
  const authorPrompt = `${ideationTemplate
    .replaceAll("CHANNEL", channel)
    .replaceAll("DEVELOPMENT_SLUG", developmentSlug)
    .replaceAll("FORMULA_VERSION", formula.version)}

BINDING CHANNEL FORMULA JSON
${JSON.stringify(modelFormula, null, 2)}

RECENT CHANNEL TITLES JSON
${JSON.stringify(recent.titles, null, 2)}

OPERATOR CREATIVE BRIEF
${creativeBrief.text || "No additional operator seeds. Follow the formula and current evidence."}

DURABLE STOCKPILE AND DIRECTIONAL RESEARCH CONTEXT JSON
Use the evidence snapshot for measured demand, delivery, and failure evidence. Only concepts explicitly promoted in the current OPERATOR CREATIVE BRIEF are mandatory finalists. Treat active and pending stockpile rows as historical editorial context, published and rejected rows as exclusion signatures, and synthetic concept signatures only as duplicate/reskin detection. Operator decisions outrank model scores.
${JSON.stringify(premiseContext.modelContext, null, 2)}
`;
  const authorPromptPath = path.join(developmentDir, "winner_ideation_prompt.md");
  await fs.mkdir(developmentDir, { recursive: true });
  await fs.writeFile(authorPromptPath, `${authorPrompt.trim()}\n`, "utf8");

  let judgedDocument;
  let draftPath = null;
  let judgePromptPath = null;
  const sourceModelContracts = [];
  if (flags["response-path"]) {
    const imported = await modelResponse({
      prompt: authorPrompt,
      stageName: "winner_ideation_import",
      outputPath: path.join(developmentDir, "winner_ideation_judged_response.txt"),
      responsePath: flags["response-path"],
    });
    sourceModelContracts.push(imported.source_model_contract);
    judgedDocument = extractJsonObject(imported.content);
  } else {
    const authorOutputPath = path.join(developmentDir, "winner_ideation_draft_response.txt");
    const resumeSelector = isTrue(flags["resume-selector"]);
    if (resumeSelector && flags["draft-response-path"]) {
      throw new Error("Use either --resume-selector true or --draft-response-path, not both.");
    }
    const draftResponse = resumeSelector
      ? await resumePassedModelResponse({
        prompt: authorPrompt,
        stageName: "winner_ideation_author",
        outputPath: authorOutputPath,
      })
      : await modelResponse({
        prompt: authorPrompt,
        stageName: "winner_ideation_author",
        outputPath: authorOutputPath,
        responsePath: flags["draft-response-path"] ?? null,
        timeoutMs: Number(flags["timeout-ms"] ?? 3_600_000),
      });
    sourceModelContracts.push(draftResponse.source_model_contract);
    const draft = extractJsonObject(draftResponse.content);
    draftPath = path.join(developmentDir, "winner_ideation_draft.json");
    if (resumeSelector) {
      if (!await exists(draftPath)) throw new Error("Cannot resume selector: winner_ideation_draft.json is missing.");
      const existingDraft = await readJson(draftPath);
      if (sha256Text(JSON.stringify(canonicalJson(existingDraft))) !== sha256Text(JSON.stringify(canonicalJson(draft)))) {
        throw new Error("Cannot resume selector: stored draft JSON does not match the passed author output.");
      }
    } else {
      await writeJson(draftPath, draft);
    }
    const selectorTemplate = extractTextPrompt(await fs.readFile(path.join(repoRoot, "docs", "prompts", "manhwa_recap_packaging_selector_v1.md"), "utf8"));
    const selectorPrompt = `${selectorTemplate}

BINDING CHANNEL FORMULA JSON
${JSON.stringify(modelFormula, null, 2)}

RECENT CHANNEL TITLES JSON
${JSON.stringify(recent.titles, null, 2)}

OPERATOR CREATIVE BRIEF
${creativeBrief.text || "No additional operator seeds."}

DURABLE STOCKPILE AND DIRECTIONAL RESEARCH CONTEXT JSON
Use the evidence snapshot for measured demand and failure evidence. Use the stockpile and synthetic concept signatures to reject duplicates and reskins. Operator decisions outrank model scores.
${JSON.stringify(premiseContext.modelContext, null, 2)}

PROTECTED CREATIVE FINALISTS JSON
${JSON.stringify(draft, null, 2)}
`;
    judgePromptPath = path.join(developmentDir, "winner_ideation_selector_prompt.md");
    await fs.writeFile(judgePromptPath, `${selectorPrompt.trim()}\n`, "utf8");
    const judgedResponse = await modelResponse({
      prompt: selectorPrompt,
      stageName: "winner_ideation_selector",
      outputPath: path.join(developmentDir, "winner_ideation_judged_response.txt"),
      responsePath: flags["judge-response-path"] ?? null,
      timeoutMs: Number(flags["timeout-ms"] ?? 3_600_000),
    });
    sourceModelContracts.push(judgedResponse.source_model_contract);
    judgedDocument = extractJsonObject(judgedResponse.content);
    assertJudgePreservedCandidates(draft, judgedDocument);
  }
  judgedDocument = {
    ...judgedDocument,
    schema: WINNER_IDEATION_SCHEMA,
    channel,
    development_slug: developmentSlug,
    formula_version: formula.version,
    source_workflow_profile: WINNER_SOURCE_ROOM_PROFILE,
  };
  const evaluated = evaluateWinnerIdeation(judgedDocument, formula, {
    recentTitles: recent.titles,
    rejectedCandidateIds: (premiseContext.modelContext.stockpile?.rejected ?? []).map((row) => row.id),
  });
  evaluated.report.formula_path = formulaPath;
  evaluated.report.formula_sha256 = formulaSha256;
  evaluated.report.recent_ledger_path = recent.ledgerPath;
  evaluated.report.operator_creative_brief_path = creativeBrief.sourcePath;
  evaluated.report.operator_creative_brief_sha256 = creativeBrief.text ? sha256Text(creativeBrief.text) : null;
  evaluated.report.premise_stockpile_path = premiseContext.stockpilePath;
  evaluated.report.premise_stockpile_sha256 = premiseContext.stockpileSha256;
  evaluated.report.ranked_research_pool_path = premiseContext.researchPoolPath;
  evaluated.report.ranked_research_pool_sha256 = premiseContext.researchPoolSha256;
  evaluated.report.source_evidence_snapshot_path = premiseContext.evidenceSnapshotPath;
  evaluated.report.source_evidence_snapshot_sha256 = premiseContext.evidenceSnapshotSha256;
  evaluated.report.source_web_research_report_path = premiseContext.webResearchPath;
  evaluated.report.source_web_research_report_sha256 = premiseContext.webResearchSha256;
  evaluated.report.source_model_contracts = sourceModelContracts;
  evaluated.report.author_prompt_path = authorPromptPath;
  evaluated.report.draft_path = draftPath;
  evaluated.report.selector_prompt_path = judgePromptPath;
  evaluated.report.scoring_authority = flags["response-path"] ? "imported_prejudged_response" : "independent_selector_pass";
  evaluated.report.selector_recovery_mode = isTrue(flags["resume-selector"])
    ? "passed_author_reused_without_resubmission"
    : "fresh_author_then_selector";
  evaluated.report.updated_at = new Date().toISOString();
  const ideationPath = path.join(developmentDir, "winner_ideation_candidates.json");
  const reportPath = path.join(developmentDir, "winner_ideation_report.json");
  const boardPath = path.join(developmentDir, "winner_candidates_review.md");
  await writeJson(ideationPath, evaluated.document);
  evaluated.report.ideation_path = ideationPath;
  evaluated.report.ideation_sha256 = await fileSha256(ideationPath);
  await writeJson(reportPath, evaluated.report);
  await fs.writeFile(boardPath, candidateBoardMarkdown(evaluated.document, evaluated.report, formula), "utf8");
  console.log(JSON.stringify({
    status: evaluated.report.status,
    ideation_path: ideationPath,
    report_path: reportPath,
    review_board_path: boardPath,
    eligible_candidate_ids: evaluated.report.ranked_eligible_candidate_ids,
    next_required_action: "operator reviews the board, then runs source approve-package for one eligible candidate",
  }, null, 2));
  if (evaluated.report.status !== "passed") throw new Error(`Winner ideation is blocked: ${evaluated.report.blockers.join(", ")}`);
}

async function loadCurrentIdeation(developmentDir, formula, { allowBlocked = false } = {}) {
  const ideationPath = path.resolve(flags.ideation ?? path.join(developmentDir, "winner_ideation_candidates.json"));
  const ideation = await readJson(ideationPath);
  const recent = await recentTitles();
  const premiseContext = await premiseResearchContext();
  const reevaluated = evaluateWinnerIdeation(ideation, formula, {
    recentTitles: recent.titles,
    rejectedCandidateIds: (premiseContext.modelContext.stockpile?.rejected ?? []).map((row) => row.id),
  });
  if (reevaluated.report.status !== "passed" && !allowBlocked) {
    throw new Error(`Winner ideation is not currently eligible: ${reevaluated.report.blockers.join(", ")}`);
  }
  const ideationSha256 = await fileSha256(ideationPath);
  const reportPath = path.join(developmentDir, "winner_ideation_report.json");
  const report = await exists(reportPath) ? await readJson(reportPath) : null;
  if (report?.ideation_sha256 && report.ideation_sha256 !== ideationSha256) {
    throw new Error("Winner ideation report is stale for the current candidate document.");
  }
  return { ideationPath, ideation: reevaluated.document, ideationSha256, reportPath: report ? reportPath : null, report };
}

async function approvePackage() {
  if (!isTrue(flags.approve)) throw new Error("Package approval requires --approve true.");
  const approvedBy = required(flags["approved-by"], "--approved-by <operator>");
  const candidateId = required(flags["candidate-id"], "--candidate-id <id>");
  const approveRisk = isTrue(flags["approve-risk"]);
  const riskReason = approveRisk ? required(flags["risk-reason"], "--risk-reason <reason>") : null;
  const developmentDir = developmentDirectory();
  const { formula, formulaSha256 } = await readFormula();
  const { ideationPath, ideation, ideationSha256, reportPath: ideationReportPath, report: ideationReport } = await loadCurrentIdeation(developmentDir, formula, { allowBlocked: approveRisk });
  const built = buildWinnerPackageContract({
    ideation,
    ideationPath,
    ideationSha256,
    formula,
    formulaPath,
    formulaSha256,
    candidateId,
    approvedBy,
    operatorOverride: approveRisk ? { approved: true, reason: riskReason } : null,
  });
  const packagePath = path.join(developmentDir, "winner_package_contract.json");
  const approvalPath = path.join(developmentDir, "winner_package_approval.json");
  built.contract.source_evidence_snapshot_path = ideationReport?.source_evidence_snapshot_path ?? null;
  built.contract.source_evidence_snapshot_sha256 = ideationReport?.source_evidence_snapshot_sha256 ?? null;
  built.contract.source_web_research_report_path = ideationReport?.source_web_research_report_path ?? null;
  built.contract.source_web_research_report_sha256 = ideationReport?.source_web_research_report_sha256 ?? null;
  built.contract.ideation_report_path = ideationReportPath;
  built.contract.ideation_report_sha256 = ideationReportPath ? await fileSha256(ideationReportPath) : null;
  await writeJson(packagePath, built.contract);
  built.approval.winner_package_path = packagePath;
  built.approval.winner_package_sha256 = await fileSha256(packagePath);
  built.approval.source_evidence_snapshot_sha256 = built.contract.source_evidence_snapshot_sha256;
  built.approval.source_web_research_report_sha256 = built.contract.source_web_research_report_sha256;
  await writeJson(approvalPath, built.approval);
  console.log(JSON.stringify({
    status: "approved",
    selected_candidate_id: candidateId,
    selected_title: built.contract.selected_title,
    winner_package_path: packagePath,
    approval_path: approvalPath,
    next_required_action: "goldflow source blueprint",
  }, null, 2));
}

async function loadApprovedPackage(developmentDir) {
  const packagePath = path.resolve(flags.package ?? path.join(developmentDir, "winner_package_contract.json"));
  const approvalPath = path.resolve(flags["package-approval"] ?? path.join(developmentDir, "winner_package_approval.json"));
  const packageContract = await readJson(packagePath);
  const validation = validateWinnerPackageContract(packageContract);
  if (!validation.done) throw new Error(`Winner package is invalid: ${validation.blockers.join(", ")}`);
  const approval = await readJson(approvalPath);
  const packageSha256 = await fileSha256(packagePath);
  if (approval?.status !== "approved" || approval?.winner_package_sha256 !== packageSha256) {
    throw new Error("Winner package approval is missing or stale.");
  }
  if (approval.selected_candidate_id !== packageContract.selected_candidate_id) throw new Error("Winner package approval candidate mismatch.");
  return { packagePath, packageSha256, packageContract, approvalPath, approval };
}

function usesRetentionDramaRoom(packageContract) {
  return packageContract?.source_workflow_profile === WINNER_SOURCE_ROOM_PROFILE;
}

function validateBlueprintDocument(blueprintDocument, loadedPackage) {
  return validateWinnerBlueprintForPackage(blueprintDocument, {
    packageContract: loadedPackage.packageContract,
    packageSha256: loadedPackage.packageSha256,
  });
}

async function blueprint() {
  const developmentDir = developmentDirectory();
  const { formula, formulaSha256 } = await readFormula();
  const loaded = await loadApprovedPackage(developmentDir);
  if (loaded.packageContract.formula_sha256 !== formulaSha256) throw new Error("Approved winner package formula hash is stale.");
  const premiseContext = await premiseResearchContext();
  const dramaRoomEnabled = usesRetentionDramaRoom(loaded.packageContract);
  const blueprintTemplateName = dramaRoomEnabled
    ? "manhwa_recap_story_blueprint_v2.md"
    : "manhwa_recap_story_blueprint_v1.md";
  const template = extractTextPrompt(await fs.readFile(path.join(repoRoot, "docs", "prompts", blueprintTemplateName), "utf8"));
  const prompt = `${template
    .replaceAll("CHANNEL", channel)
    .replaceAll("DEVELOPMENT_SLUG", loaded.packageContract.development_slug)
    .replaceAll("SELECTED_CANDIDATE_ID", loaded.packageContract.selected_candidate_id)
    .replaceAll("SELECTED_TITLE", loaded.packageContract.selected_title)}

BINDING APPROVED WINNER PACKAGE JSON
${JSON.stringify(loaded.packageContract, null, 2)}

CURRENT EVIDENCE SNAPSHOT JSON
Use this for opening-mode and delivery context only. The approved package remains story truth.
${JSON.stringify(premiseContext.modelContext.evidence_snapshot, null, 2)}
`;
  const promptPath = path.join(developmentDir, "winner_story_blueprint_prompt.md");
  await fs.writeFile(promptPath, `${prompt.trim()}\n`, "utf8");
  const response = await modelResponse({
    prompt,
    stageName: "winner_story_blueprint",
    outputPath: path.join(developmentDir, "winner_story_blueprint_response.txt"),
    responsePath: flags["response-path"] ?? null,
    timeoutMs: Number(flags["timeout-ms"] ?? 1_800_000),
  });
  const draft = extractJsonObject(response.content);
  const document = {
    ...draft,
    schema: dramaRoomEnabled ? WINNER_STORY_BLUEPRINT_V2_SCHEMA : WINNER_STORY_BLUEPRINT_SCHEMA,
    status: "planned",
    ...(dramaRoomEnabled ? {
      source_workflow_profile: WINNER_SOURCE_ROOM_PROFILE,
      audience_feedback_contract_version: WINNER_AUDIENCE_FEEDBACK_CONTRACT_VERSION,
      retention_north_star: {
        metric: "average_percentage_viewed",
        target_percent: 50,
        contract: "upload_measurement_target_not_model_prediction",
      },
    } : {}),
    channel: loaded.packageContract.channel,
    development_slug: loaded.packageContract.development_slug,
    selected_candidate_id: loaded.packageContract.selected_candidate_id,
    selected_title: loaded.packageContract.selected_title,
    winner_package_path: loaded.packagePath,
    winner_package_sha256: loaded.packageSha256,
    source_evidence_snapshot_path: premiseContext.evidenceSnapshotPath,
    source_evidence_snapshot_sha256: premiseContext.evidenceSnapshotSha256,
    planned_at: new Date().toISOString(),
  };
  const validation = validateBlueprintDocument(document, loaded);
  const blueprintPath = path.join(developmentDir, "winner_story_blueprint.json");
  const reportPath = path.join(developmentDir, "winner_story_blueprint_report.json");
  await writeJson(blueprintPath, document);
  await writeJson(reportPath, {
    schema: dramaRoomEnabled
      ? "goldflow_winner_story_blueprint_report_v2"
      : "goldflow_winner_story_blueprint_report_v1",
    status: validation.done ? "passed" : "blocked",
    channel,
    development_slug: loaded.packageContract.development_slug,
    selected_candidate_id: loaded.packageContract.selected_candidate_id,
    winner_story_blueprint_path: blueprintPath,
    winner_story_blueprint_sha256: await fileSha256(blueprintPath),
    winner_package_path: loaded.packagePath,
    winner_package_sha256: loaded.packageSha256,
    source_evidence_snapshot_path: premiseContext.evidenceSnapshotPath,
    source_evidence_snapshot_sha256: premiseContext.evidenceSnapshotSha256,
    prompt_path: promptPath,
    prompt_sha256: sha256Text(prompt),
    model: response.model ?? "external_response",
    provider: response.provider ?? "external_response",
    reasoning_effort: response.reasoning_effort ?? null,
    source_model_contract: response.source_model_contract,
    source_workflow_profile: loaded.packageContract.source_workflow_profile ?? "legacy_single_draft_v1",
    blueprint_template: blueprintTemplateName,
    target_word_total: validation.target_word_total,
    blockers: validation.blockers,
    updated_at: new Date().toISOString(),
  });
  console.log(JSON.stringify({
    status: validation.done ? "passed" : "blocked",
    blueprint_path: blueprintPath,
    report_path: reportPath,
    target_word_total: validation.target_word_total,
    blockers: validation.blockers,
    next_required_action: validation.done
      ? (dramaRoomEnabled
        ? "goldflow source blueprint-audit"
        : "operator or delegated agent reviews the causal blueprint, then runs source approve-blueprint")
      : "repair or regenerate only the story blueprint before approval",
  }, null, 2));
  if (!validation.done) throw new Error(`Winner story blueprint is blocked: ${validation.blockers.join(", ")}`);
}

async function loadBlueprintAudienceAudit(developmentDir, loadedPackage, {
  blueprintPath,
  blueprintSha256,
  blueprintDocument,
  auditPath: requestedAuditPath = null,
} = {}) {
  const auditPath = path.resolve(
    requestedAuditPath
      ?? flags["blueprint-audit"]
      ?? path.join(developmentDir, "winner_blueprint_audience_audit.json"),
  );
  const document = await readJson(auditPath);
  const auditSha256 = await fileSha256(auditPath);
  const validation = validateWinnerBlueprintAudienceAudit(document, {
    packageContract: loadedPackage.packageContract,
    packageSha256: loadedPackage.packageSha256,
    blueprint: blueprintDocument,
    blueprintSha256,
  });
  if (!validation.done) {
    throw new Error(`Winner blueprint audience audit is invalid or stale: ${validation.blockers.join(", ")}`);
  }
  return {
    auditPath,
    auditSha256,
    document,
    validation,
    blueprintPath,
  };
}

async function blueprintAudit() {
  const developmentDir = developmentDirectory();
  const loaded = await loadApprovedPackage(developmentDir);
  if (!usesRetentionDramaRoom(loaded.packageContract)) {
    throw new Error("source blueprint-audit is available only for retention_drama_room_v1 packages.");
  }
  const blueprintPath = path.resolve(flags.blueprint ?? path.join(developmentDir, "winner_story_blueprint.json"));
  const blueprintDocument = await readJson(blueprintPath);
  const blueprintSha256 = await fileSha256(blueprintPath);
  const blueprintValidation = validateBlueprintDocument(blueprintDocument, loaded);
  if (!blueprintValidation.done) {
    throw new Error(`Winner story blueprint is invalid: ${blueprintValidation.blockers.join(", ")}`);
  }
  if (!usesWinnerAudienceFeedbackContract(blueprintDocument)) {
    throw new Error("source blueprint-audit requires a marker-bearing audience-feedback blueprint; legacy blueprints remain directly approvable.");
  }
  const premiseContext = await premiseResearchContext();
  const template = extractTextPrompt(await fs.readFile(
    path.join(repoRoot, "docs", "prompts", "manhwa_recap_blueprint_audience_audit_v1.md"),
    "utf8",
  ));
  const prompt = `${template}

BINDING APPROVED WINNER PACKAGE JSON
${JSON.stringify(loaded.packageContract, null, 2)}

EXACT STORY BLUEPRINT TO AUDIT
${JSON.stringify(blueprintDocument, null, 2)}

CURRENT MEASURED AUDIENCE EVIDENCE SNAPSHOT JSON
Treat comment counts as lower-bound, self-selected audience signals. Use them to test audience trust and satisfaction risks, not to invent story facts or claim universal prevalence.
${JSON.stringify(premiseContext.modelContext.evidence_snapshot, null, 2)}
`;
  const promptPath = path.join(developmentDir, "winner_blueprint_audience_audit_prompt.md");
  await fs.writeFile(promptPath, `${prompt.trim()}\n`, "utf8");
  const response = await modelResponse({
    prompt,
    stageName: "winner_blueprint_audience_audit",
    outputPath: path.join(developmentDir, "winner_blueprint_audience_audit_response.txt"),
    responsePath: flags["response-path"] ?? null,
    timeoutMs: Number(flags["timeout-ms"] ?? 1_800_000),
  });
  const draft = extractJsonObject(response.content);
  const document = {
    ...draft,
    schema: WINNER_BLUEPRINT_AUDIENCE_AUDIT_SCHEMA,
    status: "completed",
    audience_feedback_contract_version: WINNER_AUDIENCE_FEEDBACK_CONTRACT_VERSION,
    channel: loaded.packageContract.channel,
    development_slug: loaded.packageContract.development_slug,
    selected_candidate_id: loaded.packageContract.selected_candidate_id,
    winner_package_path: loaded.packagePath,
    winner_package_sha256: loaded.packageSha256,
    winner_story_blueprint_path: blueprintPath,
    winner_story_blueprint_sha256: blueprintSha256,
    source_evidence_snapshot_path: premiseContext.evidenceSnapshotPath,
    source_evidence_snapshot_sha256: premiseContext.evidenceSnapshotSha256,
    source_model_contract: response.source_model_contract,
    audited_at: new Date().toISOString(),
  };
  const validation = validateWinnerBlueprintAudienceAudit(document, {
    packageContract: loaded.packageContract,
    packageSha256: loaded.packageSha256,
    blueprint: blueprintDocument,
    blueprintSha256,
  });
  const auditPath = path.join(developmentDir, "winner_blueprint_audience_audit.json");
  const reportPath = path.join(developmentDir, "winner_blueprint_audience_audit_report.json");
  await writeJson(auditPath, document);
  await writeJson(reportPath, {
    schema: "goldflow_winner_blueprint_audience_audit_report_v1",
    status: validation.done ? "passed" : "blocked",
    decision: document.decision ?? null,
    channel,
    development_slug: loaded.packageContract.development_slug,
    selected_candidate_id: loaded.packageContract.selected_candidate_id,
    winner_blueprint_audience_audit_path: auditPath,
    winner_blueprint_audience_audit_sha256: await fileSha256(auditPath),
    winner_story_blueprint_path: blueprintPath,
    winner_story_blueprint_sha256: blueprintSha256,
    winner_package_path: loaded.packagePath,
    winner_package_sha256: loaded.packageSha256,
    prompt_path: promptPath,
    prompt_sha256: sha256Text(prompt),
    source_model_contract: response.source_model_contract,
    blockers: validation.blockers,
    updated_at: new Date().toISOString(),
  });
  console.log(JSON.stringify({
    status: validation.done ? "passed" : "blocked",
    decision: document.decision ?? null,
    audit_path: auditPath,
    report_path: reportPath,
    blockers: validation.blockers,
    next_required_action: !validation.done
      ? "repair the malformed audit response only"
      : document.decision === "pass"
        ? "goldflow source approve-blueprint"
        : "inspect the cited findings, repair only the blueprint fields or movements at issue, then rerun source blueprint-audit",
  }, null, 2));
  if (!validation.done) throw new Error(`Winner blueprint audience audit is blocked: ${validation.blockers.join(", ")}`);
}

async function approveBlueprint() {
  if (!isTrue(flags.approve)) throw new Error("Story blueprint approval requires --approve true.");
  const approvedBy = required(flags["approved-by"], "--approved-by <operator-or-agent>");
  const developmentDir = developmentDirectory();
  const loaded = await loadApprovedPackage(developmentDir);
  const blueprintPath = path.resolve(flags.blueprint ?? path.join(developmentDir, "winner_story_blueprint.json"));
  const blueprintDocument = await readJson(blueprintPath);
  const blueprintSha256 = await fileSha256(blueprintPath);
  const validation = validateBlueprintDocument(blueprintDocument, loaded);
  if (!validation.done) throw new Error(`Winner story blueprint is invalid: ${validation.blockers.join(", ")}`);
  let auditLoaded = null;
  let auditRiskOverride = null;
  if (usesWinnerAudienceFeedbackContract(blueprintDocument)) {
    auditLoaded = await loadBlueprintAudienceAudit(developmentDir, loaded, {
      blueprintPath,
      blueprintSha256,
      blueprintDocument,
    });
    if (auditLoaded.document.decision !== "pass") {
      if (!isTrue(flags["approve-risk"])) {
        throw new Error("Winner blueprint audience audit requires revision. Repair the cited blueprint fields or pass --approve-risk true --risk-reason <reason> for an explicit operator override.");
      }
      auditRiskOverride = {
        approved: true,
        reason: required(flags["risk-reason"], "--risk-reason <operator reason>"),
        original_decision: auditLoaded.document.decision,
      };
    }
  }
  const approvalPath = path.join(developmentDir, "winner_story_blueprint_approval.json");
  const approval = {
    schema: WINNER_STORY_BLUEPRINT_APPROVAL_SCHEMA,
    status: "approved",
    channel: loaded.packageContract.channel,
    development_slug: loaded.packageContract.development_slug,
    selected_candidate_id: loaded.packageContract.selected_candidate_id,
    winner_story_blueprint_path: blueprintPath,
    winner_story_blueprint_sha256: blueprintSha256,
    winner_package_sha256: loaded.packageSha256,
    audience_feedback_contract_version: blueprintDocument.audience_feedback_contract_version ?? null,
    winner_blueprint_audience_audit_path: auditLoaded?.auditPath ?? null,
    winner_blueprint_audience_audit_sha256: auditLoaded?.auditSha256 ?? null,
    winner_blueprint_audience_audit_decision: auditLoaded?.document?.decision ?? null,
    audience_audit_risk_override: auditRiskOverride,
    approved_by: approvedBy,
    approved_at: new Date().toISOString(),
    approval_scope: usesRetentionDramaRoom(loaded.packageContract)
      ? "exact_package_bound_dramatic_engine_audience_trust_title_payment_continuity_movements_setups_climax_and_ending"
      : "exact_package_bound_canon_opening_causal_movements_climax_and_ending",
  };
  const approvalValidation = validateWinnerStoryBlueprintApproval(approval, { blueprintSha256 });
  if (!approvalValidation.done) throw new Error(`Winner story blueprint approval is invalid: ${approvalValidation.blockers.join(", ")}`);
  await writeJson(approvalPath, approval);
  console.log(JSON.stringify({
    status: "approved",
    winner_story_blueprint_path: blueprintPath,
    winner_story_blueprint_sha256: blueprintSha256,
    approval_path: approvalPath,
    next_required_action: usesRetentionDramaRoom(loaded.packageContract)
      ? "goldflow source retention-map"
      : "goldflow source script",
  }, null, 2));
}

async function loadApprovedBlueprint(developmentDir, loadedPackage) {
  const blueprintPath = path.resolve(flags.blueprint ?? path.join(developmentDir, "winner_story_blueprint.json"));
  const approvalPath = path.resolve(flags["blueprint-approval"] ?? path.join(developmentDir, "winner_story_blueprint_approval.json"));
  const blueprintDocument = await readJson(blueprintPath);
  const blueprintSha256 = await fileSha256(blueprintPath);
  const validation = validateBlueprintDocument(blueprintDocument, loadedPackage);
  if (!validation.done) throw new Error(`Winner story blueprint is invalid: ${validation.blockers.join(", ")}`);
  const approval = await readJson(approvalPath);
  const approvalValidation = validateWinnerStoryBlueprintApproval(approval, { blueprintSha256 });
  if (!approvalValidation.done) throw new Error(`Winner story blueprint approval is missing or stale: ${approvalValidation.blockers.join(", ")}`);
  if (approval.winner_package_sha256 !== loadedPackage.packageSha256) throw new Error("Winner story blueprint approval package hash is stale.");
  let auditLoaded = null;
  if (usesWinnerAudienceFeedbackContract(blueprintDocument)) {
    auditLoaded = await loadBlueprintAudienceAudit(developmentDir, loadedPackage, {
      blueprintPath,
      blueprintSha256,
      blueprintDocument,
      auditPath: approval.winner_blueprint_audience_audit_path,
    });
    if (approval.winner_blueprint_audience_audit_sha256 !== auditLoaded.auditSha256
      || approval.winner_blueprint_audience_audit_decision !== auditLoaded.document.decision
      || approval.audience_feedback_contract_version !== WINNER_AUDIENCE_FEEDBACK_CONTRACT_VERSION) {
      throw new Error("Winner story blueprint approval audience-audit binding is missing or stale.");
    }
    if (auditLoaded.document.decision !== "pass"
      && (!approval.audience_audit_risk_override?.approved
        || !String(approval.audience_audit_risk_override?.reason ?? "").trim())) {
      throw new Error("Winner story blueprint has an unresolved audience-audit revision decision.");
    }
  }
  return { blueprintPath, blueprintSha256, blueprintDocument, approvalPath, approval, auditLoaded };
}

async function retentionMap() {
  const developmentDir = developmentDirectory();
  const loaded = await loadApprovedPackage(developmentDir);
  if (!usesRetentionDramaRoom(loaded.packageContract)) {
    throw new Error("source retention-map is available only for retention_drama_room_v1 packages.");
  }
  const blueprintLoaded = await loadApprovedBlueprint(developmentDir, loaded);
  const template = extractTextPrompt(await fs.readFile(
    path.join(repoRoot, "docs", "prompts", "manhwa_recap_retention_map_v1.md"),
    "utf8",
  ));
  const prompt = `${template}

BINDING APPROVED WINNER PACKAGE JSON
${JSON.stringify(loaded.packageContract, null, 2)}

BINDING APPROVED STORY BLUEPRINT JSON
${JSON.stringify(blueprintLoaded.blueprintDocument, null, 2)}
`;
  const promptPath = path.join(developmentDir, "winner_retention_map_prompt.md");
  await fs.writeFile(promptPath, `${prompt.trim()}\n`, "utf8");
  const response = await modelResponse({
    prompt,
    stageName: "winner_retention_map",
    outputPath: path.join(developmentDir, "winner_retention_map_response.txt"),
    responsePath: flags["response-path"] ?? null,
    timeoutMs: Number(flags["timeout-ms"] ?? 1_800_000),
  });
  const draft = extractJsonObject(response.content);
  const document = {
    ...draft,
    schema: WINNER_RETENTION_MAP_SCHEMA,
    status: "planned",
    source_workflow_profile: WINNER_SOURCE_ROOM_PROFILE,
    ...(usesWinnerAudienceFeedbackContract(blueprintLoaded.blueprintDocument) ? {
      audience_feedback_contract_version: blueprintLoaded.blueprintDocument.audience_feedback_contract_version,
    } : {}),
    retention_north_star: {
      metric: "average_percentage_viewed",
      target_percent: 50,
      contract: "upload_measurement_target_not_model_prediction",
    },
    channel: loaded.packageContract.channel,
    development_slug: loaded.packageContract.development_slug,
    selected_candidate_id: loaded.packageContract.selected_candidate_id,
    winner_package_path: loaded.packagePath,
    winner_package_sha256: loaded.packageSha256,
    winner_story_blueprint_path: blueprintLoaded.blueprintPath,
    winner_story_blueprint_sha256: blueprintLoaded.blueprintSha256,
    planned_at: new Date().toISOString(),
  };
  const validation = validateWinnerRetentionMap(document, {
    blueprint: blueprintLoaded.blueprintDocument,
    blueprintSha256: blueprintLoaded.blueprintSha256,
    packageContract: loaded.packageContract,
    packageSha256: loaded.packageSha256,
  });
  const mapPath = path.join(developmentDir, "winner_retention_map.json");
  const reportPath = path.join(developmentDir, "winner_retention_map_report.json");
  await writeJson(mapPath, document);
  await writeJson(reportPath, {
    schema: "goldflow_winner_retention_map_report_v1",
    status: validation.done ? "passed" : "blocked",
    channel,
    development_slug: loaded.packageContract.development_slug,
    selected_candidate_id: loaded.packageContract.selected_candidate_id,
    winner_retention_map_path: mapPath,
    winner_retention_map_sha256: await fileSha256(mapPath),
    winner_story_blueprint_path: blueprintLoaded.blueprintPath,
    winner_story_blueprint_sha256: blueprintLoaded.blueprintSha256,
    winner_package_path: loaded.packagePath,
    winner_package_sha256: loaded.packageSha256,
    prompt_path: promptPath,
    prompt_sha256: sha256Text(prompt),
    model: response.model ?? "external_response",
    provider: response.provider ?? "external_response",
    reasoning_effort: response.reasoning_effort ?? null,
    source_model_contract: response.source_model_contract,
    blockers: validation.blockers,
    updated_at: new Date().toISOString(),
  });
  console.log(JSON.stringify({
    status: validation.done ? "passed" : "blocked",
    retention_map_path: mapPath,
    report_path: reportPath,
    blockers: validation.blockers,
    next_required_action: validation.done
      ? "goldflow source opening"
      : "repair or regenerate only the retention map",
  }, null, 2));
  if (!validation.done) throw new Error(`Winner retention map is blocked: ${validation.blockers.join(", ")}`);
}

async function loadRetentionMap(developmentDir, loadedPackage, blueprintLoaded) {
  const mapPath = path.resolve(flags["retention-map"] ?? path.join(developmentDir, "winner_retention_map.json"));
  const reportPath = path.resolve(flags["retention-map-report"] ?? path.join(developmentDir, "winner_retention_map_report.json"));
  const document = await readJson(mapPath);
  const mapSha256 = await fileSha256(mapPath);
  const validation = validateWinnerRetentionMap(document, {
    blueprint: blueprintLoaded.blueprintDocument,
    blueprintSha256: blueprintLoaded.blueprintSha256,
    packageContract: loadedPackage.packageContract,
    packageSha256: loadedPackage.packageSha256,
  });
  if (!validation.done) throw new Error(`Winner retention map is invalid: ${validation.blockers.join(", ")}`);
  const report = await readJson(reportPath);
  if (report?.status !== "passed" || report?.winner_retention_map_sha256 !== mapSha256) {
    throw new Error("Winner retention map report is missing or stale.");
  }
  return { mapPath, mapSha256, document, reportPath, report };
}

async function opening() {
  const developmentDir = developmentDirectory();
  const loaded = await loadApprovedPackage(developmentDir);
  if (!usesRetentionDramaRoom(loaded.packageContract)) {
    throw new Error("source opening is available only for retention_drama_room_v1 packages.");
  }
  const blueprintLoaded = await loadApprovedBlueprint(developmentDir, loaded);
  const retentionLoaded = await loadRetentionMap(developmentDir, loaded, blueprintLoaded);
  const template = extractTextPrompt(await fs.readFile(
    path.join(repoRoot, "docs", "prompts", "manhwa_recap_opening_writer_v1.md"),
    "utf8",
  ));
  const prompt = `${template}

BINDING APPROVED WINNER PACKAGE JSON
${JSON.stringify(loaded.packageContract, null, 2)}

BINDING APPROVED STORY BLUEPRINT JSON
${JSON.stringify(blueprintLoaded.blueprintDocument, null, 2)}

BINDING RETENTION MAP JSON
${JSON.stringify(retentionLoaded.document, null, 2)}
`;
  const promptPath = path.join(developmentDir, "winner_opening_prompt.md");
  await fs.writeFile(promptPath, `${prompt.trim()}\n`, "utf8");
  const response = await modelResponse({
    prompt,
    stageName: "winner_opening_generation",
    outputPath: path.join(developmentDir, "winner_opening_response.txt"),
    responsePath: flags["response-path"] ?? null,
    timeoutMs: Number(flags["timeout-ms"] ?? 1_800_000),
  });
  const review = reviewWinnerOpening(response.content, loaded.packageContract, {
    retentionMapSha256: retentionLoaded.mapSha256,
    blueprintSha256: blueprintLoaded.blueprintSha256,
  });
  const openingPath = path.join(developmentDir, "winner_opening.md");
  await fs.writeFile(openingPath, review.normalized_opening, "utf8");
  const { normalized_opening: ignored, ...reviewReport } = review;
  void ignored;
  const reportPath = path.join(developmentDir, "winner_opening_report.json");
  await writeJson(reportPath, {
    ...reviewReport,
    channel,
    development_slug: loaded.packageContract.development_slug,
    selected_candidate_id: loaded.packageContract.selected_candidate_id,
    opening_path: openingPath,
    opening_sha256: await fileSha256(openingPath),
    winner_package_sha256: loaded.packageSha256,
    winner_story_blueprint_path: blueprintLoaded.blueprintPath,
    winner_retention_map_path: retentionLoaded.mapPath,
    prompt_path: promptPath,
    prompt_sha256: sha256Text(prompt),
    model: response.model ?? "external_response",
    provider: response.provider ?? "external_response",
    reasoning_effort: response.reasoning_effort ?? null,
    source_model_contract: response.source_model_contract,
    updated_at: new Date().toISOString(),
  });
  console.log(JSON.stringify({
    status: review.status,
    opening_path: openingPath,
    opening_sha256: await fileSha256(openingPath),
    opening_word_count: review.opening_word_count,
    report_path: reportPath,
    blockers: review.blockers,
    warnings: review.warnings,
    next_required_action: review.status === "passed"
      ? "operator or delegated agent reviews the five-minute opening, then runs source approve-opening"
      : "repair or regenerate only the five-minute opening",
  }, null, 2));
  if (review.status !== "passed") throw new Error(`Winner opening is blocked: ${review.blockers.join(", ")}`);
}

async function approveOpening() {
  if (!isTrue(flags.approve)) throw new Error("Winner opening approval requires --approve true.");
  const approvedBy = required(flags["approved-by"], "--approved-by <operator-or-agent>");
  const developmentDir = developmentDirectory();
  const loaded = await loadApprovedPackage(developmentDir);
  const blueprintLoaded = await loadApprovedBlueprint(developmentDir, loaded);
  const retentionLoaded = await loadRetentionMap(developmentDir, loaded, blueprintLoaded);
  const openingPath = path.resolve(flags.opening ?? path.join(developmentDir, "winner_opening.md"));
  const reportPath = path.resolve(flags["opening-report"] ?? path.join(developmentDir, "winner_opening_report.json"));
  const openingText = normalizeWinnerNarration(await fs.readFile(openingPath, "utf8"));
  const openingSha256 = sha256Text(openingText);
  const report = await readJson(reportPath);
  if (report?.status !== "passed" || report?.opening_sha256 !== openingSha256) {
    throw new Error("Winner opening report is missing or stale.");
  }
  if (report.winner_retention_map_sha256 !== retentionLoaded.mapSha256
    || report.winner_story_blueprint_sha256 !== blueprintLoaded.blueprintSha256) {
    throw new Error("Winner opening report is stale for the current retention map or blueprint.");
  }
  const approval = {
    schema: WINNER_OPENING_APPROVAL_SCHEMA,
    status: "approved",
    channel: loaded.packageContract.channel,
    development_slug: loaded.packageContract.development_slug,
    selected_candidate_id: loaded.packageContract.selected_candidate_id,
    opening_path: openingPath,
    opening_sha256: openingSha256,
    winner_retention_map_sha256: retentionLoaded.mapSha256,
    winner_story_blueprint_sha256: blueprintLoaded.blueprintSha256,
    approved_by: approvedBy,
    approved_at: new Date().toISOString(),
    approval_scope: "exact_first_five_minutes_and_endpoint_state",
  };
  const validation = validateWinnerOpeningApproval(approval, {
    openingSha256,
    retentionMapSha256: retentionLoaded.mapSha256,
    blueprintSha256: blueprintLoaded.blueprintSha256,
  });
  if (!validation.done) throw new Error(`Winner opening approval is invalid: ${validation.blockers.join(", ")}`);
  const approvalPath = path.join(developmentDir, "winner_opening_approval.json");
  await writeJson(approvalPath, approval);
  console.log(JSON.stringify({
    status: "approved",
    opening_path: openingPath,
    opening_sha256: openingSha256,
    approval_path: approvalPath,
    next_required_action: "goldflow source script",
  }, null, 2));
}

async function loadApprovedOpening(developmentDir, loadedPackage, blueprintLoaded, retentionLoaded) {
  const openingPath = path.resolve(flags.opening ?? path.join(developmentDir, "winner_opening.md"));
  const approvalPath = path.resolve(flags["opening-approval"] ?? path.join(developmentDir, "winner_opening_approval.json"));
  const openingText = normalizeWinnerNarration(await fs.readFile(openingPath, "utf8"));
  const openingSha256 = sha256Text(openingText);
  const approval = await readJson(approvalPath);
  const validation = validateWinnerOpeningApproval(approval, {
    openingSha256,
    retentionMapSha256: retentionLoaded.mapSha256,
    blueprintSha256: blueprintLoaded.blueprintSha256,
  });
  if (!validation.done) throw new Error(`Winner opening approval is missing or stale: ${validation.blockers.join(", ")}`);
  if (approval.selected_candidate_id !== loadedPackage.packageContract.selected_candidate_id) {
    throw new Error("Winner opening approval candidate mismatch.");
  }
  return { openingPath, openingSha256, openingText, approvalPath, approval };
}

function fillScriptTemplate(template, packageContract) {
  const thumbnail = packageContract.thumbnail_contract ?? {};
  const mechanic = packageContract.core_advantage ?? {};
  const thumbnailPromise = [
    `Exact main text: ${thumbnail.main_text}.`,
    `Dominant proof: ${thumbnail.dominant_proof}.`,
    `Betrayal signal: ${thumbnail.betrayal_signal}.`,
    `Reversal signal: ${thumbnail.reversal_signal}.`,
    `Additive fact: ${thumbnail.additive_fact}.`,
  ].join(" ");
  const mechanicRules = [
    `Type: ${mechanic.type}.`,
    `Post-betrayal connection: ${mechanic.post_betrayal_connection}.`,
    `Source or activation: ${mechanic.source_or_activation}.`,
    `Core capability: ${mechanic.core_capability}.`,
    `Growth or compounding rule: ${mechanic.growth_or_compounding_rule}.`,
    `Execution bridge: ${mechanic.execution_bridge}.`,
    `First visible proof: ${mechanic.first_visible_proof}.`,
    `Decisive application examples: ${JSON.stringify(mechanic.decisive_applications ?? [])}.`,
    `Causal scale path: ${mechanic.causal_scale_path}.`,
    mechanic.optional_constraints_or_risks
      ? `True constraints or risks, if any: ${mechanic.optional_constraints_or_risks}.`
      : null,
  ].filter(Boolean).join(" ");
  const range = `${packageContract.target_word_range.minimum} to ${packageContract.target_word_range.maximum} spoken words`;
  return template
    .replace("[INSERT TITLE]", packageContract.selected_title)
    .replace("[INSERT ADDITIVE THUMBNAIL TEXT OR VISUAL JUDGMENT THAT DOES NOT REPEAT THE TITLE]", thumbnailPromise)
    .replace("[INSERT PREMISE]", packageContract.premise)
    .replace("[INSERT THE NON-NEGOTIABLE ACQUISITION, CAPABILITY, SCALING RULE, EXECUTION BRIDGE, DECISIVE APPLICATIONS, CAUSAL SCALE PATH, AND ANY TRUE CONSTRAINTS]", mechanicRules)
    .replace("[INSERT MINIMUM AND MAXIMUM WORDS]", range)
    .replace("[INSERT TARGET WPM]", String(packageContract.intended_spoken_wpm))
    .replace("[INSERT DIRECT WINNER, CONVERSATIONAL WINNER, MARKET MEDIAN, OR A CUSTOM PROFILE]", packageContract.narration_profile)
    .replace("[INSERT REQUIREMENT OR WRITE COMPLETE STANDALONE ENDING]", packageContract.ending_requirement);
}

function lightScriptStoryBrief(packageContract) {
  const story = packageContract.story_contract ?? {};
  return {
    title_truth: packageContract.title_contract,
    thumbnail_truth: {
      main_text: packageContract.thumbnail_contract?.main_text,
      dominant_proof: packageContract.thumbnail_contract?.dominant_proof,
      additive_fact: packageContract.thumbnail_contract?.additive_fact,
    },
    first_meaningful_choice: story.boundary_by_minute_5,
    continuing_conflict_options: story.middle_engine,
    escalation_pressure: story.escalation_pressure,
    antagonist_adaptation: story.antagonist_adaptation,
    active_climax: story.climax,
    final_boundary: story.final_boundary,
  };
}

async function script() {
  const developmentDir = developmentDirectory();
  const { formula, formulaSha256 } = await readFormula();
  const loaded = await loadApprovedPackage(developmentDir);
  const blueprintLoaded = await loadApprovedBlueprint(developmentDir, loaded);
  if (loaded.packageContract.formula_sha256 !== formulaSha256) throw new Error("Approved winner package formula hash is stale.");
  const dramaRoomEnabled = usesRetentionDramaRoom(loaded.packageContract);
  let retentionLoaded = null;
  let openingLoaded = null;
  let prompt;
  let writerTemplateName;
  if (dramaRoomEnabled) {
    retentionLoaded = await loadRetentionMap(developmentDir, loaded, blueprintLoaded);
    openingLoaded = await loadApprovedOpening(developmentDir, loaded, blueprintLoaded, retentionLoaded);
    writerTemplateName = "manhwa_recap_longform_writer_v7.md";
    const template = extractTextPrompt(await fs.readFile(path.join(repoRoot, "docs", "prompts", writerTemplateName), "utf8"));
    const openingWords = reviewWinnerOpening(openingLoaded.openingText, loaded.packageContract).opening_word_count;
    const continuationRange = {
      minimum: Math.max(500, Number(loaded.packageContract.target_word_range.minimum) - openingWords),
      maximum: Math.max(700, Number(loaded.packageContract.target_word_range.maximum) - openingWords),
    };
    prompt = `${template}

TARGET CONTINUATION WORD RANGE
${continuationRange.minimum} to ${continuationRange.maximum} spoken words. This excludes the locked opening below.

BINDING APPROVED WINNER PACKAGE JSON
${JSON.stringify(loaded.packageContract, null, 2)}

BINDING APPROVED STORY BLUEPRINT JSON
${JSON.stringify(blueprintLoaded.blueprintDocument, null, 2)}

BINDING RETENTION MAP JSON
${JSON.stringify(retentionLoaded.document, null, 2)}

EXACT APPROVED FIVE-MINUTE OPENING
This is immutable context. Begin after its final state and do not output any of these words again.
${openingLoaded.openingText}
`;
  } else {
    writerTemplateName = "manhwa_recap_chatbot_prompt_v6_light.md";
    const template = extractTextPrompt(await fs.readFile(path.join(repoRoot, "docs", "prompts", writerTemplateName), "utf8"));
    prompt = `${fillScriptTemplate(template, loaded.packageContract)}

LIGHT STORY TRUTH NOTES
These notes protect the approved click promise. They are not a beat sheet, checklist, chapter plan, or exact timing grid. Use them naturally and compress anything that does not keep the story moving.
${JSON.stringify(lightScriptStoryBrief(loaded.packageContract), null, 2)}

BINDING APPROVED STORY BLUEPRINT
This blueprint locks story truth, POV, tense, canon, causal movement, climax, and ending. Write natural continuous narration inside it. Do not print its headings, IDs, JSON fields, word budgets, or planning language in the script.
${JSON.stringify(blueprintLoaded.blueprintDocument, null, 2)}
`;
  }
  const promptPath = path.join(developmentDir, "winner_script_prompt.md");
  await fs.writeFile(promptPath, `${prompt.trim()}\n`, "utf8");
  const response = await modelResponse({
    prompt,
    stageName: dramaRoomEnabled ? "winner_script_generation_v7" : "winner_script_generation",
    outputPath: path.join(developmentDir, "winner_script_response.txt"),
    responsePath: flags["response-path"] ?? null,
    timeoutMs: Number(flags["timeout-ms"] ?? 2_400_000),
  });
  const normalizedScript = dramaRoomEnabled
    ? assembleWinnerScriptWithApprovedOpening(openingLoaded.openingText, response.content)
    : normalizeWinnerNarration(response.content);
  const scriptPath = path.join(developmentDir, "script_candidate.md");
  await fs.writeFile(scriptPath, normalizedScript, "utf8");
  const deterministic = deterministicWinnerScriptReview(normalizedScript, loaded.packageContract, {
    blueprint: blueprintLoaded.blueprintDocument,
  });
  const { normalized_script: ignored, ...deterministicReport } = deterministic;
  void ignored;
  const report = {
    schema: WINNER_SCRIPT_GENERATION_REPORT_SCHEMA,
    status: deterministic.status,
    channel,
    development_slug: loaded.packageContract.development_slug,
    selected_candidate_id: loaded.packageContract.selected_candidate_id,
    selected_title: loaded.packageContract.selected_title,
    source_script_path: scriptPath,
    source_script_sha256: deterministic.source_script_sha256,
    source_word_count: deterministic.source_word_count,
    winner_package_path: loaded.packagePath,
    winner_package_sha256: loaded.packageSha256,
    winner_story_blueprint_path: blueprintLoaded.blueprintPath,
    winner_story_blueprint_sha256: blueprintLoaded.blueprintSha256,
    winner_story_blueprint_approval_path: blueprintLoaded.approvalPath,
    winner_retention_map_path: retentionLoaded?.mapPath ?? null,
    winner_retention_map_sha256: retentionLoaded?.mapSha256 ?? null,
    winner_opening_path: openingLoaded?.openingPath ?? null,
    winner_opening_sha256: openingLoaded?.openingSha256 ?? null,
    winner_opening_approval_path: openingLoaded?.approvalPath ?? null,
    source_workflow_profile: loaded.packageContract.source_workflow_profile ?? "legacy_single_draft_v1",
    formula_path: formulaPath,
    formula_sha256: formulaSha256,
    prompt_path: promptPath,
    prompt_sha256: sha256Text(prompt),
    writer_template: writerTemplateName,
    model: response.model ?? "external_response",
    provider: response.provider ?? "external_response",
    reasoning_effort: response.reasoning_effort ?? null,
    source_model_contract: response.source_model_contract,
    deterministic_review: deterministicReport,
    updated_at: new Date().toISOString(),
  };
  const reportPath = path.join(developmentDir, "winner_script_generation_report.json");
  await writeJson(reportPath, report);
  console.log(JSON.stringify({
    status: report.status,
    script_path: scriptPath,
    script_sha256: report.source_script_sha256,
    source_word_count: report.source_word_count,
    report_path: reportPath,
    blockers: report.deterministic_review.blockers,
    next_required_action: report.status === "passed"
      ? dramaRoomEnabled
        ? "goldflow source diagnose"
        : "operator reviews the exact script; optional: goldflow source audit; release when approved"
      : "the response appears structurally truncated; regenerate or supply a complete candidate",
  }, null, 2));
  if (report.status !== "passed") throw new Error(`Winner script generation is blocked: ${report.deterministic_review.blockers.join(", ")}`);
}

async function loadGeneratedScriptCandidate(developmentDir, loadedPackage) {
  const scriptPath = path.join(developmentDir, "script_candidate.md");
  const scriptText = normalizeWinnerNarration(await fs.readFile(scriptPath, "utf8"));
  const generationReportPath = path.resolve(flags["generation-report"] ?? path.join(developmentDir, "winner_script_generation_report.json"));
  const generationReport = await readJson(generationReportPath);
  if (generationReport?.schema !== WINNER_SCRIPT_GENERATION_REPORT_SCHEMA || generationReport?.status !== "passed") {
    throw new Error("Winner script generation report is missing or not passed.");
  }
  let blueprintLoaded = null;
  let retentionLoaded = null;
  let openingLoaded = null;
  if (generationReport.winner_story_blueprint_sha256) {
    blueprintLoaded = await loadApprovedBlueprint(developmentDir, loadedPackage);
    if (generationReport.winner_story_blueprint_sha256 !== blueprintLoaded.blueprintSha256) {
      throw new Error("Winner script generation report is stale for the current story blueprint.");
    }
  }
  if (usesRetentionDramaRoom(loadedPackage.packageContract)) {
    retentionLoaded = await loadRetentionMap(developmentDir, loadedPackage, blueprintLoaded);
    openingLoaded = await loadApprovedOpening(
      developmentDir,
      loadedPackage,
      blueprintLoaded,
      retentionLoaded,
    );
    if (generationReport.winner_retention_map_sha256 !== retentionLoaded.mapSha256
      || generationReport.winner_opening_sha256 !== openingLoaded.openingSha256) {
      throw new Error("Winner script generation report is stale for the current retention map or opening.");
    }
    if (!scriptText.startsWith(openingLoaded.openingText.trim())) {
      throw new Error("Winner script candidate does not preserve the approved opening bytes.");
    }
  }
  const review = deterministicWinnerScriptReview(scriptText, loadedPackage.packageContract, {
    blueprint: blueprintLoaded?.blueprintDocument ?? null,
  });
  if (review.status !== "passed") throw new Error(`Current script fails deterministic review: ${review.blockers.join(", ")}`);
  if (generationReport.source_script_sha256 !== review.source_script_sha256) throw new Error("Winner script generation report is stale for the current script.");
  if (generationReport.winner_package_sha256 !== loadedPackage.packageSha256) throw new Error("Winner script generation report is stale for the current package.");
  return {
    scriptPath,
    scriptText,
    scriptSha256: review.source_script_sha256,
    scriptWordCount: review.source_word_count,
    generationReportPath,
    generationReport,
    blueprintLoaded,
    retentionLoaded,
    openingLoaded,
  };
}

async function loadRevisionArtifact(reportPath, expectedStage, baseScript) {
  const report = await readJson(reportPath);
  const sourcePath = path.resolve(report.source_script_path ?? "");
  const outputPath = path.resolve(report.output_script_path ?? "");
  const sourceText = normalizeWinnerNarration(await fs.readFile(sourcePath, "utf8"));
  const outputText = normalizeWinnerNarration(await fs.readFile(outputPath, "utf8"));
  const sourceSha256 = sha256Text(sourceText);
  const outputSha256 = sha256Text(outputText);
  const validation = validateWinnerRevisionReport(report, {
    expectedStage,
    sourceScriptSha256: sourceSha256,
    outputScriptSha256: outputSha256,
    openingSha256: baseScript.openingLoaded?.openingSha256 ?? null,
  });
  if (!validation.done) throw new Error(`Winner ${expectedStage} report is invalid: ${validation.blockers.join(", ")}`);
  if (report.winner_story_blueprint_sha256 !== baseScript.blueprintLoaded?.blueprintSha256
    || report.winner_retention_map_sha256 !== baseScript.retentionLoaded?.mapSha256) {
    throw new Error(`Winner ${expectedStage} report is stale for the current blueprint or retention map.`);
  }
  if (!outputText.startsWith(baseScript.openingLoaded.openingText.trim())) {
    throw new Error(`Winner ${expectedStage} output changed the approved opening.`);
  }
  return {
    reportPath,
    report,
    sourcePath,
    sourceText,
    sourceSha256,
    outputPath,
    outputText,
    outputSha256,
  };
}

async function loadCurrentScript(developmentDir, loadedPackage) {
  const baseScript = await loadGeneratedScriptCandidate(developmentDir, loadedPackage);
  if (!usesRetentionDramaRoom(loadedPackage.packageContract)) return baseScript;

  const revisionReportPath = path.join(developmentDir, "winner_integrated_revision_report.json");
  const polishReportPath = path.join(developmentDir, "winner_line_flow_polish_report.json");
  let revision = null;
  let polish = null;
  if (await exists(revisionReportPath)) {
    revision = await loadRevisionArtifact(revisionReportPath, "integrated_revision", baseScript);
    if (revision.sourceSha256 !== baseScript.scriptSha256) {
      throw new Error("Winner integrated revision is stale for the generated script candidate.");
    }
  }
  if (await exists(polishReportPath)) {
    if (!revision) throw new Error("Winner line-flow polish exists without a current integrated revision.");
    polish = await loadRevisionArtifact(polishReportPath, "line_flow_polish", baseScript);
    if (polish.sourceSha256 !== revision.outputSha256) {
      throw new Error("Winner line-flow polish is stale for the integrated revision.");
    }
  }

  let selected = polish ?? revision ?? null;
  if (flags.script) {
    const requestedPath = path.resolve(flags.script);
    if (requestedPath === baseScript.scriptPath) selected = null;
    else if (polish && requestedPath === polish.outputPath) selected = polish;
    else if (revision && requestedPath === revision.outputPath) selected = revision;
    else throw new Error("--script must name the current candidate, integrated revision, or line-flow polish artifact.");
  }
  if (!selected) return baseScript;
  const review = deterministicWinnerScriptReview(selected.outputText, loadedPackage.packageContract, {
    blueprint: baseScript.blueprintLoaded.blueprintDocument,
  });
  if (review.status !== "passed") throw new Error(`Current winner script fails deterministic review: ${review.blockers.join(", ")}`);
  return {
    ...baseScript,
    scriptPath: selected.outputPath,
    scriptText: selected.outputText,
    scriptSha256: selected.outputSha256,
    scriptWordCount: review.source_word_count,
    currentStageReportPath: selected.reportPath,
    currentStageReport: selected.report,
  };
}

async function diagnose() {
  const developmentDir = developmentDirectory();
  const loaded = await loadApprovedPackage(developmentDir);
  if (!usesRetentionDramaRoom(loaded.packageContract)) {
    throw new Error("source diagnose is available only for retention_drama_room_v1 packages.");
  }
  const currentScript = await loadGeneratedScriptCandidate(developmentDir, loaded);
  const promptByPass = {
    causal_flow: "manhwa_recap_causal_flow_diagnostic_v1.md",
    emotional_drama: "manhwa_recap_emotional_drama_diagnostic_v1.md",
    retention_repetition: "manhwa_recap_retention_repetition_diagnostic_v1.md",
  };
  const reports = [];
  for (const passId of WINNER_DIAGNOSTIC_PASS_IDS) {
    const template = extractTextPrompt(await fs.readFile(
      path.join(repoRoot, "docs", "prompts", promptByPass[passId]),
      "utf8",
    ));
    const prompt = `${template}

BINDING APPROVED WINNER PACKAGE JSON
${JSON.stringify(loaded.packageContract, null, 2)}

BINDING APPROVED STORY BLUEPRINT JSON
${JSON.stringify(currentScript.blueprintLoaded.blueprintDocument, null, 2)}

BINDING RETENTION MAP JSON
${JSON.stringify(currentScript.retentionLoaded.document, null, 2)}

EXACT SCRIPT TO DIAGNOSE
${currentScript.scriptText}
`;
    const promptPath = path.join(developmentDir, `winner_diagnostic_${passId}_prompt.md`);
    await fs.writeFile(promptPath, `${prompt.trim()}\n`, "utf8");
    const response = await modelResponse({
      prompt,
      stageName: `winner_diagnostic_${passId}`,
      outputPath: path.join(developmentDir, `winner_diagnostic_${passId}_response.txt`),
      responsePath: flags[`${passId.replaceAll("_", "-")}-response-path`] ?? null,
      timeoutMs: Number(flags["timeout-ms"] ?? 1_800_000),
    });
    const draft = extractJsonObject(response.content);
    const document = {
      ...draft,
      schema: WINNER_DEVELOPMENT_DIAGNOSTIC_SCHEMA,
      status: "completed",
      pass_id: passId,
      channel,
      development_slug: loaded.packageContract.development_slug,
      selected_candidate_id: loaded.packageContract.selected_candidate_id,
      source_script_path: currentScript.scriptPath,
      source_script_sha256: currentScript.scriptSha256,
      winner_package_sha256: loaded.packageSha256,
      winner_story_blueprint_sha256: currentScript.blueprintLoaded.blueprintSha256,
      winner_retention_map_sha256: currentScript.retentionLoaded.mapSha256,
      source_model_contract: response.source_model_contract,
      diagnosed_at: new Date().toISOString(),
    };
    const validation = validateWinnerDevelopmentDiagnostic(document, {
      passId,
      sourceScriptSha256: currentScript.scriptSha256,
      scriptText: currentScript.scriptText,
    });
    document.validation = validation;
    const reportPath = path.join(developmentDir, `winner_diagnostic_${passId}.json`);
    await writeJson(reportPath, document);
    if (!validation.done) {
      throw new Error(`Winner ${passId} diagnostic is invalid: ${validation.blockers.join(", ")}`);
    }
    reports.push({
      pass_id: passId,
      decision: document.decision,
      report_path: reportPath,
      report_sha256: await fileSha256(reportPath),
      finding_count: Array.isArray(document.findings) ? document.findings.length : 0,
      high_priority_finding_count: (document.findings ?? []).filter((row) => row.priority === "high").length,
      warnings: validation.warnings,
    });
  }
  const manifestPath = path.join(developmentDir, "winner_development_diagnostics_manifest.json");
  await writeJson(manifestPath, {
    schema: "goldflow_winner_development_diagnostics_manifest_v1",
    status: "passed",
    source_workflow_profile: WINNER_SOURCE_ROOM_PROFILE,
    channel,
    development_slug: loaded.packageContract.development_slug,
    selected_candidate_id: loaded.packageContract.selected_candidate_id,
    source_script_path: currentScript.scriptPath,
    source_script_sha256: currentScript.scriptSha256,
    winner_package_sha256: loaded.packageSha256,
    winner_story_blueprint_sha256: currentScript.blueprintLoaded.blueprintSha256,
    winner_retention_map_sha256: currentScript.retentionLoaded.mapSha256,
    reports,
    completed_at: new Date().toISOString(),
  });
  console.log(JSON.stringify({
    status: "passed",
    source_script_sha256: currentScript.scriptSha256,
    diagnostics_manifest_path: manifestPath,
    reports,
    next_required_action: "goldflow source revise",
  }, null, 2));
}

async function loadDiagnostics(developmentDir, currentScript) {
  const manifestPath = path.resolve(flags["diagnostics-manifest"]
    ?? path.join(developmentDir, "winner_development_diagnostics_manifest.json"));
  const manifest = await readJson(manifestPath);
  if (manifest?.status !== "passed" || manifest?.source_script_sha256 !== currentScript.scriptSha256) {
    throw new Error("Winner development diagnostics manifest is missing or stale.");
  }
  const reports = [];
  for (const passId of WINNER_DIAGNOSTIC_PASS_IDS) {
    const row = (manifest.reports ?? []).find((item) => item.pass_id === passId);
    if (!row) throw new Error(`Winner diagnostics manifest is missing ${passId}.`);
    const document = await readJson(row.report_path);
    const reportSha256 = await fileSha256(row.report_path);
    const validation = validateWinnerDevelopmentDiagnostic(document, {
      passId,
      sourceScriptSha256: currentScript.scriptSha256,
      scriptText: currentScript.scriptText,
    });
    if (!validation.done || reportSha256 !== row.report_sha256) {
      throw new Error(`Winner ${passId} diagnostic is missing, invalid, or stale.`);
    }
    reports.push({ path: row.report_path, sha256: reportSha256, document });
  }
  return { manifestPath, manifestSha256: await fileSha256(manifestPath), manifest, reports };
}

async function revise() {
  const developmentDir = developmentDirectory();
  const loaded = await loadApprovedPackage(developmentDir);
  if (!usesRetentionDramaRoom(loaded.packageContract)) {
    throw new Error("source revise is available only for retention_drama_room_v1 packages.");
  }
  const currentScript = await loadGeneratedScriptCandidate(developmentDir, loaded);
  const diagnostics = await loadDiagnostics(developmentDir, currentScript);
  const template = extractTextPrompt(await fs.readFile(
    path.join(repoRoot, "docs", "prompts", "manhwa_recap_integrated_revision_v1.md"),
    "utf8",
  ));
  const prompt = `${template}

BINDING APPROVED WINNER PACKAGE JSON
${JSON.stringify(loaded.packageContract, null, 2)}

BINDING APPROVED STORY BLUEPRINT JSON
${JSON.stringify(currentScript.blueprintLoaded.blueprintDocument, null, 2)}

BINDING RETENTION MAP JSON
${JSON.stringify(currentScript.retentionLoaded.document, null, 2)}

EXACT APPROVED FIVE-MINUTE OPENING
This is immutable. Do not output it.
${currentScript.openingLoaded.openingText}

SPECIALIST DIAGNOSTIC REPORTS JSON
${JSON.stringify(diagnostics.reports.map((row) => row.document), null, 2)}

EXACT FULL SCRIPT TO REVISE
Return only the revised continuation after the approved opening.
${currentScript.scriptText}
`;
  const promptPath = path.join(developmentDir, "winner_integrated_revision_prompt.md");
  await fs.writeFile(promptPath, `${prompt.trim()}\n`, "utf8");
  const response = await modelResponse({
    prompt,
    stageName: "winner_integrated_revision",
    outputPath: path.join(developmentDir, "winner_integrated_revision_response.txt"),
    responsePath: flags["response-path"] ?? null,
    timeoutMs: Number(flags["timeout-ms"] ?? 2_400_000),
  });
  const revisedText = assembleWinnerScriptWithApprovedOpening(
    currentScript.openingLoaded.openingText,
    response.content,
  );
  const outputPath = path.join(developmentDir, "script_revised.md");
  await fs.writeFile(outputPath, revisedText, "utf8");
  const deterministic = deterministicWinnerScriptReview(revisedText, loaded.packageContract, {
    blueprint: currentScript.blueprintLoaded.blueprintDocument,
  });
  const reportPath = path.join(developmentDir, "winner_integrated_revision_report.json");
  const report = {
    schema: WINNER_REVISION_REPORT_SCHEMA,
    status: deterministic.status,
    stage: "integrated_revision",
    source_workflow_profile: WINNER_SOURCE_ROOM_PROFILE,
    source_script_path: currentScript.scriptPath,
    source_script_sha256: currentScript.scriptSha256,
    output_script_path: outputPath,
    output_script_sha256: sha256Text(revisedText),
    output_word_count: deterministic.source_word_count,
    approved_opening_sha256: currentScript.openingLoaded.openingSha256,
    winner_package_sha256: loaded.packageSha256,
    winner_story_blueprint_sha256: currentScript.blueprintLoaded.blueprintSha256,
    winner_retention_map_sha256: currentScript.retentionLoaded.mapSha256,
    diagnostics_manifest_path: diagnostics.manifestPath,
    diagnostics_manifest_sha256: diagnostics.manifestSha256,
    prompt_path: promptPath,
    prompt_sha256: sha256Text(prompt),
    model: response.model ?? "external_response",
    provider: response.provider ?? "external_response",
    reasoning_effort: response.reasoning_effort ?? null,
    source_model_contract: response.source_model_contract,
    deterministic_review: {
      blockers: deterministic.blockers,
      warnings: deterministic.warnings,
    },
    completed_at: new Date().toISOString(),
  };
  await writeJson(reportPath, report);
  if (deterministic.status !== "passed") {
    throw new Error(`Winner integrated revision is blocked: ${deterministic.blockers.join(", ")}`);
  }
  const validation = validateWinnerRevisionReport(report, {
    expectedStage: "integrated_revision",
    sourceScriptSha256: currentScript.scriptSha256,
    outputScriptSha256: sha256Text(revisedText),
    openingSha256: currentScript.openingLoaded.openingSha256,
  });
  if (!validation.done) throw new Error(`Winner integrated revision report is invalid: ${validation.blockers.join(", ")}`);
  console.log(JSON.stringify({
    status: "passed",
    script_path: outputPath,
    script_sha256: sha256Text(revisedText),
    source_word_count: deterministic.source_word_count,
    report_path: reportPath,
    warnings: deterministic.warnings,
    next_required_action: "goldflow source polish",
  }, null, 2));
}

async function polish() {
  const developmentDir = developmentDirectory();
  const loaded = await loadApprovedPackage(developmentDir);
  if (!usesRetentionDramaRoom(loaded.packageContract)) {
    throw new Error("source polish is available only for retention_drama_room_v1 packages.");
  }
  const baseScript = await loadGeneratedScriptCandidate(developmentDir, loaded);
  const revisionReportPath = path.join(developmentDir, "winner_integrated_revision_report.json");
  const revision = await loadRevisionArtifact(revisionReportPath, "integrated_revision", baseScript);
  if (revision.sourceSha256 !== baseScript.scriptSha256) {
    throw new Error("Winner integrated revision is stale for the generated script candidate.");
  }
  const template = extractTextPrompt(await fs.readFile(
    path.join(repoRoot, "docs", "prompts", "manhwa_recap_line_flow_polish_v1.md"),
    "utf8",
  ));
  const prompt = `${template}

BINDING APPROVED WINNER PACKAGE JSON
${JSON.stringify(loaded.packageContract, null, 2)}

BINDING APPROVED STORY BLUEPRINT JSON
${JSON.stringify(baseScript.blueprintLoaded.blueprintDocument, null, 2)}

BINDING RETENTION MAP JSON
${JSON.stringify(baseScript.retentionLoaded.document, null, 2)}

EXACT APPROVED FIVE-MINUTE OPENING
This is immutable. Do not output it.
${baseScript.openingLoaded.openingText}

EXACT FULL REVISED SCRIPT TO POLISH
Return only the polished continuation after the approved opening.
${revision.outputText}
`;
  const promptPath = path.join(developmentDir, "winner_line_flow_polish_prompt.md");
  await fs.writeFile(promptPath, `${prompt.trim()}\n`, "utf8");
  const response = await modelResponse({
    prompt,
    stageName: "winner_line_flow_polish",
    outputPath: path.join(developmentDir, "winner_line_flow_polish_response.txt"),
    responsePath: flags["response-path"] ?? null,
    timeoutMs: Number(flags["timeout-ms"] ?? 2_400_000),
  });
  const polishedText = assembleWinnerScriptWithApprovedOpening(
    baseScript.openingLoaded.openingText,
    response.content,
  );
  const outputPath = path.join(developmentDir, "script_final.md");
  await fs.writeFile(outputPath, polishedText, "utf8");
  const deterministic = deterministicWinnerScriptReview(polishedText, loaded.packageContract, {
    blueprint: baseScript.blueprintLoaded.blueprintDocument,
  });
  const reportPath = path.join(developmentDir, "winner_line_flow_polish_report.json");
  const report = {
    schema: WINNER_REVISION_REPORT_SCHEMA,
    status: deterministic.status,
    stage: "line_flow_polish",
    source_workflow_profile: WINNER_SOURCE_ROOM_PROFILE,
    source_script_path: revision.outputPath,
    source_script_sha256: revision.outputSha256,
    output_script_path: outputPath,
    output_script_sha256: sha256Text(polishedText),
    output_word_count: deterministic.source_word_count,
    approved_opening_sha256: baseScript.openingLoaded.openingSha256,
    winner_package_sha256: loaded.packageSha256,
    winner_story_blueprint_sha256: baseScript.blueprintLoaded.blueprintSha256,
    winner_retention_map_sha256: baseScript.retentionLoaded.mapSha256,
    prompt_path: promptPath,
    prompt_sha256: sha256Text(prompt),
    model: response.model ?? "external_response",
    provider: response.provider ?? "external_response",
    reasoning_effort: response.reasoning_effort ?? null,
    source_model_contract: response.source_model_contract,
    deterministic_review: {
      blockers: deterministic.blockers,
      warnings: deterministic.warnings,
    },
    completed_at: new Date().toISOString(),
  };
  await writeJson(reportPath, report);
  if (deterministic.status !== "passed") {
    throw new Error(`Winner line-flow polish is blocked: ${deterministic.blockers.join(", ")}`);
  }
  const validation = validateWinnerRevisionReport(report, {
    expectedStage: "line_flow_polish",
    sourceScriptSha256: revision.outputSha256,
    outputScriptSha256: sha256Text(polishedText),
    openingSha256: baseScript.openingLoaded.openingSha256,
  });
  if (!validation.done) throw new Error(`Winner line-flow polish report is invalid: ${validation.blockers.join(", ")}`);
  console.log(JSON.stringify({
    status: "passed",
    script_path: outputPath,
    script_sha256: sha256Text(polishedText),
    source_word_count: deterministic.source_word_count,
    report_path: reportPath,
    warnings: deterministic.warnings,
    next_required_action: "operator reviews the exact final script; optional: goldflow source audit; then source release",
  }, null, 2));
}

async function audit() {
  const developmentDir = developmentDirectory();
  const { formula, formulaSha256 } = await readFormula();
  const loaded = await loadApprovedPackage(developmentDir);
  const currentScript = await loadCurrentScript(developmentDir, loaded);
  const auditFormula = structuredClone(formula);
  if (usesRetentionDramaRoom(loaded.packageContract)) {
    const movementCount = currentScript.blueprintLoaded?.blueprintDocument?.movements?.length ?? null;
    if (Number.isInteger(movementCount) && movementCount > 0) {
      auditFormula.retention_architecture.movement_count_min = movementCount;
      auditFormula.retention_architecture.movement_count_max = movementCount;
    }
  }
  const gateTemplate = extractTextPrompt(await fs.readFile(path.join(repoRoot, "docs", "prompts", "manhwa_recap_machine_release_gate_v1.md"), "utf8"));
  const prompt = `${gateTemplate}

SCRIPT WORD COUNT
${currentScript.scriptWordCount}

BINDING CHANNEL FORMULA JSON
${JSON.stringify(auditFormula, null, 2)}

BINDING APPROVED WINNER PACKAGE JSON
${JSON.stringify(loaded.packageContract, null, 2)}

BINDING APPROVED STORY BLUEPRINT JSON
${JSON.stringify(currentScript.blueprintLoaded?.blueprintDocument ?? null, null, 2)}

BINDING RETENTION MAP JSON
${JSON.stringify(currentScript.retentionLoaded?.document ?? null, null, 2)}

EXACT SCRIPT TO JUDGE
${currentScript.scriptText}
`;
  const promptPath = path.join(developmentDir, "winner_script_gate_prompt.md");
  await fs.writeFile(promptPath, `${prompt.trim()}\n`, "utf8");
  const response = await modelResponse({
    prompt,
    stageName: "winner_script_retention_review_log",
    outputPath: path.join(developmentDir, "winner_script_gate_response.txt"),
    responsePath: flags["response-path"] ?? null,
    timeoutMs: Number(flags["timeout-ms"] ?? 1_800_000),
  });
  const gateDocument = extractJsonObject(response.content);
  gateDocument.channel = channel;
  gateDocument.development_slug = loaded.packageContract.development_slug;
  gateDocument.selected_candidate_id = loaded.packageContract.selected_candidate_id;
  gateDocument.selected_title = loaded.packageContract.selected_title;
  gateDocument.source_script_path = currentScript.scriptPath;
  gateDocument.source_script_sha256 = currentScript.scriptSha256;
  gateDocument.source_word_count = currentScript.scriptWordCount;
  gateDocument.winner_package_path = loaded.packagePath;
  gateDocument.winner_package_sha256 = loaded.packageSha256;
  gateDocument.formula_path = formulaPath;
  gateDocument.formula_sha256 = formulaSha256;
  gateDocument.judge_model = response.model ?? "external_response";
  gateDocument.judge_reasoning_effort = response.reasoning_effort ?? null;
  gateDocument.source_model_contract = response.source_model_contract;
  gateDocument.judged_at = new Date().toISOString();
  const validation = validateWinnerScriptGate(gateDocument, {
    scriptWordCount: currentScript.scriptWordCount,
    formula: auditFormula,
    intendedSpokenWpm: loaded.packageContract.intended_spoken_wpm,
  });
  gateDocument.validation = validation;
  const gatePath = path.join(developmentDir, "winner_script_gate.json");
  await writeJson(gatePath, gateDocument);
  const reportPath = path.join(developmentDir, "winner_script_gate_report.json");
  await writeJson(reportPath, {
    schema: "goldflow_winner_script_gate_report_v1",
    status: "review_logged",
    blocking: false,
    gate_decision: gateDocument.status,
    structural_validation_done: validation.done,
    blockers: validation.blockers,
    retention_weighted_score: gateDocument.retention_architecture?.weighted_score ?? null,
    source_script_sha256: currentScript.scriptSha256,
    winner_package_sha256: loaded.packageSha256,
    formula_sha256: formulaSha256,
    source_model_contract: response.source_model_contract,
    gate_path: gatePath,
    updated_at: new Date().toISOString(),
  });
  console.log(JSON.stringify({
    status: "review_logged",
    blocking: false,
    review_decision: gateDocument.status,
    retention_weighted_score: gateDocument.retention_architecture?.weighted_score ?? null,
    gate_path: gatePath,
    report_path: reportPath,
    blockers: validation.blockers,
    next_required_action: "operator may inspect or accept these findings; the log never blocks source release",
  }, null, 2));
}

async function release() {
  if (!isTrue(flags.approve)) throw new Error("Winner source release requires --approve true.");
  const releasedBy = required(flags["approved-by"] ?? flags["released-by"], "--approved-by <operator>");
  const developmentDir = developmentDirectory();
  const { formula, formulaSha256 } = await readFormula();
  const loaded = await loadApprovedPackage(developmentDir);
  const currentScript = await loadCurrentScript(developmentDir, loaded);
  const defaultReviewLogPath = path.join(developmentDir, "winner_script_gate.json");
  const requestedReviewLogPath = flags.gate ?? flags.audit ?? null;
  const reviewLogPath = requestedReviewLogPath
    ? path.resolve(requestedReviewLogPath)
    : (await exists(defaultReviewLogPath)) ? defaultReviewLogPath : null;
  let reviewLog = null;
  let reviewLogSha256 = null;
  if (reviewLogPath) {
    reviewLog = await readJson(reviewLogPath);
    reviewLogSha256 = await fileSha256(reviewLogPath);
    if (reviewLog.source_script_sha256 !== currentScript.scriptSha256) {
      reviewLog = null;
      reviewLogSha256 = null;
    }
  }
  const ingestSourcePath = path.join(developmentDir, "ingest_ready_source.md");
  await fs.writeFile(ingestSourcePath, currentScript.scriptText, "utf8");
  const sourceScriptSha256 = sha256Text(normalizeWinnerNarration(await fs.readFile(ingestSourcePath, "utf8")));
  const diagnosticsManifestPath = path.join(developmentDir, "winner_development_diagnostics_manifest.json");
  const integratedRevisionReportPath = path.join(developmentDir, "winner_integrated_revision_report.json");
  const lineFlowPolishReportPath = path.join(developmentDir, "winner_line_flow_polish_report.json");
  const dramaRoomEnabled = usesRetentionDramaRoom(loaded.packageContract);
  const releaseDocument = {
    schema: WINNER_SOURCE_RELEASE_SCHEMA,
    status: "passed",
    channel,
    development_slug: loaded.packageContract.development_slug,
    formula_version: loaded.packageContract.formula_version,
    formula_path: formulaPath,
    formula_sha256: formulaSha256,
    selected_candidate_id: loaded.packageContract.selected_candidate_id,
    selected_title: loaded.packageContract.selected_title,
    source_path: ingestSourcePath,
    source_script_sha256: sourceScriptSha256,
    source_word_count: currentScript.scriptWordCount,
    winner_package_path: loaded.packagePath,
    winner_package_sha256: loaded.packageSha256,
    winner_package_approval_path: loaded.approvalPath,
    winner_package_score: loaded.packageContract.weighted_score,
    source_workflow_profile: loaded.packageContract.source_workflow_profile ?? "legacy_single_draft_v1",
    audience_feedback_contract_version: currentScript.blueprintLoaded?.blueprintDocument?.audience_feedback_contract_version ?? null,
    winner_story_blueprint_path: currentScript.blueprintLoaded?.blueprintPath ?? null,
    winner_story_blueprint_sha256: currentScript.blueprintLoaded?.blueprintSha256 ?? null,
    winner_story_blueprint_approval_path: currentScript.blueprintLoaded?.approvalPath ?? null,
    winner_blueprint_audience_audit_path: currentScript.blueprintLoaded?.auditLoaded?.auditPath ?? null,
    winner_blueprint_audience_audit_sha256: currentScript.blueprintLoaded?.auditLoaded?.auditSha256 ?? null,
    winner_blueprint_audience_audit_decision: currentScript.blueprintLoaded?.auditLoaded?.document?.decision ?? null,
    winner_blueprint_audience_audit_risk_override: currentScript.blueprintLoaded?.approval?.audience_audit_risk_override ?? null,
    winner_retention_map_path: currentScript.retentionLoaded?.mapPath ?? null,
    winner_retention_map_sha256: currentScript.retentionLoaded?.mapSha256 ?? null,
    winner_opening_path: currentScript.openingLoaded?.openingPath ?? null,
    winner_opening_sha256: currentScript.openingLoaded?.openingSha256 ?? null,
    winner_opening_approval_path: currentScript.openingLoaded?.approvalPath ?? null,
    source_review_log_path: reviewLog ? reviewLogPath : null,
    source_review_log_sha256: reviewLogSha256,
    source_review_log_decision: reviewLog?.status ?? null,
    retention_weighted_score: reviewLog?.retention_architecture?.weighted_score ?? null,
    script_generation_report_path: currentScript.generationReportPath,
    script_generation_report_sha256: await fileSha256(currentScript.generationReportPath),
    script_development_report_path: currentScript.currentStageReportPath ?? null,
    script_development_report_sha256: currentScript.currentStageReportPath
      ? await fileSha256(currentScript.currentStageReportPath)
      : null,
    winner_development_diagnostics_manifest_path: dramaRoomEnabled ? diagnosticsManifestPath : null,
    winner_development_diagnostics_manifest_sha256: dramaRoomEnabled
      ? await fileSha256(diagnosticsManifestPath)
      : null,
    winner_integrated_revision_report_path: dramaRoomEnabled ? integratedRevisionReportPath : null,
    winner_integrated_revision_report_sha256: dramaRoomEnabled
      ? await fileSha256(integratedRevisionReportPath)
      : null,
    winner_line_flow_polish_report_path: dramaRoomEnabled ? lineFlowPolishReportPath : null,
    winner_line_flow_polish_report_sha256: dramaRoomEnabled
      ? await fileSha256(lineFlowPolishReportPath)
      : null,
    released_by: releasedBy,
    released_at: new Date().toISOString(),
    approval_scope: dramaRoomEnabled
      ? "operator_approved_exact_title_thumbnail_package_audience_audited_blueprint_retention_map_opening_and_final_script_hashes; fifty_percent_apv_is_an_upload_measurement_target; automated_final_script_criticism_is_review_only"
      : "operator_approved_exact_title_thumbnail_premise_mechanic_blueprint_and_script_hashes; automated_criticism_is_review_only",
  };
  const validation = validateWinnerSourceRelease(releaseDocument, {
    sourceText: currentScript.scriptText,
    packageContract: loaded.packageContract,
  });
  if (!validation.done) throw new Error(`Winner release document is invalid: ${validation.blockers.join(", ")}`);
  const releasePath = path.join(developmentDir, "winner_source_release.json");
  await writeJson(releasePath, releaseDocument);
  console.log(JSON.stringify({
    status: "passed",
    source_path: ingestSourcePath,
    source_script_sha256: sourceScriptSha256,
    selected_title: loaded.packageContract.selected_title,
    winner_release_path: releasePath,
    next_required_action: `goldflow run preflight --channel ${channel} --series <series> --week <stable-run-slug> --episode ep_01 --title \"${loaded.packageContract.selected_title}\" --source \"${ingestSourcePath}\" --winner-release \"${releasePath}\"`,
  }, null, 2));
}

function help() {
  console.log(`Packaging-first winner source workflow

Commands:
  goldflow source research --channel 53rebirth --development-slug <slug> --brief <research-question.md>
  goldflow source ideate --channel 53rebirth --development-slug <slug>
  goldflow source approve-package --channel 53rebirth --development-slug <slug> --candidate-id <id> --approve true --approved-by <operator>
  goldflow source blueprint --channel 53rebirth --development-slug <slug>
  goldflow source blueprint-audit --channel 53rebirth --development-slug <slug>
  goldflow source approve-blueprint --channel 53rebirth --development-slug <slug> --approve true --approved-by <operator-or-agent>
  goldflow source retention-map --channel 53rebirth --development-slug <slug>
  goldflow source opening --channel 53rebirth --development-slug <slug>
  goldflow source approve-opening --channel 53rebirth --development-slug <slug> --approve true --approved-by <operator-or-agent>
  goldflow source script --channel 53rebirth --development-slug <slug>
  goldflow source diagnose --channel 53rebirth --development-slug <slug>
  goldflow source revise --channel 53rebirth --development-slug <slug>
  goldflow source polish --channel 53rebirth --development-slug <slug>
  goldflow source audit --channel 53rebirth --development-slug <slug>   # optional, review-only
  goldflow source release --channel 53rebirth --development-slug <slug> --approve true --approved-by <operator>

Optional diagnostics/testing:
  --formula <path>
  --development-dir <path>
  --response-path <model-output-file>
  ideate brief: --brief <path> or --creative-brief <text>
  ideate context: --stockpile <path> --research-pool <path> --evidence-snapshot <path>
  research: --minimum-citations <count> --timeout-ms <ms>
  ideate only: --draft-response-path <file> --judge-response-path <file>
  diagnose fixtures: --causal-flow-response-path <file> --emotional-drama-response-path <file> --retention-repetition-response-path <file>
  package override: --approve-risk true --risk-reason <operator reason>
  blueprint-audit override at approval: --approve-risk true --risk-reason <operator reason>
`);
}

async function main() {
  if (["help", "--help", "-h"].includes(action)) return help();
  if (action === "research") return research();
  if (action === "ideate") return ideate();
  if (action === "approve-package") return approvePackage();
  if (action === "blueprint") return blueprint();
  if (action === "blueprint-audit") return blueprintAudit();
  if (action === "approve-blueprint") return approveBlueprint();
  if (action === "retention-map") return retentionMap();
  if (action === "opening") return opening();
  if (action === "approve-opening") return approveOpening();
  if (action === "script") return script();
  if (action === "diagnose") return diagnose();
  if (action === "revise") return revise();
  if (action === "polish") return polish();
  if (["audit", "gate"].includes(action)) return audit();
  if (action === "release") return release();
  throw new Error(`Unknown winner source action: ${action}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
