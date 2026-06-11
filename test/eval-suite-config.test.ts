import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadEvalSuiteConfig } from "../src/eval-suite-config.js";
import { supportedSandcastleBuiltInProviders } from "../src/sandcastle-provider-registry.js";

async function makeSuiteRoot() {
  return mkdtemp(path.join(tmpdir(), "coding-agent-eval-config-"));
}

async function writeFixtureFile(root: string, relativePath: string, contents: string) {
  const filePath = path.join(root, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, contents, "utf8");
}

async function writeValidSuite(root: string, extraConfig = "") {
  await writeFixtureFile(root, "prompts/task.md", "# Task\n");
  await writeFixtureFile(root, "starter/README.md", "# Starter\n");
  await writeFixtureFile(root, "acceptance/hidden/smoke.test.js", "console.log('ok')\n");
  await writeFixtureFile(root, "rubrics/maintainability.md", "# Maintainability\n");
  await writeFixtureFile(
    root,
    "eval-suite.yaml",
    `sandbox:
  provider: docker
agents:
  - id: claude
    provider: claude-code
    model: claude-opus-4-7
evaluatorAgent:
  id: evaluator
  provider: opencode
tasks:
  - id: hello
    prompt: prompts/task.md
    starter: starter
    scoring:
      deterministicWeight: 0.7
      rubricWeight: 0.3
    acceptanceMaterial:
      hiddenDir: acceptance/hidden
      checks:
        - id: smoke
          command: npm test
      rubrics:
        - id: maintainability
          path: rubrics/maintainability.md
scenarioVariants:
  - id: baseline
matrix:
  runIndexes: [1]
${extraConfig}`
  );
}

