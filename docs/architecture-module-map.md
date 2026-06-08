# Architecture Module Map

This map helps Ralph loop agents preserve module depth while changing the Coding Agent Eval CLI. Prefer changes that keep domain rules near the module that owns them. Each section names locality and leverage for the module. Do not add a shallow pass-through file when a caller can already use a clear interface directly.

## Eval Suite Config

Files: `src/eval-suite-config.ts`, consumed by `src/cli.ts`, `src/trial-matrix.ts`, and Eval Trial execution modules.

Interface: `loadEvalSuiteConfig(configPath, options)` returns a normalized `EvalSuiteConfig`, suite root, config path, and summary.

Implementation: Parses YAML, validates provider support, path safety, duplicate ids, environment references, scoring weights, Acceptance Material references, Trial Matrix selectors, and pricing references, then normalizes optional values into predictable arrays and defaults.

Domain rules owned: Eval Suite config validity, Docker-only sandbox selection, Sandcastle built-in provider ids, safe relative paths, `env:` references, deterministic and rubric weight sum, and references from Trial Matrix selectors to agents, tasks, Scenario Variants, and run indexes.

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

## Acceptance Material Sandbox

Files: `src/acceptance-material-sandbox.ts`, composed by `src/post-trial-scoring.ts`.

Interface: `runAcceptanceMaterialSandbox(input)`, `collectAcceptanceSecretValues(checks, evaluatorAgent, agent)`, and `redactText(text, secretValues)`.

Implementation: Copies completed work into a scoring root, injects hidden Acceptance Material only there, runs deterministic checks with safe cwd handling and timeouts, collects non-hidden artifacts, redacts secret values, and cleans up the scoring root.

Domain rules owned: Hidden Acceptance Material timing, scoring sandbox containment, deterministic check execution, artifact collection that excludes hidden files, secret redaction, and cleanup after scoring.

Locality: Hiddenness and redaction rules stay together instead of being spread across Eval Trial execution, Evaluator Agent handling, and artifact writing.

Leverage: Filesystem seam tests can prove hidden Acceptance Material is absent during Eval Trial execution and present only for post-trial scoring.

Depth guidance: Preserve `docs/adr/0002-hidden-acceptance-runs-in-post-trial-scoring-sandbox.md`. Do not add hidden Acceptance Material paths to Eval Trial worktrees, prompt snapshots, logs, or trial artifacts.

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

Implementation: Maps configured coding agent provider and model to Sandcastle built-ins, mounts the prepared agent home, runs in Docker with head branch strategy, reads logs, collects commits, captures provider metadata, preserves iteration usage, and asks git work for the diff.

Domain rules owned: Coding agent provider mapping, Docker mount shape for agent runtime config, Sandcastle logging, branch strategy, result normalization, and handoff to git work for changed work.

Locality: Sandcastle details stay behind the adapter interface instead of leaking into Eval Trial lifecycle code.

Leverage: Fixture-based adapter tests can verify provider mapping, Docker options, logs, commits, diff, and usage metadata without executing a real coding agent.

Depth guidance: Do not add custom command adapters or non-Docker sandbox execution here. One adapter is a hypothetical seam; add another only when product scope requires it.

## Git Work

Files: `src/git-work.ts`, used by `src/coding-agent-adapter.ts` and `src/eval-trial-lifecycle.ts`.

Interface: `ensureGitWorkBaseline({ repoPath })` and `collectGitWorkDiff({ repoPath, baseSha })`.

Implementation: Initializes git when needed, configures local commit identity, creates an initial Eval Trial baseline commit when no HEAD exists, returns the baseline sha, and combines committed plus uncommitted diffs after coding agent execution.

Domain rules owned: Eval Trial baseline creation, local git identity for reproducible commits, and changed work collection.

Locality: Git commands and diff assumptions stay separate from Sandcastle execution and artifact writing.

Leverage: Temporary repo tests can verify baseline and diff behavior with no coding agent, Acceptance Material, or report generation.

Depth guidance: Keep git work focused. Remote starter sources, host-only scoring, retries, and storage changes are future scope, not part of this module.

## Eval Trial Execution Orchestration

Files: `src/eval-trial-execution.ts`, `src/eval-trial-lifecycle.ts`, and `src/post-trial-scoring.ts`.

Interface: `executeEvalTrials(input)`, `runEvalTrialLifecycle(input)`, `runPostTrialScoring(input)`, and `didPostTrialScoringFail(scoring)`.

Implementation: Creates a results run directory, expands the Trial Matrix, schedules Eval Trials with optional fail-fast, prepares worktrees, snapshots prompts, invokes the coding agent adapter, runs post-trial scoring, computes Eval Score facts, writes stable artifacts, finalizes worktrees, and generates reports.

Domain rules owned: Eval Trial lifecycle ordering, artifact compatibility, fail-fast behavior, success or failure shaping, report generation timing, and composition of the deep modules above.

Locality: Lifecycle order stays readable here while specialized rules stay in their owning modules.

Leverage: High-level filesystem seam tests can prove the full Eval Trial path without duplicating config, scoring, git, adapter, or hidden Acceptance Material implementation details.

Depth guidance: This module should orchestrate, not absorb. If a change adds pricing math, hidden Acceptance Material copying, Evaluator Agent JSON parsing, provider mapping, or git command details here, move it back to the owning module.
