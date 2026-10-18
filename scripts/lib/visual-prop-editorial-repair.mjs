import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { exactVisualPromptRepairAdmission } from './visual-prompt-exact-repair.mjs';
import { runCodexCli } from './codex-cli-runner.mjs';

export const propRepairHash = value => createHash('sha256').update(value).digest('hex');
const bytes = value => JSON.stringify(value, null, 2)+'\n';
const need=(ok,message)=>{if(!ok)throw new Error(`Editorial prop repair: ${message}`);};
const read=async file=>{const raw=await fs.readFile(file);return {value:JSON.parse(raw),sha256:propRepairHash(raw)}};
const save=async(file,value)=>{await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,bytes(value),{flag:'wx'})};
const required=['run_identity.json','script_clean.md','visual_beat_plan.json','visual_reference_plan.json','reference_plan_approval.json','section_image_prompts.json'];
const textPath=/^(?:provider_prompt|shot_manifest\.(?:foreground_action|continuity_notes)|shot_manifest\.character_staging\[\d+\]\.pose|shot_manifest\.anatomy_contracts\[\d+\]\.(?:reason|body_invariant)|shot_manifest\.equipment_contracts\[\d+\]\.(?:hand_assignment|holder_state|contact_target|reason))$/;
const removalPath=/^shot_manifest\.(?:equipment_contracts|visible_props)\[\d+\]$/;
function fieldAt(object,field){const parts=field.replaceAll(/\[(\d+)\]/g,'.$1').split('.');let owner=object;for(const key of parts.slice(0,-1)){need(owner&&Object.hasOwn(owner,key),'unknown patch field');owner=owner[key]}const key=parts.at(-1);need(owner&&Object.hasOwn(owner,key),'unknown patch leaf');return {owner,key};}

// Applies only explicit model/editor-authored spans. No prop-specific heuristic,
// lexical prose replacement, new artwork decision or source-state rewrite.
export function applyPropRepairDecision(row,decision){
 need(decision.image_id===row.image_id&&['keep','repair'].includes(decision.disposition)&&typeof decision.reason==='string'&&decision.reason.trim(),'decision identity/disposition/reason required');
 if(decision.disposition==='keep'){need(decision.patches===undefined||(Array.isArray(decision.patches)&&!decision.patches.length),'keep must not edit');return structuredClone(row)}
 need(Array.isArray(decision.patches)&&decision.patches.length<=24,'bounded explicit patches required');
 need(decision.patches.length>0,'repair requires patches');
 const out=structuredClone(row),removals=[];
 for(const patch of decision.patches){
  need(Object.keys(patch).every(k=>['op','path','before','to'].includes(k)),'unsupported patch key');
  if(patch.op==='remove'){
   need(removalPath.test(patch.path),'removal outside declared prop/equipment arrays');
   const f=fieldAt(row,patch.path);need(JSON.stringify(f.owner[f.key])===JSON.stringify(patch.before),'stale removal');removals.push(patch);continue;
  }
  need(patch.op==='span'&&textPath.test(patch.path)&&typeof patch.before==='string'&&patch.before.length>0&&typeof patch.to==='string'&&patch.to!==patch.before,'invalid authored span');
  const f=fieldAt(out,patch.path),value=f.owner[f.key];need(typeof value==='string'&&value.split(patch.before).length===2,'span must match exactly once');
  const start=value.indexOf(patch.before);f.owner[f.key]=value.slice(0,start)+patch.to+value.slice(start+patch.before.length);
 }
 const seen=new Set();
 for(const patch of removals.sort((a,b)=>Number(b.path.match(/\[(\d+)\]$/)[1])-Number(a.path.match(/\[(\d+)\]$/)[1]))){need(!seen.has(patch.path),'duplicate removal');seen.add(patch.path);const f=fieldAt(out,patch.path);f.owner.splice(Number(f.key),1)}
 need(typeof out.provider_prompt==='string'&&out.provider_prompt.trim()&&out.provider_prompt.length<=12000,'unusable resulting prompt');
 need(row.image_prompt===row.provider_prompt&&!row.modelslab_image_prompt&&!row.codex_image_prompt,'canonical single provider variant required');
 out.image_prompt=out.provider_prompt;out.prompt_hash=propRepairHash(out.provider_prompt);return out;
}

