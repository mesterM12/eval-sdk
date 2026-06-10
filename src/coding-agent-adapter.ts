import { readFile } from "node:fs/promises";
import { collectGitWorkDiff, ensureGitWorkBaseline, type GitWorkBaseline } from "./git-work.js";
import { runSandcastleBuiltIn, sandcastleRuntime, type EvalSandboxProvider, type SandcastleRuntime } from "./sandcastle-provider-registry.js";

export type SandcastleExecutorInput = {
  evalTrialId: string;
  providerName: string;
  model?: string;
  sandboxProvider: EvalSandboxProvider;
  branchStrategy: "head";
  prompt: string;
  worktreePath: string;
  agentHomePath: string;
  logPath: string;
  env: Record<string, string>;
};

export type SandcastleExecutorResult = {
  stdout?: string;
  logs?: string;
  commits?: Array<{ sha: string }>;
  diff?: string;
  branch?: string;
  providerMetadata?: Record<string, unknown>;
  iterations?: Array<Record<string, unknown>>;
};

export type CodingAgentAdapterInput = Omit<SandcastleExecutorInput, "branchStrategy"> & {
  gitBaseline: GitWorkBaseline;
};

export type CodingAgentAdapter = {
  completeEvalTrial: (input: CodingAgentAdapterInput) => Promise<SandcastleExecutorResult>;
};

export function createSandcastleCodingAgentAdapter(runtime: SandcastleRuntime = sandcastleRuntime): CodingAgentAdapter {
  return {
    completeEvalTrial: async (input) => {
      const runResult = await runSandcastleBuiltIn({
        providerName: input.providerName,
        model: input.model,
        env: input.env,
        sandboxProvider: input.sandboxProvider,
        execution: { type: "eval-trial", agentHomePath: input.agentHomePath },
        cwd: input.worktreePath,
        prompt: input.prompt,
        logPath: input.logPath,
        providerLabel: "agent provider",
      }, runtime);
      let logs: string | undefined;
      try {
        logs = await readFile(typeof runResult.logFilePath === "string" ? runResult.logFilePath : input.logPath, "utf8");
      } catch {
        logs = undefined;
      }
      const diff = await collectGitWorkDiff({ repoPath: input.worktreePath, baseSha: input.gitBaseline.baseSha });
      return {
        stdout: typeof runResult.stdout === "string" ? runResult.stdout : undefined,
        logs,
        commits: Array.isArray(runResult.commits) ? runResult.commits as Array<{ sha: string }> : undefined,
        diff,
        branch: typeof runResult.branch === "string" ? runResult.branch : undefined,
        providerMetadata: { provider: input.providerName, model: input.model, logFilePath: runResult.logFilePath },
        iterations: Array.isArray(runResult.iterations) ? runResult.iterations as Array<Record<string, unknown>> : undefined,
      };
    },
  };
}

export function createSandcastleBuiltInExecutor(runtime: SandcastleRuntime = sandcastleRuntime): (input: SandcastleExecutorInput) => Promise<SandcastleExecutorResult> {
  const adapter = createSandcastleCodingAgentAdapter(runtime);
  return async (input) => adapter.completeEvalTrial({ ...input, gitBaseline: await ensureGitWorkBaseline({ repoPath: input.worktreePath }) });
}
