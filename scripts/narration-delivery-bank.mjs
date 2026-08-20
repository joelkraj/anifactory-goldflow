#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import {
  DEFAULT_NARRATION_DELIVERY_BANK_PATH,
  NARRATION_DELIVERY_PROMOTION_SCHEMA,
  loadNarrationDeliveryReferenceBank,
  narrationDeliveryPromotionSha256,
  validateNarrationDeliveryPromotion,
} from "./lib/narration-delivery-reference-bank.mjs";

function flagsFrom(parts) {
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

async function writeAtomic(filePath, document) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  await fs.rename(temporary, filePath);
}

async function main() {
  const flags = flagsFrom(process.argv.slice(2));
  const action = String(flags.action ?? "audit");
  const bankPath = path.resolve(flags.bank ?? DEFAULT_NARRATION_DELIVERY_BANK_PATH);
  const loaded = await loadNarrationDeliveryReferenceBank(bankPath);
  if (loaded.validation.status !== "passed") {
    throw new Error(`Delivery bank blocked: ${loaded.validation.findings.map((row) => row.code).join(", ")}`);
  }
  if (action === "audit") {
    console.log(JSON.stringify({
      status: "passed",
      bank_path: loaded.path,
      bank_sha256: loaded.sha256,
      active_delivery_ids: loaded.document.production_active_delivery_ids,
      unpromoted_delivery_ids: loaded.document.references.filter((row) => !loaded.document.production_active_delivery_ids.includes(row.delivery_id)).map((row) => row.delivery_id),
    }, null, 2));
    return;
  }
  if (action !== "promote") throw new Error("--action must be audit or promote.");
  const deliveryId = String(flags["delivery-id"] ?? "").trim();
  const approvedBy = String(flags["approved-by"] ?? "").trim();
  if (!deliveryId || !approvedBy) throw new Error("Promotion requires --delivery-id <id> --approved-by <operator> plus blinded evidence flags.");
  const candidate = loaded.document.references.find((row) => row.delivery_id === deliveryId);
  if (!candidate) throw new Error(`Unknown delivery reference ${deliveryId}.`);
  const base = {
    schema: NARRATION_DELIVERY_PROMOTION_SCHEMA,
    status: "approved",
    delivery_id: deliveryId,
    candidate_audio_sha256: candidate.audio_sha256,
    bank_sha256_before_promotion: loaded.sha256,
    blind_test_minutes: Number(flags["blind-test-minutes"]),
    fatigue_soak_minutes: Number(flags["fatigue-soak-minutes"]),
    blind_preference_winner: String(flags["blind-winner"] ?? ""),
    same_voice_identity_passed: flags["same-voice-passed"] === "true",
    voice_drift_veto_clear: flags["voice-drift-clear"] === "true",
    blind_review_path: flags["blind-review"] ? path.resolve(flags["blind-review"]) : null,
    fatigue_soak_path: flags["fatigue-soak"] ? path.resolve(flags["fatigue-soak"]) : null,
    voice_similarity_path: flags["voice-similarity"] ? path.resolve(flags["voice-similarity"]) : null,
    approved_by: approvedBy,
    approved_at: new Date().toISOString(),
  };
  const promotion = { ...base, promotion_sha256: narrationDeliveryPromotionSha256(base) };
  const validation = validateNarrationDeliveryPromotion(promotion, loaded.document);
  if (validation.status !== "passed") throw new Error(`Promotion blocked: ${validation.findings.map((row) => row.code).join(", ")}`);
  for (const requiredPath of [promotion.blind_review_path, promotion.fatigue_soak_path, promotion.voice_similarity_path]) {
    if (!requiredPath || !await fs.stat(requiredPath).then((row) => row.isFile()).catch(() => false)) throw new Error("Promotion requires existing blind-review, fatigue-soak, and voice-similarity evidence files.");
  }
  const outputDir = path.resolve(flags["output-dir"] ?? path.dirname(bankPath));
  const promotionPath = path.join(outputDir, `delivery_promotion_${deliveryId}.json`);
  await writeAtomic(promotionPath, promotion);
  const nextBank = structuredClone(loaded.document);
  nextBank.blind_approved_delivery_ids = [...new Set([
    ...(nextBank.blind_approved_delivery_ids ?? []),
    deliveryId,
  ])];
  const row = nextBank.references.find((entry) => entry.delivery_id === deliveryId);
  row.status = "blind_approved_pending_multireference_runtime";
  row.promotion_evidence = {
    promotion_path: promotionPath,
    promotion_sha256: promotion.promotion_sha256,
    blind_review_path: promotion.blind_review_path,
    fatigue_soak_path: promotion.fatigue_soak_path,
    voice_similarity_path: promotion.voice_similarity_path,
  };
  const outputBankPath = path.resolve(flags.output ?? path.join(outputDir, "narration_delivery_reference_bank.promoted.json"));
  await writeAtomic(outputBankPath, nextBank);
  console.log(JSON.stringify({
    status: "blind_approved_pending_multireference_runtime",
    delivery_id: deliveryId,
    promotion_path: promotionPath,
    output_bank_path: outputBankPath,
    production_active_delivery_ids: nextBank.production_active_delivery_ids,
    policy: "The production runner remains single-reference until a separately tested multi-reference batch contract is promoted. The approved baseline is unchanged.",
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
