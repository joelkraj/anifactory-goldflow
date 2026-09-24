#!/usr/bin/env node
import { createHash } from "node:crypto";
import { promises as fs, constants as fsConstants } from "node:fs";
import path from "node:path";
import { buildReferenceBoard, referenceBoardPromptGuidance } from "./lib/openart-reference-board.mjs";
import { falFileSha256, falObjectSha256, uploadFalReference, submitFalImage, observeFalImage, FAL_ENDPOINTS } from "./lib/fal-provider.mjs";
import { falPortableAssetId, promoteApprovedFalReferences } from "./lib/fal-portable-bank.mjs";

const digest = value => createHash("sha256").update(value).digest("hex");
const bytes = value => `${JSON.stringify(value, null, 2)}\n`;
function need(value, message) { if (!value) throw new Error(message); }
function flags(argv) { const out={}; for(let i=0;i<argv.length;i+=2){need(argv[i]?.startsWith("--")&&argv[i+1]!==undefined,"Every Fal production flag requires a value.");out[argv[i].slice(2)]=argv[i+1];} return out; }
async function read(file){return JSON.parse(await fs.readFile(file,"utf8"));}
async function absent(file){try{await fs.lstat(file);throw new Error(`Refusing to overwrite ${file}`);}catch(error){if(error.code!=="ENOENT")throw error;}}
async function write(file,value){const content=bytes(value);const prior=await fs.readFile(file,"utf8").catch(error=>{if(error.code==="ENOENT")return null;throw error;});if(prior!==null){need(prior===content,`Existing Fal artifact differs: ${file}`);return;}await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,content,{flag:"wx"});}
async function mapLimit(rows, limit, fn){const out=[];let cursor=0;async function worker(){while(cursor<rows.length){const i=cursor++;out[i]=await fn(rows[i],i);}}await Promise.all(Array.from({length:Math.min(limit,rows.length)},worker));return out;}

