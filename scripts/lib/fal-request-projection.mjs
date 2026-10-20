import { PAGE_REFERENCE_BOARD_SIZE, REFERENCE_BOARD_WIDTH, REFERENCE_BOARD_HEIGHT } from "./openart-reference-board.mjs";

// Projected Fal cost per request by output canvas and reference-board size.
// These are measured means from billed proofs, never provider quotes:
//   docs/proofs/fal_canvas_cost_comparison_v1.md  (1920 page $0.0187, 3840 page $0.0262, single $0.0176)
//   docs/proofs/reference_board_size_cost_test_v1.md (1024x576 board: -$0.0066 per page, 3840 page $0.0196)
// Unmeasured combinations take the nearest measured rate that is not lower.
export const FAL_REQUEST_PROJECTION_VERSION = "2026-10-20.1";
export const FAL_REQUEST_PROJECTION_RATES = Object.freeze([
  Object.freeze({ canvas: "1920x1080", board: "none", usd: 0.0176, basis: "measured_mean", source: "fal_canvas_cost_comparison_v1 (658 singles)" }),
  Object.freeze({ canvas: "1920x1080", board: "1920x1080", usd: 0.0187, basis: "measured_mean", source: "fal_canvas_cost_comparison_v1 (13 pages, $0.0182-0.0192)" }),
  Object.freeze({ canvas: "1920x1080", board: "1024x576", usd: 0.0187, basis: "assumed_not_lower", source: "no 1920-canvas small-board measurement; 1920-board rate kept" }),
  Object.freeze({ canvas: "2560x1440", board: "none", usd: 0.0262, basis: "assumed_not_lower", source: "no 2560 measurement; 3840 rate kept" }),
  Object.freeze({ canvas: "2560x1440", board: "1920x1080", usd: 0.0262, basis: "assumed_not_lower", source: "no 2560 measurement; 3840 rate kept" }),
  Object.freeze({ canvas: "2560x1440", board: "1024x576", usd: 0.0262, basis: "assumed_not_lower", source: "no 2560 measurement; 3840 full-board rate kept" }),
  Object.freeze({ canvas: "3840x2160", board: "none", usd: 0.0262, basis: "assumed_not_lower", source: "3840 full-board page rate; no text-only 3840 measurement" }),
  Object.freeze({ canvas: "3840x2160", board: "1920x1080", usd: 0.0262, basis: "measured_mean", source: "fal_canvas_cost_comparison_v1 (11 pages, $0.0254-0.0273)" }),
  Object.freeze({ canvas: "3840x2160", board: "1024x576", usd: 0.0196, basis: "measured_mean", source: "reference_board_size_cost_test_v1 (4 pages, $0.0188-0.0206)" }),
]);

const key = (size) => (size ? `${size.width}x${size.height}` : "none");

/** Projected USD for one request from its output size and reference-board size (null board = text-only). */
export function falProjectedRequestUsd({ imageSize = { width: 1920, height: 1080 }, boardSize = null } = {}) {
  const row = FAL_REQUEST_PROJECTION_RATES.find((rate) => rate.canvas === key(imageSize) && rate.board === key(boardSize));
  if (!row) throw new Error(`No Fal projection rate for canvas ${key(imageSize)} with board ${key(boardSize)}.`);
  return row;
}

/** Board size of a prepared assignment: the page board for page owners, the full board otherwise, none without references. */
export function falAssignmentBoardSize(assignment) {
  if (!assignment?.board_path) return null;
  return assignment.panel_page_template ? { ...PAGE_REFERENCE_BOARD_SIZE } : { width: REFERENCE_BOARD_WIDTH, height: REFERENCE_BOARD_HEIGHT };
}

/** Per-assignment projection rows and their total, labelled as a projection. */
export function falProjectedAssignmentsUsd(assignments) {
  const rows = assignments.map((assignment) => {
    const rate = falProjectedRequestUsd({ imageSize: assignment.image_size ?? { width: 1920, height: 1080 }, boardSize: falAssignmentBoardSize(assignment) });
    return { image_id: assignment.image_id, canvas: rate.canvas, board: rate.board, projected_usd: rate.usd, basis: rate.basis };
  });
  return { status: "projected", version: FAL_REQUEST_PROJECTION_VERSION, estimate_only: true, request_count: rows.length,
    projected_usd: Number(rows.reduce((sum, row) => sum + row.projected_usd, 0).toFixed(4)), rows };
}
