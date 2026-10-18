import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { sha256File } from './file-hash.mjs';
import { assertPanelPromptAllocation, materializePanelAssetAliases } from './panel-production-assets.mjs';

const need = (value, message) => { if (!value) throw new Error(`Fal panel artwork: ${message}`); };
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const authoredHash = row => hash({ image_prompt: row.image_prompt ?? null, modelslab_image_prompt: row.modelslab_image_prompt ?? null, codex_image_prompt: row.codex_image_prompt ?? null, shot_manifest: row.shot_manifest ?? null, reference_requirements: row.reference_requirements ?? [] });

/** Validate the complete allocation before selecting actual paid artwork orders. */
export async function falArtworkOrders({ episodeDir, prompts, imageIds = null }) {
  await assertPanelPromptAllocation({ episodeDir, prompts });
  const owners = prompts.filter(row => row.image_generation_required !== false && row.provider_submission_required !== false);
  if (imageIds) {
    need(new Set(imageIds).size === imageIds.length, 'duplicate requested artwork IDs');
    const known = new Set(owners.map(row => row.image_id));
    need(imageIds.every(id => known.has(id)), 'requested IDs must name unique artwork owners, not reused panels or unknown IDs');
  }
  return imageIds ? owners.filter(row => imageIds.includes(row.image_id)) : owners;
}

/** Bind accepted Fal owners; an explicit repair scope refreshes only its dependent aliases. */
export async function completeFalPanelArtwork({ episodeDir, prompts, results, cuts, ownerImageIds = null }) {
  const allocation = await assertPanelPromptAllocation({ episodeDir, prompts });
  if (!allocation) return { results, cuts };
  const owners = await falArtworkOrders({ episodeDir, prompts, imageIds: ownerImageIds });
  const byResult = new Map(results.map(row => [row.image_id, row]));
  const byCut = new Map(cuts.map(row => [row.image_id, row]));
  const expectedCount = ownerImageIds ? prompts.length : owners.length;
  need(byResult.size === results.length && results.length === expectedCount && byCut.size === cuts.length && cuts.length === expectedCount, 'every unique owner needs exactly one accepted result and ledger row');
  // Verify every owner before writing any derived sidecar or alias.
  for (const prompt of owners) {
    const result = byResult.get(prompt.image_id), cut = byCut.get(prompt.image_id);
    need(result?.status === 'generated' && result.generated?.provider === 'fal_ai' && result.image_path === cut?.image_path, `accepted Fal owner missing: ${prompt.image_id}`);
    const expected = result.generated.output_sha256;
    need(/^[a-f0-9]{64}$/.test(expected ?? '') && cut.image_sha256 === expected && await sha256File(result.image_path) === expected, `owner bytes changed: ${prompt.image_id}`);
    need(result.generated.result_receipt_path && await sha256File(result.generated.result_receipt_path) === result.generated.result_receipt_sha256, `owner receipt changed: ${prompt.image_id}`);
    const receipt = JSON.parse(await fs.readFile(result.generated.result_receipt_path, 'utf8'));
    need(receipt.output_path === result.image_path && receipt.output_sha256 === expected && receipt.request_id === result.generated.request_id, `owner receipt binding differs: ${prompt.image_id}`);
  }
  for (const prompt of owners) {
    const result = byResult.get(prompt.image_id), cut = byCut.get(prompt.image_id);
    const metadata = { image_id: prompt.image_id, image_provider: 'fal_ai', panel_asset_id: prompt.panel_asset_id, panel_asset_plan_sha256: allocation.planSha256, provider_submission_required: true, generated: result.generated };
    const file = `${result.image_path}.metadata.json`;
    const prior = await fs.readFile(file, 'utf8').then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (prior) need(prior.image_id === metadata.image_id && prior.panel_asset_id === metadata.panel_asset_id && prior.panel_asset_plan_sha256 === metadata.panel_asset_plan_sha256 && prior.generated?.output_sha256 === metadata.generated.output_sha256 && prior.generated?.result_receipt_sha256 === metadata.generated.result_receipt_sha256, `existing owner provenance differs: ${prompt.image_id}`);
    else await fs.writeFile(file, `${JSON.stringify(metadata, null, 2)}\n`, { flag: 'wx' });
    result.image_sha256 = cut.image_sha256;
    Object.assign(cut, { image_provider: 'fal_ai', panel_asset_id: prompt.panel_asset_id, panel_asset_plan_sha256: allocation.planSha256, authored_prompt_hash: authoredHash(prompt), image_qa_status: 'pending' });
  }
  const expanded = await materializePanelAssetAliases({ episodeDir, prompts, results, ownerImageIds });
  need(expanded.length === prompts.length, 'all authored panel bindings must materialize');
  for (const result of expanded.filter(row => row.status === 'editorial_reuse' && (!ownerImageIds || ownerImageIds.includes(row.generated?.reuse_source_image_id)))) {
    const prompt = prompts.find(row => row.image_id === result.image_id);
    const owner = byCut.get(prompt.reuse_source_image_id);
    need(owner, `alias owner ledger missing: ${result.image_id}`);
    byCut.set(result.image_id, { ...owner, image_id: result.image_id, scene_id: prompt.scene_id, visual_beat_id: prompt.visual_beat_id, start_sec: prompt.start_sec, duration_sec: prompt.duration_sec, image_path: result.image_path, image_sha256: result.image_sha256, provider: 'editorial_reuse', image_provider: 'editorial_reuse', generation_status: 'editorial_reuse', editorial_reuse_approved: true, reuse_source_image_id: prompt.reuse_source_image_id, panel_asset_id: prompt.panel_asset_id, panel_asset_plan_sha256: allocation.planSha256, authored_prompt_hash: authoredHash(prompt), submitted_prompt_hash: result.prompt_hash, image_qa_status: 'pending' });
  }
  return { results: expanded, cuts: prompts.map(row => byCut.get(row.image_id)) };
}
