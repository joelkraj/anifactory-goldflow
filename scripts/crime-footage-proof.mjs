#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {preflightCrimeFootageProof,crimeFootageProofStatus,beginCrimeFootageProofStage,finishCrimeFootageProofStage,failCrimeFootageProofStage} from './lib/crime-footage-proof-workflow.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const need=(ok,msg)=>{if(!ok)throw new Error(msg);};
const json=async f=>JSON.parse(await fs.readFile(f,'utf8'));
export async function executeCrimeFootageProofCli(argv){
  const [action,...args]=argv,flags={};
  for(let i=0;i<args.length;i++){need(args[i].startsWith('--'),'Use explicit named flags');const k=args[i].slice(2);need(!Object.hasOwn(flags,k),'Duplicate flag');need(args[i+1]&&!args[i+1].startsWith('--'),`Value required for --${k}`);flags[k]=args[++i];}
  const selected={preflight:['identity','repo-dir','allow-dirty-worktree','dirty-reason'],status:[],begin:['stage','inputs'],finish:['stage','attempt-token','result'],fail:['stage','attempt-token','note']};
  need(Object.hasOwn(selected,action),'Use preflight, status, begin, finish or fail; no publishing, approval or retry action exists');
  need(Object.keys(flags).every(k=>['episode-dir','format',...selected[action]].includes(k)),'Unknown or bypass flag');
  need(path.isAbsolute(flags['episode-dir']??''),'--episode-dir requires an absolute path');const proofDir=flags['episode-dir'];let result;
  if(action==='preflight'){need(path.isAbsolute(flags.identity??''),'--identity requires an absolute path');need(flags['allow-dirty-worktree']===undefined||['true','false'].includes(flags['allow-dirty-worktree']),'Invalid dirty scope flag');result=await preflightCrimeFootageProof({proofDir,repoDir:flags['repo-dir']??root,identity:await json(flags.identity),allowDirtyWorktree:flags['allow-dirty-worktree']==='true',dirtyReason:flags['dirty-reason']??''});}
  else if(action==='status')result=await crimeFootageProofStatus({proofDir});
  else if(action==='begin'){need(path.isAbsolute(flags.inputs??''),'--inputs requires an absolute JSON array path');result=await beginCrimeFootageProofStage({proofDir,stage:flags.stage,inputs:await json(flags.inputs)});}
  else if(action==='finish'){need(path.isAbsolute(flags.result??''),'--result requires an absolute path');result=await finishCrimeFootageProofStage({proofDir,stage:flags.stage,attemptToken:flags['attempt-token'],result:await json(flags.result)});}
  else result=await failCrimeFootageProofStage({proofDir,stage:flags.stage,attemptToken:flags['attempt-token'],note:flags.note});
  if(flags.format==='markdown'&&result.stages)return `CrimeDungeon footage proof: ${result.state}. Private; review pending.\n\n${result.stages.map(s=>`${s.stage}: ${s.state}`).join('\n')}\n\nNext: ${result.next_command_shape??'Whole-program review; no release action.'}\n`;
  return result;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{const r=await executeCrimeFootageProofCli(process.argv.slice(2));console.log(typeof r==='string'?r:JSON.stringify(r,null,2));}catch(e){console.error(e.message);process.exitCode=1;}
}
