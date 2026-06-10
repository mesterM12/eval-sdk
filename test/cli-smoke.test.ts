import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, "dist", "cli.js");

async function runCli(args: string[], cwd: string) {
  return execa(process.execPath, [cliPath, ...args], { cwd, reject: false });
}

async function makeTempDir() {
  return mkdtemp(path.join(tmpdir(), "coding-agent-eval-cli-"));
}

async function writeFixtureFile(cwd: string, relativePath: string, contents: string) {
  const filePath = path.join(cwd, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, contents, "utf8");
}

async function writeJsonFixture(cwd: string, relativePath: string, value: unknown) {
  await writeFixtureFile(cwd, relativePath, `${JSON.stringify(value, null, 2)}\n`);
}

describe("coding-agent-eval CLI", () => {
  it("shows glossary-based help for init, validate, run, and report", async () => {
    const cwd = await makeTempDir();

    const result = await runCli(["--help"], cwd);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("init");
    expect(result.stdout).toContain("validate");
    expect(result.stdout).toContain("run");
    expect(result.stdout).toContain("report");
    expect(result.stdout).toContain("eval trial");
    expect(result.stdout).toContain("trial matrix");
    expect(result.stdout).toContain("scenario variant");
    expect(result.stdout).toContain("acceptance material");
    expect(result.stdout).toContain("evaluator agent");
    expect(result.stdout).toContain("eval score");
  });

  it("initializes a minimal eval suite that validate accepts", async () => {
    const cwd = await makeTempDir();

    const init = await runCli(["init"], cwd);

    expect(init.exitCode).toBe(0);
    await expect(stat(path.join(cwd, "eval-suite.yaml"))).resolves.toBeTruthy();
    await expect(stat(path.join(cwd, "prompts", "task.md"))).resolves.toBeTruthy();
    await expect(stat(path.join(cwd, "starter", "README.md"))).resolves.toBeTruthy();
    await expect(stat(path.join(cwd, "acceptance", "hidden", "smoke.test.js"))).resolves.toBeTruthy();
    await expect(stat(path.join(cwd, "rubrics", "maintainability.md"))).resolves.toBeTruthy();

    const config = await readFile(path.join(cwd, "eval-suite.yaml"), "utf8");
    expect(config).toContain("scenarioVariants:");
    expect(config).toContain("acceptanceMaterial:");
    expect(config).toContain("evaluatorAgent:");

    const validate = await runCli(["validate"], cwd);

    expect(validate.exitCode).toBe(0);
    expect(validate.stdout).toContain("valid eval suite");
  });

  it("validates a first-release eval suite schema at the command seam", async () => {
    const cwd = await makeTempDir();
    await writeFixtureFile(cwd, "prompts/task.md", "# Task\n");
    await writeFixtureFile(cwd, "prompts/report.md", "# Report\n");
    await writeFixtureFile(cwd, "starter/README.md", "# Starter\n");
    await writeFixtureFile(cwd, "overlays/repo/README.md", "# Overlay\n");
    await writeFixtureFile(cwd, "overlays/home/config.json", "{}\n");
    await writeFixtureFile(cwd, "acceptance/hidden/smoke.test.js", "console.log('ok')\n");
    await writeFixtureFile(cwd, "rubrics/maintainability.md", "# Maintainability\n");
    await writeFixtureFile(
      cwd,
      "eval-suite.yaml",
      `sandbox:
  provider: docker
agents:
  - id: claude
    provider: claude-code
    model: claude-opus-4-7
    env:
      ANTHROPIC_API_KEY: env:ANTHROPIC_API_KEY
evaluatorAgent:
  id: evaluator
  provider: opencode
  model: opencode/big-pickle
  prompt: prompts/report.md
tasks:
  - id: hello
    prompt: prompts/task.md
    starter: starter
    scoring:
      deterministicWeight: 0.7
      rubricWeight: 0.3
    acceptanceMaterial:
      hiddenDir: acceptance/hidden
      checks:
        - id: smoke
          command: npm test
          cwd: .
          timeoutMs: 30000
          weight: 1
          env:
            API_KEY: env:API_KEY
          artifacts:
            - reports/*.xml
      rubrics:
        - id: maintainability
          path: rubrics/maintainability.md
          weight: 1
          scale:
            min: 1
            max: 5
scenarioVariants:
  - id: baseline
    description: Baseline scenario variant.
  - id: with-overlay
    prompt: prompts/task.md
    repoOverlay: overlays/repo
    agentHomeOverlay: overlays/home
matrix:
  runIndexes: [1, 2]
  baselineScenarioVariant: baseline
  include:
    - agent: claude
      task: hello
      scenarioVariant: with-overlay
      runIndex: 3
  exclude:
    - agent: claude
      task: hello
      scenarioVariant: baseline
      runIndex: 2
pricing:
  - id: claude-opus
    provider: claude-code
    model: claude-opus-4-7
    inputPerMillion: 15
    outputPerMillion: 75
report:
  prompt: prompts/report.md
`
    );

    const validate = await runCli(["validate"], cwd);

    expect(validate.exitCode).toBe(0);
    expect(validate.stdout).toContain("valid eval suite: 1 task(s), 1 agent(s), 2 scenario variant(s)");
  });

  it("rejects invalid schema, references, providers, selectors, weights, and env values", async () => {
    const cwd = await makeTempDir();
    await writeFixtureFile(cwd, "prompts/task.md", "# Task\n");
    await writeFixtureFile(cwd, "starter/README.md", "# Starter\n");
    await writeFixtureFile(cwd, "acceptance/hidden/smoke.test.js", "console.log('ok')\n");
    await writeFixtureFile(cwd, "rubrics/maintainability.md", "# Maintainability\n");
    await writeFixtureFile(
      cwd,
      "eval-suite.yaml",
      `sandbox:
  provider: host
agents:
  - id: dup
    provider: custom-agent
    env:
      API_KEY: literal-not-env-ref
  - id: dup
    provider: claude-code
evaluatorAgent:
  id: evaluator
  provider: unsupported-evaluator
  prompt: prompts/missing-report.md
tasks:
  - id: task
    prompt: prompts/missing-task.md
    starter: missing-starter
    scoring:
      deterministicWeight: 0.8
      rubricWeight: 0.8
    acceptanceMaterial:
      hiddenDir: missing-hidden
      checks:
        - id: duplicate-check
          command: ""
          cwd: /tmp
          timeoutMs: 0
          weight: -1
          artifacts:
            - ""
        - id: duplicate-check
          command: npm test
      rubrics:
        - id: duplicate-rubric
          path: rubrics/missing.md
          weight: 0
          scale:
            min: 5
            max: 1
        - id: duplicate-rubric
          path: rubrics/missing-again.md
          weight: 1
  - id: task
    prompt: prompts/task.md
    starter: starter
    scoring:
      deterministicWeight: 1
      rubricWeight: 0
    acceptanceMaterial:
      hiddenDir: acceptance/hidden
      checks:
        - id: smoke
          command: npm test
      rubrics:
        - id: maintainability
          path: rubrics/maintainability.md
          weight: 1
scenarioVariants:
  - id: baseline
  - id: baseline
    repoOverlay: missing-overlay
matrix:
  runIndexes: [1, 1, 0]
  baselineScenarioVariant: missing-baseline
  include:
    - agent: missing-agent
      task: task
      scenarioVariant: baseline
      runIndex: 1
  exclude:
    - agent: dup
      task: missing-task
      scenarioVariant: baseline
      runIndex: 99
pricing:
  - id: duplicate-price
    provider: claude-code
    model: claude-opus-4-7
    inputPerMillion: 1
    outputPerMillion: 1
  - id: duplicate-price
    provider: missing-provider
    model: missing-model
    inputPerMillion: -1
    outputPerMillion: 0
report:
  prompt: prompts/missing-report.md
`
    );

    const validate = await runCli(["validate"], cwd);

    expect(validate.exitCode).toBe(1);
    expect(validate.stderr).toContain("invalid eval suite:");
    expect(validate.stderr).toContain("sandbox.provider must be docker or local");
    expect(validate.stderr).toContain("duplicate agents id: dup");
    expect(validate.stderr).toContain("agent dup provider must be a Sandcastle built-in provider");
    expect(validate.stderr).toContain("agent dup env API_KEY must be an env var reference like env:API_KEY");
    expect(validate.stderr).toContain("evaluatorAgent provider must be a Sandcastle built-in provider");
    expect(validate.stderr).toContain("duplicate tasks id: task");
    expect(validate.stderr).toContain("task task prompt does not exist: prompts/missing-task.md");
    expect(validate.stderr).toContain("task task scoring deterministicWeight and rubricWeight must sum to 1");
    expect(validate.stderr).toContain("duplicate task task acceptance checks id: duplicate-check");
    expect(validate.stderr).toContain("task task check duplicate-check command is required");
    expect(validate.stderr).toContain("task task check duplicate-check cwd must be relative");
    expect(validate.stderr).toContain("task task check duplicate-check timeoutMs must be a positive integer");
    expect(validate.stderr).toContain("task task check duplicate-check artifacts must contain non-empty relative glob strings");
    expect(validate.stderr).toContain("duplicate task task rubric criteria id: duplicate-rubric");
    expect(validate.stderr).toContain("task task rubric duplicate-rubric scale min must be less than max");
    expect(validate.stderr).toContain("duplicate scenarioVariants id: baseline");
    expect(validate.stderr).toContain("matrix.runIndexes must contain positive unique integers");
    expect(validate.stderr).toContain("matrix.baselineScenarioVariant must reference a scenario variant id: missing-baseline");
    expect(validate.stderr).toContain("matrix.include[0].agent must reference an agent id: missing-agent");
    expect(validate.stderr).toContain("matrix.exclude[0].task must reference a task id: missing-task");
    expect(validate.stderr).toContain("matrix.exclude[0].runIndex must reference matrix.runIndexes: 99");
    expect(validate.stderr).toContain("duplicate pricing id: duplicate-price");
    expect(validate.stderr).toContain("pricing duplicate-price must match a configured agent or evaluator agent provider/model");
    expect(validate.stderr).toContain("report.prompt does not exist: prompts/missing-report.md");
  });

  it("regenerates deterministic JSON and Markdown reports from existing result artifacts", async () => {
    const cwd = await makeTempDir();
    const resultsDir = path.join(cwd, "results", "fixture-run");
    const config = {
      matrix: { baselineScenarioVariant: "baseline" },
    };
    const baseResult = {
      evalTrialId: "agent__task__baseline__1",
      status: "success",
      timings: { startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:05.000Z", durationMs: 5000 },
      scoring: { acceptanceChecks: [{ id: "smoke", exitCode: 0, timedOut: false, weight: 1, stdout: "pass\n", stderr: "" }], evaluatorAgent: { status: "success", result: { summary: "Baseline is solid.", criteria: [{ id: "quality", score: 4, rationale: "Good baseline." }] } } },
      evalScore: { value: 0.8 },
      usage: { agent: { provider: "opencode", model: "model-a", inputTokens: 10, cacheReadTokens: 2, cacheWriteTokens: 1, outputTokens: 5, unknown: { reasoningTokens: 3 } } },
      cost: { agent: { matchedPricingId: "opencode-price", estimatedUsd: 0.000042 } },
      worktree: { preserved: false, worktreePath: null, agentHomePath: null },
    };
    const skillsResult = {
      ...baseResult,
      evalTrialId: "agent__task__skills__1",
      evalScore: { value: 0.9 },
      scoring: { acceptanceChecks: [{ id: "smoke", exitCode: 0, timedOut: false, weight: 1, stdout: "pass\n", stderr: "" }], evaluatorAgent: { status: "success", result: { summary: "Skills improved the solution.", criteria: [{ id: "quality", score: 5, rationale: "Better structure." }] } } },
    };
    const missingBaselineResult = {
      ...baseResult,
      evalTrialId: "agent__other-task__skills__1",
      status: "failed",
      error: "post-trial scoring failed",
      evalScore: { value: 0.25 },
      cost: { agent: { status: "unavailable", reason: "matching pricing not configured" } },
      worktree: { preserved: true, worktreePath: "/tmp/failed-worktree", agentHomePath: "/tmp/failed-home" },
    };
    await writeJsonFixture(cwd, "results/fixture-run/agent__task__skills__1/config.json", config);
    await writeJsonFixture(cwd, "results/fixture-run/agent__task__skills__1/result.json", skillsResult);
    await writeJsonFixture(cwd, "results/fixture-run/agent__other-task__skills__1/config.json", config);
    await writeJsonFixture(cwd, "results/fixture-run/agent__other-task__skills__1/result.json", missingBaselineResult);
    await writeJsonFixture(cwd, "results/fixture-run/agent__task__baseline__1/config.json", config);
    await writeJsonFixture(cwd, "results/fixture-run/agent__task__baseline__1/result.json", baseResult);

    const report = await runCli(["report", "--results-dir", resultsDir], cwd);

    expect(report.exitCode).toBe(0);
    expect(report.stdout).toContain("generated reports for 3 eval trial(s)");
    const jsonReport = JSON.parse(await readFile(path.join(resultsDir, "report.json"), "utf8"));
    expect(jsonReport.trials.map((trial: { evalTrialId: string }) => trial.evalTrialId)).toEqual([
      "agent__other-task__skills__1",
      "agent__task__baseline__1",
      "agent__task__skills__1",
    ]);
    expect(jsonReport.trials[2].baselineDelta).toEqual({ status: "matched", baselineEvalTrialId: "agent__task__baseline__1", evalScoreDelta: 0.1 });
    expect(jsonReport.trials[0].baselineDelta).toEqual({ status: "missing", baselineScenarioVariant: "baseline", expectedEvalTrialId: "agent__other-task__baseline__1" });
    expect(jsonReport.trials[0]).toMatchObject({
      status: "failed",
      failure: "post-trial scoring failed",
      preservedWorktreePath: "/tmp/failed-worktree",
      evalScore: { value: 0.25 },
      cost: { agent: { status: "unavailable", reason: "matching pricing not configured" } },
    });
    const markdownReport = await readFile(path.join(resultsDir, "report.md"), "utf8");
    expect(markdownReport).toContain("# Eval Report");
    expect(markdownReport).toContain("| agent__task__skills__1 | success | 0.9 | +0.1 vs agent__task__baseline__1 | 13 | 5 | $0.000042 | 5000 |  |  |");
    expect(markdownReport).toContain("| agent__other-task__skills__1 | failed | 0.25 | missing baseline agent__other-task__baseline__1 | 13 | 5 | unavailable | 5000 | post-trial scoring failed | /tmp/failed-worktree |");
    expect(markdownReport).toContain("## Evaluator Agent Rationale");
    expect(markdownReport).toContain("- agent__task__skills__1: Skills improved the solution.");
  });

  it("implements run and report help", async () => {
    const cwd = await makeTempDir();

    const run = await runCli(["run", "--help"], cwd);
    const report = await runCli(["report", "--help"], cwd);

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("--fail-fast");
    expect(report.exitCode).toBe(0);
    expect(report.stdout).toContain("--results-dir");
  });
});
