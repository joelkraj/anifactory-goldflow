#!/usr/bin/env node
import { promises as fs } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createFootageProvider, loadFootageConfig, footageConfigStatus } from "./lib/footage-providers.mjs";
import { parseSubtitles, searchSubtitles } from "./lib/footage-subtitles.mjs";
import { extractFootageClip } from "./lib/footage-extract.mjs";
import { sha256File } from "./lib/file-hash.mjs";
import {
  FOOTAGE_CLIP_SCHEMA, FOOTAGE_SEARCH_SCHEMA, createFootageSource, footageClipIdentity,
  footageHash, footageLibraryRoot, readFootageJson, readFootageSource,
  validateFootageClipReceipt, validateLocalFootageSource, validateResolvedFootageSource,
  validateFootageAudioContract,
  writeImmutableFootageJson,
} from "./lib/footage-library.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const FOOTAGE_HELP = `Goldflow footage — private, opt-in source clipping (not an episode stage)

  footage init                 Create .env.footage.local without overwriting keys
  footage config               Show key-presence flags and local FFmpeg availability
  footage accounts             Check configured accounts (network; no downloads)
  footage list                 List account torrent files, exact IDs and readiness
  footage cache-check          Check TorBox cache for --hash (no source discovery)
  footage add                  Add --magnet-file; TorBox defaults to cached-only
  footage select               Select exact Real-Debrid --file-ids for download
  footage register             Register --file OR --provider/--source-id/--file-id
  footage search               Search local --subtitles for --query, bound to --source
  footage extract              Make one 3–5 second clip (silent unless opted in)
  footage approve              Record preview approval for --clip receipt.json

Common: --provider torbox|real_debrid|both, --library-dir <directory>
List: --limit 20 --offset 0 [--refresh true] (refresh requires --provider torbox)
Registration: --title <title> --edition <exact release> --rights-confirmed true
              --rights-note <permission/public-domain/license/review-basis note>
Search: --source <source.json> --subtitles <file.srt|file.vtt> --query <dialogue>
        [--subtitle-offset-sec 0] [--subtitle-scale 1] [--limit 10]
Extract: --source <source.json> --start-sec <seconds> [--duration-sec 4]
         OR --source <source.json> --search-report <search.json> --candidate-id <id>
         [--max-download-mib 128] [--timeout-sec 120]
         [--keep-audio true] First source audio track, AAC 192k stereo/48k
                             Fails if audio is missing; default is silent
Approve: --clip <receipt.json> --reviewer <name> --note <preview evidence>
Add/select: require --rights-confirmed true --rights-note <basis>.
            Real-Debrid also requires --allow-uncached true (no cache-only API).
            select requires --source-id <id> --file-ids <comma-separated IDs>.