async function inputs({episodeDir,spec,specPath,status}){
 need(exactVisualPromptRepairAdmission(status,{'episode-dir':episodeDir,'repair-spec':specPath}).allowed,'only guarded pre-harden repair is allowed');
 need(spec.schema==='goldflow_visual_prop_editorial_request_v1'&&spec.episode===path.basename(episodeDir)&&spec.reviewer&&spec.directive&&spec.source_quote,'reviewed source-bound request required');
 need(Array.isArray(spec.rows)&&spec.rows.length>0&&spec.rows.length<=1000,'explicit bounded owner scope required');
 for(const name of [...required,`visual_reference_approval_${spec.episode}.json`]){const file=path.join(episodeDir,name);need(spec.source_hashes?.[file]===propRepairHash(await fs.readFile(file)),`stale required source ${name}`)}
 for(const [file,hash] of Object.entries(spec.source_hashes)){need(path.isAbsolute(file)&&hash===propRepairHash(await fs.readFile(file)),'stale source binding')}
 const script=await fs.readFile(path.join(episodeDir,'script_clean.md'),'utf8');need(script.includes(spec.source_quote)&&spec.source_quote.length>=16,'exact source quote required');
 const {value:plan}=await read(path.join(episodeDir,'section_image_prompts.json'));
 need(plan.status==='passed'&&Array.isArray(plan.prompts),'passed prompt plan required');
 for(const [file,hash] of Object.entries(plan.source_hashes??{}))need(propRepairHash(await fs.readFile(file))===hash,'stale prompt dependency');
 const beats=(await read(path.join(episodeDir,'visual_beat_plan.json'))).value.beats;
 const byId=new Map(plan.prompts.map(r=>[r.image_id,r]));const seen=new Set();
 const rows=spec.rows.map(r=>{const row=byId.get(r.image_id);need(row&&!seen.has(r.image_id)&&row.provider_submission_required!==false&&r.old_row_sha256===propRepairHash(bytes(row)),'scope is duplicate, stale, absent or an alias');seen.add(r.image_id);return row});
 const allocationPath=path.join(episodeDir,`panel_asset_plan_${spec.episode}.json`);
 const allocation=plan.prompts.some(r=>r.panel_asset_id)?(await read(allocationPath)).value:null;
 if(allocation)need(spec.source_hashes[allocationPath]===propRepairHash(await fs.readFile(allocationPath)),'allocation binding missing');
 return {plan,rows,beats,allocation};
}
export async function authorPropRepairs({episodeDir,spec,specPath,status,repoRoot}){
 const input=await inputs({episodeDir,spec,specPath,status});
 const requestHash=propRepairHash(await fs.readFile(specPath)),root=path.join(episodeDir,'reports','prop_editorial',requestHash);
 await fs.mkdir(root,{recursive:true});const units=[];
 for(let i=0;i<input.rows.length;i+=3)units.push(input.rows.slice(i,i+3));
 let cursor=0;const results=new Array(units.length);
 const worker=async()=>{while(cursor<units.length){const i=cursor++,file=path.join(root,`chunk_${String(i+1).padStart(3,'0')}.json`);
  if(await fs.access(file).then(()=>true,()=>false)){const cached=(await read(file)).value;need(cached.request_sha256===requestHash,'changed chunk request');results[i]=cached;continue}
  const rows=units[i].map(row=>({image_id:row.image_id,provider_prompt:row.provider_prompt,shot_manifest:row.shot_manifest,source_excerpt:row.visual_beat_script_excerpt,source_action:row.visual_beat_action,artwork_order:input.allocation?.asset_orders.find(o=>o.owner_beat_id===row.visual_beat_id),covered_source:input.beats.filter(b=>input.allocation?.asset_orders.find(o=>o.owner_beat_id===row.visual_beat_id)?.beat_ids.includes(b.visual_beat_id)).map(b=>({excerpt:b.visual_beat_script_excerpt,action:b.visual_beat_action}))}));
  const prompt=`You are doing exact editorial prop-staging repair, not replanning artwork. Review every supplied owner independently. Do not automatically remove a prop merely because it is named. Keep legitimate present use, registration, document reading, signing, a required UI label, memory or already stowed ownership. Correct unsupported permanent hand occupation inherited from an earlier ownership event, especially in combat or unrelated tasks. Prioritize exact current action and source excerpts; an inherited possession field does not mandate a held pose.\nOperator direction: ${spec.directive}\nExact earlier source evidence: ${spec.source_quote}\nPreserve all unrelated wording, identities, references, action, overlays, timing and artwork allocation. Use short exact span patches only where necessary, not whole-prompt rewrites. Remove only obsolete matching equipment-contract and visible-prop entries when a prop is removed from view; synchronize affected pose, action and anatomy reason. Do not add text about the rejected prop elsewhere merely to explain it is absent. A free hand may remain naturally empty; do not invent a new physical action. Never delete the weapon or other required equipment.\nReturn JSON {decisions:[{image_id,disposition:"keep"|"repair",reason,patches:[{op:"span",path,before,to}|{op:"remove",path,before}]}]}. Every requested ID exactly once in order. Span paths: provider_prompt; shot_manifest.foreground_action; shot_manifest.continuity_notes; shot_manifest.character_staging[N].pose; shot_manifest.anatomy_contracts[N].reason; shot_manifest.equipment_contracts[N].hand_assignment/holder_state/contact_target/reason. Removal paths: shot_manifest.equipment_contracts[N] or shot_manifest.visible_props[N]. before must exactly match a unique current span (or entire array item for removal). to may be empty for deleted text. Keep decisions have no patches.\n${JSON.stringify(rows)}`;
  need(Buffer.byteLength(prompt)<=48000,'review packet exceeds fixed ceiling');
  try{const call=await runCodexCli({prompt,stageName:`${spec.episode}_visual_plan_prop_review_${String(i+1).padStart(3,'0')}`,repoRoot,outputPath:path.join(root,`chunk_${i+1}-output.txt`),planningOverrideStage:'visual_prompt_plan',timeoutMs:480000});const parsed=JSON.parse(call.content.replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,''));need(Array.isArray(parsed.decisions)&&parsed.decisions.length===units[i].length,'exact decision count required');parsed.decisions.forEach((d,j)=>applyPropRepairDecision(units[i][j],d));results[i]={status:'review_candidate',request_sha256:requestHash,decisions:parsed.decisions,output_path:call.output_path??null};}
  catch(error){results[i]={status:'failed',request_sha256:requestHash,image_ids:units[i].map(r=>r.image_id),error:error.message};}
  await save(file,results[i]);console.log(`prop editorial ${i+1}/${units.length}: ${results[i].status}`);
 }};
 await Promise.all(Array.from({length:Math.min(12,units.length)},worker));
 const candidate={schema:'goldflow_visual_prop_editorial_candidate_v1',status:results.some(r=>r.status==='failed')?'partial_requires_triage':'requires_actual_review',request_path:specPath,request_sha256:requestHash,source_hashes:spec.source_hashes,chunks:results};
 const candidatePath=path.join(root,'candidate.json');await save(candidatePath,candidate);return {status:candidate.status,candidate_path:candidatePath,owner_count:input.rows.length,failed_chunks:results.filter(r=>r.status==='failed').length};
}

