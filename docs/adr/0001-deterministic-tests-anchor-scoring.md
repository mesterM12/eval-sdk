# Deterministic Tests Anchor Scoring

Eval scores combine deterministic acceptance-test results with evaluator-agent rubric scores, but objective correctness is anchored by deterministic tests. Evaluator agents judge qualitative acceptance material and explain rationale; they do not override executable acceptance failures. This keeps eval trials reproducible while still allowing maintainability, style, and standards docs to contribute to final scoring through explicit weights.
