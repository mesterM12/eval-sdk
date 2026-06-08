import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { exec, execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { claudeCode, codex, copilot, cursor, opencode, pi, run } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { finalizeEvalTrialWorktree, prepareEvalTrialWorktree } from "./eval-trial-worktree.js";
import { generateReports } from "./report.js";
import { expandTrialMatrix } from "./trial-matrix.js";

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

type EvalSuiteExecutionConfig = {
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
      checks?: AcceptanceCheckConfig[];
      rubrics?: RubricConfig[];
    };
  }>;
  scenarioVariants?: Array<{ id?: string; prompt?: string; repoOverlay?: string; agentHomeOverlay?: string }>;
  matrix?: { runIndexes?: number[]; include?: MatrixSelector[]; exclude?: MatrixSelector[] };
  pricing?: Array<{ id?: string; provider?: string; model?: string; inputPerMillion?: number; cacheReadPerMillion?: number; cacheWritePerMillion?: number; outputPerMillion?: number }>;
};

type MatrixSelector = { agent?: string; task?: string; scenarioVariant?: string; runIndex?: number };

type AcceptanceCheckConfig = {
  id?: string;
  command?: string;
  cwd?: string;
  timeoutMs?: number;
  weight?: number;
  env?: Record<string, string>;
  artifacts?: string[];
};

type RubricConfig = { id?: string; path?: string; weight?: number; scale?: { min?: number; max?: number } };

type NormalizedUsage =
  | {
      provider?: string;
      model?: string;
      inputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
      outputTokens: number;
      unknown: Record<string, number>;
    }
  | { status: "unavailable"; reason: string; provider?: string; model?: string };

export type SandcastleExecutorInput = {
  evalTrialId: string;
  providerName: string;
  model?: string;
  sandboxProvider: "docker";
  branchStrategy: "head";
  prompt: string;
  worktreePath: string;
  agentHomePath: string;
  logPath: string;
  env: Record<string, string>;
};

export type SandcastleExecutorResult = {
  stdout?: string;
  logs?: string;
  commits?: Array<{ sha: string }>;
  diff?: string;
  branch?: string;
  providerMetadata?: Record<string, unknown>;
  iterations?: Array<Record<string, unknown>>;
};

export type AcceptanceCheckResult = {
  id: string;
  command: string;
  cwd: string;
  timeoutMs: number | null;
  weight: number;
  env: Record<string, string>;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
  artifacts: Array<{ path: string; contents: string }>;
};

export type EvaluatorAgentExecutorInput = {
  evalTrialId: string;
  providerName: string;
  model?: string;
  prompt: string;
  scoringContextPath: string;
  readOnly: true;
  deterministicResults: AcceptanceCheckResult[];
  rubrics: RubricConfig[];
  env: Record<string, string>;
};

export type EvaluatorAgentExecutorResult = { stdout: string; stderr?: string };

export type EvalTrialExecutionResult = {
  evalTrialId: string;
  status: "success" | "failed";
  error?: string;
  artifactRoot: string;
};

export type ExecuteEvalTrialsInput = {
  suiteRoot: string;
  resultsRoot: string;
  config: EvalSuiteExecutionConfig;
  failFast?: boolean;
  sandcastleExecutor?: (input: SandcastleExecutorInput) => Promise<SandcastleExecutorResult>;
  evaluatorAgentExecutor?: (input: EvaluatorAgentExecutorInput) => Promise<EvaluatorAgentExecutorResult>;
};

async function createResultsRunDirectory(resultsRoot: string) {
  await mkdir(path.dirname(resultsRoot), { recursive: true });
  try {
    await mkdir(resultsRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`results run directory already exists: ${resultsRoot}`);
    }
    throw error;
  }
}

