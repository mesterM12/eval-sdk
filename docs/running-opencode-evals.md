# Running OpenCode Eval Trials

This guide shows how to run a real eval suite using OpenCode for every coding-agent and evaluator-agent role.

## What The Example Tests

Example suite: `examples/opencode-skills-and-plugins/eval-suite.yaml`

The task asks OpenCode to implement `parseInventoryCsv(csv)` in `src/inventory.js`. The baseline prompt is intentionally minimal, while the skill/plugin scenario variants provide a stricter import contract. Hidden acceptance material checks behavior that is easy for agents to miss:

- quoted CSV fields containing commas and doubled quotes
- CRLF input
- blank-line and comment-line skipping
- exact header validation
- row length validation
- non-negative integer validation for `quantity` and `priceCents`
- tag trimming after pipe splitting

The trial matrix runs the same OpenCode model across three scenario variants:

- `baseline`: no extra runtime config.
- `test-skill`: agent-home overlay includes a real OpenCode skill at `.config/opencode/skills/inventory-contract/SKILL.md`.
- `audit-plugin`: agent-home overlay includes a real OpenCode plugin at `.config/opencode/plugins/inventory-contract-guard.js`.

The task is intentionally realistic enough to separate variants. Baseline usually passes only the simple core behavior. The skill variant should have the strongest result because the agent can load the complete inventory parser contract. The plugin variant should improve over baseline by blocking incomplete edits, but it can still fail if the agent satisfies the plugin's static guard while missing a semantic edge case.

The hidden tests and evaluator rubric are not copied into the eval trial worktree until post-trial scoring.

## Prerequisites

Install dependencies and build the CLI:

```bash
npm install
npm run build
```

Start Docker and provide OpenCode credentials:

```bash
export OPENCODE_API_KEY=your-key
```

The example uses `model: opencode/big-pickle`. Change the model in `examples/opencode-skills-and-plugins/eval-suite.yaml` if your OpenCode account uses a different model name.

## Build The Sandcastle Docker Image

The example includes a Sandcastle Docker scaffold at `examples/opencode-skills-and-plugins/starter/.sandcastle/`.

Build the image name used by eval trial worktrees:

```bash
(cd examples/opencode-skills-and-plugins/starter && npx sandcastle docker build-image --image-name sandcastle:repo)
```

Sandcastle looks for `sandcastle:repo` because eval trial worktrees are mounted from a directory named `repo`.

For a brand-new task starter that does not already have `.sandcastle/`, create it non-interactively first:

```bash
npx sandcastle init \
  --agent opencode \
  --model opencode/big-pickle \
  --sandbox docker \
  --template blank \
  --issue-tracker github-issues \
  --create-label false \
  --build-image false \
  --install-template-deps false \
  --image-name sandcastle:repo
```

## Validate The Suite

Run validation before spending model tokens:

```bash
node dist/cli.js validate -c examples/opencode-skills-and-plugins/eval-suite.yaml
```

Expected output:

```text
valid eval suite: 1 task(s), 1 agent(s), 3 scenario variant(s)
```

## Run The Eval Trials

Use an explicit results directory. Result directories are immutable; choose a fresh path for each run.

```bash
node dist/cli.js run \
  -c examples/opencode-skills-and-plugins/eval-suite.yaml \
  --results-dir "$(pwd)/examples/opencode-skills-and-plugins/.eval-agent/results/manual-run"
```

This expands to three eval trials:

- `opencode-big-pickle__inventory-parser__baseline__1`
- `opencode-big-pickle__inventory-parser__test-skill__1`
- `opencode-big-pickle__inventory-parser__audit-plugin__1`

Each eval trial writes artifacts under its own result directory, including:

- `prompt.md`: exact prompt snapshot the coding agent saw.
- `sandcastle.log`: Sandcastle coding-agent log.
- `diff.patch`: changes produced by the coding agent.
- `acceptance-output.json`: hidden deterministic acceptance output.
- `result.json`: full eval trial result with score, usage, cost, scoring, and worktree metadata.

Failed eval trials preserve their worktrees under `.eval-agent/worktrees/<eval-trial-id>/` for debugging. Successful eval trials clean up worktrees after artifacts are captured.

## Regenerate Reports

Reports can be regenerated without rerunning agents:

```bash
node dist/cli.js report --results-dir examples/opencode-skills-and-plugins/.eval-agent/results/manual-run
```

Report files:

- `report.json`: machine-readable summary.
- `report.md`: human-readable comparison table with eval scores, costs, failures, and baseline deltas.

## How Skills And Plugins Are Represented

Scenario variants use `agentHomeOverlay` to copy runtime config into the eval trial's isolated agent home before Sandcastle starts OpenCode.

The example overlays use real OpenCode config locations under the sandboxed agent home:

- `overlays/test-skill-home/.config/opencode/skills/inventory-contract/SKILL.md`
- `overlays/test-skill-home/.config/opencode/opencode.json`
- `overlays/audit-plugin-home/.config/opencode/plugins/inventory-contract-guard.js`
- `overlays/audit-plugin-home/.config/opencode/opencode.json`

The skill variant asks the agent to load `inventory-contract` with the native `skill` tool. The plugin variant uses `tool.execute.before` to reject incomplete edits to `src/inventory.js` and return contract feedback to the agent.

## Minimal Config Shape

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
      deterministicWeight: 0.8
      rubricWeight: 0.2
    acceptanceMaterial:
      hiddenDir: acceptance/hidden
      checks:
        - id: core-behavior
          command: node acceptance/hidden/core.test.mjs
        - id: csv-edge-cases
          command: node acceptance/hidden/csv-edge-cases.test.mjs
        - id: validation-behavior
          command: node acceptance/hidden/validation.test.mjs
      rubrics:
        - id: maintainability
          path: rubrics/maintainability.md

scenarioVariants:
  - id: baseline
  - id: test-skill
    prompt: prompts/scenarios/test-skill.md
    agentHomeOverlay: overlays/test-skill-home

matrix:
  runIndexes: [1]
```

## Troubleshooting

- `results run directory already exists`: choose a new `--results-dir`; result directories are immutable.
- `sandbox.provider must be docker`: only Docker is supported in the first release.
- `agent provider must be a Sandcastle built-in provider`: use one of `claude-code`, `pi`, `codex`, `opencode`, `cursor`, or `copilot`.
- Docker errors during `run`: verify Docker is running and the current user can run containers.
- OpenCode auth errors: verify `OPENCODE_API_KEY` is exported in the shell running the CLI.
