#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  configuredCodexModel,
  configuredCodexReasoningEffort,
  runCodexCli,
} from "./lib/codex-cli-runner.mjs";
import {
  WINNER_IDEATION_SCHEMA,
  WINNER_SCRIPT_GENERATION_REPORT_SCHEMA,
  WINNER_SOURCE_RELEASE_SCHEMA,
  buildWinnerPackageContract,
  deterministicWinnerScriptReview,
  evaluateWinnerIdeation,
  extractJsonObject,
  normalizeWinnerNarration,
  sha256Text,
  validateWinnerFormula,
  validateWinnerPackageContract,
  validateWinnerScriptGate,
  validateWinnerSourceRelease,
} from "./lib/winner-source-contract.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataRoot = process.env.ANIFACTORY_DATA_ROOT || "/Users/joel/AniFactoryData";
const action = process.argv[2] ?? "help";
const flags = parseFlags(process.argv.slice(3));
const channel = String(flags.channel ?? "53rebirth").trim();
const developmentSlug = String(flags["development-slug"] ?? flags.slug ?? "").trim();
const defaultFormulaPath = path.join(repoRoot, "docs", "channel_formulas", "53rebirth_winner_formula_v1.json");
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
  const stockpile = await exists(stockpilePath) ? await readJson(stockpilePath) : null;
  const researchPool = await exists(researchPoolPath) ? await readJson(researchPoolPath) : null;
  const topResearchConcepts = (researchPool?.concepts ?? []).slice(0, 30).map((row) => ({
    id: row.id,
    research_rank: row.research_rank,
    editorial_score: row.editorial_score,
    lane: row.lane,
    title: row.title,
    thumbnail_proof_token: row.thumbnail_proof_token,
    antagonist_concrete_loss: row.antagonist_concrete_loss,
    status: row.status,
    related_stockpile_id: row.related_stockpile_id ?? null,
    disposition_note: row.note ?? null,
  }));
  return {
    stockpilePath: stockpile ? stockpilePath : null,
    stockpileSha256: stockpile ? await fileSha256(stockpilePath) : null,
    researchPoolPath: researchPool ? researchPoolPath : null,
    researchPoolSha256: researchPool ? await fileSha256(researchPoolPath) : null,
    modelContext: {
      stockpile: stockpile ? {
        ranking_rule: stockpile.ranking_rule,
        active: stockpile.active ?? [],
        pending_research: stockpile.pending_research ?? [],
        rejected: stockpile.rejected ?? [],
        research_dispositions: stockpile.research_dispositions ?? [],
      } : null,
      ranked_research_pool: researchPool ? {
        role: "directional_examples_and_duplicate_detection_only",
        warning: "The active channel formula controls betrayal-plus-engine architecture, reversal-engine mix, and scoring. The imported pool's old 50/40/10 surface-trait mix and one-point scores are examples and duplicate evidence only; they are not engine-allocation authority.",
        provenance: researchPool.provenance,
        concept_count: researchPool.concept_count,
        top_30_directional_concepts: topResearchConcepts,
      } : null,
    },
  };
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
    return { content, ...metadata };
  }
  return runCodexCli({
    prompt,
    stageName,
    repoRoot,
    outputPath,
    model: configuredCodexModel(flags.model ?? null),
    reasoningEffort: configuredCodexReasoningEffort(flags["reasoning-effort"] ?? "high"),
    verbosity: flags.verbosity ?? "medium",
    timeoutMs,
  });
}

