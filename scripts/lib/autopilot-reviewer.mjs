import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

// The built-in model reviewer for operator_or_agent gates. It runs through the
// existing planner runner (identity-locked planning provider) and must return
// strict JSON. Malformed output is a blocker, never a default approval.
export const AUTOPILOT_REVIEW_SCHEMA = "goldflow_autopilot_model_review_v1";

function sha(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

export function parseReviewerJson(content) {
  let text = String(content ?? "").trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) text = fenced[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("Model reviewer returned no JSON object.");
  return JSON.parse(text.slice(start, end + 1));
}

async function defaultExecutor({ prompt, images, outputPath, repoRoot, stageName }) {
  const { runCodexCli } = await import("./codex-cli-runner.mjs");
  const result = await runCodexCli({
    prompt, stageName, repoRoot, outputPath, verbosity: "low",
    extraArgs: ["--sandbox", "read-only", ...images.flatMap((image) => ["--image", image])],
  });
  return result.content;
}

/**
 * review({ task, prompt, images, validate }) → parsed verdict. The raw call is
 * kept under autopilot/reviews/ with the prompt hash for provenance.
 */
export function createModelReviewer({ episodeDir, repoRoot, executor = defaultExecutor }) {
  return async function review({ task, prompt, images = [], validate }) {
    const promptHash = sha(`${prompt}\n${images.join("\n")}`);
    const dir = path.join(episodeDir, "autopilot", "reviews");
    await fs.mkdir(dir, { recursive: true });
    const outputPath = path.join(dir, `${task}_${promptHash.slice(0, 16)}.txt`);
    const content = await executor({ prompt, images, outputPath, repoRoot, stageName: `autopilot_${task}` });
    const verdict = parseReviewerJson(content);
    const problems = validate ? validate(verdict) : [];
    if (problems.length) throw new Error(`Model reviewer output for ${task} is invalid: ${problems.join("; ")}`);
    await fs.writeFile(path.join(dir, `${task}_${promptHash.slice(0, 16)}.json`), `${JSON.stringify({
      schema: AUTOPILOT_REVIEW_SCHEMA, task, prompt_sha256: promptHash, images, verdict,
    }, null, 2)}\n`);
    return verdict;
  };
}

export const REVIEW_RULES = [
  "You are Goldflow's automated production reviewer. Judge only what is asked.",
  "Approve only when nothing material is wrong. A material defect is one a viewer would notice or that breaks the story contract.",
  "Never invent facts. Return exactly one JSON object and nothing else.",
].join("\n");
