import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PIPELINE_STAGE_REGISTRY, PIPELINE_STAGE_REGISTRY_VERSION } from "../lib/pipeline-stage-registry.mjs";
import { mediaWorkflowForPreflight } from "../lib/media-workflows.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (relative) => readFileSync(path.join(repoRoot, relative), "utf8");
const root = read("AGENTS.md");
const generated = read("docs/pipelines/generated_visuals.md");
const manhwa = read("docs/pipelines/manhwa.md");
const documentary = read("docs/pipelines/documentary.md");
const movie = read("docs/pipelines/movie_tv.md");
const asset = read("docs/workflows/asset_afterlife_profile.md");
const pilotDesign = read("docs/designs/avatar_what_if_pilot_v1.md");
const pilotWorkflow = read("docs/workflows/avatar_pilot_workflow.md");
const sentryBrief = read("docs/briefs/sentry_doomsday_90s.md");

assert.ok(root.split("\n").length <= 120, "Root guidance should remain a concise shared router.");
assert.match(root, /manhwa_recap_v1/);
assert.match(root, /asset_afterlife_v1/);
assert.match(root, /movie_tv_commentary_v1/);
assert.match(root, /--content-profile/);
assert.match(root, /--media-workflow/);
assert.doesNotMatch(root, /GOLDFLOW_STAGE_REGISTRY:START/);
assert.doesNotMatch(root, /Titles must explain the concrete betrayal|Scene prompt bodies should carry concise anime/);
assert.match(root, /clean worktree/);
assert.match(root, /exact-ID/);
assert.match(root, /No deterministic creative rewriting/);
assert.match(root, /signed media URLs/);

for (const file of ["AGENTS.md", "docs/pipelines/generated_visuals.md", "docs/pipelines/manhwa.md", "docs/pipelines/documentary.md", "docs/pipelines/movie_tv.md", "docs/designs/avatar_what_if_pilot_v1.md", "docs/workflows/avatar_pilot_workflow.md", "docs/briefs/sentry_doomsday_90s.md"]) {
  for (const match of read(file).matchAll(/\]\(([^)]+\.md)(?:#[^)]*)?\)/g)) {
    if (/^https?:/.test(match[1])) continue;
    assert.ok(existsSync(path.resolve(repoRoot, path.dirname(file), match[1])), `${file}: broken guidance link ${match[1]}`);
  }
}
for (const file of ["docs/pipelines/generated_visuals.md", "docs/workflows/video_production_workflow.md"]) {
  const text = read(file);
  const block = text.split("<!-- GOLDFLOW_STAGE_REGISTRY:START -->")[1]?.split("<!-- GOLDFLOW_STAGE_REGISTRY:END -->")[0];
  assert.ok(block, `${file}: missing generated stage table`);
  assert.ok(block.includes(PIPELINE_STAGE_REGISTRY_VERSION));
  const ids = [...block.matchAll(/^\| \d+ \| `([^`]+)`/gm)].map((match) => match[1]);
  assert.deepEqual(ids, PIPELINE_STAGE_REGISTRY.map((row) => row.id));
}

assert.match(manhwa, /Joey/);
assert.match(manhwa, /\| Manhwa Recap/);
assert.match(manhwa, /source manufacture/);
assert.doesNotMatch(generated, /Titles must explain the concrete betrayal|Genuine K-drama\/manhwa style is a causal story requirement/);
assert.match(generated, /narration_subjective|subjective sample manifest/);
assert.match(generated, /exact sample accounting/);
assert.match(generated, /execution_events\.jsonl/);
assert.match(generated, /immutable/);
assert.match(generated, /no automatic cross-provider failover/i);
assert.match(documentary, /asset_afterlife_v1/);
assert.match(documentary, /proof/i);
assert.match(documentary, /evidence/i);
assert.match(documentary, /unsupported-packaging gate/);
assert.match(documentary, /Historical identities retain their existing validators/);
assert.match(generated, /stop at `upload_packaging`/);
assert.match(asset, /-3\.5 dB/);
assert.doesNotMatch(asset, /further `-2 dB`/);
assert.match(movie, /source_footage_v1/);
assert.match(movie, /blocked/i);
assert.match(movie, /subtitle/i);
assert.match(movie, /audio/i);
assert.match(movie, /avatar_what_if_pilot_v1\.md/);
assert.match(pilotDesign, /canonical Joel opening\/remaining synthesis implemented with separate listening gates/);
assert.match(pilotDesign, /arbitrary audio imports remain blocked/);
assert.match(pilotDesign, /exactly 90-second proof/);
assert.match(pilotDesign, /No full episode, publishing/);
assert.match(pilotDesign, /no effective per-unit instruction or native-speed channel/);
assert.match(pilotDesign, /15–20 second opening take/);
assert.match(pilotDesign, /automatic media generation.*remains unavailable/);
assert.match(pilotDesign, /two exact-hash raw opening units/);
assert.match(pilotDesign, /already-frozen remaining cohorts/);
assert.match(pilotDesign, /entire_proof_narration_listened_end_to_end/);
assert.match(pilotWorkflow, /`pilot_remaining_only`/);
assert.match(pilotWorkflow, /candidate does not complete a stage|pending candidate, not an accepted stage/);
assert.match(pilotWorkflow, /do not delete it or rerun synthesis/);
assert.match(pilotWorkflow, /without a second ASR run/);
assert.match(pilotWorkflow, /not a claim that real remaining audio has been generated or approved/);
assert.match(pilotDesign, /deliberate loops are allowed/);
assert.match(pilotDesign, /Keep source time and finished-video time separate/);
assert.match(pilotDesign, /No automatic provider|not authorize a three-provider bakeoff/);
assert.match(sentryBrief, /Only abilities demonstrated in the movie/);
assert.match(sentryBrief, /Void/);
assert.match(sentryBrief, /changed assumption/);
assert.match(sentryBrief, /Earlier permissions for other titles are not inherited/);
assert.throws(() => mediaWorkflowForPreflight({ contentProfile: "movie_tv_commentary_v1", mediaWorkflow: "source_footage_v1" }), /reserved|unavailable/);

console.log("Pipeline guidance routing, preservation anchors, links, and stage-table checks passed.");
