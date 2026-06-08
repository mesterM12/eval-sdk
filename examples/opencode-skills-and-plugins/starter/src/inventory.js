export function parseInventoryCsv(csv) {
  return csv
    .trim()
    .split("\n")
    .slice(1)
    .map((line) => {
      const [sku, name, quantity, priceCents, tags = ""] = line.split(",");
      return {
        sku,
        name,
        quantity: Number(quantity),
        priceCents: Number(priceCents),
        tags: tags ? tags.split("|") : [],
      };
    });
}
