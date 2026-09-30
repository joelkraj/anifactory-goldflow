import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import sharp from 'sharp';
import {loadTrueCrimeProofIdentity,trueCrimeProofFileRef} from './true-crime-proof-workflow.mjs';

const exec=promisify(execFile);
const hash=data=>createHash('sha256').update(data).digest('hex');
const need=(ok,message)=>{if(!ok)throw new Error(`Proof source assets: ${message}`);};
const filename=value=>{need(typeof value==='string'&&/^[a-z0-9][a-z0-9_.-]+$/.test(value),'safe explicit filename required');return value;};
const write=(file,value)=>fs.writeFile(file,JSON.stringify(value,null,2)+'\n',{flag:'wx'});

/** Source-only action inside an already opened and identity-bound asset attempt. */
export async function prepareTrueCrimeProofAssets({proofDir,attempt_token,recipePath}){
  const {identity,identity_sha256}=await loadTrueCrimeProofIdentity({proofDir});
  const start=JSON.parse(await fs.readFile(path.join(proofDir,'attempts/source_assets/start.json'),'utf8'));
  const lock=JSON.parse(await fs.readFile(path.join(proofDir,'operation.lock'),'utf8'));
  need(start.identity_sha256===identity_sha256&&start.attempt_token_sha256===hash(attempt_token)&&lock.attempt_token_sha256===start.attempt_token_sha256&&lock.stage==='source_assets','exact open source-assets attempt required');
  const recipeRef=await trueCrimeProofFileRef(recipePath);
  need(start.inputs.some(r=>r.path===recipeRef.path&&r.sha256===recipeRef.sha256),'asset recipe must be bound before media work');
  const recipe=JSON.parse(await fs.readFile(recipePath,'utf8'));
  need(recipe.schema==='goldflow_true_crime_proof_assets_v1','unsupported asset recipe');
  need(Array.isArray(recipe.downloads)&&recipe.downloads.length<=2&&Array.isArray(recipe.documents)&&recipe.documents.length<=6&&Array.isArray(recipe.image_operations)&&recipe.image_operations.length<=2,'bounded explicit asset lists required');
  const outputDir=path.join(proofDir,'attempts/source_assets/output');
  const selectedIds=new Set(),selectedFiles=new Set();
  for(const item of [...recipe.downloads,...recipe.documents,...recipe.image_operations]){
    need(/^[A-Za-z][A-Za-z0-9_-]*$/.test(item.id)&&!selectedIds.has(item.id),'unique recipe asset IDs required');selectedIds.add(item.id);
    if(item.filename){filename(item.filename);need(!selectedFiles.has(item.filename),'unique recipe output filenames required');selectedFiles.add(item.filename);}
  }
  for(const item of recipe.documents)need(item.filename?.endsWith('.png'),'document outputs must be explicit PNG files');
  need(new Set(recipe.image_operations.map(item=>item.operation)).size===recipe.image_operations.length,'image operations cannot repeat');
  await write(path.join(outputDir,'preparation-start.json'),{identity_sha256,recipe:recipeRef,started_at:new Date().toISOString(),automatic_retry:false});
  const artifacts=[],acquired_sources=[],derivations=[],requests=[];
  const ids=new Set();
  const add=async(id,file,kind,source_ids=[])=>{
    need(/^[A-Za-z][A-Za-z0-9_-]*$/.test(id)&&!ids.has(id),'unique asset IDs required');ids.add(id);
    const ref=await trueCrimeProofFileRef(file);artifacts.push({id,...ref,kind,source_ids});return ref;
  };
  for(const item of recipe.downloads){
    const source=identity.sources.find(s=>s.id===item.source_id);
    need(source?.acquisition==='pending'&&source.url.startsWith('https://'),'download must match a selected pending HTTPS source');
    need(Number.isInteger(item.max_bytes)&&item.max_bytes>0&&item.max_bytes<=8_000_000,'download size cap required');
    const file=path.join(outputDir,filename(item.filename));
    const requestPath=path.join(outputDir,filename(item.filename)+'.request.json');
    await write(requestPath,{source_id:source.id,url:source.url,max_bytes:item.max_bytes,started_at:new Date().toISOString(),automatic_retry:false});
    const response=await fetch(source.url,{redirect:'error',signal:AbortSignal.timeout(45000)});
    need(response.ok&&/^image\//i.test(response.headers.get('content-type')??''),'selected source did not return an image');
    const reader=response.body.getReader();let size=0;const chunks=[];
    while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>item.max_bytes){await reader.cancel();throw new Error('Selected image exceeds the locked byte limit');}chunks.push(value);}
    const bytes=Buffer.concat(chunks);const meta=await sharp(bytes).metadata();
    need(['jpeg','png','webp'].includes(meta.format)&&meta.width>=150&&meta.height>=150,'unsupported or unusably small source image');
    await fs.writeFile(file,bytes,{flag:'wx'});
    const ref=await add(item.id,file,'source_image',[source.id]);
    acquired_sources.push({id:source.id,...ref,url:source.url});
    derivations.push({id:item.id,method:'selected_public_image_download',source_id:source.id,source_url:source.url,bytes:size,width:meta.width,height:meta.height,request:await trueCrimeProofFileRef(requestPath),output:ref});
  }
  for(const item of recipe.documents){
    const source=identity.sources.find(s=>s.id===item.source_id);
    need(source?.acquisition==='research_copy'&&source.path.toLowerCase().endsWith('.pdf'),'document crop requires an identity-bound research PDF');
    need((await trueCrimeProofFileRef(source.path)).sha256===source.sha256,'source PDF changed');
    const rect=item.rect_points;
    need(Number.isInteger(item.page)&&item.page>=1&&item.page<=100&&Number.isInteger(item.dpi)&&item.dpi>=144&&item.dpi<=300&&Array.isArray(rect)&&rect.length===4&&rect.every(Number.isFinite)&&rect[0]>=0&&rect[1]>=0&&rect[2]>0&&rect[3]>0,'explicit bounded PDF page/crop required');
    const prefix=path.join(outputDir,filename(item.filename).replace(/\.png$/,''));
    const scale=item.dpi/72,px=rect.map(v=>Math.round(v*scale));
    await exec('pdftoppm',['-f',String(item.page),'-l',String(item.page),'-r',String(item.dpi),'-x',String(px[0]),'-y',String(px[1]),'-W',String(px[2]),'-H',String(px[3]),'-singlefile','-png',source.path,prefix],{timeout:45000,maxBuffer:100000});
    const ref=await add(item.id,prefix+'.png','document_excerpt',[source.id]);
    derivations.push({id:item.id,method:'pdf_page_crop_render',source_id:source.id,source_sha256:source.sha256,page:item.page,rect_points:rect,dpi:item.dpi,output:ref});
  }
  for(const item of recipe.image_operations){
    const stills=identity.providers?.stills;
    need(stills?.operations.includes(item.operation)&&typeof item.prompt==='string'&&item.prompt.trim()&&item.prompt.length<10000,'selected image operation and explicit prompt required');
    const target=item.input_asset_id?artifacts.find(a=>a.id===item.input_asset_id):null;
    need(!item.input_asset_id||target,'edit input must be an acquired asset in this attempt');
    const request={schema:'goldflow_true_crime_image_request_v1',operation:item.operation,provider:stills.provider,model:stills.model,prompt:item.prompt,input:target?{path:target.path,sha256:target.sha256}:null,output_id:item.id,attempt:1,automatic_retry:false,requested_at:new Date().toISOString()};
    const file=path.join(outputDir,filename(item.id)+'.request.json');await write(file,request);
    requests.push({...request,request:await trueCrimeProofFileRef(file)});
  }
  const preparation={schema:'goldflow_true_crime_asset_preparation_v1',identity_sha256,recipe:recipeRef,artifacts,acquired_sources,derivations,image_requests:requests};
  const file=path.join(outputDir,'asset-preparation.json');await write(file,preparation);
  return {outputDir,preparation:await trueCrimeProofFileRef(file),image_requests:requests,asset_count:artifacts.length};
}
