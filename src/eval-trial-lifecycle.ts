import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createSandcastleCodingAgentAdapter, type SandcastleExecutorInput, type SandcastleExecutorResult } from "./coding-agent-adapter.js";
import { redactText, resolveEnv } from "./env-reference.js";
import { evalTrialArtifactPath, writeEvalTrialArtifactManifest, writeEvalTrialArtifacts, writeFailedEvalTrialResult } from "./eval-trial-artifacts.js";
import type { EvaluatorAgentExecutorInput, EvaluatorAgentExecutorResult } from "./evaluator-agent.js";
import { finalizeEvalTrialWorktree, prepareEvalTrialWorktree } from "./eval-trial-worktree.js";
import type { EvalSuiteConfig } from "./eval-suite-config.js";
import { resolveSuitePath } from "./filesystem-safety.js";
import { ensureGitWorkBaseline } from "./git-work.js";
import { didPostTrialScoringFail, runPostTrialScoring } from "./post-trial-scoring.js";
import { scoreEvalTrialFacts } from "./scoring.js";
import type { EvalTrial } from "./trial-matrix.js";

export type EvalTrialExecutionResult = {
  evalTrialId: string;
  status: "success" | "failed";
  error?: string;
  artifactRoot: string;
};

export async function runEvalTrialLifecycle(input: {
  suiteRoot: string;
  tempRoot: string;
  resultsRoot: string;
  config: EvalSuiteConfig;
  evalTrial: EvalTrial;
  sandcastleExecutor?: (input: SandcastleExecutorInput) => Promise<SandcastleExecutorResult>;
  evaluatorAgentExecutor?: (input: EvaluatorAgentExecutorInput) => Promise<EvaluatorAgentExecutorResult>;
}): Promise<EvalTrialExecutionResult> {
  const agent = findById(input.config.agents, input.evalTrial.agentId, "agent");
  const task = findById(input.config.tasks, input.evalTrial.taskId, "task");
  const scenarioVariant = findById(input.config.scenarioVariants, input.evalTrial.scenarioVariantId, "scenario variant");
  const artifactRoot = path.join(input.resultsRoot, input.evalTrial.id);
  await mkdir(artifactRoot);

  const startedAt = new Date();
  let prepared: Awaited<ReturnType<typeof prepareEvalTrialWorktree>> | undefined;

  try {
    const prompt = await resolvePromptSnapshot(input.suiteRoot, task.prompt, scenarioVariant.prompt);
    await writeFile(evalTrialArtifactPath(artifactRoot, "prompt"), prompt, "utf8");
    prepared = await prepareEvalTrialWorktree({
      suiteRoot: input.suiteRoot,
      tempRoot: input.tempRoot,
      evalTrialId: input.evalTrial.id,
      starterPath: requireString(task.starter, "task starter"),
      repoOverlayPath: scenarioVariant.repoOverlay,
      agentHomeOverlayPath: scenarioVariant.agentHomeOverlay,
    });

    const sandcastle = await completeEvalTrialWithCodingAgent({
      evalTrialId: input.evalTrial.id,
      agent,
      prompt,
      prepared,
      artifactRoot,
      sandboxProvider: input.config.sandbox.provider,
      sandcastleExecutor: input.sandcastleExecutor,
    });
    const finishedAt = new Date();
    await writeFile(evalTrialArtifactPath(artifactRoot, "sandcastleLog"), sandcastle.logs ?? sandcastle.stdout ?? "", "utf8");

    const scoring = await runPostTrialScoring({
      suiteRoot: input.suiteRoot,
      scoringRoot: path.join(input.tempRoot, "scoring", input.evalTrial.id),
      evalTrialId: input.evalTrial.id,
      completedRepoPath: prepared.repoPath,
      agent,
      task,
      evaluatorAgent: input.config.evaluatorAgent,
      sandboxProvider: input.config.sandbox.provider,
      evaluatorAgentExecutor: input.evaluatorAgentExecutor,
    });
    const { secretValues, ...persistedScoring } = scoring;
    const scoringFailed = didPostTrialScoringFail(scoring);
    const status = scoringFailed ? "failed" : "success";
    const worktree = await finalizeEvalTrialWorktree(prepared, { outcome: scoringFailed ? "failure" : "success" });
    const { evalScore, usage, cost } = scoreEvalTrialFacts({
      agent,
      task,
      acceptanceChecks: scoring.acceptanceChecks,
      evaluatorAgent: scoring.evaluatorAgent,
      iterations: sandcastle.iterations,
      pricing: input.config.pricing,
    });
    const timingsValue = timings(startedAt, finishedAt);
    const resultJson = redactSecrets(
      {
        evalTrialId: input.evalTrial.id,
        status,
        timings: timingsValue,
        sandcastle,
        scoring: persistedScoring,
        evalScore,
        usage,
        cost,
        worktree,
      },
      secretValues
    );
    await writeEvalTrialArtifacts(artifactRoot, {
      config: input.config,
      diff: sandcastle.diff ?? "",
      commits: sandcastle.commits ?? [],
      timings: timingsValue,
      usage,
      cost,
      acceptanceOutput: persistedScoring.acceptanceChecks,
      evaluatorRationale: persistedScoring.evaluatorAgent,
      result: resultJson,
    });
    await writeEvalTrialArtifactManifest(artifactRoot);
    return scoringFailed
      ? { evalTrialId: input.evalTrial.id, status, artifactRoot, error: "post-trial scoring failed" }
      : { evalTrialId: input.evalTrial.id, status, artifactRoot };
  } catch (error) {
    const finishedAt = new Date();
    const worktree = prepared ? await finalizeEvalTrialWorktree(prepared, { outcome: "failure" }) : { preserved: false, worktreePath: null, agentHomePath: null };
    const message = error instanceof Error ? error.message : String(error);
    const publicMessage = message.startsWith("acceptance check cwd must stay inside the eval trial scoring sandbox") ? "post-trial scoring failed" : message;
    await writeFailedEvalTrialResult(artifactRoot, {
      evalTrialId: input.evalTrial.id,
      status: "failed",
      error: publicMessage,
      timings: timings(startedAt, finishedAt),
      worktree,
    });
    await writeEvalTrialArtifactManifest(artifactRoot);
    return { evalTrialId: input.evalTrial.id, status: "failed", error: publicMessage, artifactRoot };
  }
}

