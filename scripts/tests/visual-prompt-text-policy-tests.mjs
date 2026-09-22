#!/usr/bin/env node

import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  compileVisualPrompt,
  validateVisualPromptCompilerReceipt,
  VISUAL_PROMPT_COMPILER_VERSION,
  VISUAL_PROMPT_TEXT_POLICY,
} from "../lib/visual-prompt-compiler.mjs";
import {
  appendCodexWorkManifestStream,
  createCodexWorkManifest,
  leaseNextWorkItem,
  openCodexWorkManifestStream,
  sha256,
  stableStringify,
} from "../lib/codex-image-work-contract.mjs";

const scenes = [
  'A hand steadies a scratched watch. An authored speech bubble reads "KEEP IT" above the hand, clear of the lower-center subtitles.',
  'The phone UI reads "LEVEL TWO". The shop sign reads "OPEN" and the document stamp reads "APPROVED".',
  'A deliberately authored bottom narrative caption reads "THREE DAYS LATER". Keep its exact wording.',
  'A face-free UI reference plate carries the label "STATUS" and a simple rectangular field.',
  'A silent empty corridor with light falling across a closed door.',
];
const shotManifest = {
  foreground_action: "The watch becomes the decisive leverage",
  mentioned_only_characters: ["The former owner"],
  forbidden_ref_ids: ["future_location"],
};
const orderedReferences = [{ slot: 1, ref_id: "watch_plate", purpose: "prop identity", sha256: "a".repeat(64) }];
const originalManifest = structuredClone(shotManifest);
const originalReferences = structuredClone(orderedReferences);

for (const provider of ["google-flow", "google-gemini", "chatgpt"]) {
  for (const neutralPrompt of scenes) {
    const compiled = compileVisualPrompt({ provider, neutralPrompt, shotManifest, orderedReferences });
    assert.ok(compiled.prompt.includes(`SCENE DESCRIPTION:\n${neutralPrompt}`), "authored copy is preserved verbatim");
    assert.equal(compiled.prompt.match(/VISIBLE TEXT POLICY:/g)?.length, 1);
    assert.match(compiled.prompt, /Preserve explicitly authored visible text: speech or thought bubbles, narrative overlays, signs, documents, and screen\/UI wording/);
    assert.match(compiled.prompt, /Do not add unrequested bottom subtitles, narration captions, explanatory labels, or production notes/);
    assert.match(compiled.prompt, /reserve room for captions added later/);
    assert.match(compiled.prompt, /Treat prompt headings, reference IDs and purposes, and staging or continuity descriptions as instructions, not lettering to print/);
    assert.equal(compiled.receipt.compiler_version, 2);
    assert.equal(compiled.receipt.text_rendering_policy, VISUAL_PROMPT_TEXT_POLICY);
    assert.deepEqual(validateVisualPromptCompilerReceipt({
      ...compiled, neutralPrompt, provider, orderedReferences, expectedCompilerVersion: 2,
    }), []);
    assert.equal(compiled.prompt_sha256, compileVisualPrompt({ provider, neutralPrompt, shotManifest, orderedReferences }).prompt_sha256);
  }
}
assert.deepEqual(shotManifest, originalManifest);
assert.deepEqual(orderedReferences, originalReferences);

// A reference asset has no scene manifest but must retain explicitly authored labels.
const neutralPrompt = scenes[3];
const provider = "google-gemini";
const compiled = compileVisualPrompt({ provider, neutralPrompt });
const validate = (overrides = {}) => validateVisualPromptCompilerReceipt({ ...compiled, neutralPrompt, provider, ...overrides });
assert.deepEqual(validate(), []);
assert.ok(validate({ prompt: `${compiled.prompt} altered` }).includes("compiler_output_hash_mismatch"));
const missingPolicyPrompt = compiled.prompt.split("\n\nVISIBLE TEXT POLICY:")[0];
assert.ok(validate({
  prompt: missingPolicyPrompt,
  receipt: { ...compiled.receipt, compiled_prompt_sha256: sha256(missingPolicyPrompt) },
}).includes("compiler_visible_text_policy_missing_or_stale"), "rehashing a policy-free prompt cannot satisfy v2");
assert.ok(validate({ receipt: { ...compiled.receipt, text_rendering_policy: "unknown" } }).includes("compiler_visible_text_policy_missing_or_stale"));
assert.ok(validate({ receipt: { ...compiled.receipt, compiler_version: 99 } }).includes("compiler_receipt_version_unsupported"));

