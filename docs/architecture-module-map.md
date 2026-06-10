# Architecture Module Map

This map helps Ralph loop agents preserve module depth while changing the Coding Agent Eval CLI. Prefer changes that keep domain rules near the module that owns them. Each section names locality and leverage for the module. Do not add a shallow pass-through file when a caller can already use a clear interface directly.

## Eval Suite Config

Files: `src/eval-suite-config.ts`, consumed by `src/cli.ts`, `src/trial-matrix.ts`, and Eval Trial execution modules.

Interface: `loadEvalSuiteConfig(configPath, options)` returns a normalized `EvalSuiteConfig`, suite root, config path, and summary.

Implementation: Parses YAML, validates provider support, sandbox provider support, path safety, duplicate ids, environment references, scoring weights, Acceptance Material references, Trial Matrix selectors, and pricing references, then normalizes optional values into predictable arrays and defaults.

Domain rules owned: Eval Suite config validity, Docker or local sandbox selection, Sandcastle built-in provider ids, safe relative paths, `env:` references, deterministic and rubric weight sum, and references from Trial Matrix selectors to agents, tasks, Scenario Variants, and run indexes.

Locality: Config rules stay in one module instead of leaking into command handling, Trial Matrix expansion, or Eval Trial orchestration.

Leverage: CLI commands can stay shallow, and tests can verify config behavior without starting an Eval Trial.

Depth guidance: Keep new config validation here unless it needs completed Eval Trial facts. Avoid a helper that only forwards raw YAML to another module.

## Eval Trial Identity

Files: `src/eval-trial-identity.ts`, consumed by `src/trial-matrix.ts` and report logic.

Interface: `createEvalTrialId(identity)` and `parseEvalTrialId(evalTrialId)`.

Implementation: Encodes agent id, task id, Scenario Variant id, and run index with the `__` delimiter while rejecting ambiguous or artifact-unsafe parts.

Domain rules owned: Eval Trial id determinism, delimiter safety, positive run index validation, artifact-safe directory naming, and parsing back into Eval Trial identity facts.

Locality: String format rules stay behind one small interface instead of reappearing as split and join logic across Trial Matrix, reports, and artifacts.

Leverage: A delimiter rule change is testable in one place and then flows through result paths, baseline report matching, and Trial Matrix overrides.

Depth guidance: Call this module rather than rebuilding ids inline. Inline parsing is a shallow substitute that risks divergent Eval Trial identity behavior.

## Eval Trial Artifacts

Files: `src/eval-trial-artifacts.ts`, composed by `src/eval-trial-lifecycle.ts` and consumed by `src/report.ts`.

Interface: `evalTrialArtifactFiles`, `evalTrialArtifactPath(artifactRoot, artifact)`, `writeEvalTrialArtifacts(artifactRoot, artifacts)`, `writeFailedEvalTrialResult(artifactRoot, result)`, `writeEvalTrialArtifactManifest(artifactRoot)`, and `readEvalTrialArtifacts(artifactRoot)`.

Implementation: Owns stable artifact filenames, the persisted result JSON shape, per-artifact JSON and patch writing, manifest enumeration, optional config reading for older result directories, and result artifact reading for Reports.

Domain rules owned: Eval Trial artifact compatibility, persisted result shape consumed by Reports, manifest contents, and shared artifact filenames for lifecycle writing and report regeneration.

Locality: Artifact contract rules stay in one module instead of being split between Eval Trial lifecycle and Reports.

Leverage: Lifecycle-written artifacts and fixture result directories can be tested through the same seam that Reports use, preserving report regeneration without rerunning Eval Trials, Acceptance Material, or Evaluator Agents.

Depth guidance: Keep artifact filenames, persisted result shape, and manifest writing here. Do not let Reports hard-code lifecycle output paths, recompute Eval Scores, rerun Acceptance Material, invoke Evaluator Agents, or decide lifecycle status.

## Env Reference

Files: `src/env-reference.ts`, consumed by `src/eval-suite-config.ts`, `src/eval-trial-lifecycle.ts`, `src/acceptance-material-sandbox.ts`, and `src/evaluator-agent.ts`.

Interface: `envReferenceValidationError(value, label, name)`, `resolveEnv(env)`, `collectEnvSecretValues(envBlocks)`, `describeEnvForPublicOutput(env)`, and `redactText(text, secretValues)`.

Implementation: Validates `env:` references, resolves referenced process env values with existing missing-value behavior, collects secret values from the same reference syntax, renders env names for public artifacts, and redacts secret values from public text.

