import { createHash } from "node:crypto";
import { execFile as execFileCb } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);
const PROFILE_PATTERN = /^[A-Za-z0-9._-]+$/u;
const DEFAULT_MODELSLAB_PROFILES = Object.freeze(["default", "secondary"]);
const accountCache = new Map();
const accountPromiseCache = new Map();

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function profileEnvSuffix(profile) {
  return String(profile).toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}

function uniqueProfiles(values) {
  return [...new Set(values)];
}

export function parseModelslabProfiles(value, { fallback = DEFAULT_MODELSLAB_PROFILES } = {}) {
  const candidates = Array.isArray(value)
    ? value
    : String(value ?? "").split(",");
  const profiles = uniqueProfiles(candidates.map((profile) => String(profile).trim()).filter(Boolean));
  const selected = profiles.length ? profiles : [...fallback];
  for (const profile of selected) {
    if (!PROFILE_PATTERN.test(profile)) {
      throw new Error(`Invalid ModelsLab CLI profile "${profile}". Use only letters, numbers, dot, underscore, or hyphen.`);
    }
  }
  return selected;
}

export function configuredModelslabProfiles({
  flagValue = null,
  envValue = process.env.ANIFACTORY_MODELSLAB_PROFILES,
} = {}) {
  return parseModelslabProfiles(flagValue ?? envValue ?? "");
}

export function modelslabAccountFingerprint(apiKey) {
  if (!apiKey) throw new Error("Cannot fingerprint an empty ModelsLab API key.");
  return `ml_${sha256(apiKey).slice(0, 12)}`;
}

export function modelslabProfileForWorkId(workId, profiles) {
  const selected = parseModelslabProfiles(profiles);
  if (selected.length === 1) return selected[0];
  let winner = selected[0];
  let winningScore = -1n;
  for (const profile of selected) {
    const score = BigInt(`0x${sha256(`${String(workId)}\0${profile}`).slice(0, 16)}`);
    if (score > winningScore) {
      winner = profile;
      winningScore = score;
    }
  }
  return winner;
}

function apiKeyFromEnvironment(profile, env = process.env) {
  const named = env[`ANIFACTORY_MODELSLAB_API_KEY_${profileEnvSuffix(profile)}`];
  if (named) return { apiKey: named, source: "profile_environment" };
  if (profile === "default") {
    const legacy = env.MODELSLAB_API_KEY || env.API_KEY;
    if (legacy) return { apiKey: legacy, source: "legacy_environment" };
  }
  return null;
}

function jsonItems(value) {
  return value?.data?.items ?? value?.items ?? [];
}

export async function loadModelslabAccount(profile, {
  cwd = process.cwd(),
  env = process.env,
  execFileImpl = execFile,
} = {}) {
  const normalizedProfile = parseModelslabProfiles([profile])[0];
  const envCredential = apiKeyFromEnvironment(normalizedProfile, env);
  if (envCredential) {
    return {
      profile: normalizedProfile,
      apiKey: envCredential.apiKey,
      fingerprint: modelslabAccountFingerprint(envCredential.apiKey),
      credential_source: envCredential.source,
    };
  }
  if (accountCache.has(normalizedProfile)) return accountCache.get(normalizedProfile);
  if (!accountPromiseCache.has(normalizedProfile)) {
    accountPromiseCache.set(normalizedProfile, (async () => {
      const common = ["--profile", normalizedProfile, "--output", "json", "--no-color", "--no-update-check"];
      const { stdout: listStdout } = await execFileImpl(
        "modelslab",
        ["keys", "list", ...common],
        { cwd: path.resolve(cwd), maxBuffer: 1024 * 1024 },
      );
      const keys = jsonItems(JSON.parse(listStdout));
      const selected = keys.find((key) => key.is_default === 1 || key.is_default === true) ?? keys[0];
      if (!selected?.id) {
        throw new Error(`No ModelsLab API key is available for CLI profile "${normalizedProfile}".`);
      }
      const { stdout: getStdout } = await execFileImpl(
        "modelslab",
        ["keys", "get", "--id", String(selected.id), ...common],
        { cwd: path.resolve(cwd), maxBuffer: 1024 * 1024 },
      );
      const apiKey = JSON.parse(getStdout)?.data?.key;
      if (!apiKey) throw new Error(`ModelsLab profile "${normalizedProfile}" did not return its selected API key.`);
      return {
        profile: normalizedProfile,
        apiKey,
        fingerprint: modelslabAccountFingerprint(apiKey),
        credential_source: "modelslab_cli_profile",
      };
    })());
  }
  try {
    const account = await accountPromiseCache.get(normalizedProfile);
    accountCache.set(normalizedProfile, account);
    return account;
  } finally {
    accountPromiseCache.delete(normalizedProfile);
  }
}

export async function loadConfiguredModelslabAccounts(profiles, options = {}) {
  return Promise.all(parseModelslabProfiles(profiles).map((profile) => loadModelslabAccount(profile, options)));
}

export function publicModelslabAccount(account) {
  return {
    fingerprint: account?.fingerprint ?? null,
    credential_source: account?.credential_source ?? null,
  };
}
