import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import type { EvalSandboxProvider } from "./coding-agent-adapter.js";

export type MatrixSelector = { agent: string; task: string; scenarioVariant: string; runIndex: number };

export type EvalSuiteConfig = {
  sandbox: { provider: EvalSandboxProvider };
  agents: Array<{ id: string; provider: string; model?: string; env?: Record<string, string> }>;
  evaluatorAgent: { id: string; provider: string; model?: string; prompt?: string; env?: Record<string, string> };
  tasks: Array<{
    id: string;
    prompt: string;
    starter: string;
    scoring: { deterministicWeight: number; rubricWeight: number };
    acceptanceMaterial: {
      hiddenDir: string;
      checks: Array<{
        id: string;
        command: string;
        cwd: string;
        timeoutMs: number;
        weight: number;
        env: Record<string, string>;
        artifacts: string[];
      }>;
      rubrics: Array<{ id: string; path: string; weight: number; scale: { min: number; max: number } }>;
    };
  }>;
  scenarioVariants: Array<{ id: string; description?: string; prompt?: string; repoOverlay?: string; agentHomeOverlay?: string }>;
  matrix: { runIndexes: number[]; baselineScenarioVariant?: string; include: MatrixSelector[]; exclude: MatrixSelector[] };
  pricing: Array<{ id: string; provider: string; model: string; inputPerMillion: number; cacheReadPerMillion?: number; cacheWritePerMillion?: number; outputPerMillion: number }>;
  report?: { prompt?: string };
};

export type LoadedEvalSuiteConfig = {
  configPath: string;
  suiteRoot: string;
  config: EvalSuiteConfig;
  summary: { tasks: number; agents: number; scenarioVariants: number };
};

type RawEvalSuiteConfig = {
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
      checks?: RawAcceptanceCheckConfig[];
      rubrics?: RawRubricConfig[];
    };
  }>;
  scenarioVariants?: Array<{ id?: string; description?: string; prompt?: string; repoOverlay?: string; agentHomeOverlay?: string }>;
  matrix?: {
    runIndexes?: number[];
    baselineScenarioVariant?: string;
    include?: RawMatrixSelector[];
    exclude?: RawMatrixSelector[];
  };
  pricing?: Array<{ id?: string; provider?: string; model?: string; inputPerMillion?: number; cacheReadPerMillion?: number; cacheWritePerMillion?: number; outputPerMillion?: number }>;
  report?: { prompt?: string };
};

type RawMatrixSelector = { agent?: string; task?: string; scenarioVariant?: string; runIndex?: number };
type RawAcceptanceCheckConfig = { id?: string; command?: string; cwd?: string; timeoutMs?: number; weight?: number; env?: Record<string, string>; artifacts?: string[] };
type RawRubricConfig = { id?: string; path?: string; weight?: number; scale?: { min?: number; max?: number } };

const SANDCASTLE_BUILT_IN_PROVIDERS = new Set(["claude-code", "pi", "codex", "opencode", "cursor", "copilot"]);
const SANDBOX_PROVIDERS = new Set(["docker", "local"]);

export async function loadEvalSuiteConfig(configPath: string, options: { cwd?: string } = {}): Promise<LoadedEvalSuiteConfig> {
  const absoluteConfigPath = path.resolve(options.cwd ?? process.cwd(), configPath);
  const suiteRoot = path.dirname(absoluteConfigPath);
  const rawConfig = await readConfig(absoluteConfigPath);
  const errors = await validateRawEvalSuiteConfig(rawConfig, suiteRoot);

  if (errors.length > 0) {
    throw new Error(`invalid eval suite:\n${errors.map((error) => `- ${error}`).join("\n")}`);
  }

  const config = normalizeEvalSuiteConfig(rawConfig);
  return {
    configPath: absoluteConfigPath,
    suiteRoot,
    config,
    summary: { tasks: config.tasks.length, agents: config.agents.length, scenarioVariants: config.scenarioVariants.length },
  };
}

async function readConfig(absoluteConfigPath: string): Promise<RawEvalSuiteConfig> {
  const rawConfig = await readFile(absoluteConfigPath, "utf8");
  try {
    return YAML.parse(rawConfig) as RawEvalSuiteConfig;
  } catch {
    throw new Error("invalid eval suite:\n- config YAML is malformed");
  }
}