Domain rules owned: Env reference syntax, coding agent env resolution, Acceptance Material env resolution, Evaluator Agent env resolution, secret collection, missing env fallback, public env display, and redaction.

Locality: Env and secret rules stay in one module instead of being repeated in Eval Suite Config, Eval Trial lifecycle, Acceptance Material sandboxing, and Evaluator Agent handling.

Leverage: Tests can prove valid env refs, invalid env refs, missing env values, secret collection, and redaction once, then consumer seams reuse the same behavior for Eval Trials and post-trial scoring.

Depth guidance: Keep shared `env:` syntax, resolution, public display, and redaction rules here. Do not recreate prefix checks or `process.env` lookup logic in callers; callers should only decide which env blocks participate in their Eval Trial, Acceptance Material, or Evaluator Agent path.

## Acceptance Material Sandbox

Files: `src/acceptance-material-sandbox.ts`, composed by `src/post-trial-scoring.ts`.

Interface: `runAcceptanceMaterialSandbox(input)`, `collectAcceptanceSecretValues(checks, evaluatorAgent, agent)`, and `redactText(text, secretValues)`.

Implementation: Copies completed work into a scoring root, injects hidden Acceptance Material only there, runs deterministic checks with safe cwd handling and timeouts, collects non-hidden artifacts, redacts secret values, and cleans up the scoring root.

Domain rules owned: Hidden Acceptance Material timing, scoring sandbox containment, deterministic check execution, artifact collection that excludes hidden files, secret redaction, and cleanup after scoring.

Locality: Hiddenness and redaction rules stay together instead of being spread across Eval Trial execution, Evaluator Agent handling, and artifact writing.

Leverage: Filesystem seam tests can prove hidden Acceptance Material is absent during Eval Trial execution and present only for post-trial scoring.

Depth guidance: Preserve `docs/adr/0002-hidden-acceptance-runs-in-post-trial-scoring-sandbox.md`. Do not add hidden Acceptance Material paths to Eval Trial worktrees, prompt snapshots, logs, or trial artifacts.

## Filesystem Safety

Files: `src/filesystem-safety.ts`, consumed by `src/eval-suite-config.ts`, `src/eval-trial-worktree.ts`, `src/eval-trial-lifecycle.ts`, `src/acceptance-material-sandbox.ts`, and `src/evaluator-agent.ts`.

Interface: `resolveSuitePath(suiteRoot, relativePath)`, `resolveScoringRootPath(scoringRoot, relativePath, label)`, `isSafeRelativePath(relativePath)`, `normalizeRelativePath(relativePath)`, and `listVisibleFiles(root)`.

Implementation: Resolves suite-relative paths while rejecting escapes, resolves scoring-root paths for Acceptance Material checks, validates relative path strings, normalizes relative paths to slash-separated artifact keys, and recursively lists visible files while excluding `.git`.

Domain rules owned: Suite-root containment for Eval Trial starter files, Scenario Variant overlays, prompts, and rubrics; scoring-root containment for Acceptance Material execution; visible file traversal for artifacts and Evaluator Agent snapshots; and relative path normalization for filesystem comparisons.

Locality: Filesystem safety rules stay in one module instead of being repeated in Eval Suite config validation, Eval Trial worktree setup, prompt snapshotting, Acceptance Material sandboxing, and Evaluator Agent read-only checks.

Leverage: A path containment or visibility rule change is testable at one seam and then flows through Eval Trial preparation, post-trial scoring, Evaluator Agent scoring context, and config reference validation.

Depth guidance: Keep containment, visibility, and normalization rules here when they are shared across modules. Do not add shallow wrappers that only forward to `path.resolve`, `path.relative`, or `readdir`; callers should use this module when they need safety behavior, not generic filesystem access.

## Eval Score And Scoring

Files: `src/scoring.ts`, composed by `src/eval-trial-lifecycle.ts` after post-trial scoring.

Interface: `scoreEvalTrialFacts({ agent, task, acceptanceChecks, evaluatorAgent, iterations, pricing })`.

Implementation: Aggregates deterministic acceptance check results and Evaluator Agent rubric results into an Eval Score, prevents rubric contribution when deterministic checks fail, normalizes usage from coding agent iterations, and estimates cost from configured pricing.

Domain rules owned: Eval Score formula, deterministic anchoring, rubric scale normalization, empty acceptance behavior, unknown usage preservation, unavailable usage and cost states, and configured price matching.

Locality: Scoring math and usage normalization stay out of Eval Trial orchestration and reports.

