import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const evalTrialArtifactFiles = {
  acceptanceOutput: "acceptance-output.json",
  commits: "commits.json",
  config: "config.json",
  cost: "cost.json",
  diff: "diff.patch",
  evaluatorRationale: "evaluator-rationale.json",
  manifest: "artifact-manifest.json",
  prompt: "prompt.md",
  result: "result.json",
  sandcastleLog: "sandcastle.log",
  timings: "timings.json",
  usage: "usage.json",
} as const;

export type PersistedEvalTrialResult = {
  evalTrialId?: string;
  status?: string;
  error?: string;
  timings?: { durationMs?: number; startedAt?: string; finishedAt?: string };
  sandcastle?: unknown;
  scoring?: {
    acceptanceChecks?: Array<{ id?: string; exitCode?: number | null; timedOut?: boolean; weight?: number; stdout?: string; stderr?: string }>;
    evaluatorAgent?: { status?: string; result?: { summary?: string; criteria?: Array<{ id?: string; score?: number; rationale?: string }> }; error?: string };
  };
  evalScore?: { value?: number; deterministic?: unknown; rubric?: unknown; formula?: string };
  usage?: { agent?: Record<string, unknown> };
  cost?: { agent?: Record<string, unknown>; evaluatorAgent?: Record<string, unknown> };
  worktree?: { preserved?: boolean; worktreePath?: string | null; agentHomePath?: string | null };
};

export type EvalTrialArtifacts = {
  config: unknown;
  diff: string;
  commits: unknown[];
  timings: unknown;
  usage: unknown;
  cost: unknown;
  acceptanceOutput: unknown;
  evaluatorRationale: unknown;
  result: PersistedEvalTrialResult;
};

export async function writeEvalTrialArtifacts(artifactRoot: string, artifacts: EvalTrialArtifacts) {
  await writeJson(evalTrialArtifactPath(artifactRoot, "config"), artifacts.config);
  await writeFile(evalTrialArtifactPath(artifactRoot, "diff"), artifacts.diff, "utf8");
  await writeJson(evalTrialArtifactPath(artifactRoot, "commits"), artifacts.commits);
  await writeJson(evalTrialArtifactPath(artifactRoot, "timings"), artifacts.timings);
  await writeJson(evalTrialArtifactPath(artifactRoot, "usage"), artifacts.usage);
  await writeJson(evalTrialArtifactPath(artifactRoot, "cost"), artifacts.cost);
  await writeJson(evalTrialArtifactPath(artifactRoot, "acceptanceOutput"), artifacts.acceptanceOutput);
  await writeJson(evalTrialArtifactPath(artifactRoot, "evaluatorRationale"), artifacts.evaluatorRationale);
  await writeJson(evalTrialArtifactPath(artifactRoot, "result"), artifacts.result);
}

export async function writeFailedEvalTrialResult(artifactRoot: string, result: PersistedEvalTrialResult) {
  await writeJson(evalTrialArtifactPath(artifactRoot, "result"), result);
}

export async function writeEvalTrialArtifactManifest(artifactRoot: string) {
  const files = (await readdir(artifactRoot, { withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => name !== evalTrialArtifactFiles.manifest);
  await writeJson(evalTrialArtifactPath(artifactRoot, "manifest"), { files: [...files, evalTrialArtifactFiles.manifest].sort() });
}

export async function readEvalTrialArtifacts(artifactRoot: string): Promise<{ result: PersistedEvalTrialResult; config?: unknown }> {
  const result = JSON.parse(await readFile(evalTrialArtifactPath(artifactRoot, "result"), "utf8")) as PersistedEvalTrialResult;
  const config = await readOptionalJson(evalTrialArtifactPath(artifactRoot, "config"));
  return { result, ...(config === undefined ? {} : { config }) };
}

export function evalTrialArtifactPath(artifactRoot: string, artifact: keyof typeof evalTrialArtifactFiles) {
  return path.join(artifactRoot, evalTrialArtifactFiles[artifact]);
}

async function readOptionalJson(filePath: string) {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeJson(filePath: string, value: unknown) {
  await writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
}
