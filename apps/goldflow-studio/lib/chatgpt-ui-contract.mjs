const EFFORT_LABELS = Object.freeze({
  low: "Instant",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Pro",
});

export function chatGptEffortLabel(reasoningEffort) {
  const normalized = String(reasoningEffort ?? "medium").trim().toLowerCase();
  const label = EFFORT_LABELS[normalized];
  if (!label) throw new Error(`Unsupported ChatGPT Web reasoning effort: ${reasoningEffort}.`);
  return label;
}

export function chatGptUiContractForLlmJob(baseContract, job) {
  return {
    ...baseContract,
    effort_label: chatGptEffortLabel(job?.request?.reasoning_effort),
  };
}

export function chatGptEffortSliderIndex(label) {
  const index = ["Instant", "Medium", "High", "Extra High", "Pro"].indexOf(String(label));
  if (index < 0) throw new Error(`Unsupported visible ChatGPT effort label: ${label}.`);
  return index;
}
