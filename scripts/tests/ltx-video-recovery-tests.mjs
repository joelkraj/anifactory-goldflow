import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import {
  assignRecoveredJobs,
  comparePerceptualFingerprints,
  parseProfileRequestMap,
  perceptualFingerprint,
  perceptualGateReason,
} from "../ltx-video-recover-interrupted.mjs";

assert.deepEqual(parseProfileRequestMap("account-a=req-1,req-2;account-b=req-3"), [
  { profile: "account-a", request_ids: ["req-1", "req-2"] },
  { profile: "account-b", request_ids: ["req-3"] },
]);
assert.throws(
  () => parseProfileRequestMap('{"account-a":["req-1"],"account-b":["req-1"]}'),
  /Duplicate ModelsLab request id/u,
);

assert.equal(perceptualGateReason({ block_ssim: 0.79, luminance_ncc: 0.99 }, {
  score: 0.95,
  margin: 0.5,
  hasRunner: true,
}), "block_ssim_below_threshold");
assert.equal(perceptualGateReason({ block_ssim: 0.95, luminance_ncc: 0.89 }, {
  score: 0.95,
  margin: 0.5,
  hasRunner: true,
}), "luminance_ncc_below_threshold");
assert.equal(perceptualGateReason({ block_ssim: 0.95, luminance_ncc: 0.98 }, {
  score: 0.95,
  margin: 0.19,
  hasRunner: true,
}), "perceptual_match_ambiguous");

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-ltx-recovery-test-"));
try {
  const sourcePath = path.join(tempDir, "source-16x9.png");
  const providerFramePath = path.join(tempDir, "provider-3x2.jpg");
  const distractorPath = path.join(tempDir, "distractor.png");
  const sourceSvg = Buffer.from(`
    <svg width="160" height="90" xmlns="http://www.w3.org/2000/svg">
      <rect width="160" height="90" fill="#111827"/>
      <rect x="34" y="8" width="40" height="74" fill="#f4c542"/>
      <circle cx="112" cy="44" r="25" fill="#f8fafc"/>
      <path d="M72 16 L101 73 L48 66 Z" fill="#dc2626"/>
    </svg>`);
  await sharp(sourceSvg).png().toFile(sourcePath);
  await sharp(sourcePath)
    .extract({ left: 12, top: 0, width: 135, height: 90 })
    .resize(150, 100)
    .jpeg({ quality: 88 })
    .toFile(providerFramePath);
  await sharp({ create: { width: 160, height: 90, channels: 3, background: "#e5e7eb" } })
    .composite([{ input: Buffer.from('<svg width="160" height="90" xmlns="http://www.w3.org/2000/svg"><circle cx="35" cy="45" r="29" fill="#111827"/><rect x="100" y="4" width="45" height="82" fill="#9ca3af"/></svg>') }])
    .png()
    .toFile(distractorPath);
  const [sourceFingerprint, frameFingerprint, distractorFingerprint] = await Promise.all([
    perceptualFingerprint(sourcePath),
    perceptualFingerprint(providerFramePath),
    perceptualFingerprint(distractorPath),
  ]);
  const match = comparePerceptualFingerprints(frameFingerprint, sourceFingerprint);
  const mismatch = comparePerceptualFingerprints(frameFingerprint, distractorFingerprint);
  assert.ok(match.score >= 0.85, JSON.stringify(match));
  assert.ok(match.block_ssim >= 0.80, JSON.stringify(match));
  assert.ok(match.luminance_ncc >= 0.90, JSON.stringify(match));
  assert.ok(match.score - mismatch.score >= 0.20, `${match.score} vs ${mismatch.score}`);

  const assignment = assignRecoveredJobs([{
    request_id: "request-fixture",
    route_profile: "account-a",
    fingerprint: frameFingerprint,
  }], [{
    image_id: "cut-match",
    candidate_id: "cut-match-candidate-01",
    candidate_index: 1,
    route_profile: "account-a",
    source_fingerprint: sourceFingerprint,
  }, {
    image_id: "cut-distractor",
    candidate_id: "cut-distractor-candidate-01",
    candidate_index: 1,
    route_profile: "account-a",
    source_fingerprint: distractorFingerprint,
  }]);
  assert.equal(assignment.assigned.length, 1);
  assert.equal(assignment.assigned[0].slot.image_id, "cut-match");
  assert.equal(assignment.assigned[0].match_diagnostics.minimum_block_ssim, 0.80);
  assert.equal(assignment.assigned[0].match_diagnostics.minimum_luminance_ncc, 0.90);
} finally {
  await fs.rm(tempDir, { recursive: true, force: true });
}

console.log("ltx interrupted recovery tests passed");
