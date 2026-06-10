# Using The Coding Agent Eval CLI

This guide documents the CLI workflow from installation through running a real eval suite with scenario variants, hidden acceptance material, skills, plugins, and reports.

The CLI compares coding agents against repeatable software tasks. It expands an `eval-suite.yaml` into a trial matrix, creates one git worktree per eval trial, runs a Sandcastle built-in coding agent in Docker or locally, introduces hidden acceptance material only during post-trial scoring, optionally asks an evaluator agent to score rubrics, and writes JSON and Markdown reports.

## Prerequisites

- Node.js 20 or newer.
- Docker running locally when `sandbox.provider` is `docker`.
- A Sandcastle Docker image for the starter project.
- Provider credentials for the coding agent and evaluator agent.
- The provider CLI installed in the Sandcastle Docker image when `sandbox.provider` is `docker`, or installed on the host when `sandbox.provider` is `local`.

Install and build the CLI:

```bash
npm install
npm run build
```

Run commands from the repository root unless the command explicitly uses a different working directory.

## CLI Commands

```bash
node dist/cli.js init
node dist/cli.js validate -c eval-suite.yaml
node dist/cli.js run -c eval-suite.yaml --results-dir .eval-agent/results/manual-run
node dist/cli.js report --results-dir .eval-agent/results/manual-run
```

`init` creates a minimal starter suite in the current directory:

- `eval-suite.yaml`
- `prompts/task.md`
- `starter/README.md`
- `acceptance/hidden/smoke.test.js`
- `rubrics/maintainability.md`

`validate` checks the YAML shape, required references, duplicate ids, relative paths, scoring weights, provider names, and matrix selectors before spending model tokens.

`run` validates the suite, expands the trial matrix, runs each eval trial, runs scoring, and generates reports. Result directories are immutable; use a fresh `--results-dir` for every run.

`report` regenerates `report.json` and `report.md` from an existing results directory without rerunning agents.

## Suite Directory Layout

A practical suite usually looks like this:

```text
my-eval-suite/
  eval-suite.yaml
  prompts/
    inventory-parser.md
    evaluator.md
    scenarios/
      test-skill.md
      audit-plugin.md
  starter/
    .sandcastle/
      Dockerfile
      main.ts
      prompt.md
    package.json
    src/
    test/
  acceptance/
    hidden/
      core.test.mjs
      csv-edge-cases.test.mjs
      validation.test.mjs
  rubrics/
    maintainability.md
  overlays/
    test-skill-home/
      .config/opencode/skills/inventory-contract/SKILL.md
      .config/opencode/opencode.json
    audit-plugin-home/
      .config/opencode/plugins/inventory-contract-guard.js
      .config/opencode/opencode.json
```

The working example at `examples/opencode-skills-and-plugins` follows this layout.

## Input Files

`eval-suite.yaml` is the suite manifest. It defines the sandbox provider, agents, evaluator agent, tasks, scenario variants, trial matrix, optional pricing, and optional report prompt.

Task prompts under `prompts/` are visible to the coding agent. A task prompt is the base instruction for the coding work.

Scenario prompts under `prompts/scenarios/` are appended to the task prompt for a specific scenario variant. Use them to tell the agent about scenario-specific runtime config, for example “load the `inventory-contract` skill”.

The `starter/` directory is copied into every eval trial worktree. It should contain only files visible to the coding agent at trial start. It must include `.sandcastle/` if you want to build a Sandcastle image from the starter.

`acceptance/hidden/` contains hidden acceptance material. The CLI does not copy it into the eval trial worktree before the coding agent runs. It is copied into a separate scoring sandbox only after the coding agent finishes.

`rubrics/` contains Markdown rubric docs for evaluator-agent scoring. Rubrics are not shown to the coding agent unless you separately include them in the visible prompt or overlays.

`overlays/` contains scenario-specific files. `repoOverlay` files are copied into the eval trial repo before the agent runs. `agentHomeOverlay` files are copied into the isolated agent home mounted at `/home/agent` inside Docker; local execution uses the host agent CLI and its normal host credential/config lookup instead.