async function validateRawEvalSuiteConfig(config: RawEvalSuiteConfig, suiteRoot: string) {
  const errors: string[] = [];

  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return ["config must be a YAML object"];
  }

  if (!config.sandbox?.provider || !SANDBOX_PROVIDERS.has(config.sandbox.provider)) {
    errors.push("sandbox.provider must be docker or local");
  }

  const hasAgents = requireNonEmptyArray(config.agents, "agents", errors);
  const hasTasks = requireNonEmptyArray(config.tasks, "tasks", errors);
  const hasScenarioVariants = requireNonEmptyArray(config.scenarioVariants, "scenarioVariants", errors);
  if (!config.evaluatorAgent?.id) errors.push("evaluatorAgent id is required");
  checkProvider(config.evaluatorAgent?.provider, "evaluatorAgent", errors);
  if (config.evaluatorAgent?.prompt) await checkMarkdownPath(suiteRoot, config.evaluatorAgent.prompt, "evaluatorAgent prompt", errors);
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
      if (scenarioVariant?.prompt) await checkMarkdownPath(suiteRoot, scenarioVariant.prompt, `${label} prompt`, errors);
      if (scenarioVariant?.repoOverlay) await checkPath(suiteRoot, scenarioVariant.repoOverlay, `${label} repoOverlay`, errors);
      if (scenarioVariant?.agentHomeOverlay) await checkPath(suiteRoot, scenarioVariant.agentHomeOverlay, `${label} agentHomeOverlay`, errors);
    }
  }

  if (hasTasks) {
    for (const task of config.tasks ?? []) {
      const taskLabel = `task ${task?.id ?? ""}`.trim();
      if (!task?.id) errors.push("each task requires an id");
      await checkMarkdownPath(suiteRoot, task?.prompt, `${taskLabel} prompt`, errors);
      await checkPath(suiteRoot, task?.starter, `${taskLabel} starter`, errors);
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

      await checkPath(suiteRoot, task?.acceptanceMaterial?.hiddenDir, `${taskLabel} hidden acceptance material directory`, errors);
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
          await checkMarkdownPath(suiteRoot, rubric?.path, rubricLabel, errors);
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
    if (price?.cacheReadPerMillion !== undefined) checkPositiveNumber(price.cacheReadPerMillion, `${priceLabel} cacheReadPerMillion`, errors);
    if (price?.cacheWritePerMillion !== undefined) checkPositiveNumber(price.cacheWritePerMillion, `${priceLabel} cacheWritePerMillion`, errors);
    if (price?.provider && price?.model && !configuredProviderModels.has(`${price.provider}\u0000${price.model}`)) {
      errors.push(`${priceLabel} must match a configured agent or evaluator agent provider/model`);
    }
  }

  if (config.report?.prompt) await checkMarkdownPath(suiteRoot, config.report.prompt, "report.prompt", errors);

  return errors;
}

function normalizeEvalSuiteConfig(config: RawEvalSuiteConfig): EvalSuiteConfig {
  return {
    sandbox: { provider: config.sandbox?.provider as EvalSandboxProvider },
    agents: (config.agents ?? []).map((agent) => withoutUndefined({ id: agent.id, provider: agent.provider, model: agent.model, env: agent.env })),
    evaluatorAgent: withoutUndefined({
      id: config.evaluatorAgent?.id,
      provider: config.evaluatorAgent?.provider,
      model: config.evaluatorAgent?.model,
      prompt: config.evaluatorAgent?.prompt,
      env: config.evaluatorAgent?.env,
    }),
    tasks: (config.tasks ?? []).map((task) => ({
      id: task.id as string,
      prompt: task.prompt as string,
      starter: task.starter as string,
      scoring: {
        deterministicWeight: task.scoring?.deterministicWeight as number,
        rubricWeight: task.scoring?.rubricWeight as number,
      },
      acceptanceMaterial: {
        hiddenDir: task.acceptanceMaterial?.hiddenDir as string,
        checks: (task.acceptanceMaterial?.checks ?? []).map((check) => ({
          id: check.id as string,
          command: check.command as string,
          cwd: check.cwd ?? ".",
          timeoutMs: check.timeoutMs ?? 30000,
          weight: check.weight ?? 1,
          env: check.env ?? {},
          artifacts: check.artifacts ?? [],
        })),
        rubrics: (task.acceptanceMaterial?.rubrics ?? []).map((rubric) => ({
          id: rubric.id as string,
          path: rubric.path as string,
          weight: rubric.weight ?? 1,
          scale: { min: rubric.scale?.min ?? 1, max: rubric.scale?.max ?? 5 },
        })),
      },
    })),
    scenarioVariants: (config.scenarioVariants ?? []).map((scenarioVariant) =>
      withoutUndefined({
        id: scenarioVariant.id,
        description: scenarioVariant.description,
        prompt: scenarioVariant.prompt,
        repoOverlay: scenarioVariant.repoOverlay,
        agentHomeOverlay: scenarioVariant.agentHomeOverlay,
      })
    ),
    matrix: withoutUndefined({
      runIndexes: config.matrix?.runIndexes ?? [],
      baselineScenarioVariant: config.matrix?.baselineScenarioVariant,
      include: (config.matrix?.include ?? []).map(normalizeSelector),
      exclude: (config.matrix?.exclude ?? []).map(normalizeSelector),
    }),
    pricing: (config.pricing ?? []).map((price) =>
      withoutUndefined({
        id: price.id,
        provider: price.provider,
        model: price.model,
        inputPerMillion: price.inputPerMillion,
        cacheReadPerMillion: price.cacheReadPerMillion,
        cacheWritePerMillion: price.cacheWritePerMillion,
        outputPerMillion: price.outputPerMillion,
      })
    ),
    report: config.report ? withoutUndefined({ prompt: config.report.prompt }) : undefined,
  } as EvalSuiteConfig;
}

function normalizeSelector(selector: RawMatrixSelector): MatrixSelector {
  return { agent: selector.agent as string, task: selector.task as string, scenarioVariant: selector.scenarioVariant as string, runIndex: selector.runIndex as number };
}

function withoutUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
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
  selector: RawMatrixSelector,
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
