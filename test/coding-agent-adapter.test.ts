import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { createSandcastleCodingAgentAdapter } from "../src/coding-agent-adapter.js";
import { ensureGitWorkBaseline } from "../src/git-work.js";

const execFileAsync = promisify(execFile);

async function makeTempDir() {
  return mkdtemp(path.join(tmpdir(), "coding-agent-eval-adapter-"));
}

async function writeFixtureFile(root: string, relativePath: string, contents: string) {
  const filePath = path.join(root, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, contents, "utf8");
}

describe("coding agent adapter fake Sandcastle runtime seam", () => {
  it("maps provider, Docker agent-home mount, branch strategy, logs, diff, metadata, and usage", async () => {
    const worktreePath = await makeTempDir();
    const agentHomePath = await makeTempDir();
    const logPath = path.join(await makeTempDir(), "sandcastle.log");
    await writeFixtureFile(worktreePath, "README.md", "before\n");
    const baseline = await ensureGitWorkBaseline({ repoPath: worktreePath });
    const runCalls: unknown[] = [];
    const dockerCalls: unknown[] = [];
    const adapter = createSandcastleCodingAgentAdapter({
      providers: { opencode: (model?: string, options?: { env?: Record<string, string> }) => ({ provider: "opencode", model, env: options?.env }) },
      docker: (options: unknown) => {
        dockerCalls.push(options);
        return { sandbox: "docker" };
      },
      run: async (options: unknown) => {
        runCalls.push(options);
        await writeFixtureFile(worktreePath, "README.md", "after\n");
        await writeFile(logPath, "runtime log\n", "utf8");
        return {
          stdout: "stdout",
          commits: [{ sha: "sha1" }],
          branch: "agent-branch",
          logFilePath: logPath,
          iterations: [{ usage: { inputTokens: 3, outputTokens: 2 } }],
        };
      },
    });

    const completed = await adapter.completeEvalTrial({
      evalTrialId: "agent__task__baseline__1",
      providerName: "opencode",
      model: "model-a",
      prompt: "# Task\n",
      worktreePath,
      agentHomePath,
      logPath,
      env: { API_KEY: "test" },
      gitBaseline: baseline,
    });

    expect(dockerCalls).toEqual([{ mounts: [{ hostPath: agentHomePath, sandboxPath: "/home/agent" }] }]);
    expect(runCalls).toEqual([
      expect.objectContaining({
        agent: { provider: "opencode", model: "model-a", env: { API_KEY: "test" } },
        sandbox: { sandbox: "docker" },
        cwd: worktreePath,
        prompt: "# Task\n",
        logging: { type: "file", path: logPath },
        branchStrategy: { type: "head" },
      }),
    ]);
    expect(completed).toMatchObject({
      stdout: "stdout",
      logs: "runtime log\n",
      commits: [{ sha: "sha1" }],
      diff: expect.stringContaining("after"),
      branch: "agent-branch",
      providerMetadata: { provider: "opencode", model: "model-a", logFilePath: logPath },
      iterations: [{ usage: { inputTokens: 3, outputTokens: 2 } }],
    });
  });

  it("fails clearly for unsupported Sandcastle providers", async () => {
    const adapter = createSandcastleCodingAgentAdapter({ providers: {}, docker: () => ({}), run: async () => ({}) });

    await expect(adapter.completeEvalTrial({
      evalTrialId: "agent__task__baseline__1",
      providerName: "unknown",
      prompt: "# Task\n",
      worktreePath: await makeTempDir(),
      agentHomePath: await makeTempDir(),
      logPath: path.join(await makeTempDir(), "sandcastle.log"),
      env: {},
      gitBaseline: { baseSha: "HEAD" },
    })).rejects.toThrow("agent provider must be a Sandcastle built-in provider: unknown");
  });

  it("falls back to stdout when Sandcastle log file cannot be read", async () => {
    const worktreePath = await makeTempDir();
    await writeFixtureFile(worktreePath, "README.md", "before\n");
    const baseline = await ensureGitWorkBaseline({ repoPath: worktreePath });
    const adapter = createSandcastleCodingAgentAdapter({
      providers: { opencode: () => ({}) },
      docker: () => ({}),
      run: async () => ({ stdout: "stdout fallback", logFilePath: path.join(worktreePath, "missing.log") }),
    });

    const completed = await adapter.completeEvalTrial({
      evalTrialId: "agent__task__baseline__1",
      providerName: "opencode",
      prompt: "# Task\n",
      worktreePath,
      agentHomePath: await makeTempDir(),
      logPath: path.join(await makeTempDir(), "sandcastle.log"),
      env: {},
      gitBaseline: baseline,
    });

    expect(completed.logs).toBeUndefined();
    expect(completed.stdout).toBe("stdout fallback");
  });
});