function protectedCreativeCandidate(candidate) {
  const protectedFields = [
    "id", "title", "title_contract", "thumbnail", "premise", "core_advantage",
    "story_contract", "differentiation", "evidence_ids",
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
Use this to avoid duplicates, honor operator rejections, and challenge—not copy—the existing pool. Operator seeds and decisions outrank research scores. The research scores are comparative hypotheses, not predicted CTR.
${JSON.stringify(premiseContext.modelContext, null, 2)}
`;
  const authorPromptPath = path.join(developmentDir, "winner_ideation_prompt.md");
  await fs.mkdir(developmentDir, { recursive: true });
  await fs.writeFile(authorPromptPath, `${authorPrompt.trim()}\n`, "utf8");

  let judgedDocument;
  let draftPath = null;
  let judgePromptPath = null;
  if (flags["response-path"]) {
    const imported = await modelResponse({
      prompt: authorPrompt,
      stageName: "winner_ideation_import",
      outputPath: path.join(developmentDir, "winner_ideation_judged_response.txt"),
      responsePath: flags["response-path"],
    });
    judgedDocument = extractJsonObject(imported.content);
  } else {
    const draftResponse = await modelResponse({
      prompt: authorPrompt,
      stageName: "winner_ideation_author",
      outputPath: path.join(developmentDir, "winner_ideation_draft_response.txt"),
      responsePath: flags["draft-response-path"] ?? null,
    });
    const draft = extractJsonObject(draftResponse.content);
    draftPath = path.join(developmentDir, "winner_ideation_draft.json");
    await writeJson(draftPath, draft);
    const selectorTemplate = extractTextPrompt(await fs.readFile(path.join(repoRoot, "docs", "prompts", "manhwa_recap_packaging_selector_v1.md"), "utf8"));
    const selectorPrompt = `${selectorTemplate}

BINDING CHANNEL FORMULA JSON
${JSON.stringify(modelFormula, null, 2)}

RECENT CHANNEL TITLES JSON
${JSON.stringify(recent.titles, null, 2)}

OPERATOR CREATIVE BRIEF
${creativeBrief.text || "No additional operator seeds."}

DURABLE STOCKPILE AND DIRECTIONAL RESEARCH CONTEXT JSON
Use this to reject duplicates and reskins. Operator decisions outrank research scores.
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
    });
    judgedDocument = extractJsonObject(judgedResponse.content);
    assertJudgePreservedCandidates(draft, judgedDocument);
  }
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
  evaluated.report.author_prompt_path = authorPromptPath;
  evaluated.report.draft_path = draftPath;
  evaluated.report.selector_prompt_path = judgePromptPath;
  evaluated.report.scoring_authority = flags["response-path"] ? "imported_prejudged_response" : "independent_selector_pass";
  evaluated.report.updated_at = new Date().toISOString();
  const ideationPath = path.join(developmentDir, "winner_ideation_candidates.json");
  const reportPath = path.join(developmentDir, "winner_ideation_report.json");
  const boardPath = path.join(developmentDir, "winner_candidates_review.md");
  await writeJson(ideationPath, evaluated.document);
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
  return { ideationPath, ideation: reevaluated.document, ideationSha256: await fileSha256(ideationPath) };
}

async function approvePackage() {
  if (!isTrue(flags.approve)) throw new Error("Package approval requires --approve true.");
  const approvedBy = required(flags["approved-by"], "--approved-by <operator>");
  const candidateId = required(flags["candidate-id"], "--candidate-id <id>");
  const approveRisk = isTrue(flags["approve-risk"]);
  const riskReason = approveRisk ? required(flags["risk-reason"], "--risk-reason <reason>") : null;
  const developmentDir = developmentDirectory();
  const { formula, formulaSha256 } = await readFormula();
  const { ideationPath, ideation, ideationSha256 } = await loadCurrentIdeation(developmentDir, formula, { allowBlocked: approveRisk });
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
  await writeJson(packagePath, built.contract);
  built.approval.winner_package_path = packagePath;
  built.approval.winner_package_sha256 = await fileSha256(packagePath);
  await writeJson(approvalPath, built.approval);
  console.log(JSON.stringify({
    status: "approved",
    selected_candidate_id: candidateId,
    selected_title: built.contract.selected_title,
    winner_package_path: packagePath,
    approval_path: approvalPath,
    next_required_action: "goldflow source script",
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
  if (loaded.packageContract.formula_sha256 !== formulaSha256) throw new Error("Approved winner package formula hash is stale.");
  const template = extractTextPrompt(await fs.readFile(path.join(repoRoot, "docs", "prompts", "manhwa_recap_chatbot_prompt_v6_light.md"), "utf8"));
  const prompt = `${fillScriptTemplate(template, loaded.packageContract)}

LIGHT STORY TRUTH NOTES
These notes protect the approved click promise. They are not a beat sheet, checklist, chapter plan, or exact timing grid. Use them naturally and compress anything that does not keep the story moving.
${JSON.stringify(lightScriptStoryBrief(loaded.packageContract), null, 2)}
`;
  const promptPath = path.join(developmentDir, "winner_script_prompt.md");
  await fs.writeFile(promptPath, `${prompt.trim()}\n`, "utf8");
  const response = await modelResponse({
    prompt,
    stageName: "winner_script_generation",
    outputPath: path.join(developmentDir, "winner_script_response.txt"),
    responsePath: flags["response-path"] ?? null,
    timeoutMs: Number(flags["timeout-ms"] ?? 2_400_000),
  });
  const normalizedScript = normalizeWinnerNarration(response.content);
  const scriptPath = path.join(developmentDir, "script_candidate.md");
  await fs.writeFile(scriptPath, normalizedScript, "utf8");
  const deterministic = deterministicWinnerScriptReview(normalizedScript, loaded.packageContract);
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
    formula_path: formulaPath,
    formula_sha256: formulaSha256,
    prompt_path: promptPath,
    prompt_sha256: sha256Text(prompt),
    model: response.model ?? "external_response",
    reasoning_effort: response.reasoning_effort ?? null,
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
      ? "operator reviews the exact script; optional: goldflow source audit; release when approved"
      : "the response appears structurally truncated; regenerate or supply a complete candidate",
  }, null, 2));
  if (report.status !== "passed") throw new Error(`Winner script generation is blocked: ${report.deterministic_review.blockers.join(", ")}`);
}

