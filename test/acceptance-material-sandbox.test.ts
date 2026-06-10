import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runAcceptanceMaterialSandbox } from "../src/acceptance-material-sandbox.js";

async function makeTempDir() {
  return mkdtemp(path.join(tmpdir(), "coding-agent-eval-acceptance-sandbox-"));
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

describe("Acceptance Material sandbox filesystem seam", () => {
  it("protects ADR-0002 by injecting hidden Acceptance Material only in a cleaned-up post-trial scoring sandbox", async () => {
    const suiteRoot = await makeTempDir();
    const completedRepoPath = path.join(suiteRoot, "completed-repo");
    const scoringRoot = path.join(suiteRoot, ".eval-agent", "scoring", "agent__task__baseline__1");
    await writeFixtureFile(completedRepoPath, "solution.txt", "completed work\n");
    await writeFixtureFile(
      suiteRoot,
      "acceptance/hidden/check.mjs",
      `import { mkdir, writeFile } from "node:fs/promises";
await mkdir("reports", { recursive: true });
await writeFile("reports/check.txt", ` + "`artifact ${process.env.SECRET_TOKEN}`" + `, "utf8");
console.log(` + "`stdout ${process.env.SECRET_TOKEN}`" + `);
console.error(` + "`stderr ${process.env.SECRET_TOKEN}`" + `);
`
    );
    process.env.SECRET_TOKEN = "super-secret-token";

    expect(await exists(path.join(completedRepoPath, "acceptance", "hidden", "check.mjs"))).toBe(false);

    const result = await runAcceptanceMaterialSandbox({
      suiteRoot,
      scoringRoot,
      completedRepoPath,
      hiddenDir: "acceptance/hidden",
      checks: [
        {
          id: "smoke",
          command: "node acceptance/hidden/check.mjs",
          cwd: ".",
          timeoutMs: 5000,
          weight: 1,
          env: { SECRET_TOKEN: "env:SECRET_TOKEN" },
          artifacts: ["reports/*.txt", "acceptance/hidden/*.mjs"],
        },
      ],
      secretValues: ["super-secret-token"],
      afterAcceptanceChecks: async ({ scoringRepoPath }) => {
        await expect(readFile(path.join(scoringRepoPath, "solution.txt"), "utf8")).resolves.toBe("completed work\n");
        await expect(readFile(path.join(scoringRepoPath, "acceptance", "hidden", "check.mjs"), "utf8")).resolves.toContain("SECRET_TOKEN");
      },
    });

    expect(result.acceptanceChecks).toEqual([
      expect.objectContaining({
        id: "smoke",
        command: "node acceptance/hidden/check.mjs",
        cwd: ".",
        timeoutMs: 5000,
        weight: 1,
        env: { SECRET_TOKEN: "[env]" },
        stdout: "stdout [REDACTED]\n",
        stderr: "stderr [REDACTED]\n",
        exitCode: 0,
        timedOut: false,
        durationMs: expect.any(Number),
        artifacts: [{ path: "reports/check.txt", contents: "artifact [REDACTED]" }],
      }),
    ]);
    expect(JSON.stringify(result.acceptanceChecks)).not.toContain("super-secret-token");
    expect(JSON.stringify(result.acceptanceChecks)).not.toContain("acceptance/hidden/check.mjs\",\"contents");
    expect(await exists(scoringRoot)).toBe(false);
    expect(await exists(path.join(completedRepoPath, "acceptance", "hidden", "check.mjs"))).toBe(false);
  });

  it("collects only visible artifacts and normalizes artifact paths", async () => {
    const suiteRoot = await makeTempDir();
    const completedRepoPath = path.join(suiteRoot, "completed-repo");
    const scoringRoot = path.join(suiteRoot, ".eval-agent", "scoring", "agent__task__baseline__1");
    await writeFixtureFile(completedRepoPath, "reports/output.txt", "visible artifact\n");
    await writeFixtureFile(completedRepoPath, ".git/config", "git metadata\n");
    await writeFixtureFile(suiteRoot, "acceptance/hidden/check.mjs", "console.log('ok');\n");

    const result = await runAcceptanceMaterialSandbox({
      suiteRoot,
      scoringRoot,
      completedRepoPath,
      hiddenDir: "acceptance/hidden",
      checks: [{ id: "artifacts", command: "node acceptance/hidden/check.mjs", cwd: ".", timeoutMs: 5000, weight: 1, env: {}, artifacts: ["reports/*.txt", ".git/*"] }],
      secretValues: [],
    });

    expect(result.acceptanceChecks[0]?.artifacts).toEqual([{ path: "reports/output.txt", contents: "visible artifact\n" }]);
  });

  it("preserves deterministic check failures, timeout behavior, and safe cwd cleanup", async () => {
    const suiteRoot = await makeTempDir();
    const completedRepoPath = path.join(suiteRoot, "completed-repo");
    const scoringRoot = path.join(suiteRoot, ".eval-agent", "scoring", "agent__task__baseline__1");
    await writeFixtureFile(completedRepoPath, "README.md", "completed work\n");
    await writeFixtureFile(suiteRoot, "acceptance/hidden/fail.mjs", "console.error('failed check'); process.exit(7);\n");
    await writeFixtureFile(suiteRoot, "acceptance/hidden/timeout.mjs", "setTimeout(() => {}, 1000);\n");

    const result = await runAcceptanceMaterialSandbox({
      suiteRoot,
      scoringRoot,
      completedRepoPath,
      hiddenDir: "acceptance/hidden",
      checks: [
        { id: "fails", command: "node acceptance/hidden/fail.mjs", cwd: ".", timeoutMs: 500, weight: 1, env: {}, artifacts: [] },
        { id: "times-out", command: "node acceptance/hidden/timeout.mjs", cwd: ".", timeoutMs: 50, weight: 1, env: {}, artifacts: [] },
      ],
      secretValues: [],
    });

    expect(result.acceptanceChecks).toEqual([
      expect.objectContaining({ id: "fails", exitCode: 7, timedOut: false, stderr: "failed check\n" }),
      expect.objectContaining({ id: "times-out", exitCode: null, timedOut: true }),
    ]);
    expect(await exists(scoringRoot)).toBe(false);

    await expect(
      runAcceptanceMaterialSandbox({
        suiteRoot,
        scoringRoot,
        completedRepoPath,
        hiddenDir: "acceptance/hidden",
        checks: [{ id: "unsafe", command: "pwd", cwd: "..", timeoutMs: 500, weight: 1, env: {}, artifacts: [] }],
        secretValues: [],
      })
    ).rejects.toThrow("acceptance check cwd must stay inside the eval trial scoring sandbox");
    expect(await exists(scoringRoot)).toBe(false);
  });
});
