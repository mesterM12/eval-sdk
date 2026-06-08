import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { createSandcastleBuiltInExecutor } from "../src/eval-trial-execution.js";

const execFileAsync = promisify(execFile);

async function makeTempDir() {
  return mkdtemp(path.join(tmpdir(), "coding-agent-eval-real-"));
}

async function writeFixtureFile(root: string, relativePath: string, contents: string) {
  const filePath = path.join(root, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, contents, "utf8");
}

describe("real Sandcastle adapter (no mocking)", () => {
  it("uses the real Sandcastle dependency and constructs the executor (will fail at Docker)", async () => {
    const executor = createSandcastleBuiltInExecutor();
    const worktreePath = await makeTempDir();
    await writeFixtureFile(worktreePath, "README.md", "before\n");
    await execFileAsync("git", ["init"], { cwd: worktreePath });
    await execFileAsync("git", ["config", "user.email", "t@t.com"], { cwd: worktreePath });
    await execFileAsync("git", ["config", "user.name", "T"], { cwd: worktreePath });
    await execFileAsync("git", ["add", "."], { cwd: worktreePath });
    await execFileAsync("git", ["commit", "-m", "init"], { cwd: worktreePath });

    const agentHomePath = await makeTempDir();
    const logPath = path.join(worktreePath, "sandcastle.log");

    const promise = executor({
      evalTrialId: "real__test__1",
      providerName: "opencode",
      model: "opencode/big-pickle",
      sandboxProvider: "docker",
      branchStrategy: "head",
      prompt: "add a line to README.md",
      worktreePath,
      agentHomePath,
      logPath,
      env: {},
    });

    await expect(promise).rejects.toThrow();
    try {
      await promise;
    } catch (error) {
      const msg = (error as Error).message;
      expect(msg).toMatch(/docker|sandbox|ENOENT|connect|ECONNREFUSED|providers|container/i);
    }
  });
});
