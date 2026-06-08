import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";

export type PrepareEvalTrialWorktreeInput = {
  suiteRoot: string;
  evalTrialId: string;
  starterPath: string;
  tempRoot?: string;
  repoOverlayPath?: string;
  agentHomeOverlayPath?: string;
  hiddenAcceptancePath?: string;
};

export type PreparedEvalTrialWorktree = {
  evalTrialId: string;
  rootPath: string;
  repoPath: string;
  agentHomePath: string;
};

export type EvalTrialWorktreeResultMetadata = {
  preserved: boolean;
  worktreePath: string | null;
  agentHomePath: string | null;
};

export async function prepareEvalTrialWorktree(input: PrepareEvalTrialWorktreeInput): Promise<PreparedEvalTrialWorktree> {
  const suiteRoot = path.resolve(input.suiteRoot);
  const tempRoot = input.tempRoot ? path.resolve(input.tempRoot) : path.join(suiteRoot, ".eval-agent");
  const rootPath = path.join(tempRoot, "worktrees", input.evalTrialId);
  const repoPath = path.join(rootPath, "repo");
  const agentHomePath = path.join(rootPath, "agent-home");

  await rm(rootPath, { recursive: true, force: true });
  await mkdir(repoPath, { recursive: true });
  await mkdir(agentHomePath, { recursive: true });

  await copyDirectory(resolveSuitePath(suiteRoot, input.starterPath), repoPath);
  if (input.repoOverlayPath) {
    await copyDirectory(resolveSuitePath(suiteRoot, input.repoOverlayPath), repoPath);
  }
  if (input.agentHomeOverlayPath) {
    await copyDirectory(resolveSuitePath(suiteRoot, input.agentHomeOverlayPath), agentHomePath);
  }

  return { evalTrialId: input.evalTrialId, rootPath, repoPath, agentHomePath };
}

export async function finalizeEvalTrialWorktree(
  prepared: PreparedEvalTrialWorktree,
  result: { outcome: "success" | "failure" }
): Promise<EvalTrialWorktreeResultMetadata> {
  if (result.outcome === "success") {
    await rm(prepared.rootPath, { recursive: true, force: true });
    return { preserved: false, worktreePath: null, agentHomePath: null };
  }

  return { preserved: true, worktreePath: prepared.repoPath, agentHomePath: prepared.agentHomePath };
}

async function copyDirectory(source: string, destination: string) {
  await cp(source, destination, { recursive: true, force: true, errorOnExist: false });
}

function resolveSuitePath(suiteRoot: string, relativePath: string) {
  const resolved = path.resolve(suiteRoot, relativePath);
  const relative = path.relative(suiteRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`eval trial path must stay inside the suite root: ${relativePath}`);
  }
  return resolved;
}
