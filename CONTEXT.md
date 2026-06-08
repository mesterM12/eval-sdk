# Coding Agent Eval CLI

Tooling for comparing coding agents against repeatable software tasks under controlled scenario variants.

## Language

**Eval Trial**:
One isolated attempt by one agent on one task under one scenario variant and run index. Each trial starts from the same starter files in a fresh git worktree; hidden acceptance materials are unavailable until scoring.
_Avoid_: Run, attempt, job

**Trial Matrix**:
The expanded set of eval trials produced from agents, tasks, scenario variants, and run indexes, with optional include and exclude overrides.
_Avoid_: Run matrix, job list

**Scenario Variant**:
A controlled variation applied before an eval trial. It may change visible starter files and agent runtime configuration such as skills, plugins, MCP servers, or permission rules; it never includes hidden acceptance materials.
_Avoid_: Mode, setup, environment

**Acceptance Material**:
Criteria used to judge an eval trial, either as hidden executable tests or rubric docs. Hidden acceptance material is unavailable to the coding agent during the eval trial.
_Avoid_: Acceptance criteria, grading files

**Evaluator Agent**:
An agent used after an eval trial to judge qualitative acceptance material and explain scoring rationale. It does not replace deterministic acceptance tests.
_Avoid_: Judge, grader, reviewer

**Eval Score**:
The final weighted result for an eval trial, combining deterministic acceptance results with evaluator-agent rubric scores.
_Avoid_: Grade, rating
