# Scenario Variant: Audit Plugin

The `inventory-contract-guard` OpenCode plugin is installed in the agent home overlay. It validates edits to `src/inventory.js` and will block incomplete implementations with contract feedback.

If a write or edit is rejected, use the plugin feedback to complete the parser contract.

Before finishing, run a small validation self-check that confirms invalid inputs throw `TypeError`, including an empty string and malformed rows.
