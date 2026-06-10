import { readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { readEvalTrialArtifacts, type PersistedEvalTrialResult } from "./eval-trial-artifacts.js";
import { createEvalTrialId, parseEvalTrialId, type EvalTrialIdentity } from "./eval-trial-identity.js";

type ReportConfig = { matrix?: { baselineScenarioVariant?: string } };

type TrialResult = PersistedEvalTrialResult;

type ReportTrial = {
  evalTrialId: string;
  agentId: string;
  taskId: string;
  scenarioVariantId: string;
  runIndex: number;
  status: string;
  failure: string | null;
  evalScore: TrialResult["evalScore"];
  deterministicAcceptance: NonNullable<TrialResult["scoring"]>["acceptanceChecks"];
  evaluatorAgentRationale: NonNullable<TrialResult["scoring"]>["evaluatorAgent"] | null;
  usage: TrialResult["usage"];
  cost: TrialResult["cost"];
  timings: TrialResult["timings"];
  preservedWorktreePath: string | null;
  baselineDelta: BaselineDelta | null;
};

type BaselineDelta =
  | { status: "baseline" }
  | { status: "matched"; baselineEvalTrialId: string; evalScoreDelta: number | null }
  | { status: "missing"; baselineScenarioVariant: string; expectedEvalTrialId: string };

export async function generateReports(resultsRoot: string) {
  const root = path.resolve(resultsRoot);
  const trials = await readTrialResults(root);
  const baselineScenarioVariant = readBaselineScenarioVariant(trials);
  const reportTrials = buildReportTrials(trials, baselineScenarioVariant);
  const report = {
    generatedFrom: root,
    baselineScenarioVariant: baselineScenarioVariant ?? null,
    summary: {
      evalTrials: reportTrials.length,
      successful: reportTrials.filter((trial) => trial.status === "success").length,
      failed: reportTrials.filter((trial) => trial.status === "failed").length,
    },
    trials: reportTrials,
  };
  await writeFile(path.join(root, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(path.join(root, "report.md"), renderMarkdownReport(report), "utf8");
  return report;
}

async function readTrialResults(resultsRoot: string) {
  const entries = await readdir(resultsRoot, { withFileTypes: true });
  const trials: Array<TrialResult & { evalTrialId: string; config?: unknown }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const { result, config } = await readEvalTrialArtifacts(path.join(resultsRoot, entry.name));
    const evalTrialId = result.evalTrialId ?? entry.name;
    trials.push({ ...result, evalTrialId, ...(config === undefined ? {} : { config }) });
  }
  return trials.sort((left, right) => left.evalTrialId.localeCompare(right.evalTrialId));
}

function readBaselineScenarioVariant(trials: Array<{ config?: unknown }>) {
  for (const trial of trials) {
    const config = trial.config as ReportConfig | undefined;
    if (config?.matrix?.baselineScenarioVariant) return config.matrix.baselineScenarioVariant;
  }
  return undefined;
}

function buildReportTrials(trials: Array<TrialResult & { evalTrialId: string }>, baselineScenarioVariant: string | undefined): ReportTrial[] {
  const byId = new Map(trials.map((trial) => [trial.evalTrialId, trial]));
  return trials.map((trial) => {
    const parsedIdentity = readEvalTrialIdentity(trial.evalTrialId);
    const identity = parsedIdentity.identity;
    const expectedBaselineId = baselineScenarioVariant && identity ? createEvalTrialId({ ...identity, scenarioVariantId: baselineScenarioVariant }) : undefined;
    const baseline = expectedBaselineId ? byId.get(expectedBaselineId) : undefined;
    return {
      evalTrialId: trial.evalTrialId,
      ...(identity ?? { agentId: "unknown", taskId: "unknown", scenarioVariantId: "unknown", runIndex: 0 }),
      status: trial.status ?? "unknown",
      failure: trial.error ?? evaluatorFailure(trial) ?? parsedIdentity.error ?? null,
      evalScore: trial.evalScore,
      deterministicAcceptance: trial.scoring?.acceptanceChecks ?? [],
      evaluatorAgentRationale: trial.scoring?.evaluatorAgent ?? null,
      usage: trial.usage,
      cost: trial.cost,
      timings: trial.timings,
      preservedWorktreePath: trial.worktree?.preserved ? trial.worktree.worktreePath ?? null : null,
      baselineDelta: baselineDelta(trial, baseline, baselineScenarioVariant, expectedBaselineId, identity),
    };
  });
}

function baselineDelta(
  trial: TrialResult & { evalTrialId: string },
  baseline: (TrialResult & { evalTrialId: string }) | undefined,
  baselineScenarioVariant: string | undefined,
  expectedBaselineId: string | undefined,
  identity: EvalTrialIdentity | undefined
): BaselineDelta | null {
  if (!baselineScenarioVariant || !expectedBaselineId || !identity) return null;
  if (identity.scenarioVariantId === baselineScenarioVariant) return { status: "baseline" };
  if (!baseline) return { status: "missing", baselineScenarioVariant, expectedEvalTrialId: expectedBaselineId };
  return { status: "matched", baselineEvalTrialId: baseline.evalTrialId, evalScoreDelta: scoreDelta(trial.evalScore?.value, baseline.evalScore?.value) };
}

function scoreDelta(value: number | undefined, baseline: number | undefined) {
  if (typeof value !== "number" || typeof baseline !== "number") return null;
  return Math.round((value - baseline) * 1_000_000) / 1_000_000;
}

function evaluatorFailure(trial: TrialResult) {
  return trial.scoring?.evaluatorAgent?.status === "failed" ? trial.scoring.evaluatorAgent.error : undefined;
}

function readEvalTrialIdentity(evalTrialId: string): { identity?: EvalTrialIdentity; error?: string } {
  try {
    return { identity: parseEvalTrialId(evalTrialId) };
  } catch (error) {
    return { error: (error as Error).message };
  }
}

function renderMarkdownReport(report: { baselineScenarioVariant: string | null; summary: { evalTrials: number; successful: number; failed: number }; trials: ReportTrial[] }) {
  const lines = [
    "# Eval Report",
    "",
    `Eval trials: ${report.summary.evalTrials}`,
    `Successful: ${report.summary.successful}`,
    `Failed: ${report.summary.failed}`,
    `Baseline scenario variant: ${report.baselineScenarioVariant ?? "not configured"}`,
    "",
    "| Eval Trial | Status | Eval Score | Baseline Delta | Input Tokens | Output Tokens | Estimated Cost | Duration Ms | Failure | Preserved Worktree |",
    "| --- | --- | ---: | --- | ---: | ---: | --- | ---: | --- | --- |",
    ...report.trials.map(renderTrialRow),
    "",
    "## Deterministic Acceptance Results",
    "",
    ...report.trials.flatMap(renderAcceptanceLines),
    "",
    "## Evaluator Agent Rationale",
    "",
    ...report.trials.map(renderEvaluatorLine),
  ];
  return `${lines.join("\n")}\n`;
}

function renderTrialRow(trial: ReportTrial) {
  return `| ${trial.evalTrialId} | ${trial.status} | ${formatNumber(trial.evalScore?.value)} | ${formatBaselineDelta(trial.baselineDelta)} | ${formatNumber(agentUsageNumber(trial, "inputTokens") + agentUsageNumber(trial, "cacheReadTokens") + agentUsageNumber(trial, "cacheWriteTokens"))} | ${formatNumber(agentUsageNumber(trial, "outputTokens"))} | ${formatCost(trial.cost?.agent)} | ${formatNumber(trial.timings?.durationMs)} | ${trial.failure ?? ""} | ${trial.preservedWorktreePath ?? ""} |`;
}

function renderAcceptanceLines(trial: ReportTrial) {
  const checks = Array.isArray(trial.deterministicAcceptance) ? trial.deterministicAcceptance : [];
  if (checks.length === 0) return [`- ${trial.evalTrialId}: no deterministic acceptance results`];
  return checks.map((check) => `- ${trial.evalTrialId} ${check.id ?? "unknown"}: exit ${check.exitCode ?? "null"}, timed out ${check.timedOut === true ? "yes" : "no"}`);
}

function renderEvaluatorLine(trial: ReportTrial) {
  const evaluator = trial.evaluatorAgentRationale;
  if (!evaluator || typeof evaluator !== "object") return `- ${trial.evalTrialId}: no evaluator agent rationale`;
  if ("result" in evaluator && evaluator.result?.summary) return `- ${trial.evalTrialId}: ${evaluator.result.summary}`;
  if ("error" in evaluator && evaluator.error) return `- ${trial.evalTrialId}: evaluator agent failed: ${evaluator.error}`;
  return `- ${trial.evalTrialId}: no evaluator agent rationale`;
}

function agentUsageNumber(trial: ReportTrial, key: string) {
  const value = trial.usage?.agent?.[key];
  return typeof value === "number" ? value : 0;
}

function formatBaselineDelta(delta: BaselineDelta | null) {
  if (!delta) return "";
  if (delta.status === "baseline") return "baseline";
  if (delta.status === "missing") return `missing baseline ${delta.expectedEvalTrialId}`;
  if (delta.evalScoreDelta === null) return `unknown vs ${delta.baselineEvalTrialId}`;
  return `${delta.evalScoreDelta >= 0 ? "+" : ""}${delta.evalScoreDelta} vs ${delta.baselineEvalTrialId}`;
}

function formatCost(cost: Record<string, unknown> | undefined) {
  if (!cost) return "";
  if (typeof cost.estimatedUsd === "number") return `$${cost.estimatedUsd.toFixed(6)}`;
  if (cost.status === "unavailable") return "unavailable";
  return "";
}

function formatNumber(value: number | undefined) {
  return typeof value === "number" ? String(value) : "";
}
