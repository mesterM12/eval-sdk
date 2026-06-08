#!/usr/bin/env node
import { Command } from "commander";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { executeEvalTrials } from "./eval-trial-execution.js";
import { generateReports } from "./report.js";

const DEFAULT_CONFIG = "eval-suite.yaml";

type EvalSuiteConfig = {
  sandbox?: { provider?: string };
  agents?: Array<{ id?: string; provider?: string; model?: string; env?: Record<string, string> }>;
  evaluatorAgent?: { id?: string; provider?: string; model?: string; prompt?: string; env?: Record<string, string> };
  tasks?: Array<{
    id?: string;
    prompt?: string;
    starter?: string;
    scoring?: { deterministicWeight?: number; rubricWeight?: number };
    acceptanceMaterial?: {
      hiddenDir?: string;
      checks?: Array<{
        id?: string;
        command?: string;
        cwd?: string;
        timeoutMs?: number;
        weight?: number;
        env?: Record<string, string>;
        artifacts?: string[];
      }>;
      rubrics?: Array<{ id?: string; path?: string; weight?: number; scale?: { min?: number; max?: number } }>;
    };
  }>;
  scenarioVariants?: Array<{ id?: string; description?: string; prompt?: string; repoOverlay?: string; agentHomeOverlay?: string }>;
  matrix?: {
    runIndexes?: number[];
    baselineScenarioVariant?: string;
    include?: MatrixSelector[];
    exclude?: MatrixSelector[];
  };
  pricing?: Array<{ id?: string; provider?: string; model?: string; inputPerMillion?: number; outputPerMillion?: number }>;
  report?: { prompt?: string };
};

type MatrixSelector = { agent?: string; task?: string; scenarioVariant?: string; runIndex?: number };

const SANDCASTLE_BUILT_IN_PROVIDERS = new Set(["claude-code", "pi", "codex", "opencode", "cursor", "copilot"]);

async function exists(filePath: string) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function writeNewFile(filePath: string, contents: string) {
  if (await exists(filePath)) {
    throw new Error(`${path.relative(process.cwd(), filePath)} already exists`);
  }
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, contents, "utf8");
}

async function initSuite() {
  const cwd = process.cwd();
  await writeNewFile(
    path.join(cwd, DEFAULT_CONFIG),
    `sandbox:
  provider: docker

agents:
  - id: example-agent
    provider: claude-code

evaluatorAgent:
  id: example-evaluator
  provider: opencode

tasks:
  - id: hello-world
    prompt: prompts/task.md
    starter: starter
    scoring:
      deterministicWeight: 0.7
      rubricWeight: 0.3
    acceptanceMaterial:
      hiddenDir: acceptance/hidden
      checks:
        - id: smoke
          command: node smoke.test.js
      rubrics:
        - id: maintainability
          path: rubrics/maintainability.md
          weight: 1

scenarioVariants:
  - id: baseline
    description: Baseline scenario variant for the trial matrix.

matrix:
  runIndexes: [1]
`
  );
  await writeNewFile(
    path.join(cwd, "prompts", "task.md"),
    `# Task Prompt

Update the starter project for one eval trial. The trial matrix combines this task with the baseline scenario variant.
`
  );
  await writeNewFile(
    path.join(cwd, "starter", "README.md"),
    `# Starter Project

Visible starter files for the eval trial live here.
`
  );
  await writeNewFile(
    path.join(cwd, "acceptance", "hidden", "smoke.test.js"),
    `import assert from "node:assert/strict";

assert.ok(true, "hidden acceptance material smoke check passes");
`
  );
  await writeNewFile(
    path.join(cwd, "rubrics", "maintainability.md"),
    `# Maintainability Rubric

Evaluator agent rubric docs contribute to the eval score after deterministic acceptance material runs.
`
  );
  console.log(`Created minimal eval suite in ${cwd}`);
}

