import { readFile } from "node:fs/promises";
import { claudeCode, codex, copilot, cursor, opencode, pi, run } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { noSandbox } from "@ai-hero/sandcastle/sandboxes/no-sandbox";
import { collectGitWorkDiff, ensureGitWorkBaseline, type GitWorkBaseline } from "./git-work.js";

export type EvalSandboxProvider = "docker" | "local";

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

export type SandcastleRuntime = {
  run: (options: unknown) => Promise<Record<string, unknown>>;
  docker: (options: unknown) => unknown;
  noSandbox: (options?: unknown) => unknown;
  providers: Record<string, (model?: string, options?: { env?: Record<string, string> }) => unknown>;
};

const sandcastleRuntime: SandcastleRuntime = {
  run: run as unknown as SandcastleRuntime["run"],
  docker: docker as SandcastleRuntime["docker"],
  noSandbox: noSandbox as SandcastleRuntime["noSandbox"],
  providers: {
    "claude-code": claudeCode as (model?: string, options?: { env?: Record<string, string> }) => unknown,
    codex: codex as (model?: string, options?: { env?: Record<string, string> }) => unknown,
    copilot: copilot as (model?: string, options?: { env?: Record<string, string> }) => unknown,
    cursor: cursor as (model?: string, options?: { env?: Record<string, string> }) => unknown,
    opencode: opencode as (model?: string, options?: { env?: Record<string, string> }) => unknown,
    pi: pi as (model?: string, options?: { env?: Record<string, string> }) => unknown,
  },
};

export function createSandcastleCodingAgentAdapter(runtime: SandcastleRuntime = sandcastleRuntime): CodingAgentAdapter {
  return {
    completeEvalTrial: async (input) => {
      const providerFactory = runtime.providers[input.providerName];
      if (!providerFactory) {
        throw new Error(`agent provider must be a Sandcastle built-in provider: ${input.providerName}`);
      }
      const runResult = await runtime.run({
        agent: providerFactory(input.model, { env: input.env }),
        sandbox: createSandbox(input, runtime),
        cwd: input.worktreePath,
        prompt: input.prompt,
        logging: { type: "file", path: input.logPath },
        branchStrategy: { type: "head" },
      });
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

function createSandbox(input: CodingAgentAdapterInput, runtime: SandcastleRuntime) {
  if (input.sandboxProvider === "local") return runtime.noSandbox();
  return runtime.docker({ mounts: [{ hostPath: input.agentHomePath, sandboxPath: "/home/agent" }] });
}

export function createSandcastleBuiltInExecutor(runtime: SandcastleRuntime = sandcastleRuntime): (input: SandcastleExecutorInput) => Promise<SandcastleExecutorResult> {
  const adapter = createSandcastleCodingAgentAdapter(runtime);
  return async (input) => adapter.completeEvalTrial({ ...input, gitBaseline: await ensureGitWorkBaseline({ repoPath: input.worktreePath }) });
}
