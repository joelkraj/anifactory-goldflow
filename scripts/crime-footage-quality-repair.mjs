#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {beginCrimeFootageHdQualityRepair,beginCrimeFootageHdWindow,finishCrimeFootageHdWindow,failCrimeFootageHdWindow,selectCrimeFootageHdRepair} from './lib/crime-footage-quality-repair.mjs';
const need=(ok,msg)=>{if(!ok)throw new Error(msg);};
const read=async p=>JSON.parse(await fs.readFile(p,'utf8'));
export async function executeCrimeFootageQualityRepairCli(argv){
  const [action,...rest]=argv,f={};for(let i=0;i<rest.length;i++){need(rest[i].startsWith('--'),'Named flags required');const k=rest[i].slice(2);need(!Object.hasOwn(f,k)&&rest[i+1]&&!rest[i+1].startsWith('--'),'One explicit value per flag required');f[k]=rest[++i];}
  const rules={begin:['recipe'],'begin-window':['repair-dir','window-id'],'finish-window':['repair-dir','window-id','result'],'fail-window':['repair-dir','window-id','note'],select:['repair-dir','failed-window-selections']};need(Object.hasOwn(rules,action),'Use begin, begin-window, finish-window, fail-window or select; no network/download/retry action exists');
  need(Object.keys(f).every(k=>['episode-dir','attempt-token',...rules[action]].includes(k)),'Unsupported flag');need(path.isAbsolute(f['episode-dir']??'')&&f['attempt-token'],'Absolute proof path and exact source-assets token required');
  const args={proofDir:f['episode-dir'],attemptToken:f['attempt-token'],repairDir:f['repair-dir'],windowId:f['window-id']};
  if(action==='begin'){need(path.isAbsolute(f.recipe??''),'Absolute recipe path required');return beginCrimeFootageHdQualityRepair({...args,recipePath:f.recipe});}
  need(path.isAbsolute(args.repairDir??''),'Absolute isolated repair directory required');
  if(action==='begin-window')return beginCrimeFootageHdWindow(args);
  if(action==='finish-window'){need(path.isAbsolute(f.result??''),'Absolute result path required');return finishCrimeFootageHdWindow({...args,result:await read(f.result)});}
  if(action==='fail-window')return failCrimeFootageHdWindow({...args,note:f.note});
  return selectCrimeFootageHdRepair({...args,failedWindowSelections:f['failed-window-selections']?await read(f['failed-window-selections']):[]});
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){try{console.log(JSON.stringify(await executeCrimeFootageQualityRepairCli(process.argv.slice(2)),null,2));}catch(e){console.error(e.message);process.exitCode=1;}}
