import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { execa } from "execa";
import { describe, expect, it } from "vitest";
import { executeEvalTrials, type EvaluatorAgentExecutorInput, type SandcastleExecutorInput } from "../src/eval-trial-execution.js";
import { prepareEvalTrialWorktree, finalizeEvalTrialWorktree } from "../src/eval-trial-worktree.js";
import { expandTrialMatrix } from "../src/trial-matrix.js";
import { generateReports } from "../src/report.js";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, "dist", "cli.js");

async function runCli(args: string[], cwd: string) {
  return execa(process.execPath, [cliPath, ...args], { cwd, reject: false });
}

async function makeTempDir() {
  return mkdtemp(path.join(tmpdir(), "coding-agent-eval-complex-"));
}

async function writeFixtureFile(root: string, relativePath: string, contents: string) {
  const filePath = path.join(root, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, contents, "utf8");
}

async function writeJsonFixture(root: string, relativePath: string, value: unknown) {
  await writeFixtureFile(root, relativePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function exists(filePath: string) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

describe("complex integration — full lifecycle end-to-end", () => {
  it("runs init → validate → report CLI commands in a single temp directory", async () => {
    const cwd = await makeTempDir();

    const init = await runCli(["init"], cwd);
    expect(init.exitCode).toBe(0);

    const validate = await runCli(["validate"], cwd);
    expect(validate.exitCode).toBe(0);
    expect(validate.stdout).toContain("valid eval suite");

    const resultsDir = path.join(cwd, "results", "fixture-run");
    await mkdir(resultsDir, { recursive: true });
    const config = { matrix: { baselineScenarioVariant: "baseline" } };
    await writeJsonFixture(cwd, "results/fixture-run/agent__task__skills__1/config.json", config);
    await writeJsonFixture(cwd, "results/fixture-run/agent__task__skills__1/result.json", {
      evalTrialId: "agent__task__skills__1", status: "success",
      evalScore: { value: 0.9 }, worktree: { preserved: false, worktreePath: null, agentHomePath: null },
      scoring: { acceptanceChecks: [{ id: "smoke", exitCode: 0, timedOut: false, weight: 1, stdout: "pass\n", stderr: "" }] },
      timings: { startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:05.000Z", durationMs: 5000 },
      usage: { agent: { inputTokens: 10, outputTokens: 5 } },
      cost: { agent: { status: "unavailable" } },
    });
    await writeJsonFixture(cwd, "results/fixture-run/agent__task__baseline__1/config.json", config);
    await writeJsonFixture(cwd, "results/fixture-run/agent__task__baseline__1/result.json", {
      evalTrialId: "agent__task__baseline__1", status: "success",
      evalScore: { value: 0.8 }, worktree: { preserved: false },
      scoring: { acceptanceChecks: [{ id: "smoke", exitCode: 0, timedOut: false, weight: 1 }] },
      timings: { startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:05.000Z", durationMs: 5000 },
      usage: { agent: { inputTokens: 10, outputTokens: 5 } },
      cost: { agent: { status: "unavailable" } },
    });

    const report = await runCli(["report", "--results-dir", resultsDir], cwd);
    expect(report.exitCode).toBe(0);
    expect(report.stdout).toContain("generated reports for 2 eval trial(s)");
    const jsonPath = path.join(resultsDir, "report.json");
    const markdownPath = path.join(resultsDir, "report.md");
    await expect(readFile(jsonPath, "utf8")).resolves.toContain("agent__task__skills__1");
    await expect(readFile(markdownPath, "utf8")).resolves.toContain("# Eval Report");
  });

  it("handles multi-agent, multi-task, multi-variant, multi-run matrix with include/exclude", async () => {
    const cwd = await makeTempDir();
    await writeFixtureFile(cwd, "prompts/task-a.md", "# Task A\n");
    await writeFixtureFile(cwd, "prompts/task-b.md", "# Task B\n");
    await writeFixtureFile(cwd, "starter/README.md", "starter\n");
    await writeFixtureFile(cwd, "acceptance/hidden/check.mjs", "console.log('pass');\n");
    await writeFixtureFile(cwd, "rubrics/quality.md", "# Quality\n");

    const results = await executeEvalTrials({
      suiteRoot: cwd,
      resultsRoot: path.join(cwd, "results", "matrix"),
      config: {
        sandbox: { provider: "docker" },
        agents: [
          { id: "claude", provider: "claude-code", model: "opus-4" },
          { id: "opencode", provider: "opencode", model: "big-pickle" },
        ],
        tasks: [
          { id: "task-a", prompt: "prompts/task-a.md", starter: "starter", acceptanceMaterial: { hiddenDir: "acceptance/hidden", checks: [{ id: "smoke", command: "node acceptance/hidden/check.mjs" }] } },
          { id: "task-b", prompt: "prompts/task-b.md", starter: "starter", acceptanceMaterial: { hiddenDir: "acceptance/hidden", checks: [{ id: "smoke", command: "node acceptance/hidden/check.mjs" }] } },
        ],
        scenarioVariants: [
          { id: "baseline" },
          { id: "skills" },
        ],
        evaluatorAgent: { id: "eval", provider: "opencode" },
        matrix: {
          runIndexes: [1, 2],
          include: [{ agent: "claude", task: "task-a", scenarioVariant: "skills", runIndex: 3 }],
          exclude: [{ agent: "opencode", task: "task-b", scenarioVariant: "baseline", runIndex: 2 }],
        },
      },
      sandcastleExecutor: async (input) => {
        await writeFixtureFile(input.worktreePath, "solution.txt", `solved by ${input.evalTrialId}\n`);
        return { stdout: "ok", commits: [{ sha: "abc" }], iterations: [{ usage: { inputTokens: 10, outputTokens: 3 } }] };
      },
      evaluatorAgentExecutor: async () => ({
        stdout: JSON.stringify({ criteria: [{ id: "quality", score: 4, rationale: "Good." }], summary: "Passed." }),
      }),
    });

    const ids = results.map((r) => r.evalTrialId);
    expect(ids).toContain("claude__task-a__skills__3");
    expect(ids).not.toContain("opencode__task-b__baseline__2");
    const cartesianSize = 2 * 2 * 2 * 2;
    const includeSize = 1;
    const excludeSize = 1;
    expect(ids).toHaveLength(cartesianSize + includeSize - excludeSize);

    const reportJson = JSON.parse(await readFile(path.join(cwd, "results", "matrix", "report.json"), "utf8"));
    expect(reportJson.trials).toHaveLength(cartesianSize + includeSize - excludeSize);
    expect(reportJson.summary.successful).toBe(cartesianSize + includeSize - excludeSize);
  });

  it("exercises score aggregation: mixed pass/fail, zero-weight checks, rubric not counted on failure", async () => {
    const cwd = await makeTempDir();
    await writeFixtureFile(cwd, "prompts/task.md", "# Task\n");
    await writeFixtureFile(cwd, "starter/README.md", "starter\n");
    await writeFixtureFile(cwd, "acceptance/hidden/pass.mjs", "console.log('pass');\n");
    await writeFixtureFile(cwd, "acceptance/hidden/fail.mjs", "process.exit(2);\n");
    await writeFixtureFile(cwd, "acceptance/hidden/always-pass.mjs", "console.log('ok');\n");
    await writeFixtureFile(cwd, "rubrics/quality.md", "# Quality\n");
    await writeFixtureFile(cwd, "rubrics/style.md", "# Style\n");

    const results = await executeEvalTrials({
      suiteRoot: cwd,
      resultsRoot: path.join(cwd, "results", "weights"),
      config: {
        sandbox: { provider: "docker" },
        agents: [{ id: "agent", provider: "opencode" }],
        evaluatorAgent: { id: "eval", provider: "opencode" },
        tasks: [{
          id: "task", prompt: "prompts/task.md", starter: "starter",
          scoring: { deterministicWeight: 0.8, rubricWeight: 0.2 },
          acceptanceMaterial: {
            hiddenDir: "acceptance/hidden",
            checks: [
              { id: "pass", command: "node acceptance/hidden/pass.mjs", weight: 3 },
              { id: "fail", command: "node acceptance/hidden/fail.mjs", weight: 1 },
              { id: "zero-weight", command: "node acceptance/hidden/always-pass.mjs", weight: 0 },
            ],
            rubrics: [
              { id: "quality", path: "rubrics/quality.md", weight: 1, scale: { min: 1, max: 5 } },
            ],
          },
        }],
        scenarioVariants: [{ id: "baseline" }],
        matrix: { runIndexes: [1] },
      },
      sandcastleExecutor: async () => ({ stdout: "ok", iterations: [{ usage: { inputTokens: 5, outputTokens: 1 } }] }),
      evaluatorAgentExecutor: async () => ({
        stdout: JSON.stringify({ criteria: [{ id: "quality", score: 5, rationale: "Perfect." }], summary: "All good." }),
      }),
    });

    expect(results[0]?.status).toBe("failed");
    const result = JSON.parse(await readFile(path.join(cwd, "results", "weights", "agent__task__baseline__1", "result.json"), "utf8"));
    expect(result.evalScore.deterministic.value).toBe(0.75);
    expect(result.evalScore.rubric.counted).toBe(false);
    expect(result.evalScore.rubric.contribution).toBe(0);
    expect(result.evalScore.value).toBe(0.6);
  });

  it("handles evaluator agent edge cases: missing criteria, extra keys, empty summary", async () => {
    const cwd = await makeTempDir();
    await writeFixtureFile(cwd, "prompts/task.md", "# Task\n");
    await writeFixtureFile(cwd, "starter/README.md", "starter\n");
    await writeFixtureFile(cwd, "acceptance/hidden/pass.mjs", "console.log('pass');\n");
    await writeFixtureFile(cwd, "rubrics/quality.md", "# Quality\n");
    await writeFixtureFile(cwd, "rubrics/style.md", "# Style\n");

    const results = await executeEvalTrials({
      suiteRoot: cwd,
      resultsRoot: path.join(cwd, "results", "evaluator-edge-cases"),
      config: {
        sandbox: { provider: "docker" },
        agents: [{ id: "agent", provider: "opencode" }],
        evaluatorAgent: { id: "eval", provider: "opencode" },
        tasks: [{
          id: "task", prompt: "prompts/task.md", starter: "starter",
          scoring: { deterministicWeight: 0.5, rubricWeight: 0.5 },
          acceptanceMaterial: {
            hiddenDir: "acceptance/hidden",
            checks: [{ id: "pass", command: "node acceptance/hidden/pass.mjs", weight: 1 }],
            rubrics: [
              { id: "quality", path: "rubrics/quality.md", weight: 2, scale: { min: 0, max: 10 } },
              { id: "style", path: "rubrics/style.md", weight: 1 },
            ],
          },
        }],
        scenarioVariants: [{ id: "baseline" }],
        matrix: { runIndexes: [1] },
      },
      sandcastleExecutor: async () => ({ stdout: "ok", iterations: [] }),
      evaluatorAgentExecutor: async () => ({
        stdout: JSON.stringify({
          criteria: [
            { id: "quality", score: 8, rationale: "Good structure." },
          ],
          summary: "",
        }),
      }),
    });

    expect(results[0]?.status).toBe("success");
    const result = JSON.parse(await readFile(path.join(cwd, "results", "evaluator-edge-cases", "agent__task__baseline__1", "result.json"), "utf8"));
    expect(result.scoring.evaluatorAgent.result.criteria).toHaveLength(1);
    const qualityScore = result.scoring.evaluatorAgent.result.criteria[0];
    expect(qualityScore).toMatchObject({ id: "quality", score: 8, rationale: "Good structure." });
  });

  it("redacts overlapping secrets correctly (longer match first)", async () => {
    const suiteRoot = await makeTempDir();
    await writeFixtureFile(suiteRoot, "prompts/task.md", "# Task\n");
    await writeFixtureFile(suiteRoot, "starter/README.md", "starter\n");
    await writeFixtureFile(
      suiteRoot,
      "acceptance/hidden/check.mjs",
      `console.log("token=gHx73k secret=gHx73kSecret suffix");\n`
    );
    await writeFixtureFile(suiteRoot, "rubrics/quality.md", "# Quality\n");

    process.env.TOKEN = "gHx73k";
    process.env.LONG_TOKEN = "gHx73kSecret";

    const results = await executeEvalTrials({
      suiteRoot,
      resultsRoot: path.join(suiteRoot, "results", "secrets"),
      config: {
        sandbox: { provider: "docker" },
        agents: [{ id: "agent", provider: "opencode", env: { TOKEN: "env:TOKEN", LONG_TOKEN: "env:LONG_TOKEN" } }],
        evaluatorAgent: { id: "eval", provider: "opencode" },
        tasks: [{
          id: "task", prompt: "prompts/task.md", starter: "starter",
          acceptanceMaterial: {
            hiddenDir: "acceptance/hidden",
            checks: [{ id: "check", command: "node acceptance/hidden/check.mjs" }],
            rubrics: [{ id: "quality", path: "rubrics/quality.md" }],
          },
        }],
        scenarioVariants: [{ id: "baseline" }],
        matrix: { runIndexes: [1] },
      },
      sandcastleExecutor: async () => ({ stdout: "ok", iterations: [] }),
      evaluatorAgentExecutor: async () => ({
        stdout: JSON.stringify({ criteria: [{ id: "quality", score: 3, rationale: "Ok." }], summary: "Ok." }),
      }),
    });

    const result = JSON.parse(await readFile(path.join(suiteRoot, "results", "secrets", "agent__task__baseline__1", "result.json"), "utf8"));
    const stdout = result.scoring.acceptanceChecks[0].stdout;
    expect(stdout).toContain("[REDACTED]");
    expect(stdout).not.toContain("gHx73k");
  });

  it("enforces strict evaluator JSON schema: rejects extra keys, wrong types, missing fields", async () => {
    const cwd = await makeTempDir();
    await writeFixtureFile(cwd, "prompts/task.md", "# Task\n");
    await writeFixtureFile(cwd, "starter/README.md", "starter\n");
    await writeFixtureFile(cwd, "acceptance/hidden/pass.mjs", "console.log('pass');\n");
    await writeFixtureFile(cwd, "rubrics/quality.md", "# Quality\n");

    const testCases: Array<{ name: string; output: string; expectedError: string }> = [
      {
        name: "non-JSON output",
        output: "not json at all",
        expectedError: "valid JSON",
      },
      {
        name: "array instead of object",
        output: JSON.stringify(["criteria", "summary"]),
        expectedError: "must be a JSON object",
      },
      {
        name: "extra top-level keys",
        output: JSON.stringify({ criteria: [], summary: "", extra: "bad" }),
        expectedError: "must contain only criteria and summary",
      },
      {
        name: "missing summary",
        output: JSON.stringify({ criteria: [] }),
        expectedError: "must contain only criteria and summary",
      },
      {
        name: "criteria not an array",
        output: JSON.stringify({ criteria: "string", summary: "" }),
        expectedError: "invalid schema",
      },
      {
        name: "summary not a string",
        output: JSON.stringify({ criteria: [], summary: 42 }),
        expectedError: "invalid schema",
      },
      {
        name: "criterion missing id",
        output: JSON.stringify({ criteria: [{ score: 5, rationale: "Good." }], summary: "Ok." }),
        expectedError: "invalid schema",
      },
      {
        name: "criterion has extra key",
        output: JSON.stringify({ criteria: [{ id: "q", score: 5, rationale: "Ok.", extra: true }], summary: "Ok." }),
        expectedError: "invalid schema",
      },
      {
        name: "criterion score not a number",
        output: JSON.stringify({ criteria: [{ id: "q", score: "high", rationale: "Ok." }], summary: "Ok." }),
        expectedError: "invalid schema",
      },
    ];

    for (const { name, output, expectedError } of testCases) {
      const results = await executeEvalTrials({
        suiteRoot: cwd,
        resultsRoot: path.join(cwd, "results", `schema-${name.replace(/\s+/g, "-")}`),
        config: {
          sandbox: { provider: "docker" },
          agents: [{ id: "agent", provider: "opencode" }],
          evaluatorAgent: { id: "eval", provider: "opencode" },
          tasks: [{
            id: "task", prompt: "prompts/task.md", starter: "starter",
            acceptanceMaterial: {
              hiddenDir: "acceptance/hidden",
              checks: [{ id: "pass", command: "node acceptance/hidden/pass.mjs" }],
              rubrics: [{ id: "quality", path: "rubrics/quality.md" }],
            },
          }],
          scenarioVariants: [{ id: "baseline" }],
          matrix: { runIndexes: [1] },
        },
        sandcastleExecutor: async () => ({ stdout: "ok", iterations: [] }),
        evaluatorAgentExecutor: async () => ({ stdout: output }),
      });
      expect(results[0]?.status).toBe("failed");
      const result = JSON.parse(await readFile(
        path.join(cwd, "results", `schema-${name.replace(/\s+/g, "-")}`, "agent__task__baseline__1", "result.json"), "utf8"
      ));
      expect(result.scoring.evaluatorAgent.error).toContain(expectedError);
    }
  });

  it("rejects path traversal via resolveSuitePath in hiddenDir", async () => {
    const cwd = await makeTempDir();
    await writeFixtureFile(cwd, "starter/README.md", "starter\n");
    await writeFixtureFile(cwd, "prompts/task.md", "# Task\n");

    const results = await executeEvalTrials({
      suiteRoot: cwd,
      resultsRoot: path.join(cwd, "results", "traversal"),
      config: {
        sandbox: { provider: "docker" },
        agents: [{ id: "agent", provider: "opencode" }],
        tasks: [{
          id: "task", prompt: "prompts/task.md", starter: "starter",
          acceptanceMaterial: {
            hiddenDir: "../../etc",
            checks: [{ id: "pass", command: "echo ok" }],
          },
        }],
        scenarioVariants: [{ id: "baseline" }],
        matrix: { runIndexes: [1] },
      },
      sandcastleExecutor: async () => ({ stdout: "ok", iterations: [] }),
    });

    expect(results[0]?.status).toBe("failed");
    expect(results[0]?.error).toContain("must stay inside the suite root");
  });

  it("handles acceptance check cwd path traversal as a failed check", async () => {
    const cwd = await makeTempDir();
    await writeFixtureFile(cwd, "prompts/task.md", "# Task\n");
    await writeFixtureFile(cwd, "starter/README.md", "starter\n");
    await writeFixtureFile(cwd, "acceptance/hidden/pass.mjs", "console.log('pass');\n");

    const results = await executeEvalTrials({
      suiteRoot: cwd,
      resultsRoot: path.join(cwd, "results", "cwd-traversal"),
      config: {
        sandbox: { provider: "docker" },
        agents: [{ id: "agent", provider: "opencode" }],
        tasks: [{
          id: "task", prompt: "prompts/task.md", starter: "starter",
          acceptanceMaterial: {
            hiddenDir: "acceptance/hidden",
            checks: [{ id: "pass", command: "echo ok", cwd: "../.." }],
          },
        }],
        scenarioVariants: [{ id: "baseline" }],
        matrix: { runIndexes: [1] },
      },
      sandcastleExecutor: async () => ({ stdout: "ok", iterations: [] }),
    });

    expect(results[0]?.status).toBe("failed");
    expect(results[0]?.error).toBe("post-trial scoring failed");
  });

  it("preserves failed worktrees on sandcastle crash and pre-existing results dir collision", async () => {
    const cwd = await makeTempDir();
    await writeFixtureFile(cwd, "prompts/task.md", "# Task\n");
    await writeFixtureFile(cwd, "starter/README.md", "starter\n");
    await writeFixtureFile(cwd, "acceptance/hidden/pass.mjs", "console.log('pass');\n");

    const results = await executeEvalTrials({
      suiteRoot: cwd,
      resultsRoot: path.join(cwd, "results", "crash"),
      config: {
        sandbox: { provider: "docker" },
        agents: [{ id: "agent", provider: "opencode" }],
        tasks: [{ id: "task", prompt: "prompts/task.md", starter: "starter", acceptanceMaterial: { hiddenDir: "acceptance/hidden", checks: [{ id: "pass", command: "node acceptance/hidden/pass.mjs" }] } }],
        scenarioVariants: [{ id: "baseline" }],
        matrix: { runIndexes: [1] },
      },
      sandcastleExecutor: async () => {
        throw new Error("docker daemon unreachable");
      },
    });

    expect(results[0]?.status).toBe("failed");
    expect(results[0]?.error).toBe("docker daemon unreachable");
    const result = JSON.parse(await readFile(path.join(cwd, "results", "crash", "agent__task__baseline__1", "result.json"), "utf8"));
    expect(result.worktree.preserved).toBe(true);
    expect(result.worktree.worktreePath).toBeTruthy();
    await expect(exists(result.worktree.worktreePath)).resolves.toBe(true);

    await expect(
      executeEvalTrials({
        suiteRoot: cwd,
        resultsRoot: path.join(cwd, "results", "crash"),
        config: {
          sandbox: { provider: "docker" },
          agents: [{ id: "agent", provider: "opencode" }],
          tasks: [{ id: "task", prompt: "prompts/task.md", starter: "starter" }],
          scenarioVariants: [{ id: "baseline" }],
          matrix: { runIndexes: [1] },
        },
        sandcastleExecutor: async () => ({ stdout: "should not run" }),
      })
    ).rejects.toThrow("results run directory already exists");
  });

  it("supports fail-fast stopping after first failure across multiple trials", async () => {
    const cwd = await makeTempDir();
    await writeFixtureFile(cwd, "prompts/task.md", "# Task\n");
    await writeFixtureFile(cwd, "starter/README.md", "starter\n");

    const order: string[] = [];
    const results = await executeEvalTrials({
      suiteRoot: cwd,
      resultsRoot: path.join(cwd, "results", "failfast"),
      config: {
        sandbox: { provider: "docker" },
        agents: [{ id: "agent", provider: "opencode" }],
        tasks: [{ id: "task", prompt: "prompts/task.md", starter: "starter" }],
        scenarioVariants: [{ id: "a" }, { id: "b" }, { id: "c" }],
        matrix: { runIndexes: [1, 2] },
      },
      failFast: true,
      sandcastleExecutor: async (input) => {
        order.push(input.evalTrialId);
        if (input.evalTrialId.includes("b__1")) throw new Error("intentional");
        return { stdout: "ok", iterations: [] };
      },
    });

    const failed = results.filter((r) => r.status === "failed");
    expect(failed.length).toBeGreaterThan(0);
    const b1InOrder = order.some((id) => id.includes("b__1"));
    const b2InOrder = order.some((id) => id.includes("b__2"));
    expect(b1InOrder).toBe(true);
    expect(b2InOrder).toBe(false);
  });

  it("produces complete artifact manifests and can regenerate reports from raw results", async () => {
    const cwd = await makeTempDir();
    await writeFixtureFile(cwd, "prompts/task.md", "# Task\n");
    await writeFixtureFile(cwd, "starter/README.md", "starter\n");
    await writeFixtureFile(cwd, "acceptance/hidden/pass.mjs", "console.log('pass');\n");
    await writeFixtureFile(cwd, "rubrics/quality.md", "# Quality\n");

    const resultsRoot = path.join(cwd, "results", "full-artifacts");
    await executeEvalTrials({
      suiteRoot: cwd,
      resultsRoot,
      config: {
        sandbox: { provider: "docker" },
        agents: [{ id: "agent", provider: "opencode" }],
        evaluatorAgent: { id: "eval", provider: "opencode" },
        tasks: [{
          id: "task", prompt: "prompts/task.md", starter: "starter",
          scoring: { deterministicWeight: 0.6, rubricWeight: 0.4 },
          acceptanceMaterial: {
            hiddenDir: "acceptance/hidden",
            checks: [{ id: "pass", command: "node acceptance/hidden/pass.mjs", weight: 1 }],
            rubrics: [{ id: "quality", path: "rubrics/quality.md", weight: 1 }],
          },
        }],
        scenarioVariants: [{ id: "baseline" }],
        matrix: { runIndexes: [1] },
      },
      sandcastleExecutor: async (input) => {
        await writeFixtureFile(input.worktreePath, "src/main.ts", "console.log('done');\n");
        await writeFixtureFile(input.worktreePath, "reports/coverage.xml", "<coverage/>\n");
        return {
          stdout: "agent done",
          logs: "full sandcastle log",
          commits: [{ sha: "abc" }, { sha: "def" }],
          diff: "diff --git a/src/main.ts b/src/main.ts\n+console.log('done');\n",
          providerMetadata: { provider: "opencode", model: "big-pickle" },
          iterations: [{ usage: { inputTokens: 100, cacheReadInputTokens: 10, cacheCreationInputTokens: 5, outputTokens: 50, reasoningTokens: 20 } }],
        };
      },
      evaluatorAgentExecutor: async () => ({
        stdout: JSON.stringify({ criteria: [{ id: "quality", score: 4, rationale: "Clean code." }], summary: "Approved." }),
      }),
    });

    const artifactRoot = path.join(resultsRoot, "agent__task__baseline__1");
    const manifest = JSON.parse(await readFile(path.join(artifactRoot, "artifact-manifest.json"), "utf8"));
    const expectedFiles = [
      "acceptance-output.json", "artifact-manifest.json", "commits.json", "config.json",
      "cost.json", "diff.patch", "evaluator-rationale.json", "prompt.md", "result.json",
      "sandcastle.log", "timings.json", "usage.json",
    ];
    expect(manifest.files).toEqual(expectedFiles);

    await expect(readFile(path.join(artifactRoot, "diff.patch"), "utf8")).resolves.toContain("console.log");
    await expect(readFile(path.join(artifactRoot, "commits.json"), "utf8")).resolves.toContain("abc");
    await expect(readFile(path.join(artifactRoot, "usage.json"), "utf8")).resolves.toContain("reasoningTokens");

    const resultJson = JSON.parse(await readFile(path.join(artifactRoot, "result.json"), "utf8"));
    expect(resultJson.evalScore.deterministic.checksFailed).toBe(false);
    expect(resultJson.evalScore.rubric.counted).toBe(true);
    expect(resultJson.evalScore.value).toBeGreaterThan(0);
    expect(resultJson.evalScore.value).toBeLessThanOrEqual(1);

    const regenerated = await generateReports(resultsRoot);
    expect(regenerated.summary.evalTrials).toBe(1);
    expect(regenerated.summary.successful).toBe(1);
    expect(regenerated.trials[0]?.evalScore?.value).toBe(resultJson.evalScore.value);
  });

  it("handles empty rubrics, missing evaluator agent, no acceptance checks gracefully", async () => {
    const cwd = await makeTempDir();
    await writeFixtureFile(cwd, "prompts/task.md", "# Task\n");
    await writeFixtureFile(cwd, "starter/README.md", "starter\n");

    const results = await executeEvalTrials({
      suiteRoot: cwd,
      resultsRoot: path.join(cwd, "results", "minimal"),
      config: {
        sandbox: { provider: "docker" },
        agents: [{ id: "agent", provider: "opencode" }],
        tasks: [{ id: "task", prompt: "prompts/task.md", starter: "starter" }],
        scenarioVariants: [{ id: "baseline" }],
        matrix: { runIndexes: [1] },
      },
      sandcastleExecutor: async () => ({ stdout: "ok", iterations: [] }),
    });

    expect(results[0]?.status).toBe("success");
    const result = JSON.parse(await readFile(path.join(cwd, "results", "minimal", "agent__task__baseline__1", "result.json"), "utf8"));
    expect(result.scoring.acceptanceChecks).toEqual([]);
    expect(result.scoring.evaluatorAgent).toEqual({ status: "skipped" });
    expect(result.evalScore.deterministic.checksFailed).toBe(false);
  });

  it("git-baselines the worktree and collects both committed and uncommitted diffs", async () => {
    const cwd = await makeTempDir();
    await writeFixtureFile(cwd, "prompts/task.md", "# Task\n");
    await writeFixtureFile(cwd, "starter/README.md", "starter\n");

    const sandcastleInputs: SandcastleExecutorInput[] = [];

    await executeEvalTrials({
      suiteRoot: cwd,
      resultsRoot: path.join(cwd, "results", "diffs"),
      config: {
        sandbox: { provider: "docker" },
        agents: [{ id: "agent", provider: "opencode" }],
        tasks: [{ id: "task", prompt: "prompts/task.md", starter: "starter" }],
        scenarioVariants: [{ id: "baseline" }],
        matrix: { runIndexes: [1] },
      },
      sandcastleExecutor: async (input) => {
        sandcastleInputs.push(input);

        const { stdout: baseSha } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: input.worktreePath });
        await writeFixtureFile(input.worktreePath, "committed.txt", "committed change\n");
        await execFileAsync("git", ["add", "."], { cwd: input.worktreePath });
        await execFileAsync("git", ["commit", "-m", "committed"], { cwd: input.worktreePath });

        await writeFixtureFile(input.worktreePath, "committed.txt", "committed change\nmodified\n");

        const committed = (await execFileAsync("git", ["diff", `${baseSha.trim()}..HEAD`], { cwd: input.worktreePath, reject: false })).stdout;
        const uncommitted = (await execFileAsync("git", ["diff"], { cwd: input.worktreePath, reject: false })).stdout;
        const diff = [committed, uncommitted].filter(Boolean).join("\n");

        return {
          stdout: "done",
          commits: [{ sha: "sha1" }],
          diff,
          iterations: [],
        };
      },
    });

    const diffPatch = await readFile(path.join(cwd, "results", "diffs", "agent__task__baseline__1", "diff.patch"), "utf8");
    expect(diffPatch).toContain("committed change");
    expect(diffPatch).toContain("modified");
  });

  it("normalizes usage across multiple iterations and estimates cost with partial pricing", async () => {
    const cwd = await makeTempDir();
    await writeFixtureFile(cwd, "prompts/task.md", "# Task\n");
    await writeFixtureFile(cwd, "starter/README.md", "starter\n");
    await writeFixtureFile(cwd, "acceptance/hidden/pass.mjs", "console.log('pass');\n");
    await writeFixtureFile(cwd, "rubrics/q.md", "# Q\n");

    const results = await executeEvalTrials({
      suiteRoot: cwd,
      resultsRoot: path.join(cwd, "results", "pricing-edge"),
      config: {
        sandbox: { provider: "docker" },
        agents: [{ id: "agent", provider: "claude-code", model: "sonnet" }],
        evaluatorAgent: { id: "eval", provider: "claude-code" },
        pricing: [
          { id: "p1", provider: "claude-code", model: "sonnet", inputPerMillion: 3, outputPerMillion: 15 },
        ],
        tasks: [{
          id: "task", prompt: "prompts/task.md", starter: "starter",
          scoring: { deterministicWeight: 1, rubricWeight: 0 },
          acceptanceMaterial: {
            hiddenDir: "acceptance/hidden",
            checks: [{ id: "pass", command: "node acceptance/hidden/pass.mjs" }],
            rubrics: [{ id: "q", path: "rubrics/q.md" }],
          },
        }],
        scenarioVariants: [{ id: "baseline" }],
        matrix: { runIndexes: [1] },
      },
      sandcastleExecutor: async () => ({
        stdout: "ok",
        iterations: [
          { usage: { inputTokens: 1000, cacheReadInputTokens: 200, cacheCreationInputTokens: 50, outputTokens: 500 } },
          { usage: { inputTokens: 500, cacheReadInputTokens: 100, outputTokens: 300, customMetric: 42 } },
          { usage: { inputTokens: 0, cacheReadInputTokens: 0, outputTokens: 0 } },
        ],
      }),
      evaluatorAgentExecutor: async () => ({
        stdout: JSON.stringify({ criteria: [{ id: "q", score: 5, rationale: "Good." }], summary: "Ok." }),
      }),
    });

    const result = JSON.parse(await readFile(path.join(cwd, "results", "pricing-edge", "agent__task__baseline__1", "result.json"), "utf8"));
    expect(result.usage.agent).toMatchObject({
      provider: "claude-code",
      model: "sonnet",
      inputTokens: 1500,
      cacheReadTokens: 300,
      cacheWriteTokens: 50,
      outputTokens: 800,
    });
    expect(result.usage.agent.unknown).toEqual({ customMetric: 42 });
    expect(result.cost.agent.estimatedUsd).toBeGreaterThan(0);
    expect(result.cost.agent.matchedPricingId).toBe("p1");
    expect(result.cost.evaluatorAgent.status).toBe("unavailable");
  });

  it("handles worktree prepare with non-existent overlay paths gracefully", async () => {
    const cwd = await makeTempDir();
    await writeFixtureFile(cwd, "starter/README.md", "starter\n");

    const prepared = await prepareEvalTrialWorktree({
      suiteRoot: cwd,
      evalTrialId: "agent__task__skills__1",
      starterPath: "starter",
      repoOverlayPath: undefined,
      agentHomeOverlayPath: undefined,
    });

    await expect(readFile(path.join(prepared.repoPath, "README.md"), "utf8")).resolves.toBe("starter\n");
    expect(prepared.repoPath).toContain("agent__task__skills__1");
    expect(prepared.agentHomePath).toContain("agent__task__skills__1");

    const meta = await finalizeEvalTrialWorktree(prepared, { outcome: "success" });
    expect(meta.preserved).toBe(false);
    await expect(exists(prepared.rootPath)).resolves.toBe(false);
  });

  it("supports formatted reports with all baseline delta scenarios", async () => {
    const cwd = await makeTempDir();
    const resultsDir = path.join(cwd, "results", "all-deltas");
    const config = { matrix: { baselineScenarioVariant: "baseline" } };

    const trialConfigs = [
      { evalTrialId: "agent__task__baseline__1", status: "success", evalScore: { value: 0.8 }, scoring: { acceptanceChecks: [{ id: "s", exitCode: 0, timedOut: false, weight: 1 }] }, cost: { agent: { estimatedUsd: 0.001 } }, usage: { agent: { inputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 5 } } },
      { evalTrialId: "agent__task__skills__1", status: "success", evalScore: { value: 0.9 }, scoring: { acceptanceChecks: [{ id: "s", exitCode: 0, timedOut: false, weight: 1 }] }, cost: { agent: { estimatedUsd: 0.002 } }, usage: { agent: { inputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 10 } } },
      { evalTrialId: "agent__other__skills__1", status: "failed", error: "post-trial scoring failed", evalScore: { value: 0.25 }, worktree: { preserved: true, worktreePath: "/tmp/preserved", agentHomePath: "/tmp/home" } },
    ];

    for (const t of trialConfigs) {
      await mkdir(path.join(resultsDir, t.evalTrialId), { recursive: true });
      await writeJsonFixture(resultsDir, `${t.evalTrialId}/config.json`, config);
      const payload = { ...t, timings: { startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:05.000Z", durationMs: 5000 } } as Record<string, unknown>;
      if (!("usage" in t)) (payload as Record<string, unknown>).usage = { agent: {} };
      if (!("cost" in t)) (payload as Record<string, unknown>).cost = { agent: {} };
      await writeJsonFixture(resultsDir, `${t.evalTrialId}/result.json`, payload);
    }

    const report = await generateReports(resultsDir);
    expect(report.trials).toHaveLength(3);
    const byId = new Map(report.trials.map((t: { evalTrialId: string }) => [t.evalTrialId, t]));
    expect(byId.get("agent__other__skills__1")?.baselineDelta).toEqual({ status: "missing", baselineScenarioVariant: "baseline", expectedEvalTrialId: "agent__other__baseline__1" });
    expect(byId.get("agent__task__baseline__1")?.baselineDelta).toEqual({ status: "baseline" });
    expect(byId.get("agent__task__skills__1")?.baselineDelta).toEqual({ status: "matched", baselineEvalTrialId: "agent__task__baseline__1", evalScoreDelta: 0.1 });

    const reportJson = JSON.parse(await readFile(path.join(resultsDir, "report.json"), "utf8"));
    expect(reportJson.summary.successful).toBe(2);
    expect(reportJson.summary.failed).toBe(1);
  });

  it("expands matrix from validated config shape matching the CLI path", async () => {
    const trials = expandTrialMatrix({
      agents: [{ id: "claude" }, { id: "opencode" }],
      tasks: [{ id: "fix-bug" }, { id: "add-feature" }, { id: "refactor" }],
      scenarioVariants: [{ id: "baseline" }, { id: "skills" }],
      matrix: {
        runIndexes: [1, 2],
        include: [
          { agent: "claude", task: "fix-bug", scenarioVariant: "skills", runIndex: 3 },
        ],
        exclude: [
          { agent: "opencode", task: "refactor", scenarioVariant: "baseline", runIndex: 2 },
          { agent: "claude", task: "add-feature", scenarioVariant: "baseline", runIndex: 1 },
        ],
      },
    });

    expect(trials).toHaveLength(23);
    expect(trials.some((t) => t.id === "claude__fix-bug__skills__3")).toBe(true);
    expect(trials.some((t) => t.id === "opencode__refactor__baseline__2")).toBe(false);
    expect(trials.some((t) => t.id === "claude__add-feature__baseline__1")).toBe(false);
    expect(trials.every((t) => t.runIndex >= 1)).toBe(true);
  });
});
