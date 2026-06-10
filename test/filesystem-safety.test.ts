import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { listVisibleFiles, normalizeRelativePath, resolveScoringRootPath, resolveSuitePath } from "../src/filesystem-safety.js";

async function makeTempDir() {
  return mkdtemp(path.join(tmpdir(), "coding-agent-eval-filesystem-safety-"));
}

async function writeFixtureFile(root: string, relativePath: string, contents: string) {
  const filePath = path.join(root, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, contents, "utf8");
}

describe("filesystem safety module", () => {
  it("owns suite and scoring containment plus relative path normalization", () => {
    const root = path.resolve("/tmp/eval-suite");

    expect(resolveSuitePath(root, "starter/README.md")).toBe(path.join(root, "starter", "README.md"));
    expect(resolveScoringRootPath(root, ".")).toBe(root);
    expect(resolveScoringRootPath(root, "reports/output.txt")).toBe(path.join(root, "reports", "output.txt"));
    expect(normalizeRelativePath("./reports\\nested/output.txt")).toBe("reports/nested/output.txt");

    expect(() => resolveSuitePath(root, "../outside")).toThrow("eval trial path must stay inside the suite root");
    expect(() => resolveSuitePath(root, path.join(path.dirname(root), "outside"))).toThrow("eval trial path must stay inside the suite root");
    expect(() => resolveScoringRootPath(root, "../outside")).toThrow("acceptance check cwd must stay inside the eval trial scoring sandbox");
  });

  it("lists visible files recursively while excluding .git", async () => {
    const root = await makeTempDir();
    await writeFixtureFile(root, "README.md", "visible\n");
    await writeFixtureFile(root, "src/app.ts", "export {};\n");
    await writeFixtureFile(root, ".git/config", "hidden\n");
    await writeFixtureFile(root, "src/.git/HEAD", "hidden nested\n");

    await expect(listVisibleFiles(root)).resolves.toEqual(["README.md", "src/app.ts"]);
  });
});