async function context(f){
  const episodeDir=await fs.realpath(path.resolve(f["episode-dir"])); const identity=await read(path.join(episodeDir,"run_identity.json"));
  need(identity.image_provider==="fal_ai","Fal production requires a Fal-locked identity.");
  const root=path.join(episodeDir,"fal"); return {episodeDir,identity,root,identityHash:await falFileSha256(path.join(episodeDir,"run_identity.json")),contract:identity.image_provider_options.fal};
}
async function prepareReferences(ctx){
  need(ctx.identity.visual_restart?.fork_at==="visual_reference_plan","Native Fal reference generation requires the early reference fork.");
  const plan=await read(path.join(ctx.episodeDir,"visual_reference_plan.json"));
  need(plan.status==="passed"&&Array.isArray(plan.reference_targets),"Approved visual reference plan is required.");
  const bank=await read(ctx.contract.reference_bank_manifest);
  const joey=bank.assets?.find(row=>row.asset_id==="gf.global.character.joey_manhwa"&&row.approval_state==="approved");
  need(joey?.local_absolute_path&&joey?.sha256&&await falFileSha256(joey.local_absolute_path)===joey.sha256,"Shared canonical Joey identity is unavailable or changed.");
  const targets=plan.reference_targets.filter(row=>row.required_before_imagegen===true||row.generation_mode==="standalone_ref");
  need(targets.length>0,"No standalone canonical references were selected.");
  const assignments=[];
  for(const target of targets){
    const id=String(target.ref_id??"");need(/^[a-z0-9][a-z0-9_-]{1,100}$/.test(id),`Unsafe reference ID: ${id}`);
    const output=target.conditioning_image_path??target.reference_image_path
      ??path.join(ctx.episodeDir,"assets","images","references",`${id}.png`);
    need(path.isAbsolute(output??"")&&output.startsWith(`${ctx.episodeDir}${path.sep}assets${path.sep}images${path.sep}references${path.sep}`),`Fal reference output is outside this attempt: ${id}`);
    const prompt=String(target.prompt_anchor??"").trim();need(prompt.length>60,`Fal reference prompt is missing: ${id}`);
    const reusableAsset=target.kind==="character_state"&&!target.base_asset_id&&!target.state_delta
      ?bank.assets.find(row=>row.asset_id===`gf.global.character.${target.canonical_subject_id}`&&row.approval_state==="approved")
      :null;
    if(reusableAsset)need(reusableAsset.local_absolute_path&&await falFileSha256(reusableAsset.local_absolute_path)===reusableAsset.sha256,
      `Approved global identity is unavailable or changed: ${target.canonical_subject_id}`);
    const joeyIdentity=target.kind==="character_state"&&(/(^|[_-])(joey|evan)([_-]|$)/i.test(id)||/\bJoey Manhwa\b/i.test(target.subject??""));
    const source=joeyIdentity?{asset_id:joey.asset_id,asset_class:joey.asset_class,path:joey.local_absolute_path,sha256:joey.sha256}:null;
    const core={image_id:id,ref_id:id,endpoint:reusableAsset?"local-approved-bank-reuse":source?FAL_ENDPOINTS.primary_edit:FAL_ENDPOINTS.primary_text,prompt,prompt_sha256:digest(prompt),run_identity_sha256:ctx.identityHash,reference_mode:reusableAsset?"approved_local_asset":source?"separate_ordered_references":"text_only",reference_asset_ids:reusableAsset?[reusableAsset.asset_id]:source?[source.asset_id]:[],reference_hashes:reusableAsset?[reusableAsset.sha256]:source?[source.sha256]:[],board_path:reusableAsset?.local_absolute_path??source?.path??null,board_sha256:reusableAsset?.sha256??source?.sha256??null,board_manifest_path:null,max_cost_usd:reusableAsset?0:1.0,asset_class:target.kind,subject:target.subject??null};
    const assignment={...core,assignment_sha256:falObjectSha256(JSON.stringify(core)),submission_receipt_path:path.join(ctx.root,"reference","submission-receipts",`${id}.json`),result_receipt_path:path.join(ctx.root,"reference","result-receipts",`${id}.json`),output_path:output,upload_receipt_path:path.join(ctx.root,"reference","upload-receipts",`${id}.json`)};
    const assignmentPath=path.join(ctx.root,"reference","assignments",`${id}.json`);await write(assignmentPath,assignment);assignments.push({...assignment,assignment_path:assignmentPath});
    if(reusableAsset){
      await fs.mkdir(path.dirname(output),{recursive:true});
      if(!await fs.access(output).then(()=>true,()=>false))await fs.copyFile(reusableAsset.local_absolute_path,output,fsConstants.COPYFILE_EXCL);
      need(await falFileSha256(output)===reusableAsset.sha256,"Imported approved global reference changed.");
      await write(assignment.result_receipt_path,{schema:"goldflow_fal_approved_bank_reuse_v1",image_id:id,source_asset_id:reusableAsset.asset_id,source_path:reusableAsset.local_absolute_path,source_sha256:reusableAsset.sha256,source_provider:reusableAsset.providers?.openart?"openart":reusableAsset.provider??null,source_provider_receipt_path:reusableAsset.provider_receipt_path??null,source_bank_manifest:ctx.contract.reference_bank_manifest,source_bank_manifest_sha256:ctx.contract.reference_bank_manifest_sha256,output_path:output,output_sha256:reusableAsset.sha256,model:reusableAsset.model,request_id:null,cost_usd:0,assignment_sha256:assignment.assignment_sha256});
    }
  }
  const referencePlan={schema:"goldflow_fal_reference_plan_v1",created_at:new Date().toISOString(),run_identity_sha256:ctx.identityHash,visual_reference_plan_sha256:await falFileSha256(path.join(ctx.episodeDir,"visual_reference_plan.json")),model:FAL_ENDPOINTS.primary_text,quality:"low",width:1920,height:1080,format:"png",concurrency:ctx.contract.production_concurrency,assignments};
  await write(path.join(ctx.root,"reference-plan.json"),referencePlan);
  return {status:"prepared",count:assignments.length,reused_approved_global_assets:assignments.filter(row=>row.reference_mode==="approved_local_asset").length,joey_conditioned_states:assignments.filter(row=>row.reference_mode==="separate_ordered_references").length};
}
async function finalizeReferences(ctx){
  const referencePlan=await read(path.join(ctx.root,"reference-plan.json"));
  const byId=new Map();
  for(const row of referencePlan.assignments){
    const reviewedAssignmentPath=path.join(ctx.root,"reference","review-repair-assignments",`${row.image_id}.json`);
    const reviewedReceiptPath=path.join(ctx.root,"reference","review-repair-result-receipts",`${row.image_id}.json`);
    const repairReceiptPath=path.join(ctx.root,"reference","repair-result-receipts",`${row.image_id}.json`);
    const reviewed=await fs.access(reviewedReceiptPath).then(()=>true,()=>false);
    const activeAssignment=reviewed?await read(reviewedAssignmentPath):row;
    const receipt=await read(reviewed?reviewedReceiptPath
      :await fs.access(repairReceiptPath).then(()=>repairReceiptPath,()=>row.result_receipt_path));
    need(receipt.output_path===activeAssignment.output_path&&await falFileSha256(activeAssignment.output_path)===receipt.output_sha256,
      `Fal reference result is missing or changed: ${row.ref_id}`);
    byId.set(row.ref_id,activeAssignment.output_path);
  }
  const planPath=path.join(ctx.episodeDir,"visual_reference_plan.json");
  const plan=await read(planPath);
  need(plan.status==="passed"&&plan.reference_targets?.length===referencePlan.assignments.length,
    "Fal reference materialization no longer matches the approved plan.");
  const updatedAt=new Date().toISOString();
  const updatedPlan={...plan,reference_targets:plan.reference_targets.map(target=>({
    ...target,reference_image_path:byId.get(target.ref_id),conditioning_image_path:byId.get(target.ref_id),
  })),reference_generation_updated_at:updatedAt};
  const characterPath=path.join(ctx.episodeDir,"character_state_refs.json");
  const characterRefs=await read(characterPath);
  const updatedCharacters={...characterRefs,character_state_refs:characterRefs.character_state_refs.map(ref=>({
    ...ref,reference_image_path:byId.get(ref.source_ref_id)??ref.reference_image_path??null,
    conditioning_image_path:byId.get(ref.source_ref_id)??ref.conditioning_image_path??null,
  })),reference_generation_updated_at:updatedAt};
  await fs.writeFile(planPath,bytes(updatedPlan));
  await fs.writeFile(characterPath,bytes(updatedCharacters));
  return {status:"materialized",count:byId.size,visual_reference_plan:planPath,character_state_refs:characterPath};
}
async function nativePromptReferences(ctx,row,approval){
  const requirements=[...(row.reference_requirements??[])].sort((a,b)=>Number(a.slot_order??99)-Number(b.slot_order??99)).slice(0,4);
  const referencePlan=await read(path.join(ctx.root,"reference-plan.json"));
  const approvedImports=new Map(referencePlan.assignments.filter(item=>item.reference_mode==="approved_local_asset")
    .map(item=>[item.ref_id,item.reference_asset_ids[0]]));
  const refs=[];
  for(const ref of requirements){
    const id=String(ref.ref_id??"");const localPath=ref.reference_image_path??ref.conditioning_image_path;
    need(id&&path.isAbsolute(localPath??""),`Fal prompt reference is missing an exact local path: ${row.image_id}`);
    const sha256=approval.reference_hash_by_ref_id?.[id];
    need(/^[a-f0-9]{64}$/.test(sha256??"")&&await falFileSha256(localPath)===sha256,`Fal prompt reference is not hash-approved: ${row.image_id}/${id}`);
    refs.push({asset_id:approvedImports.get(id)??falPortableAssetId(ctx.identity.series_slug,{ref_id:id,kind:ref.kind??"asset"}),asset_class:ref.kind??"asset",path:localPath,sha256});
  }
  return refs;
}
function chooseNativeValidationRows(rows){
  const eligible=rows.filter(row=>row.image_generation_required!==false);
  need(eligible.length>=8,"Fal validation needs at least eight distinct production shots.");
  const chosen=[],used=new Set();
  const pick=predicate=>{const row=eligible.find(item=>!used.has(item.image_id)&&predicate(item));if(row){used.add(row.image_id);chosen.push(row);}};
  pick(()=>true);
  pick(row=>(row.reference_requirements??[]).filter(ref=>ref.kind==="character_state").length>=2);
  pick(row=>/\b(?:father|dad|Dylan|Nolan)\b/i.test(row.provider_prompt??""));
  pick(row=>/\bMara\b/i.test(row.provider_prompt??""));
  pick(row=>/\b(?:Silas|Bell|Rook)\b/i.test(row.provider_prompt??""));
  pick(row=>/\b(?:wrist|hand|year|blue number)\b/i.test(row.provider_prompt??"")&&/close|detail|insert/i.test(row.sequence_grammar?.shot_size??row.provider_prompt??""));
  pick(row=>/wide|establish/i.test(row.sequence_grammar?.shot_size??row.suggested_shot_job??""));
  pick(row=>(row.reference_requirements??[]).length>=4);
  for(const row of eligible)if(chosen.length<8&&!used.has(row.image_id)){used.add(row.image_id);chosen.push(row);}
  return chosen;
}
async function prepare(ctx){
  if(ctx.identity.visual_restart?.fork_at==="visual_reference_plan"){
    const hardened=await read(path.join(ctx.episodeDir,"section_image_prompts_hardened.json"));const approval=await read(path.join(ctx.episodeDir,`visual_reference_approval_${ctx.identity.episode}.json`));
    need(approval.status==="approved", "Fal validation requires approved canonical references.");
    const portableBank=await promoteApprovedFalReferences({episodeDir:ctx.episodeDir,identity:ctx.identity,contract:ctx.contract,approval});
    const assignments=[];
    for(const row of chooseNativeValidationRows(hardened.prompts)){
      const refs=await nativePromptReferences(ctx,row,approval);
      const board=refs.length?await buildReferenceBoard({root:ctx.root,imageId:row.image_id,references:refs}):null;
      const basePrompt=row.provider_prompt??row.image_prompt;need(basePrompt,`Fal validation prompt missing: ${row.image_id}`);
      const prompt=board?`${basePrompt}\n\n${referenceBoardPromptGuidance(board)}`:basePrompt;
      const core={image_id:row.image_id,endpoint:board?FAL_ENDPOINTS.primary_edit:FAL_ENDPOINTS.primary_text,prompt,prompt_sha256:digest(prompt),run_identity_sha256:ctx.identityHash,reference_mode:board?"one_positional_collage":"text_only",reference_asset_ids:refs.map(r=>r.asset_id),reference_hashes:refs.map(r=>r.sha256),board_path:board?.output_path??null,board_sha256:board?.output_sha256??null,board_manifest_path:board?.manifest_path??null,max_cost_usd:1.0};
      const assignment={...core,assignment_sha256:falObjectSha256(JSON.stringify(core)),submission_receipt_path:path.join(ctx.root,"submission-receipts",`${row.image_id}.json`),result_receipt_path:path.join(ctx.root,"result-receipts",`${row.image_id}.json`),output_path:path.join(ctx.root,"validation-results",`${row.image_id}.png`),upload_receipt_path:path.join(ctx.root,"upload-receipts",`${row.image_id}.json`),checks:["identity consistency","hands","prop fidelity","composition","unwanted text"]};
      const assignmentPath=path.join(ctx.root,"validation-assignments",`${row.image_id}.json`);await write(assignmentPath,assignment);assignments.push({...assignment,assignment_path:assignmentPath});
    }
    const plan={schema:"goldflow_fal_validation_plan_v1",created_at:new Date().toISOString(),run_identity_sha256:ctx.identityHash,source_prompt_plan_sha256:await falFileSha256(path.join(ctx.episodeDir,"section_image_prompts_hardened.json")),model:FAL_ENDPOINTS.primary_edit,quality:"low",width:1920,height:1080,format:"png",normal_reference_mode:"one_positional_collage",concurrency:8,assignments};
    await write(path.join(ctx.root,"validation-plan.json"),plan);return {status:"prepared",count:assignments.length,image_ids:assignments.map(row=>row.image_id),portable_bank:portableBank};
  }
  const catalog=await read(path.join(ctx.root,"catalog.json")); const bank=await read(ctx.contract.reference_bank_manifest);
  const approved=new Map(bank.assets.filter(row=>row.approval_state==="approved").map(row=>[row.asset_id,row])); const assignments=[];
  for(const shot of catalog.validation_shots){
    let ids=[...shot.reference_asset_ids]; if(ids.length>4) ids=ids.filter(id=>!id.includes("location.")).slice(0,4);
    const refs=ids.map(id=>{const row=approved.get(id);need(row?.local_absolute_path&&row?.sha256,`Approved canonical asset missing: ${id}`);return {asset_id:id,asset_class:row.asset_class,path:row.local_absolute_path,sha256:row.sha256};});
    const board=await buildReferenceBoard({root:ctx.root,imageId:shot.image_id,references:refs});
    const prompt=`${shot.prompt}\n\n${referenceBoardPromptGuidance(board)}`; const core={image_id:shot.image_id,endpoint:FAL_ENDPOINTS.primary_edit,prompt,prompt_sha256:digest(prompt),run_identity_sha256:ctx.identityHash,reference_mode:"one_positional_collage",reference_asset_ids:refs.map(r=>r.asset_id),reference_hashes:refs.map(r=>r.sha256),board_path:board.output_path,board_sha256:board.output_sha256,board_manifest_path:board.manifest_path,max_cost_usd:1.0};
    const assignment={...core,assignment_sha256:falObjectSha256(JSON.stringify(core)),submission_receipt_path:path.join(ctx.root,"submission-receipts",`${shot.image_id}.json`),result_receipt_path:path.join(ctx.root,"result-receipts",`${shot.image_id}.json`),output_path:path.join(ctx.root,"validation-results",`${shot.image_id}.png`),upload_receipt_path:path.join(ctx.root,"upload-receipts",`${shot.image_id}.json`),checks:shot.checks};
    const assignmentPath=path.join(ctx.root,"validation-assignments",`${shot.image_id}.json`);await write(assignmentPath,assignment);assignments.push({...assignment,assignment_path:assignmentPath});
  }
  const plan={schema:"goldflow_fal_validation_plan_v1",created_at:new Date().toISOString(),run_identity_sha256:ctx.identityHash,reference_bank_manifest:ctx.contract.reference_bank_manifest,reference_bank_manifest_sha256:ctx.contract.reference_bank_manifest_sha256,model:FAL_ENDPOINTS.primary_edit,quality:"low",width:1920,height:1080,format:"png",normal_reference_mode:"one_positional_collage",concurrency:8,assignments};
  await write(path.join(ctx.root,"validation-plan.json"),plan);return {status:"prepared",count:assignments.length};
}
async function prepareBulk(ctx,f){
  const prompts=await read(path.join(ctx.episodeDir,"section_image_prompts_hardened.json"));
  const requested=String(f["image-ids"]??"all").split(",").filter(Boolean); const wanted=requested[0]==="all"?null:new Set(requested);
  const rows=prompts.prompts.filter(row=>row.image_generation_required!==false&&(!wanted||wanted.has(row.image_id))); need(rows.length,"No requested Fal bulk images found.");
  const assignments=[];
  const nativeFal=ctx.identity.visual_restart?.fork_at==="visual_reference_plan";
  const approval=nativeFal?await read(path.join(ctx.episodeDir,`visual_reference_approval_${ctx.identity.episode}.json`)):null;
  const validation=nativeFal?await read(path.join(ctx.root,"validation-plan.json")):null;
  const validationReview=nativeFal?await read(path.join(ctx.root,"validation-review.json")):null;
  for(const row of rows){
    const refs=nativeFal?await nativePromptReferences(ctx,row,approval):(row.reference_bindings??[]).slice(0,4).map(ref=>({asset_id:ref.asset_id,asset_class:ref.asset_class,path:ref.portable_file?.path??ref.path,sha256:ref.portable_file?.sha256??ref.sha256}));
    need(refs.every(ref=>ref.path&&ref.sha256),`Portable reference binding missing for ${row.image_id}.`);
    const board=refs.length?await buildReferenceBoard({root:path.join(ctx.root,"bulk"),imageId:row.image_id,references:refs}):null;
    const basePrompt=row.provider_prompt??row.image_prompt??row.canonical_prompt; need(basePrompt,`Prompt missing for ${row.image_id}.`);
    const prompt=board?`${basePrompt}\n\n${referenceBoardPromptGuidance(board)}`:basePrompt;
    const core={image_id:row.image_id,endpoint:board?FAL_ENDPOINTS.primary_edit:FAL_ENDPOINTS.primary_text,prompt,prompt_sha256:digest(prompt),run_identity_sha256:ctx.identityHash,reference_mode:board?"one_positional_collage":"text_only",reference_asset_ids:refs.map(r=>r.asset_id),reference_hashes:refs.map(r=>r.sha256),board_path:board?.output_path??null,board_sha256:board?.output_sha256??null,board_manifest_path:board?.manifest_path??null,max_cost_usd:0.05,start_sec:row.start_sec,duration_sec:row.duration_sec};
    const acceptedValidation=validation?.assignments?.find(item=>item.image_id===row.image_id&&validationReview?.approved_ids?.includes(item.image_id));
    if(acceptedValidation){
      need(acceptedValidation.prompt_sha256===core.prompt_sha256&&acceptedValidation.board_sha256===core.board_sha256&&JSON.stringify(acceptedValidation.reference_hashes)===JSON.stringify(core.reference_hashes),`Accepted Fal validation shot changed before bulk reuse: ${row.image_id}`);
      need(await fs.access(acceptedValidation.result_receipt_path).then(()=>true,()=>false),`Accepted Fal validation result is missing: ${row.image_id}`);
      assignments.push({...acceptedValidation,reused_validation_shot:true,start_sec:row.start_sec,duration_sec:row.duration_sec});
      continue;
    }
    const assignment={...core,assignment_sha256:falObjectSha256(JSON.stringify(core)),submission_receipt_path:path.join(ctx.root,"bulk","submission-receipts",`${row.image_id}.json`),result_receipt_path:path.join(ctx.root,"bulk","result-receipts",`${row.image_id}.json`),output_path:path.join(ctx.root,"bulk","outputs",`${row.image_id}.png`),upload_receipt_path:path.join(ctx.root,"bulk","upload-receipts",`${row.image_id}.json`)};
    const assignmentPath=path.join(ctx.root,"bulk","assignments",`${row.image_id}.json`);await write(assignmentPath,assignment);assignments.push({...assignment,assignment_path:assignmentPath});
  }
  const projectedBase=Number((assignments.filter(row=>!row.reused_validation_shot).length*0.00441).toFixed(4)); need(projectedBase<=ctx.contract.hard_budget_usd,"Projected Fal base cost exceeds the locked episode hard budget.");
  const plan={schema:"goldflow_fal_bulk_plan_v1",created_at:new Date().toISOString(),run_identity_sha256:ctx.identityHash,model:FAL_ENDPOINTS.primary_edit,quality:"low",width:1920,height:1080,format:"png",reference_mode:"one_positional_collage",concurrency:ctx.contract.production_concurrency,assignment_count:assignments.length,projected_base_cost_usd:projectedBase,pricing_note:"Official endpoint base price at preparation; input-image token charges may increase actual cost.",assignments};
  await write(path.join(ctx.root,"bulk-plan.json"),plan);return {status:"prepared",count:assignments.length,projected_base_cost_usd:projectedBase};
}
async function submitRows(ctx,rows,limit){return mapLimit(rows,limit,async row=>{if(!row.board_path)return submitFalImage({assignment:row,referenceUrls:[],receiptPath:row.submission_receipt_path});const upload=await uploadFalReference({localPath:row.board_path,expectedSha256:row.board_sha256,receiptPath:row.upload_receipt_path});try{return await submitFalImage({assignment:row,referenceUrls:[upload.remoteUrl],receiptPath:row.submission_receipt_path});}finally{upload.remoteUrl=null;}});}
async function observeRows(ctx,rows,limit){return mapLimit(rows,limit,async row=>{const receipt=await read(row.submission_receipt_path);try{return await observeFalImage({endpoint:receipt.endpoint,requestId:receipt.request_id,outputPath:row.output_path,receiptPath:row.result_receipt_path});}catch(error){const timedOut=error?.name==="TimeoutError"||/aborted due to timeout/i.test(error?.message??"");const stale=Date.now()-Date.parse(receipt.submitted_at)>15*60_000;if(timedOut&&!stale)return {complete:false,transient_observation_timeout:true,request_id:receipt.request_id};if(timedOut||Number(error?.status)>=500||/Gateway Timeout|Internal Server Error/i.test(error?.message??"")){const holdPath=path.join(path.dirname(path.dirname(row.result_receipt_path)),"transport-holds",`${row.image_id}.json`);if(!await fs.access(holdPath).then(()=>true,()=>false))await write(holdPath,{schema:"goldflow_fal_transport_hold_v1",created_at:new Date().toISOString(),image_id:row.image_id,endpoint:receipt.endpoint,request_id:receipt.request_id,assignment_sha256:row.assignment_sha256,provider_queue_status:"unknown_or_completed",reason:timedOut?"stale_observation_timeout":"provider_5xx_during_observation",billable_request_resubmitted:false});return {complete:false,transport_pending:true,request_id:receipt.request_id,hold_path:holdPath};}if(error?.status!==422)throw error;const failurePath=path.join(path.dirname(path.dirname(row.result_receipt_path)),"failure-receipts",`${row.image_id}.json`);const failure={schema:"goldflow_fal_exact_failure_v1",created_at:new Date().toISOString(),image_id:row.image_id,endpoint:receipt.endpoint,request_id:receipt.request_id,assignment_sha256:row.assignment_sha256,error_status:error.status,error_type:error.body?.detail?.[0]?.type??"unprocessable_entity",error_message:error.body?.detail?.[0]?.msg??error.message,automatic_retry:false,automatic_failover:false};await write(failurePath,failure);return {complete:false,failed:true,failure_path:failurePath};}});}
async function main(){
 const f=flags(process.argv.slice(2)); const ctx=await context(f); const action=f.action;
 if(action==="prepare-references") return console.log(JSON.stringify(await prepareReferences(ctx),null,2));
 if(action==="billing-submit-reference"||action==="billing-observe-reference"){
   const plan=await read(path.join(ctx.root,"reference-plan.json"));const row=plan.assignments.find(item=>item.image_id===f["image-id"]);need(row,`Unknown exact Fal reference probe: ${f["image-id"]}`);
   if(action==="billing-submit-reference"){
     need(f["confirm-spend"]==="exact_fal_reference_probe","Paid Fal reference probe requires exact confirmation token.");
     need(!await fs.access(row.submission_receipt_path).then(()=>true,()=>false),"Fal reference probe is already submitted.");
     const result=await submitRows(ctx,[row],1);return console.log(JSON.stringify({status:"submitted",image_id:row.image_id,request_id:result[0].request_id},null,2));
   }
   const result=await observeRows(ctx,[row],1);return console.log(JSON.stringify({status:result[0].complete?"complete":"pending",image_id:row.image_id,result:result[0]},null,2));
 }
 if(action==="dispatch-references"){
   need(f["confirm-spend"]==="exact_fal_reference_batch","Paid reference dispatch requires exact confirmation token.");const plan=await read(path.join(ctx.root,"reference-plan.json"));const limit=Math.min(Number(f.limit??100),100);need(Number.isInteger(limit)&&limit>0,"Reference limit must be 1..100.");const rows=[];for(const row of plan.assignments)if(!await fs.access(row.submission_receipt_path).then(()=>true,()=>false)){rows.push(row);if(rows.length===limit)break;}const result=await submitRows(ctx,rows,ctx.contract.production_concurrency);return console.log(JSON.stringify({status:"submitted",count:result.length},null,2));
 }
 if(action==="observe-references"){
   const plan=await read(path.join(ctx.root,"reference-plan.json"));const rows=[];for(const row of plan.assignments){
     const submitted=await fs.access(row.submission_receipt_path).then(()=>true,()=>false);
     const done=await fs.access(row.result_receipt_path).then(()=>true,()=>false);
     const failed=await fs.access(path.join(ctx.root,"reference","failure-receipts",`${row.image_id}.json`)).then(()=>true,()=>false);
     const held=await fs.access(path.join(ctx.root,"reference","transport-holds",`${row.image_id}.json`)).then(()=>true,()=>false);
     if(submitted&&!done&&!failed&&!held)rows.push(row);
   }
   const result=await observeRows(ctx,rows,ctx.contract.production_concurrency);return console.log(JSON.stringify({status:result.every(r=>r.complete)?"complete":"pending",checked:result.length,complete:result.filter(r=>r.complete).length,pending:result.filter(r=>!r.complete).length},null,2));
 }
 if(action==="repair-reference-failures"){
   need(f["confirm-spend"]==="exact_fal_reference_repair","Paid reference repair requires exact confirmation token.");
   need(path.isAbsolute(f.directives??""),"Reference repair requires an absolute --directives file.");
   const plan=await read(path.join(ctx.root,"reference-plan.json"));const directives=await read(f.directives);
   need(directives?.schema==="goldflow_fal_reference_repair_directives_v1"&&Array.isArray(directives.repairs)&&directives.repairs.length,
     "Exact Fal reference repair directives are required.");
   const repairs=[];
   for(const directive of directives.repairs){
     const original=plan.assignments.find(row=>row.image_id===directive.image_id);
     need(original&&directive.original_assignment_sha256===original.assignment_sha256,
       `Reference repair binding changed for ${directive.image_id}`);
     need(await fs.access(path.join(ctx.root,"reference","failure-receipts",`${directive.image_id}.json`)).then(()=>true,()=>false),
       `No exact reference failure exists for ${directive.image_id}`);
     need(typeof directive.replacement_prompt==="string"&&directive.replacement_prompt.length>40
       &&digest(directive.replacement_prompt)!==original.prompt_sha256&&directive.repair_reason,
       `Reference repair must have a changed prompt and reason: ${directive.image_id}`);
     const core={...original,prompt:directive.replacement_prompt,prompt_sha256:digest(directive.replacement_prompt),
       previous_assignment_sha256:original.assignment_sha256,repair_reason:directive.repair_reason};
     for(const key of ["assignment_sha256","assignment_path","submission_receipt_path","result_receipt_path","upload_receipt_path"])delete core[key];
     const repair={...core,assignment_sha256:falObjectSha256(JSON.stringify(core)),
       submission_receipt_path:path.join(ctx.root,"reference","repair-submission-receipts",`${directive.image_id}.json`),
       result_receipt_path:path.join(ctx.root,"reference","repair-result-receipts",`${directive.image_id}.json`),
       upload_receipt_path:path.join(ctx.root,"reference","repair-upload-receipts",`${directive.image_id}.json`)};
     await write(path.join(ctx.root,"reference","repair-assignments",`${directive.image_id}.json`),repair);
     repairs.push(repair);
   }
   const result=await submitRows(ctx,repairs,Math.min(ctx.contract.production_concurrency,repairs.length));
   return console.log(JSON.stringify({status:"reference_repair_submitted",count:result.length,image_ids:repairs.map(row=>row.image_id)},null,2));
 }
 if(action==="observe-reference-repairs"){
   const dir=path.join(ctx.root,"reference","repair-assignments");const names=await fs.readdir(dir);const rows=[];
   for(const name of names.filter(value=>value.endsWith(".json"))){const row=await read(path.join(dir,name));
     if(!await fs.access(row.result_receipt_path).then(()=>true,()=>false))rows.push(row);}
   const result=await observeRows(ctx,rows,ctx.contract.production_concurrency);
   return console.log(JSON.stringify({status:result.every(row=>row.complete)?"complete":"pending",checked:result.length,
     complete:result.filter(row=>row.complete).length,pending:result.filter(row=>!row.complete).length},null,2));
 }
 if(action==="repair-reviewed-references"){
   need(f["confirm-spend"]==="exact_fal_reviewed_reference_repair","Paid visual reference repair requires exact confirmation token.");
   const reviewPath=path.join(ctx.root,"reference","review-rejections.json");
   const review=await read(reviewPath);need(review?.schema==="goldflow_fal_reference_visual_review_v1"
     &&Array.isArray(review.rejections)&&review.rejections.length,"Exact visual review rejection receipt is required.");
   const plan=await read(path.join(ctx.root,"reference-plan.json"));const repairs=[];
   for(const finding of review.rejections){
     const original=plan.assignments.find(row=>row.image_id===finding.image_id);
     need(original&&finding.original_assignment_sha256===original.assignment_sha256,
       `Visual repair identity changed for ${finding.image_id}`);
     const originalRepairReceiptPath=path.join(ctx.root,"reference","repair-result-receipts",`${original.image_id}.json`);
     const originalReceiptPath=await fs.access(originalRepairReceiptPath).then(()=>originalRepairReceiptPath,
       ()=>original.result_receipt_path);
     const originalReceipt=await read(originalReceiptPath);
     need(originalReceipt.output_sha256===finding.rejected_sha256
       &&await falFileSha256(originalReceipt.output_path)===finding.rejected_sha256,
       `Visual review source changed for ${finding.image_id}`);
     need(typeof finding.replacement_prompt==="string"&&finding.replacement_prompt.length>40
       &&digest(finding.replacement_prompt)!==original.prompt_sha256&&finding.finding,
       `Visual repair prompt or finding is missing for ${finding.image_id}`);
     let source=null;
     if(finding.reference_image_id){
       const sourceAssignment=plan.assignments.find(row=>row.image_id===finding.reference_image_id);
       need(sourceAssignment&&sourceAssignment.image_id!==original.image_id,
         `Invalid visual repair source for ${finding.image_id}`);
       const sourceRepairReceiptPath=path.join(ctx.root,"reference","repair-result-receipts",`${sourceAssignment.image_id}.json`);
       const sourceReceiptPath=await fs.access(sourceRepairReceiptPath).then(()=>sourceRepairReceiptPath,
         ()=>sourceAssignment.result_receipt_path);
       const sourceReceipt=await read(sourceReceiptPath);
       need(sourceReceipt.output_sha256===finding.reference_sha256
         &&await falFileSha256(sourceReceipt.output_path)===finding.reference_sha256,
         `Visual repair reference changed for ${finding.image_id}`);
       source={asset_id:falPortableAssetId(ctx.identity.series_slug,{ref_id:sourceAssignment.ref_id,kind:sourceAssignment.asset_class}),
         path:sourceReceipt.output_path,sha256:sourceReceipt.output_sha256};
     }
     const core={...original,endpoint:source?FAL_ENDPOINTS.primary_edit:FAL_ENDPOINTS.primary_text,
       prompt:finding.replacement_prompt,prompt_sha256:digest(finding.replacement_prompt),
       reference_mode:source?"separate_ordered_references":"text_only",
       reference_asset_ids:source?[source.asset_id]:[],reference_hashes:source?[source.sha256]:[],
       board_path:source?.path??null,board_sha256:source?.sha256??null,
       previous_assignment_sha256:original.assignment_sha256,rejected_image_sha256:finding.rejected_sha256,
       repair_reason:finding.finding,visual_review_path:reviewPath,
       output_path:path.join(ctx.episodeDir,"assets","images","reference-repairs",`${finding.image_id}-v2.png`)};
     for(const key of ["assignment_sha256","assignment_path","submission_receipt_path","result_receipt_path","upload_receipt_path"])delete core[key];
     const repair={...core,assignment_sha256:falObjectSha256(JSON.stringify(core)),
       submission_receipt_path:path.join(ctx.root,"reference","review-repair-submission-receipts",`${finding.image_id}.json`),
       result_receipt_path:path.join(ctx.root,"reference","review-repair-result-receipts",`${finding.image_id}.json`),
       upload_receipt_path:path.join(ctx.root,"reference","review-repair-upload-receipts",`${finding.image_id}.json`)};
     await write(path.join(ctx.root,"reference","review-repair-assignments",`${finding.image_id}.json`),repair);
     repairs.push(repair);
   }
   const result=await submitRows(ctx,repairs,Math.min(ctx.contract.production_concurrency,repairs.length));
   return console.log(JSON.stringify({status:"reviewed_reference_repairs_submitted",count:result.length,
     image_ids:repairs.map(row=>row.image_id)},null,2));
 }
 if(action==="observe-reviewed-references"){
   const dir=path.join(ctx.root,"reference","review-repair-assignments");const names=await fs.readdir(dir);const rows=[];
   for(const name of names.filter(value=>value.endsWith(".json"))){const row=await read(path.join(dir,name));
     if(!await fs.access(row.result_receipt_path).then(()=>true,()=>false))rows.push(row);}
   const result=await observeRows(ctx,rows,ctx.contract.production_concurrency);
   return console.log(JSON.stringify({status:result.every(row=>row.complete)?"complete":"pending",checked:result.length,
     complete:result.filter(row=>row.complete).length,pending:result.filter(row=>!row.complete).length},null,2));
 }
 if(action==="finalize-reviewed-references") return console.log(JSON.stringify(await finalizeReferences(ctx),null,2));
 if(action==="finalize-references") return console.log(JSON.stringify(await finalizeReferences(ctx),null,2));
 if(action==="prepare-validation") return console.log(JSON.stringify(await prepare(ctx),null,2));
 if(action==="prepare-bulk") return console.log(JSON.stringify(await prepareBulk(ctx,f),null,2));
 if(action==="dispatch-bulk"){
   need(f["confirm-spend"]==="exact_fal_bulk_batch","Paid bulk dispatch requires exact confirmation token.");const bulk=await read(path.join(ctx.root,"bulk-plan.json"));const limit=Math.min(Number(f.limit??100),100);need(Number.isInteger(limit)&&limit>0,"Bulk limit must be 1..100.");const rows=[];for(const row of bulk.assignments)if(!await fs.access(row.submission_receipt_path).then(()=>true,()=>false)){rows.push(row);if(rows.length===limit)break;}const result=await submitRows(ctx,rows,ctx.contract.production_concurrency);return console.log(JSON.stringify({status:"submitted",count:result.length,remaining:bulk.assignments.length-(await Promise.all(bulk.assignments.map(row=>fs.access(row.submission_receipt_path).then(()=>1,()=>0)))).reduce((a,b)=>a+b,0)},null,2));
 }
 if(action==="repair-failures"){
   need(f["confirm-spend"]==="exact_fal_repair_batch","Paid repair dispatch requires exact confirmation token.");need(path.isAbsolute(f.directives??""),"Repair dispatch requires an absolute --directives file.");
   const bulk=await read(path.join(ctx.root,"bulk-plan.json"));const directives=await read(f.directives);need(directives?.schema==="goldflow_fal_repair_directives_v1"&&Array.isArray(directives.repairs)&&directives.repairs.length,"Exact repair directives are required.");const repairs=[];
   for(const directive of directives.repairs){const original=bulk.assignments.find(row=>row.image_id===directive.image_id);need(original&&directive.original_assignment_sha256===original.assignment_sha256,`Repair binding changed for ${directive.image_id}.`);const failurePath=path.join(ctx.root,"bulk","failure-receipts",`${directive.image_id}.json`);need(await fs.access(failurePath).then(()=>true,()=>false),`No exact failure exists for ${directive.image_id}.`);need(typeof directive.replacement_prompt==="string"&&directive.replacement_prompt.length>40,"Repair prompt is missing.");const core={...original,prompt:directive.replacement_prompt,prompt_sha256:digest(directive.replacement_prompt),previous_assignment_sha256:original.assignment_sha256,repair_reason:directive.repair_reason};for(const key of ["assignment_sha256","assignment_path","submission_receipt_path","result_receipt_path","output_path","upload_receipt_path"])delete core[key];const repair={...core,assignment_sha256:falObjectSha256(JSON.stringify(core)),submission_receipt_path:path.join(ctx.root,"bulk","repair-submission-receipts",`${directive.image_id}.json`),result_receipt_path:path.join(ctx.root,"bulk","repair-result-receipts",`${directive.image_id}.json`),output_path:original.output_path,upload_receipt_path:path.join(ctx.root,"bulk","repair-upload-receipts",`${directive.image_id}.json`)};const assignmentPath=path.join(ctx.root,"bulk","repair-assignments",`${directive.image_id}.json`);await write(assignmentPath,repair);repairs.push(repair);}
   const result=await submitRows(ctx,repairs,Math.min(ctx.contract.production_concurrency,repairs.length));return console.log(JSON.stringify({status:"repair_submitted",count:result.length,image_ids:repairs.map(r=>r.image_id)},null,2));
 }
 if(action==="observe-repairs"){
   const dir=path.join(ctx.root,"bulk","repair-assignments");const names=await fs.readdir(dir);const rows=[];for(const name of names.filter(n=>n.endsWith(".json"))){const row=await read(path.join(dir,name));if(!await fs.access(row.result_receipt_path).then(()=>true,()=>false))rows.push(row);}const result=await observeRows(ctx,rows,ctx.contract.production_concurrency);return console.log(JSON.stringify({status:result.every(r=>r.complete)?"complete":"pending",checked:result.length,complete:result.filter(r=>r.complete).length,pending:result.filter(r=>!r.complete).length},null,2));
 }
 if(action==="observe-bulk"){
   const bulk=await read(path.join(ctx.root,"bulk-plan.json"));const limit=Math.min(Number(f.limit??100),100);const rows=[];for(const row of bulk.assignments){const submitted=await fs.access(row.submission_receipt_path).then(()=>true,()=>false),done=await fs.access(row.result_receipt_path).then(()=>true,()=>false),failed=await fs.access(path.join(ctx.root,"bulk","failure-receipts",`${row.image_id}.json`)).then(()=>true,()=>false),held=await fs.access(path.join(ctx.root,"bulk","transport-holds",`${row.image_id}.json`)).then(()=>true,()=>false);if(submitted&&!done&&!failed&&!held){rows.push(row);if(rows.length===limit)break;}}const result=await observeRows(ctx,rows,ctx.contract.production_concurrency);return console.log(JSON.stringify({status:result.every(r=>r.complete||r.failed||r.transport_pending)?"observed":"pending",checked:result.length,complete:result.filter(r=>r.complete).length,failed:result.filter(r=>r.failed).length,held:result.filter(r=>r.transport_pending).length,pending:result.filter(r=>!r.complete&&!r.failed&&!r.transport_pending).length},null,2));
 }
 if(action==="observe-holds"){
   const bulk=await read(path.join(ctx.root,"bulk-plan.json"));const rows=[];for(const row of bulk.assignments){const held=await fs.access(path.join(ctx.root,"bulk","transport-holds",`${row.image_id}.json`)).then(()=>true,()=>false),done=await fs.access(row.result_receipt_path).then(()=>true,()=>false),recovered=await fs.access(path.join(ctx.root,"bulk","transport-recovery-result-receipts",`${row.image_id}.json`)).then(()=>true,()=>false);if(held&&!done&&!recovered)rows.push(row);}const result=await observeRows(ctx,rows,ctx.contract.production_concurrency);for(let i=0;i<rows.length;i++){const row=rows[i],observed=result[i];await write(path.join(ctx.root,"bulk","hold-observation-receipts",`${row.image_id}.json`),{schema:"goldflow_fal_hold_observation_v1",observed_at:new Date().toISOString(),image_id:row.image_id,original_assignment_sha256:row.assignment_sha256,original_request_id:(await read(row.submission_receipt_path)).request_id,complete:observed.complete===true,transport_pending:observed.transport_pending===true,transient_observation_timeout:observed.transient_observation_timeout===true});}return console.log(JSON.stringify({status:result.every(r=>r.complete)?"complete":"pending",checked:result.length,complete:result.filter(r=>r.complete).length,pending:result.filter(r=>!r.complete).length},null,2));
 }
 if(action==="recover-holds"){
   need(f["confirm-spend"]==="exact_fal_transport_recovery","Paid transport recovery requires exact confirmation token.");need(path.isAbsolute(f.directives??""),"Transport recovery requires an absolute --directives file.");
   const bulk=await read(path.join(ctx.root,"bulk-plan.json"));const directives=await read(f.directives);need(directives?.schema==="goldflow_fal_transport_recovery_directives_v1"&&Array.isArray(directives.recoveries)&&directives.recoveries.length,"Exact transport recovery directives are required.");const recoveries=[];
   for(const directive of directives.recoveries){const original=bulk.assignments.find(row=>row.image_id===directive.image_id);need(original&&directive.original_assignment_sha256===original.assignment_sha256,`Transport recovery binding changed for ${directive.image_id}.`);const hold=await read(path.join(ctx.root,"bulk","transport-holds",`${directive.image_id}.json`));need(hold.request_id===directive.original_request_id,`Transport recovery request ID changed for ${directive.image_id}.`);const core={...original,previous_request_id:hold.request_id,transport_recovery_reason:directive.recovery_reason};for(const key of ["assignment_sha256","assignment_path","submission_receipt_path","result_receipt_path","output_path","upload_receipt_path"])delete core[key];const recovery={...core,assignment_sha256:falObjectSha256(JSON.stringify(core)),submission_receipt_path:path.join(ctx.root,"bulk","transport-recovery-submission-receipts",`${directive.image_id}.json`),result_receipt_path:path.join(ctx.root,"bulk","transport-recovery-result-receipts",`${directive.image_id}.json`),output_path:original.output_path,upload_receipt_path:path.join(ctx.root,"bulk","transport-recovery-upload-receipts",`${directive.image_id}.json`)};const assignmentPath=path.join(ctx.root,"bulk","transport-recovery-assignments",`${directive.image_id}.json`);await write(assignmentPath,recovery);recoveries.push(recovery);}
   const result=await submitRows(ctx,recoveries,Math.min(ctx.contract.production_concurrency,recoveries.length));return console.log(JSON.stringify({status:"transport_recovery_submitted",count:result.length,image_ids:recoveries.map(r=>r.image_id)},null,2));
 }
 if(action==="observe-transport-recovery"){
   const dir=path.join(ctx.root,"bulk","transport-recovery-assignments");const names=await fs.readdir(dir);const rows=[];for(const name of names.filter(n=>n.endsWith(".json"))){const row=await read(path.join(dir,name));if(!await fs.access(row.result_receipt_path).then(()=>true,()=>false))rows.push(row);}const result=await observeRows(ctx,rows,ctx.contract.production_concurrency);return console.log(JSON.stringify({status:result.every(r=>r.complete)?"complete":"pending",checked:result.length,complete:result.filter(r=>r.complete).length,pending:result.filter(r=>!r.complete).length},null,2));
 }
 if(action==="finalize-bulk"){
   const bulk=await read(path.join(ctx.root,"bulk-plan.json"));const planPath=path.join(ctx.episodeDir,"section_image_prompts_hardened.json");const plan=await read(planPath);const promptHash=await falFileSha256(planPath);const promptById=new Map(plan.prompts.map(row=>[row.image_id,row]));const results=[];const cuts=[];
   for(const row of bulk.assignments){const receiptCandidates=[row.result_receipt_path,path.join(ctx.root,"bulk","transport-recovery-result-receipts",`${row.image_id}.json`),path.join(ctx.root,"bulk","repair-result-receipts",`${row.image_id}.json`)];let receiptPath=null;for(const candidate of receiptCandidates)if(await fs.access(candidate).then(()=>true,()=>false)){receiptPath=candidate;break;}need(receiptPath,`Final Fal result missing for ${row.image_id}.`);const receipt=await read(receiptPath);need(await falFileSha256(receipt.output_path)===receipt.output_sha256,`Final Fal raster hash changed for ${row.image_id}.`);const prompt=promptById.get(row.image_id);need(prompt,`Final Fal prompt row missing for ${row.image_id}.`);const referenceInputs=prompt.reference_bindings??[];const recoveryType=receiptPath.includes("repair-result")?"content_policy_repair":receiptPath.includes("transport-recovery")?"transport_recovery":"original";const generated={output_sha256:receipt.output_sha256,model:row.endpoint,provider:"fal_ai",request_id:receipt.request_id,result_receipt_path:receiptPath,result_receipt_sha256:await falFileSha256(receiptPath),recovery_type:recoveryType,...receipt};results.push({image_id:row.image_id,scene_id:prompt.scene_id,image_path:receipt.output_path,status:"generated",generated,reference_inputs:referenceInputs});cuts.push({image_id:row.image_id,scene_id:prompt.scene_id,visual_beat_id:prompt.visual_beat_id,start_sec:prompt.start_sec,duration_sec:prompt.duration_sec,prompt_hash:row.prompt_sha256,reference_ids:row.reference_asset_ids,reference_inputs:referenceInputs,image_path:receipt.output_path,image_sha256:receipt.output_sha256,provider:"fal_ai",model:row.endpoint,provider_request_id:receipt.request_id,provider_receipt_path:receiptPath,provider_receipt_sha256:await falFileSha256(receiptPath),recovery_type:recoveryType});}
   need(results.length===bulk.assignments.length&&results.length===plan.prompts.filter(row=>row.image_generation_required!==false).length,"Fal final report count does not match the locked prompt plan.");const updatedAt=new Date().toISOString();const report={schema:"goldflow_imagegen_report_v1",status:"passed",image_provider:"fal_ai",prompt_plan_path:planPath,prompt_plan_hash:promptHash,expected_image_count:bulk.assignments.length,image_count:results.length,missing_image_count:0,results,updated_at:updatedAt};const ledger={schema:"goldflow_cut_execution_ledger_v1",prompt_plan_path:planPath,prompt_plan_hash:promptHash,cuts,updated_at:updatedAt};const immutableReportPath=path.join(ctx.root,"bulk","image-reports",`${Date.now()}-${digest(JSON.stringify(report)).slice(0,12)}.json`);await write(immutableReportPath,report);await write(path.join(ctx.episodeDir,`imagegen_report_${ctx.identity.episode}.json`),report);await write(path.join(ctx.episodeDir,"cut_execution_ledger.json"),ledger);return console.log(JSON.stringify({status:"passed",image_count:results.length,imagegen_report:path.join(ctx.episodeDir,`imagegen_report_${ctx.identity.episode}.json`),cut_execution_ledger:path.join(ctx.episodeDir,"cut_execution_ledger.json"),immutable_report:immutableReportPath},null,2));
 }
 const plan=await read(path.join(ctx.root,"validation-plan.json"));
 if(action==="billing-submit"){need(f["confirm-spend"]==="exact_fal_validation_probe","Paid probe requires exact confirmation token.");return console.log(JSON.stringify({status:"submitted",count:(await submitRows(ctx,[plan.assignments[0]],1)).length},null,2));}
 if(action==="billing-observe"){const result=await observeRows(ctx,[plan.assignments[0]],1);return console.log(JSON.stringify({status:result[0].complete?"complete":"pending",result},null,2));}
 if(action==="dispatch-validation"){need(f["confirm-spend"]==="exact_fal_validation_set","Paid validation requires exact confirmation token.");const rows=[];for(const row of plan.assignments.slice(1))if(!await fs.access(row.submission_receipt_path).then(()=>true,()=>false))rows.push(row);return console.log(JSON.stringify({status:"submitted",count:(await submitRows(ctx,rows,8)).length},null,2));}
 if(action==="observe-validation"){const rows=[];for(const row of plan.assignments)if(!await fs.access(row.result_receipt_path).then(()=>true,()=>false))rows.push(row);const result=await observeRows(ctx,rows,8);return console.log(JSON.stringify({status:result.every(r=>r.complete)?"complete":"pending",complete:result.filter(r=>r.complete).length,pending:result.filter(r=>!r.complete).length},null,2));}
 if(action==="review-validation"){const approved=String(f["approve-ids"]??"").split(",").filter(Boolean),rejected=String(f["reject-ids"]??"").split(",").filter(Boolean);need(f.reviewer&&f.note,"Review requires reviewer and note.");need(approved.length+rejected.length===8&&new Set([...approved,...rejected]).size===8,"Review must disposition all eight exact IDs.");const nativeFal=ctx.identity.visual_restart?.fork_at==="visual_reference_plan";const critical=nativeFal?[plan.assignments[0].image_id]:[plan.assignments[0].image_id,"openart-validation-four-person-roulette-v1","openart-validation-wide-grand-salon-v1"];const status=approved.length>=7&&critical.every(id=>approved.includes(id))?"passed":"failed";const review={schema:"goldflow_fal_validation_review_v1",created_at:new Date().toISOString(),reviewer:f.reviewer,note:f.note,status,approved_ids:approved,rejected_ids:rejected,criteria:nativeFal?["identity consistency","hands","prop fidelity","environment detail","composition","unwanted text"]:["identity consistency","hands","prop fidelity","casino detail","composition","unwanted text"],minor_cosmetic_differences_accepted:true};await write(path.join(ctx.root,"validation-review.json"),review);return console.log(JSON.stringify(review,null,2));}
 throw new Error(`Unsupported Fal action: ${action}`);
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