async function loadCurrentScript(developmentDir, loadedPackage) {
  const scriptPath = path.resolve(flags.script ?? path.join(developmentDir, "script_candidate.md"));
  const scriptText = normalizeWinnerNarration(await fs.readFile(scriptPath, "utf8"));
  const review = deterministicWinnerScriptReview(scriptText, loadedPackage.packageContract);
  if (review.status !== "passed") throw new Error(`Current script fails deterministic review: ${review.blockers.join(", ")}`);
  const generationReportPath = path.resolve(flags["generation-report"] ?? path.join(developmentDir, "winner_script_generation_report.json"));
  const generationReport = await readJson(generationReportPath);
  if (generationReport?.schema !== WINNER_SCRIPT_GENERATION_REPORT_SCHEMA || generationReport?.status !== "passed") {
    throw new Error("Winner script generation report is missing or not passed.");
  }
  if (generationReport.source_script_sha256 !== review.source_script_sha256) throw new Error("Winner script generation report is stale for the current script.");
  if (generationReport.winner_package_sha256 !== loadedPackage.packageSha256) throw new Error("Winner script generation report is stale for the current package.");
  return {
    scriptPath,
    scriptText,
    scriptSha256: review.source_script_sha256,
    scriptWordCount: review.source_word_count,
    generationReportPath,
    generationReport,
  };
}

async function audit() {
  const developmentDir = developmentDirectory();
  const { formula, formulaSha256 } = await readFormula();
  const loaded = await loadApprovedPackage(developmentDir);
  const currentScript = await loadCurrentScript(developmentDir, loaded);
  const gateTemplate = extractTextPrompt(await fs.readFile(path.join(repoRoot, "docs", "prompts", "manhwa_recap_machine_release_gate_v1.md"), "utf8"));
  const prompt = `${gateTemplate}

SCRIPT WORD COUNT
${currentScript.scriptWordCount}

BINDING CHANNEL FORMULA JSON
${JSON.stringify(formula, null, 2)}

BINDING APPROVED WINNER PACKAGE JSON
${JSON.stringify(loaded.packageContract, null, 2)}

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
  gateDocument.judged_at = new Date().toISOString();
  const validation = validateWinnerScriptGate(gateDocument, {
    scriptWordCount: currentScript.scriptWordCount,
    formula,
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
    source_review_log_path: reviewLog ? reviewLogPath : null,
    source_review_log_sha256: reviewLogSha256,
    source_review_log_decision: reviewLog?.status ?? null,
    retention_weighted_score: reviewLog?.retention_architecture?.weighted_score ?? null,
    script_generation_report_path: currentScript.generationReportPath,
    script_generation_report_sha256: await fileSha256(currentScript.generationReportPath),
    released_by: releasedBy,
    released_at: new Date().toISOString(),
    approval_scope: "operator_approved_exact_title_thumbnail_premise_mechanic_and_script_hashes; automated_criticism_is_review_only",
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
  goldflow source ideate --channel 53rebirth --development-slug <slug>
  goldflow source approve-package --channel 53rebirth --development-slug <slug> --candidate-id <id> --approve true --approved-by <operator>
  goldflow source script --channel 53rebirth --development-slug <slug>
  goldflow source audit --channel 53rebirth --development-slug <slug>   # optional, review-only
  goldflow source release --channel 53rebirth --development-slug <slug> --approve true --approved-by <operator>

Optional diagnostics/testing:
  --formula <path>
  --development-dir <path>
  --response-path <model-output-file>
  ideate brief: --brief <path> or --creative-brief <text>
  ideate context: --stockpile <path> --research-pool <path>
  ideate only: --draft-response-path <file> --judge-response-path <file>
  package override: --approve-risk true --risk-reason <operator reason>
`);
}

async function main() {
  if (["help", "--help", "-h"].includes(action)) return help();
  if (action === "ideate") return ideate();
  if (action === "approve-package") return approvePackage();
  if (action === "script") return script();
  if (["audit", "gate"].includes(action)) return audit();
  if (action === "release") return release();
  throw new Error(`Unknown winner source action: ${action}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
