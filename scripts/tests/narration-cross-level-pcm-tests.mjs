import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { crossLevelPcmIntegrityForTests } from "../narration-provider-output-finalize.mjs";

const rate = 24000;
const pcm = (samples) => {
  const buffer = Buffer.alloc(44 + samples.length * 2);
  buffer.write("RIFF", 0); buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write("WAVEfmt ", 8); buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(rate, 24); buffer.writeUInt32LE(rate * 2, 28);
  buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36); buffer.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((sample, index) => buffer.writeInt16LE(sample, 44 + index * 2));
  return buffer;
};
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-cross-level-pcm-"));
try {
  const preparedSamples = Array.from({ length: rate }, (_, index) =>
    Math.round(1800 * Math.sin(2 * Math.PI * 300 * index / rate)));
  const prefix = Array(2400).fill(0);
  const suffix = Array(2400).fill(0);
  const rawSamples = [...prefix, ...preparedSamples, ...suffix];
  const masterSamples = rawSamples.map((sample) => Math.round(sample * 2));
  const preparedPath = path.join(directory, "prepared.wav");
  const rawPath = path.join(directory, "raw.wav");
  const masterPath = path.join(directory, "master.wav");
  await Promise.all([
    fs.writeFile(preparedPath, pcm(preparedSamples)),
    fs.writeFile(rawPath, pcm(rawSamples)),
    fs.writeFile(masterPath, pcm(masterSamples)),
  ]);
  const inputs = { preparedPath, rawStitchPath: rawPath, masterPath,
    startSample: prefix.length, endSampleExclusive: prefix.length + rate,
    articleStartSec: 0.2, articleEndSec: 0.4 };
  const valid = await crossLevelPcmIntegrityForTests(inputs);
  assert.equal(valid.status, "passed");
  assert.equal(valid.prepared_pcm_sha256, valid.raw_stitch_span_pcm_sha256);
  const changed = [...rawSamples];
  changed[prefix.length + 5000] = 1234;
  await fs.writeFile(rawPath, pcm(changed));
  const mutated = await crossLevelPcmIntegrityForTests(inputs);
  assert.equal(mutated.status, "blocked");
  assert.notEqual(mutated.prepared_pcm_sha256, mutated.raw_stitch_span_pcm_sha256);
} finally {
  await fs.rm(directory, { recursive: true, force: true });
}
console.log("narration-cross-level-pcm-tests: passed");