async function completeEvalTrialWithCodingAgent(input: {
  evalTrialId: string;
  agent: EvalSuiteConfig["agents"][number];
  prompt: string;
  prepared: Awaited<ReturnType<typeof prepareEvalTrialWorktree>>;
  artifactRoot: string;
  sandboxProvider: EvalSuiteConfig["sandbox"]["provider"];
  sandcastleExecutor?: (input: SandcastleExecutorInput) => Promise<SandcastleExecutorResult>;
}) {
  const sandcastleInput = {
    evalTrialId: input.evalTrialId,
    providerName: requireString(input.agent.provider, "agent provider"),
    model: input.agent.model,
    sandboxProvider: input.sandboxProvider,
    branchStrategy: "head",
    prompt: input.prompt,
    worktreePath: input.prepared.repoPath,
    agentHomePath: input.prepared.agentHomePath,
    logPath: evalTrialArtifactPath(input.artifactRoot, "sandcastleLog"),
    env: resolveEnv(input.agent.env),
  } satisfies SandcastleExecutorInput;
  const gitBaseline = await ensureGitWorkBaseline({ repoPath: input.prepared.repoPath });
  if (input.sandcastleExecutor) return input.sandcastleExecutor(sandcastleInput);
  return createSandcastleCodingAgentAdapter().completeEvalTrial({ ...sandcastleInput, gitBaseline });
}

function redactSecrets<T>(value: T, secretValues: string[]): T {
  return JSON.parse(redactText(JSON.stringify(value), secretValues)) as T;
}

async function resolvePromptSnapshot(suiteRoot: string, taskPromptPath: string | undefined, scenarioPromptPath: string | undefined) {
  const taskPrompt = await readFile(resolveSuitePath(suiteRoot, requireString(taskPromptPath, "task prompt")), "utf8");
  if (!scenarioPromptPath) return taskPrompt;
  const scenarioPrompt = await readFile(resolveSuitePath(suiteRoot, scenarioPromptPath), "utf8");
  return `${taskPrompt}\n${scenarioPrompt}`;
}

function findById<T extends { id: string }>(items: T[], id: string, label: string): T {
  const item = items.find((candidate) => candidate.id === id);
  if (!item) throw new Error(`${label} not found: ${id}`);
  return item;
}

function requireString(value: string | undefined, label: string) {
  if (!value) throw new Error(`${label} is required`);
  return value;
}

function timings(startedAt: Date, finishedAt: Date) {
  return {
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
  };
}
