#!/usr/bin/env node
import { Command } from "commander";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { executeEvalTrials } from "./eval-trial-execution.js";
import { loadEvalSuiteConfig } from "./eval-suite-config.js";
import { generateReports } from "./report.js";

const DEFAULT_CONFIG = "eval-suite.yaml";

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

async function validateSuite(configPath: string) {
  const suite = await loadEvalSuiteConfig(configPath);
  console.log(`valid eval suite: ${suite.summary.tasks} task(s), ${suite.summary.agents} agent(s), ${suite.summary.scenarioVariants} scenario variant(s)`);
}

async function runSuite(options: { config: string; failFast?: boolean; resultsDir?: string }) {
  const suite = await loadEvalSuiteConfig(options.config);
  const resultsRoot = path.resolve(suite.suiteRoot, options.resultsDir ?? path.join(".eval-agent", "results", new Date().toISOString().replace(/[:.]/g, "-")));
  const results = await executeEvalTrials({ suiteRoot: suite.suiteRoot, resultsRoot, config: suite.config, failFast: options.failFast });
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
