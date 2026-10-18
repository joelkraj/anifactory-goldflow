import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import sharp from 'sharp';

export const REFERENCE_BOARD_SCHEMA = 'goldflow_reference_board_v1';
export const REFERENCE_BOARD_COMPOSITOR_VERSION = '1.1.0';
export const REFERENCE_BOARD_WIDTH = 1920;
export const REFERENCE_BOARD_HEIGHT = 1080;
export const REFERENCE_BOARD_GUTTER = 12;
export const REFERENCE_BOARD_BACKGROUND = { r: 96, g: 96, b: 96, alpha: 1 };

export const REFERENCE_BOARD_PROMPT_GUIDANCE = `The input is a reference board, not the requested composition.
Each human panel supplies only its own subject's identity and named wardrobe state. Do not transfer one person's face, hair, complexion, age, build, or outfit to another person. Only story-confirmed twins, clones, or the same person in another state may share a face. Follow the current shot's wardrobe state when a base identity panel shows older clothing.
Create one coherent cinematic manhwa frame. Do not reproduce the board, borders, gutters, reference-sheet layout, or multiple copies of a character. Do not add labels, captions, watermarks, or unintended text.`;
export const LEGACY_REFERENCE_BOARD_PROMPT_GUIDANCE = `The input is a reference board, not the requested composition.
Use each panel only for the identity or visual function described by its recorded position. Preserve the primary character's identity, face, hair, age, body type, and wardrobe; preserve secondary-character identities separately; preserve the environment's architecture, materials, lighting vocabulary, and spatial identity; and preserve any crucial prop's defining shape and details.
Create one coherent cinematic manhwa frame. Do not reproduce the board, borders, gutters, reference-sheet layout, or multiple copies of a character. Do not add labels, captions, watermarks, or unintended text.`;

const digest = (value) => createHash('sha256').update(value).digest('hex');
const safe = (value) => String(value).replace(/[^A-Za-z0-9._-]+/g, '_');

function classify(ref) {
  if (ref.asset_class === 'character' || ref.asset_class === 'character_state' || ref.asset_class === 'wardrobe') return 'character';
  if (ref.asset_class === 'location') return 'environment';
  if (ref.asset_class === 'style') return 'style_reference';
  return 'prop';
}

function box(x, y, width, height, role, ref) {
  return { x, y, width, height, role, ref };
}

export function referenceBoardLayout(references) {
  if (!Array.isArray(references) || references.length < 1 || references.length > 4) {
    throw new Error('Deterministic reference boards require one through four approved source references.');
  }
  const g = REFERENCE_BOARD_GUTTER;
  const w = REFERENCE_BOARD_WIDTH;
  const h = REFERENCE_BOARD_HEIGHT;
  const characters = references.filter((ref) => classify(ref) === 'character');
  const environment = references.find((ref) => classify(ref) === 'environment');
  const prop = references.find((ref) => classify(ref) === 'prop');
  const primary = characters[0] ?? references[0];
  const secondary = characters.find((ref) => ref !== primary);
  const used = new Set();
  const take = (preferred) => {
    const ref = preferred && !used.has(preferred) ? preferred : references.find((row) => !used.has(row));
    used.add(ref); return ref;
  };

  if (references.length === 1) {
    return { layout_id: 'single_reference_full_canvas', panels: [box(0, 0, w, h, classify(references[0]), references[0])] };
  }
  if (references.length === 2) {
    const left = take(primary); const right = take(secondary ?? environment ?? prop);
    const lw = Math.floor((w - g) / 2);
    return { layout_id: 'primary_left_support_right', panels: [box(0, 0, lw, h, classify(left), left), box(lw + g, 0, w - lw - g, h, classify(right), right)] };
  }
  if (references.length === 3 && characters.length >= 2) {
    const left = take(primary); const center = take(secondary); const right = take(environment ?? prop);
    const usable = w - (2 * g); const lw = Math.floor(usable * 0.35); const cw = Math.floor(usable * 0.35);
    return { layout_id: 'two_character_primary_left_secondary_center_environment_right', panels: [box(0, 0, lw, h, 'primary_character', left), box(lw + g, 0, cw, h, 'secondary_character', center), box(lw + g + cw + g, 0, w - lw - cw - (2 * g), h, classify(right), right)] };
  }
  if (references.length === 3 && prop && environment) {
    const left = take(primary); const upper = take(prop); const lower = take(environment);
    const lw = Math.floor((w - g) * 0.45); const rh = Math.floor((h - g) * 0.55);
    return { layout_id: 'prop_critical_primary_left_prop_upper_right_environment_lower_right', panels: [box(0, 0, lw, h, classify(left), left), box(lw + g, 0, w - lw - g, rh, 'crucial_prop', upper), box(lw + g, rh + g, w - lw - g, h - rh - g, 'environment', lower)] };
  }
  if (references.length === 3) {
    const left = take(primary); const upper = take(environment); const lower = take();
    const lw = Math.floor((w - g) * 0.5); const rh = Math.floor((h - g) * 0.6);
    return { layout_id: 'primary_left_environment_upper_right_support_lower_right', panels: [box(0, 0, lw, h, classify(left), left), box(lw + g, 0, w - lw - g, rh, classify(upper), upper), box(lw + g, rh + g, w - lw - g, h - rh - g, classify(lower), lower)] };
  }

  const left = take(primary); const center = take(secondary); const upper = take(environment); const lower = take(prop);
  const usable = w - (2 * g); const lw = Math.floor(usable * 0.35); const cw = Math.floor(usable * 0.30); const rh = Math.floor((h - g) * 0.56);
  return { layout_id: 'four_reference_primary_left_secondary_center_environment_upper_right_prop_lower_right', panels: [box(0, 0, lw, h, 'primary_character', left), box(lw + g, 0, cw, h, 'secondary_character_or_subject', center), box(lw + g + cw + g, 0, w - lw - cw - (2 * g), rh, classify(upper), upper), box(lw + g + cw + g, rh + g, w - lw - cw - (2 * g), h - rh - g, classify(lower), lower)] };
}