Leverage: Pure domain tests can cover Eval Score, usage, and cost rules without Docker, Sandcastle, git, or filesystem setup.

Depth guidance: Preserve `docs/adr/0001-deterministic-tests-anchor-scoring.md`. Evaluator Agent results may add qualitative signal, but they must not override executable Acceptance Material failures.

## Evaluator Agent

Files: `src/evaluator-agent.ts`, composed by `src/post-trial-scoring.ts`.

Interface: `runEvaluatorAgent(input)` and `createSandcastleEvaluatorAgentExecutor(runtime)`.

Implementation: Builds the Evaluator Agent prompt from deterministic results and rubric docs, runs a read-only scoring context through a Sandcastle built-in provider, verifies no files changed, parses strict JSON, validates criteria against configured rubrics, and redacts captured output.

Domain rules owned: Evaluator Agent prompt shape, read-only scoring context enforcement, rubric doc loading, JSON shape, unknown or missing rubric criteria failure, provider mapping for evaluator execution, and failure shaping.

Locality: Qualitative scoring behavior stays in one module rather than being mixed into Acceptance Material sandboxing or Eval Score aggregation.

Leverage: Fake adapter tests can exercise malformed JSON, mutation attempts, rubric validation, and provider mapping without a real model.

Depth guidance: Keep the Evaluator Agent read-only and post-trial. Do not let it change completed work or replace deterministic Acceptance Material checks.

## Coding Agent Adapter

Files: `src/coding-agent-adapter.ts`, composed by `src/eval-trial-lifecycle.ts`.

Interface: `createSandcastleCodingAgentAdapter(runtime)` returns `completeEvalTrial(input)`. `createSandcastleBuiltInExecutor(runtime)` remains a compatibility seam for tests and existing callers.

Implementation: Maps configured coding agent provider and model to Sandcastle built-ins, selects Docker or local Sandcastle execution, mounts the prepared agent home for Docker, runs with head branch strategy, reads logs, collects commits, captures provider metadata, preserves iteration usage, and asks git work for the diff.

Domain rules owned: Coding agent provider mapping, Docker mount shape for agent runtime config, local host execution for login-authenticated CLIs, Sandcastle logging, branch strategy, result normalization, and handoff to git work for changed work.

Locality: Sandcastle details stay behind the adapter interface instead of leaking into Eval Trial lifecycle code.

Leverage: Fixture-based adapter tests can verify provider mapping, sandbox selection, Docker options, logs, commits, diff, and usage metadata without executing a real coding agent.

Depth guidance: Preserve `docs/adr/0003-local-sandbox-for-login-authenticated-agents.md`. Do not add custom command adapters when Sandcastle already provides the sandbox provider needed by product scope.

## Sandbox Provider And Sandcastle Provider Registry

Files: `src/sandcastle-provider-registry.ts`, consumed by `src/eval-suite-config.ts`, `src/coding-agent-adapter.ts`, `src/evaluator-agent.ts`, and `src/post-trial-scoring.ts`.

Interface: `supportedSandboxProviders`, `supportedSandcastleBuiltInProviders`, `isEvalSandboxProvider(provider)`, `isSandcastleBuiltInProvider(provider)`, `sandcastleRuntime`, `createSandboxForEvalTrial(input, runtime)`, `createSandboxForEvaluatorAgent(sandboxProvider, runtime)`, and `runSandcastleBuiltIn(input, runtime)`.

Implementation: Validates `docker` and `local`, validates Sandcastle built-in provider ids, maps provider ids to Sandcastle factories, chooses Docker or local sandbox execution for coding agents and Evaluator Agents, and owns shared Sandcastle run intent such as provider env, cwd, prompt, logging, and head branch strategy.

Domain rules owned: Sandbox Provider support, local login execution, Docker execution, Sandcastle built-in provider id validity, and common built-in execution shape.

Locality: Provider support and common execution-shape changes should happen in one module instead of being repeated in config validation, coding-agent execution, and Evaluator Agent execution.

Leverage: Config validation and both execution adapters can share the same provider facts and shared Sandcastle run intent while keeping their own prompt, result, artifact, and failure behavior.

Depth guidance: Do not import Sandbox Provider types from the Coding Agent Adapter into unrelated modules. Keep local/Docker choice and shared Sandcastle built-in execution intent here; keep coding-agent result shaping and Evaluator Agent scoring behavior in their adapters.

## Git Work

Files: `src/git-work.ts`, used by `src/coding-agent-adapter.ts` and `src/eval-trial-lifecycle.ts`.

