---
name: inventory-contract
description: Implement the inventory CSV parser contract with quoted-field parsing and strict validation.
license: MIT
compatibility: opencode
metadata:
  domain: inventory-imports
---

## Inventory Parser Contract

Implement `parseInventoryCsv(csv)` in `src/inventory.js` according to this contract:

- Input must be a non-empty string with a non-comment header row; otherwise throw `TypeError`.
- Ignore blank lines and lines whose first non-space character is `#`, except when `#` is inside a quoted CSV field.
- Support LF and CRLF line endings.
- First non-comment row must be the exact header `sku,name,quantity,priceCents,tags`; otherwise throw `TypeError`.
- Parse CSV with quoted fields. Quoted fields may contain commas, pipes, and doubled quotes like `""`.
- Each data row must have exactly five fields.
- Return records shaped `{ sku, name, quantity, priceCents, tags }`.
- Trim `sku`, `name`, numeric fields, and each tag after parsing.
- `quantity` and `priceCents` must be non-negative integers; otherwise throw `TypeError`.
- `tags` is pipe-separated after CSV parsing. Empty tag fields become `[]`.

## Must-Pass Validation Self-Checks

Before finishing, manually verify these throw `TypeError`:

- `parseInventoryCsv("")`
- `parseInventoryCsv(null)`
- `parseInventoryCsv("sku,name,quantity,priceCents,tags\nBAD,Item,-1,100,tag")`
- `parseInventoryCsv("sku,name,quantity,priceCents,tags\nBAD,Item,1,10.5,tag")`
- `parseInventoryCsv("sku,name,quantity\nBAD,Item,1")`
- `parseInventoryCsv("sku,name,quantity,priceCents,tags\nBAD,Item,1")`

Prefer a small state-machine parser inside `src/inventory.js`. Do not add dependencies.
