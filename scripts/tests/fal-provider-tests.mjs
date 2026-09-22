import test from "node:test";
import assert from "node:assert/strict";
import { buildFalImageInput, FAL_ENDPOINTS, FAL_PRIMARY_PARAMS } from "../lib/fal-provider.mjs";

test("Fal text request locks low quality 1920x1080 PNG", () => {
  const request = buildFalImageInput({ prompt: "one frame" });
  assert.equal(request.endpoint, FAL_ENDPOINTS.primary_text);
  assert.deepEqual(request.input.image_size, { width: 1920, height: 1080 });
  assert.equal(request.input.quality, "low");
  assert.equal(request.input.output_format, "png");
  assert.deepEqual(request.input, { prompt: "one frame", ...structuredClone(FAL_PRIMARY_PARAMS) });
});

test("Fal edit request uses one positional board without persisting a URL", () => {
  const request = buildFalImageInput({ prompt: "one coherent shot", referenceUrls: ["https://v3.fal.media/files/board.png"] });
  assert.equal(request.endpoint, FAL_ENDPOINTS.primary_edit);
  assert.equal(request.reference_mode, "one_positional_collage");
  assert.deepEqual(request.input.image_urls, ["https://v3.fal.media/files/board.png"]);
  assert.equal(request.input.partial_images, 0);
});

test("Fal request rejects more than sixteen ordered references", () => {
  assert.throws(() => buildFalImageInput({ prompt: "x", referenceUrls: Array(17).fill("https://v3.fal.media/a.png") }), /sixteen/);
});
