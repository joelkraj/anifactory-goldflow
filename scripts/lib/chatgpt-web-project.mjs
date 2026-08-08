export const CHATGPT_WEB_PROJECT_CLEANUP_POLICY = "operator_delete_after_local_artifact_lock";

export function normalizeChatGptWebProjectUrl(value, { required = false } = {}) {
  if (value == null || String(value).trim() === "") {
    if (required) throw new Error("A ChatGPT project home URL is required.");
    return null;
  }
  let projectUrl;
  try {
    projectUrl = new URL(String(value));
  } catch {
    throw new Error("ChatGPT project URL must be an absolute ChatGPT project home URL.");
  }
  if (
    projectUrl.origin !== "https://chatgpt.com"
    || !/^\/g\/g-p-[A-Za-z0-9-]+\/project\/?$/.test(projectUrl.pathname)
  ) {
    throw new Error("ChatGPT project URL must use https://chatgpt.com/g/g-p-<id>/project.");
  }
  projectUrl.search = "";
  projectUrl.hash = "";
  return projectUrl.href;
}

export function chatGptWebConversationScope(value) {
  let url;
  try {
    url = new URL(String(value ?? ""));
  } catch {
    return "unknown";
  }
  if (url.origin !== "https://chatgpt.com") return "unknown";
  if (/^\/g\/g-p-[A-Za-z0-9-]+\/c\/[A-Za-z0-9-]+\/?$/.test(url.pathname)) return "project";
  if (/^\/c\/[A-Za-z0-9-]+\/?$/.test(url.pathname)) return "regular";
  if (url.pathname === "/" && url.searchParams.get("temporary-chat") === "true") return "temporary";
  return "unknown";
}
