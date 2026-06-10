import { claudeCode, codex, copilot, cursor, opencode, pi, run } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { noSandbox } from "@ai-hero/sandcastle/sandboxes/no-sandbox";

export type EvalSandboxProvider = "docker" | "local";

export type SandcastleProviderFactory = (model?: string, options?: { env?: Record<string, string> }) => unknown;

export type SandcastleRuntime = {
  run: (options: unknown) => Promise<Record<string, unknown>>;
  docker: (options: unknown) => unknown;
  noSandbox: (options?: unknown) => unknown;
  providers: Record<string, SandcastleProviderFactory>;
};

export type SandcastleBuiltInRunInput = {
  providerName: string;
  model?: string;
  env: Record<string, string>;
  sandboxProvider: EvalSandboxProvider;
  execution: { type: "eval-trial"; agentHomePath: string } | { type: "evaluator-agent" };
  cwd: string;
  prompt: string;
  logPath: string;
  providerLabel: string;
};

export const supportedSandboxProviders = ["docker", "local"] as const;
export const supportedSandcastleBuiltInProviders = ["claude-code", "codex", "copilot", "cursor", "opencode", "pi"] as const;

const SANDBOX_PROVIDERS = new Set<string>(supportedSandboxProviders);
const SANDCASTLE_BUILT_IN_PROVIDER_FACTORIES: Record<(typeof supportedSandcastleBuiltInProviders)[number], SandcastleProviderFactory> = {
  "claude-code": claudeCode as SandcastleProviderFactory,
  codex: codex as SandcastleProviderFactory,
  copilot: copilot as SandcastleProviderFactory,
  cursor: cursor as SandcastleProviderFactory,
  opencode: opencode as SandcastleProviderFactory,
  pi: pi as SandcastleProviderFactory,
};

export const sandcastleRuntime: SandcastleRuntime = {
  run: run as unknown as SandcastleRuntime["run"],
  docker: docker as SandcastleRuntime["docker"],
  noSandbox: noSandbox as SandcastleRuntime["noSandbox"],
  providers: SANDCASTLE_BUILT_IN_PROVIDER_FACTORIES,
};

export function isEvalSandboxProvider(provider: string | undefined): provider is EvalSandboxProvider {
  return typeof provider === "string" && SANDBOX_PROVIDERS.has(provider);
}

export function isSandcastleBuiltInProvider(provider: string | undefined) {
  return typeof provider === "string" && provider in SANDCASTLE_BUILT_IN_PROVIDER_FACTORIES;
}

export function createSandboxForEvalTrial(input: { sandboxProvider: EvalSandboxProvider; agentHomePath: string }, runtime: SandcastleRuntime) {
  if (input.sandboxProvider === "local") return runtime.noSandbox();
  return runtime.docker({ mounts: [{ hostPath: input.agentHomePath, sandboxPath: "/home/agent" }] });
}

export function createSandboxForEvaluatorAgent(sandboxProvider: EvalSandboxProvider, runtime: SandcastleRuntime) {
  if (sandboxProvider === "local") return runtime.noSandbox();
  return runtime.docker({});
}

export async function runSandcastleBuiltIn(input: SandcastleBuiltInRunInput, runtime: SandcastleRuntime) {
  const providerFactory = runtime.providers[input.providerName];
  if (!providerFactory) {
    throw new Error(`${input.providerLabel} must be a Sandcastle built-in provider: ${input.providerName}`);
  }
  return runtime.run({
    agent: providerFactory(input.model, { env: input.env }),
    sandbox: createSandboxForExecution(input, runtime),
    cwd: input.cwd,
    prompt: input.prompt,
    logging: { type: "file", path: input.logPath },
    branchStrategy: { type: "head" },
  });
}

function createSandboxForExecution(input: SandcastleBuiltInRunInput, runtime: SandcastleRuntime) {
  if (input.execution.type === "eval-trial") return createSandboxForEvalTrial({ sandboxProvider: input.sandboxProvider, agentHomePath: input.execution.agentHomePath }, runtime);
  return createSandboxForEvaluatorAgent(input.sandboxProvider, runtime);
}
