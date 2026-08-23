#!/usr/bin/env node

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  NARRATION_EXACT_LISTEN_ATTESTATION,
  NARRATION_EXACT_LISTEN_REVIEW_PACKET_SCHEMA,
  buildNarrationExactListenReviewDecision,
  narrationExactListenReviewPacketSha256,
  validateNarrationExactListenReviewDecision,
} from "./lib/narration-delivery-quality.mjs";

function parseFlags(parts) {
  const flags = {};
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (!part.startsWith("--")) continue;
    const key = part.slice(2);
    const value = parts[index + 1] && !parts[index + 1].startsWith("--")
      ? parts[++index]
      : "true";
    flags[key] = value;
  }
  return flags;
}

function boolFlag(value) {
  return /^(?:1|true|yes)$/iu.test(String(value ?? ""));
}

function csv(value) {
  return [...new Set(String(value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean))];
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function fileSha256(filePath) {
  return sha256(await fs.readFile(filePath));
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function atomicWriteJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporary, filePath);
}

function defectByUnit(value, repairIds, fallback) {
  const entries = String(value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  const mapped = new Map();
  for (const entry of entries) {
    const separator = entry.indexOf(":");
    if (separator < 1) continue;
    mapped.set(entry.slice(0, separator), entry.slice(separator + 1));
  }
  for (const unitId of repairIds) {
    if (!mapped.has(unitId) && fallback) mapped.set(unitId, fallback);
  }
  return mapped;
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const episodeDir = path.resolve(flags["episode-dir"] ?? "");
  if (!flags["episode-dir"]) {
    throw new Error("--episode-dir is required.");
  }
  const identity = await readJson(path.join(episodeDir, "run_identity.json"));
  const episode = String(identity.episode ?? "ep_01");
  const packetPath = path.resolve(
    flags.packet
      ?? path.join(episodeDir, `narration_exact_listen_review_packet_${episode}.json`),
  );
  const packet = await readJson(packetPath);
  if (packet.schema !== NARRATION_EXACT_LISTEN_REVIEW_PACKET_SCHEMA
    || packet.packet_sha256 !== narrationExactListenReviewPacketSha256(packet)) {
    throw new Error("Exact listen-review packet is missing, stale, or hash-invalid.");
  }
  if (packet.status === "not_required" || Number(packet.item_count ?? 0) === 0) {
    console.log(JSON.stringify({
      status: "not_required",
      packet_path: packetPath,
      item_count: 0,
    }, null, 2));
    return;
  }

  const reviewer = String(flags.reviewer ?? "").trim();
  if (!reviewer) throw new Error("--reviewer <name> is required.");
  const packetIds = packet.items.map((item) => String(item.unit_id));
  const repairIds = csv(flags["repair-unit-ids"]);
  const repairSet = new Set(repairIds);
  const acceptIds = boolFlag(flags["accept-all"])
    ? packetIds.filter((unitId) => !repairSet.has(unitId))
    : csv(flags["accept-unit-ids"]);
  const decidedIds = [...acceptIds, ...repairIds];
  if (new Set(decidedIds).size !== decidedIds.length
    || decidedIds.length !== packetIds.length
    || packetIds.some((unitId) => !decidedIds.includes(unitId))) {
    throw new Error(
      "Accept and repair decisions must cover every packet unit exactly once. "
      + "Use --accept-all true after listening to every item, or provide exact "
      + "--accept-unit-ids and --repair-unit-ids lists.",
    );
  }
  if (acceptIds.length
    && flags.attestation !== NARRATION_EXACT_LISTEN_ATTESTATION) {
    throw new Error(
      `Accepted units require --attestation ${NARRATION_EXACT_LISTEN_ATTESTATION}.`,
    );
  }
  const defectMap = defectByUnit(
    flags["repair-defects"],
    repairIds,
    String(flags["defect-type"] ?? "").trim(),
  );
  for (const unitId of repairIds) {
    if (!String(defectMap.get(unitId) ?? "").trim()) {
      throw new Error(
        `Repair unit ${unitId} needs --defect-type or --repair-defects ${unitId}:<type>.`,
      );
    }
  }
  for (const item of packet.items) {
    if (!item.audio_path || !item.audio_sha256
      || await fileSha256(item.audio_path) !== item.audio_sha256) {
      throw new Error(`Listened audio is missing or hash-stale for ${item.unit_id}.`);
    }
  }

  const note = String(flags.note ?? "").trim() || null;
  const decisions = packetIds.map((unitId) => ({
    unit_id: unitId,
    decision: repairSet.has(unitId) ? "repair_required" : "accept",
    defect_type: repairSet.has(unitId) ? defectMap.get(unitId) : null,
    note,
  }));
  const artifact = buildNarrationExactListenReviewDecision({
    packet,
    reviewer,
    decisions,
    attestation: acceptIds.length ? flags.attestation : null,
  });
  const validation = validateNarrationExactListenReviewDecision(packet, artifact);
  if (validation.status === "blocked") {
    throw new Error(
      `Listen-review decision failed validation: ${validation.findings
        .map((finding) => finding.code)
        .join(", ")}`,
    );
  }
  artifact.validation = validation;
  const decisionPath = path.join(
    episodeDir,
    `narration_exact_listen_review_decision_${episode}.json`,
  );
  await atomicWriteJson(decisionPath, artifact);

  let retryEvidencePath = null;
  const exactRetryDefects = new Set(["skip", "truncation", "stutter"]);
  const exactRetryIds = repairIds.filter((unitId) => (
    exactRetryDefects.has(String(defectMap.get(unitId)).toLowerCase())
  ));
  if (exactRetryIds.length) {
    const reportPath = path.join(episodeDir, `narration_tts_report_${episode}.json`);
    const reportBuffer = await fs.readFile(reportPath);
    const report = JSON.parse(reportBuffer.toString("utf8"));
    const reportById = new Map(
      (report.results ?? []).map((row) => [String(row.unit_id), row]),
    );
    const confirmedUnits = exactRetryIds.map((unitId) => {
      const selected = reportById.get(unitId);
      if (!selected?.audio_sha256 || !selected?.synthesis_identity_sha256) {
        throw new Error(
          `Narration report lacks selected audio lineage for repair unit ${unitId}.`,
        );
      }
      return {
        unit_id: unitId,
        defect_type: String(defectMap.get(unitId)).toLowerCase(),
        listen_note: note ?? `Audible ${defectMap.get(unitId)} confirmed by ${reviewer}.`,
        selected_attempt: Number(selected.attempt),
        audio_sha256: selected.audio_sha256,
        synthesis_identity_sha256: selected.synthesis_identity_sha256,
        listen_review_decision_sha256: artifact.decision_sha256,
      };
    });
    retryEvidencePath = path.join(
      episodeDir,
      `narration_confirmed_retry_evidence_${episode}.json`,
    );
    await atomicWriteJson(retryEvidencePath, {
      schema: "goldflow_confirmed_tts_retry_evidence_v2",
      // Retry validation binds creative plan identity, while the file hash is
      // retained separately to prove the exact serialized artifact reviewed.
      narration_generation_plan_sha256:
        packet.narration_generation_plan_sha256,
      narration_generation_plan_file_sha256:
        packet.narration_generation_plan_file_sha256 ?? null,
      canonical_narration_generation_plan_sha256:
        packet.narration_generation_plan_sha256,
      pre_retry_narration_report_sha256: sha256(reportBuffer),
      listen_review_packet_sha256: packet.packet_sha256,
      listen_review_decision_sha256: artifact.decision_sha256,
      confirmed_units: confirmedUnits,
    });
  }

  console.log(JSON.stringify({
    status: artifact.status,
    decision_path: decisionPath,
    decision_sha256: artifact.decision_sha256,
    repair_unit_ids: repairIds,
    confirmed_retry_evidence_path: retryEvidencePath,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
