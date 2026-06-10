import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("architecture module map documentation", () => {
  it("documents deep modules, their locality, leverage, and ADR constraints", async () => {
    const doc = await readFile(path.join(process.cwd(), "docs", "architecture-module-map.md"), "utf8");

    for (const term of ["Eval Trial", "Trial Matrix", "Scenario Variant", "Acceptance Material", "Evaluator Agent", "Eval Score"]) {
      expect(doc).toContain(term);
    }

    for (const term of ["module", "interface", "implementation", "depth", "deep", "shallow", "seam", "adapter", "leverage", "locality"]) {
      expect(doc).toContain(term);
    }

    for (const moduleName of [
      "Eval Suite Config",
      "Eval Trial Identity",
      "Acceptance Material Sandbox",
      "Eval Score And Scoring",
      "Evaluator Agent",
      "Coding Agent Adapter",
      "Sandbox Provider And Sandcastle Provider Registry",
      "Git Work",
      "Eval Trial Worktree",
      "Reports",
      "Eval Trial Execution Orchestration",
    ]) {
      expect(doc).toContain(`## ${moduleName}`);
    }

    expect(doc).toContain("docs/adr/0001-deterministic-tests-anchor-scoring.md");
    expect(doc).toContain("docs/adr/0002-hidden-acceptance-runs-in-post-trial-scoring-sandbox.md");
    expect(doc).toContain("Hidden Acceptance Material is not a worktree concern");
    expect(doc).toContain("Sandbox Provider support");

    for (const heading of doc.matchAll(/^## .+$/gm)) {
      const sectionStart = heading.index ?? 0;
      const nextSection = doc.indexOf("\n## ", sectionStart + 1);
      const section = doc.slice(sectionStart, nextSection === -1 ? undefined : nextSection);
      expect(section).toContain("Locality:");
      expect(section).toContain("Leverage:");
    }

    for (const forbidden of ["component", "service", "api", "boundary"]) {
      expect(doc.toLowerCase()).not.toMatch(new RegExp(`\\b${forbidden}\\b`));
    }
  });
});
