import { promises as fs } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { authorPropRepairs, acceptPropRepairs } from './lib/visual-prop-editorial-repair.mjs';
const flags={};const args=process.argv.slice(2);for(let i=0;i<args.length;i+=2){const k=args[i]?.slice(2);if(!['episode-dir','repair-spec'].includes(k)||flags[k]||!args[i+1])throw new Error('Explicit episode and repair spec only');flags[k]=args[i+1]}
const repoRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');const episodeDir=path.resolve(flags['episode-dir']);const specPath=path.resolve(flags['repair-spec']);const check=spawnSync(process.execPath,[path.join(repoRoot,'scripts/run-status.mjs'),'--episode-dir',episodeDir],{encoding:'utf8',maxBuffer:16000000});if(check.status)throw new Error(check.stderr);const spec=JSON.parse(await fs.readFile(specPath));const action=spec.schema==='goldflow_visual_prop_editorial_acceptance_v1'?acceptPropRepairs:authorPropRepairs;console.log(JSON.stringify(await action({episodeDir,specPath,spec,status:JSON.parse(check.stdout),repoRoot}),null,2));
