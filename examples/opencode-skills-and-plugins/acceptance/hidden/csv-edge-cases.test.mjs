import assert from "node:assert/strict";
import { parseInventoryCsv } from "../../src/inventory.js";

const csv = [
  "# vendor export generated nightly",
  "sku,name,quantity,priceCents,tags",
  'Q-1,"Heavy, Large Widget",12,2599,"warehouse|oversized"',
  'Q-2,"Quoted ""Deluxe"" Gadget",1,5000,"premium|fragile"',
  "",
  "# comments and blank lines should be ignored",
  'Q-3,"Comma, Pipe | Name",2,750,"mixed | trimmed | tags"',
].join("\r\n");

assert.deepEqual(parseInventoryCsv(csv), [
  { sku: "Q-1", name: "Heavy, Large Widget", quantity: 12, priceCents: 2599, tags: ["warehouse", "oversized"] },
  { sku: "Q-2", name: "Quoted \"Deluxe\" Gadget", quantity: 1, priceCents: 5000, tags: ["premium", "fragile"] },
  { sku: "Q-3", name: "Comma, Pipe | Name", quantity: 2, priceCents: 750, tags: ["mixed", "trimmed", "tags"] },
]);
