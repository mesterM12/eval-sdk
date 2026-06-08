import assert from "node:assert/strict";
import { parseInventoryCsv } from "../src/inventory.js";

const csv = `sku,name,quantity,priceCents,tags
ABC-1,Widget,4,1299,hardware|sale
XYZ-2,Gadget,0,999,clearance`;

assert.deepEqual(parseInventoryCsv(csv), [
  { sku: "ABC-1", name: "Widget", quantity: 4, priceCents: 1299, tags: ["hardware", "sale"] },
  { sku: "XYZ-2", name: "Gadget", quantity: 0, priceCents: 999, tags: ["clearance"] },
]);
