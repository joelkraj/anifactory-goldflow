#!/usr/bin/env node
import { createHash } from "node:crypto";
import { promises as fs, constants as fsConstants } from "node:fs";
import path from "node:path";
import { buildReferenceBoard, referenceBoardPromptGuidance, pageReferenceBoardPromptGuidance } from "./lib/openart-reference-board.mjs";
// Page owners carry their template on the prompt row (and later on the assignment, for repairs).
const boardGuidance=(pageTemplate,board)=>pageTemplate?pageReferenceBoardPromptGuidance(board):referenceBoardPromptGuidance(board);
const pageField=pageTemplate=>pageTemplate?{panel_page_template:pageTemplate}:{};
import { falFileSha256, falObjectSha256, uploadFalReference, submitFalImage, observeFalImage, FAL_ENDPOINTS } from "./lib/fal-provider.mjs";
import { falPortableAssetId, promoteApprovedFalReferences } from "./lib/fal-portable-bank.mjs";
import { assertFalRetryBudget, assertFalSpendProjectionBudget, falAmbiguousSubmissionAttempts, falSpendProjectionState, falProjectedSpendUsd } from "./lib/fal-retry-budget.mjs";
import { chooseNativeValidationRows } from "./lib/fal-validation-selector.mjs";
import { falAdjudicationPath, validateFalNoJobAdjudication } from "./lib/fal-ambiguous-adjudication.mjs";
import { falFailureReceiptPath, recordFalFailure } from "./lib/fal-failure-receipt.mjs";
import { validateFalValidationCorrection, validateFalValidationRecovery } from "./lib/fal-validation-recovery.mjs";
import { validateFalPrebulkPromptCorrection } from "./lib/fal-prebulk-prompt-correction.mjs";
import { applyFalPostplanPromptCorrection, inspectFalPostplanPromptCorrection } from "./lib/fal-postplan-prompt-correction.mjs";
import { validateFalReviewedReferenceSuccessRepair } from "./lib/fal-reviewed-reference-success-repair.mjs";
import { recheckFalReferenceHolds } from "./lib/fal-reference-hold-recheck.mjs";
import { reviewedBulkRepairRound } from "./lib/fal-reviewed-bulk-round.mjs";
import { reviewedBulkSourceReceipt } from "./lib/fal-reviewed-bulk-source-receipt.mjs";
import { falArtworkOrders, completeFalPanelArtwork } from "./lib/fal-panel-artwork.mjs";
import { reviewedBulkHoldRecoveryPrompt } from "./lib/fal-reviewed-bulk-hold-recovery.mjs";
import { inspectReferenceProbeReview, prepareReferenceProbeReview, acceptReferenceProbeReview } from "./lib/fal-reference-probe-review.mjs";
import { reviewedFalCharacterAdditions } from "./lib/fal-reviewed-character-additions.mjs";
import { prepareZoneRepair, applyZoneRepair, validateZoneRepairRequest, buildZoneRepairAssignment, ZONE_REPAIR_RECEIPT_DIR } from "./lib/panel-zone-repair.mjs";

const digest = value => createHash("sha256").update(value).digest("hex");
const bytes = value => `${JSON.stringify(value, null, 2)}\n`;
function need(value, message) { if (!value) throw new Error(message); }
function flags(argv) { const out={}; for(let i=0;i<argv.length;i+=2){need(argv[i]?.startsWith("--")&&argv[i+1]!==undefined,"Every Fal production flag requires a value.");out[argv[i].slice(2)]=argv[i+1];} return out; }
async function read(file){return JSON.parse(await fs.readFile(file,"utf8"));}
async function absent(file){try{await fs.lstat(file);throw new Error(`Refusing to overwrite ${file}`);}catch(error){if(error.code!=="ENOENT")throw error;}}
async function write(file,value){const content=bytes(value);const prior=await fs.readFile(file,"utf8").catch(error=>{if(error.code==="ENOENT")return null;throw error;});if(prior!==null){need(prior===content,`Existing Fal artifact differs: ${file}`);return;}await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,content,{flag:"wx"});}
async function mapLimit(rows, limit, fn){const out=[];let cursor=0,failure=null;async function worker(){while(!failure&&cursor<rows.length){const i=cursor++;try{out[i]=await fn(rows[i],i);}catch(error){failure??=error;}}}await Promise.all(Array.from({length:Math.min(limit,rows.length)},worker));if(failure)throw failure;return out;}

