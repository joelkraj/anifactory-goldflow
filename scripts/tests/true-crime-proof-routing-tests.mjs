import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mediaWorkflowForPreflight, resolveMediaWorkflow } from '../lib/media-workflows.mjs';
import { assertCommandWorkflowRoute } from '../lib/episode-workflow-routing.mjs';
import { stageRegistryFor } from '../lib/pipeline-stage-registry.mjs';

const binding = () => mediaWorkflowForPreflight({contentProfile:'true_crime_proof_v1',mediaWorkflow:'true_crime_hybrid_proof_v1'});
const identity = () => ({...binding(),content_profile:'true_crime_proof_v1',run_intent:'proof',production_eligible:false,publish_allowed:false});

test('private proof profile and workflow require each other and never receive a legacy generated adapter',()=>{
  assert.equal(resolveMediaWorkflow(identity()).id,'true_crime_hybrid_proof_v1');
  assert.throws(()=>resolveMediaWorkflow({content_profile:'true_crime_proof_v1'}),/explicit private workflow/);
  for(const profile of ['manhwa_recap_v1','asset_afterlife_v1']){
    assert.throws(()=>mediaWorkflowForPreflight({contentProfile:profile,mediaWorkflow:'true_crime_hybrid_proof_v1'}),/exact private proof/);
  }
  assert.throws(()=>mediaWorkflowForPreflight({contentProfile:'true_crime_proof_v1',mediaWorkflow:'generated_visuals_v1'}),/exact private proof/);
  assert.throws(()=>stageRegistryFor(identity()),/dedicated private stage registry/);
});

test('generic production preflight refuses the private proof before episode creation',()=>{
  assert.throws(()=>assertCommandWorkflowRoute({command:'run',subcommand:'preflight',script:'run-preflight.mjs',flags:{'content-profile':'true_crime_proof_v1','media-workflow':'true_crime_hybrid_proof_v1'}}),/Use crime-proof preflight/);
});

test('proof routing permits only its commands and status even with workflow bypass',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'crime-proof-routing-'));
  try{
    fs.writeFileSync(path.join(dir,'run_identity.json'),JSON.stringify(identity()));
    const flags={'episode-dir':dir,'workflow-bypass':'true'};
    assert.equal(assertCommandWorkflowRoute({command:'run',subcommand:'status',script:'run-status.mjs',flags,episodeDir:dir}).id,'true_crime_hybrid_proof_v1');
    assert.equal(assertCommandWorkflowRoute({command:'crime-proof',subcommand:'status',script:'true-crime-proof.mjs',flags,episodeDir:dir}).id,'true_crime_hybrid_proof_v1');
    for(const [command,subcommand,script] of [['run','advance','run-advance.mjs'],['tts','create','tts.mjs'],['youtube','publish','youtube-publish.mjs'],['render','episode','render.mjs']]){
      assert.throws(()=>assertCommandWorkflowRoute({command,subcommand,script,flags,episodeDir:dir}),/True-crime proof permits only/);
    }
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
