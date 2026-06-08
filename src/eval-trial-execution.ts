import { mkdir } from "node:fs/promises";
import path from "node:path";
import { createSandcastleBuiltInExecutor, type SandcastleExecutorInput, type SandcastleExecutorResult } from "./coding-agent-adapter.js";
import type { EvaluatorAgentExecutorInput, EvaluatorAgentExecutorResult } from "./evaluator-agent.js";
import { runEvalTrialLifecycle, type EvalTrialExecutionResult } from "./eval-trial-lifecycle.js";
import type { EvalSuiteConfig } from "./eval-suite-config.js";
import { generateReports } from "./report.js";
import { expandTrialMatrix } from "./trial-matrix.js";

export { createSandcastleBuiltInExecutor, type SandcastleExecutorInput, type SandcastleExecutorResult } from "./coding-agent-adapter.js";

export type { EvalTrialExecutionResult } from "./eval-trial-lifecycle.js";

export type ExecuteEvalTrialsInput = {
  suiteRoot: string;
  resultsRoot: string;
  config: EvalSuiteConfig;
  failFast?: boolean;
  sandcastleExecutor?: (input: SandcastleExecutorInput) => Promise<SandcastleExecutorResult>;
  evaluatorAgentExecutor?: (input: EvaluatorAgentExecutorInput) => Promise<EvaluatorAgentExecutorResult>;
};

async function createResultsRunDirectory(resultsRoot: string) {
  await mkdir(path.dirname(resultsRoot), { recursive: true });
  try {
    await mkdir(resultsRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`results run directory already exists: ${resultsRoot}`);
    }
    throw error;
  }
}

export async function executeEvalTrials(input: ExecuteEvalTrialsInput): Promise<EvalTrialExecutionResult[]> {
  const suiteRoot = path.resolve(input.suiteRoot);
  const resultsRoot = path.resolve(input.resultsRoot);
  await createResultsRunDirectory(resultsRoot);
  const tempRoot = path.join(suiteRoot, ".eval-agent");
  const evalTrials = expandTrialMatrix({
    agents: input.config.agents,
    tasks: input.config.tasks,
    scenarioVariants: input.config.scenarioVariants,
    matrix: input.config.matrix,
  });
  const results: EvalTrialExecutionResult[] = [];

  for (const evalTrial of evalTrials) {
    const result = await runEvalTrialLifecycle({
      suiteRoot,
      tempRoot,
      resultsRoot,
      config: input.config,
      evalTrial,
      sandcastleExecutor: input.sandcastleExecutor,
      evaluatorAgentExecutor: input.evaluatorAgentExecutor,
    });
    results.push(result);
    if (result.status === "failed" && input.failFast) break;
  }

  await generateReports(resultsRoot);
  return results;
}
