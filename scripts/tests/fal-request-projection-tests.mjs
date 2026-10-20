import test from "node:test";
import assert from "node:assert/strict";
import { FAL_REQUEST_PROJECTION_RATES, falAssignmentBoardSize, falProjectedAssignmentsUsd, falProjectedRequestUsd } from "../lib/fal-request-projection.mjs";

test("a 3840 page without the small board projects at least the measured $0.0262", () => {
  assert.ok(falProjectedRequestUsd({ imageSize: { width: 3840, height: 2160 }, boardSize: null }).usd >= 0.0262);
  assert.ok(falProjectedRequestUsd({ imageSize: { width: 3840, height: 2160 }, boardSize: { width: 1920, height: 1080 } }).usd >= 0.0262);
  assert.equal(falProjectedRequestUsd({ imageSize: { width: 3840, height: 2160 }, boardSize: { width: 1024, height: 576 } }).usd, 0.0196);
  assert.equal(falProjectedRequestUsd({}).usd, 0.0176);
  assert.throws(() => falProjectedRequestUsd({ imageSize: { width: 1024, height: 1024 } }), /No Fal projection rate/);
  for (const row of FAL_REQUEST_PROJECTION_RATES) assert.ok(["measured_mean", "assumed_not_lower"].includes(row.basis) && row.usd > 0);
});

test("assignments are priced per canvas and board, labelled as a projection", () => {
  const page = { image_id: "p1", image_size: { width: 3840, height: 2160 }, panel_page_template: "P4H", board_path: "/b.png" };
  const single = { image_id: "s1", board_path: "/b.png" };
  const textOnly = { image_id: "t1" };
  assert.deepEqual(falAssignmentBoardSize(page), { width: 1024, height: 576 });
  assert.deepEqual(falAssignmentBoardSize(single), { width: 1920, height: 1080 });
  assert.equal(falAssignmentBoardSize(textOnly), null);
  const projection = falProjectedAssignmentsUsd([page, single, textOnly]);
  assert.equal(projection.status, "projected");
  assert.equal(projection.estimate_only, true);
  assert.equal(projection.projected_usd, Number((0.0196 + 0.0187 + 0.0176).toFixed(4)));
  assert.deepEqual(projection.rows.map((row) => [row.canvas, row.board]), [["3840x2160", "1024x576"], ["1920x1080", "1920x1080"], ["1920x1080", "none"]]);
  // 179 dense pages with the small board stay above the flat allowance only when the board is missing.
  assert.ok(falProjectedAssignmentsUsd(Array.from({ length: 179 }, (_, i) => ({ image_id: String(i), image_size: { width: 3840, height: 2160 }, panel_page_template: "P5L" }))).projected_usd > 179 * 0.022);
});
