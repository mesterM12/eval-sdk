import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { prepareEvalTrialWorktree, finalizeEvalTrialWorktree } from "../src/eval-trial-worktree.js";

async function makeTempDir() {
  return mkdtemp(path.join(tmpdir(), "coding-agent-eval-worktree-"));
}

async function writeFixtureFile(root: string, relativePath: string, contents: string) {
  const filePath = path.join(root, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, contents, "utf8");
}

async function exists(filePath: string) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

describe("eval trial worktree filesystem seam", () => {
  it("creates isolated eval trial workspaces from identical starter files", async () => {
    const root = await makeTempDir();
    await writeFixtureFile(root, "starter/README.md", "original starter\n");
    await writeFixtureFile(root, "starter/src/app.ts", "export const value = 1;\n");

    const first = await prepareEvalTrialWorktree({
      suiteRoot: root,
      tempRoot: path.join(root, ".eval-agent"),
      evalTrialId: "claude__task__baseline__1",
      starterPath: "starter",
    });
    await writeFixtureFile(first.repoPath, "README.md", "mutated by first eval trial\n");

    const second = await prepareEvalTrialWorktree({
      suiteRoot: root,
      tempRoot: path.join(root, ".eval-agent"),
      evalTrialId: "opencode__task__baseline__1",
      starterPath: "starter",
    });

    expect(first.repoPath).not.toBe(second.repoPath);
    expect(first.repoPath).toContain(path.join(".eval-agent", "worktrees"));
    await expect(readFile(path.join(second.repoPath, "README.md"), "utf8")).resolves.toBe("original starter\n");
    await expect(readFile(path.join(second.repoPath, "src", "app.ts"), "utf8")).resolves.toBe("export const value = 1;\n");
  });

  it("applies repo overlays only to visible eval trial files before coding-agent execution", async () => {
    const root = await makeTempDir();
    await writeFixtureFile(root, "starter/README.md", "starter readme\n");
    await writeFixtureFile(root, "starter/src/app.ts", "starter app\n");
    await writeFixtureFile(root, "overlays/repo/README.md", "scenario variant readme\n");
    await writeFixtureFile(root, "overlays/repo/src/feature.ts", "scenario variant feature\n");

    const prepared = await prepareEvalTrialWorktree({
      suiteRoot: root,
      tempRoot: path.join(root, ".eval-agent"),
      evalTrialId: "claude__task__overlay__1",
      starterPath: "starter",
      repoOverlayPath: "overlays/repo",
    });

    await expect(readFile(path.join(prepared.repoPath, "README.md"), "utf8")).resolves.toBe("scenario variant readme\n");
    await expect(readFile(path.join(prepared.repoPath, "src", "app.ts"), "utf8")).resolves.toBe("starter app\n");
    await expect(readFile(path.join(prepared.repoPath, "src", "feature.ts"), "utf8")).resolves.toBe("scenario variant feature\n");
    await expect(exists(path.join(root, "starter", "src", "feature.ts"))).resolves.toBe(false);
  });

  it("stages agent-home overlays separately from starter files", async () => {
    const root = await makeTempDir();
    await writeFixtureFile(root, "starter/README.md", "starter\n");
    await writeFixtureFile(root, "overlays/home/skills/skill.md", "# Skill\n");
    await writeFixtureFile(root, "overlays/home/opencode.json", "{}\n");

    const prepared = await prepareEvalTrialWorktree({
      suiteRoot: root,
      tempRoot: path.join(root, ".eval-agent"),
      evalTrialId: "claude__task__skills__1",
      starterPath: "starter",
      agentHomeOverlayPath: "overlays/home",
    });

    await expect(readFile(path.join(prepared.agentHomePath, "skills", "skill.md"), "utf8")).resolves.toBe("# Skill\n");
    await expect(readFile(path.join(prepared.agentHomePath, "opencode.json"), "utf8")).resolves.toBe("{}\n");
    await expect(exists(path.join(prepared.repoPath, "skills", "skill.md"))).resolves.toBe(false);
    await expect(readFile(path.join(prepared.repoPath, "README.md"), "utf8")).resolves.toBe("starter\n");
  });

  it("keeps hidden acceptance material out of the eval trial workspace", async () => {
    const root = await makeTempDir();
    await writeFixtureFile(root, "starter/README.md", "starter\n");
    await writeFixtureFile(root, "acceptance/hidden/smoke.test.js", "throw new Error('hidden')\n");

    const prepared = await prepareEvalTrialWorktree({
      suiteRoot: root,
      tempRoot: path.join(root, ".eval-agent"),
      evalTrialId: "claude__task__baseline__1",
      starterPath: "starter",
      hiddenAcceptancePath: "acceptance/hidden",
    });

    await expect(exists(path.join(prepared.repoPath, "acceptance", "hidden", "smoke.test.js"))).resolves.toBe(false);
    await expect(exists(path.join(prepared.agentHomePath, "acceptance", "hidden", "smoke.test.js"))).resolves.toBe(false);
  });

  it("removes successful eval trial worktrees and preserves failed worktrees in metadata", async () => {
    const root = await makeTempDir();
    await writeFixtureFile(root, "starter/README.md", "starter\n");

    const successful = await prepareEvalTrialWorktree({
      suiteRoot: root,
      tempRoot: path.join(root, ".eval-agent"),
      evalTrialId: "claude__task__baseline__1",
      starterPath: "starter",
    });
    const failed = await prepareEvalTrialWorktree({
      suiteRoot: root,
      tempRoot: path.join(root, ".eval-agent"),
      evalTrialId: "opencode__task__baseline__1",
      starterPath: "starter",
    });

    const successMetadata = await finalizeEvalTrialWorktree(successful, { outcome: "success" });
    const failureMetadata = await finalizeEvalTrialWorktree(failed, { outcome: "failure" });

    await expect(exists(successful.rootPath)).resolves.toBe(false);
    expect(successMetadata).toEqual({ preserved: false, worktreePath: null, agentHomePath: null });
    await expect(exists(failed.rootPath)).resolves.toBe(true);
    expect(failureMetadata).toEqual({ preserved: true, worktreePath: failed.repoPath, agentHomePath: failed.agentHomePath });
  });
});
