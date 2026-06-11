# Coding Agent Eval CLI

TypeScript CLI for comparing coding agents against repeatable software tasks under controlled scenario variants.

Use it when you want to answer questions like:

- Does a skill, plugin, MCP server, permission rule, or project instruction actually improve coding-agent outcomes?
- How does one agent or model compare with another on the same task?
- Are improvements real across repeated eval trials, or just one lucky completion?
- What changed in each eval trial, what did hidden acceptance material report, and how much did the trial cost?

The CLI reads an `eval-suite.yaml`, expands it into a Trial Matrix, runs each Eval Trial through Sandcastle built-in coding agents in Docker or locally, introduces hidden Acceptance Material only during post-trial scoring, optionally asks an Evaluator Agent to score rubric docs, and writes JSON plus Markdown reports.

## Status

This project is a working evaluation harness, not a hosted service. It assumes you are comfortable running agent CLIs, managing provider credentials, and building Sandcastle Docker images for starter projects.

## Core Ideas

An **Eval Trial** is one isolated attempt by one agent on one task under one Scenario Variant and run index.

A **Trial Matrix** is every configured agent times every task times every Scenario Variant times every run index, with optional include and exclude overrides.

A **Scenario Variant** is a controlled change applied before the Eval Trial, such as adding a skill, plugin, repo overlay, agent-home overlay, or extra prompt. It must not include hidden Acceptance Material.

**Acceptance Material** is the material used to judge the Eval Trial. Hidden executable checks are copied in only after the coding agent finishes. Rubric docs are used by the Evaluator Agent.

An **Evaluator Agent** runs after deterministic checks and returns strict JSON rubric scores. It does not replace executable acceptance checks.

The final **Eval Score** combines deterministic check results with rubric scores using task-level weights.

## Requirements

- Node.js 20 or newer.
- Docker running locally when `sandbox.provider` is `docker`.
- A Sandcastle Docker image for each starter project when using Docker mode.
- Provider credentials for the coding agent and Evaluator Agent.
- The provider CLI installed in the Docker image for Docker mode, or installed on the host for local mode.

Supported Sandcastle built-in providers are `claude-code`, `pi`, `codex`, `opencode`, `cursor`, and `copilot`.

## Install

```bash
npm install
npm run build
```

Useful development commands:

```bash
npm test
npm run coverage
```

`npm test` builds the TypeScript project and runs the Vitest suite. `npm run coverage` runs Vitest coverage through `@vitest/coverage-v8`.

## Quickstart

Create a minimal suite:

```bash
mkdir my-eval-suite
cd my-eval-suite
node ../dist/cli.js init
```

Then replace the generated starter, prompt, hidden checks, rubrics, and provider config with your real eval materials.

Validate before spending model tokens:

```bash
node ../dist/cli.js validate -c eval-suite.yaml
```

Run Eval Trials into a fresh immutable results directory:

```bash
node ../dist/cli.js run -c eval-suite.yaml --results-dir .eval-agent/results/manual-run
```

Regenerate reports from existing artifacts:

```bash
node ../dist/cli.js report --results-dir .eval-agent/results/manual-run
```

If you are running from this repository root instead of from a suite directory, use `node dist/cli.js ...`.

## CLI Commands

`init` creates a minimal suite skeleton in the current directory.

```bash
node dist/cli.js init
```

`validate` checks config shape, references, safe relative paths, provider ids, env references, scoring weights, duplicate ids, and matrix selectors.

```bash
node dist/cli.js validate -c eval-suite.yaml
```

`run` validates the suite, expands the Trial Matrix, executes Eval Trials, runs scoring, writes artifacts, and generates reports. Use `--fail-fast` to stop scheduling later Eval Trials after the first failure.

```bash
node dist/cli.js run -c eval-suite.yaml --results-dir .eval-agent/results/manual-run
```

`report` rebuilds `report.json` and `report.md` from an existing results directory without rerunning agents or Acceptance Material.

```bash
node dist/cli.js report --results-dir .eval-agent/results/manual-run
```

## Suite Layout

A typical suite looks like this:

```text
my-eval-suite/
  eval-suite.yaml
  prompts/
    task.md
    evaluator.md
    scenarios/
      with-skill.md
  starter/
    .sandcastle/
      Dockerfile
    package.json
    src/
  acceptance/
    hidden/
      behavior.test.mjs
      edge-cases.test.mjs
  rubrics/
    maintainability.md
  overlays/
    skill-home/
      .config/opencode/skills/example-skill/SKILL.md
```

`starter/` is visible to the coding agent at the start of every Eval Trial.

`prompts/` contains visible task prompts and optional Scenario Variant prompts.

`acceptance/hidden/` contains hidden executable checks. These files are not copied into the Eval Trial worktree before the coding agent runs.

`rubrics/` contains Markdown docs for Evaluator Agent scoring.

`overlays/` contains Scenario Variant files. `repoOverlay` copies files into the trial repo. `agentHomeOverlay` copies files into the isolated agent home used by the provider.

## Minimal Config

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
    prompt: prompts/task.md
    starter: starter
    scoring:
      deterministicWeight: 0.9
      rubricWeight: 0.1
    acceptanceMaterial:
      hiddenDir: acceptance/hidden
      checks:
        - id: behavior
          command: node acceptance/hidden/behavior.test.mjs
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
    description: No extra runtime config.
  - id: with-skill
    description: Adds a provider-native skill.
    prompt: prompts/scenarios/with-skill.md
    agentHomeOverlay: overlays/skill-home

