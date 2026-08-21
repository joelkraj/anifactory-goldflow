#!/usr/bin/env node

import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readCodexCallMetadata, runCodexCli } from "../lib/codex-cli-runner.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-local-studio-errors-"));
const originalEnvironment = { ...process.env };
const responseFixtures = new Map([
  ["CHATGPT_STRING_ERROR", {
    status: 429,
    payload: { code: "rate_limited", error: "ChatGPT rate limit: wait before retrying." },
  }],
  ["CHATGPT_OBJECT_ERROR", {
    status: 503,
    payload: { code: "chatgpt_generation_error", error: { message: "ChatGPT worker transport failed." } },
  }],
  ["GEMINI_STRING_ERROR", {
    status: 429,
    payload: { code: "rate_limited", error: "Gemini rate limit: wait before retrying." },
  }],
  ["GEMINI_OBJECT_ERROR", {
    status: 503,
    payload: { code: "provider_transient_circuit_open", error: { message: "Gemini worker transport failed." } },
  }],
]);
let requestCount = 0;
const server = createServer((request, response) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    requestCount += 1;
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const prompt = String(body?.messages?.[0]?.content ?? "");
    const fixture = responseFixtures.get(prompt);
    assert.ok(fixture, `unexpected local Studio test prompt: ${prompt}`);
    response.statusCode = fixture.status;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(fixture.payload));
  });
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});

try {
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  process.env.ANIFACTORY_CHATGPT_WEB_URL = baseUrl;
  process.env.ANIFACTORY_CHATGPT_WEB_TOKEN = "test-chatgpt-token";
  process.env.ANIFACTORY_GEMINI_WEB_URL = baseUrl;
  process.env.ANIFACTORY_GEMINI_WEB_TOKEN = "test-gemini-token";

  const cases = [
    { provider: "chatgpt_web", prompt: "CHATGPT_STRING_ERROR", code: "rate_limited", message: "ChatGPT rate limit: wait before retrying." },
    { provider: "chatgpt_web", prompt: "CHATGPT_OBJECT_ERROR", code: "chatgpt_generation_error", message: "ChatGPT worker transport failed." },
    { provider: "gemini_web", prompt: "GEMINI_STRING_ERROR", code: "rate_limited", message: "Gemini rate limit: wait before retrying." },
    { provider: "gemini_web", prompt: "GEMINI_OBJECT_ERROR", code: "provider_transient_circuit_open", message: "Gemini worker transport failed." },
  ];
  for (const testCase of cases) {
    const outputPath = path.join(temporaryRoot, `${testCase.prompt.toLowerCase()}.txt`);
    await assert.rejects(() => runCodexCli({
      prompt: testCase.prompt,
      stageName: `local_${testCase.prompt.toLowerCase()}_test`,
      repoRoot,
      outputPath,
      provider: testCase.provider,
      reasoningEffort: "medium",
      timeoutMs: 5_000,
    }), (error) => {
      assert.equal(error.code, testCase.code);
      assert.match(error.message, new RegExp(testCase.message.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.doesNotMatch(error.message, /unknown error/);
      return true;
    });
    const metadata = await readCodexCallMetadata(outputPath);
    assert.equal(metadata.error_code, testCase.code);
    assert.match(metadata.error, new RegExp(testCase.message.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.equal(requestCount, cases.length);
} finally {
  process.env = { ...originalEnvironment };
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(temporaryRoot, { recursive: true, force: true });
}

console.log("codex CLI runner local Studio error tests passed");
