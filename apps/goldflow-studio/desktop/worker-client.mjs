const REFERENCE_ROUTE = /^\/v1\/worker\/image-reference\/[^/?]+\/[^/?]+\/\d+\?lease_token=[^&]+$/;

export class GoldflowWorkerClient {
  constructor({ serverUrl, workerToken = null } = {}) {
    this.serverUrl = String(serverUrl).replace(/\/+$/, "");
    this.workerToken = workerToken;
  }

  async request(route, { method = "GET", body = null, auth = true, binary = false } = {}) {
    const response = await fetch(`${this.serverUrl}${route}`, {
      method,
      headers: {
        ...(auth && this.workerToken ? { authorization: `Bearer ${this.workerToken}` } : {}),
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : null,
    });
    if (binary) {
      if (!response.ok) throw new Error(`Goldflow request ${route} failed with HTTP ${response.status}.`);
      return {
        bytes: Buffer.from(await response.arrayBuffer()),
        mimeType: response.headers.get("content-type")?.split(";", 1)[0]?.trim() || "application/octet-stream",
        disposition: response.headers.get("content-disposition"),
      };
    }
    const value = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
    if (!response.ok) throw new Error(value.error || `Goldflow request ${route} failed with HTTP ${response.status}.`);
    return value;
  }

  async pair(code, label) {
    const value = await this.request("/v1/pair", { method: "POST", body: { code, label }, auth: false });
    this.workerToken = value.token;
    return value;
  }

  lease(types, slot) {
    return this.request("/v1/worker/lease", { method: "POST", body: { types, slot } });
  }

  heartbeat(job, slot) {
    return this.request("/v1/worker/heartbeat", {
      method: "POST",
      body: {
        type: job.type,
        jobId: job.job_id,
        manifestId: job.manifest_id,
        assetId: job.asset_id,
        leaseToken: job.lease_token,
        slot,
      },
    });
  }

  complete(job, slot, result) {
    return this.request("/v1/worker/complete", {
      method: "POST",
      body: job.type === "image"
        ? {
            type: "image",
            manifestId: job.manifest_id,
            assetId: job.asset_id,
            leaseToken: job.lease_token,
            slot,
            downloadPath: result.downloadPath,
            sourceUrl: result.sourceUrl,
            conversationUrl: result.conversationUrl,
            uiContract: result.uiContract,
          }
        : {
            type: "llm",
            jobId: job.job_id,
            leaseToken: job.lease_token,
            slot,
            content: result.content,
            conversationUrl: result.conversationUrl,
            uiContract: result.uiContract,
          },
    });
  }

  fail(job, slot, error) {
    return this.request("/v1/worker/fail", {
      method: "POST",
      body: {
        type: job.type,
        jobId: job.job_id,
        manifestId: job.manifest_id,
        assetId: job.asset_id,
        leaseToken: job.lease_token,
        slot,
        code: error?.code ?? "browser_worker_failure",
        message: error?.message ?? String(error),
      },
    });
  }

  fetchReference(route) {
    if (!REFERENCE_ROUTE.test(String(route ?? ""))) throw new Error("Rejected an invalid Goldflow image-reference route.");
    return this.request(route, { binary: true });
  }
}

export function validReferenceRoute(route) {
  return REFERENCE_ROUTE.test(String(route ?? ""));
}