## Config Reference

Minimal shape:

```yaml
sandbox:
  provider: docker

agents:
  - id: opencode-big-pickle
    provider: opencode
    model: opencode/big-pickle
    env:
      OPENCODE_API_KEY: env:OPENCODE_API_KEY

evaluatorAgent:
  id: opencode-evaluator
  provider: opencode
  model: opencode/big-pickle
  prompt: prompts/evaluator.md
  env:
    OPENCODE_API_KEY: env:OPENCODE_API_KEY

tasks:
  - id: inventory-parser
    prompt: prompts/inventory-parser.md
    starter: starter
    scoring:
      deterministicWeight: 0.9
      rubricWeight: 0.1
    acceptanceMaterial:
      hiddenDir: acceptance/hidden
      checks:
        - id: core-behavior
          command: node acceptance/hidden/core.test.mjs
          cwd: .
          timeoutMs: 30000
          weight: 1
      rubrics:
        - id: maintainability
          path: rubrics/maintainability.md
          weight: 1
          scale:
            min: 1
            max: 5

scenarioVariants:
  - id: baseline
  - id: test-skill
    prompt: prompts/scenarios/test-skill.md
    agentHomeOverlay: overlays/test-skill-home

matrix:
  runIndexes: [1]
  baselineScenarioVariant: baseline
```

`sandbox.provider` must be `docker` or `local`. `docker` runs coding agents and evaluator agents in Sandcastle Docker containers with the prepared agent home mounted at `/home/agent`. `local` runs coding agents and evaluator agents on the host with Sandcastle `noSandbox()`, which lets locally authenticated Claude Code and OpenCode/OpenAI CLIs use their existing login state but does not provide container isolation.

`agents` defines coding agents. Supported provider names are Sandcastle built-ins: `claude-code`, `pi`, `codex`, `opencode`, `cursor`, and `copilot`. `id` is used in eval trial ids. `model` is passed to the provider factory. `env` maps sandbox environment variable names to host environment variable references like `env:ANTHROPIC_API_KEY`; omit API-key env entries when using a locally logged-in CLI in `local` mode.

`evaluatorAgent` defines the post-trial evaluator agent. It uses the same provider names as coding agents. Its prompt is prepended to an auto-generated scoring prompt that includes deterministic results and rubric docs. The evaluator must return JSON; malformed evaluator output fails the eval trial.

`tasks` defines coding tasks. `prompt` and `starter` are visible materials. `scoring.deterministicWeight` and `scoring.rubricWeight` must be between `0` and `1` and must sum to `1`.

`acceptanceMaterial.hiddenDir` is copied into the scoring sandbox after the coding agent finishes. `checks` run shell commands in the scoring repo. A check passes when it exits `0` and does not time out. Check weights control the deterministic weighted average. `artifacts` can collect non-hidden files from the scoring repo for storage in `acceptance-output.json`.

`rubrics` defines qualitative acceptance material. Each rubric has an id, Markdown path, optional weight, and optional scoring scale. Rubric scores are normalized to `0..1` before aggregation.

`scenarioVariants` defines controlled variations. A variant can have a description, appended prompt, `repoOverlay`, and `agentHomeOverlay`. The CLI does not interpret overlay contents; it only copies them into the isolated repo or home directory.

`matrix.runIndexes` controls repeated eval trials. The full matrix is every agent times every task times every scenario variant times every run index. `matrix.exclude` removes concrete eval trials. `matrix.include` adds concrete eval trials and may use run indexes outside `matrix.runIndexes`.

`matrix.baselineScenarioVariant` marks which scenario variant should be used for baseline deltas in reports.

`pricing` is optional. A pricing entry must match a configured provider/model. If provider usage is available, costs are estimated from input, cache read, cache write, and output token prices per million tokens. Some providers may report usage as unavailable.

`report.prompt` is currently validated as a Markdown path but is not used by report generation.

## Eval Trial Lifecycle

For each expanded eval trial, the CLI:

