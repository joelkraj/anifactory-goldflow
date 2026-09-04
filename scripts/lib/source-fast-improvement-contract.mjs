export const FAST_IMPROVEMENT_PANEL_COUNT = 3;
export const FAST_IMPROVEMENT_MIN_APV_DELTA = 0.5;

export function validateDirectorNotes(notes, incumbentSha256) {
  if (!notes || notes.incumbent_sha256 !== incumbentSha256) throw new Error("Director notes do not match the exact incumbent script.");
  if (typeof notes.instructions !== "string" || !notes.instructions.trim()) throw new Error("Director notes need nonempty editorial instructions.");
  if (notes.instructions.length > 6000) throw new Error("Keep director instructions compact (at most 6000 characters).");
  return notes.instructions.trim();
}

function average(values) {
  const numbers = values.map(Number).filter(Number.isFinite);
  return numbers.length ? numbers.reduce((sum, value) => sum + value, 0) / numbers.length : null;
}

export function assessFastImprovementLength(incumbentWordCount, challengerWordCount) {
  const incumbent = Number(incumbentWordCount);
  const challenger = Number(challengerWordCount);
  const ratio = incumbent > 0 && challenger > 0 ? challenger / incumbent : null;
  return {
    incumbent_word_count: incumbent,
    challenger_word_count: challenger,
    ratio: ratio == null ? null : Number(ratio.toFixed(4)),
    requested_range: [0.95, 1.05],
    comparable_range: [0.9, 1.1],
    within_requested_range: ratio != null && ratio >= 0.95 && ratio <= 1.05,
    within_comparable_range: ratio != null && ratio >= 0.9 && ratio <= 1.1,
    rule: "Word count is not a viewer score. This loose guard only prevents a materially shorter or longer script from masquerading as an editing win.",
  };
}

export function decideFastImprovement({
  panels,
  incumbentWordCount,
  challengerWordCount,
  minimumApvDelta = FAST_IMPROVEMENT_MIN_APV_DELTA,
} = {}) {
  const rows = Array.isArray(panels) ? panels : [];
  const incumbentApv = average(rows.map((row) => row?.incumbent_predicted_apv));
  const challengerApv = average(rows.map((row) => row?.challenger_predicted_apv));
  const delta = incumbentApv == null || challengerApv == null ? null : challengerApv - incumbentApv;
  const challengerWins = rows.filter((row) => row?.winner === "challenger").length;
  const incumbentWins = rows.filter((row) => row?.winner === "incumbent").length;
  const ties = rows.length - challengerWins - incumbentWins;
  const length = assessFastImprovementLength(incumbentWordCount, challengerWordCount);
  const blockers = [];
  if (rows.length !== FAST_IMPROVEMENT_PANEL_COUNT) blockers.push("three_complete_panels_required");
  if (incumbentApv == null || challengerApv == null) blockers.push("panel_apv_missing");
  if (!length.within_comparable_range) blockers.push("challenger_length_not_comparable");
  if (challengerWins < 2) blockers.push("challenger_did_not_win_two_of_three_panels");
  if (delta == null || delta < Number(minimumApvDelta)) blockers.push("aggregate_predicted_apv_gain_below_threshold");
  return {
    accepted: blockers.length === 0,
    blockers,
    ranking_metric: "predicted_average_percentage_viewed",
    panel_count: rows.length,
    challenger_panel_wins: challengerWins,
    incumbent_panel_wins: incumbentWins,
    tied_panels: ties,
    incumbent_predicted_apv: incumbentApv == null ? null : Number(incumbentApv.toFixed(2)),
    challenger_predicted_apv: challengerApv == null ? null : Number(challengerApv.toFixed(2)),
    predicted_apv_delta: delta == null ? null : Number(delta.toFixed(2)),
    minimum_apv_delta: Number(minimumApvDelta),
    length_comparability: length,
  };
}