export async function executeEvalTrials(input: ExecuteEvalTrialsInput): Promise<EvalTrialExecutionResult[]> {
  const suiteRoot = path.resolve(input.suiteRoot);
  const resultsRoot = path.resolve(input.resultsRoot);
  await createResultsRunDirectory(resultsRoot);
  const tempRoot = path.join(suiteRoot, ".eval-agent");
  const executor = input.sandcastleExecutor ?? runSandcastleBuiltIn;
  const evalTrials = expandTrialMatrix({
    agents: requiredItems(input.config.agents, "agents"),
    tasks: requiredItems(input.config.tasks, "tasks"),
    scenarioVariants: requiredItems(input.config.scenarioVariants, "scenarioVariants"),
    matrix: {
      runIndexes: input.config.matrix?.runIndexes ?? [],
      include: concreteSelectors(input.config.matrix?.include),
      exclude: concreteSelectors(input.config.matrix?.exclude),
    },
  });
  const results: EvalTrialExecutionResult[] = [];

  for (const evalTrial of evalTrials) {
    const agent = findById(input.config.agents, evalTrial.agentId, "agent");
    const task = findById(input.config.tasks, evalTrial.taskId, "task");
    const scenarioVariant = findById(input.config.scenarioVariants, evalTrial.scenarioVariantId, "scenario variant");
    const artifactRoot = path.join(resultsRoot, evalTrial.id);
    await mkdir(artifactRoot);

    const startedAt = new Date();
    let prepared: Awaited<ReturnType<typeof prepareEvalTrialWorktree>> | undefined;

    try {
      const prompt = await resolvePromptSnapshot(suiteRoot, task.prompt, scenarioVariant.prompt);
      await writeFile(path.join(artifactRoot, "prompt.md"), prompt, "utf8");
      prepared = await prepareEvalTrialWorktree({
        suiteRoot,
        tempRoot,
        evalTrialId: evalTrial.id,
        starterPath: requireString(task.starter, "task starter"),
        repoOverlayPath: scenarioVariant.repoOverlay,
        agentHomeOverlayPath: scenarioVariant.agentHomeOverlay,
        hiddenAcceptancePath: task.acceptanceMaterial?.hiddenDir,
      });
      await ensureGitBaseline(prepared.repoPath);

      const sandcastle = await executor({
        evalTrialId: evalTrial.id,
        providerName: requireString(agent.provider, "agent provider"),
        model: agent.model,
        sandboxProvider: "docker",
        branchStrategy: "head",
        prompt,
        worktreePath: prepared.repoPath,
        agentHomePath: prepared.agentHomePath,
        logPath: path.join(artifactRoot, "sandcastle.log"),
        env: resolveEnv(agent.env),
      });
      const finishedAt = new Date();
      await writeFile(path.join(artifactRoot, "sandcastle.log"), sandcastle.logs ?? sandcastle.stdout ?? "", "utf8");
      const scoring = await scoreEvalTrial({
        suiteRoot,
        scoringRoot: path.join(tempRoot, "scoring", evalTrial.id),
        evalTrialId: evalTrial.id,
        completedRepoPath: prepared.repoPath,
        agent,
        task,
        evaluatorAgent: input.config.evaluatorAgent,
        evaluatorAgentExecutor: input.evaluatorAgentExecutor,
      });
      const { secretValues, ...persistedScoring } = scoring;
      const scoringFailed = scoring.acceptanceChecks.some((check) => check.exitCode !== 0 || check.timedOut) || scoring.evaluatorAgent.status === "failed";
      const status = scoringFailed ? "failed" : "success";
      const worktree = await finalizeEvalTrialWorktree(prepared, { outcome: scoringFailed ? "failure" : "success" });
      const evalScore = aggregateEvalScore(task, scoring.acceptanceChecks, scoring.evaluatorAgent);
      const usage = { agent: normalizeUsage(agent.provider, agent.model, sandcastle.iterations) };
      const cost = { agent: estimateCost(usage.agent, input.config.pricing), evaluatorAgent: { status: "unavailable", reason: "usage unavailable" } };
      const timingsValue = timings(startedAt, finishedAt);
      const resultJson = redactSecrets({
        evalTrialId: evalTrial.id,
        status,
        timings: timingsValue,
        sandcastle,
        scoring: persistedScoring,
        evalScore,
        usage,
        cost,
        worktree,
      }, secretValues);
      await writeTrialArtifacts(artifactRoot, {
        config: input.config,
        diff: sandcastle.diff ?? "",
        commits: sandcastle.commits ?? [],
        timings: timingsValue,
        usage,
        cost,
        acceptanceOutput: persistedScoring.acceptanceChecks,
        evaluatorRationale: persistedScoring.evaluatorAgent,
        result: resultJson,
      });
      await writeFile(
        path.join(artifactRoot, "result.json"),
        JSON.stringify(resultJson, null, 2),
        "utf8"
      );
      await writeArtifactManifest(artifactRoot);
      results.push(scoringFailed ? { evalTrialId: evalTrial.id, status, artifactRoot, error: "post-trial scoring failed" } : { evalTrialId: evalTrial.id, status, artifactRoot });
      if (scoringFailed && input.failFast) break;
    } catch (error) {
      const finishedAt = new Date();
      const worktree = prepared ? await finalizeEvalTrialWorktree(prepared, { outcome: "failure" }) : { preserved: false, worktreePath: null, agentHomePath: null };
      const message = error instanceof Error ? error.message : String(error);
      await writeFile(
        path.join(artifactRoot, "result.json"),
        JSON.stringify(
          {
            evalTrialId: evalTrial.id,
            status: "failed",
            error: message,
            timings: timings(startedAt, finishedAt),
            worktree,
          },
          null,
          2
        ),
        "utf8"
      );
      await writeArtifactManifest(artifactRoot);
      results.push({ evalTrialId: evalTrial.id, status: "failed", error: message, artifactRoot });
      if (input.failFast) break;
    }
  }

  await generateReports(resultsRoot);
  return results;
}

