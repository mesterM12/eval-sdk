import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runEvaluatorAgent, type EvaluatorAgentExecutorInput } from "../src/evaluator-agent.js";
import type { AcceptanceCheckResult } from "../src/acceptance-material-sandbox.js";

async function makeTempDir() {
  return mkdtemp(path.join(tmpdir(), "coding-agent-eval-evaluator-agent-"));
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

const deterministicResult = (overrides: Partial<AcceptanceCheckResult> = {}): AcceptanceCheckResult => ({
  id: "smoke",
  command: "npm test",
  cwd: ".",
  timeoutMs: 1000,
  weight: 1,
  stdout: "pass\n",
  stderr: "",
  exitCode: 0,
  timedOut: false,
  durationMs: 12,
  artifacts: [],
  ...overrides,
});

describe("Evaluator Agent module", () => {
  it("constructs prompts from deterministic Acceptance Material results and rubric docs, then returns structured rationale", async () => {
    const suiteRoot = await makeTempDir();
    await writeFixtureFile(suiteRoot, "prompts/evaluator.md", "# Base Evaluator Agent Prompt\nBe strict.\n");
    await writeFixtureFile(suiteRoot, "rubrics/quality.md", "# Quality\nScore quality.\n");
    await writeFixtureFile(suiteRoot, "repo/solution.txt", "completed work\n");

    const calls: EvaluatorAgentExecutorInput[] = [];
    const result = await runEvaluatorAgent({
      suiteRoot,
      evalTrialId: "agent__task__baseline__1",
      scoringRepoPath: path.join(suiteRoot, "repo"),
      deterministicResults: [deterministicResult()],
      rubrics: [{ id: "quality", path: "rubrics/quality.md", weight: 2, scale: { min: 1, max: 5 } }],
      evaluatorAgent: { id: "evaluator", provider: "opencode", model: "judge-model", prompt: "prompts/evaluator.md" },
      secretValues: [],
      executor: async (input) => {
        calls.push(input);
        return { stdout: JSON.stringify({ criteria: [{ id: "quality", score: 4, rationale: "Clear." }], summary: "Good." }) };
      },
    });

    expect(result).toMatchObject({
      providerName: "opencode",
      model: "judge-model",
      status: "success",
      result: { criteria: [{ id: "quality", score: 4, rationale: "Clear." }], summary: "Good." },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(expect.objectContaining({
      providerName: "opencode",
      model: "judge-model",
      scoringContextPath: path.join(suiteRoot, "repo"),
      readOnly: true,
      deterministicResults: [expect.objectContaining({ id: "smoke", exitCode: 0 })],
      rubrics: [{ id: "quality", path: "rubrics/quality.md", weight: 2, scale: { min: 1, max: 5 } }],
    }));
    expect(calls[0]!.prompt).toContain("# Base Evaluator Agent Prompt");
    expect(calls[0]!.prompt).toContain('"id": "smoke"');
    expect(calls[0]!.prompt).toContain('"contents": "# Quality\\nScore quality.\\n"');
  });

  it("skips execution when no Evaluator Agent provider is configured", async () => {
    const suiteRoot = await makeTempDir();
    await writeFixtureFile(suiteRoot, "repo/solution.txt", "completed work\n");

    const result = await runEvaluatorAgent({
      suiteRoot,
      evalTrialId: "agent__task__baseline__1",
      scoringRepoPath: path.join(suiteRoot, "repo"),
      deterministicResults: [],
      rubrics: [],
      evaluatorAgent: undefined,
      secretValues: [],
      executor: async () => {
        throw new Error("should not execute");
      },
    });

    expect(result).toEqual({ status: "skipped" });
  });

  it.each([
    ["malformed JSON", "not json", "valid JSON"],
    ["extra top-level keys", JSON.stringify({ criteria: [], summary: "ok", extra: true }), "only criteria and summary"],
    ["missing summary", JSON.stringify({ criteria: [] }), "only criteria and summary"],
    ["invalid score types", JSON.stringify({ criteria: [{ id: "quality", score: "5", rationale: "No." }], summary: "bad" }), "invalid schema"],
    ["invalid criteria", JSON.stringify({ criteria: [{ id: "unknown", score: 5, rationale: "No." }], summary: "bad" }), "unknown rubric"],
    ["missing criteria", JSON.stringify({ criteria: [], summary: "bad" }), "missing rubric"],
  ])("records %s as Evaluator Agent failures", async (_name, stdout, errorText) => {
    const suiteRoot = await makeTempDir();
    await writeFixtureFile(suiteRoot, "repo/solution.txt", "completed work\n");
    await writeFixtureFile(suiteRoot, "rubrics/quality.md", "# Quality\n");

    const result = await runEvaluatorAgent({
      suiteRoot,
      evalTrialId: "agent__task__baseline__1",
      scoringRepoPath: path.join(suiteRoot, "repo"),
      deterministicResults: [deterministicResult()],
      rubrics: [{ id: "quality", path: "rubrics/quality.md", weight: 1, scale: { min: 1, max: 5 } }],
      evaluatorAgent: { id: "evaluator", provider: "opencode" },
      secretValues: [],
      executor: async () => ({ stdout }),
    });

    expect(result).toEqual(expect.objectContaining({ status: "failed", error: expect.stringContaining(errorText) }));
  });

  it("records failed Evaluator Agent execution without throwing", async () => {
    const suiteRoot = await makeTempDir();
    await writeFixtureFile(suiteRoot, "repo/solution.txt", "completed work\n");

    const result = await runEvaluatorAgent({
      suiteRoot,
      evalTrialId: "agent__task__baseline__1",
      scoringRepoPath: path.join(suiteRoot, "repo"),
      deterministicResults: [],
      rubrics: [],
      evaluatorAgent: { id: "evaluator", provider: "opencode" },
      secretValues: [],
      executor: async () => {
        throw new Error("adapter failed");
      },
    });

    expect(result).toEqual(expect.objectContaining({ providerName: "opencode", status: "failed", error: "adapter failed" }));
  });

  it("records read-only scoring context mutations as Evaluator Agent failures", async () => {
    const suiteRoot = await makeTempDir();
    await writeFixtureFile(suiteRoot, "repo/solution.txt", "completed work\n");

    const result = await runEvaluatorAgent({
      suiteRoot,
      evalTrialId: "agent__task__baseline__1",
      scoringRepoPath: path.join(suiteRoot, "repo"),
      deterministicResults: [],
      rubrics: [],
      evaluatorAgent: { id: "evaluator", provider: "opencode" },
      secretValues: [],
      executor: async (input) => {
        await writeFixtureFile(input.scoringContextPath, "new-file.txt", "mutated\n");
        return { stdout: JSON.stringify({ criteria: [], summary: "Done." }) };
      },
    });

    expect(result).toEqual(expect.objectContaining({ status: "failed", error: expect.stringContaining("read-only scoring context") }));
    expect(await exists(path.join(suiteRoot, "repo", "new-file.txt"))).toBe(true);
  });

  it("redacts secrets from successful Evaluator Agent stdout and stderr", async () => {
    const suiteRoot = await makeTempDir();
    await writeFixtureFile(suiteRoot, "repo/solution.txt", "completed work\n");

    const result = await runEvaluatorAgent({
      suiteRoot,
      evalTrialId: "agent__task__baseline__1",
      scoringRepoPath: path.join(suiteRoot, "repo"),
      deterministicResults: [],
      rubrics: [],
      evaluatorAgent: { id: "evaluator", provider: "opencode" },
      secretValues: ["super-secret"],
      executor: async () => ({ stdout: '{"criteria":[],"summary":"super-secret"}', stderr: "stderr super-secret" }),
    });

    expect(result).toEqual(expect.objectContaining({ status: "success", stdout: '{"criteria":[],"summary":"[REDACTED]"}', stderr: "stderr [REDACTED]" }));
  });
});
