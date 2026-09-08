import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import sharp from "sharp";
import { resolvePilotHostDesignRevision } from "./lib/avatar-pilot-host-design-revision.mjs";

const execute = promisify(execFile);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const need = (ok, message) => { if (!ok) throw new Error(message); };
const ref = async (file, id) => ({ ...(id ? { id } : {}), path: file, sha256: hash(await fs.readFile(file)) });
const writeJson = async (file, value) => fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });

function flags(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 2) { need(argv[i]?.startsWith("--") && argv[i + 1], "Flags require --name value pairs."); result[argv[i].slice(2)] = argv[i + 1]; }
  return result;
}

async function prepare(episodeDir) {
  const identityPath = path.join(episodeDir, "run_identity.json");
  const identity = JSON.parse(await fs.readFile(identityPath));
  const host = await resolvePilotHostDesignRevision({ episodeDir, identity }); need(host, "Accepted host revision is required.");
  const plan = structuredClone(host.plan.row.payload);
  const sourceFor = { concept_intercept: ["film_sentry_window"], concept_rescue: ["film_sentry_window"], concept_void_doorway: ["film_void_shadow"] };
  for (const row of plan.assets.filter((asset) => Object.hasOwn(sourceFor, asset.id))) Object.assign(row, {
    kind: "editorial_composite", provider: "local_compositor", model: "source_cutout_composite_v1",
    reference_asset_ids: sourceFor[row.id],
    purpose: `${row.purpose} Materialize as a clearly editorial moving-sticker composition from the exact referenced movie excerpt plus locally authored diagram shapes; never present it as a leaked frame.`,
  });
  plan.intent = "Exactly 90-second private proof using accepted host/media plus three source-bound local editorial composites after both locked AI concept providers returned no output.";
  plan.scope = { ...plan.scope, new_still_count: 7, generated_concept_still_count: 0, local_editorial_composite_count: 3 };
  plan.art_direction.concept_style = "Specular-inspired editorial boards: source-frame character cutouts with a thick white sticker edge, soft shadow, restrained local shapes and clear compositor truth labels. No AI-generated crossover frame.";
  plan.art_direction.concept_continuity = "Shared abstract tower-board geometry and repeated device marker; Sentry/Void cutouts remain bound to the two accepted Thunderbolts excerpts. Doom is a locally authored green-hood and metal-mask diagram silhouette, not a film costume or actor likeness.";
  plan.generation_order = plan.generation_order.map((step) => ({ ...step, asset_ids: step.asset_ids.filter((id) => !Object.hasOwn(sourceFor, id)) })).filter((step) => step.asset_ids.length);
  plan.generation_order.push({ step: 3, asset_ids: Object.keys(sourceFor), gate_after: "Inspect all three deterministic local composites and their exact source/recipe receipts before media import." });
  plan.revision = { id: "local_concept_fallback_v1", status: "operator_authorized_after_dual_provider_no_output",
    request: "Use source-derived character stickers, framed clips and local graphic shapes to finish the proof quickly.",
    unchanged_scope: "Same 90-second script, narration, two accepted movie excerpts, masked host, room, asset IDs and publishing prohibition." };
  const planPath = path.join(episodeDir, "asset_plan_candidate_v4_local_composites.json");
  await writeJson(planPath, plan);
  const work = path.join(episodeDir, "pilot_media_work", "concept_intercept");
  const request = { schema: "goldflow_avatar_pilot_concept_fallback_request_v1", identity_sha256: (await ref(identityPath)).sha256,
    prior_plan: await ref(host.plan.path), prior_approval: await ref(host.approval.path), new_plan: await ref(planPath),
    provider_failures: [await ref(path.join(work, "generation_result_v1.json")), await ref(path.join(work, "generation_result_v2_gemini_web.json"))] };
  const requestPath = path.join(episodeDir, "concept_fallback_request_v1.json"); await writeJson(requestPath, request);
  process.stdout.write(`${requestPath}\n`);
}

