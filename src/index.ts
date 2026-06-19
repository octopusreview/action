import * as core from "@actions/core";
import * as github from "@actions/github";
import { requestReview, pollReview, triggerOssReview, OctopusApiError, type ReviewResponseCompleted } from "./octopus-client";
import { postReview } from "./post-review";
import { postOrUpdateSummaryComment } from "./summary-comment";
import { isPermissionError, warnReadOnlyToken } from "./errors";

const MAX_DIFF_SIZE = 500_000; // 500KB
const POLL_INTERVAL_MS = 10_000; // 10s
const POLL_TIMEOUT_MS = 5 * 60 * 1000; // 5 min

async function run(): Promise<void> {
  try {
    // ── Validate event ────────────────────────────────────────────────────

    const eventName = github.context.eventName;
    if (eventName !== "pull_request" && eventName !== "pull_request_target") {
      core.info(
        `Octopus Review only runs on pull_request events. Current event: ${eventName}. Skipping.`,
      );
      return;
    }

    const pr = github.context.payload.pull_request;
    if (!pr) {
      core.warning("No pull_request payload found. Skipping.");
      return;
    }

    // ── Read inputs ───────────────────────────────────────────────────────

    const apiKey = core.getInput("octopus-api-key") || undefined;
    const mode = (core.getInput("mode") || "full").toLowerCase();
    if (mode !== "full" && mode !== "trigger") {
      core.warning(`Unknown mode "${mode}"; expected "full" or "trigger". Falling back to "full".`);
    }
    // "trigger" mode posts no token and grants no permissions; the server reviews and
    // posts as the Octopus bot account. github-token is only needed in "full" mode.
    const githubToken = core.getInput("github-token", { required: mode !== "trigger" });
    const apiUrl = core.getInput("api-url") || "https://octopus-review.ai";
    const forceReindex = core.getInput("force-reindex") === "true";
    const reindexThresholdHours = parseInt(
      core.getInput("reindex-threshold-hours") || "24",
      10,
    );

    const { owner, repo } = github.context.repo;
    const prNumber = pr.number as number;
    const prTitle = (pr.title as string) || "";
    const prAuthor = (pr.user?.login as string) || "";
    const headSha = (pr.head?.sha as string) || "";
    const baseBranch = (pr.base?.ref as string) || "main";

    core.info(`Reviewing PR #${prNumber}: ${prTitle}`);
    if (!apiKey) {
      core.info("No octopus-api-key provided. Running in community mode (public repos only).");
    }

    // Heads-up for the common fork-PR pitfall: on the `pull_request` event GitHub
    // makes GITHUB_TOKEN read-only for forks, so posting will fail later. We warn
    // upfront so the cause is obvious even before the post attempt.
    const headRepoFullName = (pr.head?.repo?.full_name as string) || "";
    const isForkPr = headRepoFullName !== "" && headRepoFullName !== `${owner}/${repo}`;
    if (isForkPr && eventName === "pull_request") {
      core.info(
        "This pull request comes from a fork. GITHUB_TOKEN is read-only for fork PRs " +
          "on the `pull_request` event, so Octopus may be unable to post its review. " +
          "If comments do not appear, see " +
          "https://octopus-review.ai/docs/github-action#fork-pull-requests",
      );
    }

    // ── Trigger mode: notify the server and exit (no token, no posting) ────

    if (mode === "trigger") {
      core.info("Running in trigger mode: notifying Octopus to review and post as the bot account.");
      try {
        const result = await triggerOssReview(apiUrl, { owner, repo, prNumber, headSha });
        if (result.status === "skipped") {
          if (result.reason === "no-consent-file") {
            core.warning(
              "Octopus is not enabled for this repo. Add a `.github/octopus.yml` file to opt in. " +
                "See https://octopus-review.ai/docs/github-action#fork-pull-requests",
            );
          } else {
            core.info(`Octopus skipped this PR (${result.reason ?? "unknown"}).`);
          }
        } else {
          core.info(`Octopus review ${result.status}${result.jobId ? ` (job ${result.jobId})` : ""}.`);
        }
      } catch (err) {
        if (err instanceof OctopusApiError) {
          core.warning(`Octopus trigger failed (${err.status}): ${err.message}`);
        } else {
          core.warning(`Octopus trigger failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      // Set outputs so downstream steps that read them don't get empty strings.
      // The review is posted asynchronously by the server, so the count isn't known here.
      core.setOutput("findings-count", "0");
      core.setOutput("summary", "Octopus review triggered; posted asynchronously by the Octopus bot account.");
      return;
    }

    // ── Fetch PR diff ─────────────────────────────────────────────────────

    const octokit = github.getOctokit(githubToken);

    core.info("Fetching PR diff...");
    const diffResponse = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: prNumber,
      mediaType: { format: "diff" },
    });

    let diff = diffResponse.data as unknown as string;
    if (diff.length > MAX_DIFF_SIZE) {
      core.warning(
        `Diff is ${(diff.length / 1024).toFixed(0)}KB, truncating to ${MAX_DIFF_SIZE / 1024}KB.`,
      );
      diff = diff.slice(0, MAX_DIFF_SIZE);
    }

    if (!diff || diff.trim().length === 0) {
      core.info("Empty diff. Nothing to review.");
      core.setOutput("findings-count", "0");
      core.setOutput("summary", "No changes to review.");
      return;
    }

    // ── Call Octopus API ──────────────────────────────────────────────────

    core.info("Sending to Octopus for review...");
    const initial = await requestReview(apiUrl, apiKey, {
      owner,
      repo,
      prNumber,
      prTitle,
      prAuthor,
      headSha,
      baseBranch,
      diff,
      githubToken,
      forceReindex,
      reindexThresholdHours,
    });

    let result: ReviewResponseCompleted;

    if (initial.status === "queued") {
      core.info(
        `Repository indexing in background (jobId=${initial.jobId}${initial.existing ? ", existing job" : ""}). Polling for result...`,
      );

      // Show progress in the (single) Octopus summary comment — find-or-create.
      try {
        await postOrUpdateSummaryComment({
          octokit,
          owner,
          repo,
          prNumber,
          body:
            "> 🐙 **Octopus Review** — Repository hasn't been indexed yet.\n>\n" +
            "> Indexing in progress... will update this comment with the review when ready.",
        });
      } catch (err) {
        if (isPermissionError(err)) {
          warnReadOnlyToken(eventName);
        } else {
          core.warning(
            `Failed to post placeholder comment: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      const repoFullName = `${owner}/${repo}`;
      const polled = await pollUntilDone(apiUrl, initial.jobId, repoFullName);

      if (polled.kind === "timeout") {
        core.warning(
          `Polling timed out after ${POLL_TIMEOUT_MS / 1000}s — indexing is still running on the server. ` +
            `The review will be posted on the next push or workflow run once indexing completes.`,
        );
        await postOrUpdateSummaryComment({
          octokit,
          owner,
          repo,
          prNumber,
          body:
            "> 🐙 **Octopus Review** — Indexing is taking longer than expected.\n>\n" +
            "> Re-run this workflow (or push a new commit) once indexing finishes to get the review.",
        }).catch((err) =>
          core.warning(`Failed to update placeholder: ${err instanceof Error ? err.message : String(err)}`),
        );
        core.setOutput("findings-count", "0");
        core.setOutput("summary", "Indexing in progress; review pending.");
        return;
      }

      if (polled.kind === "failed") {
        core.setFailed(`Octopus review failed: ${polled.error}`);
        await postOrUpdateSummaryComment({
          octokit,
          owner,
          repo,
          prNumber,
          body: `> 🐙 **Octopus Review** — Review failed: ${polled.error}`,
        }).catch(() => {});
        return;
      }

      if (polled.kind === "expired") {
        core.warning("Octopus review job expired before completion.");
        return;
      }

      result = polled.result;
    } else {
      result = initial;
    }

    core.info(
      `Review complete: ${result.findings.length} findings (model: ${result.model}, indexed: ${result.indexed})`,
    );

    if (result.community) {
      core.info(
        "Running in community mode. Add octopus-api-key to unlock full features: knowledge base, custom rules, and review history.",
      );
    }

    // ── Post review ───────────────────────────────────────────────────────

    const summaryBody = buildSummaryBody(result);

    await postOrUpdateSummaryComment({
      octokit,
      owner,
      repo,
      prNumber,
      body: summaryBody,
    }).catch((err) => {
      if (isPermissionError(err)) {
        warnReadOnlyToken(eventName);
      } else {
        core.warning(
          `Failed to post Octopus summary comment: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });

    if (result.findings.length > 0) {
      try {
        const { posted, skipped } = await postReview({
          token: githubToken,
          owner,
          repo,
          prNumber,
          findings: result.findings,
          diff,
        });

        core.info(
          `Posted review: ${posted} inline comments, ${skipped} could not be mapped to diff lines.`,
        );
      } catch (err) {
        if (isPermissionError(err)) {
          warnReadOnlyToken(eventName);
        } else {
          throw err;
        }
      }
    } else {
      core.info("No findings — summary comment only.");
    }

    // ── Set outputs ───────────────────────────────────────────────────────

    core.setOutput("findings-count", String(result.findings.length));
    core.setOutput("summary", result.summary);
  } catch (error) {
    if (error instanceof OctopusApiError) {
      switch (error.status) {
        case 401:
          core.setFailed(
            `Authentication failed: ${error.message}. Check your octopus-api-key secret.`,
          );
          break;
        case 402:
          core.warning(`Octopus: ${error.message}`);
          break;
        case 413:
          core.warning(`Octopus: ${error.message}`);
          break;
        case 429:
          core.warning(`Octopus: ${error.message}`);
          break;
        default:
          core.setFailed(`Octopus API error (${error.status}): ${error.message}`);
      }
    } else {
      core.setFailed(`Unexpected error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

type PollOutcome =
  | { kind: "completed"; result: ReviewResponseCompleted }
  | { kind: "failed"; error: string }
  | { kind: "expired" }
  | { kind: "timeout" };

async function pollUntilDone(
  apiUrl: string,
  jobId: string,
  repoFullName: string,
): Promise<PollOutcome> {
  const start = Date.now();
  let lastStatus = "";

  while (Date.now() - start < POLL_TIMEOUT_MS) {
    await sleep(POLL_INTERVAL_MS);

    let polled;
    try {
      polled = await pollReview(apiUrl, jobId, repoFullName);
    } catch (err) {
      core.warning(
        `Poll failed (will retry): ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }

    if (polled.status !== lastStatus) {
      core.info(`Job ${jobId} status: ${polled.status}`);
      lastStatus = polled.status;
    }

    if (polled.status === "completed") {
      return { kind: "completed", result: polled };
    }
    if (polled.status === "failed") {
      return { kind: "failed", error: polled.error };
    }
    if (polled.status === "expired") {
      return { kind: "expired" };
    }
    // indexing | reviewing → keep polling
  }

  return { kind: "timeout" };
}

function buildSummaryBody(result: ReviewResponseCompleted): string {
  const lines: string[] = [];

  if (result.summary && result.summary.trim().length > 0) {
    lines.push(result.summary);
  } else {
    lines.push("No issues found. Looking good!");
  }

  lines.push("");
  lines.push("---");
  lines.push("*Reviewed by [Octopus](https://octopus-review.ai)*");

  if (result.community && result.firstCommunityReview) {
    lines.push("");
    lines.push(
      "*This review ran without an Octopus API key. " +
        "Add `octopus-api-key` to unlock your team's knowledge base, custom rules, and full review history. " +
        "[Learn more](https://octopus-review.ai/docs/github-action)*",
    );
  }

  return lines.join("\n");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

run();