matrix:
  runIndexes: [1]
  baselineScenarioVariant: baseline
```

`sandbox.provider` must be `docker` or `local`.

`agents` defines coding agents. `provider` must be a supported Sandcastle built-in provider.

`evaluatorAgent` defines the post-trial Evaluator Agent. Its prompt is prepended to an auto-generated scoring prompt that includes deterministic results and rubric docs.

`tasks` define prompts, starter files, deterministic/rubric scoring weights, hidden checks, and rubrics.

`scenarioVariants` define controlled changes. Variants can append prompts and add repo or agent-home overlays.

`matrix.runIndexes` controls repeated Eval Trials. `matrix.include` can add concrete Eval Trials, and `matrix.exclude` can remove concrete Eval Trials.

## Docker Vs Local Sandbox Provider

Use `sandbox.provider: docker` when you want isolation. Docker mode mounts the prepared agent home at `/home/agent` and requires the provider CLI plus project dependencies inside the Sandcastle image.

Use `sandbox.provider: local` when the agent CLI authenticates through local login state that is hard to copy into Docker. Local mode uses Sandcastle `noSandbox()`, so coding agents and Evaluator Agents run on the host and can access host credentials/config. This trades away container isolation.

## Scoring

The Eval Score formula is:

```text
deterministicWeight * deterministicScore + rubricWeight * rubricScore
```

`deterministicScore` is the weighted average of hidden acceptance checks, where pass is `1` and fail or timeout is `0`.

`rubricScore` is the weighted average of Evaluator Agent criteria after normalizing each criterion to its configured scale.

Rubric contribution is counted only when all deterministic checks pass. If any deterministic check fails, the rubric contribution is `0` even if the Evaluator Agent returns high rubric scores.

## Results

Each Eval Trial writes a directory under `--results-dir`:

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

Start with `report.md` for the comparison table, baseline deltas, costs, failures, and scoring summaries.

Use `prompt.md` to confirm what the coding agent saw.

Use `diff.patch` to inspect the produced code change.

Use `acceptance-output.json` to debug hidden deterministic checks.

Use `evaluator-rationale.json` to debug rubric scoring or Evaluator Agent failures.

Successful Eval Trials delete their worktrees after artifacts are captured. Failed Eval Trials preserve worktrees under `.eval-agent/worktrees/<eval-trial-id>/` for debugging.

## Complete OpenCode Example

A runnable OpenCode suite is in `examples/opencode-skills-and-plugins`.

It runs one OpenCode coding agent across three Scenario Variants:

- `baseline`: no extra runtime config.
- `test-skill`: adds a real OpenCode skill at `~/.config/opencode/skills/inventory-contract/SKILL.md` inside the sandboxed agent home.
- `audit-plugin`: adds a real OpenCode plugin at `~/.config/opencode/plugins/inventory-contract-guard.js` inside the sandboxed agent home.

Run it:

```bash
export OPENCODE_API_KEY=your-key
npm run build
(cd examples/opencode-skills-and-plugins/starter && npx sandcastle docker build-image --image-name sandcastle:repo)
node dist/cli.js validate -c examples/opencode-skills-and-plugins/eval-suite.yaml
node dist/cli.js run -c examples/opencode-skills-and-plugins/eval-suite.yaml --results-dir "$(pwd)/examples/opencode-skills-and-plugins/.eval-agent/results/manual-run"
node dist/cli.js report --results-dir examples/opencode-skills-and-plugins/.eval-agent/results/manual-run
open examples/opencode-skills-and-plugins/.eval-agent/results/manual-run/report.md
```

See `docs/running-opencode-evals.md` for the full OpenCode walkthrough.

## Documentation

- `docs/using-coding-agent-eval-cli.md`: complete user guide, config reference, lifecycle explanation, Claude Code conversion guide, and troubleshooting.
- `docs/running-opencode-evals.md`: end-to-end OpenCode example with skills and plugins.
- `docs/architecture-module-map.md`: contributor-facing module map and ownership guide.
- `docs/adr/`: architecture decisions behind deterministic scoring, hidden Acceptance Material timing, and local sandbox support.
- `CONTEXT.md`: project terminology for agents and contributors.

## Troubleshooting

`results run directory already exists`: choose a new `--results-dir`. Result directories are immutable by design.

`sandbox.provider must be docker or local`: use `docker` for isolated container execution, or `local` for host execution with local CLI login state.

`agent provider must be a Sandcastle built-in provider`: use one of `claude-code`, `pi`, `codex`, `opencode`, `cursor`, or `copilot`.

Docker errors during `run`: verify Docker is running and rebuild `sandcastle:repo` from the starter directory.

Provider command not found: install the provider CLI in `starter/.sandcastle/Dockerfile` for Docker mode, or on the host for local mode.

Auth errors: export the API keys referenced by `env` for Docker mode, or verify the provider CLI is logged in for local mode.

Hidden tests visible to the coding agent: keep hidden files only under `acceptanceMaterial.hiddenDir`, not in `starter`, `repoOverlay`, or visible prompts.

No cost shown: provider usage may be unavailable, or no `pricing` entry matches the configured provider/model pair.