async function sticker(input, height) {
  const body = await sharp(input).trim({ background: { r: 0, g: 0, b: 0, alpha: 0 } }).resize({ height, fit: "inside" }).png().toBuffer();
  const meta = await sharp(body).metadata();
  const alpha = await sharp(body).extractChannel("alpha").png().toBuffer();
  const white = await sharp({ create: { width: meta.width, height: meta.height, channels: 3, background: "white" } }).joinChannel(alpha).png().toBuffer();
  const pad = 18, shifts = [[0,-pad],[pad,-pad],[pad,0],[pad,pad],[0,pad],[-pad,pad],[-pad,0],[-pad,-pad]];
  return sharp({ create: { width: meta.width + pad * 2, height: meta.height + pad * 2, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([...shifts.map(([x,y]) => ({ input: white, left: pad + x, top: pad + y })), { input: body, left: pad, top: pad }]).png().toBuffer();
}

const doomSvg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="620" height="900" viewBox="0 0 620 900">
<g stroke="#fff" stroke-width="22" stroke-linejoin="round" paint-order="stroke fill"><path fill="#173d31" d="M78 855 112 365 205 120 310 55 416 120 510 365 548 855Z"/><path fill="#245947" d="M151 355 205 132 310 78 416 132 471 355 407 252 310 216 214 252Z"/><path fill="#aeb9ba" d="M222 220 310 176 399 220 379 469 310 548 241 469Z"/><path fill="#536568" d="m253 280 57-30 57 30-18 171-39 42-39-42Z"/><path fill="#0d1719" d="m252 321 42-16-8 45-42 8Zm116 0-42-16 8 45 42 8Z"/><path fill="#1a2527" d="M274 401h72l-10 43h-52Z"/><path fill="#29483d" d="M116 492 25 742l113 52 116-245Zm388 0 91 250-113 52-116-245Z"/></g></svg>`);
const caseSvg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="430" height="260"><g stroke="#fff" stroke-width="14" paint-order="stroke fill"><rect x="35" y="70" width="360" height="155" rx="22" fill="#20262d"/><path d="M155 70V35h120v35" fill="none" stroke="#fff" stroke-width="24"/><path d="M55 145h320" stroke="#d38b31" stroke-width="12"/></g></svg>`);
const allySvg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="350" height="520"><g stroke="#fff" stroke-width="18" stroke-linejoin="round" paint-order="stroke fill"><circle cx="175" cy="92" r="62" fill="#283543"/><path d="M95 185h160l45 270H48Z" fill="#526373"/><path d="m95 230-72 132 55 28 86-125m91-35 72 132-55 28-86-125" fill="#526373"/></g></svg>`);

async function makeBoard({ background, layers, output }) {
  const texture = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080"><defs><filter id="n"><feTurbulence baseFrequency=".7" numOctaves="2" seed="8"/><feColorMatrix type="saturate" values="0"/><feComponentTransfer><feFuncA type="table" tableValues="0 .06"/></feComponentTransfer></filter></defs><rect width="1920" height="1080" fill="${background}"/><rect width="1920" height="1080" filter="url(#n)" opacity=".35"/><path d="M0 860 1920 700V1080H0Z" fill="#0d151c" opacity=".42"/></svg>`);
  await sharp(texture).composite(layers).png().toFile(output);
}

