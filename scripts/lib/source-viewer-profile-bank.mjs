import { createHash } from "node:crypto";

export const CORE_SOURCE_VIEWER_PROFILES = Object.freeze([
  {
    id: "instant_payoff_scroller",
    order: "candidate_first",
    brief: "You click manhwa recaps impulsively and leave quickly when the title fantasy is delayed. You reward immediate visual action, simple stakes, escalating surprise, and a clear reason to keep watching. Dense lore and setup feel expensive to you.",
  },
  {
    id: "emotional_kdrama_viewer",
    order: "reference_first",
    brief: "You stay for emotionally specific betrayal, relationship pressure, sacrifice, subtext, and choices with human cost. You dislike procedural status drama, hollow cruelty, and characters who exist only to explain mechanics.",
  },
  {
    id: "system_power_fantasy_viewer",
    order: "candidate_first",
    brief: "You want the promised power, regression, theft, or system fantasy demonstrated clearly and expanded through clever applications. You tolerate setup only while danger escalates. You dislike delayed engines, vague powers, and repetitive victories.",
  },
  {
    id: "coherence_binge_viewer",
    order: "reference_first",
    brief: "You watch long recaps when causes, character decisions, rules, and payoffs remain understandable at narration speed. You notice repetition, forgotten setup, arbitrary saves, continuity errors, and middles that stop changing the story.",
  },
  {
    id: "skeptical_niche_veteran",
    order: "candidate_first",
    brief: "You have watched hundreds of manhwa recaps and recognize generic AI phrasing, copied scaffolds, exposition dumps, empty crowd reactions, and fake cliffhangers. You reward a fresh package, clean dramatic escalation, memorable scenes, and a satisfying complete payoff.",
  },
]);

export const ROTATING_SOURCE_VIEWER_PROFILE_BANK = Object.freeze([
  ["lore_intolerant_casual", "You abandon videos when proper nouns, factions, history, ranks, or rules arrive faster than immediate drama can make them useful."],
  ["revenge_payoff_purist", "You clicked to watch betrayal become personal reversal, humiliation, and earned consequences. Mercy can work, but only after decisive dominance and visible justice."],
  ["mechanic_optimizer", "You enjoy systems when rules create clever choices, combinations, measurable growth, and satisfying exploits. Vague or conveniently changing mechanics lose you."],
  ["spectacle_seeker", "You need visually memorable confrontations, transformations, impossible feats, and escalating dominance. You reject administration presented as stakes."],
  ["emotional_justice_viewer", "You stay when wronged characters receive emotionally specific recognition, repair, apology, restitution, or consequence rather than generic victory."],
  ["background_listener", "You often listen while doing something else. Names, chronology, goals, and reversals must remain understandable without rereading or visual dependence."],
  ["ending_payoff_hawk", "You tolerate setup only when the ending resolves the clicked promise, core relationship, antagonist, and protagonist change instead of stopping at sequel setup."],
  ["novelty_skeptic", "You have low patience for familiar regression, system, academy, and revenge scaffolds unless scenes produce an original human or tactical consequence."],
  ["procedural_middle_abandoner", "You leave during hearings, ledgers, meetings, training summaries, travel, logistics, and rule explanation unless each beat visibly changes danger or a relationship."],
  ["character_agency_critic", "You track whether Joey and recurring allies make consequential choices. Convenient rescues, passive rewards, and supporting characters reduced to tools lose you."],
  ["romance_subtext_viewer", "You value earned attraction, boundaries, tension, vulnerability, and changed trust. Decorative heroines and reward-romance weaken your investment."],
  ["status_reversal_addict", "You want former superiors to witness undeniable status inversion through competence, authority, wealth, power, or public choice, with increasingly strong receipts."],
  ["danger_believability_viewer", "You need opposition to learn, adapt, and create credible loss. Repeated effortless wins and last-second unplanted abilities make you stop believing danger."],
  ["comment_theory_viewer", "You stay for clear mysteries, rules, motives, and planted clues that support discussion and prediction without withholding basic story comprehension."],
  ["compression_sensitive_viewer", "You dislike both padding and breathless summaries. Scenes should dramatize decisive turns, then leave before repeating their function."],
].map(([id, brief], index) => Object.freeze({
  id,
  brief,
  order: index % 2 === 0 ? "reference_first" : "candidate_first",
})));

export function selectRotatingSourceViewerProfiles(seed, count = 5) {
  const stableSeed = String(seed ?? "").trim();
  if (!stableSeed) throw new Error("A non-empty panel seed is required.");
  if (!Number.isInteger(count) || count < 1 || count > ROTATING_SOURCE_VIEWER_PROFILE_BANK.length) {
    throw new Error(`Invalid rotating viewer count ${count}.`);
  }
  return [...ROTATING_SOURCE_VIEWER_PROFILE_BANK]
    .sort((left, right) => {
      const leftHash = createHash("sha256").update(`${stableSeed}\0${left.id}`).digest("hex");
      const rightHash = createHash("sha256").update(`${stableSeed}\0${right.id}`).digest("hex");
      return leftHash.localeCompare(rightHash);
    })
    .slice(0, count);
}

export function sourceViewerPanel(seed) {
  return [
    ...CORE_SOURCE_VIEWER_PROFILES.map((profile) => ({ ...profile, panel_role: "control" })),
    ...selectRotatingSourceViewerProfiles(seed, 5).map((profile) => ({ ...profile, panel_role: "rotating_challenger" })),
  ];
}
