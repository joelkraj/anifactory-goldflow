import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { loadTrueCrimeProofIdentity } from './true-crime-proof-workflow.mjs';

const exec = promisify(execFile);
const helperPath = fileURLToPath(new URL('../helpers/vision-foreground-mask.swift', import.meta.url));
const HELPER_SHA = '93091d38c441f6f6efe3d4fdd201efd15a9dbb999f3a6da9b21e751607e74486';
const SOURCE_SHA = 'bce51d63d4572c0a19546e7ada2531401f88487385af5ffd8e31da4e82814582';
const FAILED_SHA = '623f1294d3ec545c7a8da3f0bef7b98349c3b3c11ea96abc7af38f0ef0ba2424';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const need = (ok, message) => { if (!ok) throw new Error(`True-crime alpha repair: ${message}`); };
const ref = async (file) => ({ path: file, sha256: hash(await fs.readFile(file)) });
const writeJson = (file, value) => fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
async function checked(ref) {
  need(path.isAbsolute(ref?.path ?? '') && /^[a-f0-9]{64}$/u.test(ref?.sha256 ?? ''), 'exact absolute file binding required');
  const bytes = await fs.readFile(ref.path); need(hash(bytes) === ref.sha256, 'bound input changed'); return bytes;
}

/** Pure byte operation, shared with synthetic tests. No segmentation or file writes. */
export function attachExactRgbAlpha(rgb, mask, width, height) {
  need(Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 && rgb.length === width * height * 3 && mask.length === width * height, 'RGB/mask dimensions do not match');
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < mask.length; i++) {
    rgba[i * 4] = rgb[i * 3]; rgba[i * 4 + 1] = rgb[i * 3 + 1]; rgba[i * 4 + 2] = rgb[i * 3 + 2]; rgba[i * 4 + 3] = mask[i];
  }
  return rgba;
}