No keys in flags. No automatic fallback, full-file fallback, subtitle API, AI calls,
movie discovery, episode mutation, or publishing. See docs/workflows/footage_clipping_workflow.md.
`;

const ALLOWED = {
  init: [], config: [], accounts: ["provider"],
  list: ["provider", "limit", "offset", "refresh"],
  "cache-check": ["provider", "hash"],
  add: ["provider", "magnet-file", "allow-uncached", "file-ids", "rights-confirmed", "rights-note"],
  select: ["provider", "source-id", "file-ids", "allow-uncached", "rights-confirmed", "rights-note"],
  register: ["provider", "source-id", "file-id", "file", "title", "edition", "rights-confirmed", "rights-note", "library-dir"],
  search: ["source", "subtitles", "query", "limit", "subtitle-offset-sec", "subtitle-scale", "library-dir"],
  extract: ["source", "start-sec", "duration-sec", "search-report", "candidate-id", "max-download-mib", "timeout-sec", "keep-audio", "library-dir"],
  approve: ["clip", "reviewer", "note"],
};

function parseArgs(argv) {
  const [command = "help", ...args] = argv;
  if (command === "help" || argv.includes("--help") || argv.includes("-h")) return { command: "help", flags: {} };
  if (!Object.hasOwn(ALLOWED, command)) throw new Error("Unknown footage command. Run goldflow footage --help.");
  const flags = {};
  for (let index = 0; index < args.length; index += 1) {
    const match = /^--([a-z-]+)(?:=(.*))?$/u.exec(args[index]);
    if (!match || !ALLOWED[command].includes(match[1]) || Object.hasOwn(flags, match[1])) throw new Error("Unknown, duplicate, or misplaced footage flag. Keys must go in .env.footage.local, never flags.");
    const value = match[2] ?? args[++index];
    if (value === undefined || value.startsWith("--")) throw new Error("Every footage flag needs an explicit value.");
    flags[match[1]] = value;
  }
  return { command, flags };
}

function required(flags, name) {
  if (!flags[name]?.trim()) throw new Error(`Missing required --${name}.`);
  return flags[name].trim();
}
function numeric(flags, name, fallback, min, max) {
  const value = flags[name] === undefined ? fallback : Number(flags[name]);
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`--${name} must be between ${min} and ${max}.`);
  return value;
}
function boolean(flags, name) {
  if (flags[name] === undefined || flags[name] === "false") return false;
  if (flags[name] === "true") return true;
  throw new Error(`--${name} must be true or false.`);
}
function integer(flags, name, fallback, min, max) {
  const value = numeric(flags, name, fallback, min, max);
  if (!Number.isSafeInteger(value)) throw new Error(`--${name} must be an integer.`);
  return value;
}
async function exists(filePath) {
  try { await fs.lstat(filePath); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}
function rights(flags) {
  if (!boolean(flags, "rights-confirmed")) throw new Error("This action requires --rights-confirmed true and --rights-note describing your basis to access/use the source. A short clip is not automatic permission.");
  return required(flags, "rights-note");
}
function providerName(raw) {
  const value = String(raw ?? "torbox").replaceAll("-", "_");
  if (value === "realdebrid") return "real_debrid";
  if (!["torbox", "real_debrid", "local", "both"].includes(value)) throw new Error("Provider must be torbox, real_debrid, or both (local only for registration).");
  return value;
}
async function limitedText(filePath, maxBytes) {
  const stat = await fs.stat(filePath);
  if (!stat.isFile() || stat.size > maxBytes) throw new Error("Input file exceeds the permitted size or is not a regular file.");
  return new TextDecoder("utf-8", { fatal: true }).decode(await fs.readFile(filePath));
}
function sourcePath(value, library) {
  return /^src_[a-f0-9]{24}$/u.test(value) ? path.join(library, "sources", `${value}.json`) : path.resolve(value);
}
function safeError(error) {
  return String(error?.message ?? "Footage operation failed.").replace(/https?:\/\/[^\s"'<>]+/giu, "[private URL redacted]");
}

export async function runFootage(argv, {
  repoRoot = REPO_ROOT, env = process.env, providerFactory = createFootageProvider,
  extract = extractFootageClip,
} = {}) {
  const { command, flags } = parseArgs(argv);
  if (command === "help") return { help: FOOTAGE_HELP };
  if (command === "init") {
    const configPath = path.join(repoRoot, ".env.footage.local");
    try {
      await fs.writeFile(configPath, "# Private provider keys. Gitignored. Either may be blank.\nGOLDFLOW_TORBOX_API_KEY=\nGOLDFLOW_REAL_DEBRID_API_KEY=\n", { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      return { status: "already_exists_preserved", config_path: configPath };
    }
    return { status: "created", config_path: configPath };
  }
  const config = await loadFootageConfig({ repoRoot, env });
  if (command === "config") return {
    ...footageConfigStatus(config),
    ffmpeg_available: spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0,
    ffprobe_available: spawnSync("ffprobe", ["-version"], { stdio: "ignore" }).status === 0,
  };
  const client = (provider) => {
    if (!["torbox", "real_debrid"].includes(provider)) throw new Error("This command requires one explicit remote provider.");
    const apiKey = provider === "torbox" ? config.torboxApiKey : config.realDebridApiKey;
    if (!apiKey) throw new Error(`No ${provider} key configured. Put it in .env.footage.local and run footage config.`);
    return providerFactory(provider, { apiKey });
  };
  if (command === "accounts" || command === "list") {
    const requested = providerName(flags.provider ?? "both");
    const refresh = command === "list" ? boolean(flags, "refresh") : false;
    if (refresh && requested !== "torbox") throw new Error("--refresh true requires --provider torbox; Real-Debrid refresh is unsupported.");
    const providers = requested === "both"
      ? [config.torboxApiKey && "torbox", config.realDebridApiKey && "real_debrid"].filter(Boolean)
      : [requested];
    if (!providers.length) throw new Error("No providers configured. Run footage init, fill the key file, then footage config.");
    const results = [];
    // Sequential, bounded pages avoid a burst of RD detail requests.
    for (const provider of providers) {
      const api = client(provider);
      results.push({ provider, ...(command === "accounts" ? await api.account() : await api.list({
        limit: integer(flags, "limit", 20, 1, 100), offset: integer(flags, "offset", 0, 0, 1_000_000),
        ...(refresh ? { refresh: true } : {}),
      })) });
    }
    return { status: "passed", results };
  }
  if (command === "cache-check") return client(providerName(flags.provider)).cacheCheck({ hash: required(flags, "hash") });
  if (command === "add" || command === "select") {
    rights(flags);
    const api = client(providerName(flags.provider));
    const fileIds = flags["file-ids"]?.split(",").map((id) => id.trim());
    const allowUncached = boolean(flags, "allow-uncached");
    if (command === "select") {
      if (!fileIds?.length) throw new Error("select requires exact --file-ids; implicit all-file selection is forbidden.");
      return api.select({ sourceId: required(flags, "source-id"), fileIds, allowUncached });
    }
    const magnet = (await limitedText(path.resolve(required(flags, "magnet-file")), 64 * 1024)).trim();
    return api.add({ magnet, allowUncached, fileIds });
  }
  const library = footageLibraryRoot(flags["library-dir"], env);
  if (command === "register") {
    const rightsNote = rights(flags);
    const title = required(flags, "title");
    const edition = required(flags, "edition");
    let identity;
    if (flags.file) {
      if (flags["source-id"] || flags["file-id"] || (flags.provider && providerName(flags.provider) !== "local")) throw new Error("Use either a local file or an exact remote provider file, not both.");
      const localPath = await fs.realpath(path.resolve(flags.file));
      const stat = await fs.stat(localPath);
      if (!stat.isFile() || !/\.(mp4|mkv)$/iu.test(localPath)) throw new Error("The source must be a regular MP4 or MKV file.");
      const hash = await sha256File(localPath);
      identity = { provider: "local", source_id: hash, file_id: "0", source_hash: hash, filename: path.basename(localPath), bytes: stat.size, local_path: localPath, local_sha256: hash };
    } else {
      identity = await client(providerName(required(flags, "provider"))).resolve({ sourceId: required(flags, "source-id"), fileId: required(flags, "file-id") });
      if (!/\.(mp4|mkv)$/iu.test(identity.filename)) throw new Error("Select a native MP4/MKV video file, not an archive or playlist.");
    }
    // createFootageSource explicitly selects safe fields; the private URL is discarded.
    const source = createFootageSource({ identity, title, edition, rightsNote });
    const manifestPath = path.join(library, "sources", `${source.id}.json`);
    await writeImmutableFootageJson(manifestPath, source);
    return { status: "registered", source_path: manifestPath, source };
  }
  if (command === "approve") {
    const receiptPath = path.resolve(required(flags, "clip"));
    const { receipt, clipPath } = await validateFootageClipReceipt(receiptPath);
    const approval = {
      schema: "goldflow_footage_clip_approval_v1", decision: "approved", production_eligible: false,
      clip_sha256: receipt.clip_sha256, receipt_sha256: receipt.receipt_sha256,
      reviewer: required(flags, "reviewer"), note: required(flags, "note"),
    };
    const approvalPath = path.join(path.dirname(receiptPath), "approval.json");
    await writeImmutableFootageJson(approvalPath, approval);
    return { status: "approved_for_library", clip_path: clipPath, approval_path: approvalPath, production_eligible: false };
  }
  const manifestPath = sourcePath(required(flags, "source"), library);
  const source = await readFootageSource(manifestPath);
  if (command === "search") {
    const subtitlePath = path.resolve(required(flags, "subtitles"));
    const text = await limitedText(subtitlePath, 10 * 1024 * 1024);
    const subtitleSha256 = footageHash(text);
    const offsetSec = numeric(flags, "subtitle-offset-sec", 0, -86400, 86400);
    const scale = numeric(flags, "subtitle-scale", 1, 0.1, 10);
    const query = required(flags, "query");
    const results = searchSubtitles(parseSubtitles(text), query, { limit: integer(flags, "limit", 10, 1, 100), offsetSec, scale });
    const body = {
      schema: FOOTAGE_SEARCH_SCHEMA, source_manifest_sha256: source.manifest_sha256,
      subtitle_sha256: subtitleSha256, query, offset_sec: offsetSec, scale,
      timing_verified: false, method: "local_lexical_subtitle_search_no_ai", results,
    };
    const report = { ...body, report_sha256: footageHash(body) };
    const reportPath = path.join(library, "searches", `${report.report_sha256}.json`);
    await writeImmutableFootageJson(reportPath, report);
    return { status: results.length ? "candidates_found" : "no_matches", report_path: reportPath, ...report };
  }
  if (command === "extract") {
    let subtitleEvidence = null;
    let startSec;
    if (flags["search-report"]) {
      if (flags["start-sec"] !== undefined) throw new Error("Choose either a search candidate or an explicit start, not both.");
      const report = await readFootageJson(path.resolve(flags["search-report"]));
      const { report_sha256: digest, ...body } = report;
      if (report.schema !== FOOTAGE_SEARCH_SCHEMA || footageHash(body) !== digest || report.source_manifest_sha256 !== source.manifest_sha256 || !Array.isArray(report.results)) throw new Error("Search report is stale, malformed, or bound to a different source edition.");
      const candidateId = required(flags, "candidate-id");
      const candidate = report.results.find((row) => row.cue_id === candidateId);
      if (!candidate) throw new Error("Candidate ID is absent from the exact search report.");
      startSec = candidate.start_sec;
      subtitleEvidence = { report_sha256: digest, subtitle_sha256: report.subtitle_sha256, cue_id: candidateId, offset_sec: report.offset_sec, scale: report.scale, timing_verified: false };
    } else {
      if (flags["candidate-id"]) throw new Error("--candidate-id requires --search-report.");
      required(flags, "start-sec");
      startSec = numeric(flags, "start-sec", 0, 0, 86400);
    }
    const durationSec = numeric(flags, "duration-sec", 4, 3, 5);
    const keepAudio = boolean(flags, "keep-audio");
    const maxBytes = Math.floor(numeric(flags, "max-download-mib", 128, 1, 512) * 1024 * 1024);
    const timeoutMs = numeric(flags, "timeout-sec", 120, 1, 300) * 1000;
    const request = footageClipIdentity(source, startSec, durationSec, subtitleEvidence, { keepAudio });
    const clipId = `clip_${footageHash(request)}`;
    const clipDir = footageLibraryRoot(path.join(library, "clips", clipId), env);
    const receiptPath = path.join(clipDir, "receipt.json");
    const outputPath = path.join(clipDir, "clip.mp4");
    if (await exists(receiptPath)) {
      const { receipt, clipPath } = await validateFootageClipReceipt(receiptPath);
      if (JSON.stringify(receipt.request) !== JSON.stringify(request)) throw new Error("Cached clip request does not match.");
      return { status: "reused_local_clip", clip_path: clipPath, receipt_path: receiptPath, audio_policy: receipt.audio_policy ?? "removed", review_status: "check_approval_json", transferred_bytes: 0 };
    }
    if (await exists(outputPath)) throw new Error("An existing clip has no receipt. Inspect the interrupted extraction; it will not be overwritten or reacquired automatically.");
    // Check cache before obtaining a fresh signed URL. Never silently reacquire on cache corruption.
    let resolved;
    if (source.provider === "local") {
      await validateLocalFootageSource(source);
      resolved = { local_path: source.local_path };
    } else {
      resolved = await client(source.provider).resolve({ sourceId: source.source_id, fileId: source.file_id });
      validateResolvedFootageSource(source, resolved);
    }
    await fs.mkdir(clipDir, { recursive: true, mode: 0o700 });
    const lockPath = path.join(clipDir, "extract.lock");
    let lock;
    try { lock = await fs.open(lockPath, "wx", 0o600); }
    catch (error) { if (error.code === "EEXIST") throw new Error("This exact clip is already extracting or has an interrupted lock; inspect it before recovery."); throw error; }
    try {
      const result = await extract({ source: resolved, outputPath, startSec, durationSec, maxBytes, timeoutMs, keepAudio });
      validateFootageAudioContract(result, { keepAudio, durationSec });
      if (source.provider === "local") {
        try { await validateLocalFootageSource(source); }
        catch (error) {
          // Only discard this attempt's newly generated, still-matching output.
          if (await sha256File(outputPath) === result.clip_sha256) await fs.unlink(outputPath);
          throw error;
        }
      }
      const receipt = {
        schema: FOOTAGE_CLIP_SCHEMA, id: clipId, request,
        source_manifest_sha256: source.manifest_sha256, source_title: source.title, source_edition: source.edition,
        clip_sha256: result.clip_sha256, actual_duration_sec: result.actual_duration_sec,
        width: result.width, height: result.height,
        audio_policy: result.audio_policy,
        ...(keepAudio ? {
          audio_codec: result.audio_codec, audio_channels: result.audio_channels,
          audio_sample_rate: result.audio_sample_rate, audio_duration_sec: result.audio_duration_sec,
          audio_start_sec: result.audio_start_sec, source_audio_stream_index: result.source_audio_stream_index,
        } : {}),
        transferred_bytes: result.transferred_bytes, request_count: result.request_count,
        range_supported: result.range_supported, max_download_bytes: maxBytes,
        source_probe_sha256: result.source_probe_sha256 ?? null,
        source_bytes: result.source_bytes ?? source.bytes,
        source_version_validation: result.source_version_validation ?? (source.provider === "local" ? "local_sha256_before_and_after" : "unavailable"),
        source_validator_sha256: result.source_validator_sha256 ?? null,
        review_status: "needs_preview", production_eligible: false,
      };
      receipt.receipt_sha256 = footageHash(receipt);
      await writeImmutableFootageJson(receiptPath, receipt);
      return { status: "extracted_needs_preview", clip_path: outputPath, receipt_path: receiptPath, ...receipt };
    } finally { await lock.close(); await fs.unlink(lockPath); }
  }
  throw new Error("Unknown footage operation.");
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    const result = await runFootage(process.argv.slice(2));
    process.stdout.write(result.help ?? `${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${safeError(error)}\n`);
    process.exitCode = 1;
  }
}
