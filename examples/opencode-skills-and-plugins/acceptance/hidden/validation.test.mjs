import assert from "node:assert/strict";
import { parseInventoryCsv } from "../../src/inventory.js";

assert.throws(() => parseInventoryCsv(""), TypeError);
assert.throws(() => parseInventoryCsv(null), TypeError);
assert.throws(() => parseInventoryCsv("sku,name,quantity,priceCents,tags\nBAD,Item,-1,100,tag"), TypeError);
assert.throws(() => parseInventoryCsv("sku,name,quantity,priceCents,tags\nBAD,Item,1,10.5,tag"), TypeError);
assert.throws(() => parseInventoryCsv("sku,name,quantity,priceCents,tags\nBAD,Item,NaN,100,tag"), TypeError);
assert.throws(() => parseInventoryCsv("sku,name,quantity\nBAD,Item,1"), TypeError);
assert.throws(() => parseInventoryCsv("sku,name,quantity,priceCents,tags\nBAD,Item,1"), TypeError);