export function mergeAcceptedPropRepairs(plan, reviewed, acceptedIds) {
 need(Array.isArray(acceptedIds)&&acceptedIds.length>0&&new Set(acceptedIds).size===acceptedIds.length,'distinct explicit accepted IDs required');
 const byId=new Map();
 for(const item of reviewed){need(!byId.has(item.row.image_id),'overlapping review candidates');byId.set(item.row.image_id,item)}
 const selected=new Set(acceptedIds),out=structuredClone(plan),receipts=[];
 for(const id of selected){const item=byId.get(id),index=out.prompts.findIndex(r=>r.image_id===id);need(item&&index>=0,'accepted ID not reviewed');
  const original=out.prompts[index];need(propRepairHash(bytes(original))===propRepairHash(bytes(item.row)),'accepted row changed');
  const corrected=applyPropRepairDecision(original,item.decision);out.prompts[index]=corrected;
  receipts.push({image_id:id,disposition:item.decision.disposition,reason:item.decision.reason,before_row_sha256:propRepairHash(bytes(original)),after_row_sha256:propRepairHash(bytes(corrected)),patches:item.decision.patches});
 }
 // Alias creative fields follow their accepted owner, with all beat-local
 // identity, timing, action and caption metadata retained verbatim.
 const owners=new Map(out.prompts.filter(r=>r.provider_submission_required!==false).map(r=>[r.image_id,r]));
 const creative=['provider_prompt','image_prompt','prompt_hash','shot_manifest'];
 for(let i=0;i<out.prompts.length;i++){const row=out.prompts[i];if(row.provider_submission_required!==false||!selected.has(row.panel_asset_owner_image_id))continue;
  const owner=owners.get(row.panel_asset_owner_image_id);need(owner,'alias owner missing');
  for(const key of creative)if(Object.hasOwn(owner,key))row[key]=structuredClone(owner[key]);
 }
 return {plan:out,receipts};
}