function requireArray(value: unknown, name: string): asserts value is unknown[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${name} must be a non-empty array`);
  }
}

function requireNonEmptyArray(value: unknown, name: string, errors: string[]): value is unknown[] {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(`${name} must be a non-empty array`);
    return false;
  }
  return true;
}

function duplicateIds(items: Array<{ id?: string }> | undefined, label: string, errors: string[]) {
  const seen = new Set<string>();
  const reported = new Set<string>();
  for (const item of items ?? []) {
    if (!item?.id) continue;
    if (seen.has(item.id) && !reported.has(item.id)) {
      errors.push(`duplicate ${label} id: ${item.id}`);
      reported.add(item.id);
    }
    seen.add(item.id);
  }
}

function ids(items: Array<{ id?: string }> | undefined) {
  return new Set((items ?? []).map((item) => item.id).filter((id): id is string => typeof id === "string" && id.length > 0));
}

function isRelativeSafePath(value: string) {
  return value.length > 0 && !path.isAbsolute(value) && !value.split(/[\\/]+/).includes("..");
}

async function checkPath(root: string, relativePath: string | undefined, label: string, errors: string[]) {
  if (!relativePath) {
    errors.push(`${label} is required`);
    return;
  }
  if (!isRelativeSafePath(relativePath)) {
    errors.push(`${label} must be a relative path`);
    return;
  }
  if (!(await exists(path.resolve(root, relativePath)))) {
    errors.push(`${label} does not exist: ${relativePath}`);
  }
}

async function checkMarkdownPath(root: string, relativePath: string | undefined, label: string, errors: string[]) {
  if (relativePath && !relativePath.endsWith(".md")) {
    errors.push(`${label} must reference a Markdown file`);
  }
  await checkPath(root, relativePath, label, errors);
}

function checkEnvRefs(env: Record<string, string> | undefined, label: string, errors: string[]) {
  if (!env) return;
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== "string" || !/^env:[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
      errors.push(`${label} env ${name} must be an env var reference like env:API_KEY`);
    }
  }
}

function checkProvider(provider: string | undefined, label: string, errors: string[]) {
  if (!provider) {
    errors.push(`${label} provider is required`);
    return;
  }
  if (!SANDCASTLE_BUILT_IN_PROVIDERS.has(provider)) {
    errors.push(`${label} provider must be a Sandcastle built-in provider`);
  }
}

function checkPositiveNumber(value: number | undefined, label: string, errors: string[]) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    errors.push(`${label} must be a positive number`);
  }
}

function checkSelector(
  selector: MatrixSelector,
  label: string,
  references: { agents: Set<string>; tasks: Set<string>; scenarioVariants: Set<string>; runIndexes: Set<number> },
  errors: string[],
  options: { allowRunIndexOutsideMatrix?: boolean } = {}
) {
  if (!selector.agent || !references.agents.has(selector.agent)) {
    errors.push(`${label}.agent must reference an agent id: ${selector.agent ?? ""}`);
  }
  if (!selector.task || !references.tasks.has(selector.task)) {
    errors.push(`${label}.task must reference a task id: ${selector.task ?? ""}`);
  }
  if (!selector.scenarioVariant || !references.scenarioVariants.has(selector.scenarioVariant)) {
    errors.push(`${label}.scenarioVariant must reference a scenario variant id: ${selector.scenarioVariant ?? ""}`);
  }
  if (options.allowRunIndexOutsideMatrix) {
    if (typeof selector.runIndex !== "number" || !Number.isInteger(selector.runIndex) || selector.runIndex <= 0) {
      errors.push(`${label}.runIndex must be a positive integer: ${selector.runIndex ?? ""}`);
    }
  } else if (typeof selector.runIndex !== "number" || !references.runIndexes.has(selector.runIndex)) {
    errors.push(`${label}.runIndex must reference matrix.runIndexes: ${selector.runIndex ?? ""}`);
  }
}

async function validateSuite(configPath: string) {
  const absoluteConfigPath = path.resolve(process.cwd(), configPath);
  const root = path.dirname(absoluteConfigPath);
  const config = await readConfig(absoluteConfigPath);
  const errors: string[] = [];

  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("invalid eval suite:\n- config must be a YAML object");
  }

  if (config.sandbox?.provider !== "docker") {
    errors.push("sandbox.provider must be docker");
  }

  const hasAgents = requireNonEmptyArray(config.agents, "agents", errors);
  const hasTasks = requireNonEmptyArray(config.tasks, "tasks", errors);
  const hasScenarioVariants = requireNonEmptyArray(config.scenarioVariants, "scenarioVariants", errors);
  if (!config.evaluatorAgent?.id) errors.push("evaluatorAgent id is required");
  checkProvider(config.evaluatorAgent?.provider, "evaluatorAgent", errors);
  if (config.evaluatorAgent?.prompt) await checkMarkdownPath(root, config.evaluatorAgent.prompt, "evaluatorAgent prompt", errors);
  checkEnvRefs(config.evaluatorAgent?.env, "evaluatorAgent", errors);

  duplicateIds(config.agents, "agents", errors);
  duplicateIds(config.tasks, "tasks", errors);
  duplicateIds(config.scenarioVariants, "scenarioVariants", errors);
  duplicateIds(config.pricing, "pricing", errors);

  const agentIds = ids(config.agents);
  const taskIds = ids(config.tasks);
  const scenarioVariantIds = ids(config.scenarioVariants);
  const runIndexes = config.matrix?.runIndexes ?? [];
  const runIndexIds = new Set(runIndexes);

  if (!Array.isArray(config.matrix?.runIndexes) || config.matrix.runIndexes.length === 0) {
    errors.push("matrix.runIndexes must be a non-empty array");
  } else if (runIndexes.some((runIndex) => !Number.isInteger(runIndex) || runIndex <= 0) || runIndexIds.size !== runIndexes.length) {
    errors.push("matrix.runIndexes must contain positive unique integers");
  }

  if (hasAgents) {
    for (const agent of config.agents ?? []) {
      const label = `agent ${agent?.id ?? ""}`.trim();
      if (!agent?.id) errors.push("each agent requires an id");
      checkProvider(agent?.provider, label, errors);
      checkEnvRefs(agent?.env, label, errors);
    }
  }

  if (hasScenarioVariants) {
    for (const scenarioVariant of config.scenarioVariants ?? []) {
      const label = `scenario variant ${scenarioVariant?.id ?? ""}`.trim();
      if (!scenarioVariant?.id) errors.push("each scenario variant requires an id");
      if (scenarioVariant?.prompt) await checkMarkdownPath(root, scenarioVariant.prompt, `${label} prompt`, errors);
      if (scenarioVariant?.repoOverlay) await checkPath(root, scenarioVariant.repoOverlay, `${label} repoOverlay`, errors);
      if (scenarioVariant?.agentHomeOverlay) await checkPath(root, scenarioVariant.agentHomeOverlay, `${label} agentHomeOverlay`, errors);
    }
  }

  if (hasTasks) {
    for (const task of config.tasks ?? []) {
      const taskLabel = `task ${task?.id ?? ""}`.trim();
      if (!task?.id) errors.push("each task requires an id");
      await checkMarkdownPath(root, task?.prompt, `${taskLabel} prompt`, errors);
      await checkPath(root, task?.starter, `${taskLabel} starter`, errors);
      const deterministicWeight = task?.scoring?.deterministicWeight;
      const rubricWeight = task?.scoring?.rubricWeight;
      if (typeof deterministicWeight !== "number" || deterministicWeight < 0 || deterministicWeight > 1) {
        errors.push(`${taskLabel} scoring deterministicWeight must be between 0 and 1`);
      }
      if (typeof rubricWeight !== "number" || rubricWeight < 0 || rubricWeight > 1) {
        errors.push(`${taskLabel} scoring rubricWeight must be between 0 and 1`);
      }
      if (typeof deterministicWeight === "number" && typeof rubricWeight === "number" && Math.abs(deterministicWeight + rubricWeight - 1) > 0.000001) {
        errors.push(`${taskLabel} scoring deterministicWeight and rubricWeight must sum to 1`);
      }

      await checkPath(root, task?.acceptanceMaterial?.hiddenDir, `${taskLabel} hidden acceptance material directory`, errors);
      const checks = task?.acceptanceMaterial?.checks;
      const rubrics = task?.acceptanceMaterial?.rubrics;
      if (requireNonEmptyArray(checks, `${taskLabel} acceptance material checks`, errors)) {
        duplicateIds(checks, `${taskLabel} acceptance checks`, errors);
        for (const check of checks) {
          const checkLabel = `${taskLabel} check ${check?.id ?? ""}`.trim();
          if (!check?.id) errors.push(`${taskLabel} acceptance material checks require an id`);
          if (!check?.command) errors.push(`${checkLabel} command is required`);
          if (check?.cwd !== undefined && !isRelativeSafePath(check.cwd)) errors.push(`${checkLabel} cwd must be relative`);
          if (check?.timeoutMs !== undefined && (!Number.isInteger(check.timeoutMs) || check.timeoutMs <= 0)) {
            errors.push(`${checkLabel} timeoutMs must be a positive integer`);
          }
          if (check?.weight !== undefined && (typeof check.weight !== "number" || check.weight <= 0)) {
            errors.push(`${checkLabel} weight must be a positive number`);
          }
          if (check?.artifacts !== undefined) {
            const validArtifacts = Array.isArray(check.artifacts) && check.artifacts.every((artifact) => typeof artifact === "string" && isRelativeSafePath(artifact));
            if (!validArtifacts) errors.push(`${checkLabel} artifacts must contain non-empty relative glob strings`);
          }
          checkEnvRefs(check?.env, checkLabel, errors);
        }
      }
      if (requireNonEmptyArray(rubrics, `${taskLabel} rubric docs`, errors)) {
        duplicateIds(rubrics, `${taskLabel} rubric criteria`, errors);
        for (const rubric of rubrics) {
          const rubricLabel = `${taskLabel} rubric ${rubric?.id ?? ""}`.trim();
          if (!rubric?.id) errors.push(`${taskLabel} rubric docs require an id`);
          await checkMarkdownPath(root, rubric?.path, rubricLabel, errors);
          if (rubric?.weight !== undefined && (typeof rubric.weight !== "number" || rubric.weight <= 0)) {
            errors.push(`${rubricLabel} weight must be a positive number`);
          }
          if (rubric?.scale) {
            if (!Number.isFinite(rubric.scale.min) || !Number.isFinite(rubric.scale.max)) {
              errors.push(`${rubricLabel} scale min and max are required`);
            } else if ((rubric.scale.min as number) >= (rubric.scale.max as number)) {
              errors.push(`${rubricLabel} scale min must be less than max`);
            }
          }
        }
      }
    }
  }

  if (config.matrix?.baselineScenarioVariant && !scenarioVariantIds.has(config.matrix.baselineScenarioVariant)) {
    errors.push(`matrix.baselineScenarioVariant must reference a scenario variant id: ${config.matrix.baselineScenarioVariant}`);
  }
  const references = { agents: agentIds, tasks: taskIds, scenarioVariants: scenarioVariantIds, runIndexes: runIndexIds };
  for (const [index, selector] of (config.matrix?.include ?? []).entries()) {
    checkSelector(selector, `matrix.include[${index}]`, references, errors, { allowRunIndexOutsideMatrix: true });
  }
  for (const [index, selector] of (config.matrix?.exclude ?? []).entries()) {
    checkSelector(selector, `matrix.exclude[${index}]`, references, errors);
  }

  const configuredProviderModels = new Set([
    ...(config.agents ?? []).map((agent) => `${agent.provider ?? ""}\u0000${agent.model ?? ""}`),
    `${config.evaluatorAgent?.provider ?? ""}\u0000${config.evaluatorAgent?.model ?? ""}`,
  ]);
  for (const price of config.pricing ?? []) {
    const priceLabel = `pricing ${price?.id ?? ""}`.trim();
    if (!price?.id) errors.push("each pricing entry requires an id");
    if (!price?.provider) errors.push(`${priceLabel} provider is required`);
    if (!price?.model) errors.push(`${priceLabel} model is required`);
    checkPositiveNumber(price?.inputPerMillion, `${priceLabel} inputPerMillion`, errors);
    checkPositiveNumber(price?.outputPerMillion, `${priceLabel} outputPerMillion`, errors);
    if (price?.provider && price?.model && !configuredProviderModels.has(`${price.provider}\u0000${price.model}`)) {
      errors.push(`${priceLabel} must match a configured agent or evaluator agent provider/model`);
    }
  }

  if (config.report?.prompt) await checkMarkdownPath(root, config.report.prompt, "report.prompt", errors);

  if (errors.length > 0) {
    throw new Error(`invalid eval suite:\n${errors.map((error) => `- ${error}`).join("\n")}`);
  }

  console.log(
    `valid eval suite: ${(config.tasks ?? []).length} task(s), ${(config.agents ?? []).length} agent(s), ${(config.scenarioVariants ?? []).length} scenario variant(s)`
  );
}

async function readConfig(absoluteConfigPath: string): Promise<EvalSuiteConfig> {
  const rawConfig = await readFile(absoluteConfigPath, "utf8");
  try {
    return YAML.parse(rawConfig) as EvalSuiteConfig;
  } catch {
    throw new Error("invalid eval suite:\n- config YAML is malformed");
  }
}

async function runSuite(options: { config: string; failFast?: boolean; resultsDir?: string }) {
  await validateSuite(options.config);
  const absoluteConfigPath = path.resolve(process.cwd(), options.config);
  const suiteRoot = path.dirname(absoluteConfigPath);
  const config = await readConfig(absoluteConfigPath);
  const resultsRoot = path.resolve(suiteRoot, options.resultsDir ?? path.join(".eval-agent", "results", new Date().toISOString().replace(/[:.]/g, "-")));
  const results = await executeEvalTrials({ suiteRoot, resultsRoot, config, failFast: options.failFast });
  const failed = results.filter((result) => result.status === "failed").length;
  console.log(`executed ${results.length} eval trial(s); ${failed} failed; results: ${resultsRoot}`);
  if (failed > 0) process.exitCode = 1;
}

async function reportSuite(options: { resultsDir: string }) {
  const report = await generateReports(path.resolve(process.cwd(), options.resultsDir));
  console.log(`generated reports for ${report.summary.evalTrials} eval trial(s): ${path.resolve(process.cwd(), options.resultsDir)}`);
}

async function main() {
  const program = new Command();

  program
    .name("coding-agent-eval")
    .description(
      "Compare coding agents through eval trial execution, trial matrix expansion, scenario variant control, acceptance material scoring, evaluator agent rubrics, and eval score reports."
    )
    .version("0.1.0");

  program
    .command("init")
    .description("Create a minimal eval suite with prompts, starter files, scenario variant config, acceptance material, and evaluator agent rubric docs.")
    .action(async () => {
      await initSuite();
    });

  program
    .command("validate")
    .description("Validate config references before expanding the trial matrix or spending on an eval trial.")
    .option("-c, --config <path>", "YAML eval suite config", DEFAULT_CONFIG)
    .action(async (options: { config: string }) => {
      await validateSuite(options.config);
    });

  program
    .command("run")
    .description("Run eval trials from the trial matrix in Docker and preserve acceptance material boundaries.")
    .option("-c, --config <path>", "YAML eval suite config", DEFAULT_CONFIG)
    .option("--fail-fast", "Stop scheduling additional eval trials after the first failed eval trial")
    .option("--results-dir <path>", "Directory for immutable eval trial result artifacts")
    .action(async (options: { config: string; failFast?: boolean; resultsDir?: string }) => {
      await runSuite(options);
    });

  program
    .command("report")
    .description("Generate JSON and Markdown reports with evaluator agent rationale and eval score summaries.")
    .requiredOption("--results-dir <path>", "Directory containing immutable eval trial result artifacts")
    .action(async (options: { resultsDir: string }) => {
      await reportSuite(options);
    });

  try {
    await program.parseAsync(process.argv);
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
}

await main();
