import { promises as fs } from 'node:fs';
import path from 'node:path';
import { falFileSha256 } from './fal-provider.mjs';
import { falPortableAssetId } from './fal-portable-bank.mjs';

const need=(value,message)=>{if(!value)throw new Error(message);};
const read=async file=>JSON.parse(await fs.readFile(file,'utf8'));

// A reviewed missing identity may fill a free slot, never displace or globally
// rescope approved inputs. The existing QA repair binds the rejected raster.
export async function reviewedFalCharacterAdditions({episodeDir,identity,promptRow,directive,refs,approval}) {
  if(!directive.character_reference_additions)return refs;
  const additions=directive.character_reference_additions;
  need(Array.isArray(additions)&&additions.length>0&&refs.length+additions.length<=4,
    'Reviewed character additions must fit the four-reference cap.');
  need(directive.actual_reference_review===true&&directive.reviewer?.trim()&&directive.reference_review_note?.trim().length>20,
    'Character attachment repair requires actual explicit reference review.');
  const planPath=path.join(episodeDir,'visual_reference_plan.json');
  const approvalPath=path.join(episodeDir,`visual_reference_approval_${identity.episode}.json`);
  need(directive.reference_plan_sha256===await falFileSha256(planPath)
    &&directive.reference_approval_sha256===await falFileSha256(approvalPath),
    'Reviewed character attachment sources changed.');
  for(const [key,file] of Object.entries({run_identity_sha256:'run_identity.json',source_script_sha256:'script_clean.md',
    beat_plan_sha256:'visual_beat_plan.json',panel_asset_plan_sha256:`panel_asset_plan_${identity.episode}.json`}))
    need(directive[key]===await falFileSha256(path.join(episodeDir,file)),`Reviewed character source changed: ${key}`);
  const plan=await read(planPath);
  const beats=(await read(path.join(episodeDir,'visual_beat_plan.json'))).beats;
  const allocation=await read(path.join(episodeDir,`panel_asset_plan_${identity.episode}.json`));
  const bindings=allocation.beat_bindings??[];
  const ownBinding=bindings.find(row=>row.beat_id===promptRow.visual_beat_id||row.visual_beat_id===promptRow.visual_beat_id);
  need(typeof ownBinding?.asset_id==='string'&&ownBinding.asset_id,'Reviewed character owner has no current artwork binding.');
  // Membership is read from explicit bindings; no narrative/keyword grouping.
  const covered=new Set([promptRow.visual_beat_id,...bindings.filter(row=>row.asset_id===ownBinding.asset_id)
    .map(row=>row.beat_id??row.visual_beat_id)]);
  const sourceText=(await fs.readFile(path.join(episodeDir,'script_clean.md'),'utf8'));
  const visible=promptRow.shot_manifest?.visible_characters??[];
  const forbidden=promptRow.shot_manifest?.forbidden_ref_ids??[];
  const ids=new Set();const result=[...refs];
  for(const addition of additions) {
    const target=plan.reference_targets?.find(row=>row.ref_id===addition.ref_id);
    need(target?.kind==='character_state'&&target.generation_mode==='standalone_ref'
      &&target.scene_ids?.includes(promptRow.scene_id)&&!forbidden.includes(addition.ref_id)
      &&!ids.has(addition.ref_id)&&visible.includes(addition.visible_character)
      &&addition.visible_character?.trim()&&target.prompt_anchor?.toLowerCase().includes(addition.visible_character.toLowerCase())
      &&addition.reason?.trim().length>20&&addition.source_quote?.trim().length>20
      &&sourceText.includes(addition.source_quote)
      &&beats.some(beat=>covered.has(beat.visual_beat_id)&&(beat.visual_beat_script_excerpt??'').includes(addition.source_quote)),
    `Character attachment is not an approved exact-scene visible identity with covered source evidence: ${addition.ref_id}`);
    ids.add(addition.ref_id);
    const localPath=target.conditioning_image_path??target.reference_image_path;
    const sha256=approval.reference_hash_by_ref_id?.[addition.ref_id];
    need(path.isAbsolute(localPath??'')&&sha256&&await falFileSha256(localPath)===sha256,
      `Added identity raster is not currently hash-approved: ${addition.ref_id}`);
    const imported=(await read(path.join(episodeDir,'fal','reference-plan.json'))).assignments
      ?.find(row=>row.ref_id===addition.ref_id&&row.reference_mode==='approved_local_asset');
    const asset_id=imported?.reference_asset_ids?.[0]??falPortableAssetId(identity.series_slug,target);
    need(!result.some(ref=>ref.asset_id===asset_id),'Reviewed character attachment repeats an existing reference.');
    result.push({asset_id,asset_class:target.kind,path:localPath,sha256});
  }
  return result;
}
