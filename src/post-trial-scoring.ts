import { collectAcceptanceSecretValues, runAcceptanceMaterialSandbox, type AcceptanceCheckResult } from "./acceptance-material-sandbox.js";
import type { EvalSandboxProvider } from "./coding-agent-adapter.js";
import { runEvaluatorAgent, type EvaluatorAgentExecutorInput, type EvaluatorAgentExecutorResult, type EvaluatorAgentScoringResult } from "./evaluator-agent.js";
import type { EvalSuiteConfig } from "./eval-suite-config.js";

export type PostTrialScoringResult = {
  acceptanceChecks: AcceptanceCheckResult[];
  evaluatorAgent: EvaluatorAgentScoringResult;
  secretValues: string[];
};

export async function runPostTrialScoring(input: {
  suiteRoot: string;
  scoringRoot: string;
  evalTrialId: string;
  completedRepoPath: string;
  agent: EvalSuiteConfig["agents"][number];
  task: EvalSuiteConfig["tasks"][number];
  evaluatorAgent: EvalSuiteConfig["evaluatorAgent"];
  sandboxProvider: EvalSandboxProvider;
  evaluatorAgentExecutor?: (input: EvaluatorAgentExecutorInput) => Promise<EvaluatorAgentExecutorResult>;
}): Promise<PostTrialScoringResult> {
  const secretValues = collectAcceptanceSecretValues(input.task.acceptanceMaterial?.checks ?? [], input.evaluatorAgent, input.agent);
  const scoring = await runAcceptanceMaterialSandbox({
    suiteRoot: input.suiteRoot,
    scoringRoot: input.scoringRoot,
    completedRepoPath: input.completedRepoPath,
    hiddenDir: input.task.acceptanceMaterial?.hiddenDir,
    checks: input.task.acceptanceMaterial?.checks ?? [],
    secretValues,
    afterAcceptanceChecks: async ({ scoringRepoPath, acceptanceChecks }) =>
      runEvaluatorAgent({
        suiteRoot: input.suiteRoot,
        evalTrialId: input.evalTrialId,
        scoringRepoPath,
        deterministicResults: acceptanceChecks,
        rubrics: input.task.acceptanceMaterial?.rubrics ?? [],
        evaluatorAgent: input.evaluatorAgent,
        sandboxProvider: input.sandboxProvider,
        executor: input.evaluatorAgentExecutor,
        secretValues,
      }),
  });
  return { acceptanceChecks: scoring.acceptanceChecks, evaluatorAgent: scoring.value ?? { status: "skipped" }, secretValues };
}

export function didPostTrialScoringFail(scoring: Pick<PostTrialScoringResult, "acceptanceChecks" | "evaluatorAgent">) {
  return scoring.acceptanceChecks.some((check) => check.exitCode !== 0 || check.timedOut) || scoring.evaluatorAgent.status === "failed";
}