/** Exact one-asset repair. Call only after the separately retained user authorization. */
export async function repairTrueCrimeProofAlpha({ recipePath } = {}) {
  need(path.isAbsolute(recipePath ?? ''), 'absolute recipe path required');
  const recipeRef = await ref(recipePath), recipe = JSON.parse(await fs.readFile(recipePath, 'utf8'));
  need(recipe.schema === 'goldflow_true_crime_alpha_repair_recipe_v1' && recipe.asset_id === 'chandler_cutout' && recipe.production_eligible === false && recipe.creative_generation === false, 'single private Chandler alpha repair required');
  need(recipe.authorization?.authorized === true && recipe.authorization.operator === 'Joel' && typeof recipe.authorization.user_quote === 'string' && recipe.authorization.user_quote.trim() && typeof recipe.authorization.note === 'string' && recipe.authorization.note.trim() && Number.isFinite(Date.parse(recipe.authorization.received_at)), 'explicit received user authorization and actual user quote required before local image editing');
  need(recipe.input?.sha256 === SOURCE_SHA && recipe.rejected_output?.sha256 === FAILED_SHA, 'repair must use the exact original agency photograph and preserve the failed generated output');
  need(path.isAbsolute(recipe.output_dir ?? ''), 'absolute output directory required');
  need(path.isAbsolute(recipe.proof_dir ?? ''), 'existing proof directory required');
  const { identity_sha256 } = await loadTrueCrimeProofIdentity({ proofDir: recipe.proof_dir });
  const startPath = path.join(recipe.proof_dir, 'attempts/source_assets/start.json');
  const lockPath = path.join(recipe.proof_dir, 'operation.lock');
  const start = JSON.parse(await fs.readFile(startPath, 'utf8')), lock = JSON.parse(await fs.readFile(lockPath, 'utf8'));
  need(start.stage === 'source_assets' && start.identity_sha256 === identity_sha256 && lock.stage === 'source_assets' && lock.attempt_token_sha256 === start.attempt_token_sha256, 'matching open source-assets context required');
  const sourceOutput = path.join(recipe.proof_dir, 'attempts/source_assets/output');
  const externalPath = path.join(recipe.proof_dir, 'attempts/source_assets/external-stage-context.json');
  const external = JSON.parse(await fs.readFile(externalPath, 'utf8'));
  need(external.stage === 'source_assets' && external.identity_sha256 === identity_sha256 && typeof external.attempt_token === 'string' && hash(external.attempt_token) === start.attempt_token_sha256 && external.output_dir === sourceOutput, 'exact retained external-stage token/context required');
  need(path.dirname(recipePath) === sourceOutput && recipe.output_dir === path.join(sourceOutput, 'chandler-alpha-repair-v1'), 'repair request and one new output directory must belong to the current source-assets attempt');
  need(recipe.input.path === path.join(sourceOutput, 'chandler-agency-photo.jpg') && recipe.rejected_output.path === path.join(sourceOutput, 'chandler_cutout.tool-output.png'), 'original and rejected images must be the exact retained source-assets files');
  const preparation = JSON.parse(await fs.readFile(path.join(sourceOutput, 'asset-preparation.json'), 'utf8'));
  const original = preparation.artifacts?.find((row) => row.id === 'portrait_source');
  need(original?.path === recipe.input.path && original?.sha256 === recipe.input.sha256 && preparation.identity_sha256 === identity_sha256, 'repair input must be the original portrait acquired by this source-assets attempt');
  const source = await checked(recipe.input); await checked(recipe.rejected_output);
  need((await ref(helperPath)).sha256 === HELPER_SHA, 'retained Vision helper changed');
  const sourceMeta = await sharp(source).metadata();
  need(sourceMeta.format === 'jpeg' && sourceMeta.width === 3072 && sourceMeta.height === 1931 && !sourceMeta.hasAlpha && (!sourceMeta.orientation || sourceMeta.orientation === 1), 'unexpected original image format/orientation');
  const { data: rgb, info } = await sharp(source).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  need(info.channels === 3, 'decoded source must be RGB');
  const originalRgbHash = hash(rgb);
  // A repair owns a new directory. Existing failed or completed evidence is never overwritten.
  await fs.mkdir(recipe.output_dir, { recursive: false });
  const eventPath = path.join(recipe.output_dir, 'events.jsonl');
  const event = (row) => fs.appendFile(eventPath, JSON.stringify({ recorded_at: new Date().toISOString(), ...row }) + '\n');
  await writeJson(path.join(recipe.output_dir, 'recipe.json'), { ...recipe, original_recipe: recipeRef, source_assets_attempt: await ref(startPath), external_context_binding: await ref(externalPath), identity_sha256 });
  await event({ status: 'started', asset_id: recipe.asset_id, input: recipe.input, rejected_output: recipe.rejected_output, method: 'local_vision_mask_only_then_exact_rgb_alpha_attachment', creative_generation: false });
  try {
    const os = await exec('/usr/bin/sw_vers', ['-productVersion']);
    const build = await exec('/usr/bin/sw_vers', ['-buildVersion']);
    const swift = await exec('/usr/bin/xcrun', ['swift', '--version']);
    const maskPath = path.join(recipe.output_dir, 'chandler-foreground-mask.png');
    const maskRun = await exec('/usr/bin/xcrun', ['swift', helperPath, recipe.input.path, maskPath], { timeout: 120000, maxBuffer: 1024 * 1024, env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C' } });
    const maskReport = JSON.parse(maskRun.stdout);
    need(maskReport.status === 'passed' && maskReport.instance_count === 1, 'exactly one foreground subject required; inspect retained mask instead of retrying');
    const { data: mask, info: maskInfo } = await sharp(maskPath).removeAlpha().greyscale().raw().toBuffer({ resolveWithObject: true });
    need(maskInfo.width === info.width && maskInfo.height === info.height && maskInfo.channels === 1, 'Vision mask dimensions differ from source');
    const pixels = mask.length; let transparent = 0, foreground = 0, partial = 0;
    for (const value of mask) { if (value === 0) transparent++; else { foreground++; if (value !== 255) partial++; } }
    need(transparent / pixels > .05 && foreground / pixels > .05, 'mask lacks substantial foreground or actual transparency');
    const rgba = attachExactRgbAlpha(rgb, mask, info.width, info.height);
    const outputBytes = await sharp(rgba, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
    const outputRgb = await sharp(outputBytes).removeAlpha().raw().toBuffer();
    need(hash(outputRgb) === originalRgbHash, 'PNG changed decoded original RGB pixels');
    const outputPath = path.join(recipe.output_dir, 'chandler-cutout.png');
    await fs.writeFile(outputPath, outputBytes, { flag: 'wx' });
    await checked(recipe.input); await checked(recipe.rejected_output);
    need((await ref(helperPath)).sha256 === HELPER_SHA, 'Vision helper changed during repair');
    const output = await ref(outputPath);
    const receipt = { schema: 'goldflow_true_crime_alpha_repair_receipt_v1', status: 'technical_pass_awaiting_visual_review', asset_id: recipe.asset_id,
      production_eligible: false, creative_generation: false, provider_calls: 0, cost_usd: 0, authorization: recipe.authorization, recipe: recipeRef, identity_sha256, source_assets_attempt: await ref(startPath), external_context_binding: await ref(externalPath),
      input: recipe.input, rejected_output_preserved: recipe.rejected_output, output, mask: await ref(maskPath), mask_report: maskReport,
      method: 'local_vision_mask_only_then_exact_rgb_alpha_attachment', adapter: await ref(fileURLToPath(import.meta.url)), helper: await ref(helperPath),
      model: { framework: 'Apple Vision', request: 'VNGenerateForegroundInstanceMaskRequest', version: 'OS-managed model; independent model version not exposed by the existing helper', macos_version: os.stdout.trim(), macos_build: build.stdout.trim(), swift: swift.stdout.trim() },
      pixel_preservation: { width: info.width, height: info.height, source_decoded_rgb_sha256: originalRgbHash, output_decoded_rgb_sha256: hash(outputRgb), exact_rgb_equal: true, resize: false, crop: false, color_adjustment: false, feather_or_blur_added: false },
      alpha: { transparent_pixels: transparent, foreground_pixels: foreground, partial_pixels: partial, transparent_ratio: transparent / pixels },
      exact_visual_approval_recorded: false };
    const receiptPath = path.join(recipe.output_dir, 'alpha-repair-receipt.json'); await writeJson(receiptPath, receipt);
    await event({ status: 'technical_pass_awaiting_visual_review', output, receipt: await ref(receiptPath) });
    return { output, receipt: await ref(receiptPath), mask: await ref(maskPath), asset_id: recipe.asset_id, review_required: true };
  } catch (error) { await event({ status: 'needs_triage', error: error.message, automatic_retry_allowed: false }); throw error; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await repairTrueCrimeProofAlpha({ recipePath: process.argv[2] });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
