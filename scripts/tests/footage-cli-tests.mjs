import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { runFootage } from "../footage.mjs";
import { extractFootageClip } from "../lib/footage-extract.mjs";
import { createFootageSource, footageHash, footageLibraryRoot, readFootageSource, validateFootageClipReceipt, writeImmutableFootageJson } from "../lib/footage-library.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-footage-cli-"));
const library = path.join(root, "library");
const env = { ANIFACTORY_DATA_ROOT: root };
let calls = 0;
let extractions = 0;
let resolvedHash = "a".repeat(40);
const providerFactory = (provider) => ({
  account: async () => { calls++; return { status: "active" }; },
  list: async () => { calls++; return { items: [] }; },
  resolve: async ({ sourceId, fileId }) => {
    calls++;
    return { provider, source_id: sourceId, file_id: fileId, filename: "fixture.mp4", bytes: 2000, source_hash: resolvedHash, url: "https://media.example.test/video?token=PRIVATE-SIGNED-URL" };
  },
});
const extract = async ({ outputPath, durationSec, source }) => {
  extractions++;
  const data = Buffer.from(`mock-output-${extractions}`);
  await fs.writeFile(outputPath, data, { flag: "wx" });
  return { clip_sha256: footageHash(data), actual_duration_sec: durationSec, width: 320, height: 180,
    transferred_bytes: source.url ? 1000 : 0, request_count: source.url ? 1 : 0, range_supported: source.url ? true : null };
};
const run = (args, overrides = {}) => runFootage(args, { repoRoot: root, env, providerFactory, extract, ...overrides });
const rights = ["--rights-confirmed", "true", "--rights-note", "Owned synthetic test fixture"];
const localFile = path.join(root, "fixture.mp4");
const subtitleFile = path.join(root, "fixture.srt");
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
let local, remote, search, clipped;

