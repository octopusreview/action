# Octopus Review GitHub Action

AI-powered, context-aware code review for your pull requests. Indexes your codebase, understands your patterns, and posts meaningful review comments — not just linting.

## Quick Start

### Open source projects (free, no signup)

```yaml
# .github/workflows/octopus.yml
name: Octopus Review
on:
  pull_request:
    types: [opened, synchronize]

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: octopusreview/action@v1
```

That's it. No account, no API key, no configuration. Your repo will be indexed on the first run and reviewed with full codebase context.

### Private repositories

Private repos need an Octopus API key:

1. Sign up at [octopus-review.ai](https://octopus-review.ai)
2. Go to **Settings > API Keys** and create a key
3. Add it as a repository secret named `OCTOPUS_API_KEY`

```yaml
name: Octopus Review
on:
  pull_request:
    types: [opened, synchronize]

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: octopusreview/action@v1
        with:
          octopus-api-key: ${{ secrets.OCTOPUS_API_KEY }}
```

## How It Works

1. A pull request is opened or updated
2. The action fetches the PR diff
3. Octopus indexes your repo (first run only, then cached for 24h)
4. Your diff is reviewed with full codebase context — Octopus understands your code patterns, not just the changed lines
5. Findings are posted as inline PR review comments with severity levels and suggested fixes

## What Makes This Different

Unlike basic linters or shallow AI reviews, Octopus:

- **Indexes your entire codebase** — understands your architecture, patterns, and conventions
- **Context-aware** — reviews changes in relation to existing code, not in isolation
- **Learns from feedback** — thumbs down a finding and it won't repeat the same mistake
- **Smart severity levels** — Critical, High, Medium, Low, and Suggestion — so you know what matters

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `octopus-api-key` | No | — | Octopus API key. Required for private repos. Optional for public repos (free community tier). |
| `github-token` | No | `${{ github.token }}` | GitHub token for posting reviews. Auto-provided by Actions. |
| `api-url` | No | `https://octopus-review.ai` | Octopus API base URL. |
| `force-reindex` | No | `false` | Force re-index the repository before reviewing. |
| `reindex-threshold-hours` | No | `24` | Re-index if the last index is older than this many hours. |

## Outputs

| Output | Description |
|--------|-------------|
| `findings-count` | Total number of findings. |
| `summary` | Review summary text. |

## Community vs Full Tier

| Feature | Community (free) | With API Key |
|---------|-----------------|--------------|
| Code review | Yes | Yes |
| Codebase indexing | Yes | Yes |
| Daily review limit | 5 per repo | Unlimited (within plan) |
| Knowledge base | — | Custom docs and rules |
| Custom config | — | Severity thresholds, categories |
| Review history | — | Full history and analytics |
| Feedback learning | — | Team-wide false positive suppression |

## Permissions

The action needs these GitHub token permissions:

- `contents: read` — to fetch the PR diff and index the repository
- `pull-requests: write` — to post review comments

For **private repos**, the `GITHUB_TOKEN` (automatically provided) already has access to the repository it runs in. The token is passed to Octopus for indexing only, is never stored, and expires when the workflow ends.

## Fork pull requests

GitHub makes `GITHUB_TOKEN` read-only for pull requests opened from forks when using the `pull_request` event. This is a deliberate security measure against untrusted forks, and it means Octopus cannot post its review on those PRs (reviews on branches within the same repository are unaffected).

To enable reviews on fork pull requests, switch the trigger to `pull_request_target`:

```yaml
# .github/workflows/octopus.yml
name: Octopus Review
on:
  pull_request_target:
    types: [opened, synchronize]

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: octopusreview/action@v1
```

The Octopus action only reads the PR diff through the GitHub API; it never checks out or runs the fork's code, so `pull_request_target` is safe here, as long as your workflow does not add a checkout step that builds the fork head.

For larger repositories that prefer not to grant a writable token in CI at all, install the [Octopus GitHub App](https://octopus-review.ai/open-source) instead. The App posts reviews with its own installation permissions, so fork token restrictions never apply.

## Examples

### Only review on specific paths

```yaml
on:
  pull_request:
    types: [opened, synchronize]
    paths:
      - "src/**"
      - "lib/**"
```

### Use outputs in subsequent steps

```yaml
steps:
  - uses: octopusreview/action@v1
    id: review
    with:
      octopus-api-key: ${{ secrets.OCTOPUS_API_KEY }}

  - if: steps.review.outputs.findings-count != '0'
    run: echo "Octopus found ${{ steps.review.outputs.findings-count }} issues"
```

## FAQ

**Does Octopus store my code?**
No. Your code is used temporarily for indexing (creating vector embeddings) and reviewing. Source code is never stored. Embeddings are cached for up to 24 hours to speed up subsequent reviews.

**How does the community tier work?**
Public repositories can use Octopus for free with no signup. A community organization is automatically created per GitHub owner (user or org). The daily review limit is 5 reviews per repository.

The updated Action masks community review job IDs in logs.

**Why are reviews not posted on pull requests from forks?**
GitHub makes `GITHUB_TOKEN` read-only for fork pull requests on the `pull_request` event, so the action cannot create review comments. Switch the trigger to `pull_request_target`, or install the Octopus GitHub App. See [Fork pull requests](#fork-pull-requests) above.

**What models does Octopus use?**
Octopus uses Claude (Anthropic) for code review and OpenAI for embeddings by default. Organizations with API keys can configure custom models.

**Can I configure what gets reviewed?**
With an API key, you can customize severity thresholds, disable specific finding categories, and add knowledge documents that guide the review.

## Links

- [Octopus Review](https://octopus-review.ai) — Dashboard, settings, and analytics
- [Documentation](https://octopus-review.ai/docs) — Full docs
- [Issues](https://github.com/octopusreview/action/issues) — Bug reports and feature requests
