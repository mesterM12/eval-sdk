import { describe, expect, it } from "vitest";
import { createEvalTrialId, parseEvalTrialId } from "../src/eval-trial-identity.js";

describe("Eval Trial identity", () => {
  it("creates deterministic artifact-safe Eval Trial ids", () => {
    expect(
      createEvalTrialId({
        agentId: "opencode",
        taskId: "fix-bug",
        scenarioVariantId: "baseline",
        runIndex: 2,
      })
    ).toBe("opencode__fix-bug__baseline__2");
  });

  it("parses deterministic Eval Trial ids", () => {
    expect(parseEvalTrialId("opencode__fix-bug__baseline__2")).toEqual({
      agentId: "opencode",
      taskId: "fix-bug",
      scenarioVariantId: "baseline",
      runIndex: 2,
    });
  });

  it("rejects invalid and ambiguous Eval Trial ids", () => {
    expect(() => parseEvalTrialId("opencode__fix-bug__baseline")).toThrow(/invalid Eval Trial id/);
    expect(() => parseEvalTrialId("opencode__fix__bug__baseline__1")).toThrow(/ambiguous Eval Trial id/);
    expect(() => createEvalTrialId({ agentId: "opencode", taskId: "fix__bug", scenarioVariantId: "baseline", runIndex: 1 })).toThrow(/ambiguous Eval Trial id/);
    expect(() => createEvalTrialId({ agentId: "opencode", taskId: "fix/bug", scenarioVariantId: "baseline", runIndex: 1 })).toThrow(/artifact-safe/);
    expect(() => createEvalTrialId({ agentId: "opencode", taskId: "fix-bug", scenarioVariantId: "baseline", runIndex: 0 })).toThrow(/positive integer/);
  });
});
