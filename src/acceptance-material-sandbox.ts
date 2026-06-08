import { cp, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { exec } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type { EvalSuiteConfig } from "./eval-suite-config.js";

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
  const names = new Set<string>();
  addEnvRefNames(agent?.env, names);
  for (const check of checks) addEnvRefNames(check.env, names);
  addEnvRefNames(evaluatorAgent?.env, names);
  return [...names].map((name) => process.env[name]).filter((value): value is string => typeof value === "string" && value.length > 0);
}

export function redactText(text: string, secretValues: string[]) {
  return secretValues.reduce((redacted, secret) => redacted.split(secret).join("[REDACTED]"), text);
}

async function runAcceptanceCheck(scoringRepoPath: string, hiddenDir: string, check: AcceptanceCheckConfig, secretValues: string[]): Promise<AcceptanceCheckResult> {
  const command = requireString(check.command, "acceptance check command");
  const cwd = check.cwd ?? ".";
  const timeoutMs = check.timeoutMs ?? 30000;
  const resolvedCwd = resolveInside(scoringRepoPath, cwd, "acceptance check cwd");
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
    env: envNames(check.env),
    stdout: redactText(stdout, secretValues),
    stderr: redactText(stderr, secretValues),
    exitCode,
    durationMs: Date.now() - startedAt,
    timedOut,
    artifacts: await collectArtifacts(scoringRepoPath, hiddenDir, check.artifacts ?? [], secretValues),
  };
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

function resolveInside(root: string, relativePath: string, label: string) {
  const resolved = path.resolve(root, relativePath);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`${label} must stay inside the eval trial scoring sandbox: ${relativePath}`);
  return resolved;
}

function normalizeRelative(relativePath: string) {
  return relativePath.split(path.sep).join("/").replace(/^\.\//, "");
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
