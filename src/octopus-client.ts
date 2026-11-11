/**
 * Octopus API client for the GitHub Action.
 */

export interface Finding {
  severity: string;
  title: string;
  filePath: string;
  startLine: number;
  endLine: number;
  category: string;
  description: string;
  suggestion: string;
  confidence: string;
}

export interface ReviewResponseCompleted {
  status: "completed";
  findings: Finding[];
  summary: string;
  model: string;
  indexed: boolean;
  community: boolean;
  firstCommunityReview: boolean;
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
}

export interface ReviewResponseQueued {
  status: "queued";
  jobId: string;
  existing: boolean;
  community: true;
  message: string;
}

export type InitialReviewResponse = ReviewResponseCompleted | ReviewResponseQueued;

export interface ReviewRequest {
  owner: string;
  repo: string;
  prNumber: number;
  prTitle: string;
  prAuthor: string;
  headSha: string;
  baseBranch: string;
  diff: string;
  githubToken: string;
  forceReindex?: boolean;
  reindexThresholdHours?: number;
}

export async function requestReview(
  apiUrl: string,
  apiKey: string | undefined,
  params: ReviewRequest,
): Promise<InitialReviewResponse> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  const res = await fetch(`${apiUrl}/api/github-action/review`, {
    method: "POST",
    headers,
    body: JSON.stringify(params),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: "Unknown error" }));
    const message = (body as { error?: string }).error ?? `HTTP ${res.status}`;
    throw new OctopusApiError(message, res.status);
  }

  return res.json() as Promise<InitialReviewResponse>;
}

export interface TriggerResponse {
  status: "queued" | "deduped" | "skipped";
  jobId?: string;
  reason?: string;
}

/**
 * Trigger-only mode: tell the server to review this PR and post the result as the
 * Octopus bot account. Sends no diff and no token — the workflow grants no permissions.
 */
export async function triggerOssReview(
  apiUrl: string,
  params: { owner: string; repo: string; prNumber: number; headSha: string },
): Promise<TriggerResponse> {
  const res = await fetch(`${apiUrl}/api/oss-review`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: "Unknown error" }));
    const message = (body as { error?: string }).error ?? `HTTP ${res.status}`;
    throw new OctopusApiError(message, res.status);
  }

  return res.json() as Promise<TriggerResponse>;
}

export interface PollResponseInFlight {
  status: "indexing" | "reviewing";
  jobId: string;
  startedAt?: string | null;
  attempts?: number;
}

export interface PollResponseFailed {
  status: "failed";
  jobId: string;
  error: string;
}

export interface PollResponseExpired {
  status: "expired";
  error: string;
}

export type PollResponse =
  | ReviewResponseCompleted
  | PollResponseInFlight
  | PollResponseFailed
  | PollResponseExpired;

export async function pollReview(
  apiUrl: string,
  jobId: string,
  repoFullName: string,
): Promise<PollResponse> {
  const url = `${apiUrl}/api/github-action/review/${encodeURIComponent(jobId)}?repo=${encodeURIComponent(repoFullName)}`;
  const res = await fetch(url, { method: "GET" });

  if (res.status === 404) {
    throw new OctopusApiError("Job not found", 404);
  }
  if (res.status === 403) {
    throw new OctopusApiError("Repo mismatch on poll", 403);
  }
  if (res.status === 410) {
    return { status: "expired", error: "Job expired" };
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: "Unknown error" }));
    const message = (body as { error?: string }).error ?? `HTTP ${res.status}`;
    throw new OctopusApiError(message, res.status);
  }

  return res.json() as Promise<PollResponse>;
}

export class OctopusApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "OctopusApiError";
  }
}
