#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareOriginalPanelExperiment } from './lib/panel-original-import.mjs';
import { createPanelCompositionTemplate, writePanelComposition } from './lib/panel-composition-authoring.mjs';
import { loadPanelExperimentTimeline } from './lib/panel-experiment-contract.mjs';
import { renderPanelExperiment } from './lib/panel-experiment-renderer.mjs';
import { writePanelExperimentReview } from './lib/panel-experiment-review.mjs';
import { createRecapSourcePackage, loadRecapSourcePackage } from './lib/recap-source-package.mjs';
import { prepareRecapAdaptation, checkRecapAdaptation, importRecapAdaptation, recordRecapAdaptationReview } from './lib/recap-adaptation.mjs';

const commands = {
  'prepare-original': { required:['episode-dir','config','start-sec','end-sec','output-dir'] },
  'composition-template': { required:['timeline','output-dir'] },
  compile: { required:['recipe','output-dir'] },
  validate: { required:['timeline'] },
  review: { required:['timeline','output-dir'], optional:['start-sec','end-sec'] },
  render: { required:['timeline','output-dir','cache-dir'], optional:['allow-dirty-worktree','dirty-reason'] },
  'import-source': { required:['config','output-dir'] },
  'check-source': { required:['source-package'] },
  'prepare-adaptation': { required:['source-package','output-dir'], optional:['target-wpm'] },
  'check-adaptation': { required:['source-package','draft'] },
  'import-adaptation': { required:['source-package','draft','output-dir'] },
  'review-adaptation': { required:['adaptation-dir','reviewer','note','attestation'] },
};

export function parsePanelWorkbenchArgs(args) {
  const [action,...parts] = args;
  if (!commands[action]) throw new Error(`Usage: node scripts/panel-workbench.mjs <${Object.keys(commands).join('|')}> --flag value. See docs/workflows/panel_workbench_v1.md`);
  const contract = commands[action], allowed = new Set([...contract.required,...contract.optional ?? []]), flags = {};
  for (let i=0;i<parts.length;i+=2) {
    const flag = parts[i]?.startsWith('--') ? parts[i].slice(2) : '';
    if (!allowed.has(flag) || flags[flag] !== undefined || !parts[i+1] || parts[i+1].startsWith('--')) throw new Error(`Invalid, duplicate or missing-value flag: ${parts[i]}`);
    flags[flag]=parts[i+1];
  }
  for (const flag of contract.required) if (!flags[flag]) throw new Error(`--${flag} is required for ${action}`);
  for (const flag of ['start-sec','end-sec','target-wpm']) if (flags[flag] !== undefined) { flags[flag]=Number(flags[flag]); if (!Number.isFinite(flags[flag])) throw new Error(`--${flag} must be finite`); }
  if (flags['allow-dirty-worktree'] !== undefined && !['true','false'].includes(flags['allow-dirty-worktree'])) throw new Error('--allow-dirty-worktree must be true or false');
  if (flags['allow-dirty-worktree'] === 'true' && !flags['dirty-reason']?.trim()) throw new Error('--dirty-reason is required for a dirty experiment');
  const file = key => flags[key] ? path.resolve(flags[key]) : undefined;
  return { action, episodeDir:file('episode-dir'), configPath:file('config'), timelinePath:file('timeline'), recipePath:file('recipe'), packagePath:file('source-package'), draftPath:file('draft'), adaptationDir:file('adaptation-dir'), outputDir:file('output-dir'), cacheDir:file('cache-dir'), startSec:flags['start-sec'], endSec:flags['end-sec'], targetWpm:flags['target-wpm'], reviewer:flags.reviewer, note:flags.note, attestation:flags.attestation, allowDirtyWorktree:flags['allow-dirty-worktree']==='true', dirtyReason:flags['dirty-reason'] ?? '' };
}

export async function runPanelWorkbenchCli(args, { writeResult = true } = {}) {
  const options = parsePanelWorkbenchArgs(args);
  let result;
  switch (options.action) {
    case 'prepare-original': result=await prepareOriginalPanelExperiment(options);break;
    case 'composition-template': result=await createPanelCompositionTemplate(options);break;
    case 'compile': result=await writePanelComposition(options);break;
    case 'validate': {
      const loaded=await loadPanelExperimentTimeline(options.timelinePath);
      result={status:'valid_private_experiment',id:loaded.timeline.id,duration_sec:loaded.timeline.duration_sec,scene_count:loaded.timeline.scenes.length,asset_count:loaded.assets.length,source_mode:loaded.identity.source_mode,production_eligible:false};break;
    }
    case 'review': result=await writePanelExperimentReview(options);break;
    case 'render': result=await renderPanelExperiment({...options,onProgress:row=>{if(row.phase!=='chunk_frames')process.stderr.write(`${JSON.stringify(row)}\n`);}});break;
    case 'import-source': {
      const loaded=await createRecapSourcePackage(options);
      const {package:sourcePackage,...paths}=loaded;
      result={status:'indexed_awaiting_adaptation',id:sourcePackage.id,source_kind:sourcePackage.source_kind,...paths};break;
    }
    case 'check-source': {
      const loaded=await loadRecapSourcePackage(options.packagePath,{verifyOriginals:true});
      result={status:'current_source_package',id:loaded.package.id,source_kind:loaded.package.source_kind,file_count:loaded.package.files.length,production_eligible:false};break;
    }
    case 'prepare-adaptation': result=await prepareRecapAdaptation(options);break;
    case 'check-adaptation': result=await checkRecapAdaptation(options);break;
    case 'import-adaptation': result=await importRecapAdaptation(options);break;
    case 'review-adaptation': result=await recordRecapAdaptationReview(options);break;
  }
  if(writeResult)process.stdout.write(`${JSON.stringify(result,null,2)}\n`);
  return result;
}

if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url))runPanelWorkbenchCli(process.argv.slice(2)).catch(error=>{process.stderr.write(`${error.message}\n`);process.exitCode=1;});
