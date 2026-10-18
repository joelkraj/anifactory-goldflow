#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beginStageExecution, finishStageExecution } from "./lib/execution-provenance.mjs";
import { collectBaselineFiles, collectHistoricalVisualInventory, fileSha256, jsonBytes, readJson, validateBaselineStages } from "./lib/openart-visual-restart.mjs";
import { createFalRestartIdentity, FAL_VISUAL_FILES, validateFalContract } from "./lib/fal-visual-restart.mjs";

const repoRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const digest=value=>createHash("sha256").update(value).digest("hex");
function flags(argv){const out={};for(let i=0;i<argv.length;i+=2){if(!argv[i]?.startsWith("--")||!argv[i+1])throw new Error("Every Fal restart flag requires a value.");out[argv[i].slice(2)]=argv[i+1];}return out;}
function git(args){const r=spawnSync("git",args,{cwd:repoRoot,encoding:"utf8"});if(r.status)throw new Error(r.stderr);return r.stdout.trim();}
async function absent(p){try{await fs.lstat(p);throw new Error(`Restart target exists: ${p}`);}catch(e){if(e.code!=="ENOENT")throw e;}}
async function main(){
 const f=flags(process.argv.slice(2)); for(const k of ["baseline-episode-dir","week","fal-contract","approved-by","note"]) if(!f[k]?.trim()) throw new Error(`Required --${k} is missing.`);
 const forkAt=f["fork-at"]??null;
 if(forkAt!==null&&forkAt!=="visual_reference_plan") throw new Error("The only supported early Fal fork is visual_reference_plan.");
 if(git(["status","--porcelain=v1","--untracked-files=all"])) throw new Error("Fal visual restart requires clean committed adapter code.");
 const baselineDir=await fs.realpath(path.resolve(f["baseline-episode-dir"])); const baseline=await readJson(path.join(baselineDir,"run_identity.json"));
 const contract=await validateFalContract(await readJson(path.resolve(f["fal-contract"]))); const suffix=path.join("weekly_runs",baseline.week,"episodes",baseline.episode);
 if(!baselineDir.endsWith(path.sep+suffix)||f.week===baseline.week) throw new Error("Use a distinct safe Fal run slug.");
 const targetDir=path.join(baselineDir.slice(0,-suffix.length),"weekly_runs",f.week,"episodes",baseline.episode); const targetRun=path.dirname(path.dirname(targetDir)); await absent(targetRun);
 const statusRun=spawnSync(process.execPath,[path.join(repoRoot,"bin/goldflow.mjs"),"run","status","--episode-dir",baselineDir,"--format","json"],{cwd:repoRoot,encoding:"utf8",maxBuffer:64*1024*1024});
 if(statusRun.status) throw new Error(statusRun.stderr||statusRun.stdout); const status=JSON.parse(statusRun.stdout); validateBaselineStages(status);
 // A Fal attempt may branch from the approved OpenArt visual restart. Its
 // narration reports still bind the original episode-local audio, so mirror
 // nonvisual files from that immutable source while taking visual plans only
 // from the current OpenArt attempt.
 const nonvisualBaselineDir=baseline.visual_restart?.baseline_episode_dir
   ? await fs.realpath(baseline.visual_restart.baseline_episode_dir) : baselineDir;
 const files=await collectBaselineFiles(nonvisualBaselineDir,baseline);
 if(!forkAt){
  for(const name of FAL_VISUAL_FILES){const source=path.join(baselineDir,name);files.push({relative_path:name,source_path:source,sha256:await fileSha256(source),kind:"approved_visual_plan_artifact"});}
  const catalogSource=path.join(baselineDir,"openart","catalog.json"); files.push({relative_path:"fal/catalog.json",source_path:catalogSource,sha256:await fileSha256(catalogSource),kind:"provider_neutral_canonical_catalog"});
 }
 const baselineIdentitySha256=await fileSha256(path.join(baselineDir,"run_identity.json")); const snapshot=jsonBytes(status); const history=jsonBytes(await collectHistoricalVisualInventory(baselineDir,baseline.episode)); const createdAt=new Date().toISOString();
 const receipt={schema:"goldflow_fal_visual_restart_v1",restart_id:randomUUID(),created_at:createdAt,target_episode_dir:targetDir,target_week:f.week,baseline_episode_dir:baselineDir,baseline_identity_sha256:baselineIdentitySha256,baseline_status_sha256:digest(snapshot),historical_visual_inventory_sha256:digest(history),...(forkAt?{fork_at:forkAt}:{}),files,authorization:{approved_by:f["approved-by"],note:f.note},provider_requests:0,cost_usd:0,git:{commit:git(["rev-parse","HEAD"]),branch:git(["rev-parse","--abbrev-ref","HEAD"]),dirty:false}};
 const receiptBytes=jsonBytes(receipt); const identity=createFalRestartIdentity({baseline,targetDir,week:f.week,contract,git:receipt.git,receiptSha256:digest(receiptBytes),baselineIdentitySha256,createdAt,forkAt});
 await fs.mkdir(targetRun); await fs.mkdir(targetDir,{recursive:true}); const execution=await beginStageExecution({stage:"run_identity",command:"run restart-visuals-fal",flags:{"episode-dir":targetDir},args:process.argv.slice(2)});
 try{for(const row of files){const dest=path.join(targetDir,row.relative_path);await fs.mkdir(path.dirname(dest),{recursive:true});await fs.copyFile(row.source_path,dest,1);if(await fileSha256(dest)!==row.sha256)throw new Error(`Carryforward changed: ${row.relative_path}`);}await fs.writeFile(path.join(targetDir,"baseline_status_snapshot.json"),snapshot,{flag:"wx"});await fs.writeFile(path.join(targetDir,"historical_visual_inventory.json"),history,{flag:"wx"});await fs.writeFile(path.join(targetDir,"visual_restart_receipt.json"),receiptBytes,{flag:"wx"});await fs.writeFile(path.join(targetDir,"run_identity.json"),jsonBytes(identity),{flag:"wx"});await finishStageExecution(execution,{exitCode:0});console.log(JSON.stringify({status:"created",episode_dir:targetDir,next_command:`node bin/goldflow.mjs run status --episode-dir ${targetDir} --format markdown`},null,2));}catch(e){await finishStageExecution(execution,{exitCode:1,error:e.message});throw e;}
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
