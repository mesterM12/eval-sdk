import { describe, expect, it } from "vitest";
import { scoreEvalTrialFacts } from "../src/scoring.js";
import type { AcceptanceCheckResult } from "../src/acceptance-material-sandbox.js";
import type { EvalSuiteConfig } from "../src/eval-suite-config.js";

const formula = "deterministicWeight * deterministicScore + rubricWeight * rubricScore; rubric contribution is not counted when deterministic checks fail";

function check(overrides: Partial<AcceptanceCheckResult> = {}): AcceptanceCheckResult {
  return {
    id: "check",
    command: "npm test",
    cwd: ".",
    timeoutMs: 1000,
    weight: 1,
    stdout: "",
    stderr: "",
    exitCode: 0,
    timedOut: false,
    durationMs: 1,
    artifacts: [],
    ...overrides,
  };
}

function task(overrides: Partial<EvalSuiteConfig["tasks"][number]> = {}): EvalSuiteConfig["tasks"][number] {
  return {
    id: "task",
    prompt: "prompts/task.md",
    starter: "starter",
    scoring: { deterministicWeight: 0.7, rubricWeight: 0.3 },
    acceptanceMaterial: {
      hiddenDir: "acceptance/hidden",
      checks: [],
      rubrics: [{ id: "quality", path: "rubrics/quality.md", weight: 1, scale: { min: 1, max: 5 } }],
    },
    ...overrides,
  };
}

describe("Eval Score and cost scoring module", () => {
  it("aggregates deterministic and rubric weights for passing Eval Trials", () => {
    const facts = scoreEvalTrialFacts({
      agent: { id: "agent", provider: "opencode", model: "model-a" },
      task: task(),
      acceptanceChecks: [check()],
      evaluatorAgent: { status: "success", result: { criteria: [{ id: "quality", score: 4, rationale: "Solid." }], summary: "Good." } },
      iterations: [],
      pricing: [],
    });

    expect(facts.evalScore).toEqual({
      value: 0.925,
      deterministic: { value: 1, weight: 0.7, contribution: 0.7, checksFailed: false },
      rubric: { value: 0.75, weight: 0.3, contribution: 0.225, counted: true },
      formula,
    });
  });

  it("protects ADR-0001 by not counting rubric contribution when deterministic Acceptance Material fails", () => {
    const facts = scoreEvalTrialFacts({
      agent: { id: "agent", provider: "opencode", model: "model-a" },
      task: task({ scoring: { deterministicWeight: 0.6, rubricWeight: 0.4 }, acceptanceMaterial: { hiddenDir: "acceptance/hidden", checks: [], rubrics: [{ id: "quality", path: "rubrics/quality.md", weight: 1, scale: { min: 0, max: 10 } }] } }),
      acceptanceChecks: [check({ id: "passes", weight: 3 }), check({ id: "fails", weight: 1, exitCode: 1 })],
      evaluatorAgent: { status: "success", result: { criteria: [{ id: "quality", score: 10, rationale: "Perfect." }], summary: "Rubric passed." } },
      iterations: [],
      pricing: [],
    });

    expect(facts.evalScore).toEqual({
      value: 0.45,
      deterministic: { value: 0.75, weight: 0.6, contribution: 0.45, checksFailed: true },
      rubric: { value: 1, weight: 0.4, contribution: 0, counted: false },
      formula,
    });
  });

  it("normalizes empty usage as unavailable and keeps cost unavailable", () => {
    const facts = scoreEvalTrialFacts({
      agent: { id: "agent", provider: "opencode", model: "model-a" },
      task: task(),
      acceptanceChecks: [],
      evaluatorAgent: { status: "skipped" },
      iterations: [],
      pricing: [],
    });

    expect(facts.usage).toEqual({ agent: { status: "unavailable", reason: "provider usage unavailable", provider: "opencode", model: "model-a" } });
    expect(facts.cost).toEqual({ agent: { status: "unavailable", reason: "usage unavailable" }, evaluatorAgent: { status: "unavailable", reason: "usage unavailable" } });
  });

  it("normalizes known and unknown usage fields and estimates matching pricing with rounding", () => {
    const facts = scoreEvalTrialFacts({
      agent: { id: "agent", provider: "opencode", model: "model-a" },
      task: task(),
      acceptanceChecks: [check()],
      evaluatorAgent: { status: "skipped" },
      iterations: [
        { usage: { inputTokens: 10, cacheReadInputTokens: 2, cacheCreationInputTokens: 1, outputTokens: 3, reasoningTokens: 4 } },
        { usage: { inputTokens: 5, cacheWriteInputTokens: 2, outputTokens: 7, vendorSpecific: 9, ignored: "not numeric" } },
      ],
      pricing: [{ id: "agent-price", provider: "opencode", model: "model-a", inputPerMillion: 2, cacheReadPerMillion: 0.5, cacheWritePerMillion: 3, outputPerMillion: 8 }],
    });

    expect(facts.usage.agent).toEqual({
      provider: "opencode",
      model: "model-a",
      inputTokens: 15,
      cacheReadTokens: 2,
      cacheWriteTokens: 3,
      outputTokens: 10,
      unknown: { reasoningTokens: 4, vendorSpecific: 9 },
    });
    expect(facts.cost.agent).toEqual({
      matchedPricingId: "agent-price",
      estimatedUsd: 0.00012,
      inputs: { inputTokens: 15, cacheReadTokens: 2, cacheWriteTokens: 3, outputTokens: 10 },
    });
  });

  it("records missing pricing without changing usage shape", () => {
    const facts = scoreEvalTrialFacts({
      agent: { id: "agent", provider: "opencode", model: "unpriced-model" },
      task: task(),
      acceptanceChecks: [check()],
      evaluatorAgent: { status: "skipped" },
      iterations: [{ usage: { inputTokens: 100, outputTokens: 50 } }],
      pricing: [{ id: "other-price", provider: "opencode", model: "other-model", inputPerMillion: 1, outputPerMillion: 1 }],
    });

    expect(facts.cost.agent).toEqual({ status: "unavailable", reason: "matching pricing not configured", provider: "opencode", model: "unpriced-model" });
  });
});
