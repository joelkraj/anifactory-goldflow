import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

function cleanValue(value) {
  const text = String(value ?? "").trim();
  return text ? text : null;
}

function readIdentity(episodeDir) {
  try {
    return JSON.parse(readFileSync(path.join(episodeDir, "run_identity.json"), "utf8"));
  } catch {
    return {};
  }
}

export function canonicalNarrationReportPath(episodeDir, episode) {
  return path.join(episodeDir, `audio_stitch_report_${episode}-narration.json`);
}

export function legacyQwenNarrationReportPath(episodeDir, episode) {
  return path.join(episodeDir, `audio_stitch_report_${episode}-modelslab-qwen.json`);
}

export function explicitNarrationReportPath(flags = {}) {
  return cleanValue(
    flags["narration-report"]
      ?? flags.narrationReport
      ?? flags.qwenReport
      ?? flags["qwen-report"]
      ?? flags.audioStitchReport
      ?? flags["audio-stitch-report"],
  );
}

export function identityUsesCanonicalNarrationContract(identity = {}) {
  return Boolean(
    cleanValue(identity.narration_contract_version)
      ?? cleanValue(identity.tts_provider)
      ?? cleanValue(identity.narration_provider)
      ?? cleanValue(identity.voice_provider_options?.tts_provider)
      ?? cleanValue(identity.voice_provider_options?.primary?.provider),
  );
}

export function resolveNarrationReport({
  episodeDir,
  episode,
  flags = {},
  identity = null,
} = {}) {
  if (!episodeDir) throw new Error("resolveNarrationReport requires episodeDir.");
  if (!episode) throw new Error("resolveNarrationReport requires episode.");

  const explicitPath = explicitNarrationReportPath(flags);
  const canonicalPath = canonicalNarrationReportPath(episodeDir, episode);
  const legacyPath = legacyQwenNarrationReportPath(episodeDir, episode);
  const runIdentity = identity ?? readIdentity(episodeDir);
  const canonicalIdentity = identityUsesCanonicalNarrationContract(runIdentity);

  if (explicitPath) {
    return {
      report_path: path.resolve(explicitPath),
      resolution: "explicit_flag",
      canonical_identity: canonicalIdentity,
      canonical_path: canonicalPath,
      legacy_path: legacyPath,
    };
  }

  // A generic identity is an explicit provider contract. Never let an old
  // Qwen artifact silently satisfy that contract. Legacy identities may read
  // a canonical imported baseline, but new identities require the canonical
  // narration report unless an operator supplies an explicit diagnostic flag.
  const candidates = canonicalIdentity
    ? [canonicalPath]
    : [legacyPath, canonicalPath];
  const existingPath = candidates.find((candidate) => existsSync(candidate));
  return {
    report_path: existingPath ?? candidates[0],
    resolution: existingPath
      ? existingPath === canonicalPath
        ? "canonical_existing"
        : "legacy_existing"
      : canonicalIdentity
        ? "canonical_expected"
        : "legacy_expected",
    canonical_identity: canonicalIdentity,
    canonical_path: canonicalPath,
    legacy_path: legacyPath,
  };
}

export function resolveNarrationReportPath(options = {}) {
  return resolveNarrationReport(options).report_path;
}
