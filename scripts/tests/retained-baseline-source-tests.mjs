import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {sha256File} from '../lib/file-hash.mjs';
import {retainedBaselineSource} from '../lib/retained-baseline-source.mjs';
const root=await fs.mkdtemp(path.join(os.tmpdir(),'retained-baseline-'));
try {
 const baseline=path.join(root,'baseline'),fork=path.join(root,'fork');await fs.mkdir(baseline);await fs.mkdir(fork);
 const original=path.join(baseline,'timing.json'),copy=path.join(fork,'timing.json');await fs.writeFile(original,'old');await fs.writeFile(copy,'old');const hash=await sha256File(original);
 const receipt=path.join(fork,'receipt.json');await fs.writeFile(receipt,JSON.stringify({target_episode_dir:fork,baseline_identity_sha256:'locked',files:[{source_path:original,relative_path:'timing.json',sha256:hash}]}));
 const identity={episode_dir:fork,visual_restart:{provider:'fal_ai',baseline_episode_dir:baseline,baseline_identity_sha256:'locked',receipt_path:receipt,receipt_sha256:await sha256File(receipt)}};
 assert.equal(await retainedBaselineSource(identity,original,hash),original);
 await fs.writeFile(original,'new');assert.equal(await retainedBaselineSource(identity,original,hash),copy,'fork retains the exact copied bytes');
 await fs.writeFile(copy,'changed');await assert.rejects(retainedBaselineSource(identity,original,hash));
 await fs.writeFile(copy,'old');await fs.writeFile(receipt,'{}');await assert.rejects(retainedBaselineSource(identity,original,hash),'changed fork receipt cannot authorize copies');
 const outside=path.join(root,'outside');await fs.writeFile(outside,'wrong');await assert.rejects(retainedBaselineSource(identity,outside,hash),/outside/);
 await assert.rejects(retainedBaselineSource({},original,hash),/stale/);

 const archive=path.join(baseline,'reports/recovery/exact');await fs.mkdir(path.join(archive,'artifacts'),{recursive:true});
 const archivedIdentity=path.join(archive,'artifacts/run_identity.json');await fs.writeFile(archivedIdentity,'historical identity');const oldIdentityHash=await sha256File(archivedIdentity);
 await fs.writeFile(path.join(baseline,'run_identity.json'),JSON.stringify({narration_identity_relock:{archive_dir:archive,previous_run_identity_sha256:oldIdentityHash}}));
 const audio=path.join(baseline,'assets/audio/old.wav'),archivedAudio=path.join(archive,'old.wav');await fs.mkdir(path.dirname(audio),{recursive:true});await fs.writeFile(audio,'new audio');await fs.writeFile(archivedAudio,'old audio');const audioHash=await sha256File(archivedAudio);
 await fs.writeFile(path.join(archive,'tts_identity_relock_report.json'),JSON.stringify({schema:'goldflow_tts_identity_relock_report_v1',status:'passed',episode_dir:baseline,run_identity_before_sha256:oldIdentityHash,retained_historical_audio_assets:[{path:audio,sha256:audioHash,archived_path:archivedAudio}]}));
 assert.equal(await retainedBaselineSource(identity,audio,audioHash),archivedAudio);
 assert.equal(await retainedBaselineSource(identity,path.join(baseline,'assets/audio/lossless-alias.wav'),audioHash),archivedAudio);
 await fs.writeFile(archivedIdentity,'corrupt');await assert.rejects(retainedBaselineSource(identity,audio,audioHash));
 console.log('retained-baseline-source-tests passed');
} finally {await fs.rm(root,{recursive:true,force:true});}
