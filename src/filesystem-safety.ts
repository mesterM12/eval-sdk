import { readdir } from "node:fs/promises";
import path from "node:path";

export function resolveSuitePath(suiteRoot: string, relativePath: string) {
  return resolveContainedPath(suiteRoot, relativePath, "eval trial path must stay inside the suite root");
}

export function resolveScoringRootPath(scoringRoot: string, relativePath: string, label = "acceptance check cwd") {
  return resolveContainedPath(scoringRoot, relativePath, `${label} must stay inside the eval trial scoring sandbox`);
}

export function isSafeRelativePath(relativePath: string) {
  return relativePath.length > 0 && !path.isAbsolute(relativePath) && !relativePath.split(/[\\/]+/).includes("..");
}

export function normalizeRelativePath(relativePath: string) {
  return relativePath.split(/[\\/]+/).join("/").replace(/^\.\//, "");
}

export async function listVisibleFiles(root: string, relativeDir = ""): Promise<string[]> {
  const entries = await readdir(path.join(root, relativeDir), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === ".git") continue;
    const relativePath = path.join(relativeDir, entry.name);
    if (entry.isDirectory()) files.push(...(await listVisibleFiles(root, relativePath)));
    else if (entry.isFile()) files.push(normalizeRelativePath(relativePath));
  }
  return files.sort();
}

function resolveContainedPath(root: string, relativePath: string, message: string) {
  if (path.isAbsolute(relativePath)) {
    throw new Error(`${message}: ${relativePath}`);
  }
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relativePath);
  const relative = path.relative(resolvedRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${message}: ${relativePath}`);
  }
  return resolved;
}
