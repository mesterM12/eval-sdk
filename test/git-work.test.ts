import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { collectGitWorkDiff, ensureGitWorkBaseline } from "../src/git-work.js";

const execFileAsync = promisify(execFile);

async function makeTempDir() {
  return mkdtemp(path.join(tmpdir(), "coding-agent-eval-git-work-"));
}

async function writeFixtureFile(root: string, relativePath: string, contents: string) {
  const filePath = path.join(root, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, contents, "utf8");
}

describe("git work filesystem seam", () => {
  it("creates an Eval Trial baseline commit for starter files", async () => {
    const repoPath = await makeTempDir();
    await writeFixtureFile(repoPath, "README.md", "starter\n");

    const baseline = await ensureGitWorkBaseline({ repoPath });

    expect(baseline.baseSha).toEqual(expect.any(String));
    const log = await execFileAsync("git", ["log", "--oneline"], { cwd: repoPath });
    expect(log.stdout).toContain("Initial eval trial baseline");
    await expect(readFile(path.join(repoPath, "README.md"), "utf8")).resolves.toBe("starter\n");
  });

  it("collects committed and uncommitted Eval Trial work diff from the baseline", async () => {
    const repoPath = await makeTempDir();
    await writeFixtureFile(repoPath, "README.md", "starter\n");
    const baseline = await ensureGitWorkBaseline({ repoPath });

    await writeFixtureFile(repoPath, "committed.txt", "committed change\n");
    await execFileAsync("git", ["add", "."], { cwd: repoPath });
    await execFileAsync("git", ["commit", "-m", "agent committed work"], { cwd: repoPath });
    await writeFixtureFile(repoPath, "committed.txt", "committed change\nmodified\n");

    const diff = await collectGitWorkDiff({ repoPath, baseSha: baseline.baseSha });

    expect(diff).toContain("committed change");
    expect(diff).toContain("modified");
  });

  it("includes untracked files created by an Eval Trial in the collected diff", async () => {
    const repoPath = await makeTempDir();
    await writeFixtureFile(repoPath, "README.md", "starter\n");
    const baseline = await ensureGitWorkBaseline({ repoPath });

    await writeFixtureFile(repoPath, "hello.txt", "hello from local opencode\n");

    const diff = await collectGitWorkDiff({ repoPath, baseSha: baseline.baseSha });

    expect(diff).toContain("diff --git a/hello.txt b/hello.txt");
    expect(diff).toContain("+hello from local opencode");
  });
});
