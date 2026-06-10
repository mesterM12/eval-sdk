import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type GitWorkBaseline = {
  baseSha: string;
};

export async function ensureGitWorkBaseline(input: { repoPath: string }): Promise<GitWorkBaseline> {
  if (!(await gitSucceeds(input.repoPath, ["rev-parse", "--is-inside-work-tree"]))) {
    await git(input.repoPath, ["init"]);
  }
  await git(input.repoPath, ["config", "user.email", "eval-trial@example.invalid"]);
  await git(input.repoPath, ["config", "user.name", "Eval Trial"]);
  if (!(await gitSucceeds(input.repoPath, ["rev-parse", "--verify", "HEAD"]))) {
    await git(input.repoPath, ["add", "."]);
    await git(input.repoPath, ["commit", "-m", "Initial eval trial baseline"]);
  }
  return { baseSha: (await gitStdout(input.repoPath, ["rev-parse", "HEAD"])).trim() };
}

export async function collectGitWorkDiff(input: { repoPath: string; baseSha: string }) {
  await git(input.repoPath, ["add", "--intent-to-add", "."]);
  const committed = await gitStdout(input.repoPath, ["diff", `${input.baseSha}..HEAD`]);
  const staged = await gitStdout(input.repoPath, ["diff", "--cached"]);
  const uncommitted = await gitStdout(input.repoPath, ["diff"]);
  return [committed, staged, uncommitted].filter((part) => part.length > 0).join("\n");
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
