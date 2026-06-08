# Scenario Variant: Test Skill

Use the `inventory-contract` OpenCode skill installed in the agent home overlay before editing. Load it through the `skill` tool and implement the contract it describes.

Before finishing, run a small validation self-check that confirms invalid inputs throw `TypeError`, including an empty string and malformed rows.

The expected difference from baseline is better handling of quoted CSV fields, comments, and validation behavior.