// Historical v1 assignments retain their exact compiled bytes and hashes. A new
// v2-pinned manifest cannot claim one of those receipts as its own compilation.
const legacyPrompt = `Create one coherent story frame that makes the decisive event immediately readable.\n\nSCENE DESCRIPTION:\n${neutralPrompt}`;
const legacyReceipt = {
  schema: "goldflow_visual_prompt_compiler_v1",
  compiler_id: "google_gemini_scene_compiler_v1",
  compiler_version: 1,
  provider,
  neutral_prompt_sha256: sha256(neutralPrompt),
  compiled_prompt_sha256: sha256(legacyPrompt),
  ordered_reference_hashes: [],
};
assert.deepEqual(validate({ prompt: legacyPrompt, receipt: legacyReceipt }), []);
assert.ok(validate({ prompt: legacyPrompt, receipt: legacyReceipt, expectedCompilerVersion: 2 }).includes("compiler_receipt_version_mismatch"));
assert.notEqual(sha256(legacyPrompt), compiled.prompt_sha256);

const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-visible-text-policy-"));
try {
  const episodeDir = path.join(temporaryRoot, "episode");
  await fs.mkdir(episodeDir);
  const promptsPath = path.join(episodeDir, "prompts.json");
  await fs.writeFile(promptsPath, JSON.stringify({
    status: "passed",
    image_provider: "federated_web_image",
    prompts: [{ image_id: "cut_001", image_generation_required: true, codex_image_prompt: scenes[0], reference_slots: [] }],
  }));
  const options = {
    mode: "scene", episodeDir, promptsPath, imageIds: ["cut_001"],
    allowedBrowserProviders: [provider], browserProviderReceiptRequired: true,
  };
  const created = await createCodexWorkManifest(options);
  assert.equal(created.manifest.items[0].prompt_compiler_version, VISUAL_PROMPT_COMPILER_VERSION);
  assert.equal((await createCodexWorkManifest(options)).created, false, "same-version manifests remain reusable");
  const { created_at, manifest_id, manifest_path, content_sha256, ...content } = created.manifest;
  assert.equal(sha256(stableStringify(content)), content_sha256);
  const legacyContent = structuredClone(content);
  delete legacyContent.items[0].prompt_compiler_version;
  const legacyId = `codex-work-${sha256(stableStringify(legacyContent)).slice(0, 24)}`;
  assert.notEqual(manifest_id, legacyId, "compiler version participates in new manifest identity");

  const leased = await leaseNextWorkItem({ manifestPath: manifest_path, workerId: "text-policy-test", browserProvider: provider });
  assert.equal(leased.assignment.item.prompt_compiler_receipt.compiler_version, 2);
  assert.deepEqual(validateVisualPromptCompilerReceipt({
    prompt: leased.assignment.item.prompt,
    receipt: leased.assignment.item.prompt_compiler_receipt,
    neutralPrompt: scenes[0], provider, expectedCompilerVersion: created.manifest.items[0].prompt_compiler_version,
  }), []);
  const resumed = await leaseNextWorkItem({ manifestPath: manifest_path, workerId: "text-policy-test", browserProvider: provider });
  assert.equal(resumed.reused_existing_lease, true);
  assert.deepEqual(resumed.assignment, leased.assignment, "an existing assignment is not recompiled on resume");

  // Old unversioned items can obtain a fresh v2 assignment, but a conflicting
  // explicit pin fails before creating a live lease or attempt.
  const legacyDir = path.join(temporaryRoot, "legacy");
  const legacyCreated = await createCodexWorkManifest({ ...options, stagingRoot: legacyDir });
  delete legacyCreated.manifest.items[0].prompt_compiler_version;
  await fs.writeFile(legacyCreated.manifest.manifest_path, JSON.stringify(legacyCreated.manifest));
  const legacyLease = await leaseNextWorkItem({ manifestPath: legacyCreated.manifest.manifest_path, workerId: "legacy-test", browserProvider: provider });
  assert.equal(legacyLease.assignment.item.prompt_compiler_receipt.compiler_version, 2);
  const unsupported = await createCodexWorkManifest({ ...options, stagingRoot: path.join(temporaryRoot, "unsupported") });
  unsupported.manifest.items[0].prompt_compiler_version = 99;
  await fs.writeFile(unsupported.manifest.manifest_path, JSON.stringify(unsupported.manifest));
  await assert.rejects(() => leaseNextWorkItem({ manifestPath: unsupported.manifest.manifest_path, workerId: "unsupported-test", browserProvider: provider }), /Compiler version does not match/);
  assert.deepEqual(await fs.readdir(path.join(path.dirname(unsupported.manifest.manifest_path), "leases")), []);
  assert.deepEqual(await fs.readdir(path.join(path.dirname(unsupported.manifest.manifest_path), "attempts")), []);

  const stream = await openCodexWorkManifestStream({ ...options, stagingRoot: path.join(temporaryRoot, "stream"), streamId: "text-policy-test" });
  delete stream.manifest.items[0].prompt_compiler_version;
  await fs.writeFile(stream.manifest.manifest_path, JSON.stringify(stream.manifest));
  await assert.rejects(() => appendCodexWorkManifestStream({ ...options, manifestPath: stream.manifest.manifest_path }), /different creative contract/);
} finally {
  await fs.rm(temporaryRoot, { recursive: true, force: true });
}

process.stdout.write("visual prompt text policy tests passed\n");
