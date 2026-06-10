import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readEvalTrialArtifacts } from "../src/eval-trial-artifacts.js";
import { runEvalTrialLifecycle } from "../src/eval-trial-lifecycle.js";
import { generateReports } from "../src/report.js";

async function makeResultsRoot() {
  return mkdtemp(path.join(tmpdir(), "coding-agent-eval-report-"));
}

async function writeJsonFixture(root: string, relativePath: string, value: unknown) {
  const filePath = path.join(root, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeFixtureFile(root: string, relativePath: string, contents: string) {
  const filePath = path.join(root, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, contents, "utf8");
}

describe("Eval Trial reports", () => {
  it("reads lifecycle-written Eval Trial artifacts through the shared artifact contract", async () => {
    const suiteRoot = await makeResultsRoot();
    const resultsRoot = path.join(suiteRoot, "results");
    const tempRoot = path.join(suiteRoot, "tmp");
    await mkdir(resultsRoot, { recursive: true });
    await writeFixtureFile(suiteRoot, "prompts/task.md", "# Task\n");
    await writeFixtureFile(suiteRoot, "starter/README.md", "starter\n");

    await runEvalTrialLifecycle({
      suiteRoot,
      tempRoot,
      resultsRoot,
      config: {
        sandbox: { provider: "docker" },
        agents: [{ id: "agent", provider: "opencode" }],
        tasks: [{ id: "task", prompt: "prompts/task.md", starter: "starter" }],
        scenarioVariants: [{ id: "baseline" }],
        matrix: { runIndexes: [1] },
      },
      evalTrial: { id: "agent__task__baseline__1", agentId: "agent", taskId: "task", scenarioVariantId: "baseline", runIndex: 1 },
      sandcastleExecutor: async (input) => {
        await writeFixtureFile(input.worktreePath, "README.md", "changed\n");
        return { stdout: "ok", commits: [], diff: "diff", iterations: [] };
      },
    });

    const artifactRoot = path.join(resultsRoot, "agent__task__baseline__1");
    await expect(readEvalTrialArtifacts(artifactRoot)).resolves.toMatchObject({ result: { evalTrialId: "agent__task__baseline__1", status: "success" } });

    const report = await generateReports(resultsRoot);

    expect(report.trials).toEqual([expect.objectContaining({ evalTrialId: "agent__task__baseline__1", status: "success" })]);
  });

  it("matches baseline Scenario Variant through parsed Eval Trial identities", async () => {
    const resultsRoot = await makeResultsRoot();
    const config = { matrix: { baselineScenarioVariant: "baseline" } };
    const baselineResult = { evalTrialId: "agent__task__baseline__1", status: "success", evalScore: { value: 0.7 } };
    const scenarioResult = { evalTrialId: "agent__task__skills__1", status: "success", evalScore: { value: 0.9 } };

    await writeJsonFixture(resultsRoot, "agent__task__baseline__1/config.json", config);
    await writeJsonFixture(resultsRoot, "agent__task__baseline__1/result.json", baselineResult);
    await writeJsonFixture(resultsRoot, "agent__task__skills__1/config.json", config);
    await writeJsonFixture(resultsRoot, "agent__task__skills__1/result.json", scenarioResult);

    const report = await generateReports(resultsRoot);

    expect(report.trials.find((trial) => trial.evalTrialId === "agent__task__skills__1")?.baselineDelta).toEqual({
      status: "matched",
      baselineEvalTrialId: "agent__task__baseline__1",
      evalScoreDelta: 0.2,
    });
  });

  it("handles ambiguous Eval Trial ids explicitly instead of reporting misleading identities", async () => {
    const resultsRoot = await makeResultsRoot();
    const config = { matrix: { baselineScenarioVariant: "baseline" } };
    const result = { evalTrialId: "agent__task__with__delimiter__1", status: "success", evalScore: { value: 0.9 } };

    await writeJsonFixture(resultsRoot, "agent__task__with__delimiter__1/config.json", config);
    await writeJsonFixture(resultsRoot, "agent__task__with__delimiter__1/result.json", result);

    const report = await generateReports(resultsRoot);

    expect(report.trials[0]).toMatchObject({
      agentId: "unknown",
      taskId: "unknown",
      scenarioVariantId: "unknown",
      runIndex: 0,
      failure: "ambiguous Eval Trial id: agent__task__with__delimiter__1",
      baselineDelta: null,
    });
  });
});
