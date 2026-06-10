import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AcceptanceCheckResult } from "./acceptance-material-sandbox.js";
import { redactText, resolveEnv } from "./env-reference.js";
import type { EvalSuiteConfig } from "./eval-suite-config.js";
import { listVisibleFiles, normalizeRelativePath, resolveSuitePath } from "./filesystem-safety.js";
import { runSandcastleBuiltIn, sandcastleRuntime, type EvalSandboxProvider, type SandcastleRuntime } from "./sandcastle-provider-registry.js";

type RubricConfig = EvalSuiteConfig["tasks"][number]["acceptanceMaterial"]["rubrics"][number];

export type EvaluatorAgentJson = { criteria: Array<{ id: string; score: number; rationale: string }>; summary: string };

export type EvaluatorAgentScoringResult =
  | { providerName: string; model?: string; status: "success"; result: EvaluatorAgentJson; stdout: string; stderr?: string }
  | { providerName: string; model?: string; status: "failed"; error: string; stdout?: string; stderr?: string }
  | { status: "skipped" };

export type EvaluatorAgentExecutorInput = {
  evalTrialId: string;
  providerName: string;
  model?: string;
  prompt: string;
  scoringContextPath: string;
  sandboxProvider: EvalSandboxProvider;
  readOnly: true;
  deterministicResults: AcceptanceCheckResult[];
  rubrics: RubricConfig[];
  env: Record<string, string>;
};

export type EvaluatorAgentExecutorResult = { stdout: string; stderr?: string };

export async function runEvaluatorAgent(input: {
  suiteRoot: string;
  evalTrialId: string;
  scoringRepoPath: string;
  deterministicResults: AcceptanceCheckResult[];
  rubrics: RubricConfig[];
  evaluatorAgent?: EvalSuiteConfig["evaluatorAgent"];
  sandboxProvider: EvalSandboxProvider;
  executor?: (input: EvaluatorAgentExecutorInput) => Promise<EvaluatorAgentExecutorResult>;
  secretValues: string[];
}): Promise<EvaluatorAgentScoringResult> {
  if (!input.evaluatorAgent?.provider) return { status: "skipped" };
  const providerName = requireString(input.evaluatorAgent.provider, "evaluator agent provider");
  const model = input.evaluatorAgent.model;
  const basePrompt = input.evaluatorAgent.prompt ? await readFile(resolveSuitePath(input.suiteRoot, input.evaluatorAgent.prompt), "utf8") : "";
  const executor = input.executor ?? createSandcastleEvaluatorAgentExecutor();
  try {
    const beforeContext = await snapshotScoringContext(input.scoringRepoPath);
    const output = await executor({
      evalTrialId: input.evalTrialId,
      providerName,
      model,
      prompt: await buildEvaluatorAgentPrompt(input.suiteRoot, basePrompt, input.deterministicResults, input.rubrics),
      scoringContextPath: input.scoringRepoPath,
      sandboxProvider: input.sandboxProvider,
      readOnly: true,
      deterministicResults: input.deterministicResults,
      rubrics: input.rubrics,
      env: resolveEnv(input.evaluatorAgent.env),
    });
    await assertScoringContextUnchanged(input.scoringRepoPath, beforeContext);
    const parsed = parseEvaluatorAgentJson(output.stdout, input.rubrics);
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

export function createSandcastleEvaluatorAgentExecutor(runtime: SandcastleRuntime = sandcastleRuntime): (input: EvaluatorAgentExecutorInput) => Promise<EvaluatorAgentExecutorResult> {
  return async (input) => {
    const logPath = path.join(path.dirname(input.scoringContextPath), `${input.evalTrialId}-evaluator-sandcastle.log`);
    const result = await runSandcastleBuiltIn({
      providerName: input.providerName,
      model: input.model,
      env: input.env,
      sandboxProvider: input.sandboxProvider,
      execution: { type: "evaluator-agent" },
      cwd: input.scoringContextPath,
      prompt: input.prompt,
      logPath,
      providerLabel: "evaluator agent provider",
    }, runtime);
    return {
      stdout: typeof result.stdout === "string" ? result.stdout : "",
    };
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

function parseEvaluatorAgentJson(stdout: string, rubrics: RubricConfig[]): EvaluatorAgentJson {
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
    if (typeof item.id !== "string" || typeof item.score !== "number" || !Number.isFinite(item.score) || typeof item.rationale !== "string") {
      throw new Error("evaluator agent criterion has an invalid schema");
    }
    return { id: item.id, score: item.score, rationale: item.rationale };
  });
  validateCriteria(criteria, rubrics);
  return { criteria, summary: object.summary };
}

function validateCriteria(criteria: EvaluatorAgentJson["criteria"], rubrics: RubricConfig[]) {
  const criteriaById = new Map(criteria.map((criterion) => [criterion.id, criterion]));
  const rubricIds = new Set(rubrics.map((rubric) => requireString(rubric.id, "rubric id")));
  for (const criterion of criteria) {
    if (!rubricIds.has(criterion.id)) throw new Error(`evaluator agent criterion references unknown rubric: ${criterion.id}`);
  }
  for (const rubric of rubrics) {
    const rubricId = requireString(rubric.id, "rubric id");
    if (!criteriaById.has(rubricId)) throw new Error(`evaluator agent JSON is missing rubric criterion: ${rubricId}`);
  }
}

async function snapshotScoringContext(scoringRepoPath: string) {
  const snapshot = new Map<string, string>();
  for (const file of await listVisibleFiles(scoringRepoPath)) {
    const normalizedFile = normalizeRelativePath(file);
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

function requireString(value: string | undefined, label: string) {
  if (!value) throw new Error(`${label} is required`);
  return value;
}
