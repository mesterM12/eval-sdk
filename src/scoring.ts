import type { AcceptanceCheckResult } from "./acceptance-material-sandbox.js";
import type { EvaluatorAgentJson, EvaluatorAgentScoringResult } from "./evaluator-agent.js";
import type { EvalSuiteConfig } from "./eval-suite-config.js";

type RubricConfig = EvalSuiteConfig["tasks"][number]["acceptanceMaterial"]["rubrics"][number];

export type NormalizedUsage =
  | {
      provider?: string;
      model?: string;
      inputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
      outputTokens: number;
      unknown: Record<string, number>;
    }
  | { status: "unavailable"; reason: string; provider?: string; model?: string };

export function scoreEvalTrialFacts(input: {
  agent: EvalSuiteConfig["agents"][number];
  task: EvalSuiteConfig["tasks"][number];
  acceptanceChecks: AcceptanceCheckResult[];
  evaluatorAgent: EvaluatorAgentScoringResult;
  iterations?: Array<Record<string, unknown>>;
  pricing: EvalSuiteConfig["pricing"] | undefined;
}) {
  const usage = { agent: normalizeUsage(input.agent.provider, input.agent.model, input.iterations) };
  return {
    evalScore: aggregateEvalScore(input.task, input.acceptanceChecks, input.evaluatorAgent),
    usage,
    cost: { agent: estimateCost(usage.agent, input.pricing), evaluatorAgent: { status: "unavailable", reason: "usage unavailable" } },
  };
}

function aggregateEvalScore(task: EvalSuiteConfig["tasks"][number], acceptanceChecks: AcceptanceCheckResult[], evaluatorAgent: EvaluatorAgentScoringResult) {
  const deterministicWeight = task.scoring?.deterministicWeight ?? 1;
  const rubricWeight = task.scoring?.rubricWeight ?? 0;
  const deterministicScore = weightedAverage(
    acceptanceChecks.map((check) => ({ weight: check.weight, value: check.exitCode === 0 && !check.timedOut ? 1 : 0 })),
    1
  );
  const checksFailed = acceptanceChecks.some((check) => check.exitCode !== 0 || check.timedOut);
  const rubricScore = evaluatorAgent.status === "success" ? rubricAverage(task.acceptanceMaterial?.rubrics ?? [], evaluatorAgent.result.criteria) : 0;
  const deterministicContribution = roundScore(deterministicWeight * deterministicScore);
  const rubricCounted = !checksFailed;
  const rubricContribution = rubricCounted ? roundScore(rubricWeight * rubricScore) : 0;
  return {
    value: roundScore(deterministicContribution + rubricContribution),
    deterministic: { value: roundScore(deterministicScore), weight: deterministicWeight, contribution: deterministicContribution, checksFailed },
    rubric: { value: roundScore(rubricScore), weight: rubricWeight, contribution: rubricContribution, counted: rubricCounted },
    formula: "deterministicWeight * deterministicScore + rubricWeight * rubricScore; rubric contribution is not counted when deterministic checks fail",
  };
}

function rubricAverage(rubrics: RubricConfig[], criteria: EvaluatorAgentJson["criteria"]) {
  const criteriaById = new Map(criteria.map((criterion) => [criterion.id, criterion]));
  return weightedAverage(
    rubrics.map((rubric) => {
      const criterion = criteriaById.get(requireString(rubric.id, "rubric id"));
      return { weight: rubric.weight ?? 1, value: criterion ? normalizeRubricScore(criterion.score, rubric.scale) : 0 };
    }),
    0
  );
}

function normalizeRubricScore(score: number, scale: RubricConfig["scale"]) {
  const min = scale?.min ?? 0;
  const max = scale?.max ?? 1;
  if (max === min) return 0;
  return Math.max(0, Math.min(1, (score - min) / (max - min)));
}

function weightedAverage(items: Array<{ weight: number; value: number }>, emptyValue: number) {
  if (items.length === 0) return emptyValue;
  const totalWeight = items.reduce((total, item) => total + item.weight, 0);
  if (totalWeight === 0) return emptyValue;
  return items.reduce((total, item) => total + item.weight * item.value, 0) / totalWeight;
}

function normalizeUsage(provider?: string, model?: string, iterations?: Array<Record<string, unknown>>): NormalizedUsage {
  const usageObjects = (iterations ?? []).map((iteration) => iteration.usage).filter((usage): usage is Record<string, unknown> => Boolean(usage) && typeof usage === "object" && !Array.isArray(usage));
  if (usageObjects.length === 0) return { status: "unavailable", reason: "provider usage unavailable", provider, model };

  const normalized = { provider, model, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, unknown: {} as Record<string, number> };
  const known = new Set(["inputTokens", "cacheReadInputTokens", "cacheCreationInputTokens", "cacheWriteInputTokens", "outputTokens"]);
  for (const usage of usageObjects) {
    normalized.inputTokens += numericUsage(usage.inputTokens);
    normalized.cacheReadTokens += numericUsage(usage.cacheReadInputTokens);
    normalized.cacheWriteTokens += numericUsage(usage.cacheCreationInputTokens) + numericUsage(usage.cacheWriteInputTokens);
    normalized.outputTokens += numericUsage(usage.outputTokens);
    for (const [key, value] of Object.entries(usage)) {
      if (known.has(key)) continue;
      if (typeof value === "number" && Number.isFinite(value)) normalized.unknown[key] = (normalized.unknown[key] ?? 0) + value;
    }
  }
  return normalized;
}

function numericUsage(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function estimateCost(usage: NormalizedUsage, pricing: EvalSuiteConfig["pricing"] | undefined) {
  if ("status" in usage) return { status: "unavailable", reason: "usage unavailable" };
  const price = pricing?.find((entry) => entry.provider === usage.provider && entry.model === usage.model);
  if (!price) return { status: "unavailable", reason: "matching pricing not configured", provider: usage.provider, model: usage.model };
  const estimatedUsd =
    (usage.inputTokens * (price.inputPerMillion ?? 0) +
      usage.cacheReadTokens * (price.cacheReadPerMillion ?? 0) +
      usage.cacheWriteTokens * (price.cacheWritePerMillion ?? 0) +
      usage.outputTokens * (price.outputPerMillion ?? 0)) /
    1_000_000;
  return {
    matchedPricingId: price.id,
    estimatedUsd: roundCost(estimatedUsd),
    inputs: {
      inputTokens: usage.inputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      outputTokens: usage.outputTokens,
    },
  };
}

function roundScore(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function roundCost(value: number) {
  return Math.round(value * 1_000_000_000_000) / 1_000_000_000_000;
}

function requireString(value: unknown, label: string) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} is required`);
  return value;
}