1. Concatenates the task prompt and optional scenario prompt into `prompt.md`.
2. Creates `.eval-agent/worktrees/<eval-trial-id>/repo` and `.eval-agent/worktrees/<eval-trial-id>/agent-home`.
3. Copies `starter` into the repo worktree.
4. Copies `repoOverlay` into the repo worktree if configured.
5. Copies `agentHomeOverlay` into the isolated agent home if configured.
6. Initializes a git baseline commit if the starter is not already a git repo.
7. Runs the Sandcastle built-in provider through the configured sandbox provider. Docker mode mounts the isolated agent home at `/home/agent`; local mode runs on the host with local CLI credentials/config.
8. Captures Sandcastle logs, commits, and git diff.
9. Copies the completed repo into a scoring sandbox.
10. Copies hidden acceptance material into the scoring sandbox.
11. Runs deterministic acceptance checks.
12. Runs the evaluator agent against a read-only scoring context.
13. Aggregates the eval score.
14. Writes trial artifacts and updates reports.

Successful eval trials delete their worktrees after artifacts are captured. Failed eval trials preserve worktrees for debugging and report their paths.

## Eval Score

The eval score formula is:

```text
deterministicWeight * deterministicScore + rubricWeight * rubricScore
```

`deterministicScore` is the weighted average of acceptance checks, where pass is `1` and fail or timeout is `0`.

`rubricScore` is the weighted average of evaluator-agent criteria after normalizing each criterion to the rubric scale.

Rubric contribution is counted only when all deterministic checks pass. If any deterministic check fails, the rubric contribution is `0` even if the evaluator returns rubric scores.

## Artifacts

Each eval trial writes a directory under `--results-dir`:

```text
<results-dir>/
  report.json
  report.md
  <eval-trial-id>/
    acceptance-output.json
    artifact-manifest.json
    commits.json
    config.json
    cost.json
    diff.patch
    evaluator-rationale.json
    prompt.md
    result.json
    sandcastle.log
    timings.json
    usage.json
```

`prompt.md` is the exact prompt snapshot shown to the coding agent.

`sandcastle.log` is the coding-agent execution log.

`diff.patch` is the git diff from the baseline commit to the completed work.

`acceptance-output.json` contains deterministic acceptance check output, exit codes, timeouts, weights, redacted env names, and collected artifacts.

`evaluator-rationale.json` contains evaluator-agent rubric scoring or evaluator failure details.

`result.json` is the full eval trial result.

`report.json` is a machine-readable aggregate report.

`report.md` is a human-readable summary table with eval scores, baseline deltas, cost, failures, and acceptance/evaluator summaries.

## Real OpenCode Skill And Plugin Walkthrough

The repository includes a complete runnable example at `examples/opencode-skills-and-plugins`.

It evaluates `parseInventoryCsv(csv)` in `src/inventory.js` across three scenario variants:

- `baseline`: no extra runtime config.
- `test-skill`: overlays a real OpenCode skill into the sandboxed agent home.
- `audit-plugin`: overlays a real OpenCode plugin into the sandboxed agent home.

Set OpenCode credentials:

```bash
export OPENCODE_API_KEY=your-key
```

Build the CLI and the starter image:

```bash
npm run build
(cd examples/opencode-skills-and-plugins/starter && npx sandcastle docker build-image --image-name sandcastle:repo)
```

Validate the suite:

```bash
node dist/cli.js validate -c examples/opencode-skills-and-plugins/eval-suite.yaml
```

Run the eval trials with a fresh immutable results directory:

```bash
node dist/cli.js run \
  -c examples/opencode-skills-and-plugins/eval-suite.yaml \
  --results-dir "$(pwd)/examples/opencode-skills-and-plugins/.eval-agent/results/manual-run"
```

Regenerate reports if needed:

```bash
node dist/cli.js report --results-dir examples/opencode-skills-and-plugins/.eval-agent/results/manual-run
```

Open the report:

```bash
open examples/opencode-skills-and-plugins/.eval-agent/results/manual-run/report.md
```

The OpenCode skill lives at:

```text
examples/opencode-skills-and-plugins/overlays/test-skill-home/.config/opencode/skills/inventory-contract/SKILL.md
```

