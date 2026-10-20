const EFFORT_LABELS = Object.freeze({
  low: "Instant",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Pro",
});

// Visible picker labels. `gpt-6-astra` -> "GPT-6" and `gpt-5.6-sol` -> "GPT-5.6 Sol" were read
// from the live picker in the Studio ChatGPT profile on 2026-10-20
// (docs/proofs/chatgpt_web_picker_probe_2026-10-20.json): those were the only two choices.
// "GPT-6 Sol" and "GPT-5.5" are historical labels kept for recorded receipts; neither was in
// that picker. No "GPT Sol 6.1" label exists in ChatGPT Web, so gpt-6.1-sol is CLI-only.
const MODEL_LABELS = Object.freeze({
  "gpt-6-astra": "GPT-6",
  "gpt-6-sol": "GPT-6 Sol",
  "gpt-5.6-sol": "GPT-5.6 Sol",
  "gpt-5.5": "GPT-5.5",
});

export function chatGptModelLabel(model) {
  const normalized = String(model ?? "gpt-6-sol").trim().toLowerCase();
  const label = MODEL_LABELS[normalized];
  if (!label) throw new Error(`Unsupported ChatGPT Web model: ${model}.`);
  return label;
}

export function chatGptEffortLabel(reasoningEffort) {
  const normalized = String(reasoningEffort ?? "medium").trim().toLowerCase();
  const label = EFFORT_LABELS[normalized];
  if (!label) throw new Error(`Unsupported ChatGPT Web reasoning effort: ${reasoningEffort}.`);
  return label;
}

export function chatGptUiContractForLlmJob(baseContract, job) {
  return {
    ...baseContract,
    model_label: chatGptModelLabel(job?.request?.model),
    effort_label: chatGptEffortLabel(job?.request?.reasoning_effort),
  };
}

export function chatGptEffortSliderIndex(label) {
  const index = ["Instant", "Medium", "High", "Extra High", "Pro"].indexOf(String(label));
  if (index < 0) throw new Error(`Unsupported visible ChatGPT effort label: ${label}.`);
  return index;
}