describe("Eval Suite config", () => {
  it("parses, validates, and normalizes the shape consumed by adapters and deep modules", async () => {
    const suiteRoot = await makeSuiteRoot();
    await writeValidSuite(suiteRoot);

    const suite = await loadEvalSuiteConfig(path.join(suiteRoot, "eval-suite.yaml"));

    expect(suite.suiteRoot).toBe(suiteRoot);
    expect(suite.config.agents).toEqual([{ id: "claude", provider: "claude-code", model: "claude-opus-4-7" }]);
    expect(suite.config.evaluatorAgent).toEqual({ id: "evaluator", provider: "opencode" });
    expect(suite.config.tasks[0]).toMatchObject({
      id: "hello",
      prompt: "prompts/task.md",
      starter: "starter",
      scoring: { deterministicWeight: 0.7, rubricWeight: 0.3 },
      acceptanceMaterial: {
        hiddenDir: "acceptance/hidden",
        checks: [{ id: "smoke", command: "npm test", cwd: ".", timeoutMs: 30000, weight: 1, env: {}, artifacts: [] }],
        rubrics: [{ id: "maintainability", path: "rubrics/maintainability.md", weight: 1, scale: { min: 1, max: 5 } }],
      },
    });
    expect(suite.config.matrix).toEqual({ runIndexes: [1], include: [], exclude: [] });
    expect(suite.summary).toEqual({ tasks: 1, agents: 1, scenarioVariants: 1 });
  });

  it("allows local host execution for suites that use locally authenticated coding agents", async () => {
    const suiteRoot = await makeSuiteRoot();
    await writeValidSuite(suiteRoot);
    await writeFixtureFile(
      suiteRoot,
      "eval-suite.yaml",
      `sandbox:
  provider: local
agents:
  - id: claude
    provider: claude-code
    model: claude-opus-4-7
evaluatorAgent:
  id: evaluator
  provider: opencode
tasks:
  - id: hello
    prompt: prompts/task.md
    starter: starter
    scoring:
      deterministicWeight: 0.7
      rubricWeight: 0.3
    acceptanceMaterial:
      hiddenDir: acceptance/hidden
      checks:
        - id: smoke
          command: npm test
      rubrics:
        - id: maintainability
          path: rubrics/maintainability.md
scenarioVariants:
  - id: baseline
matrix:
  runIndexes: [1]
`
    );

    const suite = await loadEvalSuiteConfig(path.join(suiteRoot, "eval-suite.yaml"));

    expect(suite.config.sandbox).toEqual({ provider: "local" });
  });

  it.each(supportedSandcastleBuiltInProviders)("accepts shared Sandcastle built-in provider %s", async (provider) => {
    const suiteRoot = await makeSuiteRoot();
    await writeFixtureFile(suiteRoot, "prompts/task.md", "# Task\n");
    await writeFixtureFile(suiteRoot, "starter/README.md", "# Starter\n");
    await writeFixtureFile(suiteRoot, "acceptance/hidden/smoke.test.js", "console.log('ok')\n");
    await writeFixtureFile(suiteRoot, "rubrics/maintainability.md", "# Maintainability\n");
    await writeFixtureFile(
      suiteRoot,
      "eval-suite.yaml",
      `sandbox:
  provider: docker
agents:
  - id: agent
    provider: ${provider}
evaluatorAgent:
  id: evaluator
  provider: ${provider}
tasks:
  - id: hello
    prompt: prompts/task.md
    starter: starter
    scoring:
      deterministicWeight: 1
      rubricWeight: 0
    acceptanceMaterial:
      hiddenDir: acceptance/hidden
      checks:
        - id: smoke
          command: npm test
      rubrics:
        - id: maintainability
          path: rubrics/maintainability.md
scenarioVariants:
  - id: baseline
matrix:
  runIndexes: [1]
`
    );

    const suite = await loadEvalSuiteConfig(path.join(suiteRoot, "eval-suite.yaml"));

    expect(suite.config.agents[0]?.provider).toBe(provider);
    expect(suite.config.evaluatorAgent.provider).toBe(provider);
  });

  it("reports config module errors for unsafe paths, selectors, pricing, weights, providers, env refs, duplicates, and Acceptance Material refs", async () => {
    const suiteRoot = await makeSuiteRoot();
    await writeValidSuite(
      suiteRoot,
      `pricing:
  - id: bad-price
    provider: claude-code
    model: missing-model
    inputPerMillion: -1
    outputPerMillion: 0
`
    );
    await writeFixtureFile(
      suiteRoot,
      "eval-suite.yaml",
      `sandbox:
  provider: host
agents:
  - id: dup
    provider: custom-agent
    env:
      API_KEY: literal
  - id: dup
    provider: claude-code
evaluatorAgent:
  id: evaluator
  provider: opencode
tasks:
  - id: task
    prompt: /tmp/task.md
    starter: ../starter
    scoring:
      deterministicWeight: 0.2
      rubricWeight: 0.2
    acceptanceMaterial:
      hiddenDir: missing-hidden
      checks:
        - id: smoke
          command: npm test
      rubrics:
        - id: maintainability
          path: rubrics/missing.md
scenarioVariants:
  - id: baseline
matrix:
  runIndexes: [1]
  include:
    - agent: missing-agent
      task: task
      scenarioVariant: baseline
      runIndex: 2
pricing:
  - id: bad-price
    provider: claude-code
    model: missing-model
    inputPerMillion: -1
    outputPerMillion: 0
`
    );

    await expect(loadEvalSuiteConfig(path.join(suiteRoot, "eval-suite.yaml"))).rejects.toThrowError(
      /sandbox\.provider must be docker or local[\s\S]*duplicate agents id: dup[\s\S]*agent dup provider must be a Sandcastle built-in provider[\s\S]*agent dup env API_KEY must be an env var reference like env:API_KEY[\s\S]*task task prompt must be a relative path[\s\S]*task task starter must be a relative path[\s\S]*task task scoring deterministicWeight and rubricWeight must sum to 1[\s\S]*task task hidden acceptance material directory does not exist: missing-hidden[\s\S]*task task rubric maintainability does not exist: rubrics\/missing.md[\s\S]*matrix\.include\[0\]\.agent must reference an agent id: missing-agent[\s\S]*pricing bad-price inputPerMillion must be a positive number[\s\S]*pricing bad-price outputPerMillion must be a positive number[\s\S]*pricing bad-price must match a configured agent or evaluator agent provider\/model/
    );
  });

  it("reports malformed and non-object suite configs clearly", async () => {
    const suiteRoot = await makeSuiteRoot();
    await writeFixtureFile(suiteRoot, "malformed.yaml", "agents: [");
    await writeFixtureFile(suiteRoot, "array.yaml", "[]\n");

    await expect(loadEvalSuiteConfig(path.join(suiteRoot, "malformed.yaml"))).rejects.toThrow("config YAML is malformed");
    await expect(loadEvalSuiteConfig(path.join(suiteRoot, "array.yaml"))).rejects.toThrow("config must be a YAML object");
  });

  it("reports rubric scale and matrix selector edge cases", async () => {
    const suiteRoot = await makeSuiteRoot();
    await writeValidSuite(suiteRoot);
    await writeFixtureFile(
      suiteRoot,
      "eval-suite.yaml",
      `sandbox:
  provider: docker
agents:
  - id: claude
    provider: claude-code
    model: claude-opus-4-7
evaluatorAgent:
  id: evaluator
  provider: opencode
tasks:
  - id: hello
    prompt: prompts/task.md
    starter: starter
    scoring:
      deterministicWeight: 0.7
      rubricWeight: 0.3
    acceptanceMaterial:
      hiddenDir: acceptance/hidden
      checks:
        - id: smoke
          command: npm test
      rubrics:
        - id: maintainability
          path: rubrics/maintainability.md
          scale:
            min: 5
            max: 1
        - id: completeness
          path: rubrics/maintainability.md
          scale: {}
scenarioVariants:
  - id: baseline
matrix:
  runIndexes: [1]
  baselineScenarioVariant: missing-baseline
  include:
    - agent: claude
      task: hello
      scenarioVariant: missing-variant
      runIndex: 0
  exclude:
    - agent: claude
      task: hello
      scenarioVariant: baseline
      runIndex: 2
`
    );

    await expect(loadEvalSuiteConfig(path.join(suiteRoot, "eval-suite.yaml"))).rejects.toThrowError(
      /task hello rubric maintainability scale min must be less than max[\s\S]*task hello rubric completeness scale min and max are required[\s\S]*matrix\.baselineScenarioVariant must reference a scenario variant id: missing-baseline[\s\S]*matrix\.include\[0\]\.scenarioVariant must reference a scenario variant id: missing-variant[\s\S]*matrix\.include\[0\]\.runIndex must be a positive integer: 0[\s\S]*matrix\.exclude\[0\]\.runIndex must reference matrix\.runIndexes: 2/
    );
  });

  it("reports missing providers, Markdown extension mistakes, and missing selector task refs", async () => {
    const suiteRoot = await makeSuiteRoot();
    await writeFixtureFile(suiteRoot, "prompts/task.txt", "# Task\n");
    await writeFixtureFile(suiteRoot, "prompts/evaluator.txt", "# Evaluator\n");
    await writeFixtureFile(suiteRoot, "starter/README.md", "# Starter\n");
    await writeFixtureFile(suiteRoot, "acceptance/hidden/smoke.test.js", "console.log('ok')\n");
    await writeFixtureFile(suiteRoot, "rubrics/maintainability.txt", "# Maintainability\n");
    await writeFixtureFile(
      suiteRoot,
      "eval-suite.yaml",
      `sandbox:
  provider: docker
agents:
  - id: claude
evaluatorAgent:
  id: evaluator
  prompt: prompts/evaluator.txt
tasks:
  - id: hello
    prompt: prompts/task.txt
    starter: starter
    scoring:
      deterministicWeight: 1
      rubricWeight: 0
    acceptanceMaterial:
      hiddenDir: acceptance/hidden
      checks:
        - id: smoke
          command: npm test
      rubrics:
        - id: maintainability
          path: rubrics/maintainability.txt
scenarioVariants:
  - id: baseline
matrix:
  runIndexes: [1]
  exclude:
    - agent: claude
      task: missing-task
      scenarioVariant: baseline
      runIndex: 1
`
    );

    await expect(loadEvalSuiteConfig(path.join(suiteRoot, "eval-suite.yaml"))).rejects.toThrowError(
      /evaluatorAgent provider is required[\s\S]*evaluatorAgent prompt must reference a Markdown file[\s\S]*agent claude provider is required[\s\S]*task hello prompt must reference a Markdown file[\s\S]*task hello rubric maintainability must reference a Markdown file[\s\S]*matrix\.exclude\[0\]\.task must reference a task id: missing-task/
    );
  });
});