function positionName(panel) {
  const cx = panel.placement.x + panel.placement.width / 2;
  const cy = panel.placement.y + panel.placement.height / 2;
  if (panel.placement.width > REFERENCE_BOARD_WIDTH * 0.8) return 'full-canvas panel';
  const horizontal = cx < REFERENCE_BOARD_WIDTH * 0.38 ? 'left' : cx > REFERENCE_BOARD_WIDTH * 0.68 ? 'right' : 'center';
  if (horizontal !== 'right' || panel.placement.height > REFERENCE_BOARD_HEIGHT * 0.8) return `${horizontal} panel`;
  return `${cy < REFERENCE_BOARD_HEIGHT / 2 ? 'upper' : 'lower'}-right panel`;
}

function roleInstruction(role) {
  if (role.includes('primary_character')) return "the primary character's identity, facial features, hair, age, body type, and wardrobe";
  if (role.includes('secondary_character')) return "the secondary character's separate identity, facial features, hair, age, body type, and wardrobe";
  if (role === 'character') return "this character's separate identity, facial features, hair, age, body type, and wardrobe";
  if (role === 'environment') return "the environment's architecture, materials, lighting vocabulary, and spatial identity";
  if (role === 'crucial_prop' || role === 'prop') return "the crucial prop's defining shape, material, scale, and identifying details";
  if (role === 'style_reference') return 'the supernatural interface treatment, color, line vocabulary, and graphic restraint only';
  return 'the referenced subject and its defining visible attributes only';
}

export function referenceBoardPromptGuidance(board) {
  const mapping = board.panels.map((panel) => `Use the ${positionName(panel)} only for ${roleInstruction(panel.role)}.`).join('\n');
  return `${REFERENCE_BOARD_PROMPT_GUIDANCE}\n${mapping}`;
}

export async function buildReferenceBoard({ root, imageId, references }) {
  const layout = referenceBoardLayout(references);
  const source = layout.panels.map((panel) => ({ asset_id: panel.ref.asset_id, sha256: panel.ref.sha256, role: panel.role, placement: { x: panel.x, y: panel.y, width: panel.width, height: panel.height } }));
  const cacheKey = digest(JSON.stringify({ schema: REFERENCE_BOARD_SCHEMA, compositor_version: REFERENCE_BOARD_COMPOSITOR_VERSION, width: REFERENCE_BOARD_WIDTH, height: REFERENCE_BOARD_HEIGHT, gutter: REFERENCE_BOARD_GUTTER, layout_id: layout.layout_id, panels: source }));
  const stem = `${safe(imageId)}--${cacheKey.slice(0, 16)}`;
  const boardDir = path.join(root, 'reference-boards');
  const manifestDir = path.join(root, 'reference-board-manifests');
  const outputPath = path.join(boardDir, `${stem}.png`);
  const manifestPath = path.join(manifestDir, `${stem}.json`);
  await fs.mkdir(boardDir, { recursive: true });
  await fs.mkdir(manifestDir, { recursive: true });
  const existing = await fs.readFile(manifestPath, 'utf8').then(JSON.parse).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
  if (existing) {
    const bytes = await fs.readFile(outputPath);
    if (digest(bytes) !== existing.output_sha256 || existing.cache_key !== cacheKey) throw new Error(`Cached reference board is stale: ${imageId}`);
    return { ...existing, manifest_path: existing.manifest_path ?? manifestPath };
  }
  const composites = [];
  for (const panel of layout.panels) {
    const input = await sharp(panel.ref.path).resize(panel.width, panel.height, { fit: 'cover', position: 'attention', withoutEnlargement: false }).png().toBuffer();
    composites.push({ input, left: panel.x, top: panel.y });
  }
  const bytes = await sharp({ create: { width: REFERENCE_BOARD_WIDTH, height: REFERENCE_BOARD_HEIGHT, channels: 4, background: REFERENCE_BOARD_BACKGROUND } }).composite(composites).png().toBuffer();
  await fs.writeFile(outputPath, bytes, { flag: 'wx' });
  const manifest = {
    schema: REFERENCE_BOARD_SCHEMA,
    board_id: `refboard.${imageId}.v1`,
    cache_key: cacheKey,
    layout_id: layout.layout_id,
    compositor: { library: 'sharp', version: sharp.versions?.sharp ?? null, contract_version: REFERENCE_BOARD_COMPOSITOR_VERSION, crop_rule: 'cover_attention_no_stretch' },
    output_path: outputPath,
    manifest_path: manifestPath,
    output_sha256: digest(bytes),
    width: REFERENCE_BOARD_WIDTH,
    height: REFERENCE_BOARD_HEIGHT,
    color_mode: 'rgba',
    panels: source,
    source_reference_order: references.map((ref) => ({ asset_id: ref.asset_id, sha256: ref.sha256 })),
    created_at: new Date().toISOString(),
  };
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  return { ...manifest, manifest_path: manifestPath };
}
