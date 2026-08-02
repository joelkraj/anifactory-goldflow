import { createHash } from "node:crypto";

export const FACTUAL_EVIDENCE_LEDGER_SCHEMA = "goldflow_factual_evidence_ledger_v1";

function clean(value) {
  return String(value ?? "").trim();
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function validateFactualEvidenceLedger(ledger, { expectedProfileId = null } = {}) {
  const blockers = [];
  if (ledger?.schema !== FACTUAL_EVIDENCE_LEDGER_SCHEMA) blockers.push("invalid_schema");
  if (!clean(ledger?.content_profile)) blockers.push("missing_content_profile");
  if (expectedProfileId && clean(ledger?.content_profile) !== clean(expectedProfileId)) blockers.push("content_profile_mismatch");
  if (!clean(ledger?.title)) blockers.push("missing_title");
  if (!clean(ledger?.researched_at)) blockers.push("missing_researched_at");
  const claims = Array.isArray(ledger?.claims) ? ledger.claims : [];
  if (!claims.length) blockers.push("missing_claims");
  const claimIds = new Set();
  let sourceCount = 0;
  claims.forEach((claim, index) => {
    const prefix = `claim_${index + 1}`;
    const claimId = clean(claim?.claim_id);
    if (!claimId) blockers.push(`${prefix}_missing_claim_id`);
    else if (claimIds.has(claimId)) blockers.push(`${prefix}_duplicate_claim_id`);
    else claimIds.add(claimId);
    if (!clean(claim?.statement)) blockers.push(`${prefix}_missing_statement`);
    if (!clean(claim?.claim_type)) blockers.push(`${prefix}_missing_claim_type`);
    if (!clean(claim?.scope)) blockers.push(`${prefix}_missing_scope`);
    const sources = Array.isArray(claim?.sources) ? claim.sources : [];
    if (!sources.length) blockers.push(`${prefix}_missing_sources`);
    sources.forEach((source, sourceIndex) => {
      sourceCount += 1;
      const sourcePrefix = `${prefix}_source_${sourceIndex + 1}`;
      if (!clean(source?.url) || !/^https?:\/\//i.test(clean(source.url))) blockers.push(`${sourcePrefix}_invalid_url`);
      if (!clean(source?.title)) blockers.push(`${sourcePrefix}_missing_title`);
      if (!clean(source?.publisher)) blockers.push(`${sourcePrefix}_missing_publisher`);
      if (!clean(source?.source_type)) blockers.push(`${sourcePrefix}_missing_source_type`);
    });
  });
  return {
    done: blockers.length === 0,
    blockers,
    claim_count: claims.length,
    source_count: sourceCount,
  };
}

export function factualEvidenceBinding(ledger, bytes, ledgerPath, { expectedProfileId = null } = {}) {
  const validation = validateFactualEvidenceLedger(ledger, { expectedProfileId });
  if (!validation.done) {
    throw new Error(`Invalid factual evidence ledger ${ledgerPath}: ${validation.blockers.join(", ")}.`);
  }
  return {
    schema: FACTUAL_EVIDENCE_LEDGER_SCHEMA,
    path: ledgerPath,
    sha256: sha256(bytes),
    content_profile: ledger.content_profile,
    title: ledger.title,
    researched_at: ledger.researched_at,
    claim_count: validation.claim_count,
    source_count: validation.source_count,
  };
}
