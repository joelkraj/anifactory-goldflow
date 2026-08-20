import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function fileHash(filePath) {
  try {
    return sha256(await fs.readFile(filePath));
  } catch {
    return null;
  }
}

async function listFiles(root, predicate, output = []) {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const filePath = path.join(root, entry.name);
    if (entry.isDirectory()) await listFiles(filePath, predicate, output);
    else if (predicate(filePath)) output.push(filePath);
  }
  return output;
}

function rows(value) {
  return Array.isArray(value) ? value : [];
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function finiteDate(value) {
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function minutesBetween(start, end) {
  const startMs = finiteDate(start);
  const endMs = finiteDate(end);
  if (startMs === null || endMs === null || endMs < startMs) return null;
  return Number(((endMs - startMs) / 60_000).toFixed(3));
}

function promptRefIds(prompt = {}) {
  return unique([
    ...rows(prompt.reference_requirements).map((row) => row?.ref_id),
    ...rows(prompt.reference_usage)
      .filter((row) => row?.usage === "attach_existing_ref")
      .map((row) => row?.ref_id),
    ...rows(prompt.shot_manifest?.reference_slots).map((row) => row?.ref_id),
    ...rows(prompt.required_reference_ids),
  ].map((value) => String(value ?? "").trim()));
}

function qaFindingsByImageId(imageQa = {}) {
  const map = new Map();
  const possible = [
    ...rows(imageQa.rows),
    ...rows(imageQa.findings),
    ...rows(imageQa.cut_findings),
    ...rows(imageQa.audit?.rows),
  ];
  for (const row of possible) {
    const imageId = String(row?.image_id ?? row?.cut_id ?? "").trim();
    if (!imageId) continue;
    const findings = rows(row?.findings).length ? rows(row.findings) : [row];
    const current = map.get(imageId) ?? [];
    current.push(...findings);
    map.set(imageId, current);
  }
  return map;
}

function referenceRelevantFinding(finding = {}) {
  const text = [finding.code, finding.message, finding.reason, finding.note]
    .map((value) => String(value ?? ""))
    .join(" ")
    .toLowerCase();
  return /identity|continuity|reference|wrong.state|wrong.location|character|wardrobe|contamin|drift/.test(text);
}

async function generationMetadataByRefId(episodeDir) {
  const root = path.join(episodeDir, "assets", "images", "references");
  const metadataPaths = await listFiles(root, (filePath) => filePath.endsWith(".metadata.json"));
  const map = new Map();
  for (const metadataPath of metadataPaths) {
    const metadata = await readJson(metadataPath);
    const refId = String(metadata?.ref_id ?? "").trim();
    if (!refId) continue;
    const attemptDir = metadata?.source_path ? path.dirname(metadata.source_path) : null;
    const assignment = attemptDir ? await readJson(path.join(attemptDir, "assignment.json")) : null;
    const receipt = metadata?.provider_receipt_path
      ? await readJson(metadata.provider_receipt_path)
      : null;
    map.set(refId, {
      metadata_path: metadataPath,
      metadata_sha256: await fileHash(metadataPath),
      provider: metadata?.image_provider ?? metadata?.browser_provider ?? null,
      model: metadata?.model ?? null,
      leased_at: assignment?.leased_at ?? null,
      completed_at: receipt?.completed_at ?? metadata?.updated_at ?? null,
      generation_minutes: minutesBetween(
        assignment?.leased_at,
        receipt?.completed_at ?? metadata?.updated_at,
      ),
      output_path: metadata?.conditioning_image_path ?? metadata?.generated?.downloaded_path ?? null,
      output_sha256: metadata?.generated?.output_sha256 ?? null,
      receipt_path: metadata?.provider_receipt_path ?? null,
      receipt_sha256: metadata?.provider_receipt_sha256 ?? null,
    });
  }
  return map;
}

export async function buildReferenceRoiAudit({
  episodeDir,
  episode = "ep_01",
  generatedAt = new Date(),
} = {}) {
  if (!episodeDir) throw new Error("Reference ROI audit requires episodeDir.");
  const paths = {
    inventory: path.join(episodeDir, "reference_inventory_ledger.json"),
    plan: path.join(episodeDir, "visual_reference_plan.json"),
    prompts: path.join(episodeDir, "section_image_prompts_hardened.json"),
    cut_ledger: path.join(episodeDir, "cut_execution_ledger.json"),
    image_qa: path.join(episodeDir, `image_output_qa_${episode}.json`),
    approval: path.join(episodeDir, `visual_reference_approval_${episode}.json`),
  };
  const [inventory, plan, prompts, cutLedger, imageQa, approval, metadataByRefId] = await Promise.all([
    readJson(paths.inventory),
    readJson(paths.plan),
    readJson(paths.prompts),
    readJson(paths.cut_ledger),
    readJson(paths.image_qa),
    readJson(paths.approval),
    generationMetadataByRefId(episodeDir),
  ]);
  if (!inventory?.assets?.length) {
    return {
      schema: "goldflow_reference_roi_audit_v1",
      status: "not_ready",
      generated_at: generatedAt.toISOString(),
      episode_dir: episodeDir,
      episode,
      reason: "reference_inventory_ledger.json has no selected assets",
      assets: [],
    };
  }
  const promptRows = rows(prompts?.prompts);
  const cutRows = rows(cutLedger?.cuts);
  const cutById = new Map(cutRows.map((row) => [String(row?.image_id ?? ""), row]));
  const qaByImageId = qaFindingsByImageId(imageQa);
  const approvalByRefId = new Map(rows(approval?.reference_decisions)
    .map((row) => [String(row?.ref_id ?? "").trim(), row]));
  const planByRefId = new Map(rows(plan?.reference_targets)
    .map((row) => [String(row?.ref_id ?? "").trim(), row]));

  const assets = rows(inventory.assets).map((asset) => {
    const refId = String(asset?.ref_id ?? "").trim();
    const target = planByRefId.get(refId) ?? {};
    const approvalRow = approvalByRefId.get(refId) ?? {};
    const generation = metadataByRefId.get(refId) ?? null;
    const dependentPrompts = promptRows.filter((prompt) => promptRefIds(prompt).includes(refId));
    const attachedCuts = cutRows.filter((cut) => rows(cut?.reference_ids).map(String).includes(refId));
    const acceptedCuts = attachedCuts.filter((cut) => /^passed/.test(String(cut?.image_qa_status ?? "")));
    const findingRows = attachedCuts.flatMap((cut) => qaByImageId.get(String(cut?.image_id ?? "")) ?? []);
    const referenceFindings = findingRows.filter(referenceRelevantFinding);
    const rejectedOrCritical = referenceFindings.filter((finding) => (
      finding?.production_blocking === true
      || finding?.severity === "blocker"
      || /reject|critical/.test(String(finding?.decision ?? finding?.status ?? "").toLowerCase())
    ));
    const plannedBeatIds = unique(rows(asset?.planned_beat_ids).map(String));
    const dependentBeatIds = unique(dependentPrompts.map((prompt) => String(prompt?.visual_beat_id ?? "")));
    const firstDependentCut = dependentPrompts
      .map((prompt) => cutById.get(String(prompt?.image_id ?? "")))
      .filter(Boolean)
      .sort((left, right) => Number(left?.start_sec ?? 0) - Number(right?.start_sec ?? 0))[0] ?? null;
    const approvalMinutesAfterGeneration = minutesBetween(
      generation?.completed_at,
      approvalRow?.reviewed_at ?? approval?.updated_at,
    );
    const whyTextIsInsufficient = String(
      asset?.why_text_is_insufficient
      ?? target?.why_text_is_insufficient
      ?? "",
    ).trim();
    const generatedReference = String(asset?.generation_mode ?? target?.generation_mode ?? "") === "standalone_ref";
    return {
      asset_id: asset?.asset_id ?? target?.inventory_asset_id ?? null,
      ref_id: refId,
      kind: asset?.kind ?? target?.kind ?? null,
      subject: asset?.subject ?? target?.subject ?? null,
      generation_mode: asset?.generation_mode ?? target?.generation_mode ?? null,
      provider: generation?.provider ?? target?.image_provider ?? null,
      model: generation?.model ?? null,
      generation_minutes: generation?.generation_minutes ?? null,
      approval_minutes_after_generation: approvalMinutesAfterGeneration,
      approved: /^approved/.test(String(approvalRow?.status ?? approvalRow?.decision ?? "")),
      cleanliness_status: approvalRow?.cleanliness_status ?? null,
      planned_use_count: Number(asset?.estimated_use_count ?? target?.estimated_use_count ?? plannedBeatIds.length),
      planned_beat_count: plannedBeatIds.length,
      dependent_cut_count: dependentPrompts.length,
      dependent_beat_count: dependentBeatIds.length,
      attachment_count: attachedCuts.length,
      accepted_cut_count: acceptedCuts.length,
      first_dependent_cut_start_sec: firstDependentCut?.start_sec ?? null,
      reference_related_qa_finding_count: referenceFindings.length,
      reference_related_critical_finding_count: rejectedOrCritical.length,
      prevention_measurement: {
        status: "not_causally_measured",
        planned_risk_reduction: asset?.reference_value_reason ?? target?.reference_value_reason ?? null,
        accepted_attached_cut_count: acceptedCuts.length,
        note: "Accepted attached cuts are evidence of downstream use, not proof of the counterfactual result without this reference.",
      },
      contamination_or_drift: {
        associated_finding_count: referenceFindings.length,
        critical_finding_count: rejectedOrCritical.length,
        status: rejectedOrCritical.length
          ? "critical_findings_present"
          : referenceFindings.length
            ? "advisory_findings_present"
            : "none_observed_in_recorded_qa",
      },
      text_only_assessment: {
        likely_sufficient: generatedReference ? false : null,
        director_evidence: whyTextIsInsufficient || null,
        status: whyTextIsInsufficient ? "director_justified" : "not_measured",
      },
      evidence: {
        generation_metadata_path: generation?.metadata_path ?? null,
        generation_metadata_sha256: generation?.metadata_sha256 ?? null,
        provider_receipt_path: generation?.receipt_path ?? null,
        provider_receipt_sha256: generation?.receipt_sha256 ?? null,
        output_path: generation?.output_path ?? target?.conditioning_image_path ?? null,
        output_sha256: generation?.output_sha256 ?? approval?.reference_hash_by_ref_id?.[refId] ?? null,
      },
    };
  });
  const generated = assets.filter((asset) => asset.generation_mode === "standalone_ref");
  const zeroUse = generated.filter((asset) => asset.attachment_count === 0);
  const lowUse = generated.filter((asset) => asset.attachment_count > 0 && asset.attachment_count <= 1);
  const totalGenerationMinutes = generated.reduce(
    (sum, asset) => sum + (Number(asset.generation_minutes) || 0),
    0,
  );
  const sourceHashes = {};
  for (const [key, filePath] of Object.entries(paths)) sourceHashes[key] = await fileHash(filePath);
  return {
    schema: "goldflow_reference_roi_audit_v1",
    status: "passed",
    generated_at: generatedAt.toISOString(),
    episode_dir: episodeDir,
    episode,
    source_paths: paths,
    source_hashes: sourceHashes,
    policy: {
      deterministic_reference_cap_forbidden: true,
      counterfactual_benefit_must_not_be_invented: true,
      accepted_cut_usage_is_not_causal_proof: true,
      future_director_uses_report_as_evidence_only: true,
    },
    summary: {
      selected_asset_count: assets.length,
      generated_reference_count: generated.length,
      attached_reference_count: generated.filter((asset) => asset.attachment_count > 0).length,
      zero_attachment_reference_count: zeroUse.length,
      single_attachment_reference_count: lowUse.length,
      total_attachment_count: assets.reduce((sum, asset) => sum + asset.attachment_count, 0),
      accepted_attached_cut_count: assets.reduce((sum, asset) => sum + asset.accepted_cut_count, 0),
      measured_generation_minutes: Number(totalGenerationMinutes.toFixed(3)),
      generated_references_with_timing_count: generated.filter((asset) => asset.generation_minutes !== null).length,
      critical_reference_related_finding_count: assets.reduce(
        (sum, asset) => sum + asset.reference_related_critical_finding_count,
        0,
      ),
      counterfactual_prevention_measured_count: 0,
    },
    findings: [
      ...(zeroUse.length ? [{
        severity: "advisory",
        code: "generated_references_without_attachments",
        ref_ids: zeroUse.map((asset) => asset.ref_id),
        message: `${zeroUse.length} generated references were not attached to an accepted cut. Review this evidence during the next global reference direction pass; do not prune the current approved plan deterministically.`,
      }] : []),
      ...(lowUse.length ? [{
        severity: "advisory",
        code: "generated_references_with_single_attachment",
        ref_ids: lowUse.map((asset) => asset.ref_id),
        message: `${lowUse.length} generated references were attached once. A one-use reference can still be justified by opening, identity, or contact risk.`,
      }] : []),
    ],
    assets,
  };
}

export function renderReferenceRoiMarkdown(report) {
  if (report.status !== "passed") {
    return `# Goldflow Reference ROI Audit\n\nStatus: ${report.status}\n\n${report.reason ?? "Not ready."}\n`;
  }
  const lines = [
    "# Goldflow Reference ROI Audit",
    "",
    `Generated: ${report.generated_at}`,
    "",
    "## Summary",
    "",
    `- Selected assets: ${report.summary.selected_asset_count}`,
    `- Generated references: ${report.summary.generated_reference_count}`,
    `- Generated references attached at least once: ${report.summary.attached_reference_count}`,
    `- Generated references with zero attachments: ${report.summary.zero_attachment_reference_count}`,
    `- Measured generation minutes: ${report.summary.measured_generation_minutes}`,
    "",
    "## Findings",
    "",
    ...(report.findings.length
      ? report.findings.map((finding) => `- **${finding.code}:** ${finding.message}`)
      : ["- No threshold findings."]),
    "",
    "## Assets",
    "",
    "| Reference | Kind | Planned | Attached | Accepted cuts | Gen min | QA findings |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: |",
    ...report.assets.map((asset) => `| ${asset.ref_id} | ${asset.kind ?? "-"} | ${asset.planned_use_count ?? 0} | ${asset.attachment_count} | ${asset.accepted_cut_count} | ${asset.generation_minutes ?? "-"} | ${asset.reference_related_qa_finding_count} |`),
    "",
  ];
  return `${lines.join("\n")}\n`;
}