export async function acceptPropRepairs({episodeDir,spec,specPath,status}) {
 need(spec.schema==='goldflow_visual_prop_editorial_acceptance_v1'&&spec.reviewer&&spec.note&&spec.actual_review===true&&Array.isArray(spec.candidates)&&spec.candidates.length>0,'actual reviewed acceptance required');
 const reviewed=[];
 for(const ref of spec.candidates){const candidate=await read(ref.path);need(candidate.sha256===ref.sha256,'candidate hash changed');
  const request=await read(candidate.value.request_path);need(request.sha256===candidate.value.request_sha256,'request hash changed');
  const loaded=await inputs({episodeDir,spec:request.value,specPath:candidate.value.request_path,status});
  const byId=new Map(loaded.rows.map(r=>[r.image_id,r]));
  for(const chunk of candidate.value.chunks)if(chunk.status==='review_candidate')for(const decision of chunk.decisions){const row=byId.get(decision.image_id);need(row,'candidate outside reviewed request');reviewed.push({row,decision})}
 }
 const file=path.join(episodeDir,'section_image_prompts.json'),before=await read(file);
 const merged=mergeAcceptedPropRepairs(before.value,reviewed,spec.accept_image_ids);
 const root=path.join(episodeDir,'reports','prop_editorial','accepted',propRepairHash(await fs.readFile(specPath)));
 await fs.mkdir(root,{recursive:true});await save(path.join(root,'before.json'),before.value);
 merged.plan.updated_at=new Date().toISOString();merged.plan.planner={...merged.plan.planner,exact_prop_editorial_repairs:[...(merged.plan.planner?.exact_prop_editorial_repairs??[]),{reviewer:spec.reviewer,acceptance_path:specPath,acceptance_sha256:propRepairHash(await fs.readFile(specPath)),receipt_path:path.join(root,'receipt.json'),owner_count:merged.receipts.length}]};
 const receipt={schema:'goldflow_visual_prop_editorial_receipt_v1',status:'passed',reviewer:spec.reviewer,note:spec.note,candidates:spec.candidates,before_snapshot:path.join(root,'before.json'),before_plan_sha256:before.sha256,after_plan_sha256:propRepairHash(bytes(merged.plan)),rows:merged.receipts,provider_calls:0};
 await save(path.join(root,'receipt.json'),receipt);
 need((await read(file)).sha256===before.sha256,'prompt plan changed during acceptance');
 const temp=path.join(root,'after.json');await save(temp,merged.plan);await fs.rename(temp,file);
 return {status:'passed',receipt_path:path.join(root,'receipt.json'),owner_count:merged.receipts.length,provider_calls:0};
}
