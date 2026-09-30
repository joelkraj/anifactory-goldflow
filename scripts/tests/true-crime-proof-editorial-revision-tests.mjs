import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { inspectEditorialRevisionRequest } from '../true-crime-proof-editorial-revision.mjs';

// Guard-refusal fixtures only. They never create an episode, call a workflow
// preflight, invoke prepare/render, read user media, or dispatch any provider.
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'crime-editorial-guard-tests-'));
try {
  const proofDir = await fs.realpath(scratch);
  const outputDir = path.join(proofDir, 'program_review_repairs/editorial-v3');
  const base = {
    schema: 'goldflow_true_crime_editorial_revision_request_v1',
    scope: 'reference_informed_picture_and_original_underscore',
    proof_dir: proofDir,
    output_dir: outputDir,
    production_eligible: false,
    publish_allowed: false,
    authorization: {
      operator: 'Joel', user_instruction: 'lets do it',
      picture_and_sound_revision_authorized: true,
      preserve_words_voice_and_duration: true,
      note: 'Synthetic rejection test only; no media execution.',
      authorized_at: '2026-09-08T00:00:00.000Z',
    },
  };
  let number = 0;
  async function rejectWithoutWrites(request, pattern) {
    const requestPath = path.join(proofDir, `fixture-${number++}.json`);
    await fs.writeFile(requestPath, `${JSON.stringify(request)}\n`, { flag: 'wx' });
    const before = (await fs.readdir(proofDir)).sort();
    await assert.rejects(inspectEditorialRevisionRequest(requestPath), pattern);
    assert.deepEqual((await fs.readdir(proofDir)).sort(), before, 'read-only refusal must not create proof artifacts');
    await assert.rejects(fs.stat(outputDir), { code: 'ENOENT' });
  }
  await assert.rejects(inspectEditorialRevisionRequest('relative-request.json'), /absolute request/);
  await rejectWithoutWrites({ ...base, publish_allowed: true }, /exact private editorial revision scope/);
  await rejectWithoutWrites({ ...base, production_eligible: true }, /exact private editorial revision scope/);
  await rejectWithoutWrites({ ...base, scope: 'full_episode_production' }, /exact private editorial revision scope/);
  await rejectWithoutWrites({ ...base, workflow_bypass: true }, /unexpected request field/);
  await rejectWithoutWrites({ ...base, authorization: { ...base.authorization, picture_and_sound_revision_authorized: false } }, /actual latest user instruction/);
  await rejectWithoutWrites({ ...base, authorization: { ...base.authorization, preserve_words_voice_and_duration: false } }, /actual latest user instruction/);
  await rejectWithoutWrites({ ...base, authorization: { ...base.authorization, user_instruction: 'assumed permission' } }, /actual latest user instruction/);
  await rejectWithoutWrites({ ...base, authorization: { ...base.authorization, authorized_at: 'invalid date' } }, /authorization context and date/);
  await rejectWithoutWrites({ ...base, output_dir: path.join(proofDir, 'replace-prior-candidate') }, /exact new editorial-v3 directory/);
  console.log('CrimeDungeon editorial revision: private scope, explicit authorization, fixed output, and no-write refusal tests passed. No media dispatched.');
} finally {
  await fs.rm(scratch, { recursive: true, force: true });
}
