import { cp, mkdir, readFile, rm } from "node:fs/promises";
import { exec } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { collectEnvSecretValues, describeEnvForPublicOutput, redactText, resolveEnv } from "./env-reference.js";
import type { EvalSuiteConfig } from "./eval-suite-config.js";
import { listVisibleFiles, normalizeRelativePath, resolveScoringRootPath, resolveSuitePath } from "./filesystem-safety.js";

const execAsync = promisify(exec);

export type AcceptanceCheckConfig = EvalSuiteConfig["tasks"][number]["acceptanceMaterial"]["checks"][number];

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

export type AcceptanceMaterialSandboxInput<T> = {
  suiteRoot: string;
  scoringRoot: string;
  completedRepoPath: string;
  hiddenDir?: string;
  checks?: AcceptanceCheckConfig[];
  secretValues: string[];
  afterAcceptanceChecks?: (context: { scoringRepoPath: string; acceptanceChecks: AcceptanceCheckResult[] }) => Promise<T>;
};

export async function runAcceptanceMaterialSandbox<T = undefined>(input: AcceptanceMaterialSandboxInput<T>): Promise<{ acceptanceChecks: AcceptanceCheckResult[]; value: T | undefined }> {
  await rm(input.scoringRoot, { recursive: true, force: true });
  const scoringRepoPath = path.join(input.scoringRoot, "repo");
  try {
    await mkdir(path.dirname(scoringRepoPath), { recursive: true });
    await cp(input.completedRepoPath, scoringRepoPath, { recursive: true });
    if (input.hiddenDir) {
      await cp(resolveSuitePath(input.suiteRoot, input.hiddenDir), path.join(scoringRepoPath, input.hiddenDir), { recursive: true });
    }

    const acceptanceChecks: AcceptanceCheckResult[] = [];
    for (const check of input.checks ?? []) {
      acceptanceChecks.push(await runAcceptanceCheck(scoringRepoPath, input.hiddenDir ?? "", check, input.secretValues));
    }
    const value = await input.afterAcceptanceChecks?.({ scoringRepoPath, acceptanceChecks });
    return { acceptanceChecks, value };
  } finally {
    await rm(input.scoringRoot, { recursive: true, force: true });
  }
}

export function collectAcceptanceSecretValues(checks: AcceptanceCheckConfig[], evaluatorAgent?: EvalSuiteConfig["evaluatorAgent"], agent?: EvalSuiteConfig["agents"][number]) {
  return collectEnvSecretValues([agent?.env, ...checks.map((check) => check.env), evaluatorAgent?.env]);
}

async function runAcceptanceCheck(scoringRepoPath: string, hiddenDir: string, check: AcceptanceCheckConfig, secretValues: string[]): Promise<AcceptanceCheckResult> {
  const command = requireString(check.command, "acceptance check command");
  const cwd = check.cwd ?? ".";
  const timeoutMs = check.timeoutMs ?? 30000;
  const resolvedCwd = resolveScoringRootPath(scoringRepoPath, cwd, "acceptance check cwd");
  const startedAt = Date.now();
  let stdout = "";
  let stderr = "";
  let exitCode: number | null = 0;
  let timedOut = false;
  try {
    const result = await execAsync(command, {
      cwd: resolvedCwd,
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
    env: describeEnvForPublicOutput(check.env),
    stdout: redactText(stdout, secretValues),
    stderr: redactText(stderr, secretValues),
    exitCode,
    durationMs: Date.now() - startedAt,
    timedOut,
    artifacts: await collectArtifacts(scoringRepoPath, hiddenDir, check.artifacts ?? [], secretValues),
  };
}

async function collectArtifacts(scoringRepoPath: string, hiddenDir: string, globs: string[], secretValues: string[]) {
  const files = await listVisibleFiles(scoringRepoPath);
  const normalizedHiddenDir = normalizeRelativePath(hiddenDir);
  const artifacts: Array<{ path: string; contents: string }> = [];
  for (const glob of globs) {
    const matcher = globMatcher(normalizeRelativePath(glob));
    for (const file of files) {
      const normalizedFile = normalizeRelativePath(file);
      if (normalizedFile === normalizedHiddenDir || normalizedFile.startsWith(`${normalizedHiddenDir}/`)) continue;
      if (!matcher(normalizedFile)) continue;
      artifacts.push({ path: normalizedFile, contents: redactText(await readFile(path.join(scoringRepoPath, normalizedFile), "utf8"), secretValues) });
    }
  }
  return artifacts.sort((a, b) => a.path.localeCompare(b.path));
}

function globMatcher(glob: string) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "[\s\S]*").replace(/\*/g, "[^/]*");
  const regex = new RegExp(`^${escaped}$`);
  return (value: string) => regex.test(value);
}

function requireString(value: string | undefined, label: string) {
  if (!value) throw new Error(`${label} is required`);
  return value;
}