test("help is isolated from config and network", async () => {
  assert.match((await run(["--help"])).help, /footage register/);
  assert.equal(calls, 0);
});
test("key initialization is private and no-clobber", async () => {
  const initialized = await run(["init"]);
  assert.equal(initialized.status, "created");
  assert.equal((await fs.stat(initialized.config_path)).mode & 0o777, 0o600);
  await fs.writeFile(initialized.config_path, "GOLDFLOW_TORBOX_API_KEY=fixture-token\nGOLDFLOW_REAL_DEBRID_API_KEY=\n");
  const original = await fs.readFile(initialized.config_path, "utf8");
  assert.equal((await run(["init"])).status, "already_exists_preserved");
  assert.equal(await fs.readFile(initialized.config_path, "utf8"), original);
});
test("configuration reports presence only; missing credentials never call a provider", async () => {
  const config = await run(["config"]);
  assert.equal(config.providers.torbox.configured, true);
  assert.equal(config.providers.real_debrid.configured, false);
  assert.ok(!JSON.stringify(config).includes("fixture-token"));
  await assert.rejects(run(["accounts", "--provider", "real_debrid"]), /No real_debrid key/);
  assert.equal(calls, 0);
});
test("flags reject secrets, arbitrary URLs, production scope, duplicate and fractional counts", async () => {
  for (const args of [
    ["config", "--api-key", "DO-NOT-ECHO"], ["extract", "--url", "https://secret.test"],
    ["register", "--episode", "ep_01"], ["accounts", "--provider", "torbox", "--provider", "both"],
  ]) await assert.rejects(run(args), (error) => /flag/.test(error.message) && !/DO-NOT-ECHO|secret.test/.test(error.message));
  await assert.rejects(run(["list", "--limit", "1.5"]), /integer/);
  assert.equal(calls, 0);
});
test("account checks use only explicitly configured providers", async () => {
  assert.equal((await run(["accounts"])).results.length, 1);
  assert.equal(calls, 1);
});
test("registration requires explicit rights and exact edition before network", async () => {
  const before = calls;
  await assert.rejects(run(["register", "--provider", "torbox"]), /rights-confirmed/);
  await assert.rejects(run(["register", ...rights, "--title", "Fixture"]), /edition/);
  assert.equal(calls, before);
});
test("local registration creates immutable hash-bound source", async () => {
  await fs.writeFile(localFile, Buffer.alloc(2000, 1));
  await fs.writeFile(subtitleFile, "1\n00:00:10,000 --> 00:00:12,000\nOpen the door.\n\n2\n00:00:30,000 --> 00:00:33,000\nClose the door.\n");
  const args = ["register", "--file", localFile, "--title", "Fixture", "--edition", "Synthetic 24fps", ...rights, "--library-dir", library];
  local = await run(args);
  assert.equal(local.source.provider, "local");
  assert.deepEqual(await readFootageSource(local.source_path), local.source);
  assert.deepEqual(await run(args), local);
});
test("remote registration discards signed URL and keys", async () => {
  remote = await run(["register", "--provider", "torbox", "--source-id", "12", "--file-id", "0", "--title", "Fixture", "--edition", "Exact remote release", ...rights, "--library-dir", library]);
  const saved = await fs.readFile(remote.source_path, "utf8");
  assert.ok(!/https:|PRIVATE|fixture-token/.test(saved));
  assert.equal(remote.source.source_id, "12");
});
test("source identity rejects ambiguous hash lengths and absent IDs", () => {
  const args = { identity: { ...remote.source, source_hash: "a".repeat(41) }, title: "Fixture", edition: "Exact", rightsNote: "Owned" };
  assert.throws(() => createFootageSource(args), /content hash/);
  args.identity = { ...remote.source, source_id: undefined };
  assert.throws(() => createFootageSource(args), /Source ID/);
  assert.throws(() => footageLibraryRoot(path.join(root, "episodes", "ep_01")), /production/);
});
test("symlinked library paths cannot write into episodes", async () => {
  const episode = path.join(root, "episodes", "ep_01");
  await fs.mkdir(episode, { recursive: true });
  const alias = path.join(root, "alias");
  await fs.symlink(episode, alias);
  assert.throws(() => footageLibraryRoot(path.join(alias, "new-library")), /production/);
  await assert.rejects(writeImmutableFootageJson(path.join(alias, "unexpected.json"), {}), /production/);
});
test("local subtitle search binds edition and affine timing without provider calls", async () => {
  const before = calls;
  search = await run(["search", "--source", local.source_path, "--subtitles", subtitleFile, "--query", "open the door", "--subtitle-offset-sec", "2", "--subtitle-scale", "1.1", "--library-dir", library]);
  assert.equal(search.results[0].start_sec, 13);
  assert.equal(search.timing_verified, false);
  assert.equal(search.source_manifest_sha256, local.source.manifest_sha256);
  assert.equal(calls, before);
});
test("search report from another edition is refused before resolution", async () => {
  const before = calls;
  await assert.rejects(run(["extract", "--source", remote.source_path, "--search-report", search.report_path, "--candidate-id", search.results[0].cue_id, "--library-dir", library]), /different source edition/);
  assert.equal(calls, before);
});
test("invalid duration and ambiguous timing are refused", async () => {
  for (const duration of ["2", "6", "NaN"]) await assert.rejects(run(["extract", "--source", local.source_path, "--start-sec", "0", "--duration-sec", duration, "--library-dir", library]), /duration-sec/);
  await assert.rejects(run(["extract", "--source", local.source_path, "--start-sec", "0", "--search-report", search.report_path]), /either/);
  assert.equal(extractions, 0);
});
test("candidate extraction carries preview-only timing and immutable receipt", async () => {
  clipped = await run(["extract", "--source", local.source_path, "--search-report", search.report_path, "--candidate-id", search.results[0].cue_id, "--library-dir", library]);
  assert.equal(clipped.request.start_sec, 13);
  assert.equal(clipped.request.duration_sec, 4);
  assert.equal(clipped.request.subtitle_evidence.timing_verified, false);
  assert.equal(clipped.production_eligible, false);
  assert.equal(clipped.review_status, "needs_preview");
  assert.equal((await validateFootageClipReceipt(clipped.receipt_path)).clipPath, clipped.clip_path);
});
test("exact clip reuse does not extract again or require provider credentials", async () => {
  const args = ["extract", "--source", remote.source_path, "--start-sec", "20", "--library-dir", library];
  const first = await run(args);
  const beforeCalls = calls, beforeExtracts = extractions;
  const reused = await run(args, { env: { ...env, GOLDFLOW_TORBOX_API_KEY: "" } });
  assert.equal(reused.status, "reused_local_clip");
  assert.equal(reused.transferred_bytes, 0);
  assert.equal(calls, beforeCalls);
  assert.equal(extractions, beforeExtracts);
  await fs.unlink(first.clip_path);
  await assert.rejects(run(args));
  assert.equal(calls, beforeCalls, "missing cached bytes must not acquire a new URL");
  assert.equal(extractions, beforeExtracts);
});
test("changed remote identity stops before media extraction", async () => {
  resolvedHash = "b".repeat(40);
  const before = extractions;
  await assert.rejects(run(["extract", "--source", remote.source_path, "--start-sec", "25", "--library-dir", library]), /no longer matches/);
  assert.equal(extractions, before);
  resolvedHash = "a".repeat(40);
});
test("changed local source stops before media extraction", async () => {
  await fs.writeFile(localFile, Buffer.alloc(2000, 2));
  const before = extractions;
  await assert.rejects(run(["extract", "--source", local.source_path, "--start-sec", "1", "--library-dir", library]), /changed since registration/);
  assert.equal(extractions, before);
  await fs.writeFile(localFile, Buffer.alloc(2000, 1));
});
test("local changes during extraction cannot publish a valid clip receipt", async () => {
  let newPath;
  await assert.rejects(run(["extract", "--source", local.source_path, "--start-sec", "7", "--library-dir", library], {
    extract: async (args) => {
      newPath = args.outputPath;
      const result = await extract(args);
      await fs.writeFile(localFile, Buffer.alloc(2000, 3));
      return result;
    },
  }), /changed since registration/);
  await assert.rejects(fs.stat(newPath), { code: "ENOENT" });
  await fs.writeFile(localFile, Buffer.alloc(2000, 1));
});
test("receipt duration tolerance agrees with extractor frame rounding", async () => {
  const result = await run(["extract", "--source", local.source_path, "--start-sec", "8", "--library-dir", library], {
    extract: async (args) => ({ ...await extract(args), actual_duration_sec: 4.14 }),
  });
  assert.equal((await validateFootageClipReceipt(result.receipt_path)).receipt.actual_duration_sec, 4.14);
});
test("preview approval is hash-bound and never production approval", async () => {
  const approved = await run(["approve", "--clip", clipped.receipt_path, "--reviewer", "Fixture reviewer", "--note", "Previewed exact four-second silent clip"]);
  assert.equal(approved.production_eligible, false);
  const record = JSON.parse(await fs.readFile(approved.approval_path, "utf8"));
  assert.equal(record.receipt_sha256, clipped.receipt_sha256);
  await assert.rejects(run(["approve", "--clip", clipped.receipt_path, "--reviewer", "Someone else", "--note", "Changed"]), /Refusing to overwrite/);
});
test("stale manifests, corrupt receipts and clobber attempts fail", async () => {
  const stalePath = path.join(root, "stale.json");
  await fs.writeFile(stalePath, JSON.stringify({ ...local.source, edition: "changed" }));
  await assert.rejects(readFootageSource(stalePath), /stale/);
  const invalid = { ...clipped, request: { ...clipped.request, duration_sec: undefined } };
  delete invalid.receipt_sha256;
  invalid.receipt_sha256 = footageHash(invalid);
  const invalidPath = path.join(root, "invalid.json");
  await fs.writeFile(invalidPath, JSON.stringify(invalid));
  await assert.rejects(validateFootageClipReceipt(invalidPath), /malformed/);
  await assert.rejects(writeImmutableFootageJson(local.source_path, { changed: true }), /overwrite/);
  await fs.writeFile(clipped.clip_path, "corruption");
  await assert.rejects(run(["approve", "--clip", clipped.receipt_path, "--reviewer", "Fixture", "--note", "Must reject"]), /no longer match/);
});
test("real FFmpeg passes register -> subtitle search -> extract -> approve -> reuse", async () => {
  const film = path.join(root, "real-fixture.mp4");
  const generated = spawnSync("ffmpeg", ["-v", "error", "-nostdin", "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=24", "-t", "18", "-c:v", "libx264", "-pix_fmt", "yuv420p", film], { encoding: "utf8" });
  assert.equal(generated.status, 0, "FFmpeg synthetic fixture generation must pass");
  const source = await run(["register", "--file", film, "--title", "Real synthetic fixture", "--edition", "24fps generated locally", ...rights, "--library-dir", library]);
  const found = await run(["search", "--source", source.source_path, "--subtitles", subtitleFile, "--query", "open the door", "--library-dir", library]);
  const args = ["extract", "--source", source.source_path, "--search-report", found.report_path, "--candidate-id", found.results[0].cue_id, "--library-dir", library];
  const clip = await run(args, { extract: extractFootageClip });
  assert.equal(clip.actual_duration_sec, 4);
  assert.equal(clip.width, 160);
  assert.equal(clip.transferred_bytes, 0);
  await run(["approve", "--clip", clip.receipt_path, "--reviewer", "Synthetic test", "--note", "Automated fixture approval only"]);
  assert.equal((await run(args)).status, "reused_local_clip");
});

try {
  for (const [name, fn] of tests) { await fn(); process.stdout.write(`PASS ${name}\n`); }
  process.stdout.write(`footage CLI/library tests passed (${tests.length})\n`);
} finally {
  // Only this test's freshly created, explicit fixture directory is removed.
  await fs.rm(root, { recursive: true, force: true });
}
