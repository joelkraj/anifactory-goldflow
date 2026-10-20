import { promises as fs } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { automatedReviewer } from "./autopilot-policy.mjs";
import { fileSha256 } from "./episode-budget.mjs";
import { REVIEW_RULES } from "./autopilot-reviewer.mjs";
import { STORY_LED_TITLE_POLICY } from "./story-led-title.mjs";
import {
  YOUTUBE_PACKAGING_SPEC_SCHEMA, YOUTUBE_THUMBNAIL_GENERATION_CONTRACT, packagingWorkflowSupport, validateYoutubePackagingSpec,
} from "./youtube-publish-contract.mjs";

// Automatic upload packaging for content profiles that have a packaging
// contract (manhwa_recap_v1 today). Research evidence and channel settings come
// from the channel's recorded config; the model never invents metrics.
export const AUTOPILOT_PACKAGING_CONFIG_SCHEMA = "goldflow_autopilot_packaging_config_v1";
const PROVIDER_IDS = new Map([["google-gemini", "google_gemini_imagen"], ["google-flow", "google_flow_imagen"]]);

function need(value, message) {
  if (!value) throw new Error(message);
}
function clean(value) {
  return String(value ?? "").trim();
}

export function packagingConfigPath(dataRoot, channel) {
  return path.join(dataRoot, "channels", channel, "autopilot_packaging.json");
}