async function context(f){
  const episodeDir=await fs.realpath(path.resolve(f["episode-dir"])); const identity=await read(path.join(episodeDir,"run_identity.json"));
  need(identity.image_provider==="fal_ai","Fal production requires a Fal-locked identity.");
  const root=path.join(episodeDir,"fal"); return {episodeDir,identity,root,identityHash:await falFileSha256(path.join(episodeDir,"run_identity.json")),contract:identity.image_provider_options.fal};
}
async function readEffectiveBulk(ctx){
  const bulk=await read(path.join(ctx.root,"bulk-plan.json"));
  const correction=await inspectFalPostplanPromptCorrection({episodeDir:ctx.episodeDir,bulkPlan:bulk});
  need(correction.state!=="pending",
    "Reviewed Fal post-plan prompt correction must be applied before dispatch, observation or finalization.");
  return {...bulk,assignments:correction.assignments,
    ...(correction.state==="applied"?{postplan_prompt_correction_receipt_sha256:await falFileSha256(correction.paths.receipt)}:{})};
}
async function verifyReviewedHoldRecovery(ctx, round, recovery, holdPath){
  const directivePath=path.join(ctx.root,"bulk","review-repair-transport-recovery-directives",`${round.stem}.json`);
  need(recovery.image_id===round.assignment.image_id
    &&recovery.previous_assignment_sha256===round.assignment.assignment_sha256
    &&recovery.source_hold_sha256===await falFileSha256(holdPath)
    &&recovery.qa_report_sha256===round.assignment.qa_report_sha256
    &&recovery.rejected_image_sha256===round.assignment.rejected_image_sha256
    &&recovery.reviewed_directive_sha256===await falFileSha256(directivePath)
    &&recovery.source_script_sha256===await falFileSha256(path.join(ctx.episodeDir,"script_clean.md")),
    `Reviewed Fal hold recovery provenance changed: ${round.stem}`);
  const submission=await read(recovery.submission_receipt_path);
  need(submission.image_id===recovery.image_id
    &&submission.assignment_sha256===recovery.assignment_sha256
    &&submission.request_id&&submission.request_id!==recovery.previous_request_id
    &&submission.prompt_sha256===recovery.prompt_sha256,
    `Reviewed Fal hold recovery submission changed: ${round.stem}`);
  return submission;
}
async function validationPlanPath(ctx){
  const revised=path.join(ctx.root,"validation-plan-v2.json");
  return await fs.access(revised).then(()=>true,()=>false)?revised:path.join(ctx.root,"validation-plan.json");
}
async function validationReviewPath(ctx){
  return (await validationPlanPath(ctx)).endsWith("-v2.json")
    ?path.join(ctx.root,"validation-review-v2.json"):path.join(ctx.root,"validation-review.json");
}
async function prepareReferences(ctx){
  need(ctx.identity.visual_restart?.fork_at==="visual_reference_plan","Native Fal reference generation requires the early reference fork.");
  const plan=await read(path.join(ctx.episodeDir,"visual_reference_plan.json"));
  need(plan.status==="passed"&&Array.isArray(plan.reference_targets),"Approved visual reference plan is required.");
  need(await falFileSha256(ctx.contract.reference_bank_manifest)===ctx.contract.reference_bank_manifest_sha256,
    "Locked Fal reference bank manifest changed.");
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
    const universalJoeyFace=target.ref_id==="joey_base_identity"
      &&target.kind==="character_state"&&target.canonical_subject_id==="joey"
      &&target.generation_mode==="manual_review"&&target.identity_usage==="face_only"
      &&!target.base_asset_id&&!target.state_delta;
    const reusableAsset=universalJoeyFace?joey:target.kind==="character_state"&&!target.base_asset_id&&!target.state_delta
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
    const reviewedV3AssignmentPath=path.join(ctx.root,"reference","review-repair-v3-assignments",`${row.image_id}.json`);
    const reviewedV3ReceiptPath=path.join(ctx.root,"reference","review-repair-v3-result-receipts",`${row.image_id}.json`);
    const reviewedAssignmentPath=path.join(ctx.root,"reference","review-repair-assignments",`${row.image_id}.json`);
    const reviewedReceiptPath=path.join(ctx.root,"reference","review-repair-result-receipts",`${row.image_id}.json`);
    const repairReceiptPath=path.join(ctx.root,"reference","repair-result-receipts",`${row.image_id}.json`);
    const transportReceiptPath=path.join(ctx.root,"reference","transport-recovery-result-receipts",`${row.image_id}.json`);
    const transportAssignmentPath=path.join(ctx.root,"reference","transport-recovery-assignments",`${row.image_id}.json`);
    const reviewedV3=await fs.access(reviewedV3ReceiptPath).then(()=>true,()=>false);
    const reviewed=await fs.access(reviewedReceiptPath).then(()=>true,()=>false);
    const transportRecovered=await fs.access(transportReceiptPath).then(()=>true,()=>false);
    const activeAssignment=reviewedV3?await read(reviewedV3AssignmentPath):reviewed?await read(reviewedAssignmentPath)
      :transportRecovered?await read(transportAssignmentPath):row;
    const receipt=await read(reviewedV3?reviewedV3ReceiptPath:reviewed?reviewedReceiptPath
      :await fs.access(repairReceiptPath).then(()=>repairReceiptPath,
        ()=>transportRecovered?transportReceiptPath:row.result_receipt_path));
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
  // Multi-zone pages may carry up to six references (one 3x2 board); single cuts keep four.
  const requirements=[...(row.reference_requirements??[])].sort((a,b)=>Number(a.slot_order??99)-Number(b.slot_order??99)).slice(0,row.panel_page_template?6:4);
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
async function prepare(ctx,{revision=1}={}){
  if(ctx.identity.visual_restart?.fork_at==="visual_reference_plan"){
    let revisionRequest=null;
    if(revision===2){
      const priorPath=path.join(ctx.root,"validation-plan.json");
      const prior=await read(priorPath);
      revisionRequest=await read(path.join(ctx.root,"validation-revision-request.json"));
      need(revisionRequest.schema==="goldflow_fal_validation_revision_request_v1"
        &&revisionRequest.previous_plan_sha256===await falFileSha256(priorPath)
        &&revisionRequest.reason==="character_state_reference_board_role_misclassified"
        &&revisionRequest.approved_by,"Validation revision lacks exact reviewed evidence.");
      const submitted=await Promise.all(prior.assignments.map(row=>fs.access(row.submission_receipt_path).then(()=>true,()=>false)));
      need(submitted.filter(Boolean).length===1&&submitted[0],"Validation revision requires only the original exact probe submitted.");
    }
    const validationRoot=revision===2?path.join(ctx.root,"validation-v2"):ctx.root;
    const hardened=await read(path.join(ctx.episodeDir,"section_image_prompts_hardened.json"));const approval=await read(path.join(ctx.episodeDir,`visual_reference_approval_${ctx.identity.episode}.json`));
    need(approval.status==="approved", "Fal validation requires approved canonical references.");
    const portableBank=await promoteApprovedFalReferences({episodeDir:ctx.episodeDir,identity:ctx.identity,contract:ctx.contract,approval});
    const assignments=[];
    for(const {row,category,category_matched} of chooseNativeValidationRows(await falArtworkOrders({episodeDir:ctx.episodeDir,prompts:hardened.prompts}))){
      const refs=await nativePromptReferences(ctx,row,approval);
      const board=refs.length?await buildReferenceBoard({root:validationRoot,imageId:row.image_id,references:refs}):null;
      const basePrompt=row.provider_prompt??row.image_prompt;need(basePrompt,`Fal validation prompt missing: ${row.image_id}`);
      const prompt=board?`${basePrompt}\n\n${boardGuidance(row.panel_page_template,board)}`:basePrompt;
      const core={...pageField(row.panel_page_template),image_id:row.image_id,validation_category:category,validation_category_matched:category_matched,endpoint:board?FAL_ENDPOINTS.primary_edit:FAL_ENDPOINTS.primary_text,prompt,prompt_sha256:digest(prompt),run_identity_sha256:ctx.identityHash,reference_mode:board?"one_positional_collage":"text_only",reference_asset_ids:refs.map(r=>r.asset_id),reference_hashes:refs.map(r=>r.sha256),board_path:board?.output_path??null,board_sha256:board?.output_sha256??null,board_manifest_path:board?.manifest_path??null,max_cost_usd:1.0};
      const assignment={...core,assignment_sha256:falObjectSha256(JSON.stringify(core)),submission_receipt_path:path.join(validationRoot,"submission-receipts",`${row.image_id}.json`),result_receipt_path:path.join(validationRoot,"result-receipts",`${row.image_id}.json`),output_path:path.join(validationRoot,"validation-results",`${row.image_id}.png`),upload_receipt_path:path.join(validationRoot,"upload-receipts",`${row.image_id}.json`),checks:["identity consistency","hands","prop fidelity","composition","unwanted text"]};
      const assignmentPath=path.join(validationRoot,"validation-assignments",`${row.image_id}.json`);await write(assignmentPath,assignment);assignments.push({...assignment,assignment_path:assignmentPath});
    }
    const plan={schema:"goldflow_fal_validation_plan_v1",created_at:new Date().toISOString(),run_identity_sha256:ctx.identityHash,source_prompt_plan_sha256:await falFileSha256(path.join(ctx.episodeDir,"section_image_prompts_hardened.json")),model:FAL_ENDPOINTS.primary_edit,quality:"low",width:1920,height:1080,format:"png",normal_reference_mode:"one_positional_collage",concurrency:8,...(revisionRequest?{supersedes_plan_sha256:revisionRequest.previous_plan_sha256,revision_reason:revisionRequest.reason}:{}),assignments};
    await write(path.join(ctx.root,revision===2?"validation-plan-v2.json":"validation-plan.json"),plan);return {status:"prepared",revision,count:assignments.length,image_ids:assignments.map(row=>row.image_id),portable_bank:portableBank};
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
  const rows=await falArtworkOrders({episodeDir:ctx.episodeDir,prompts:prompts.prompts,imageIds:wanted?[...wanted]:null}); need(rows.length,"No requested Fal bulk images found.");
  const assignments=[];
  const nativeFal=ctx.identity.visual_restart?.fork_at==="visual_reference_plan";
  const approval=nativeFal?await read(path.join(ctx.episodeDir,`visual_reference_approval_${ctx.identity.episode}.json`)):null;
  const validation=nativeFal?await read(await validationPlanPath(ctx)):null;
  const correction=nativeFal?await validateFalValidationCorrection({root:ctx.root,validationPlanPath:await validationPlanPath(ctx),validationReviewPath:await validationReviewPath(ctx)}):null;
  const recovery=correction?await validateFalValidationRecovery({root:ctx.root,correction}):null;
  need(!correction||recovery?.status==="passed","Corrected Fal validation requires both exact replacement shots visually approved before bulk.");
  const prebulkCorrection=await validateFalPrebulkPromptCorrection({episodeDir:ctx.episodeDir,
    validationPlanPath:await validationPlanPath(ctx),validationReviewPath:await validationReviewPath(ctx)});
  if(prebulkCorrection){
    need(String(f["image-ids"]??"all")==="all","Reviewed pre-bulk correction requires the complete locked image scope.");
    await write(prebulkCorrection.paths.receipt,prebulkCorrection.receipt);
  }
  const validationReview=nativeFal?(correction?{approved_ids:[...correction.expected.approved_ids,...recovery.review.approved_ids]}:await read(await validationReviewPath(ctx))):null;
  for(const row of rows){
    const refs=nativeFal?await nativePromptReferences(ctx,row,approval):(row.reference_bindings??[]).slice(0,4).map(ref=>({asset_id:ref.asset_id,asset_class:ref.asset_class,path:ref.portable_file?.path??ref.path,sha256:ref.portable_file?.sha256??ref.sha256}));
    need(refs.every(ref=>ref.path&&ref.sha256),`Portable reference binding missing for ${row.image_id}.`);
    const board=refs.length?await buildReferenceBoard({root:path.join(ctx.root,"bulk"),imageId:row.image_id,references:refs}):null;
    const basePrompt=prebulkCorrection?.effectivePrompts.get(row.image_id)
      ??row.provider_prompt??row.image_prompt??row.canonical_prompt; need(basePrompt,`Prompt missing for ${row.image_id}.`);
    const prompt=board?`${basePrompt}\n\n${boardGuidance(row.panel_page_template,board)}`:basePrompt;
    const core={...pageField(row.panel_page_template),image_id:row.image_id,endpoint:board?FAL_ENDPOINTS.primary_edit:FAL_ENDPOINTS.primary_text,prompt,prompt_sha256:digest(prompt),run_identity_sha256:ctx.identityHash,reference_mode:board?"one_positional_collage":"text_only",reference_asset_ids:refs.map(r=>r.asset_id),reference_hashes:refs.map(r=>r.sha256),board_path:board?.output_path??null,board_sha256:board?.output_sha256??null,board_manifest_path:board?.manifest_path??null,max_cost_usd:0.05,start_sec:row.start_sec,duration_sec:row.duration_sec,
      ...(prebulkCorrection?.effectivePrompts.has(row.image_id)?{prebulk_prompt_correction_receipt_sha256:await falFileSha256(prebulkCorrection.paths.receipt)}:{})};
    const acceptedValidation=correction?.expected.rejected_ids.includes(row.image_id)
      ?recovery.plan.assignments.find(item=>item.image_id===row.image_id&&recovery.review.approved_ids.includes(item.image_id))
      :validation?.assignments?.find(item=>item.image_id===row.image_id&&validationReview?.approved_ids?.includes(item.image_id));
    if(acceptedValidation){
      const recovered=correction?.expected.rejected_ids.includes(row.image_id);
      if(recovered)need(validation.assignments.find(item=>item.image_id===row.image_id)?.prompt_sha256===core.prompt_sha256,
        `Underlying approved Fal prompt changed before exact validation recovery reuse: ${row.image_id}`);
      need((recovered||acceptedValidation.prompt_sha256===core.prompt_sha256)
        &&acceptedValidation.board_sha256===core.board_sha256
        &&JSON.stringify(acceptedValidation.reference_hashes)===JSON.stringify(core.reference_hashes),
      `Accepted Fal validation shot changed before bulk reuse: ${row.image_id}`);
      const receipt=await read(acceptedValidation.result_receipt_path);
      need(receipt.output_sha256===await falFileSha256(receipt.output_path)
        &&(recovered?recovery.review.result_sha256_by_id[row.image_id]===await falFileSha256(acceptedValidation.result_receipt_path):true),
      `Accepted Fal validation result is missing or changed: ${row.image_id}`);
      assignments.push({...acceptedValidation,reused_validation_shot:true,start_sec:row.start_sec,duration_sec:row.duration_sec});
      continue;
    }
    const assignment={...core,assignment_sha256:falObjectSha256(JSON.stringify(core)),submission_receipt_path:path.join(ctx.root,"bulk","submission-receipts",`${row.image_id}.json`),result_receipt_path:path.join(ctx.root,"bulk","result-receipts",`${row.image_id}.json`),output_path:path.join(ctx.root,"bulk","outputs",`${row.image_id}.png`),upload_receipt_path:path.join(ctx.root,"bulk","upload-receipts",`${row.image_id}.json`)};
    const assignmentPath=path.join(ctx.root,"bulk","assignments",`${row.image_id}.json`);await write(assignmentPath,assignment);assignments.push({...assignment,assignment_path:assignmentPath});
  }
  const projectedBase=Number((assignments.filter(row=>!row.reused_validation_shot).length*0.00441).toFixed(4));
  const spend=await falSpendProjectionState({episodeDir:ctx.episodeDir,
    warningBudgetUsd:ctx.contract.warning_budget_usd,hardBudgetUsd:ctx.contract.hard_budget_usd});
  const projectedPending=assignments.filter(row=>!row.reused_validation_shot).length;
  const projectedEpisode=falProjectedSpendUsd(spend.paid_submissions+projectedPending);
  need(projectedEpisode<ctx.contract.hard_budget_usd,
    "Projected Fal episode spend reaches the locked hard budget; estimate only, verify actual account spend.");
  if(projectedEpisode>=ctx.contract.warning_budget_usd)
    console.error(`Fal projected episode spend $${projectedEpisode} reaches the locked warning threshold; estimate only, verify actual account spend.`);
  const plan={schema:"goldflow_fal_bulk_plan_v1",created_at:new Date().toISOString(),run_identity_sha256:ctx.identityHash,model:FAL_ENDPOINTS.primary_edit,quality:"low",width:1920,height:1080,format:"png",reference_mode:"one_positional_collage",concurrency:ctx.contract.production_concurrency,assignment_count:assignments.length,projected_base_cost_usd:projectedBase,projected_observed_rate_episode_cost_usd:projectedEpisode,pricing_note:"$0.00441 is base-output only. The episode spend projection uses $0.022 per paid request from observed Fal billing; actual charges require dashboard verification.",
    ...(prebulkCorrection?{prebulk_prompt_correction_receipt_sha256:await falFileSha256(prebulkCorrection.paths.receipt),prebulk_corrected_image_ids:[...prebulkCorrection.effectivePrompts.keys()]}:{}),
    ...(correction?{validation_review_correction_sha256:await falFileSha256(correction.paths.correction),validation_recovery_review_sha256:await falFileSha256(correction.paths.review)}:{}),
    ...(recovery?.second?{validation_second_review_sha256:await falFileSha256(recovery.second.reviewPath)}:{}),assignments};
  await write(path.join(ctx.root,"bulk-plan.json"),plan);return {status:"prepared",count:assignments.length,projected_base_cost_usd:projectedBase,projected_observed_rate_episode_cost_usd:projectedEpisode};
}
async function submitRows(ctx,rows,limit){
  const lockPath=path.join(ctx.root,"paid-dispatch.lock");
  await fs.mkdir(ctx.root,{recursive:true});
  try{await fs.mkdir(lockPath);}catch(error){if(error.code==="EEXIST")throw new Error("Fal paid dispatch is already active or was interrupted; inspect its attempts before further spend.");throw error;}
  try{
    const ambiguous=await falAmbiguousSubmissionAttempts(ctx.episodeDir);
    need(!ambiguous.length,`Fal has ${ambiguous.length} submission attempt(s) without request receipts; reconcile them before further spend.`);
    const pending=[];
    for(const row of rows){
      if(await fs.access(row.submission_receipt_path).then(()=>true,()=>false)){
        const prior=await read(row.submission_receipt_path);
        need(prior.schema==="goldflow_fal_submission_receipt_v1"&&prior.image_id===row.image_id
          &&prior.assignment_sha256===row.assignment_sha256&&prior.run_identity_sha256===ctx.identityHash,
          `Existing Fal submission receipt differs from exact assignment: ${row.image_id}`);
      }else pending.push(row);
    }
    if(!pending.length)return [];
    need(new Set(pending.map(row=>row.submission_receipt_path)).size===pending.length,
      "Fal paid batch contains duplicate submission receipt paths.");
    await assertFalRetryBudget({episodeDir:ctx.episodeDir,assignments:pending});
    const spend=await assertFalSpendProjectionBudget({episodeDir:ctx.episodeDir,assignments:pending,
      warningBudgetUsd:ctx.contract.warning_budget_usd,hardBudgetUsd:ctx.contract.hard_budget_usd});
    if(spend.warning_after_batch)console.error(`Fal projected spend warning: $${spend.projected_spend_after_batch_usd} against locked $${spend.warning_budget_usd}; estimate only, verify actual Fal balance.`);
    return await mapLimit(pending,limit,async row=>{
      if(!row.board_path)return submitFalImage({assignment:row,referenceUrls:[],receiptPath:row.submission_receipt_path});
      const upload=await uploadFalReference({localPath:row.board_path,expectedSha256:row.board_sha256,receiptPath:row.upload_receipt_path});
      try{return await submitFalImage({assignment:row,referenceUrls:[upload.remoteUrl],receiptPath:row.submission_receipt_path});}
      finally{upload.remoteUrl=null;}
    });
  }finally{await fs.rmdir(lockPath);}
}
async function preflightPaidRepair(ctx,receiptDir,imageIds,fileStemForId=id=>id){
  const pending=[];
  for(const imageId of imageIds){
    const submission_receipt_path=path.join(ctx.root,receiptDir,`${fileStemForId(imageId)}.json`);
    if(!await fs.access(submission_receipt_path).then(()=>true,()=>false))
      pending.push({image_id:imageId,previous_assignment_sha256:"preflight",submission_receipt_path});
  }
  if(!pending.length)return;
  await assertFalRetryBudget({episodeDir:ctx.episodeDir,assignments:pending});
  await assertFalSpendProjectionBudget({episodeDir:ctx.episodeDir,assignments:pending,
    warningBudgetUsd:ctx.contract.warning_budget_usd,hardBudgetUsd:ctx.contract.hard_budget_usd});
}
async function observeRows(ctx,rows,limit){return mapLimit(rows,limit,async row=>{const receipt=await read(row.submission_receipt_path);try{return await observeFalImage({endpoint:receipt.endpoint,requestId:receipt.request_id,outputPath:row.output_path,receiptPath:row.result_receipt_path});}catch(error){const timedOut=error?.name==="TimeoutError"||/aborted due to timeout/i.test(error?.message??"");const stale=Date.now()-Date.parse(receipt.submitted_at)>15*60_000;if(timedOut&&!stale)return {complete:false,transient_observation_timeout:true,request_id:receipt.request_id};if(timedOut||Number(error?.status)>=500||/Gateway Timeout|Internal Server Error/i.test(error?.message??"")){const resultDir=path.basename(path.dirname(row.result_receipt_path));const holdName=resultDir==="review-repair-result-receipts"?path.basename(row.result_receipt_path):resultDir==="review-repair-transport-recovery-result-receipts"||resultDir==="transport-recovery-result-receipts"?`${path.basename(row.result_receipt_path,".json")}-recovery.json`:`${row.image_id}.json`;const holdPath=path.join(path.dirname(path.dirname(row.result_receipt_path)),"transport-holds",holdName);if(!await fs.access(holdPath).then(()=>true,()=>false))await write(holdPath,{schema:"goldflow_fal_transport_hold_v1",created_at:new Date().toISOString(),image_id:row.image_id,endpoint:receipt.endpoint,request_id:receipt.request_id,assignment_sha256:row.assignment_sha256,provider_queue_status:"unknown_or_completed",reason:timedOut?"stale_observation_timeout":"provider_5xx_during_observation",billable_request_resubmitted:false});return {complete:false,transport_pending:true,request_id:receipt.request_id,hold_path:holdPath};}if(error?.status!==422)throw error;const failurePath=await recordFalFailure(row,receipt,error);return {complete:false,failed:true,failure_path:failurePath};}});}
async function main(){
 const f=flags(process.argv.slice(2)); const ctx=await context(f); const action=f.action;
 if (["prepare-reference-probe-repair", "dispatch-reference-probe-repair", "observe-reference-probe-repair", "review-reference-probe-repair"].includes(action)) {
   const state=await inspectReferenceProbeReview(ctx.episodeDir);
   need(state,"Exact reference-probe visual rejection is required.");
   if(action==="prepare-reference-probe-repair") return console.log(JSON.stringify({status:"prepared",image_id:(await prepareReferenceProbeReview(ctx.episodeDir,state)).image_id}));
   if(action==="dispatch-reference-probe-repair") {
     need(state.state==="dispatch"&&f["confirm-spend"]==="exact_fal_reference_probe_repair","Only the prepared exact probe repair may be submitted once.");
     await preflightPaidRepair(ctx,"reference/review-repair-submission-receipts",[state.repair.image_id]);
     return console.log(JSON.stringify({status:"submitted",count:(await submitRows(ctx,[state.repair],1)).length}));
   }
   if(action==="observe-reference-probe-repair") {
     need(state.state==="observe","Exact probe repair must await observation.");
     return console.log(JSON.stringify(await observeRows(ctx,[state.repair],1),null,2));
   }
   return console.log(JSON.stringify(await acceptReferenceProbeReview(ctx.episodeDir,state,{reviewer:f.reviewer,note:f.note}),null,2));
 }
 if(action==="apply-postplan-prompt-correction"){
   const bulk=await read(path.join(ctx.root,"bulk-plan.json"));
   return console.log(JSON.stringify(await applyFalPostplanPromptCorrection({
     episodeDir:ctx.episodeDir,bulkPlan:bulk,requestPath:f.request}),null,2));
 }
 if(action==="adjudicate-no-job"){
   need(path.isAbsolute(f["review-spec"]??""),"No-job adjudication requires an absolute reviewed spec.");
   const bulk=await readEffectiveBulk(ctx);
   const row=bulk.assignments.find(item=>item.image_id===f["image-id"]);
   need(row,`Unknown exact Fal bulk ID: ${f["image-id"]}`);
   const receipt=await validateFalNoJobAdjudication({episodeDir:ctx.episodeDir,assignment:row,spec:await read(f["review-spec"])});
   const receiptPath=falAdjudicationPath(ctx.episodeDir,row.image_id);
   await absent(receiptPath);await write(receiptPath,receipt);
   return console.log(JSON.stringify({status:"no_provider_job_adjudicated",image_id:row.image_id,receipt_path:receiptPath},null,2));
 }
 if(action==="dispatch-adjudicated"||action==="observe-adjudicated"){
   const bulk=await readEffectiveBulk(ctx);
   const originals=action==="dispatch-adjudicated"?bulk.assignments.filter(row=>row.image_id===f["image-id"]):bulk.assignments;
   need(originals.length,"No exact Fal adjudicated ID found.");const rows=[];
   for(const original of originals){
     const adjudicationPath=falAdjudicationPath(ctx.episodeDir,original.image_id);
     if(!await fs.access(adjudicationPath).then(()=>true,()=>false))continue;
     const adjudication=await read(adjudicationPath);
     need(adjudication.schema==="goldflow_fal_no_job_adjudication_receipt_v1"
       && adjudication.assignment_sha256===original.assignment_sha256
       && adjudication.prompt_sha256===original.prompt_sha256
       && adjudication.attempt_sha256===await falFileSha256(adjudication.attempt_path),
       `Fal no-job adjudication changed: ${original.image_id}`);
     need(!await fs.access(original.submission_receipt_path).then(()=>true,()=>false)
       && !await fs.access(original.result_receipt_path).then(()=>true,()=>false),
       `Original Fal request acquired a receipt: ${original.image_id}`);
     const core={...original,previous_assignment_sha256:original.assignment_sha256,
       ambiguous_attempt_sha256:adjudication.attempt_sha256,
       adjudication_receipt_sha256:await falFileSha256(adjudicationPath),recovery_reason:"reviewed_no_provider_job"};
     for(const key of ["assignment_sha256","assignment_path","submission_receipt_path","result_receipt_path","output_path","upload_receipt_path"])delete core[key];
     const root=path.join(ctx.root,"bulk");
     const row={...core,assignment_sha256:falObjectSha256(JSON.stringify(core)),
       submission_receipt_path:path.join(root,"ambiguous-retry-submission-receipts",`${original.image_id}.json`),
       result_receipt_path:path.join(root,"ambiguous-retry-result-receipts",`${original.image_id}.json`),
       output_path:original.output_path,
       upload_receipt_path:path.join(root,"ambiguous-retry-upload-receipts",`${original.image_id}.json`)};
     if(action==="dispatch-adjudicated"){
       need(f["confirm-spend"]==="exact_fal_ambiguous_retry","Adjudicated retry requires exact spend token.");
       need(!await fs.access(row.output_path).then(()=>true,()=>false),`Accepted Fal output already exists: ${original.image_id}`);
       await write(path.join(root,"ambiguous-retry-assignments",`${original.image_id}.json`),row);
       rows.push(row);
     }else if(await fs.access(row.submission_receipt_path).then(()=>true,()=>false)
       && !await fs.access(row.result_receipt_path).then(()=>true,()=>false))rows.push(row);
   }
   if(action==="dispatch-adjudicated"){
     need(rows.length===1,"Exactly one adjudicated retry is required.");
     const result=await submitRows(ctx,rows,1);
     return console.log(JSON.stringify({status:"submitted",image_id:f["image-id"],count:result.length},null,2));
   }
   const result=await observeRows(ctx,rows,ctx.contract.production_concurrency);
   return console.log(JSON.stringify({status:"observed",checked:result.length,complete:result.filter(x=>x.complete).length},null,2));
 }
 if(action==="prepare-references") return console.log(JSON.stringify(await prepareReferences(ctx),null,2));
 if(["dispatch-validation-second","observe-validation-second","review-validation-second"].includes(action)) {
   const correction=await validateFalValidationCorrection({root:ctx.root,validationPlanPath:await validationPlanPath(ctx),validationReviewPath:await validationReviewPath(ctx)});
   need(correction?.recorded,"First reviewed validation recovery is required.");
   const recovery=await validateFalValidationRecovery({root:ctx.root,correction});
   need(recovery.status==="second_pending","Only a pending, explicitly reviewed second validation repair is eligible.");
   const second=recovery.second;
   if(action==="dispatch-validation-second") {
     need(second.state==="submit"&&f["confirm-spend"]==="exact_fal_validation_second","Second repair requires exact pending scope and spend token.");
     await preflightPaidRepair(ctx,"validation-recovery-second/submission-receipts",second.assignments.map(r=>r.image_id));
     for(const row of second.assignments) await write(path.join(second.dir,"assignments",`${row.image_id}.json`),row);
     return console.log(JSON.stringify({status:"submitted",count:(await submitRows(ctx,second.assignments,1)).length},null,2));
   }
   if(action==="observe-validation-second") {
     need(second.state==="observe","No original second-repair request awaits observation.");
     return console.log(JSON.stringify(await observeRows(ctx,second.assignments.filter((r,i)=>!second.completed[i]),1),null,2));
   }
   need(second.state==="review"&&f.reviewer&&String(f.note??"").trim().length>20,"Actual complete visual review is required.");
   const approved=String(f["approve-ids"]??"").split(',').filter(Boolean),rejected=String(f["reject-ids"]??"").split(',').filter(Boolean);
   need(approved.length+rejected.length===second.assignments.length&&new Set([...approved,...rejected]).size===second.assignments.length
     &&second.assignments.every(r=>approved.includes(r.image_id)||rejected.includes(r.image_id)),"Second review must disposition exact IDs only.");
   const hashes={};for(const row of second.assignments) hashes[row.image_id]=await falFileSha256(row.result_receipt_path);
   await write(second.reviewPath,{schema:"goldflow_fal_second_validation_review_v1",created_at:new Date().toISOString(),
     request_sha256:await falFileSha256(second.requestPath),actual_review:true,reviewer:f.reviewer,note:f.note,
     approved_ids:approved,rejected_ids:rejected,result_sha256_by_id:hashes});
   return console.log(JSON.stringify({status:rejected.length?"failed":"passed",approved,rejected},null,2));
 }
 if(["correct-validation-review","prepare-validation-recovery","dispatch-validation-recovery","observe-validation-recovery","review-validation-recovery"].includes(action)){
   const correction=await validateFalValidationCorrection({root:ctx.root,validationPlanPath:await validationPlanPath(ctx),validationReviewPath:await validationReviewPath(ctx)});
   need(correction,"Reviewed validation correction request is missing.");
   if(action==="correct-validation-review"){
     need(!correction.recorded,"Validation review correction is already recorded.");
     await write(correction.paths.correction,correction.expected);
     return console.log(JSON.stringify({status:"needs_exact_recovery",approved:correction.expected.approved_ids.length,rejected:correction.expected.rejected_ids.length,correction_path:correction.paths.correction},null,2));
   }
   need(correction.recorded,"Record the hash-bound validation correction before recovery.");
   const recovery=await validateFalValidationRecovery({root:ctx.root,correction});
   if(action==="prepare-validation-recovery"){
     need(recovery.status==="plan_missing","Exact validation recovery is already prepared.");
     const assignments=[];
     for(const imageId of correction.expected.rejected_ids){
       const original=correction.plan.assignments.find(row=>row.image_id===imageId);
       const directive=correction.request.recovery_prompts.find(row=>row.image_id===imageId);
       const core={...original};
       for(const key of ["assignment_sha256","assignment_path","submission_receipt_path","result_receipt_path","output_path","upload_receipt_path","prompt","prompt_sha256"])
         delete core[key];
       Object.assign(core,{prompt:directive.replacement_prompt,prompt_sha256:digest(directive.replacement_prompt),
         previous_assignment_sha256:original.assignment_sha256,previous_result_sha256:directive.previous_result_sha256,
         rejected_image_sha256:directive.previous_output_sha256,recovery_correction_sha256:await falFileSha256(correction.paths.correction),
         recovery_reason:directive.reason});
       const root=path.join(ctx.root,"validation-recovery");
       const assignment={...core,assignment_sha256:falObjectSha256(JSON.stringify(core)),
         submission_receipt_path:path.join(root,"submission-receipts",`${imageId}.json`),
         result_receipt_path:path.join(root,"result-receipts",`${imageId}.json`),
         output_path:path.join(root,"outputs",`${imageId}.png`),
         upload_receipt_path:path.join(root,"upload-receipts",`${imageId}.json`)};
       const assignmentPath=path.join(root,"assignments",`${imageId}.json`);
       await write(assignmentPath,assignment);
       assignments.push({...assignment,assignment_path:assignmentPath});
     }
     await write(correction.paths.plan,{schema:"goldflow_fal_validation_recovery_plan_v1",created_at:new Date().toISOString(),
       correction_sha256:await falFileSha256(correction.paths.correction),validation_plan_sha256:correction.expected.validation_plan_sha256,
       count:assignments.length,assignments});
     return console.log(JSON.stringify({status:"prepared",count:assignments.length,image_ids:assignments.map(row=>row.image_id)},null,2));
   }
   need(recovery.plan,"Exact validation recovery plan is missing.");
   if(action==="dispatch-validation-recovery"){
     need(f["confirm-spend"]==="exact_fal_validation_recovery","Exact validation recovery requires its spend token.");
     need(recovery.status==="pending"&&!recovery.submissions.some(Boolean),"Validation recovery submission is not the next exact step.");
     const result=await submitRows(ctx,recovery.plan.assignments,Math.min(2,ctx.contract.production_concurrency));
     return console.log(JSON.stringify({status:"submitted",count:result.length,image_ids:recovery.plan.assignments.map(row=>row.image_id)},null,2));
   }
   if(action==="observe-validation-recovery"){
     const rows=recovery.plan.assignments.filter((row,index)=>recovery.submissions[index]&&!recovery.results[index]&&!recovery.failures[index]&&!recovery.holds[index]);
     need(rows.length,"No submitted validation recovery result awaits observation.");
     const result=await observeRows(ctx,rows,Math.min(2,ctx.contract.production_concurrency));
     return console.log(JSON.stringify({status:result.every(row=>row.complete)?"complete":"pending",checked:result.length,complete:result.filter(row=>row.complete).length},null,2));
   }
   if(action==="review-validation-recovery"){
     need(recovery.status==="pending"&&recovery.results.every(Boolean),"Every exact recovery raster must exist before visual review.");
     const approved=String(f["approve-ids"]??"").split(",").filter(Boolean),rejected=String(f["reject-ids"]??"").split(",").filter(Boolean);
     need(f.reviewer&&String(f.note??"").trim().length>20,"Visual recovery review requires actual reviewer and material note.");
     need(approved.length+rejected.length===recovery.plan.assignments.length
       &&new Set([...approved,...rejected]).size===recovery.plan.assignments.length
       &&recovery.plan.assignments.every(row=>approved.includes(row.image_id)||rejected.includes(row.image_id)),
     "Visual recovery review must disposition only the exact recovery IDs.");
     const resultHashes={};
     for(const row of recovery.plan.assignments){const receipt=await read(row.result_receipt_path);
       need(receipt.output_sha256===await falFileSha256(receipt.output_path),`Recovery raster changed: ${row.image_id}`);
       resultHashes[row.image_id]=await falFileSha256(row.result_receipt_path);}
     const review={schema:"goldflow_fal_validation_recovery_review_v1",created_at:new Date().toISOString(),
       correction_sha256:await falFileSha256(correction.paths.correction),recovery_plan_sha256:await falFileSha256(correction.paths.plan),
       reviewer:f.reviewer,note:f.note,status:rejected.length?"failed":"passed",approved_ids:approved,rejected_ids:rejected,result_sha256_by_id:resultHashes};
     await write(correction.paths.review,review);
     return console.log(JSON.stringify(review,null,2));
   }
 }
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
   need(f["confirm-spend"]==="exact_fal_reference_batch","Paid reference dispatch requires exact confirmation token.");const plan=await read(path.join(ctx.root,"reference-plan.json"));const limit=Math.min(Number(f.limit??100),100);need(Number.isInteger(limit)&&limit>0,"Reference limit must be 1..100.");const rows=[];for(const row of plan.assignments)if(row.reference_mode!=="approved_local_asset"&&!await fs.access(row.submission_receipt_path).then(()=>true,()=>false)){rows.push(row);if(rows.length===limit)break;}const result=await submitRows(ctx,rows,ctx.contract.production_concurrency);return console.log(JSON.stringify({status:"submitted",count:result.length},null,2));
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
 if(action==="observe-reference-holds"){
   const plan=await read(path.join(ctx.root,"reference-plan.json"));
   const result=await recheckFalReferenceHolds({root:ctx.root,assignments:plan.assignments,
     observe:rows=>observeRows(ctx,rows,ctx.contract.production_concurrency)});
   return console.log(JSON.stringify(result,null,2));
 }
 if(action==="recover-reference-holds"){
   need(f["confirm-spend"]==="exact_fal_reference_transport_recovery",
     "Paid reference transport recovery requires the exact confirmation token.");
   need(path.isAbsolute(f.directives??""),"Reference transport recovery needs absolute reviewed directives.");
   const plan=await read(path.join(ctx.root,"reference-plan.json"));
   const directives=await read(f.directives);
   need(directives?.schema==="goldflow_fal_reference_transport_recovery_directives_v1"
     &&Array.isArray(directives.recoveries)&&directives.recoveries.length,
     "Exact reference transport recovery directives are required.");
   need(new Set(directives.recoveries.map(row=>row.image_id)).size===directives.recoveries.length,
     "Reference transport recovery repeats an image ID.");
   await preflightPaidRepair(ctx,"reference/transport-recovery-submission-receipts",
     directives.recoveries.map(row=>row.image_id));
   const recoveries=[];
   for(const directive of directives.recoveries){
     const original=plan.assignments.find(row=>row.image_id===directive.image_id);
     need(original&&directive.original_assignment_sha256===original.assignment_sha256,
       `Reference transport recovery assignment changed: ${directive.image_id}`);
     const holdPath=path.join(ctx.root,"reference","transport-holds",`${directive.image_id}.json`);
     const observationPath=path.join(ctx.root,"reference","hold-observation-receipts",`${directive.image_id}.json`);
     const [hold,observation,submission]=await Promise.all([
       read(holdPath),read(observationPath),read(original.submission_receipt_path)]);
     need(hold.schema==="goldflow_fal_transport_hold_v1"&&hold.request_id===submission.request_id
       &&hold.assignment_sha256===original.assignment_sha256
       &&observation.schema==="goldflow_fal_reference_hold_observation_v1"
       &&["provider_failed","transport_pending"].includes(observation.outcome)
       &&observation.original_request_id===hold.request_id
       &&observation.original_assignment_sha256===original.assignment_sha256
       &&observation.original_transport_hold_sha256===await falFileSha256(holdPath)
       &&observation.original_submission_receipt_sha256===await falFileSha256(original.submission_receipt_path)
       &&directive.original_request_id===hold.request_id
       &&directive.hold_observation_receipt_sha256===await falFileSha256(observationPath)
       &&typeof directive.recovery_reason==="string"&&directive.recovery_reason.trim()
       &&typeof directive.reviewer==="string"&&directive.reviewer.trim()
       &&typeof directive.note==="string"&&directive.note.trim(),
       `Reference transport recovery lacks reviewed original-request lineage: ${directive.image_id}`);
     need(!await fs.access(original.result_receipt_path).then(()=>true,()=>false)
       &&!await fs.access(path.join(ctx.root,"reference","failure-receipts",`${directive.image_id}.json`)).then(()=>true,()=>false),
       `Original reference request resolved before paid transport recovery: ${directive.image_id}`);
     const core={...original,previous_request_id:hold.request_id,
       previous_assignment_sha256:original.assignment_sha256,
       original_transport_hold_sha256:await falFileSha256(holdPath),
       hold_observation_receipt_sha256:await falFileSha256(observationPath),
       transport_recovery_reason:directive.recovery_reason};
     for(const key of ["assignment_sha256","assignment_path","submission_receipt_path","result_receipt_path","output_path","upload_receipt_path"])delete core[key];
     const recovery={...core,assignment_sha256:falObjectSha256(JSON.stringify(core)),
       submission_receipt_path:path.join(ctx.root,"reference","transport-recovery-submission-receipts",`${directive.image_id}.json`),
       result_receipt_path:path.join(ctx.root,"reference","transport-recovery-result-receipts",`${directive.image_id}.json`),
       output_path:path.join(ctx.episodeDir,"assets","images","reference-repairs",`${directive.image_id}-transport.png`),
       upload_receipt_path:path.join(ctx.root,"reference","transport-recovery-upload-receipts",`${directive.image_id}.json`)};
     await write(path.join(ctx.root,"reference","transport-recovery-assignments",`${directive.image_id}.json`),recovery);
     recoveries.push(recovery);
   }
   const result=await submitRows(ctx,recoveries,Math.min(ctx.contract.production_concurrency,recoveries.length));
   return console.log(JSON.stringify({status:"reference_transport_recovery_submitted",count:result.length,
     image_ids:recoveries.map(row=>row.image_id)},null,2));
 }
 if(action==="observe-reference-transport-recovery"){
   const dir=path.join(ctx.root,"reference","transport-recovery-assignments");
   const names=await fs.readdir(dir);const rows=[];
   for(const name of names.filter(value=>value.endsWith(".json"))){
     const row=await read(path.join(dir,name));
     const failed=await fs.access(path.join(ctx.root,"reference","transport-recovery-failure-receipts",`${row.image_id}.json`)).then(()=>true,()=>false);
     const held=await fs.access(path.join(ctx.root,"reference","transport-holds",`${row.image_id}-recovery.json`)).then(()=>true,()=>false);
     if(!failed&&!held&&!await fs.access(row.result_receipt_path).then(()=>true,()=>false))rows.push(row);
   }
   const result=await observeRows(ctx,rows,ctx.contract.production_concurrency);
   return console.log(JSON.stringify({status:result.every(row=>row.complete)?"complete":"pending",
     checked:result.length,complete:result.filter(row=>row.complete).length,
     failed:result.filter(row=>row.failed).length,held:result.filter(row=>row.transport_pending).length,
     pending:result.filter(row=>!row.complete&&!row.failed&&!row.transport_pending).length},null,2));
 }
 if(action==="repair-reference-failures"){
   need(f["confirm-spend"]==="exact_fal_reference_repair","Paid reference repair requires exact confirmation token.");
   need(path.isAbsolute(f.directives??""),"Reference repair requires an absolute --directives file.");
   const plan=await read(path.join(ctx.root,"reference-plan.json"));const directives=await read(f.directives);
   need(directives?.schema==="goldflow_fal_reference_repair_directives_v1"&&Array.isArray(directives.repairs)&&directives.repairs.length,
     "Exact Fal reference repair directives are required.");
   await preflightPaidRepair(ctx,"reference/repair-submission-receipts",directives.repairs.map(row=>row.image_id));
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
   await preflightPaidRepair(ctx,"reference/review-repair-submission-receipts",review.rejections.map(row=>row.image_id));
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
     if(!await fs.access(row.result_receipt_path).then(()=>true,()=>false)
       &&!await fs.access(falFailureReceiptPath(row)).then(()=>true,()=>false))rows.push(row);}
   const result=await observeRows(ctx,rows,ctx.contract.production_concurrency);
   return console.log(JSON.stringify({status:result.every(row=>row.complete)?"complete":"pending",checked:result.length,
     complete:result.filter(row=>row.complete).length,pending:result.filter(row=>!row.complete&&!row.failed).length,
     failed:result.filter(row=>row.failed).length},null,2));
 }
 if(action==="repair-failed-reviewed-reference"){
   need(f["confirm-spend"]==="exact_fal_reviewed_reference_v3","Second reviewed-reference repair requires exact spend token.");
   need(path.isAbsolute(f.directives??""),"Second reviewed-reference repair requires an absolute directive file.");
   const id=String(f["image-id"]??"");
   need(/^[a-z0-9][a-z0-9_-]{1,100}$/.test(id),"Exact reviewed-reference ID is required.");
   const review=await read(path.join(ctx.root,"reference","review-rejections.json"));
   need(review.schema==="goldflow_fal_reference_visual_review_v1"&&review.rejections.some(row=>row.image_id===id),
     `Reviewed reference rejection is missing for ${id}.`);
   const previous=await read(path.join(ctx.root,"reference","review-repair-assignments",`${id}.json`));
   const priorSubmission=await read(previous.submission_receipt_path);
   const failurePath=falFailureReceiptPath(previous);
   const failure=await read(failurePath);
   need(failure.schema==="goldflow_fal_exact_failure_v1"&&failure.image_id===id
     &&failure.assignment_sha256===previous.assignment_sha256&&failure.request_id===priorSubmission.request_id
     &&failure.error_status===422,`Exact reviewed-reference provider failure changed for ${id}.`);
   need(!await fs.access(previous.result_receipt_path).then(()=>true,()=>false),`Reviewed-reference repair already succeeded for ${id}.`);
   const directive=await read(f.directives);
   need(directive.schema==="goldflow_fal_reviewed_reference_failure_repair_v1"
     &&directive.image_id===id&&directive.failed_assignment_sha256===previous.assignment_sha256
     &&directive.failure_receipt_sha256===await falFileSha256(failurePath)
     &&directive.failed_request_id===failure.request_id
     &&typeof directive.replacement_prompt==="string"&&directive.replacement_prompt.length>80
     &&digest(directive.replacement_prompt)!==previous.prompt_sha256
     &&typeof directive.repair_reason==="string"&&directive.repair_reason.length>20,
     `Second reviewed-reference directive is not bound to the exact failure for ${id}.`);
   await preflightPaidRepair(ctx,"reference/review-repair-v3-submission-receipts",[id]);
   const core={...previous,prompt:directive.replacement_prompt,
     prompt_sha256:digest(directive.replacement_prompt),previous_assignment_sha256:previous.assignment_sha256,
     failed_repair_request_id:failure.request_id,failed_repair_receipt_sha256:directive.failure_receipt_sha256,
     repair_reason:directive.repair_reason,
     output_path:path.join(ctx.episodeDir,"assets","images","reference-repairs",`${id}-v3.png`)};
   for(const key of ["assignment_sha256","assignment_path","submission_receipt_path","result_receipt_path","upload_receipt_path"])delete core[key];
   const row={...core,assignment_sha256:falObjectSha256(JSON.stringify(core)),
     submission_receipt_path:path.join(ctx.root,"reference","review-repair-v3-submission-receipts",`${id}.json`),
     result_receipt_path:path.join(ctx.root,"reference","review-repair-v3-result-receipts",`${id}.json`),
     upload_receipt_path:path.join(ctx.root,"reference","review-repair-v3-upload-receipts",`${id}.json`)};
   await write(path.join(ctx.root,"reference","review-repair-v3-assignments",`${id}.json`),row);
   const result=await submitRows(ctx,[row],1);
   return console.log(JSON.stringify({status:"reviewed_reference_v3_submitted",image_id:id,count:result.length},null,2));
 }
 if(action==="repair-successful-reviewed-references"){
   need(f["confirm-spend"]==="exact_fal_reviewed_reference_success_v3",
     "Successful reviewed-reference repair requires exact spend token.");
   const directivesPath=String(f.directives??"");
   need(path.isAbsolute(directivesPath),"Successful reviewed-reference repair requires an absolute directive file.");
   const validated=await validateFalReviewedReferenceSuccessRepair({episodeDir:ctx.episodeDir,directivesPath});
   await preflightPaidRepair(ctx,"reference/review-repair-v3-submission-receipts",validated.ids);
   const repairs=[];
   for(const {row,v2Assignment,v2Result,source} of validated.checked){
     const sourcePath=source.reference_image_path;
     const core={...v2Assignment,endpoint:FAL_ENDPOINTS.primary_edit,
       prompt:row.replacement_prompt,prompt_sha256:digest(row.replacement_prompt),
       reference_mode:"separate_ordered_references",
       reference_asset_ids:[falPortableAssetId(ctx.identity.series_slug,{ref_id:source.ref_id,kind:source.kind??"asset"})],
       reference_hashes:[row.reference_sha256],board_path:sourcePath,board_sha256:row.reference_sha256,
       previous_assignment_sha256:v2Assignment.assignment_sha256,
       rejected_image_sha256:v2Result.output_sha256,repair_reason:row.finding,
       visual_review_path:directivesPath,
       output_path:path.join(ctx.episodeDir,"assets","images","reference-repairs",`${row.image_id}-v3.png`)};
     for(const key of ["assignment_sha256","assignment_path","submission_receipt_path","result_receipt_path","upload_receipt_path"])delete core[key];
     const repair={...core,assignment_sha256:falObjectSha256(JSON.stringify(core)),
       submission_receipt_path:path.join(ctx.root,"reference","review-repair-v3-submission-receipts",`${row.image_id}.json`),
       result_receipt_path:path.join(ctx.root,"reference","review-repair-v3-result-receipts",`${row.image_id}.json`),
       upload_receipt_path:path.join(ctx.root,"reference","review-repair-v3-upload-receipts",`${row.image_id}.json`)};
     await write(path.join(ctx.root,"reference","review-repair-v3-assignments",`${row.image_id}.json`),repair);
     repairs.push(repair);
   }
   const submitted=await submitRows(ctx,repairs,Math.min(ctx.contract.production_concurrency,repairs.length));
   return console.log(JSON.stringify({status:"reviewed_reference_success_v3_submitted",count:submitted.length,image_ids:validated.ids},null,2));
 }
 if(action==="observe-successful-reviewed-references"){
   const directivesPath=path.join(ctx.root,"reference","review-success-v3.json");
   const directive=await read(directivesPath);
   const rows=await Promise.all(directive.repairs.map(row=>read(path.join(ctx.root,"reference","review-repair-v3-assignments",`${row.image_id}.json`))));
   const pending=[];
   for(const row of rows)if(!await fs.access(row.result_receipt_path).then(()=>true,()=>false)
     &&!await fs.access(falFailureReceiptPath(row)).then(()=>true,()=>false))pending.push(row);
   const observed=await observeRows(ctx,pending,Math.min(ctx.contract.production_concurrency,Math.max(1,pending.length)));
   return console.log(JSON.stringify({status:observed.every(row=>row.complete)?"complete":"pending",
     checked:observed.length,complete:observed.filter(row=>row.complete).length,
     failed:observed.filter(row=>row.failed).length},null,2));
 }
 if(action==="observe-failed-reviewed-reference"){
   const id=String(f["image-id"]??"");
   need(/^[a-z0-9][a-z0-9_-]{1,100}$/.test(id),"Exact reviewed-reference ID is required.");
   const row=await read(path.join(ctx.root,"reference","review-repair-v3-assignments",`${id}.json`));
   need(row.image_id===id&&await fs.access(row.submission_receipt_path).then(()=>true,()=>false),
     `Second reviewed-reference submission is missing for ${id}.`);
   if(await fs.access(row.result_receipt_path).then(()=>true,()=>false))
     return console.log(JSON.stringify({status:"complete",image_id:id},null,2));
   const result=(await observeRows(ctx,[row],1))[0];
   return console.log(JSON.stringify({status:result.complete?"complete":result.failed?"failed":"pending",
     image_id:id,...(result.failed?{failure_path:result.failure_path}:{})},null,2));
 }
 if(action==="finalize-reviewed-references") return console.log(JSON.stringify(await finalizeReferences(ctx),null,2));
 if(action==="finalize-references") return console.log(JSON.stringify(await finalizeReferences(ctx),null,2));
 if(action==="prepare-validation") return console.log(JSON.stringify(await prepare(ctx),null,2));
 if(action==="prepare-validation-revision") return console.log(JSON.stringify(await prepare(ctx,{revision:2}),null,2));
 if(action==="prepare-bulk") return console.log(JSON.stringify(await prepareBulk(ctx,f),null,2));
 if(action==="repair-reviewed-bulk"){
   need(f["confirm-spend"]==="exact_fal_reviewed_bulk_repair","Paid visual repair requires exact confirmation token.");
   need(path.isAbsolute(f.directives??""),"Visual repair requires absolute directives.");
   const qaPath=path.join(ctx.episodeDir,`image_output_qa_${ctx.identity.episode}.json`);
   const qa=await read(qaPath),directives=await read(f.directives),bulk=await readEffectiveBulk(ctx);
   need(qa.status==="blocked"&&qa.unresolved_blocker_count>0,"Exact image QA blocker is required.");
   need(directives.schema==="goldflow_fal_reviewed_bulk_repair_directives_v1"&&directives.qa_report_sha256===await falFileSha256(qaPath),"Visual repair directives are not bound to current QA.");
   const blocked=new Set(qa.critical_rejected_image_ids??[]);
   need(Array.isArray(directives.repairs)&&directives.repairs.length===blocked.size&&directives.repairs.every(row=>blocked.has(row.image_id)),"Every and only blocked exact image ID must be repaired.");
   need(new Set(directives.repairs.map(row=>row.image_id)).size===blocked.size,"Visual repair directives contain duplicate IDs.");
   const prompts=await read(path.join(ctx.episodeDir,"section_image_prompts_hardened.json"));
   const approval=await read(path.join(ctx.episodeDir,`visual_reference_approval_${ctx.identity.episode}.json`));
   const report=await read(path.join(ctx.episodeDir,`imagegen_report_${ctx.identity.episode}.json`));
   const ledger=await read(path.join(ctx.episodeDir,"cut_execution_ledger.json"));
   const rounds=new Map();
   for(const directive of directives.repairs){
     const selected=report.results?.find(row=>row.image_id===directive.image_id);
     const cut=ledger.cuts?.find(row=>row.image_id===directive.image_id);
     need(selected&&cut&&selected.image_path===cut.image_path
       &&cut.image_sha256===directive.rejected_image_sha256
       &&selected.generated?.output_sha256===directive.rejected_image_sha256
       &&await falFileSha256(cut.image_path)===directive.rejected_image_sha256,
       `Current rejected raster/report/ledger binding changed: ${directive.image_id}`);
     const selectedReceiptPath=selected.generated?.result_receipt_path;
     need(path.isAbsolute(selectedReceiptPath??"")
       &&await falFileSha256(selectedReceiptPath)===selected.generated.result_receipt_sha256,
       `Selected Fal result receipt changed: ${directive.image_id}`);
     const selectedReceipt=await read(selectedReceiptPath);
     need(selectedReceipt.output_path===cut.image_path
       &&selectedReceipt.output_sha256===directive.rejected_image_sha256,
       `Selected Fal result receipt does not bind rejected raster: ${directive.image_id}`);
     rounds.set(directive.image_id,await reviewedBulkRepairRound({root:ctx.root,imageId:directive.image_id,
       qaReportSha256:directives.qa_report_sha256,rejectedImageSha256:directive.rejected_image_sha256}));
   }
   await preflightPaidRepair(ctx,"bulk/review-repair-submission-receipts",
     directives.repairs.map(row=>row.image_id),id=>rounds.get(id).stem);
   const repairs=[];
   for(const directive of directives.repairs){
     const original=bulk.assignments.find(row=>row.image_id===directive.image_id);
     need(original&&original.assignment_sha256===directive.original_assignment_sha256,`Original assignment changed: ${directive.image_id}`);
     const selected=report.results.find(row=>row.image_id===directive.image_id);
     await reviewedBulkSourceReceipt({imageId:directive.image_id,
       primaryReceiptPath:original.result_receipt_path,
       selectedReceiptPath:selected.generated.result_receipt_path,
       selectedReceiptSha256:selected.generated.result_receipt_sha256,
       selectedImagePath:selected.image_path,
       selectedImageSha256:directive.rejected_image_sha256});
     need(typeof directive.finding==="string"&&directive.finding.length>20&&typeof directive.replacement_prompt==="string"&&directive.replacement_prompt.length>100,"Review finding and replacement prompt required.");
     const promptRow=prompts.prompts.find(row=>row.image_id===directive.image_id);
     need(promptRow,`Locked prompt row missing: ${directive.image_id}`);
     let refs=await nativePromptReferences(ctx,promptRow,approval);
     refs=await reviewedFalCharacterAdditions({episodeDir:ctx.episodeDir,identity:ctx.identity,promptRow,directive,refs,approval});
     if(directive.ordered_reference_asset_ids){
       const order=directive.ordered_reference_asset_ids;
       need(Array.isArray(order)&&order.length===refs.length&&new Set(order).size===refs.length&&order.every(id=>refs.some(ref=>ref.asset_id===id)),`Reference reorder is not the same approved set: ${directive.image_id}`);
       refs=order.map(id=>refs.find(ref=>ref.asset_id===id));
     }
     const round=rounds.get(directive.image_id);
     const board=refs.length?await buildReferenceBoard({root:path.join(ctx.root,"bulk","review-repair"),imageId:round.stem,references:refs}):null;
     const prompt=board?`${directive.replacement_prompt}\n\n${boardGuidance(original.panel_page_template,board)}`:directive.replacement_prompt;
     need(digest(prompt)!==original.prompt_sha256,`Visual repair prompt unchanged: ${directive.image_id}`);
     const core={...pageField(original.panel_page_template),image_id:directive.image_id,endpoint:board?FAL_ENDPOINTS.primary_edit:FAL_ENDPOINTS.primary_text,prompt,prompt_sha256:digest(prompt),run_identity_sha256:ctx.identityHash,reference_mode:board?"one_positional_collage":"text_only",reference_asset_ids:refs.map(ref=>ref.asset_id),reference_hashes:refs.map(ref=>ref.sha256),board_path:board?.output_path??null,board_sha256:board?.output_sha256??null,board_manifest_path:board?.manifest_path??null,max_cost_usd:0.05,start_sec:original.start_sec,duration_sec:original.duration_sec,previous_assignment_sha256:original.assignment_sha256,rejected_image_sha256:directive.rejected_image_sha256,repair_reason:directive.finding,qa_report_sha256:directives.qa_report_sha256};
     if(directive.character_reference_additions){
       Object.assign(core,{reviewed_character_reference_additions:directive.character_reference_additions,
         reference_review_directives_sha256:await falFileSha256(f.directives),
         reference_review_sources:Object.fromEntries(["reference_plan_sha256","reference_approval_sha256",
           "run_identity_sha256","source_script_sha256","beat_plan_sha256","panel_asset_plan_sha256"]
           .map(key=>[key,directive[key]])),reference_reviewer:directive.reviewer,
         reference_review_note:directive.reference_review_note});
     }
     const repair={...core,assignment_sha256:falObjectSha256(JSON.stringify(core)),submission_receipt_path:path.join(ctx.root,"bulk","review-repair-submission-receipts",`${round.stem}.json`),result_receipt_path:path.join(ctx.root,"bulk","review-repair-result-receipts",`${round.stem}.json`),output_path:path.join(ctx.root,"bulk","review-repair-outputs",`${round.stem}${round.stem===directive.image_id?"-v2":""}.png`),upload_receipt_path:path.join(ctx.root,"bulk","review-repair-upload-receipts",`${round.stem}.json`)};
     await write(round.assignmentPath,repair);
     repairs.push(repair);
   }
   const result=await submitRows(ctx,repairs,Math.min(ctx.contract.production_concurrency,repairs.length));
   return console.log(JSON.stringify({status:"reviewed_bulk_repair_submitted",count:result.length,image_ids:repairs.map(row=>row.image_id)},null,2));
 }
 if(action==="recover-reviewed-bulk-hold"){
   need(f["confirm-spend"]==="exact_fal_reviewed_bulk_hold_recovery","Paid reviewed hold recovery requires its exact confirmation token.");
   const id=String(f["image-id"]??"");
   need(/^[a-z0-9][a-z0-9_-]{1,100}$/.test(id),"One exact reviewed Fal image ID is required.");
   const qaPath=path.join(ctx.episodeDir,`image_output_qa_${ctx.identity.episode}.json`);
   const qa=await read(qaPath),qaHash=await falFileSha256(qaPath);
   need(qa.status==="blocked"&&qa.critical_rejected_image_ids?.includes(id),"Current blocked image QA does not contain this exact ID.");
   const ledger=await read(path.join(ctx.episodeDir,"cut_execution_ledger.json"));
   const report=await read(path.join(ctx.episodeDir,`imagegen_report_${ctx.identity.episode}.json`));
   const cut=ledger.cuts?.find(row=>row.image_id===id),selected=report.results?.find(row=>row.image_id===id);
   need(cut&&selected&&selected.image_path===cut.image_path&&selected.generated?.output_sha256===cut.image_sha256
     &&await falFileSha256(cut.image_path)===cut.image_sha256,"Rejected Fal raster/report/ledger binding changed.");
   const round=await reviewedBulkRepairRound({root:ctx.root,imageId:id,qaReportSha256:qaHash,
     rejectedImageSha256:cut.image_sha256});
   const prior=round.assignment;
   need(prior&&prior.qa_report_sha256===qaHash&&prior.rejected_image_sha256===cut.image_sha256,
     "Current reviewed repair assignment is missing or changed.");
   need(!await fs.access(prior.result_receipt_path).then(()=>true,()=>false),"Held reviewed repair already has a result.");
   const submission=await read(prior.submission_receipt_path);
   const holdPath=path.join(ctx.root,"bulk","transport-holds",`${round.stem}.json`);
   const hold=await read(holdPath),holdSha=await falFileSha256(holdPath);
   const directivePath=path.join(ctx.root,"bulk","review-repair-transport-recovery-directives",`${round.stem}.json`);
   need(f.directives===directivePath,"Reviewed hold recovery requires the exact status-reported directive path.");
   const directive=await read(directivePath);
   const scriptPath=path.join(ctx.episodeDir,"script_clean.md");
   const scriptText=await fs.readFile(scriptPath,"utf8");
   const prompt=reviewedBulkHoldRecoveryPrompt({directive,qaReportSha256:qaHash,round,
     assignment:prior,submission,hold,holdSha256:holdSha,scriptText});
   const assignmentPath=path.join(ctx.root,"bulk","review-repair-transport-recovery-assignments",`${round.stem}.json`);
   const base={...prior};
   for(const key of ["assignment_sha256","submission_receipt_path","result_receipt_path","output_path","upload_receipt_path"])
     delete base[key];
   const core={...base,prompt,prompt_sha256:digest(prompt),previous_assignment_sha256:prior.assignment_sha256,
     previous_request_id:submission.request_id,source_hold_sha256:holdSha,
     reviewed_directive_sha256:await falFileSha256(directivePath),
     source_script_sha256:await falFileSha256(scriptPath),
     terminal_evidence_sha256:digest(JSON.stringify(directive.terminal_provider_evidence)),
     recovery_reason:"terminal_504_no_cost_reviewed_visual_hold"};
   const recovery={...core,assignment_sha256:falObjectSha256(JSON.stringify(core)),
     submission_receipt_path:path.join(ctx.root,"bulk","review-repair-transport-recovery-submission-receipts",`${round.stem}.json`),
     result_receipt_path:path.join(ctx.root,"bulk","review-repair-transport-recovery-result-receipts",`${round.stem}.json`),
     output_path:path.join(ctx.root,"bulk","review-repair-transport-recovery-outputs",`${round.stem}.png`),
     upload_receipt_path:path.join(ctx.root,"bulk","review-repair-transport-recovery-upload-receipts",`${round.stem}.json`)};
   need(!await fs.access(path.join(ctx.root,"bulk","transport-holds",`${round.stem}-recovery.json`)).then(()=>true,()=>false),
     "Reviewed Fal recovery attempt has its own unresolved hold.");
   await preflightPaidRepair(ctx,"bulk/review-repair-transport-recovery-submission-receipts",[id],()=>round.stem);
   await write(assignmentPath,recovery);
   const submitted=await submitRows(ctx,[recovery],1);
   return console.log(JSON.stringify({status:"reviewed_bulk_hold_recovery_submitted",image_id:id,
     submitted:submitted.length,assignment_path:assignmentPath},null,2));
 }
 if(action==="observe-reviewed-bulk"){
   const qaPath=path.join(ctx.episodeDir,`image_output_qa_${ctx.identity.episode}.json`),qa=await read(qaPath),qaHash=await falFileSha256(qaPath);
   need(qa.status==="blocked"&&qa.critical_rejected_image_ids?.length,"Current blocked QA is required to observe reviewed repairs.");
   const ledger=await read(path.join(ctx.episodeDir,"cut_execution_ledger.json")),rows=[];
   for(const id of qa.critical_rejected_image_ids){
     const cut=ledger.cuts?.find(row=>row.image_id===id);
     need(cut&&await falFileSha256(cut.image_path)===cut.image_sha256,`Current rejected cut changed: ${id}`);
     const round=await reviewedBulkRepairRound({root:ctx.root,imageId:id,qaReportSha256:qaHash,
       rejectedImageSha256:cut.image_sha256});
     need(round.assignment,`Current reviewed repair assignment missing: ${id}`);
     const holdPath=path.join(ctx.root,"bulk","transport-holds",`${round.stem}.json`);
     const held=await fs.access(holdPath).then(()=>true,()=>false);
     const recoveryPath=path.join(ctx.root,"bulk","review-repair-transport-recovery-assignments",`${round.stem}.json`);
     const row=held?await read(recoveryPath):round.assignment;
     if(held) await verifyReviewedHoldRecovery(ctx,round,row,holdPath);
     else need(await fs.access(row.submission_receipt_path).then(()=>true,()=>false),`Reviewed repair is not submitted: ${id}`);
     if(!await fs.access(row.result_receipt_path).then(()=>true,()=>false))rows.push(row);
   }
   const result=await observeRows(ctx,rows,Math.min(ctx.contract.production_concurrency,rows.length));
   for(let i=0;i<rows.length;i++){
     if(path.basename(path.dirname(rows[i].result_receipt_path))!=="review-repair-transport-recovery-result-receipts"
       || result[i]?.status?.status!=="FAILED")continue;
     const row=rows[i],submission=await read(row.submission_receipt_path);
     const stem=path.basename(row.result_receipt_path,".json");
     await write(path.join(ctx.root,"bulk","transport-holds",`${stem}-recovery.json`),{
       schema:"goldflow_fal_transport_hold_v1",created_at:new Date().toISOString(),image_id:row.image_id,
       endpoint:submission.endpoint,request_id:submission.request_id,assignment_sha256:row.assignment_sha256,
       provider_queue_status:"FAILED",reason:"provider_failed_queue_status",billable_request_resubmitted:false});
   }
   return console.log(JSON.stringify({status:result.every(row=>row.complete)?"complete":"pending",checked:result.length,complete:result.filter(row=>row.complete).length},null,2));
 }
 if(action==="finalize-reviewed-bulk"){
   const qaPath=path.join(ctx.episodeDir,`image_output_qa_${ctx.identity.episode}.json`);
   const qa=await read(qaPath),qaHash=await falFileSha256(qaPath);
   need(qa.status==="blocked"&&qa.critical_rejected_image_ids?.length,"Blocked QA required to finalize reviewed repairs.");
   const reportPath=path.join(ctx.episodeDir,`imagegen_report_${ctx.identity.episode}.json`),ledgerPath=path.join(ctx.episodeDir,"cut_execution_ledger.json");
   const report=await read(reportPath),ledger=await read(ledgerPath),archive=path.join(ctx.root,"bulk","review-repair-previous");
   await write(path.join(archive,`imagegen-report-${await falFileSha256(reportPath)}.json`),report);
   await write(path.join(archive,`cut-ledger-${await falFileSha256(ledgerPath)}.json`),ledger);
   for(const id of qa.critical_rejected_image_ids){
     const result=report.results.find(row=>row.image_id===id),cut=ledger.cuts.find(row=>row.image_id===id);
     need(result&&cut&&result.image_path===cut.image_path&&result.generated?.output_sha256===cut.image_sha256
       &&await falFileSha256(cut.image_path)===cut.image_sha256,`Prior cut binding changed: ${id}`);
     const round=await reviewedBulkRepairRound({root:ctx.root,imageId:id,qaReportSha256:qaHash,
       rejectedImageSha256:cut.image_sha256});
     need(round.assignment,"Current QA-bound reviewed repair assignment is missing: "+id);
     const holdPath=path.join(ctx.root,"bulk","transport-holds",`${round.stem}.json`);
     const held=await fs.access(holdPath).then(()=>true,()=>false);
     const assignment=held
       ?await read(path.join(ctx.root,"bulk","review-repair-transport-recovery-assignments",`${round.stem}.json`))
       :round.assignment;
     const recoverySubmission=held?await verifyReviewedHoldRecovery(ctx,round,assignment,holdPath):null;
     const receipt=await read(assignment.result_receipt_path);
     need(receipt.output_sha256===await falFileSha256(receipt.output_path),`Reviewed repair raster changed: ${id}`);
     need(receipt.output_path===assignment.output_path&&cut.image_sha256===assignment.rejected_image_sha256,
       `Current QA reviewed repair selection changed: ${id}`);
     need(!held||receipt.request_id===recoverySubmission.request_id,
       `Reviewed Fal hold recovery result request changed: ${id}`);
     result.image_path=receipt.output_path;
     const recoveryType=held?"reviewed_visual_transport_recovery":"reviewed_visual_repair";
     result.generated={...result.generated,...receipt,output_sha256:receipt.output_sha256,result_receipt_path:assignment.result_receipt_path,result_receipt_sha256:await falFileSha256(assignment.result_receipt_path),recovery_type:recoveryType,previous_image_sha256:assignment.rejected_image_sha256};
     Object.assign(cut,{image_path:receipt.output_path,image_sha256:receipt.output_sha256,prompt_hash:assignment.prompt_sha256,reference_ids:assignment.reference_asset_ids,provider_request_id:receipt.request_id,provider_receipt_path:assignment.result_receipt_path,provider_receipt_sha256:await falFileSha256(assignment.result_receipt_path),recovery_type:recoveryType,previous_image_sha256:assignment.rejected_image_sha256});
   }
   const promptPlan=await read(path.join(ctx.episodeDir,"section_image_prompts_hardened.json"));
   const completed=await completeFalPanelArtwork({episodeDir:ctx.episodeDir,prompts:promptPlan.prompts,
     results:report.results,cuts:ledger.cuts,ownerImageIds:qa.critical_rejected_image_ids});
   report.results=completed.results;ledger.cuts=completed.cuts;
   report.updated_at=new Date().toISOString();ledger.updated_at=report.updated_at;
   await write(path.join(ctx.root,"bulk","image-reports",`reviewed-${digest(JSON.stringify(report)).slice(0,16)}.json`),report);
   await fs.writeFile(reportPath,bytes(report));await fs.writeFile(ledgerPath,bytes(ledger));
   return console.log(JSON.stringify({status:"reviewed_bulk_repair_finalized",image_ids:qa.critical_rejected_image_ids,imagegen_report:reportPath,cut_execution_ledger:ledgerPath},null,2));
 }
 // Zone-scoped page repair: one reviewed single artwork for exactly one rejected zone.
 if(["prepare-zone-repair","dispatch-zone-repair","observe-zone-repair","apply-zone-repair"].includes(action)){
   if(action==="prepare-zone-repair"){
     need(path.isAbsolute(f.request??""),"Zone repair preparation requires an absolute --request file.");
     const spec=await prepareZoneRepair({episodeDir:ctx.episodeDir,episode:ctx.identity.episode,request:await read(f.request)});
     return console.log(JSON.stringify({status:spec.status,spec_path:spec.spec_path,spec_sha256:spec.spec_sha256,image_ids:spec.image_ids,provider_calls:0},null,2));
   }
   need(path.isAbsolute(f.spec??""),"Zone repair requires an absolute --spec file.");
   const specSha256=await falFileSha256(f.spec),spec=await read(f.spec);
   await validateZoneRepairRequest({episodeDir:ctx.episodeDir,episode:ctx.identity.episode,request:spec.request});
   const bulk=await readEffectiveBulk(ctx);const owner=(await read(path.join(ctx.episodeDir,"section_image_prompts_hardened.json"))).prompts.find(row=>row.panel_asset_id===spec.request.page_asset_id&&row.provider_submission_required!==false);
   const original=bulk.assignments.find(row=>row.image_id===owner?.image_id);need(original,`Accepted Fal assignment missing for page ${spec.request.page_asset_id}.`);
   const board=original.board_manifest_path?await read(original.board_manifest_path):null;
   if(board)need(await falFileSha256(original.board_path)===original.board_sha256,`Page owner reference board changed: ${original.image_id}.`);
   const row=buildZoneRepairAssignment({falRoot:ctx.root,spec,specSha256,original,boardGuidance:board?referenceBoardPromptGuidance(board):null,identityHash:ctx.identityHash,objectSha256:falObjectSha256});
   if(action==="dispatch-zone-repair"){
     need(f["confirm-spend"]==="exact_fal_zone_repair","Paid zone repair requires the exact confirmation token.");
     await write(row.assignment_path,row);
     await preflightPaidRepair(ctx,ZONE_REPAIR_RECEIPT_DIR,[row.image_id],()=>row.stem);
     const result=await submitRows(ctx,[row],1);return console.log(JSON.stringify({status:"zone_repair_submitted",count:result.length,stem:row.stem,image_ids:spec.image_ids},null,2));
   }
   const assigned=await read(row.assignment_path);need(assigned.assignment_sha256===row.assignment_sha256,`Zone repair assignment changed: ${row.stem}.`);
   if(action==="observe-zone-repair"){
     if(await fs.access(falFailureReceiptPath(assigned)).then(()=>true,()=>false))return console.log(JSON.stringify({status:"blocked",stem:row.stem,failure_path:falFailureReceiptPath(assigned)},null,2));
     if(await fs.access(assigned.result_receipt_path).then(()=>true,()=>false))return console.log(JSON.stringify({status:"complete",stem:row.stem},null,2));
     const result=(await observeRows(ctx,[assigned],1))[0];return console.log(JSON.stringify({status:result.failed?"blocked":result.complete?"complete":"pending",stem:row.stem,result},null,2));
   }
   const receipt=await read(assigned.result_receipt_path);need(receipt.output_path===assigned.output_path,"Zone repair result receipt binding differs.");
   const applied=await applyZoneRepair({episodeDir:ctx.episodeDir,episode:ctx.identity.episode,specPath:f.spec,specSha256,replacementPath:assigned.output_path,resultReceiptPath:assigned.result_receipt_path,resultReceiptSha256:await falFileSha256(assigned.result_receipt_path)});
   return console.log(JSON.stringify(applied,null,2));
 }
 if(action==="dispatch-bulk"){
   need(f["confirm-spend"]==="exact_fal_bulk_batch","Paid bulk dispatch requires exact confirmation token.");const bulk=await readEffectiveBulk(ctx);const limit=Math.min(Number(f.limit??100),100);need(Number.isInteger(limit)&&limit>0,"Bulk limit must be 1..100.");const rows=[];for(const row of bulk.assignments)if(!await fs.access(row.submission_receipt_path).then(()=>true,()=>false)&&!await fs.access(falAdjudicationPath(ctx.episodeDir,row.image_id)).then(()=>true,()=>false)){rows.push(row);if(rows.length===limit)break;}const result=await submitRows(ctx,rows,ctx.contract.production_concurrency);return console.log(JSON.stringify({status:"submitted",count:result.length,remaining:bulk.assignments.length-(await Promise.all(bulk.assignments.map(row=>fs.access(row.submission_receipt_path).then(()=>1,()=>0)))).reduce((a,b)=>a+b,0)},null,2));
 }
 if(action==="repair-failures"){
   need(f["confirm-spend"]==="exact_fal_repair_batch","Paid repair dispatch requires exact confirmation token.");need(path.isAbsolute(f.directives??""),"Repair dispatch requires an absolute --directives file.");
   const bulk=await readEffectiveBulk(ctx);const directives=await read(f.directives);need(directives?.schema==="goldflow_fal_repair_directives_v1"&&Array.isArray(directives.repairs)&&directives.repairs.length,"Exact repair directives are required.");await preflightPaidRepair(ctx,"bulk/repair-submission-receipts",directives.repairs.map(row=>row.image_id));const repairs=[];
   for(const directive of directives.repairs){const original=bulk.assignments.find(row=>row.image_id===directive.image_id);need(original&&directive.original_assignment_sha256===original.assignment_sha256,`Repair binding changed for ${directive.image_id}.`);const failurePath=path.join(ctx.root,"bulk","failure-receipts",`${directive.image_id}.json`);need(await fs.access(failurePath).then(()=>true,()=>false),`No exact failure exists for ${directive.image_id}.`);need(typeof directive.replacement_prompt==="string"&&directive.replacement_prompt.length>40,"Repair prompt is missing.");const core={...original,prompt:directive.replacement_prompt,prompt_sha256:digest(directive.replacement_prompt),previous_assignment_sha256:original.assignment_sha256,repair_reason:directive.repair_reason};for(const key of ["assignment_sha256","assignment_path","submission_receipt_path","result_receipt_path","output_path","upload_receipt_path"])delete core[key];const repair={...core,assignment_sha256:falObjectSha256(JSON.stringify(core)),submission_receipt_path:path.join(ctx.root,"bulk","repair-submission-receipts",`${directive.image_id}.json`),result_receipt_path:path.join(ctx.root,"bulk","repair-result-receipts",`${directive.image_id}.json`),output_path:original.output_path,upload_receipt_path:path.join(ctx.root,"bulk","repair-upload-receipts",`${directive.image_id}.json`)};const assignmentPath=path.join(ctx.root,"bulk","repair-assignments",`${directive.image_id}.json`);await write(assignmentPath,repair);repairs.push(repair);}
   const result=await submitRows(ctx,repairs,Math.min(ctx.contract.production_concurrency,repairs.length));return console.log(JSON.stringify({status:"repair_submitted",count:result.length,image_ids:repairs.map(r=>r.image_id)},null,2));
 }
 if(action==="observe-repairs"){
   const dir=path.join(ctx.root,"bulk","repair-assignments");const names=await fs.readdir(dir);const rows=[];let failed=0;for(const name of names.filter(n=>n.endsWith(".json"))){const row=await read(path.join(dir,name));if(await fs.access(falFailureReceiptPath(row)).then(()=>true,()=>false)){failed++;continue;}if(!await fs.access(row.result_receipt_path).then(()=>true,()=>false))rows.push(row);}const result=await observeRows(ctx,rows,ctx.contract.production_concurrency);failed+=result.filter(r=>r.failed).length;return console.log(JSON.stringify({status:failed?"blocked":result.every(r=>r.complete)?"complete":"pending",checked:result.length,complete:result.filter(r=>r.complete).length,failed,pending:result.filter(r=>!r.complete&&!r.failed).length},null,2));
 }
 if(action==="inspect-repair-failure"){
   const id=String(f["image-id"]??"");need(/^[a-z0-9][a-z0-9_-]{1,100}$/.test(id),"An exact Fal image ID is required.");
   const assignment=await read(path.join(ctx.root,"bulk","repair-assignments",`${id}.json`));need(assignment.image_id===id,"Repair assignment ID changed.");
   const failurePath=falFailureReceiptPath(assignment);const failure=await read(failurePath);
   need(failure.image_id===id&&failure.assignment_sha256===assignment.assignment_sha256,"Repair failure binding changed.");
   return console.log(JSON.stringify({status:"blocked",image_id:id,repair_assignment_path:path.join(ctx.root,"bulk","repair-assignments",`${id}.json`),repair_failure_path:failurePath,original_failure_path:path.join(ctx.root,"bulk","failure-receipts",`${id}.json`),failure,
     reviewed_directive_path:path.join(ctx.root,"bulk","repair-v2-directives",`${id}.json`),
     directive_schema:"goldflow_fal_failed_repair_directive_v1",directive_required_fields:["image_id","failed_repair_assignment_sha256","failed_repair_request_id","replacement_prompt","repair_reason","reviewer","note"]},null,2));
 }
 if(action==="repair-failed-repair"){
   need(f["confirm-spend"]==="exact_fal_repair_v2","Paid second repair requires exact confirmation token.");
   need(path.isAbsolute(f.directives??""),"Second repair requires an absolute reviewed directive.");
   const id=String(f["image-id"]??"");need(/^[a-z0-9][a-z0-9_-]{1,100}$/.test(id),"One exact Fal image ID is required.");
   need(f.directives===path.join(ctx.root,"bulk","repair-v2-directives",`${id}.json`),"Second repair requires the exact reviewed directive path reported by status.");
   const directive=await read(f.directives);
   need(directive?.schema==="goldflow_fal_failed_repair_directive_v1"&&directive.image_id===id,
     "Reviewed second-repair directive must bind one exact image ID.");
   need(typeof directive.reviewer==="string"&&directive.reviewer.trim()&&typeof directive.note==="string"&&directive.note.trim(),
     "Second repair requires reviewer and review note.");
   need(typeof directive.replacement_prompt==="string"&&directive.replacement_prompt.length>40
     &&typeof directive.repair_reason==="string"&&directive.repair_reason.trim(),"Reviewed second-repair prompt and reason are required.");
   const prior=await read(path.join(ctx.root,"bulk","repair-assignments",`${id}.json`));
   need(prior.image_id===id,"Prior repair assignment ID changed.");
   const failure=await read(falFailureReceiptPath(prior));
   need(failure.image_id===id&&failure.assignment_sha256===prior.assignment_sha256
     &&failure.assignment_sha256===directive.failed_repair_assignment_sha256
     &&failure.request_id===directive.failed_repair_request_id,"Second repair is not bound to the exact failed request.");
   const v2Path=path.join(ctx.root,"bulk","repair-v2-assignments",`${id}.json`);
   await absent(v2Path);
   await preflightPaidRepair(ctx,"bulk/repair-v2-submission-receipts",[id]);
   const core={...prior,prompt:directive.replacement_prompt,prompt_sha256:digest(directive.replacement_prompt),
     previous_assignment_sha256:prior.assignment_sha256,previous_request_id:failure.request_id,
     repair_reason:directive.repair_reason,reviewer:directive.reviewer,review_note:directive.note};
   for(const key of ["assignment_sha256","assignment_path","submission_receipt_path","result_receipt_path","output_path","upload_receipt_path"])delete core[key];
   const repair={...core,assignment_sha256:falObjectSha256(JSON.stringify(core)),
     submission_receipt_path:path.join(ctx.root,"bulk","repair-v2-submission-receipts",`${id}.json`),
     result_receipt_path:path.join(ctx.root,"bulk","repair-v2-result-receipts",`${id}.json`),
     output_path:prior.output_path,upload_receipt_path:path.join(ctx.root,"bulk","repair-v2-upload-receipts",`${id}.json`)};
   await write(v2Path,repair);
   const result=await submitRows(ctx,[repair],1);
   return console.log(JSON.stringify({status:"second_repair_submitted",image_id:id,count:result.length,assignment_path:v2Path},null,2));
 }
 if(action==="observe-repair-v2"){
   const id=String(f["image-id"]??"");need(/^[a-z0-9][a-z0-9_-]{1,100}$/.test(id),"One exact Fal image ID is required.");
   const row=await read(path.join(ctx.root,"bulk","repair-v2-assignments",`${id}.json`));need(row.image_id===id,"Second repair assignment ID changed.");
   if(await fs.access(falFailureReceiptPath(row)).then(()=>true,()=>false))return console.log(JSON.stringify({status:"blocked",image_id:id,failure_path:falFailureReceiptPath(row)},null,2));
   if(await fs.access(row.result_receipt_path).then(()=>true,()=>false))return console.log(JSON.stringify({status:"complete",image_id:id},null,2));
   const result=(await observeRows(ctx,[row],1))[0];return console.log(JSON.stringify({status:result.failed?"blocked":result.complete?"complete":"pending",image_id:id,result},null,2));
 }
 if(action==="observe-bulk"){
   const bulk=await readEffectiveBulk(ctx);const limit=Math.min(Number(f.limit??100),100);const rows=[];for(const row of bulk.assignments){const submitted=await fs.access(row.submission_receipt_path).then(()=>true,()=>false),done=await fs.access(row.result_receipt_path).then(()=>true,()=>false),failed=await fs.access(path.join(ctx.root,"bulk","failure-receipts",`${row.image_id}.json`)).then(()=>true,()=>false),held=await fs.access(path.join(ctx.root,"bulk","transport-holds",`${row.image_id}.json`)).then(()=>true,()=>false);if(submitted&&!done&&!failed&&!held){rows.push(row);if(rows.length===limit)break;}}const result=await observeRows(ctx,rows,ctx.contract.production_concurrency);return console.log(JSON.stringify({status:result.every(r=>r.complete||r.failed||r.transport_pending)?"observed":"pending",checked:result.length,complete:result.filter(r=>r.complete).length,failed:result.filter(r=>r.failed).length,held:result.filter(r=>r.transport_pending).length,pending:result.filter(r=>!r.complete&&!r.failed&&!r.transport_pending).length},null,2));
 }
 if(action==="observe-holds"){
   const bulk=await readEffectiveBulk(ctx);const rows=[];for(const row of bulk.assignments){const held=await fs.access(path.join(ctx.root,"bulk","transport-holds",`${row.image_id}.json`)).then(()=>true,()=>false),done=await fs.access(row.result_receipt_path).then(()=>true,()=>false),recovered=await fs.access(path.join(ctx.root,"bulk","transport-recovery-result-receipts",`${row.image_id}.json`)).then(()=>true,()=>false);if(held&&!done&&!recovered)rows.push(row);}const result=await observeRows(ctx,rows,ctx.contract.production_concurrency);for(let i=0;i<rows.length;i++){const row=rows[i],observed=result[i];await write(path.join(ctx.root,"bulk","hold-observation-receipts",`${row.image_id}.json`),{schema:"goldflow_fal_hold_observation_v1",observed_at:new Date().toISOString(),image_id:row.image_id,original_assignment_sha256:row.assignment_sha256,original_request_id:(await read(row.submission_receipt_path)).request_id,complete:observed.complete===true,transport_pending:observed.transport_pending===true,transient_observation_timeout:observed.transient_observation_timeout===true});}return console.log(JSON.stringify({status:result.every(r=>r.complete)?"complete":"pending",checked:result.length,complete:result.filter(r=>r.complete).length,pending:result.filter(r=>!r.complete).length},null,2));
 }
 if(action==="recover-holds"){
   need(f["confirm-spend"]==="exact_fal_transport_recovery","Paid transport recovery requires exact confirmation token.");need(path.isAbsolute(f.directives??""),"Transport recovery requires an absolute --directives file.");
   const bulk=await readEffectiveBulk(ctx);const directives=await read(f.directives);need(directives?.schema==="goldflow_fal_transport_recovery_directives_v1"&&Array.isArray(directives.recoveries)&&directives.recoveries.length,"Exact transport recovery directives are required.");await preflightPaidRepair(ctx,"bulk/transport-recovery-submission-receipts",directives.recoveries.map(row=>row.image_id));const recoveries=[];
   for(const directive of directives.recoveries){const original=bulk.assignments.find(row=>row.image_id===directive.image_id);need(original&&directive.original_assignment_sha256===original.assignment_sha256,`Transport recovery binding changed for ${directive.image_id}.`);const hold=await read(path.join(ctx.root,"bulk","transport-holds",`${directive.image_id}.json`));need(hold.request_id===directive.original_request_id,`Transport recovery request ID changed for ${directive.image_id}.`);const core={...original,previous_request_id:hold.request_id,transport_recovery_reason:directive.recovery_reason};for(const key of ["assignment_sha256","assignment_path","submission_receipt_path","result_receipt_path","output_path","upload_receipt_path"])delete core[key];const recovery={...core,assignment_sha256:falObjectSha256(JSON.stringify(core)),submission_receipt_path:path.join(ctx.root,"bulk","transport-recovery-submission-receipts",`${directive.image_id}.json`),result_receipt_path:path.join(ctx.root,"bulk","transport-recovery-result-receipts",`${directive.image_id}.json`),output_path:original.output_path,upload_receipt_path:path.join(ctx.root,"bulk","transport-recovery-upload-receipts",`${directive.image_id}.json`)};const assignmentPath=path.join(ctx.root,"bulk","transport-recovery-assignments",`${directive.image_id}.json`);await write(assignmentPath,recovery);recoveries.push(recovery);}
   const result=await submitRows(ctx,recoveries,Math.min(ctx.contract.production_concurrency,recoveries.length));return console.log(JSON.stringify({status:"transport_recovery_submitted",count:result.length,image_ids:recoveries.map(r=>r.image_id)},null,2));
 }
 if(action==="observe-transport-recovery"){
   const dir=path.join(ctx.root,"bulk","transport-recovery-assignments");const names=await fs.readdir(dir);const rows=[];for(const name of names.filter(n=>n.endsWith(".json"))){const row=await read(path.join(dir,name));if(!await fs.access(row.result_receipt_path).then(()=>true,()=>false))rows.push(row);}const result=await observeRows(ctx,rows,ctx.contract.production_concurrency);return console.log(JSON.stringify({status:result.every(r=>r.complete)?"complete":"pending",checked:result.length,complete:result.filter(r=>r.complete).length,pending:result.filter(r=>!r.complete).length},null,2));
 }
 if(action==="finalize-bulk"){
   const bulk=await readEffectiveBulk(ctx);const planPath=path.join(ctx.episodeDir,"section_image_prompts_hardened.json");const plan=await read(planPath);const promptHash=await falFileSha256(planPath);const promptById=new Map(plan.prompts.map(row=>[row.image_id,row]));let results=[];let cuts=[];
   const prebulkCorrection=await validateFalPrebulkPromptCorrection({episodeDir:ctx.episodeDir,
     validationPlanPath:await validationPlanPath(ctx),validationReviewPath:await validationReviewPath(ctx)});
   need(Boolean(prebulkCorrection)===Boolean(bulk.prebulk_prompt_correction_receipt_sha256),
     "Final Fal bulk plan changed its reviewed pre-bulk prompt correction lineage.");
   for(const row of bulk.assignments){const receiptCandidates=[row.result_receipt_path,path.join(ctx.root,"bulk","ambiguous-retry-result-receipts",`${row.image_id}.json`),path.join(ctx.root,"bulk","transport-recovery-result-receipts",`${row.image_id}.json`),path.join(ctx.root,"bulk","repair-result-receipts",`${row.image_id}.json`),path.join(ctx.root,"bulk","repair-v2-result-receipts",`${row.image_id}.json`)];let receiptPath=null;for(const candidate of receiptCandidates)if(await fs.access(candidate).then(()=>true,()=>false)){receiptPath=candidate;break;}need(receiptPath,`Final Fal result missing for ${row.image_id}.`);const receipt=await read(receiptPath);need(await falFileSha256(receipt.output_path)===receipt.output_sha256,`Final Fal raster hash changed for ${row.image_id}.`);const prompt=promptById.get(row.image_id);need(prompt,`Final Fal prompt row missing for ${row.image_id}.`);const effectiveAssignment=receiptPath.includes("repair-v2-result-receipts")?await read(path.join(ctx.root,"bulk","repair-v2-assignments",`${row.image_id}.json`)):receiptPath.includes("repair-result-receipts")?await read(path.join(ctx.root,"bulk","repair-assignments",`${row.image_id}.json`)):row;if(receiptPath.includes("repair-result-receipts")||receiptPath.includes("repair-v2-result-receipts")||effectiveAssignment.source_bulk_assignment_sha256){const submission=await read(effectiveAssignment.submission_receipt_path);need(submission.request_id===receipt.request_id&&submission.assignment_sha256===effectiveAssignment.assignment_sha256,`Final Fal assignment binding changed for ${row.image_id}.`);}const referenceInputs=prompt.reference_bindings??[];const recoveryType=receiptPath.includes("ambiguous-retry")?"adjudicated_no_job_retry":receiptPath.includes("repair-v2-result")?"content_policy_repair_v2":receiptPath.includes("repair-result")?"content_policy_repair":receiptPath.includes("transport-recovery")?"transport_recovery":"original";const generated={output_sha256:receipt.output_sha256,model:row.endpoint,provider:"fal_ai",request_id:receipt.request_id,result_receipt_path:receiptPath,result_receipt_sha256:await falFileSha256(receiptPath),recovery_type:recoveryType,...receipt};results.push({image_id:row.image_id,scene_id:prompt.scene_id,image_path:receipt.output_path,status:"generated",generated,reference_inputs:referenceInputs});cuts.push({image_id:row.image_id,scene_id:prompt.scene_id,visual_beat_id:prompt.visual_beat_id,start_sec:prompt.start_sec,duration_sec:prompt.duration_sec,prompt_hash:effectiveAssignment.prompt_sha256,reference_ids:effectiveAssignment.reference_asset_ids,reference_inputs:referenceInputs,image_path:receipt.output_path,image_sha256:receipt.output_sha256,provider:"fal_ai",model:row.endpoint,provider_request_id:receipt.request_id,provider_receipt_path:receiptPath,provider_receipt_sha256:await falFileSha256(receiptPath),recovery_type:recoveryType});}
   need(results.length===bulk.assignments.length&&results.length===(await falArtworkOrders({episodeDir:ctx.episodeDir,prompts:plan.prompts})).length,"Fal final owner count does not match the locked artwork allocation."); ({results,cuts}=await completeFalPanelArtwork({episodeDir:ctx.episodeDir,prompts:plan.prompts,results,cuts}));const updatedAt=new Date().toISOString();const report={schema:"goldflow_imagegen_report_v1",status:"passed",image_provider:"fal_ai",prompt_plan_path:planPath,prompt_plan_hash:promptHash,expected_image_count:results.length,unique_generated_image_count:bulk.assignments.length,image_count:results.length,missing_image_count:0,results,updated_at:updatedAt,...(bulk.postplan_prompt_correction_receipt_sha256?{postplan_prompt_correction_receipt_sha256:bulk.postplan_prompt_correction_receipt_sha256}:{})};const ledger={schema:"goldflow_cut_execution_ledger_v1",prompt_plan_path:planPath,prompt_plan_hash:promptHash,cuts,updated_at:updatedAt,...(bulk.postplan_prompt_correction_receipt_sha256?{postplan_prompt_correction_receipt_sha256:bulk.postplan_prompt_correction_receipt_sha256}:{})};const immutableReportPath=path.join(ctx.root,"bulk","image-reports",`${Date.now()}-${digest(JSON.stringify(report)).slice(0,12)}.json`);await write(immutableReportPath,report);await write(path.join(ctx.episodeDir,`imagegen_report_${ctx.identity.episode}.json`),report);await write(path.join(ctx.episodeDir,"cut_execution_ledger.json"),ledger);return console.log(JSON.stringify({status:"passed",image_count:results.length,imagegen_report:path.join(ctx.episodeDir,`imagegen_report_${ctx.identity.episode}.json`),cut_execution_ledger:path.join(ctx.episodeDir,"cut_execution_ledger.json"),immutable_report:immutableReportPath},null,2));
 }
 const plan=await read(await validationPlanPath(ctx));
 if(action==="billing-submit"){need(f["confirm-spend"]==="exact_fal_validation_probe","Paid probe requires exact confirmation token.");return console.log(JSON.stringify({status:"submitted",count:(await submitRows(ctx,[plan.assignments[0]],1)).length},null,2));}
 if(action==="billing-observe"){const result=await observeRows(ctx,[plan.assignments[0]],1);return console.log(JSON.stringify({status:result[0].complete?"complete":"pending",result},null,2));}
 if(action==="dispatch-validation"){need(f["confirm-spend"]==="exact_fal_validation_set","Paid validation requires exact confirmation token.");const rows=[];for(const row of plan.assignments.slice(1))if(!await fs.access(row.submission_receipt_path).then(()=>true,()=>false))rows.push(row);return console.log(JSON.stringify({status:"submitted",count:(await submitRows(ctx,rows,8)).length},null,2));}
 if(action==="observe-validation"){const rows=[];for(const row of plan.assignments)if(!await fs.access(row.result_receipt_path).then(()=>true,()=>false))rows.push(row);const result=await observeRows(ctx,rows,8);return console.log(JSON.stringify({status:result.every(r=>r.complete)?"complete":"pending",complete:result.filter(r=>r.complete).length,pending:result.filter(r=>!r.complete).length},null,2));}
 if(action==="review-validation"){const approved=String(f["approve-ids"]??"").split(",").filter(Boolean),rejected=String(f["reject-ids"]??"").split(",").filter(Boolean);need(f.reviewer&&f.note,"Review requires reviewer and note.");need(approved.length+rejected.length===8&&new Set([...approved,...rejected]).size===8,"Review must disposition all eight exact IDs.");const nativeFal=ctx.identity.visual_restart?.fork_at==="visual_reference_plan";const critical=nativeFal?[plan.assignments[0].image_id]:[plan.assignments[0].image_id,"openart-validation-four-person-roulette-v1","openart-validation-wide-grand-salon-v1"];const status=approved.length>=7&&critical.every(id=>approved.includes(id))?"passed":"failed";const review={schema:"goldflow_fal_validation_review_v1",created_at:new Date().toISOString(),reviewer:f.reviewer,note:f.note,status,approved_ids:approved,rejected_ids:rejected,criteria:nativeFal?["identity consistency","hands","prop fidelity","environment detail","composition","unwanted text"]:["identity consistency","hands","prop fidelity","casino detail","composition","unwanted text"],minor_cosmetic_differences_accepted:true};await write(await validationReviewPath(ctx),review);return console.log(JSON.stringify(review,null,2));}
 throw new Error(`Unsupported Fal action: ${action}`);
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