The skill scenario also includes:

```text
examples/opencode-skills-and-plugins/overlays/test-skill-home/.config/opencode/opencode.json
```

That file allows the `inventory-contract` skill for OpenCode:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "permission": {
    "skill": {
      "inventory-contract": "allow"
    }
  }
}
```

The OpenCode plugin lives at:

```text
examples/opencode-skills-and-plugins/overlays/audit-plugin-home/.config/opencode/plugins/inventory-contract-guard.js
```

The plugin registers a `tool.execute.before` hook and rejects incomplete edits to `src/inventory.js` with contract feedback.

## Using Claude Code Instead Of OpenCode

The CLI supports Claude Code through Sandcastle’s `claude-code` provider. To switch a suite from OpenCode to Claude Code, change the provider, model, credentials, scenario overlays, and Docker image.

### 1. Install Claude Code In The Docker Image

The example Dockerfile installs OpenCode:

```dockerfile
RUN npm install -g opencode-ai@latest
```

For Claude Code, install the Claude Code CLI instead:

```dockerfile
RUN npm install -g @anthropic-ai/claude-code@latest
```

The image must contain a `claude` executable because Sandcastle runs Claude Code with a command shaped like:

```text
claude --print --verbose --output-format stream-json --model <model> -p -
```

Rebuild the image after changing the Dockerfile:

```bash
(cd path/to/starter && npx sandcastle docker build-image --image-name sandcastle:repo)
```

### 2. Export Claude Credentials

Use a host environment variable and reference it from `eval-suite.yaml`:

```bash
export ANTHROPIC_API_KEY=your-key
```

The CLI forwards only variables explicitly referenced in `env`. It stores env names as `[env]` and redacts secret values from artifacts.

### 3. Change The Agent Config

Replace OpenCode agents with Claude Code agents:

```yaml
agents:
  - id: claude-sonnet
    provider: claude-code
    model: claude-sonnet-4-6
    env:
      ANTHROPIC_API_KEY: env:ANTHROPIC_API_KEY

evaluatorAgent:
  id: claude-evaluator
  provider: claude-code
  model: claude-sonnet-4-6
  prompt: prompts/evaluator.md
  env:
    ANTHROPIC_API_KEY: env:ANTHROPIC_API_KEY
```

Use whatever Claude Code model name your account and installed CLI support.

### 4. Convert OpenCode Home Overlays To Claude Code Home Overlays

`agentHomeOverlay` is provider-agnostic. The CLI copies its contents into the isolated agent home at `/home/agent`. For OpenCode, files go under `.config/opencode/`. For Claude Code, put Claude Code home files under `.claude/`.

A Claude Code skill overlay can look like this:

```text
overlays/claude-test-skill-home/
  .claude/
    skills/
      inventory-contract/
        SKILL.md
```

Example `SKILL.md`:

```markdown
---
name: inventory-contract
description: Implement the inventory CSV parser contract with quoted-field parsing and strict validation.
---

## Inventory Parser Contract

Implement `parseInventoryCsv(csv)` in `src/inventory.js` with quoted CSV parsing, CRLF support, comment and blank-line skipping, exact header validation, five fields per row, non-negative integer validation for `quantity` and `priceCents`, doubled quote unescaping, pipe-split trimmed tags, and `TypeError` for invalid input.
```

Then point the Claude scenario variant at the overlay:

```yaml
scenarioVariants:
  - id: baseline
    description: No extra Claude Code runtime config.
  - id: claude-test-skill
    description: Adds a Claude Code skill that exposes the inventory parser contract.
    prompt: prompts/scenarios/claude-test-skill.md
    agentHomeOverlay: overlays/claude-test-skill-home
```

Example scenario prompt:

```markdown
Use the `inventory-contract` skill before editing `src/inventory.js`.
```

Claude Code project-level guidance can also be represented with `repoOverlay` instead of `agentHomeOverlay`, for example:

```text
overlays/claude-project-guidance/
  CLAUDE.md
  .claude/
    settings.json
    commands/
      inventory-contract.md
