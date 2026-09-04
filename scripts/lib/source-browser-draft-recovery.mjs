import { promises as fs } from "node:fs";
import path from "node:path";
import { sha256Text } from "./source-manufacturer-contract.mjs";

export function validateRecoveredDraft({ manifest, receipt, text, prompt, model, effort }) {
  const job = manifest?.jobs?.[0];
  const artifact = receipt?.artifacts?.find((row) => row.kind === "text");
  if (manifest?.jobs?.length !== 1 || job.kind !== "llm" || job.prompt !== prompt
    || job.model !== model || job.effort !== effort) throw new Error("Recovery manifest does not match the exact requested draft.");
  if (receipt?.schema !== "goldflow_chatgpt_job_receipt_v1" || receipt.status !== "completed"
    || receipt.runId !== manifest.runId || receipt.jobId !== job.id || receipt.kind !== "llm"
    || receipt.model !== model || receipt.effort !== effort || receipt.promptSha256 !== sha256Text(prompt)) {
    throw new Error("Recovery receipt is not a completed exact-model, exact-prompt draft.");
  }
  if (!text.trim() || !artifact || artifact.sha256 !== sha256Text(text)
    || artifact.bytes !== Buffer.byteLength(text)) throw new Error("Recovery text does not match the immutable browser artifact.");
  return artifact;
}

// Only an explicitly named orphaned browser job can be adopted. Never resubmit it.
export async function recoverBrowserDraft({ manifestPath, outputPath, prompt, model, effort, stageName, timeoutMs }) {
  const manifestBytes = await fs.readFile(manifestPath);
  const manifest = JSON.parse(manifestBytes);
  const job = manifest.jobs?.[0];
  if (manifest.jobs?.length !== 1 || job?.prompt !== prompt || job.model !== model || job.effort !== effort) {
    throw new Error("Recovery manifest identity mismatch; no browser request was sent.");
  }
  const runDirectory = path.resolve(path.dirname(manifestPath), manifest.outputDir);
  const receiptPath = path.join(runDirectory, "receipts", `${job.id}.json`);
  const deadline = Date.now() + timeoutMs;
  let receipt;
  while (!receipt) {
    try { receipt = JSON.parse(await fs.readFile(receiptPath, "utf8")); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      if (Date.now() >= deadline) throw new Error(`Waiting for existing browser receipt timed out: ${receiptPath}`);
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
  }
  const artifact = receipt.artifacts?.find((row) => row.kind === "text");
  if (!artifact) throw new Error(`Existing browser job ended without draft text: ${receipt.status}`);
  const artifactPath = path.resolve(artifact.path);
  if (!artifactPath.startsWith(`${runDirectory}${path.sep}`)) throw new Error("Recovery artifact is outside its recorded job directory.");
  const text = await fs.readFile(artifactPath, "utf8");
  validateRecoveredDraft({ manifest, receipt, text, prompt, model, effort });
  const metadata = {
    schema: "goldflow_codex_call_metadata_v1", status: "passed",
    stage_name: stageName, provider: "chatgpt_web", transport: "goldflow_authenticated_browser_jobs",
    model, reasoning_effort: effort, prompt_sha256: sha256Text(prompt),
    output_path: outputPath, output_sha256: sha256Text(text),
    bridge_receipt_path: receiptPath, bridge_source_sha256: artifact.sha256,
    bridge_duration_ms: receipt.durationMs, response_normalization: "none",
    started_at: receipt.startedAt, completed_at: receipt.finishedAt,
    recovery: { method: "exact_browser_receipt_adoption", manifest_path: manifestPath,
      manifest_sha256: sha256Text(manifestBytes.toString("utf8")), receipt_sha256: sha256Text(await fs.readFile(receiptPath, "utf8")),
      adopted_at: new Date().toISOString(), new_creative_submissions: 0 },
  };
  await fs.writeFile(outputPath, text, { flag: "wx" });
  await fs.writeFile(`${outputPath}.meta.json`, `${JSON.stringify(metadata, null, 2)}\n`, { flag: "wx" });
  return metadata;
}