export async function loadPackagingConfig(configPath) {
  let config;
  try {
    config = JSON.parse(await fs.readFile(configPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") throw new Error(`Autopilot packaging needs the channel's recorded research evidence and YouTube settings at ${configPath}.`);
    throw error;
  }
  need(config?.schema === AUTOPILOT_PACKAGING_CONFIG_SCHEMA, `Unsupported packaging config schema in ${configPath}.`);
  need(Array.isArray(config.research_evidence) && config.research_evidence.length >= 3, "Packaging config needs at least three recorded research evidence rows.");
  need(config.youtube_channel && config.publish_settings, "Packaging config needs youtube_channel and publish_settings.");
  return config;
}

export function packagingMarkdown(spec) {
  return [
    `# Upload packaging — ${spec.episode}`, "",
    "## Recommended Title", spec.selected_title, "",
    "## Full Description", spec.description, "",
    "## Pinned Comment", spec.pinned_comment.text, "",
    "## Provenance", `Authored by ${spec.authored_by}; validated by the YouTube packaging contract before approval.`, "",
  ].join("\n");
}

function authorPrompt({ script, evidence, identity }) {
  return `${REVIEW_RULES}
Author YouTube packaging for this ${identity.content_profile ?? "manhwa_recap_v1"} episode under policy ${STORY_LED_TITLE_POLICY}.
Rules: 3–5 unique title candidates (35–100 characters, each ending with "| Manhwa Recap", explains_full_video true, hook_contract {primary_hook, hook_phrase, payoff_phrase, why_this_hook, story_support:[{title_phrase, evidence, source_quote}]} where hook_phrase and payoff_phrase appear in the title and every source_quote is copied verbatim from the script); research_evidence_ids only from the ids below.
2–3 thumbnail candidates: {id, subjects:[{role, emotion}] (1–3), main_text (1–4 words), labels:[{text}] (≤2, ≤3 words), arrows:[{purpose}] (≤2), hook_signal, payoff_signal, single_scene:true, no_collage:true, simple_read_order:true, research_evidence_ids, image_prompt (a complete 16:9 image prompt that renders the main_text in the image)}.
description (opening explains hook and payoff and contains the primary keywords), description_contract {primary_keywords:[1–2], opening_explains_hook_and_payoff:true}, tags:[…], pinned_comment {text (≤500 chars, one clear question), viewer_dilemma}, selected_title, title_selection_reason.
Return exactly one JSON object with those fields.

RESEARCH EVIDENCE:
${JSON.stringify(evidence.map((row) => ({ id: row.id, title: row.title, lesson: row.lesson, source_type: row.source_type })), null, 2)}

SCRIPT:
${script.slice(0, 120_000)}`;
}

/**
 * Writes upload_packaging_<ep>.md and a draft youtube_packaging_spec_<ep>.json
 * that already passes the packaging validator (except approval). Approval is
 * recorded afterwards by `youtube approve-packaging` with an automated reviewer.
 */
export async function authorAutomatedPackaging({ episodeDir, episode, identity, config, reviewer, thumbnailGenerator, now = new Date().toISOString() }) {
  const support = packagingWorkflowSupport(identity);
  need(support.available, support.reason);
  const scriptText = await fs.readFile(path.join(episodeDir, "script_clean.md"), "utf8");
  const ids = new Set(config.research_evidence.map((row) => row.id));
  const draft = await reviewer({
    task: "upload_packaging",
    prompt: authorPrompt({ script: scriptText, evidence: config.research_evidence, identity }),
    validate: (value) => {
      const problems = [];
      if (!Array.isArray(value?.title_candidates) || !Array.isArray(value?.thumbnail_candidates)) problems.push("title_candidates and thumbnail_candidates are required");
      const links = [...(value?.title_candidates ?? []), ...(value?.thumbnail_candidates ?? [])].flatMap((row) => row?.research_evidence_ids ?? []);
      if (links.some((id) => !ids.has(id))) problems.push("research_evidence_ids must come from the recorded evidence");
      if ((value?.thumbnail_candidates ?? []).some((row) => clean(row?.image_prompt).length < 40)) problems.push("every thumbnail candidate needs an image_prompt");
      return problems;
    },
  });
  const thumbDir = path.join(episodeDir, "packaging", "thumbnails");
  await fs.mkdir(thumbDir, { recursive: true });
  const receipts = await thumbnailGenerator({
    jobs: draft.thumbnail_candidates.map((row) => ({ workId: `${episode}_${row.id}`, prompt: row.image_prompt, outputPath: path.join(thumbDir, `${row.id}.png`) })),
  });
  need(Array.isArray(receipts) && receipts.length === draft.thumbnail_candidates.length && receipts.every((row) => row?.reference_count === 0),
    "Every thumbnail candidate needs a zero-reference generation receipt.");
  const pick = await reviewer({
    task: "thumbnail_select",
    images: receipts.map((row) => row.output_path),
    prompt: `${REVIEW_RULES}\nThese are thumbnail candidates ${draft.thumbnail_candidates.map((row) => row.id).join(", ")} (in order). Pick the one that reads best at mobile size (about 168×94 px): one scene, legible model-rendered text, clear read order. Return {"selected_id":"…","readable_at_mobile_size":true|false,"note":"…"}.`,
    validate: (value) => (draft.thumbnail_candidates.some((row) => row.id === value?.selected_id) && typeof value?.readable_at_mobile_size === "boolean" ? [] : ["selected_id must be a candidate id"]),
  });
  need(pick.readable_at_mobile_size === true, `No thumbnail candidate is readable at mobile size: ${clean(pick.note)}`);
  const index = draft.thumbnail_candidates.findIndex((row) => row.id === pick.selected_id);
  const finalPath = path.join(episodeDir, `thumbnail_final_${episode}.png`);
  await fs.copyFile(receipts[index].output_path, finalPath);
  const candidates = draft.thumbnail_candidates.map((row, position) => {
    const { image_prompt: imagePrompt, ...rest } = row;
    return {
      ...rest, image_prompt: imagePrompt, provider: PROVIDER_IDS.get(receipts[position].provider) ?? receipts[position].provider,
      generation_mode: YOUTUBE_THUMBNAIL_GENERATION_CONTRACT.generation_mode, reference_count: 0,
      text_rendered_by_model: true, locally_composited_text: false, locally_composited_arrows: false,
      generation_receipt_path: `${receipts[position].output_path}.receipt.json`,
      ...(position === index ? { mobile_reviewed: true, selection_reason: `Automated mobile-size review: ${clean(pick.note)}` } : {}),
    };
  });
  const spec = {
    schema: YOUTUBE_PACKAGING_SPEC_SCHEMA, status: "draft", episode,
    title_selection_policy: STORY_LED_TITLE_POLICY,
    research_evidence: config.research_evidence,
    title_candidates: draft.title_candidates,
    selected_title: clean(draft.selected_title),
    thumbnail_candidates: candidates,
    selected_thumbnail_candidate_id: pick.selected_id,
    thumbnail_final_path: finalPath,
    description: clean(draft.description),
    description_contract: draft.description_contract,
    tags: draft.tags ?? [],
    pinned_comment: draft.pinned_comment,
    youtube_channel: config.youtube_channel,
    publish_settings: { ...config.publish_settings, initial_visibility: "private" },
    authored_by: automatedReviewer("packaging_author"),
    authored_at: now,
  };
  const selectedTitle = spec.title_candidates.find((row) => clean(row.title) === spec.selected_title);
  if (selectedTitle && !selectedTitle.selection_reason) selectedTitle.selection_reason = clean(draft.title_selection_reason) || "Strongest hook/payoff match to the full video.";
  const markdown = packagingMarkdown(spec);
  const [metadata, stat] = await Promise.all([sharp(finalPath).metadata(), fs.stat(finalPath)]);
  const validation = validateYoutubePackagingSpec(spec, {
    runIdentity: identity, requireApproval: false, markdown, scriptText,
    thumbnailMetadata: { width: metadata.width, height: metadata.height, format: metadata.format },
    thumbnailBytes: stat.size, thumbnailFinalSha256: await fileSha256(finalPath),
  });
  const packagePath = path.join(episodeDir, `upload_packaging_${episode}.md`);
  const specPath = path.join(episodeDir, `youtube_packaging_spec_${episode}.json`);
  if (validation.status !== "passed") {
    // The rejected draft is kept for triage under autopilot/, not as the episode's package.
    const draftPath = path.join(episodeDir, "autopilot", "requests", `packaging_draft_${Date.now()}.json`);
    await fs.mkdir(path.dirname(draftPath), { recursive: true });
    await fs.writeFile(draftPath, `${JSON.stringify({ spec, blockers: validation.blockers }, null, 2)}\n`, { flag: "wx" });
    return { status: "blocked", blockers: validation.blockers, draft_path: draftPath };
  }
  await fs.writeFile(packagePath, markdown, { flag: "wx" });
  await fs.writeFile(specPath, `${JSON.stringify(spec, null, 2)}\n`, { flag: "wx" });
  return { status: "draft_ready", package_path: packagePath, spec_path: specPath };
}
