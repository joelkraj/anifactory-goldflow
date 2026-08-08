const config = window.GOLDFLOW_STUDIO_CONFIG;
const $ = (selector) => document.querySelector(selector);
let lastState = null;

function toast(message) {
  const element = $("#toast");
  element.textContent = message;
  element.classList.add("visible");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.remove("visible"), 3500);
}

async function api(path, { method = "GET", body = null } = {}) {
  const response = await fetch(`${config.apiBase}${path}`, {
    method,
    headers: { authorization: `Bearer ${config.adminToken}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : null,
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || `Request failed ${response.status}`);
  return value;
}

function short(value, length = 14) {
  const text = String(value ?? "");
  return text.length > length ? `${text.slice(0, length)}...` : text;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  })[character]);
}

function renderArtifacts(state) {
  const rows = [];
  for (const job of state.llm.jobs.slice(0, 12)) {
    const recovery = ["failed", "needs_triage"].includes(job.status)
      ? `<button class="mini-button" data-requeue="${escapeHtml(job.job_id)}">Requeue</button>`
      : escapeHtml(job.updated_at || "-");
    rows.push(`<tr><td>Planner</td><td><code>${escapeHtml(short(job.job_id))}</code><br>${escapeHtml(job.stage_name || "pipeline call")}</td><td><span class="state-pill">${escapeHtml(job.status)}</span></td><td>attempt ${Number(job.attempt_count || 0)}</td><td>${recovery}</td></tr>`);
  }
  for (const manifest of state.image_manifests) {
    const counts = manifest.counts || {};
    rows.push(`<tr><td>Images</td><td><code>${escapeHtml(manifest.manifest_id || "invalid")}</code><br>${escapeHtml(manifest.mode || "-")}</td><td><span class="state-pill">${escapeHtml(manifest.status)}</span></td><td>${Number(counts.completed || 0)}/${Number(manifest.item_count || 0)} complete</td><td>${Number(counts.leased || 0)} leased</td></tr>`);
  }
  $("#artifactRows").innerHTML = rows.length ? rows.join("") : '<tr><td colspan="5" class="empty">No durable jobs yet.</td></tr>';
}

function renderState(state) {
  lastState = state;
  const paused = state.runtime.paused;
  $("#serverState").textContent = paused ? "Dispatch paused" : "Controller online";
  $("#liveDot").className = `live-dot ${paused ? "paused" : "online"}`;
  $("#pauseButton").textContent = paused ? "Resume dispatch" : "Pause dispatch";
  $("#llmQueued").textContent = state.llm.counts.queued || 0;
  $("#llmActive").textContent = state.llm.counts.leased || 0;
  $("#workerCount").textContent = state.workers.length;
  $("#imagePending").textContent = state.image_manifests.reduce((sum, manifest) => sum + Number(manifest.counts?.pending || 0), 0);
  const route = state.config.route;
  $("#routeCommand").textContent = [
    `export ANIFACTORY_LLM_ROUTE=${route.ANIFACTORY_LLM_ROUTE}`,
    `export ANIFACTORY_CHATGPT_WEB_URL=${route.ANIFACTORY_CHATGPT_WEB_URL}`,
    "export ANIFACTORY_CHATGPT_WEB_TOKEN=<injected by Studio>",
    "node bin/goldflow.mjs run advance --episode-dir <episode-dir>",
  ].join("\n");
  renderArtifacts(state);
}

async function refresh() {
  try {
    renderState(await api("/dashboard/state"));
  } catch (error) {
    $("#serverState").textContent = "Controller offline";
    $("#liveDot").className = "live-dot";
    toast(error.message);
  }
}

async function guarded(action) {
  try {
    await action();
    await refresh();
  } catch (error) {
    toast(error.message);
  }
}

$("#pairingCode").textContent = config.pairingCode;
$("#planLabel").textContent = config.uiContract.account_plan;
$("#modelLabel").textContent = config.uiContract.model_label;
$("#effortLabel").textContent = config.uiContract.effort_label;

$("#refreshButton").addEventListener("click", refresh);
$("#pauseButton").addEventListener("click", () => guarded(async () => {
  await api("/dashboard/pause", { method: "POST", body: { paused: !lastState?.runtime?.paused } });
}));

$("#statusButton").addEventListener("click", () => guarded(async () => {
  const status = await api("/dashboard/run/status", { method: "POST", body: { episodeDir: $("#episodeDir").value } });
  $("#runStatus").textContent = JSON.stringify({ current_stage: status.current_stage, current_stage_state: status.current_stage_state, next_command_shape: status.next_command_shape, episode_dir: status.episode_dir }, null, 2);
}));

$("#previewButton").addEventListener("click", () => guarded(async () => {
  const preview = await api("/dashboard/run/advance", { method: "POST", body: { episodeDir: $("#episodeDir").value, execute: false, maxSteps: 1 } });
  $("#runStatus").textContent = JSON.stringify(preview, null, 2);
}));

$("#executeButton").addEventListener("click", () => guarded(async () => {
  if (!window.confirm("Run exactly the next automatic Goldflow stage for this episode? This may use planner, media, or render resources allowed by the locked production profile.")) return;
  const result = await api("/dashboard/run/advance", { method: "POST", body: { episodeDir: $("#episodeDir").value, execute: true, maxSteps: 1 } });
  $("#runStatus").textContent = JSON.stringify(result, null, 2);
}));

$("#manifestButton").addEventListener("click", () => guarded(async () => {
  const mode = $("#manifestMode").value;
  const result = await api("/dashboard/manifests/create", {
    method: "POST",
    body: {
      episodeDir: $("#episodeDir").value,
      mode,
      concurrency: Number($("#concurrency").value),
      imageIds: mode === "scene" ? $("#assetIds").value : "",
      referenceIds: mode === "reference" ? $("#assetIds").value : "",
    },
  });
  $("#manifestResult").textContent = `${result.created ? "Created" : "Reused"} ${result.manifest_id} with ${result.item_count} exact assets.`;
}));

$("#artifactRows").addEventListener("click", (event) => guarded(async () => {
  const button = event.target.closest("[data-requeue]");
  if (!button) return;
  const reason = window.prompt("Why is this exact failed or triaged planner call safe to submit again?");
  if (!reason?.trim()) return;
  await api("/dashboard/llm/requeue", { method: "POST", body: { jobId: button.dataset.requeue, reason: reason.trim() } });
}));

refresh();
setInterval(refresh, 3000);