```

Use `repoOverlay` when the files should live in the project repo. Use `agentHomeOverlay` when the files should live in the agent user’s home directory.

OpenCode plugins are OpenCode-specific JavaScript hooks and do not run in Claude Code. To evaluate Claude Code with plugin-like behavior, represent the provider’s real supported runtime mechanism as files in `repoOverlay` or `agentHomeOverlay`, for example Claude Code settings, commands, skills, MCP configuration, or project guidance. The eval CLI itself does not know what a plugin is; it only copies configured files and then runs the provider.

### 5. Run The Claude Code Eval

After updating the Dockerfile, config, and overlays:

```bash
npm run build
(cd path/to/starter && npx sandcastle docker build-image --image-name sandcastle:repo)
node dist/cli.js validate -c path/to/eval-suite.yaml
node dist/cli.js run -c path/to/eval-suite.yaml --results-dir "$(pwd)/path/to/.eval-agent/results/claude-manual-run"
node dist/cli.js report --results-dir path/to/.eval-agent/results/claude-manual-run
```

## Creating A New Eval Suite Step By Step

1. Create the suite skeleton:

```bash
mkdir my-eval-suite
cd my-eval-suite
node ../dist/cli.js init
```

2. Replace `starter/` with the visible starter project the coding agent should edit.

3. Add or update `starter/.sandcastle/Dockerfile` so the image has Node, git, project dependencies, and the provider CLI.

4. Build the Sandcastle image:

```bash
(cd starter && npx sandcastle docker build-image --image-name sandcastle:repo)
```

5. Write the task prompt in `prompts/task.md` or another Markdown file.

6. Write hidden deterministic tests under `acceptance/hidden/`.

7. Write rubric docs under `rubrics/` if you want evaluator-agent scoring.

8. Add scenario overlays under `overlays/` for skills, plugins, settings, MCP servers, permission rules, or repo guidance.

9. Update `eval-suite.yaml` with agents, evaluator agent, tasks, scenario variants, matrix, and pricing.

10. Export provider credentials referenced by `env`.

11. Validate the suite:

```bash
node ../dist/cli.js validate -c eval-suite.yaml
```

12. Run a single small matrix first, usually one task, one agent, one run index, and baseline plus one scenario variant.

13. Inspect `report.md`, `diff.patch`, `acceptance-output.json`, and preserved worktrees for failures.

14. Expand the matrix only after the suite separates variants in a useful way.

## Troubleshooting

`results run directory already exists`: choose a new `--results-dir`. Result directories are immutable by design.

`sandbox.provider must be docker or local`: use `docker` for isolated container execution, or `local` for host execution with local CLI login state.

`agent provider must be a Sandcastle built-in provider`: use `claude-code`, `pi`, `codex`, `opencode`, `cursor`, or `copilot`.

Docker errors during `run`: verify Docker is running and rebuild `sandcastle:repo` from the starter directory.

Provider command not found: in Docker mode, install the provider CLI in `starter/.sandcastle/Dockerfile` and rebuild the image; in local mode, install the provider CLI on the host.

OpenCode auth errors: in Docker mode, export `OPENCODE_API_KEY`; in local mode, verify the host OpenCode CLI is logged in to OpenAI.

Claude Code auth errors: in Docker mode, export `ANTHROPIC_API_KEY` and verify the Docker image has the `claude` CLI; in local mode, verify the host Claude Code CLI is logged in and the configured model name is accepted.

Hidden tests unexpectedly visible to the coding agent: ensure hidden files are only under `acceptanceMaterial.hiddenDir`, not inside `starter`, `repoOverlay`, or visible prompts.

Evaluator agent fails with JSON errors: make the evaluator prompt stricter, but keep in mind the CLI already appends an exact JSON-only instruction and validates the final output.

No cost shown: provider usage may be unavailable, or no `pricing` entry matches the provider/model pair.

Scenario variant has no effect: verify `agentHomeOverlay` or `repoOverlay` paths exist, validate the suite, inspect preserved failed worktrees, and read `prompt.md` to confirm the scenario prompt was appended.
