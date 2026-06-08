import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { generateReports } from "../src/report.js";

async function makeResultsRoot() {
  return mkdtemp(path.join(tmpdir(), "coding-agent-eval-report-"));
}

async function writeJsonFixture(root: string, relativePath: string, value: unknown) {
  const filePath = path.join(root, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

describe("Eval Trial reports", () => {
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
