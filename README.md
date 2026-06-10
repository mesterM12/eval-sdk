# Coding Agent Eval CLI

TypeScript CLI for comparing coding agents against repeatable software tasks under controlled scenario variants.

The CLI reads an `eval-suite.yaml`, expands a trial matrix, runs each eval trial through Sandcastle built-in coding agents in Docker or locally, introduces hidden acceptance material only during post-trial scoring, and writes JSON/Markdown reports.

## Install

```bash
npm install
npm run build
```

Runtime requirements for real eval trials:

- Node.js 20+
- Docker running locally when `sandbox.provider` is `docker`
- Credentials for the agent provider you configure, either API keys such as `OPENCODE_API_KEY` or local CLI login state when `sandbox.provider` is `local`

## Commands

```bash
node dist/cli.js init
node dist/cli.js validate -c eval-suite.yaml
node dist/cli.js run -c eval-suite.yaml --results-dir .eval-agent/results/manual-run
node dist/cli.js report --results-dir .eval-agent/results/manual-run
```

For the complete setup, input-file reference, config reference, Claude Code conversion guide, and end-to-end walkthrough, see `docs/using-coding-agent-eval-cli.md`.

## OpenCode Example

A complete OpenCode suite is in `examples/opencode-skills-and-plugins`.

It runs one OpenCode coding agent across three scenario variants:

- `baseline`: no extra runtime config.
- `test-skill`: adds a real OpenCode skill at `~/.config/opencode/skills/inventory-contract/SKILL.md` inside the sandboxed agent home.
- `audit-plugin`: adds a real OpenCode plugin at `~/.config/opencode/plugins/inventory-contract-guard.js` inside the sandboxed agent home.

The example is designed to show measurable differences: baseline sees only a minimal parser prompt, the skill variant can load the full inventory parser contract, and the plugin variant receives runtime feedback when edits miss contract markers.

Run it:

```bash
export OPENCODE_API_KEY=your-key
npm run build
(cd examples/opencode-skills-and-plugins/starter && npx sandcastle docker build-image --image-name sandcastle:repo)
node dist/cli.js validate -c examples/opencode-skills-and-plugins/eval-suite.yaml
node dist/cli.js run -c examples/opencode-skills-and-plugins/eval-suite.yaml --results-dir "$(pwd)/examples/opencode-skills-and-plugins/.eval-agent/results/manual-run"
node dist/cli.js report --results-dir examples/opencode-skills-and-plugins/.eval-agent/results/manual-run
```

Read the generated report:

```bash
open examples/opencode-skills-and-plugins/.eval-agent/results/manual-run/report.md
```

See `docs/running-opencode-evals.md` for the full walkthrough and config reference.

## Local Login Auth

Use `sandbox.provider: local` to run coding agents and evaluator agents on the host with Sandcastle `noSandbox()`. This lets Claude Code and OpenCode use local login credentials instead of API keys, at the cost of Docker isolation.
