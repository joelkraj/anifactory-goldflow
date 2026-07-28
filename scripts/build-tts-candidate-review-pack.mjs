#!/usr/bin/env node

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

function parseFlags(parts) {
  const flags = {};
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (!part.startsWith("--")) continue;
    const key = part.slice(2);
    const value = parts[index + 1] && !parts[index + 1].startsWith("--")
      ? parts[++index]
      : "true";
    flags[key] = value;
  }
  return flags;
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} failed with code ${code}: ${stderr.slice(-3000)}`));
    });
  });
}

function timestamp(seconds) {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds - minutes * 60;
  return `${String(minutes).padStart(2, "0")}:${remainder.toFixed(1).padStart(4, "0")}`;
}

const flags = parseFlags(process.argv.slice(2));
const episodeDir = path.resolve(String(flags["episode-dir"] ?? ""));
const attempt = Number(flags.attempt ?? 2);
const provider = String(flags.provider ?? "kokoro_local");
const outputDir = path.resolve(String(
  flags["output-dir"] ?? path.join(episodeDir, "reports", "recovery", "tts-candidate-review"),
));
if (!episodeDir || episodeDir === path.parse(episodeDir).root) {
  throw new Error("--episode-dir must resolve to one exact episode directory.");
}

const qa = JSON.parse(await fs.readFile(path.join(episodeDir, "narration_tts_unit_qa_ep_01.json"), "utf8"));
const plan = JSON.parse(await fs.readFile(path.join(episodeDir, "narration_generation_plan.json"), "utf8"));
const planById = new Map((plan.units ?? []).map((unit) => [String(unit.unit_id), unit]));
const candidates = (qa.candidates ?? [])
  .filter((row) => row.provider === provider && Number(row.attempt) === attempt)
  .sort((left, right) => (
    Number(planById.get(left.unit_id)?.order_index ?? Number.MAX_SAFE_INTEGER)
    - Number(planById.get(right.unit_id)?.order_index ?? Number.MAX_SAFE_INTEGER)
  ));
if (!candidates.length) throw new Error(`No ${provider} attempt-${attempt} candidates found.`);

await fs.mkdir(outputDir, { recursive: true });
const silencePath = path.join(outputDir, "gap-500ms.wav");
await run("ffmpeg", [
  "-y", "-nostdin", "-v", "error",
  "-f", "lavfi", "-i", "anullsrc=r=24000:cl=mono",
  "-t", "0.5", "-c:a", "pcm_s16le", silencePath,
]);

const concatLines = [];
const reviewRows = [];
let cursor = 0;
for (const [index, candidate] of candidates.entries()) {
  const planUnit = planById.get(String(candidate.unit_id)) ?? {};
  concatLines.push(`file '${String(candidate.audio_path).replaceAll("'", "'\\''")}'`);
  if (index < candidates.length - 1) concatLines.push(`file '${silencePath.replaceAll("'", "'\\''")}'`);
  const duration = Number(candidate.duration_sec ?? 0);
  reviewRows.push({
    index: index + 1,
    start_sec: Number(cursor.toFixed(3)),
    end_sec: Number((cursor + duration).toFixed(3)),
    unit_id: candidate.unit_id,
    intended_text: planUnit.spoken_text ?? planUnit.source_text ?? "",
    recognized_text: candidate.qa?.transcript?.recognized_text ?? null,
    qa_status: candidate.qa?.status ?? null,
    blocker_codes: (candidate.qa?.findings ?? [])
      .filter((finding) => finding.severity === "blocker")
      .map((finding) => finding.code),
    warning_codes: (candidate.qa?.findings ?? [])
      .filter((finding) => finding.severity === "warning")
      .map((finding) => finding.code),
    audio_path: candidate.audio_path,
  });
  cursor += duration + (index < candidates.length - 1 ? 0.5 : 0);
}

const concatPath = path.join(outputDir, "concat.txt");
await fs.writeFile(concatPath, `${concatLines.join("\n")}\n`, "utf8");
const wavPath = path.join(outputDir, `${provider}-attempt-${attempt}-review.wav`);
const m4aPath = path.join(outputDir, `${provider}-attempt-${attempt}-review.m4a`);
await run("ffmpeg", [
  "-y", "-nostdin", "-v", "error",
  "-f", "concat", "-safe", "0", "-i", concatPath,
  "-ar", "24000", "-ac", "1", "-c:a", "pcm_s16le", wavPath,
]);
await run("ffmpeg", [
  "-y", "-nostdin", "-v", "error",
  "-i", wavPath, "-c:a", "aac", "-b:a", "192k", m4aPath,
]);

const report = {
  schema: "goldflow_tts_candidate_review_pack_v1",
  status: "passed",
  episode_dir: episodeDir,
  provider,
  attempt,
  candidate_count: reviewRows.length,
  duration_sec: Number(cursor.toFixed(3)),
  review_audio_path: m4aPath,
  lossless_review_audio_path: wavPath,
  units: reviewRows,
};
await fs.writeFile(path.join(outputDir, "review.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
const markdown = [
  `# ${provider} attempt ${attempt} review`,
  "",
  `Audio: ${m4aPath}`,
  "",
  ...reviewRows.flatMap((row) => [
    `## ${row.index}. ${timestamp(row.start_sec)}–${timestamp(row.end_sec)}`,
    "",
    `- Unit: \`${row.unit_id}\``,
    `- QA: ${row.qa_status}`,
    `- Blockers: ${row.blocker_codes.join(", ") || "none"}`,
    `- Warnings: ${row.warning_codes.join(", ") || "none"}`,
    `- Intended: ${row.intended_text}`,
    `- Whisper: ${row.recognized_text ?? "missing"}`,
    "",
  ]),
].join("\n");
await fs.writeFile(path.join(outputDir, "review.md"), `${markdown}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));
