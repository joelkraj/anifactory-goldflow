import assert from "node:assert/strict";
import {
  configuredModelslabProfiles,
  loadModelslabAccount,
  modelslabAccountFingerprint,
  modelslabProfileForWorkId,
  parseModelslabProfiles,
  publicModelslabAccount,
} from "../lib/modelslab-account-pool.mjs";

function testProfileParsingAndStickyAssignment() {
  assert.deepEqual(parseModelslabProfiles("default, secondary,default"), ["default", "secondary"]);
  assert.deepEqual(parseModelslabProfiles(""), ["default", "secondary"]);
  assert.deepEqual(configuredModelslabProfiles({ flagValue: null, envValue: undefined }), ["default", "secondary"]);
  assert.deepEqual(configuredModelslabProfiles({ flagValue: null, envValue: "default" }), ["default"]);
  assert.deepEqual(configuredModelslabProfiles({ flagValue: "secondary", envValue: "default" }), ["secondary"]);
  assert.throws(() => parseModelslabProfiles("default,bad profile"), /Invalid ModelsLab CLI profile/u);

  const profiles = ["default", "secondary"];
  const first = modelslabProfileForWorkId("cut_001", profiles);
  assert.equal(modelslabProfileForWorkId("cut_001", profiles), first);
  const assignments = Array.from({ length: 100 }, (_value, index) => (
    modelslabProfileForWorkId(`cut_${String(index).padStart(3, "0")}`, profiles)
  ));
  assert.equal(new Set(assignments).size, 2);
}

async function testCredentialLoadingAndPublicRedaction() {
  const calls = [];
  const mockExec = async (_command, args) => {
    calls.push(args);
    if (args[1] === "list") {
      return { stdout: JSON.stringify({ data: { items: [{ id: 42, is_default: true }] } }) };
    }
    return { stdout: JSON.stringify({ data: { key: "mock-secret-key" } }) };
  };
  const account = await loadModelslabAccount("fixture-secondary", {
    cwd: process.cwd(),
    env: {},
    execFileImpl: mockExec,
  });
  assert.equal(account.profile, "fixture-secondary");
  assert.equal(account.apiKey, "mock-secret-key");
  assert.equal(account.fingerprint, modelslabAccountFingerprint("mock-secret-key"));
  assert.equal(calls.every((args) => args.includes("fixture-secondary")), true);
  assert.deepEqual(publicModelslabAccount(account), {
    fingerprint: modelslabAccountFingerprint("mock-secret-key"),
    credential_source: "modelslab_cli_profile",
  });
  assert.equal(JSON.stringify(publicModelslabAccount(account)).includes("mock-secret-key"), false);
  assert.equal(JSON.stringify(publicModelslabAccount(account)).includes("fixture-secondary"), false);
}

testProfileParsingAndStickyAssignment();
await testCredentialLoadingAndPublicRedaction();
