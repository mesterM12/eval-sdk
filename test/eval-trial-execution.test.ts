import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  createSandcastleBuiltInExecutor,
  executeEvalTrials,
  type EvaluatorAgentExecutorInput,
  type SandcastleExecutorInput,
} from "../src/eval-trial-execution.js";

const execFileAsync = promisify(execFile);

async function makeTempDir() {
  return mkdtemp(path.join(tmpdir(), "coding-agent-eval-execution-"));
}

async function writeFixtureFile(root: string, relativePath: string, contents: string) {
  const filePath = path.join(root, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, contents, "utf8");
}

async function exists(filePath: string) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

describe("eval trial execution filesystem seam", () => {
  it("runs eval trials through Sandcastle built-ins and stores auditable artifacts", async () => {
    const suiteRoot = await makeTempDir();
    await writeFixtureFile(suiteRoot, "prompts/task.md", "# Task\nChange the starter.\n");
    await writeFixtureFile(suiteRoot, "prompts/variant.md", "# Scenario Variant\nUse the skill.\n");
    await writeFixtureFile(suiteRoot, "starter/README.md", "starter\n");
    await writeFixtureFile(suiteRoot, "overlays/home/config.json", "{\"agent\":true}\n");
    await writeFixtureFile(suiteRoot, "acceptance/hidden/smoke.test.js", "throw new Error('hidden')\n");

    const calls: SandcastleExecutorInput[] = [];
    const visibilityChecks: boolean[] = [];

    const results = await executeEvalTrials({
      suiteRoot,
      resultsRoot: path.join(suiteRoot, "results", "test-run"),
      config: {
        sandbox: { provider: "docker" },
        agents: [{ id: "claude", provider: "claude-code", model: "claude-opus-4-7" }],
        tasks: [
          {
            id: "task",
            prompt: "prompts/task.md",
            starter: "starter",
            acceptanceMaterial: { hiddenDir: "acceptance/hidden" },
          },
        ],
        scenarioVariants: [{ id: "skills", prompt: "prompts/variant.md", agentHomeOverlay: "overlays/home" }],
        matrix: { runIndexes: [1] },
      },
      sandcastleExecutor: async (input) => {
        calls.push(input);
        visibilityChecks.push(
          (await readFile(path.join(input.agentHomePath, "config.json"), "utf8")) === "{\"agent\":true}\n" &&
            !(await exists(path.join(input.worktreePath, "acceptance", "hidden", "smoke.test.js")))
        );
        await writeFixtureFile(input.worktreePath, "README.md", "changed\n");
        return {
          stdout: "agent stdout",
          logs: "sandcastle log",
          commits: [{ sha: "abc123" }],
          diff: "diff --git a/README.md b/README.md",
          branch: "main",
          providerMetadata: { provider: input.providerName, model: input.model },
          iterations: [{ usage: { inputTokens: 10, cacheCreationInputTokens: 1, cacheReadInputTokens: 2, outputTokens: 3 } }],
        };
      },
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe("success");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      providerName: "claude-code",
      model: "claude-opus-4-7",
      sandboxProvider: "docker",
      branchStrategy: "head",
    });
    expect(calls[0]?.prompt).toBe("# Task\nChange the starter.\n\n# Scenario Variant\nUse the skill.\n");
    expect(calls[0]?.worktreePath).toContain(path.join(".eval-agent", "worktrees", "claude__task__skills__1", "repo"));
    expect(calls[0]?.agentHomePath).toContain(path.join(".eval-agent", "worktrees", "claude__task__skills__1", "agent-home"));
    expect(visibilityChecks).toEqual([true]);

    const artifactRoot = path.join(suiteRoot, "results", "test-run", "claude__task__skills__1");
    await expect(readFile(path.join(artifactRoot, "prompt.md"), "utf8")).resolves.toBe(calls[0]!.prompt);
    await expect(readFile(path.join(artifactRoot, "sandcastle.log"), "utf8")).resolves.toBe("sandcastle log");
    const resultJson = JSON.parse(await readFile(path.join(artifactRoot, "result.json"), "utf8"));
    expect(resultJson).toMatchObject({
      evalTrialId: "claude__task__skills__1",
      status: "success",
      sandcastle: {
        commits: [{ sha: "abc123" }],
        diff: "diff --git a/README.md b/README.md",
        providerMetadata: { provider: "claude-code", model: "claude-opus-4-7" },
        iterations: [{ usage: { inputTokens: 10, cacheCreationInputTokens: 1, cacheReadInputTokens: 2, outputTokens: 3 } }],
      },
      worktree: { preserved: false, worktreePath: null, agentHomePath: null },
    });
    expect(resultJson.timings.startedAt).toEqual(expect.any(String));
    expect(resultJson.timings.finishedAt).toEqual(expect.any(String));
    expect(resultJson.timings.durationMs).toEqual(expect.any(Number));
    await expect(readFile(path.join(suiteRoot, "results", "test-run", "report.json"), "utf8")).resolves.toContain("claude__task__skills__1");
    await expect(readFile(path.join(suiteRoot, "results", "test-run", "report.md"), "utf8")).resolves.toContain("# Eval Report");
  });

  it("passes local sandbox provider to coding and evaluator agents", async () => {
    const suiteRoot = await makeTempDir();
    await writeFixtureFile(suiteRoot, "prompts/task.md", "# Task\n");
    await writeFixtureFile(suiteRoot, "starter/README.md", "starter\n");
    await writeFixtureFile(suiteRoot, "acceptance/hidden/pass.test.js", "console.log('ok')\n");
    await writeFixtureFile(suiteRoot, "rubrics/quality.md", "# Quality\n");
    const agentCalls: SandcastleExecutorInput[] = [];
    const evaluatorCalls: EvaluatorAgentExecutorInput[] = [];

    const results = await executeEvalTrials({
      suiteRoot,
      resultsRoot: path.join(suiteRoot, "results", "local-run"),
      config: {
        sandbox: { provider: "local" },
        agents: [{ id: "claude", provider: "claude-code" }],
        evaluatorAgent: { id: "eval", provider: "opencode" },
        tasks: [
          {
            id: "task",
            prompt: "prompts/task.md",
            starter: "starter",
            scoring: { deterministicWeight: 0.5, rubricWeight: 0.5 },
            acceptanceMaterial: {
              hiddenDir: "acceptance/hidden",
              checks: [{ id: "pass", command: "node acceptance/hidden/pass.test.js" }],
              rubrics: [{ id: "quality", path: "rubrics/quality.md" }],
            },
          },
        ],
        scenarioVariants: [{ id: "baseline" }],
        matrix: { runIndexes: [1] },
      },
      sandcastleExecutor: async (input) => {
        agentCalls.push(input);
        await writeFixtureFile(input.worktreePath, "README.md", "changed\n");
        return { stdout: "ok", commits: [], diff: "diff" };
      },
      evaluatorAgentExecutor: async (input) => {
        evaluatorCalls.push(input);
        return { stdout: JSON.stringify({ criteria: [{ id: "quality", score: 4, rationale: "Good." }], summary: "Good." }) };
      },
    });

    expect(results[0]?.status).toBe("success");
    expect(agentCalls).toEqual([expect.objectContaining({ sandboxProvider: "local", providerName: "claude-code" })]);
    expect(evaluatorCalls).toEqual([expect.objectContaining({ sandboxProvider: "local", providerName: "opencode" })]);
  });

  it("records failed eval trials without retries and only fail-fast stops later scheduling", async () => {
    const suiteRoot = await makeTempDir();
    await writeFixtureFile(suiteRoot, "prompts/task.md", "# Task\n");
    await writeFixtureFile(suiteRoot, "starter/README.md", "starter\n");

    const config = {
      sandbox: { provider: "docker" },
      agents: [{ id: "agent", provider: "opencode" }],
      tasks: [{ id: "task", prompt: "prompts/task.md", starter: "starter" }],
      scenarioVariants: [{ id: "baseline" }],
      matrix: { runIndexes: [1, 2] },
    };
    const calls: string[] = [];
    const executor = async (input: SandcastleExecutorInput) => {
      calls.push(input.evalTrialId);
      if (input.evalTrialId.endsWith("__1")) throw new Error("agent crashed");
      return { stdout: "ok", commits: [], iterations: [] };
    };

    const continuing = await executeEvalTrials({ suiteRoot, resultsRoot: path.join(suiteRoot, "results", "continue"), config, sandcastleExecutor: executor });

    expect(calls).toEqual(["agent__task__baseline__1", "agent__task__baseline__2"]);
    expect(continuing.map((result) => result.status)).toEqual(["failed", "success"]);
    const failedResult = JSON.parse(await readFile(path.join(suiteRoot, "results", "continue", "agent__task__baseline__1", "result.json"), "utf8"));
    expect(failedResult).toMatchObject({ status: "failed", error: "agent crashed", worktree: { preserved: true } });

    calls.length = 0;
    const failFast = await executeEvalTrials({ suiteRoot, resultsRoot: path.join(suiteRoot, "results", "fail-fast"), config, failFast: true, sandcastleExecutor: executor });

    expect(calls).toEqual(["agent__task__baseline__1"]);
    expect(failFast.map((result) => result.status)).toEqual(["failed"]);
  });

  it("scores completed eval trials in a separate sandbox with hidden acceptance material and redacted artifacts", async () => {
    const suiteRoot = await makeTempDir();
    await writeFixtureFile(suiteRoot, "prompts/task.md", "# Task\n");
    await writeFixtureFile(suiteRoot, "prompts/evaluator.md", "# Evaluator Agent\nReturn JSON.\n");
    await writeFixtureFile(suiteRoot, "starter/package.json", "{\"type\":\"module\"}\n");
    await writeFixtureFile(
      suiteRoot,
      "acceptance/hidden/check.mjs",
      `import { mkdir, writeFile } from "node:fs/promises";
await mkdir("reports", { recursive: true });
await writeFile("reports/check.txt", ` + "`artifact ${process.env.SECRET_TOKEN}`" + `, "utf8");
console.log(` + "`stdout ${process.env.SECRET_TOKEN}`" + `);
console.error(` + "`stderr ${process.env.SECRET_TOKEN}`" + `);
`
    );
    await writeFixtureFile(suiteRoot, "rubrics/maintainability.md", "# Maintainability\nScore the work.\n");

    process.env.SECRET_TOKEN = "super-secret-token";
    const events: string[] = [];
    const evaluatorInputs: EvaluatorAgentExecutorInput[] = [];

    const results = await executeEvalTrials({
      suiteRoot,
      resultsRoot: path.join(suiteRoot, "results", "scored"),
      config: {
        sandbox: { provider: "docker" },
        agents: [{ id: "agent", provider: "opencode", env: { SECRET_TOKEN: "env:SECRET_TOKEN" } }],
        evaluatorAgent: { id: "evaluator", provider: "claude-code", model: "judge-model", prompt: "prompts/evaluator.md" },
        tasks: [
          {
            id: "task",
            prompt: "prompts/task.md",
            starter: "starter",
            scoring: { deterministicWeight: 0.7, rubricWeight: 0.3 },
            acceptanceMaterial: {
              hiddenDir: "acceptance/hidden",
              checks: [
                {
                  id: "smoke",
                  command: "node acceptance/hidden/check.mjs",
                  cwd: ".",
                  timeoutMs: 5000,
                  weight: 1,
                  env: { SECRET_TOKEN: "env:SECRET_TOKEN" },
                  artifacts: ["reports/*.txt", "acceptance/hidden/*.mjs"],
                },
              ],
              rubrics: [{ id: "maintainability", path: "rubrics/maintainability.md", weight: 1, scale: { min: 1, max: 5 } }],
            },
          },
        ],
        scenarioVariants: [{ id: "baseline" }],
        matrix: { runIndexes: [1] },
      },
      sandcastleExecutor: async (input) => {
        events.push("agent");
        expect(await exists(path.join(input.worktreePath, "acceptance", "hidden", "check.mjs"))).toBe(false);
        await writeFixtureFile(input.worktreePath, "solution.txt", "completed work\n");
        return { stdout: "agent saw no hidden material", commits: [], iterations: [] };
      },
      evaluatorAgentExecutor: async (input) => {
        events.push("evaluator");
        evaluatorInputs.push(input);
        await expect(readFile(path.join(input.scoringContextPath, "solution.txt"), "utf8")).resolves.toBe("completed work\n");
        await expect(readFile(path.join(input.scoringContextPath, "acceptance", "hidden", "check.mjs"), "utf8")).resolves.toContain("SECRET_TOKEN");
        return {
          stdout: JSON.stringify({
            criteria: [{ id: "maintainability", score: 4, rationale: "Clear implementation." }],
            summary: "Good work.",
          }),
        };
      },
    });

    expect(results).toEqual([{ evalTrialId: "agent__task__baseline__1", status: "success", artifactRoot: path.join(suiteRoot, "results", "scored", "agent__task__baseline__1") }]);
    expect(events).toEqual(["agent", "evaluator"]);
    expect(evaluatorInputs).toEqual([
      expect.objectContaining({
        providerName: "claude-code",
        model: "judge-model",
        readOnly: true,
        deterministicResults: [expect.objectContaining({ id: "smoke", exitCode: 0, timedOut: false })],
      }),
    ]);

    const resultJsonText = await readFile(path.join(suiteRoot, "results", "scored", "agent__task__baseline__1", "result.json"), "utf8");
    expect(resultJsonText).not.toContain("super-secret-token");
    expect(resultJsonText).not.toContain("SECRET_TOKEN`;");
    const resultJson = JSON.parse(resultJsonText);
    expect(Object.keys(resultJson)).toEqual(["evalTrialId", "status", "timings", "sandcastle", "scoring", "evalScore", "usage", "cost", "worktree"]);
    expect(resultJson.scoring.acceptanceChecks).toEqual([
      expect.objectContaining({
        id: "smoke",
        command: "node acceptance/hidden/check.mjs",
        cwd: ".",
        timeoutMs: 5000,
        weight: 1,
        stdout: "stdout [REDACTED]\n",
        stderr: "stderr [REDACTED]\n",
        exitCode: 0,
        timedOut: false,
        durationMs: expect.any(Number),
        artifacts: [{ path: "reports/check.txt", contents: "artifact [REDACTED]" }],
      }),
    ]);
    expect(resultJson.scoring.evaluatorAgent).toMatchObject({
      providerName: "claude-code",
      model: "judge-model",
      status: "success",
      result: { criteria: [{ id: "maintainability", score: 4, rationale: "Clear implementation." }], summary: "Good work." },
    });
  });

  it("records failing checks, timeouts, and malformed evaluator-agent JSON as scoring failures", async () => {
    const suiteRoot = await makeTempDir();
    await writeFixtureFile(suiteRoot, "prompts/task.md", "# Task\n");
    await writeFixtureFile(suiteRoot, "starter/README.md", "starter\n");
    await writeFixtureFile(suiteRoot, "acceptance/hidden/fail.mjs", "console.error('failed check'); process.exit(7);\n");
    await writeFixtureFile(suiteRoot, "acceptance/hidden/timeout.mjs", "setTimeout(() => {}, 1000);\n");
    await writeFixtureFile(suiteRoot, "rubrics/quality.md", "# Quality\n");

    await executeEvalTrials({
      suiteRoot,
      resultsRoot: path.join(suiteRoot, "results", "failures"),
      config: {
        sandbox: { provider: "docker" },
        agents: [{ id: "agent", provider: "opencode" }],
        evaluatorAgent: { id: "evaluator", provider: "opencode" },
        tasks: [
          {
            id: "task",
            prompt: "prompts/task.md",
            starter: "starter",
            acceptanceMaterial: {
              hiddenDir: "acceptance/hidden",
              checks: [
                { id: "fails", command: "node acceptance/hidden/fail.mjs", timeoutMs: 500, weight: 1 },
                { id: "times-out", command: "node acceptance/hidden/timeout.mjs", timeoutMs: 50, weight: 1 },
              ],
              rubrics: [{ id: "quality", path: "rubrics/quality.md", weight: 1, scale: { min: 1, max: 5 } }],
            },
          },
        ],
        scenarioVariants: [{ id: "baseline" }],
        matrix: { runIndexes: [1] },
      },
      sandcastleExecutor: async () => ({ stdout: "ok", commits: [], iterations: [] }),
      evaluatorAgentExecutor: async () => ({ stdout: "not json" }),
    });

    const resultJson = JSON.parse(await readFile(path.join(suiteRoot, "results", "failures", "agent__task__baseline__1", "result.json"), "utf8"));
    expect(resultJson.status).toBe("failed");
    expect(resultJson.scoring.acceptanceChecks).toEqual([
      expect.objectContaining({ id: "fails", exitCode: 7, timedOut: false, stderr: "failed check\n" }),
      expect.objectContaining({ id: "times-out", exitCode: null, timedOut: true }),
    ]);
    expect(resultJson.scoring.evaluatorAgent).toEqual(expect.objectContaining({ status: "failed", error: expect.stringContaining("valid JSON") }));
  });

  it("records evaluator-agent mutations of read-only scoring context as scoring failures", async () => {
    const suiteRoot = await makeTempDir();
    await writeFixtureFile(suiteRoot, "prompts/task.md", "# Task\n");
    await writeFixtureFile(suiteRoot, "starter/README.md", "starter\n");
    await writeFixtureFile(suiteRoot, "acceptance/hidden/pass.mjs", "console.log('pass');\n");
    await writeFixtureFile(suiteRoot, "rubrics/quality.md", "# Quality\n");

    await executeEvalTrials({
      suiteRoot,
      resultsRoot: path.join(suiteRoot, "results", "readonly"),
      config: {
        sandbox: { provider: "docker" },
        agents: [{ id: "agent", provider: "opencode" }],
        evaluatorAgent: { id: "evaluator", provider: "opencode" },
        tasks: [
          {
            id: "task",
            prompt: "prompts/task.md",
            starter: "starter",
            acceptanceMaterial: {
              hiddenDir: "acceptance/hidden",
              checks: [{ id: "passes", command: "node acceptance/hidden/pass.mjs", timeoutMs: 500, weight: 1 }],
              rubrics: [{ id: "quality", path: "rubrics/quality.md", weight: 1, scale: { min: 1, max: 5 } }],
            },
          },
        ],
        scenarioVariants: [{ id: "baseline" }],
        matrix: { runIndexes: [1] },
      },
      sandcastleExecutor: async (input) => {
        await writeFixtureFile(input.worktreePath, "solution.txt", "completed work\n");
        return { stdout: "ok", commits: [], iterations: [] };
      },
      evaluatorAgentExecutor: async (input) => {
        await writeFixtureFile(input.scoringContextPath, "solution.txt", "mutated by evaluator\n");
        return { stdout: JSON.stringify({ criteria: [{ id: "quality", score: 5, rationale: "Looks good." }], summary: "Passed." }) };
      },
    });

    const resultJson = JSON.parse(await readFile(path.join(suiteRoot, "results", "readonly", "agent__task__baseline__1", "result.json"), "utf8"));
    expect(resultJson.status).toBe("failed");
    expect(resultJson.scoring.evaluatorAgent).toEqual(expect.objectContaining({ status: "failed", error: expect.stringContaining("read-only scoring context") }));
    expect(resultJson.worktree.preserved).toBe(true);
    await expect(readFile(path.join(resultJson.worktree.worktreePath, "solution.txt"), "utf8")).resolves.toBe("completed work\n");
  });

  it("aggregates eval score, normalized usage, matched cost, and immutable artifact manifests", async () => {
    const suiteRoot = await makeTempDir();
    await writeFixtureFile(suiteRoot, "prompts/task.md", "# Task\n");
    await writeFixtureFile(suiteRoot, "prompts/evaluator.md", "# Evaluator Agent\n");
    await writeFixtureFile(suiteRoot, "starter/README.md", "starter\n");
    await writeFixtureFile(suiteRoot, "acceptance/hidden/pass.mjs", "console.log('pass');\n");
    await writeFixtureFile(suiteRoot, "rubrics/quality.md", "# Quality\n");

    await executeEvalTrials({
      suiteRoot,
      resultsRoot: path.join(suiteRoot, "results", "aggregation"),
      config: {
        sandbox: { provider: "docker" },
        agents: [{ id: "agent", provider: "opencode", model: "model-a" }],
        evaluatorAgent: { id: "evaluator", provider: "claude-code", model: "judge-model", prompt: "prompts/evaluator.md" },
        pricing: [
          { id: "agent-price", provider: "opencode", model: "model-a", inputPerMillion: 2, cacheReadPerMillion: 0.5, cacheWritePerMillion: 3, outputPerMillion: 8 },
          { id: "evaluator-price", provider: "claude-code", model: "judge-model", inputPerMillion: 1, outputPerMillion: 4 },
        ],
        tasks: [
          {
            id: "task",
            prompt: "prompts/task.md",
            starter: "starter",
            scoring: { deterministicWeight: 0.7, rubricWeight: 0.3 },
            acceptanceMaterial: {
              hiddenDir: "acceptance/hidden",
              checks: [{ id: "passes", command: "node acceptance/hidden/pass.mjs", weight: 1, artifacts: ["reports/*.txt"] }],
              rubrics: [{ id: "quality", path: "rubrics/quality.md", weight: 1, scale: { min: 1, max: 5 } }],
            },
          },
        ],
        scenarioVariants: [{ id: "baseline" }],
        matrix: { runIndexes: [1] },
      },
      sandcastleExecutor: async (input) => {
        await writeFixtureFile(input.worktreePath, "reports/output.txt", "visible artifact\n");
        return {
          stdout: "ok",
          logs: "agent logs",
          commits: [{ sha: "sha1" }],
          diff: "diff --git a/reports/output.txt b/reports/output.txt",
          providerMetadata: { provider: "opencode", model: "model-a" },
          iterations: [
            { usage: { inputTokens: 10, cacheReadInputTokens: 2, cacheCreationInputTokens: 1, outputTokens: 3, reasoningTokens: 4 } },
            { usage: { inputTokens: 5, outputTokens: 7, vendorSpecific: 9 } },
          ],
        };
      },
      evaluatorAgentExecutor: async () => ({
        stdout: JSON.stringify({ criteria: [{ id: "quality", score: 4, rationale: "Solid." }], summary: "Good." }),
      }),
    });

    const artifactRoot = path.join(suiteRoot, "results", "aggregation", "agent__task__baseline__1");
    const resultJson = JSON.parse(await readFile(path.join(artifactRoot, "result.json"), "utf8"));
    expect(resultJson.evalScore).toEqual({
      value: 0.925,
      deterministic: { value: 1, weight: 0.7, contribution: 0.7, checksFailed: false },
      rubric: { value: 0.75, weight: 0.3, contribution: 0.225, counted: true },
      formula: "deterministicWeight * deterministicScore + rubricWeight * rubricScore; rubric contribution is not counted when deterministic checks fail",
    });
    expect(resultJson.usage.agent).toEqual({
      provider: "opencode",
      model: "model-a",
      inputTokens: 15,
      cacheReadTokens: 2,
      cacheWriteTokens: 1,
      outputTokens: 10,
      unknown: { reasoningTokens: 4, vendorSpecific: 9 },
    });
    expect(resultJson.cost.agent).toEqual({
      matchedPricingId: "agent-price",
      estimatedUsd: 0.000114,
      inputs: { inputTokens: 15, cacheReadTokens: 2, cacheWriteTokens: 1, outputTokens: 10 },
    });
    expect(resultJson.cost.evaluatorAgent).toEqual({ status: "unavailable", reason: "usage unavailable" });

    await expect(readFile(path.join(artifactRoot, "config.json"), "utf8")).resolves.toContain('"pricing"');
    await expect(readFile(path.join(artifactRoot, "diff.patch"), "utf8")).resolves.toContain("reports/output.txt");
    await expect(readFile(path.join(artifactRoot, "commits.json"), "utf8")).resolves.toContain("sha1");
    await expect(readFile(path.join(artifactRoot, "usage.json"), "utf8")).resolves.toContain("cacheReadTokens");
    await expect(readFile(path.join(artifactRoot, "cost.json"), "utf8")).resolves.toContain("agent-price");
    await expect(readFile(path.join(artifactRoot, "acceptance-output.json"), "utf8")).resolves.toContain("passes");
    await expect(readFile(path.join(artifactRoot, "evaluator-rationale.json"), "utf8")).resolves.toContain("Solid.");
    const manifest = JSON.parse(await readFile(path.join(artifactRoot, "artifact-manifest.json"), "utf8"));
    expect(manifest.files).toEqual([
      "acceptance-output.json",
      "artifact-manifest.json",
      "commits.json",
      "config.json",
      "cost.json",
      "diff.patch",
      "evaluator-rationale.json",
      "prompt.md",
      "result.json",
      "sandcastle.log",
      "timings.json",
      "usage.json",
    ]);
  });

  it("does not count evaluator-agent rubric contribution when deterministic checks fail and records missing pricing", async () => {
    const suiteRoot = await makeTempDir();
    await writeFixtureFile(suiteRoot, "prompts/task.md", "# Task\n");
    await writeFixtureFile(suiteRoot, "starter/README.md", "starter\n");
    await writeFixtureFile(suiteRoot, "acceptance/hidden/pass.mjs", "console.log('pass');\n");
    await writeFixtureFile(suiteRoot, "acceptance/hidden/fail.mjs", "process.exit(1);\n");
    await writeFixtureFile(suiteRoot, "rubrics/quality.md", "# Quality\n");

    await executeEvalTrials({
      suiteRoot,
      resultsRoot: path.join(suiteRoot, "results", "deterministic-failure"),
      config: {
        sandbox: { provider: "docker" },
        agents: [{ id: "agent", provider: "opencode", model: "unpriced-model" }],
        evaluatorAgent: { id: "evaluator", provider: "opencode" },
        pricing: [{ id: "other-price", provider: "opencode", model: "other-model", inputPerMillion: 1, outputPerMillion: 1 }],
        tasks: [
          {
            id: "task",
            prompt: "prompts/task.md",
            starter: "starter",
            scoring: { deterministicWeight: 0.6, rubricWeight: 0.4 },
            acceptanceMaterial: {
              hiddenDir: "acceptance/hidden",
              checks: [
                { id: "passes", command: "node acceptance/hidden/pass.mjs", weight: 3 },
                { id: "fails", command: "node acceptance/hidden/fail.mjs", weight: 1 },
              ],
              rubrics: [{ id: "quality", path: "rubrics/quality.md", weight: 1, scale: { min: 0, max: 10 } }],
            },
          },
        ],
        scenarioVariants: [{ id: "baseline" }],
        matrix: { runIndexes: [1] },
      },
      sandcastleExecutor: async () => ({
        stdout: "ok",
        iterations: [{ usage: { inputTokens: 100, outputTokens: 50 } }],
      }),
      evaluatorAgentExecutor: async () => ({
        stdout: JSON.stringify({ criteria: [{ id: "quality", score: 10, rationale: "Perfect rubric score." }], summary: "Rubric passed." }),
      }),
    });

    const resultJson = JSON.parse(await readFile(path.join(suiteRoot, "results", "deterministic-failure", "agent__task__baseline__1", "result.json"), "utf8"));
    expect(resultJson.status).toBe("failed");
    expect(resultJson.evalScore).toEqual({
      value: 0.45,
      deterministic: { value: 0.75, weight: 0.6, contribution: 0.45, checksFailed: true },
      rubric: { value: 1, weight: 0.4, contribution: 0, counted: false },
      formula: "deterministicWeight * deterministicScore + rubricWeight * rubricScore; rubric contribution is not counted when deterministic checks fail",
    });
    expect(resultJson.cost.agent).toEqual({ status: "unavailable", reason: "matching pricing not configured", provider: "opencode", model: "unpriced-model" });
    expect(resultJson.worktree.preserved).toBe(true);
    await expect(readFile(path.join(resultJson.worktree.worktreePath, "acceptance", "hidden", "fail.mjs"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    const reportJson = JSON.parse(await readFile(path.join(suiteRoot, "results", "deterministic-failure", "report.json"), "utf8"));
    expect(reportJson.summary).toEqual({ evalTrials: 1, successful: 0, failed: 1 });
    expect(reportJson.trials[0]).toMatchObject({
      evalTrialId: "agent__task__baseline__1",
      status: "failed",
      preservedWorktreePath: resultJson.worktree.worktreePath,
    });
  });

  it("fails run-id collisions instead of overwriting existing result directories", async () => {
    const suiteRoot = await makeTempDir();
    await writeFixtureFile(suiteRoot, "prompts/task.md", "# Task\n");
    await writeFixtureFile(suiteRoot, "starter/README.md", "starter\n");
    const resultsRoot = path.join(suiteRoot, "results", "collision");
    await mkdir(resultsRoot, { recursive: true });
    await writeFixtureFile(resultsRoot, "sentinel.txt", "must remain\n");

    await expect(
      executeEvalTrials({
        suiteRoot,
        resultsRoot,
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
    await expect(readFile(path.join(resultsRoot, "sentinel.txt"), "utf8")).resolves.toBe("must remain\n");
  });

  it("maps the Sandcastle built-in adapter contract without invoking a model", async () => {
    const worktreePath = await makeTempDir();
    await writeFixtureFile(worktreePath, "README.md", "before\n");
    await execFileAsync("git", ["init"], { cwd: worktreePath });
    await execFileAsync("git", ["config", "user.email", "test@example.invalid"], { cwd: worktreePath });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: worktreePath });
    await execFileAsync("git", ["add", "."], { cwd: worktreePath });
    await execFileAsync("git", ["commit", "-m", "baseline"], { cwd: worktreePath });
    const runCalls: unknown[] = [];
    const dockerCalls: unknown[] = [];
    const executor = createSandcastleBuiltInExecutor({
      providers: { "claude-code": (model?: string, options?: { env?: Record<string, string> }) => ({ name: "claude", model, env: options?.env }) },
      docker: (options: unknown) => {
        dockerCalls.push(options);
        return { name: "docker", tag: "bind-mount", env: {} };
      },
      noSandbox: () => ({ name: "local" }),
      run: async (options: unknown) => {
        runCalls.push(options);
        await writeFixtureFile(worktreePath, "README.md", "after\n");
        return {
          stdout: "stdout",
          commits: [{ sha: "sha1" }],
          branch: "main",
          logFilePath: undefined,
          iterations: [{ usage: { inputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 2 } }],
        };
      },
    });

    const result = await executor({
      evalTrialId: "claude__task__baseline__1",
      providerName: "claude-code",
      model: "claude-opus-4-7",
      sandboxProvider: "docker",
      branchStrategy: "head",
      prompt: "# Task\n",
      worktreePath,
      agentHomePath: "/tmp/agent-home",
      logPath: "/tmp/log.txt",
      env: { OPENCODE_API_KEY: "test-key" },
    });

    expect(dockerCalls).toEqual([{ mounts: [{ hostPath: "/tmp/agent-home", sandboxPath: "/home/agent" }] }]);
    expect(runCalls).toEqual([
      expect.objectContaining({
        agent: { name: "claude", model: "claude-opus-4-7", env: { OPENCODE_API_KEY: "test-key" } },
        sandbox: { name: "docker", tag: "bind-mount", env: {} },
        cwd: worktreePath,
        prompt: "# Task\n",
        logging: { type: "file", path: "/tmp/log.txt" },
        branchStrategy: { type: "head" },
      }),
    ]);
    expect(result).toMatchObject({
      stdout: "stdout",
      commits: [{ sha: "sha1" }],
      diff: expect.stringContaining("after"),
      branch: "main",
      providerMetadata: { provider: "claude-code", model: "claude-opus-4-7" },
      iterations: [{ usage: { inputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 2 } }],
    });
  });
});