async function writeTrialArtifacts(
  artifactRoot: string,
  artifacts: {
    config: unknown;
    diff: string;
    commits: unknown[];
    timings: unknown;
    usage: unknown;
    cost: unknown;
    acceptanceOutput: unknown;
    evaluatorRationale: unknown;
    result: unknown;
  }
) {
  await writeJson(path.join(artifactRoot, "config.json"), artifacts.config);
  await writeFile(path.join(artifactRoot, "diff.patch"), artifacts.diff, "utf8");
  await writeJson(path.join(artifactRoot, "commits.json"), artifacts.commits);
  await writeJson(path.join(artifactRoot, "timings.json"), artifacts.timings);
  await writeJson(path.join(artifactRoot, "usage.json"), artifacts.usage);
  await writeJson(path.join(artifactRoot, "cost.json"), artifacts.cost);
  await writeJson(path.join(artifactRoot, "acceptance-output.json"), artifacts.acceptanceOutput);
  await writeJson(path.join(artifactRoot, "evaluator-rationale.json"), artifacts.evaluatorRationale);
  await writeJson(path.join(artifactRoot, "result.json"), artifacts.result);
}

async function writeArtifactManifest(artifactRoot: string) {
  const files = (await readdir(artifactRoot, { withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => name !== "artifact-manifest.json");
  await writeJson(path.join(artifactRoot, "artifact-manifest.json"), { files: [...files, "artifact-manifest.json"].sort() });
}

async function writeJson(filePath: string, value: unknown) {
  await writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
}

function aggregateEvalScore(
  task: NonNullable<EvalSuiteExecutionConfig["tasks"]>[number],
  acceptanceChecks: AcceptanceCheckResult[],
  evaluatorAgent: ScoringResult["evaluatorAgent"]
) {
  const deterministicWeight = task.scoring?.deterministicWeight ?? 1;
  const rubricWeight = task.scoring?.rubricWeight ?? 0;
  const deterministicScore = weightedAverage(
    acceptanceChecks.map((check) => ({ weight: check.weight, value: check.exitCode === 0 && !check.timedOut ? 1 : 0 })),
    1
  );
  const checksFailed = acceptanceChecks.some((check) => check.exitCode !== 0 || check.timedOut);
  const rubricScore = evaluatorAgent.status === "success" ? rubricAverage(task.acceptanceMaterial?.rubrics ?? [], evaluatorAgent.result.criteria) : 0;
  const deterministicContribution = roundScore(deterministicWeight * deterministicScore);
  const rubricCounted = !checksFailed;
  const rubricContribution = rubricCounted ? roundScore(rubricWeight * rubricScore) : 0;
  return {
    value: roundScore(deterministicContribution + rubricContribution),
    deterministic: { value: roundScore(deterministicScore), weight: deterministicWeight, contribution: deterministicContribution, checksFailed },
    rubric: { value: roundScore(rubricScore), weight: rubricWeight, contribution: rubricContribution, counted: rubricCounted },
    formula: "deterministicWeight * deterministicScore + rubricWeight * rubricScore; rubric contribution is not counted when deterministic checks fail",
  };
}

function rubricAverage(rubrics: RubricConfig[], criteria: EvaluatorAgentJson["criteria"]) {
  const criteriaById = new Map(criteria.map((criterion) => [criterion.id, criterion]));
  return weightedAverage(
    rubrics.map((rubric) => {
      const criterion = criteriaById.get(requireString(rubric.id, "rubric id"));
      return { weight: rubric.weight ?? 1, value: criterion ? normalizeRubricScore(criterion.score, rubric.scale) : 0 };
    }),
    0
  );
}

function normalizeRubricScore(score: number, scale: RubricConfig["scale"]) {
  const min = scale?.min ?? 0;
  const max = scale?.max ?? 1;
  if (max === min) return 0;
  return Math.max(0, Math.min(1, (score - min) / (max - min)));
}

function weightedAverage(items: Array<{ weight: number; value: number }>, emptyValue: number) {
  if (items.length === 0) return emptyValue;
  const totalWeight = items.reduce((total, item) => total + item.weight, 0);
  if (totalWeight === 0) return emptyValue;
  return items.reduce((total, item) => total + item.weight * item.value, 0) / totalWeight;
}

function normalizeUsage(provider?: string, model?: string, iterations?: Array<Record<string, unknown>>): NormalizedUsage {
  const usageObjects = (iterations ?? []).map((iteration) => iteration.usage).filter((usage): usage is Record<string, unknown> => Boolean(usage) && typeof usage === "object" && !Array.isArray(usage));
  if (usageObjects.length === 0) return { status: "unavailable", reason: "provider usage unavailable", provider, model };

  const normalized = { provider, model, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, unknown: {} as Record<string, number> };
  const known = new Set(["inputTokens", "cacheReadInputTokens", "cacheCreationInputTokens", "cacheWriteInputTokens", "outputTokens"]);
  for (const usage of usageObjects) {
    normalized.inputTokens += numericUsage(usage.inputTokens);
    normalized.cacheReadTokens += numericUsage(usage.cacheReadInputTokens);
    normalized.cacheWriteTokens += numericUsage(usage.cacheCreationInputTokens) + numericUsage(usage.cacheWriteInputTokens);
    normalized.outputTokens += numericUsage(usage.outputTokens);
    for (const [key, value] of Object.entries(usage)) {
      if (known.has(key)) continue;
      if (typeof value === "number" && Number.isFinite(value)) normalized.unknown[key] = (normalized.unknown[key] ?? 0) + value;
    }
  }
  return normalized;
}

function numericUsage(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function estimateCost(usage: NormalizedUsage, pricing: EvalSuiteExecutionConfig["pricing"] | undefined) {
  if ("status" in usage) return { status: "unavailable", reason: "usage unavailable" };
  const price = pricing?.find((entry) => entry.provider === usage.provider && entry.model === usage.model);
  if (!price) return { status: "unavailable", reason: "matching pricing not configured", provider: usage.provider, model: usage.model };
  const estimatedUsd =
    (usage.inputTokens * (price.inputPerMillion ?? 0) +
      usage.cacheReadTokens * (price.cacheReadPerMillion ?? 0) +
      usage.cacheWriteTokens * (price.cacheWritePerMillion ?? 0) +
      usage.outputTokens * (price.outputPerMillion ?? 0)) /
    1_000_000;
  return {
    matchedPricingId: price.id,
    estimatedUsd: roundCost(estimatedUsd),
    inputs: {
      inputTokens: usage.inputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      outputTokens: usage.outputTokens,
    },
  };
}

function roundScore(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function roundCost(value: number) {
  return Math.round(value * 1_000_000_000_000) / 1_000_000_000_000;
}

type ScoringResult = {
  acceptanceChecks: AcceptanceCheckResult[];
  evaluatorAgent:
    | { providerName: string; model?: string; status: "success"; result: EvaluatorAgentJson; stdout: string; stderr?: string }
    | { providerName: string; model?: string; status: "failed"; error: string; stdout?: string; stderr?: string }
    | { status: "skipped" };
  secretValues: string[];
};

type EvaluatorAgentJson = { criteria: Array<{ id: string; score: number; rationale: string }>; summary: string };

async function scoreEvalTrial(input: {
  suiteRoot: string;
  scoringRoot: string;
  evalTrialId: string;
  completedRepoPath: string;
  agent: NonNullable<EvalSuiteExecutionConfig["agents"]>[number];
  task: NonNullable<EvalSuiteExecutionConfig["tasks"]>[number];
  evaluatorAgent?: EvalSuiteExecutionConfig["evaluatorAgent"];
  evaluatorAgentExecutor?: (input: EvaluatorAgentExecutorInput) => Promise<EvaluatorAgentExecutorResult>;
}): Promise<ScoringResult> {
  await rm(input.scoringRoot, { recursive: true, force: true });
  const scoringRepoPath = path.join(input.scoringRoot, "repo");
  await mkdir(path.dirname(scoringRepoPath), { recursive: true });
  await cp(input.completedRepoPath, scoringRepoPath, { recursive: true });
  const hiddenDir = input.task.acceptanceMaterial?.hiddenDir;
  if (hiddenDir) {
    await cp(resolveSuitePath(input.suiteRoot, hiddenDir), path.join(scoringRepoPath, hiddenDir), { recursive: true });
  }

  const secretValues = collectSecretValues(input.task.acceptanceMaterial?.checks ?? [], input.evaluatorAgent, input.agent);
  const acceptanceChecks: AcceptanceCheckResult[] = [];
  for (const check of input.task.acceptanceMaterial?.checks ?? []) {
    acceptanceChecks.push(await runAcceptanceCheck(scoringRepoPath, hiddenDir ?? "", check, secretValues));
  }

  const evaluatorAgent = await runEvaluatorAgent({
    suiteRoot: input.suiteRoot,
    evalTrialId: input.evalTrialId,
    scoringRepoPath,
    deterministicResults: acceptanceChecks,
    rubrics: input.task.acceptanceMaterial?.rubrics ?? [],
    evaluatorAgent: input.evaluatorAgent,
    evaluatorAgentExecutor: input.evaluatorAgentExecutor,
    secretValues,
  });
  await rm(input.scoringRoot, { recursive: true, force: true });
  return { acceptanceChecks, evaluatorAgent, secretValues };
}

async function runAcceptanceCheck(scoringRepoPath: string, hiddenDir: string, check: AcceptanceCheckConfig, secretValues: string[]): Promise<AcceptanceCheckResult> {
  const command = requireString(check.command, "acceptance check command");
  const cwd = check.cwd ?? ".";
  const timeoutMs = check.timeoutMs ?? 30000;
  const startedAt = Date.now();
  let stdout = "";
  let stderr = "";
  let exitCode: number | null = 0;
  let timedOut = false;
  try {
    const result = await execAsync(command, {
      cwd: resolveInside(scoringRepoPath, cwd, "acceptance check cwd"),
      timeout: timeoutMs,
      env: { ...process.env, ...resolveEnv(check.env) },
      killSignal: "SIGKILL",
    });
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (error) {
    const execError = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number | string | null; killed?: boolean; signal?: string };
    stdout = execError.stdout ?? "";
    stderr = execError.stderr ?? "";
    timedOut = execError.killed === true || execError.signal === "SIGTERM" || execError.signal === "SIGKILL";
    exitCode = timedOut ? null : typeof execError.code === "number" ? execError.code : 1;
  }
  return {
    id: requireString(check.id, "acceptance check id"),
    command,
    cwd,
    timeoutMs,
    weight: check.weight ?? 1,
    env: envNames(check.env),
    stdout: redactText(stdout, secretValues),
    stderr: redactText(stderr, secretValues),
    exitCode,
    durationMs: Date.now() - startedAt,
    timedOut,
    artifacts: await collectArtifacts(scoringRepoPath, hiddenDir, check.artifacts ?? [], secretValues),
  };
}

async function runEvaluatorAgent(input: {
  suiteRoot: string;
  evalTrialId: string;
  scoringRepoPath: string;
  deterministicResults: AcceptanceCheckResult[];
  rubrics: RubricConfig[];
  evaluatorAgent?: EvalSuiteExecutionConfig["evaluatorAgent"];
  evaluatorAgentExecutor?: (input: EvaluatorAgentExecutorInput) => Promise<EvaluatorAgentExecutorResult>;
  secretValues: string[];
}): Promise<ScoringResult["evaluatorAgent"]> {
  if (!input.evaluatorAgent?.provider) return { status: "skipped" };
  const providerName = requireString(input.evaluatorAgent.provider, "evaluator agent provider");
  const model = input.evaluatorAgent?.model;
  const prompt = input.evaluatorAgent?.prompt ? await readFile(resolveSuitePath(input.suiteRoot, input.evaluatorAgent.prompt), "utf8") : "";
  const executor = input.evaluatorAgentExecutor ?? defaultEvaluatorAgentExecutor;
  try {
    const beforeContext = await snapshotScoringContext(input.scoringRepoPath);
    const output = await executor({
      evalTrialId: input.evalTrialId,
      providerName,
      model,
      prompt: await buildEvaluatorAgentPrompt(input.suiteRoot, prompt, input.deterministicResults, input.rubrics),
      scoringContextPath: input.scoringRepoPath,
      readOnly: true,
      deterministicResults: input.deterministicResults,
      rubrics: input.rubrics,
      env: resolveEnv(input.evaluatorAgent?.env),
    });
    await assertScoringContextUnchanged(input.scoringRepoPath, beforeContext);
    const parsed = parseEvaluatorAgentJson(output.stdout);
    return {
      providerName,
      model,
      status: "success",
      result: parsed,
      stdout: redactText(output.stdout, input.secretValues),
      stderr: output.stderr === undefined ? undefined : redactText(output.stderr, input.secretValues),
    };
  } catch (error) {
    return {
      providerName,
      model,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function snapshotScoringContext(scoringRepoPath: string) {
  const snapshot = new Map<string, string>();
  for (const file of await listFiles(scoringRepoPath)) {
    const normalizedFile = normalizeRelative(file);
    snapshot.set(normalizedFile, await readFile(path.join(scoringRepoPath, normalizedFile), "utf8"));
  }
  return snapshot;
}

async function assertScoringContextUnchanged(scoringRepoPath: string, before: Map<string, string>) {
  const after = await snapshotScoringContext(scoringRepoPath);
  const beforeKeys = [...before.keys()].sort();
  const afterKeys = [...after.keys()].sort();
  if (beforeKeys.join("\0") !== afterKeys.join("\0")) {
    throw new Error("evaluator agent modified read-only scoring context");
  }
  for (const key of beforeKeys) {
    if (before.get(key) !== after.get(key)) {
      throw new Error("evaluator agent modified read-only scoring context");
    }
  }
}

async function defaultEvaluatorAgentExecutor(input: EvaluatorAgentExecutorInput): Promise<EvaluatorAgentExecutorResult> {
  const providerFactory = sandcastleRuntime.providers[input.providerName];
  if (!providerFactory) throw new Error(`evaluator agent provider must be a Sandcastle built-in provider: ${input.providerName}`);
  const logPath = path.join(path.dirname(input.scoringContextPath), `${input.evalTrialId}-evaluator-sandcastle.log`);
  const result = await sandcastleRuntime.run({
    agent: providerFactory(input.model, { env: input.env }),
    sandbox: sandcastleRuntime.docker({}),
    cwd: input.scoringContextPath,
    prompt: input.prompt,
    logging: { type: "file", path: logPath },
    branchStrategy: { type: "head" },
  });
  return {
    stdout: typeof result.stdout === "string" ? result.stdout : "",
  };
}

async function buildEvaluatorAgentPrompt(suiteRoot: string, basePrompt: string, deterministicResults: AcceptanceCheckResult[], rubrics: RubricConfig[]) {
  const rubricDocs = await Promise.all(
    rubrics.map(async (rubric) => ({
      id: requireString(rubric.id, "rubric id"),
      weight: rubric.weight ?? 1,
      scale: rubric.scale ?? { min: 1, max: 5 },
      contents: await readFile(resolveSuitePath(suiteRoot, requireString(rubric.path, "rubric path")), "utf8"),
    }))
  );
  return `${basePrompt.trim()}

You are the evaluator agent for this eval trial. Inspect the completed work in the current working directory, use the deterministic acceptance results and rubric docs below, and return only JSON with this exact shape:

{"criteria":[{"id":"rubric-id","score":1,"rationale":"short rationale"}],"summary":"short summary"}

Your entire final answer must be the JSON object. Do not include prose before or after it. Do not include Markdown fences. If you output anything other than this JSON object, the eval trial fails.

Do not edit files.

Deterministic acceptance results:
${JSON.stringify(deterministicResults, null, 2)}

Rubric docs:
${JSON.stringify(rubricDocs, null, 2)}
`;
}

function parseEvaluatorAgentJson(stdout: string): EvaluatorAgentJson {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonObject(stdout));
  } catch {
    throw new Error("evaluator agent output must be valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("evaluator agent output must be a JSON object");
  const object = parsed as Record<string, unknown>;
  const keys = Object.keys(object).sort();
  if (keys.join("\0") !== ["criteria", "summary"].join("\0")) throw new Error("evaluator agent JSON must contain only criteria and summary");
  if (!Array.isArray(object.criteria) || typeof object.summary !== "string") throw new Error("evaluator agent JSON has an invalid schema");
  const criteria = object.criteria.map((criterion) => {
    if (!criterion || typeof criterion !== "object" || Array.isArray(criterion)) throw new Error("evaluator agent criterion must be an object");
    const item = criterion as Record<string, unknown>;
    const itemKeys = Object.keys(item).sort();
    if (itemKeys.join("\0") !== ["id", "rationale", "score"].join("\0")) throw new Error("evaluator agent criterion has an invalid schema");
    if (typeof item.id !== "string" || typeof item.score !== "number" || typeof item.rationale !== "string") {
      throw new Error("evaluator agent criterion has an invalid schema");
    }
    return { id: item.id, score: item.score, rationale: item.rationale };
  });
  return { criteria, summary: object.summary };
}

function extractJsonObject(stdout: string) {
  const trimmed = stdout.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
  const start = trimmed.indexOf("{");
  if (start === -1) return trimmed;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < trimmed.length; index += 1) {
    const char = trimmed[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    if (depth === 0) return trimmed.slice(start, index + 1);
  }
  return trimmed;
}

async function collectArtifacts(scoringRepoPath: string, hiddenDir: string, globs: string[], secretValues: string[]) {
  const files = await listFiles(scoringRepoPath);
  const normalizedHiddenDir = normalizeRelative(hiddenDir);
  const artifacts: Array<{ path: string; contents: string }> = [];
  for (const glob of globs) {
    const matcher = globMatcher(normalizeRelative(glob));
    for (const file of files) {
      const normalizedFile = normalizeRelative(file);
      if (normalizedFile === normalizedHiddenDir || normalizedFile.startsWith(`${normalizedHiddenDir}/`)) continue;
      if (!matcher(normalizedFile)) continue;
      artifacts.push({ path: normalizedFile, contents: redactText(await readFile(path.join(scoringRepoPath, normalizedFile), "utf8"), secretValues) });
    }
  }
  return artifacts.sort((a, b) => a.path.localeCompare(b.path));
}

async function listFiles(root: string, relativeDir = ""): Promise<string[]> {
  const entries = await readdir(path.join(root, relativeDir), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === ".git") continue;
    const relativePath = path.join(relativeDir, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(root, relativePath)));
    else if (entry.isFile()) files.push(relativePath);
  }
  return files;
}

function globMatcher(glob: string) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "[\s\S]*").replace(/\*/g, "[^/]*");
  const regex = new RegExp(`^${escaped}$`);
  return (value: string) => regex.test(value);
}

function collectSecretValues(checks: AcceptanceCheckConfig[], evaluatorAgent?: EvalSuiteExecutionConfig["evaluatorAgent"], agent?: NonNullable<EvalSuiteExecutionConfig["agents"]>[number]) {
  const names = new Set<string>();
  addEnvRefNames(agent?.env, names);
  for (const check of checks) addEnvRefNames(check.env, names);
  addEnvRefNames(evaluatorAgent?.env, names);
  return [...names].map((name) => process.env[name]).filter((value): value is string => typeof value === "string" && value.length > 0);
}

function addEnvRefNames(env: Record<string, string> | undefined, names: Set<string>) {
  for (const value of Object.values(env ?? {})) {
    if (value.startsWith("env:")) names.add(value.slice("env:".length));
  }
}

function resolveEnv(env: Record<string, string> | undefined) {
  return Object.fromEntries(Object.entries(env ?? {}).map(([name, value]) => [name, value.startsWith("env:") ? process.env[value.slice("env:".length)] ?? "" : value]));
}

function envNames(env: Record<string, string> | undefined) {
  return Object.fromEntries(Object.keys(env ?? {}).map((name) => [name, "[env]"]));
}

function redactSecrets<T>(value: T, secretValues: string[]): T {
  return JSON.parse(redactText(JSON.stringify(value), secretValues)) as T;
}

function redactText(text: string, secretValues: string[]) {
  return secretValues.reduce((redacted, secret) => redacted.split(secret).join("[REDACTED]"), text);
}

function resolveInside(root: string, relativePath: string, label: string) {
  const resolved = path.resolve(root, relativePath);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`${label} must stay inside the eval trial scoring sandbox: ${relativePath}`);
  return resolved;
}

function normalizeRelative(relativePath: string) {
  return relativePath.split(path.sep).join("/").replace(/^\.\//, "");
}

type SandcastleRuntime = {
  run: (options: unknown) => Promise<Record<string, unknown>>;
  docker: (options: unknown) => unknown;
  providers: Record<string, (model?: string, options?: { env?: Record<string, string> }) => unknown>;
};

const sandcastleRuntime: SandcastleRuntime = {
  run: run as unknown as SandcastleRuntime["run"],
  docker: docker as SandcastleRuntime["docker"],
  providers: {
    "claude-code": claudeCode as (model?: string, options?: { env?: Record<string, string> }) => unknown,
    codex: codex as (model?: string, options?: { env?: Record<string, string> }) => unknown,
    copilot: copilot as (model?: string, options?: { env?: Record<string, string> }) => unknown,
    cursor: cursor as (model?: string, options?: { env?: Record<string, string> }) => unknown,
    opencode: opencode as (model?: string, options?: { env?: Record<string, string> }) => unknown,
    pi: pi as (model?: string, options?: { env?: Record<string, string> }) => unknown,
  },
};

export function createSandcastleBuiltInExecutor(runtime: SandcastleRuntime = sandcastleRuntime): (input: SandcastleExecutorInput) => Promise<SandcastleExecutorResult> {
  return async (input) => {
    const providerFactory = runtime.providers[input.providerName];
    if (!providerFactory) {
      throw new Error(`agent provider must be a Sandcastle built-in provider: ${input.providerName}`);
    }
    const baseSha = await gitStdout(input.worktreePath, ["rev-parse", "HEAD"]);
    const runResult = await runtime.run({
      agent: providerFactory(input.model, { env: input.env }),
      sandbox: runtime.docker({ mounts: [{ hostPath: input.agentHomePath, sandboxPath: "/home/agent" }] }),
      cwd: input.worktreePath,
      prompt: input.prompt,
      logging: { type: "file", path: input.logPath },
      branchStrategy: { type: "head" },
    });
    let logs: string | undefined;
    try {
      logs = await readFile(typeof runResult.logFilePath === "string" ? runResult.logFilePath : input.logPath, "utf8");
    } catch {
      logs = undefined;
    }
    const diff = await collectGitDiff(input.worktreePath, baseSha.trim());
    return {
      stdout: typeof runResult.stdout === "string" ? runResult.stdout : undefined,
      logs,
      commits: Array.isArray(runResult.commits) ? runResult.commits as Array<{ sha: string }> : undefined,
      diff,
      branch: typeof runResult.branch === "string" ? runResult.branch : undefined,
      providerMetadata: { provider: input.providerName, model: input.model, logFilePath: runResult.logFilePath },
      iterations: Array.isArray(runResult.iterations) ? runResult.iterations as Array<Record<string, unknown>> : undefined,
    };
  };
}

async function ensureGitBaseline(repoPath: string) {
  if (!(await gitSucceeds(repoPath, ["rev-parse", "--is-inside-work-tree"]))) {
    await git(repoPath, ["init"]);
  }
  await git(repoPath, ["config", "user.email", "eval-trial@example.invalid"]);
  await git(repoPath, ["config", "user.name", "Eval Trial"]);
  if (!(await gitSucceeds(repoPath, ["rev-parse", "--verify", "HEAD"]))) {
    await git(repoPath, ["add", "."]);
    await git(repoPath, ["commit", "-m", "Initial eval trial baseline"]);
  }
}

async function collectGitDiff(repoPath: string, baseSha: string) {
  const committed = await gitStdout(repoPath, ["diff", `${baseSha}..HEAD`]);
  const uncommitted = await gitStdout(repoPath, ["diff"]);
  return [committed, uncommitted].filter((part) => part.length > 0).join("\n");
}

async function git(repoPath: string, args: string[]) {
  await execFileAsync("git", args, { cwd: repoPath });
}

async function gitStdout(repoPath: string, args: string[]) {
  const result = await execFileAsync("git", args, { cwd: repoPath });
  return result.stdout;
}

async function gitSucceeds(repoPath: string, args: string[]) {
  try {
    await git(repoPath, args);
    return true;
  } catch {
    return false;
  }
}

const runSandcastleBuiltIn = createSandcastleBuiltInExecutor();

async function resolvePromptSnapshot(suiteRoot: string, taskPromptPath: string | undefined, scenarioPromptPath: string | undefined) {
  const taskPrompt = await readFile(resolveSuitePath(suiteRoot, requireString(taskPromptPath, "task prompt")), "utf8");
  if (!scenarioPromptPath) return taskPrompt;
  const scenarioPrompt = await readFile(resolveSuitePath(suiteRoot, scenarioPromptPath), "utf8");
  return `${taskPrompt}\n${scenarioPrompt}`;
}

function requiredItems<T extends { id?: string }>(items: T[] | undefined, label: string): Array<{ id: string }> {
  if (!items) throw new Error(`${label} are required`);
  return items.map((item) => ({ id: requireString(item.id, `${label} id`) }));
}

function concreteSelectors(selectors: MatrixSelector[] | undefined) {
  return selectors?.map((selector) => ({
    agent: requireString(selector.agent, "matrix selector agent"),
    task: requireString(selector.task, "matrix selector task"),
    scenarioVariant: requireString(selector.scenarioVariant, "matrix selector scenario variant"),
    runIndex: requireNumber(selector.runIndex, "matrix selector run index"),
  }));
}

function requireNumber(value: number | undefined, label: string) {
  if (typeof value !== "number") throw new Error(`${label} is required`);
  return value;
}

function findById<T extends { id?: string }>(items: T[] | undefined, id: string, label: string): T {
  const item = items?.find((candidate) => candidate.id === id);
  if (!item) throw new Error(`${label} not found: ${id}`);
  return item;
}

function requireString(value: string | undefined, label: string) {
  if (!value) throw new Error(`${label} is required`);
  return value;
}

function resolveSuitePath(suiteRoot: string, relativePath: string) {
  const resolved = path.resolve(suiteRoot, relativePath);
  const relative = path.relative(suiteRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`eval trial path must stay inside the suite root: ${relativePath}`);
  }
  return resolved;
}

function timings(startedAt: Date, finishedAt: Date) {
  return {
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
  };
}
