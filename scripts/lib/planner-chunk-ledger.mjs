import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const writeQueues = new Map();

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function fileHash(filePath) {
  if (!filePath) return null;
  try {
    return sha256(await fs.readFile(filePath));
  } catch {
    return null;
  }
}

export function plannerChunkKey({ plannerStage, chunkId, inputHash }) {
  return sha256(`${plannerStage}\n${chunkId}\n${inputHash}`).slice(0, 24);
}

export function plannerChunkIdentityFindings(expectedIds = [], actualIds = []) {
  const expected = expectedIds.map(String);
  const actual = actualIds.map(String);
  const findings = [];
  if (actual.length !== expected.length) {
    findings.push({
      code: "planner_chunk_output_count_mismatch",
      expected_count: expected.length,
      actual_count: actual.length,
    });
  }
  if (expected.some((id, index) => actual[index] !== id)) {
    findings.push({
      code: "planner_chunk_identity_mismatch",
      expected_ids: expected,
      actual_ids: actual,
    });
  }
  return findings;
}

export async function recordPlannerChunkCheckpoint({
  episodeDir,
  plannerStage,
  chunkId,
  inputHash,
  expectedIds = [],
  status,
  attempt = 1,
  reused = false,
  outputPath = null,
  findings = [],
  metadata = {},
}) {
  const ledgerPath = path.join(episodeDir, "planner_chunk_ledger.json");
  const key = plannerChunkKey({ plannerStage, chunkId, inputHash });
  const previousQueue = writeQueues.get(ledgerPath) ?? Promise.resolve();
  const queued = previousQueue.then(async () => {
    const ledger = await readJson(ledgerPath, {
      schema: "goldflow_planner_chunk_ledger_v1",
      entries: {},
    });
    const prior = ledger.entries?.[key] ?? null;
    const entry = {
      planner_stage: plannerStage,
      chunk_id: chunkId,
      input_sha256: inputHash,
      expected_ids: expectedIds.map(String),
      status,
      attempt_count: Math.max(Number(prior?.attempt_count ?? 0), Number(attempt ?? 1)),
      reused_cached_output: Boolean(reused),
      output_path: outputPath,
      output_sha256: await fileHash(outputPath),
      findings,
      metadata,
      updated_at: new Date().toISOString(),
    };
    const entries = { ...(ledger.entries ?? {}), [key]: entry };
    const values = Object.values(entries);
    const next = {
      ...ledger,
      entries,
      summary: {
        entry_count: values.length,
        passed_count: values.filter((row) => row.status === "passed").length,
        failed_count: values.filter((row) => row.status === "failed").length,
        cached_reuse_count: values.filter((row) => row.reused_cached_output).length,
      },
      updated_at: new Date().toISOString(),
    };
    await fs.mkdir(path.dirname(ledgerPath), { recursive: true });
    const temporary = `${ledgerPath}.${process.pid}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    await fs.rename(temporary, ledgerPath);
    return entry;
  });
  writeQueues.set(ledgerPath, queued.catch(() => {}));
  return queued;
}