Interface: `ensureGitWorkBaseline({ repoPath })` and `collectGitWorkDiff({ repoPath, baseSha })`.

Implementation: Initializes git when needed, configures local commit identity, creates an initial Eval Trial baseline commit when no HEAD exists, returns the baseline sha, and combines committed plus uncommitted diffs after coding agent execution.

Domain rules owned: Eval Trial baseline creation, local git identity for reproducible commits, and changed work collection.

Locality: Git commands and diff assumptions stay separate from Sandcastle execution and artifact writing.

Leverage: Temporary repo tests can verify baseline and diff behavior with no coding agent, Acceptance Material, or report generation.

Depth guidance: Keep git work focused. Remote starter sources, host-only scoring, retries, and storage changes are future scope, not part of this module.

## Eval Trial Worktree

Files: `src/eval-trial-worktree.ts`, composed by `src/eval-trial-lifecycle.ts`.

Interface: `prepareEvalTrialWorktree(input)` and `finalizeEvalTrialWorktree(prepared, result)`.

Implementation: Creates an isolated Eval Trial repo and agent home, copies visible starter files, applies Scenario Variant repo overlays, stages agent-home overlays, removes successful worktrees, and preserves failed worktrees in result metadata.

Domain rules owned: Eval Trial worktree isolation, visible starter material, Scenario Variant file overlays, agent runtime config overlays, successful cleanup, and failed Eval Trial preservation.

Locality: Filesystem setup and cleanup rules stay out of Eval Trial lifecycle orchestration and coding-agent execution.

Leverage: Tests can prove worktree isolation, overlay behavior, and preservation rules without running a coding agent or post-trial scoring.

Depth guidance: Hidden Acceptance Material is not a worktree concern. Preserve `docs/adr/0002-hidden-acceptance-runs-in-post-trial-scoring-sandbox.md` by keeping hidden files in post-trial scoring modules only.

## Reports

Files: `src/report.ts`, consumed by `src/eval-trial-execution.ts` and `src/cli.ts`.

Interface: `generateReports(resultsRoot)`.

Implementation: Reads Eval Trial artifacts through `src/eval-trial-artifacts.ts`, parses Eval Trial identity, matches baseline Scenario Variant results, computes displayed Eval Score deltas from persisted Eval Scores, summarizes success and failure counts, and writes JSON plus Markdown reports.

Domain rules owned: report artifact shape, baseline Scenario Variant comparison, Eval Trial identity display, Eval Score delta display, deterministic Acceptance Material output display, Evaluator Agent rationale display, usage display, cost display, and preserved worktree display.

Locality: Report formatting and artifact reading stay together rather than leaking into Eval Trial execution or scoring modules.

Leverage: Report tests can exercise baseline delta and rendering behavior from fixture artifacts without rerunning Eval Trials, Acceptance Material, Evaluator Agents, or scoring math.

Depth guidance: Reports consume artifacts through the artifact module. They should not recompute Eval Scores, rerun Acceptance Material, invoke Evaluator Agents, mutate Eval Trial artifacts, or decide lifecycle status.

## Eval Trial Execution Orchestration

Files: `src/eval-trial-execution.ts`, `src/eval-trial-lifecycle.ts`, and `src/post-trial-scoring.ts`, composing `src/eval-trial-worktree.ts` and `src/report.ts`.

Interface: `executeEvalTrials(input)`, `runEvalTrialLifecycle(input)`, `runPostTrialScoring(input)`, and `didPostTrialScoringFail(scoring)`.

Implementation: Creates a results run directory, expands the Trial Matrix, schedules Eval Trials with optional fail-fast, prepares worktrees, snapshots prompts, invokes the coding agent adapter, runs post-trial scoring, computes Eval Score facts, writes stable artifacts, finalizes worktrees, and generates reports.

Domain rules owned: Eval Trial lifecycle ordering, artifact compatibility, fail-fast behavior, success or failure shaping, post-trial scoring timing, report generation timing, and composition of the deep modules above.

Locality: Lifecycle order stays readable here while specialized rules stay in their owning modules.

Leverage: High-level filesystem seam tests can prove the full Eval Trial path without duplicating config, scoring, git, adapter, or hidden Acceptance Material implementation details.

Depth guidance: This module should orchestrate, not absorb. If a change adds pricing math, hidden Acceptance Material copying, Evaluator Agent JSON parsing, provider mapping, report formatting, worktree copying, or git command details here, move it back to the owning module.
