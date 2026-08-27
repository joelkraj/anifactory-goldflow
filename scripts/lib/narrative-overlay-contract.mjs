import { createHash } from "node:crypto";

export const NARRATIVE_OVERLAY_KINDS = Object.freeze([
  "rpg_game_text",
  "speech_bubble",
  "thought_bubble",
  "manhwa_reaction",
  "game_hud",
]);

const OVERLAY_STYLES = new Set([
  "system_cyan",
  "rank_gold",
  "danger_red",
  "success_green",
  "speech_white",
  "speech_black",
  "whisper_gray",
  "reaction_shock",
  "reaction_rage",
  "reaction_comedy",
  "reaction_dread",
]);

function cleanText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function comparisonText(value) {
  return cleanText(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function defaultStyle(kind) {
  if (kind === "speech_bubble") return "speech_white";
  if (kind === "thought_bubble") return "whisper_gray";
  if (kind === "manhwa_reaction") return "reaction_shock";
  return "system_cyan";
}

function overlayId(imageId, index, text, treatment) {
  const digest = createHash("sha256")
    .update(`${imageId ?? "cut"}:${index}:${text}:${treatment}`)
    .digest("hex")
    .slice(0, 12);
  return `${imageId ?? "cut"}-graphic-${digest}`;
}

function promptHasKindLanguage(kind, providerPrompt) {
  if (!providerPrompt) return false;
  if (kind === "speech_bubble") return /\b(?:speech|dialogue|manhwa|comic)\s+bubble\b|\bspeech balloon\b/.test(providerPrompt);
  if (kind === "thought_bubble") return /\b(?:thought|inner monologue|manhwa|comic)\s+bubble\b|\bthought balloon\b/.test(providerPrompt);
  if (kind === "manhwa_reaction") return /\b(?:manhwa reaction|reaction styling|shock lines|rage lines|speed lines|impact burst|chibi reaction|comic reaction|dread shading)\b/.test(providerPrompt);
  return /\b(?:rpg|game|system|hud|status|rank|quest|reward|ownership|progression)\b/.test(providerPrompt);
}

export function narrativeOverlayAuthoringRules() {
  return [
    "Every cut must include narrative_overlays. Most cuts should use one integrated narrative graphic; use [] for purposeful clean frames such as an establishing breath, an already-dense action image, or an emotional close-up that becomes weaker with lettering.",
    "The image model renders narrative_overlays inside the finished still. Write the complete graphic instruction and its exact short copy directly inside provider_prompt; metadata alone is not sent as a second post-production text layer.",
    "Use rpg_game_text for ranks, rewards, threats, ownership changes, timers, hidden conditions, status deltas, or game-ad progression receipts. Use speech_bubble or thought_bubble for a short reaction, strategy line, irony beat, character pressure, or subtext. Use manhwa_reaction for shock, rage, dread, embarrassment, comedy, impact lines, expression exaggeration, or a compact reaction caption.",
    "The graphic must be additive to the local narration and subtitles. It may reveal subtext, a private thought, a status delta, an unspoken reaction, or a sharper payoff, but it should not transcribe or summarize visual_beat_script_excerpt. State the new value in information_delta.",
    "Prefer one dominant narrative graphic. Use a second only when the composition has two clearly separated reading zones and both additions materially improve the beat.",
    "Keep lettering mobile-readable, normally 2-10 words and at most 64 characters. Name the speaker or attachment target, describe the bubble tail or RPG/reaction treatment, and place the graphic where it remains integrated without covering the decisive face, contact point, or lower-center subtitle zone.",
    "ui_text_on_screen remains source-required literal story/UI text. narrative_overlays is an editorial image-generation layer and must not duplicate ui_text_on_screen in the same cut.",
  ];
}

export function sanitizeNarrativeOverlays(value, options = {}) {
  const rows = Array.isArray(value) ? value : [];
  const imageId = cleanText(options.imageId) || null;
  const sceneId = cleanText(options.sceneId) || null;
  const narrationText = comparisonText(options.narrationText);
  const providerPrompt = comparisonText(options.providerPrompt);
  const literalUi = new Set((options.uiTextOnScreen ?? []).map(comparisonText).filter(Boolean));
  const overlays = [];
  const findings = [];

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      findings.push({
        image_id: imageId,
        scene_id: sceneId,
        severity: "warning",
        code: "narrative_overlay_invalid_row_dropped",
        message: `Narrative graphic row ${index + 1} was not an object and was dropped.`,
        resolved: true,
      });
      continue;
    }
    const requestedKind = cleanText(row.kind).toLowerCase();
    const kind = NARRATIVE_OVERLAY_KINDS.includes(requestedKind) ? requestedKind : "rpg_game_text";
    const text = cleanText(row.text);
    const visualTreatment = cleanText(row.visual_treatment ?? row.treatment);
    if (!text && !(kind === "manhwa_reaction" && visualTreatment)) {
      findings.push({
        image_id: imageId,
        scene_id: sceneId,
        severity: "warning",
        code: "narrative_overlay_empty_content_dropped",
        message: `Narrative graphic row ${index + 1} had neither readable copy nor a usable reaction treatment and was dropped.`,
        resolved: true,
      });
      continue;
    }
    const requestedStyle = cleanText(row.style).toLowerCase();
    const style = OVERLAY_STYLES.has(requestedStyle) ? requestedStyle : defaultStyle(kind);
    const informationDelta = cleanText(row.information_delta ?? row.purpose);
    const normalizedText = comparisonText(text);
    const normalizedTreatment = comparisonText(visualTreatment);
    const placement = cleanText(row.placement ?? row.position) || "integrated near the relevant subject without covering the decisive action";
    const rawAttachmentTarget = row.attachment_target ?? row.tail_target;
    const attachmentTarget = typeof rawAttachmentTarget === "string"
      ? cleanText(rawAttachmentTarget) || null
      : null;

    if (text.length > 64) {
      findings.push({
        image_id: imageId,
        scene_id: sceneId,
        severity: "warning",
        code: "narrative_overlay_copy_too_long",
        message: `Graphic copy \"${text}\" exceeds the 64-character mobile-reading target.`,
        resolved: false,
      });
    }
    if (!informationDelta) {
      findings.push({
        image_id: imageId,
        scene_id: sceneId,
        severity: "warning",
        code: "narrative_overlay_information_delta_missing",
        message: `Narrative graphic ${text ? `\"${text}\"` : `row ${index + 1}`} does not state what new information it adds.`,
        resolved: false,
      });
    }
    if (normalizedText.length >= 4 && narrationText.includes(normalizedText)) {
      findings.push({
        image_id: imageId,
        scene_id: sceneId,
        severity: "warning",
        code: "narrative_overlay_duplicates_narration",
        message: `Graphic copy \"${text}\" repeats the local narration instead of adding a second reading layer.`,
        resolved: false,
      });
    }
    if (normalizedText && literalUi.has(normalizedText)) {
      findings.push({
        image_id: imageId,
        scene_id: sceneId,
        severity: "warning",
        code: "narrative_overlay_duplicates_literal_ui",
        message: `Graphic copy \"${text}\" duplicates ui_text_on_screen in the same cut.`,
        resolved: false,
      });
    }
    if (providerPrompt) {
      const textMissing = normalizedText && !providerPrompt.includes(normalizedText);
      const treatmentMissing = normalizedTreatment && !providerPrompt.includes(normalizedTreatment);
      const kindMissing = !promptHasKindLanguage(kind, providerPrompt);
      if (textMissing || treatmentMissing || kindMissing) {
        findings.push({
          image_id: imageId,
          scene_id: sceneId,
          severity: "warning",
          code: "narrative_overlay_not_authored_in_provider_prompt",
          message: `The ${kind} metadata is not fully materialized in provider_prompt; the image model would not receive the intended graphic.`,
          missing_exact_copy: Boolean(textMissing),
          missing_visual_treatment: Boolean(treatmentMissing),
          missing_kind_language: Boolean(kindMissing),
          resolved: false,
        });
      }
    }

    overlays.push({
      overlay_id: cleanText(row.overlay_id) || overlayId(imageId, index, text, visualTreatment),
      kind,
      text: text || null,
      speaker: cleanText(row.speaker) || null,
      information_delta: informationDelta || null,
      placement,
      attachment_target: attachmentTarget,
      style,
      visual_treatment: visualTreatment || null,
    });
  }

  return { overlays, findings };
}
