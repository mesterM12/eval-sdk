import { describe, expect, it } from "vitest";
import { expandTrialMatrix } from "../src/trial-matrix.js";

describe("trial matrix expansion", () => {
  it("creates eval trials from the Cartesian product with stable ids", () => {
    const evalTrials = expandTrialMatrix({
      agents: [{ id: "claude" }, { id: "opencode" }],
      tasks: [{ id: "fix-bug" }],
      scenarioVariants: [{ id: "baseline" }, { id: "skills" }],
      runIndexes: [1],
    });

    expect(evalTrials).toEqual([
      { id: "claude__fix-bug__baseline__1", agentId: "claude", taskId: "fix-bug", scenarioVariantId: "baseline", runIndex: 1 },
      { id: "claude__fix-bug__skills__1", agentId: "claude", taskId: "fix-bug", scenarioVariantId: "skills", runIndex: 1 },
      { id: "opencode__fix-bug__baseline__1", agentId: "opencode", taskId: "fix-bug", scenarioVariantId: "baseline", runIndex: 1 },
      { id: "opencode__fix-bug__skills__1", agentId: "opencode", taskId: "fix-bug", scenarioVariantId: "skills", runIndex: 1 },
    ]);
  });

  it("expands multiple run indexes", () => {
    const evalTrials = expandTrialMatrix({
      agents: [{ id: "claude" }],
      tasks: [{ id: "fix-bug" }],
      scenarioVariants: [{ id: "baseline" }],
      runIndexes: [1, 2, 3],
    });

    expect(evalTrials.map((evalTrial) => evalTrial.id)).toEqual([
      "claude__fix-bug__baseline__1",
      "claude__fix-bug__baseline__2",
      "claude__fix-bug__baseline__3",
    ]);
  });

  it("adds include-only eval trials without changing the Cartesian trial matrix shape", () => {
    const evalTrials = expandTrialMatrix({
      agents: [{ id: "claude" }],
      tasks: [{ id: "fix-bug" }],
      scenarioVariants: [{ id: "baseline" }],
      runIndexes: [1],
      include: [{ agent: "claude", task: "fix-bug", scenarioVariant: "baseline", runIndex: 2 }],
    });

    expect(evalTrials.map((evalTrial) => evalTrial.id)).toEqual([
      "claude__fix-bug__baseline__1",
      "claude__fix-bug__baseline__2",
    ]);
  });

  it("removes excluded eval trials from the Cartesian trial matrix", () => {
    const evalTrials = expandTrialMatrix({
      agents: [{ id: "claude" }],
      tasks: [{ id: "fix-bug" }],
      scenarioVariants: [{ id: "baseline" }, { id: "skills" }],
      runIndexes: [1],
      exclude: [{ agent: "claude", task: "fix-bug", scenarioVariant: "skills", runIndex: 1 }],
    });

    expect(evalTrials.map((evalTrial) => evalTrial.id)).toEqual(["claude__fix-bug__baseline__1"]);
  });

  it("applies excludes before include overrides", () => {
    const evalTrials = expandTrialMatrix({
      agents: [{ id: "claude" }],
      tasks: [{ id: "fix-bug" }],
      scenarioVariants: [{ id: "baseline" }],
      runIndexes: [1],
      exclude: [{ agent: "claude", task: "fix-bug", scenarioVariant: "baseline", runIndex: 1 }],
      include: [{ agent: "claude", task: "fix-bug", scenarioVariant: "baseline", runIndex: 1 }],
    });

    expect(evalTrials.map((evalTrial) => evalTrial.id)).toEqual(["claude__fix-bug__baseline__1"]);
  });

  it("sorts output stably by eval trial id", () => {
    const evalTrials = expandTrialMatrix({
      agents: [{ id: "opencode" }, { id: "claude" }],
      tasks: [{ id: "z-task" }, { id: "a-task" }],
      scenarioVariants: [{ id: "skills" }, { id: "baseline" }],
      runIndexes: [2, 1],
    });

    expect(evalTrials.map((evalTrial) => evalTrial.id)).toEqual([
      "claude__a-task__baseline__1",
      "claude__a-task__baseline__2",
      "claude__a-task__skills__1",
      "claude__a-task__skills__2",
      "claude__z-task__baseline__1",
      "claude__z-task__baseline__2",
      "claude__z-task__skills__1",
      "claude__z-task__skills__2",
      "opencode__a-task__baseline__1",
      "opencode__a-task__baseline__2",
      "opencode__a-task__skills__1",
      "opencode__a-task__skills__2",
      "opencode__z-task__baseline__1",
      "opencode__z-task__baseline__2",
      "opencode__z-task__skills__1",
      "opencode__z-task__skills__2",
    ]);
  });

  it("expands from the validated config matrix shape", () => {
    const evalTrials = expandTrialMatrix({
      agents: [{ id: "claude" }],
      tasks: [{ id: "fix-bug" }],
      scenarioVariants: [{ id: "baseline" }],
      matrix: {
        runIndexes: [1],
        include: [{ agent: "claude", task: "fix-bug", scenarioVariant: "baseline", runIndex: 2 }],
        exclude: [{ agent: "claude", task: "fix-bug", scenarioVariant: "baseline", runIndex: 1 }],
      },
    });

    expect(evalTrials.map((evalTrial) => evalTrial.id)).toEqual(["claude__fix-bug__baseline__2"]);
  });
});
