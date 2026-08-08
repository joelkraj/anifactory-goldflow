import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const runtimeRoot = path.join(
  process.env.HOME || "/Users/joel",
  ".codex-chatgpt-web",
  "runtime",
);

export const CHATGPT_WEB_ARCHIVE_QUEUE_PATH = process.env.GOLDFLOW_CHATGPT_WEB_ARCHIVE_QUEUE
  || path.join(runtimeRoot, "goldflow-conversation-archive-queue.jsonl");

export async function queueChatGptWebConversationArchive({
  conversationUrl,
  workId,
  source = "goldflow_image",
}) {
  const url = String(conversationUrl ?? "").trim();
  if (!/^https:\/\/chatgpt\.com\/c\/[A-Za-z0-9-]+/.test(url)) {
    throw new Error(`ChatGPT conversation URL is not queueable: ${url || "missing URL"}`);
  }
  const queuedAt = new Date().toISOString();
  const record = {
    schema: "goldflow_chatgpt_web_archive_queue_v1",
    queue_id: createHash("sha256").update(url).digest("hex").slice(0, 20),
    conversation_url: url,
    work_id: String(workId ?? "goldflow"),
    source,
    queued_at: queuedAt,
  };
  await fs.mkdir(path.dirname(CHATGPT_WEB_ARCHIVE_QUEUE_PATH), { recursive: true });
  await fs.appendFile(CHATGPT_WEB_ARCHIVE_QUEUE_PATH, `${JSON.stringify(record)}\n`, "utf8");
  return { ...record, queue_path: CHATGPT_WEB_ARCHIVE_QUEUE_PATH };
}
