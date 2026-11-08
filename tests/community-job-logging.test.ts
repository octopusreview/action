import { expect, it, mock } from "bun:test";

it("keeps the polling capability out of logs while completing a community review", async () => {
  const jobId = "11111111-1111-4111-8111-111111111111";
  const logs: string[] = [];
  const secrets: string[] = [];
  const outputs: Record<string, string> = {};
  let polledJob = "";
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => { finish = resolve; });
  const originalTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) =>
    originalTimeout(handler, delay === 10_000 ? 0 : delay, ...args)) as typeof setTimeout;

  mock.module("@actions/core", () => ({
    getInput: (name: string) => name === "github-token" ? "synthetic-token" : "",
    info: (message: string) => logs.push(message),
    warning: (message: string) => logs.push(message),
    setFailed: (message: string) => { logs.push(message); finish(); },
    setSecret: (value: string) => secrets.push(value),
    setOutput: (name: string, value: string) => { outputs[name] = value; if (name === "summary") finish(); },
  }));
  mock.module("@actions/github", () => ({
    context: { eventName: "pull_request", repo: { owner: "synthetic", repo: "example" },
      payload: { pull_request: { number: 1, title: "synthetic", user: { login: "test" },
        head: { sha: "abc" }, base: { ref: "main" } } } },
    getOctokit: () => ({ rest: { pulls: { get: async () => ({ data: "synthetic diff" }) } } }),
  }));
  mock.module("../src/octopus-client", () => ({
    OctopusApiError: class extends Error {},
    requestReview: async () => ({ status: "queued", jobId, existing: true }),
    pollReview: async (_url: string, receivedJob: string) => {
      polledJob = receivedJob;
      return { status: "completed", summary: "synthetic review", findings: [], model: "fake", indexed: false };
    },
  }));
  mock.module("../src/post-review", () => ({ postReview: async () => ({ posted: 0, skipped: 0 }) }));
  mock.module("../src/summary-comment", () => ({ postOrUpdateSummaryComment: async () => {} }));

  try {
    await import("../src/index");
    await finished;
    expect(polledJob).toBe(jobId);
    expect(outputs.summary).toBe("synthetic review");
    expect(outputs["findings-count"]).toBe("0");
    expect(secrets).toContain(jobId);
    expect(logs.some((line) => line.includes(jobId))).toBe(false);
  } finally {
    globalThis.setTimeout = originalTimeout;
    mock.restore();
  }
});
