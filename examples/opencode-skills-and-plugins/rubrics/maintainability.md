# Inventory Parser Maintainability Rubric

Score from 1 to 5.

- 5: Robust CSV state machine or equivalent parser, clear row validation, readable conversion into inventory records, and no broad rewrites.
- 3: Correct behavior but parser and validation are somewhat tangled or hard to audit.
- 1: Fragile split-based parsing, hidden assumptions, broad rewrites, or behavior that is hard to audit.