async function build(episodeDir) {
  const planStage = JSON.parse(await fs.readFile(path.join(episodeDir, "pilot_concept_fallback", "pilot_asset_plan.json"), "utf8"));
  const assets = Object.fromEntries(planStage.payload.assets.map((row) => [row.id, row]));
  const out = path.join(episodeDir, "pilot_media_work", "local_composites"); await fs.mkdir(out, { recursive: false });
  const sentryClip = assets.film_sentry_window.existing_file.path, voidClip = assets.film_void_shadow.existing_file.path;
  const sentryFrame = path.join(out, "sentry_frame.png"), voidFrame = path.join(out, "void_frame.png");
  await execute("ffmpeg", ["-v", "error", "-ss", "2.2", "-i", sentryClip, "-frames:v", "1", sentryFrame]);
  await execute("ffmpeg", ["-v", "error", "-ss", "2.0", "-i", voidClip, "-frames:v", "1", voidFrame]);
  const sentryCutout = path.join(out, "sentry_cutout.png"), voidCutout = path.join(out, "void_cutout.png");
  const swift = path.resolve(path.dirname(new URL(import.meta.url).pathname), "macos-subject-cutout.swift");
  await execute("xcrun", ["swift", swift, sentryFrame, sentryCutout]); await execute("xcrun", ["swift", swift, voidFrame, voidCutout]);
  const sentrySticker = await sticker(sentryCutout, 820), voidSticker = await sticker(voidCutout, 900);
  const outputs = {
    concept_intercept: { file: path.join(out, "concept_intercept.png"), source: "film_sentry_window", background: "#293446",
      layers: [{ input: doomSvg, left: 40, top: 110 }, { input: await sharp(sentrySticker).flop().png().toBuffer(), left: 770, top: 150 }, { input: caseSvg, left: 1450, top: 690 }] },
    concept_rescue: { file: path.join(out, "concept_rescue.png"), source: "film_sentry_window", background: "#A64339",
      layers: [{ input: sentrySticker, left: 45, top: 160 }, { input: allySvg, left: 1110, top: 310 }, { input: allySvg, left: 1380, top: 350 }, { input: caseSvg, left: 1375, top: 730 }] },
    concept_void_doorway: { file: path.join(out, "concept_void_doorway.png"), source: "film_void_shadow", background: "#E7E2D9",
      layers: [{ input: doomSvg, left: 30, top: 120 }, { input: voidSticker, left: 620, top: 105 }, { input: allySvg, left: 1490, top: 410 }, { input: caseSvg, left: 1430, top: 750 }] },
  };
  for (const [id, spec] of Object.entries(outputs)) await makeBoard({ background: spec.background, layers: spec.layers, output: spec.file });
  const recipe = { schema: "goldflow_avatar_pilot_local_composite_recipe_v1", method: "ffmpeg_frame_then_macos_vision_foreground_mask_then_sharp_sticker_board",
    source_frame_offsets_sec: { film_sentry_window: 2.2, film_void_shadow: 2.0 }, white_sticker_border_px: 18,
    locally_authored_elements: ["abstract tower board", "green hood and metal mask diagram silhouette", "equipment case marker", "ally diagram silhouettes"],
    intermediate_hashes: { sentry_frame: (await ref(sentryFrame)).sha256, void_frame: (await ref(voidFrame)).sha256,
      sentry_cutout: (await ref(sentryCutout)).sha256, void_cutout: (await ref(voidCutout)).sha256 },
    output_hashes: Object.fromEntries(await Promise.all(Object.entries(outputs).map(async ([id, spec]) => [id, (await ref(spec.file)).sha256]))) };
  const recipePath = path.join(out, "recipe.json"); await writeJson(recipePath, recipe); const recipeRef = await ref(recipePath);
  const reviewPacket = { schema: "goldflow_avatar_pilot_local_composite_review_packet_v1", status: "review_required",
    recipe: recipeRef, assets: await Promise.all(Object.entries(outputs).map(async ([id, spec]) => ({
      id, output: await ref(spec.file), source_binding: { id: spec.source, ...assets[spec.source].existing_file },
    }))) };
  await writeJson(path.join(out, "review_packet.json"), reviewPacket);
  process.stdout.write(`${out}\n`);
}

async function approve(episodeDir, reviewer, note) {
  need(reviewer && note, "Approval requires --reviewer and --note.");
  const out = path.join(episodeDir, "pilot_media_work", "local_composites");
  const packetPath = path.join(out, "review_packet.json");
  const packet = JSON.parse(await fs.readFile(packetPath, "utf8"));
  need(packet.schema === "goldflow_avatar_pilot_local_composite_review_packet_v1", "Unexpected local composite review packet.");
  const recipe = await ref(packet.recipe.path);
  need(recipe.sha256 === packet.recipe.sha256, "Local composite recipe changed after review packet creation.");
  for (const asset of packet.assets) {
    const output = await ref(asset.output.path);
    need(output.sha256 === asset.output.sha256, `${asset.id} changed after review packet creation.`);
    const source = await ref(asset.source_binding.path, asset.source_binding.id);
    need(source.sha256 === asset.source_binding.sha256, `${asset.id} source changed after review packet creation.`);
    await writeJson(path.join(out, `${asset.id}_receipt.json`), {
      schema: "goldflow_avatar_pilot_local_composite_receipt_v1", status: "passed",
      asset_id: asset.id, provider: "local_compositor", model: "source_cutout_composite_v1",
      output_sha256: output.sha256, source_bindings: [{ ...asset.source_binding, sha256: source.sha256 }], recipe,
      review: { approved: true, reviewer, note }, production_eligible: false, publish_allowed: false,
    });
  }
  process.stdout.write(`${out}\n`);
}

const [command, ...rest] = process.argv.slice(2), options = flags(rest);
need(["prepare-fallback", "build", "approve"].includes(command) && options["episode-dir"], "Use prepare-fallback|build|approve --episode-dir <absolute-path>.");
const episodeDir = path.resolve(options["episode-dir"]);
if (command === "prepare-fallback") await prepare(episodeDir);
else if (command === "build") await build(episodeDir);
else await approve(episodeDir, options.reviewer, options.note);
