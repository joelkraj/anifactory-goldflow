const $ = (selector) => document.querySelector(selector);
let settingsDirty = false;

function message(type, fields = {}) {
  return chrome.runtime.sendMessage({ type, ...fields }).then((response) => {
    if (!response?.ok) throw new Error(response?.error ?? "Extension request failed.");
    return response.value;
  });
}

function render(status) {
  const settings = status.settings;
  if (!settingsDirty) {
    $("#serverUrl").value = settings.serverUrl;
    $("#enabled").checked = settings.enabled;
    $("#concurrency").value = String(settings.concurrency);
    $("#llmType").checked = settings.types.includes("llm");
    $("#imageType").checked = settings.types.includes("image");
  }
  $("#pairState").textContent = settings.workerToken ? `Paired as ${settings.workerId}` : "Not paired";
  $("#activeJobs").innerHTML = status.activeJobs.length
    ? status.activeJobs.map((job) => `<article><strong>Slot ${job.slot + 1} / ${job.phase}</strong><code>${job.job.job_id}</code></article>`).join("")
    : "<p>No active jobs.</p>";
  $("#events").innerHTML = status.recentEvents.length
    ? status.recentEvents.map((entry) => `<article class="${entry.level}">${entry.at.slice(11,19)} ${entry.message}</article>`).join("")
    : "<p>Waiting for controller.</p>";
}

async function refresh() {
  try { render(await message("GOLDFLOW_GET_STATUS")); } catch (error) { $("#pairState").textContent = error.message; }
}

$("#pairButton").addEventListener("click", async () => {
  try {
    await message("GOLDFLOW_SAVE_SETTINGS", { settings: { serverUrl: $("#serverUrl").value } });
    await message("GOLDFLOW_PAIR", { code: $("#pairCode").value, label: `Chrome ${navigator.platform}` });
    $("#pairCode").value = "";
    settingsDirty = false;
    await refresh();
  } catch (error) { $("#pairState").textContent = error.message; }
});

$("#saveButton").addEventListener("click", async () => {
  try {
    const types = [$("#llmType").checked ? "llm" : null, $("#imageType").checked ? "image" : null].filter(Boolean);
    await message("GOLDFLOW_SAVE_SETTINGS", { settings: { serverUrl: $("#serverUrl").value, enabled: $("#enabled").checked, concurrency: Number($("#concurrency").value), types } });
    settingsDirty = false;
    await refresh();
  } catch (error) { $("#pairState").textContent = error.message; }
});

$("#studioButton").addEventListener("click", () => message("GOLDFLOW_OPEN_STUDIO").catch((error) => { $("#pairState").textContent = error.message; }));

for (const selector of ["#serverUrl", "#enabled", "#concurrency", "#llmType", "#imageType"]) {
  $(selector).addEventListener("input", () => { settingsDirty = true; });
  $(selector).addEventListener("change", () => { settingsDirty = true; });
}

refresh();
setInterval(refresh, 1200);
