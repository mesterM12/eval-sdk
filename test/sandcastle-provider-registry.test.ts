import { describe, expect, it } from "vitest";
import { isEvalSandboxProvider, isSandcastleBuiltInProvider, runSandcastleBuiltIn, sandcastleRuntime, supportedSandcastleBuiltInProviders, supportedSandboxProviders } from "../src/sandcastle-provider-registry.js";

describe("Sandcastle provider registry", () => {
  it("exposes one source of truth for supported Sandbox Providers", () => {
    expect(supportedSandboxProviders).toEqual(["docker", "local"]);
    expect(isEvalSandboxProvider("docker")).toBe(true);
    expect(isEvalSandboxProvider("local")).toBe(true);
    expect(isEvalSandboxProvider("host")).toBe(false);
  });

  it("exposes one source of truth for Sandcastle built-in providers", () => {
    expect(Object.keys(sandcastleRuntime.providers).sort()).toEqual([...supportedSandcastleBuiltInProviders].sort());
    for (const provider of supportedSandcastleBuiltInProviders) {
      expect(isSandcastleBuiltInProvider(provider)).toBe(true);
    }
    expect(isSandcastleBuiltInProvider("unknown")).toBe(false);
  });

  it("runs a Sandcastle built-in provider with Docker Eval Trial execution intent", async () => {
    const runCalls: unknown[] = [];
    const dockerCalls: unknown[] = [];

    await runSandcastleBuiltIn({
      providerName: "opencode",
      model: "model-a",
      env: { API_KEY: "test" },
      sandboxProvider: "docker",
      execution: { type: "eval-trial", agentHomePath: "/tmp/agent-home" },
      cwd: "/tmp/worktree",
      prompt: "Complete the Eval Trial",
      logPath: "/tmp/sandcastle.log",
      providerLabel: "agent provider",
    }, {
      providers: { opencode: (model?: string, options?: { env?: Record<string, string> }) => ({ provider: "opencode", model, env: options?.env }) },
      docker: (options: unknown) => {
        dockerCalls.push(options);
        return { sandbox: "docker" };
      },
      noSandbox: () => ({ sandbox: "local" }),
      run: async (options: unknown) => {
        runCalls.push(options);
        return { stdout: "done" };
      },
    });

    expect(dockerCalls).toEqual([{ mounts: [{ hostPath: "/tmp/agent-home", sandboxPath: "/home/agent" }] }]);
    expect(runCalls).toEqual([expect.objectContaining({
      agent: { provider: "opencode", model: "model-a", env: { API_KEY: "test" } },
      sandbox: { sandbox: "docker" },
      cwd: "/tmp/worktree",
      prompt: "Complete the Eval Trial",
      logging: { type: "file", path: "/tmp/sandcastle.log" },
      branchStrategy: { type: "head" },
    })]);
  });

  it("runs a Sandcastle built-in provider with local Evaluator Agent execution intent", async () => {
    const runCalls: unknown[] = [];
    const dockerCalls: unknown[] = [];
    const noSandboxCalls: unknown[] = [];

    await runSandcastleBuiltIn({
      providerName: "opencode",
      env: {},
      sandboxProvider: "local",
      execution: { type: "evaluator-agent" },
      cwd: "/tmp/scoring-repo",
      prompt: "Score the Eval Trial",
      logPath: "/tmp/evaluator.log",
      providerLabel: "evaluator agent provider",
    }, {
      providers: { opencode: (model?: string, options?: { env?: Record<string, string> }) => ({ provider: "opencode", model, env: options?.env }) },
      docker: (options: unknown) => {
        dockerCalls.push(options);
        return { sandbox: "docker" };
      },
      noSandbox: (options?: unknown) => {
        noSandboxCalls.push(options);
        return { sandbox: "local" };
      },
      run: async (options: unknown) => {
        runCalls.push(options);
        return { stdout: "{}" };
      },
    });

    expect(dockerCalls).toEqual([]);
    expect(noSandboxCalls).toEqual([undefined]);
    expect(runCalls).toEqual([expect.objectContaining({
      sandbox: { sandbox: "local" },
      cwd: "/tmp/scoring-repo",
      logging: { type: "file", path: "/tmp/evaluator.log" },
      branchStrategy: { type: "head" },
    })]);
  });

  it("fails clearly when built-in provider execution receives an unsupported provider", async () => {
    await expect(runSandcastleBuiltIn({
      providerName: "unknown",
      env: {},
      sandboxProvider: "docker",
      execution: { type: "evaluator-agent" },
      cwd: "/tmp/scoring-repo",
      prompt: "Score the Eval Trial",
      logPath: "/tmp/evaluator.log",
      providerLabel: "evaluator agent provider",
    }, { providers: {}, docker: () => ({}), noSandbox: () => ({}), run: async () => ({}) })).rejects.toThrow("evaluator agent provider must be a Sandcastle built-in provider: unknown");
  });
});
