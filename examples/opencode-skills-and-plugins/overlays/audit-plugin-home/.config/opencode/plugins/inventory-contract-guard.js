export const InventoryContractGuard = async () => {
  const contract = `inventory-contract: implement quoted CSV parsing, CRLF support, comment/blank-line skipping, exact header validation, five fields per row, non-negative integer quantity and priceCents validation, doubled quote unescaping, pipe-split trimmed tags, and TypeError for invalid input including empty strings.`;

  function sourceFrom(args) {
    if (!args || typeof args !== "object") return "";
    return String(args.content ?? args.newString ?? "");
  }

  function targetsInventory(args) {
    if (!args || typeof args !== "object") return false;
    return String(args.filePath ?? args.path ?? "").endsWith("src/inventory.js");
  }

  function looksComplete(source) {
    return [
      "inQuotes",
      "priceCents",
      "quantity",
      "Number.isInteger",
      "throw new TypeError",
      "startsWith(\"#\")",
      "replace(/\"\"/g",
      "tags",
    ].every((needle) => source.includes(needle)) && !source.includes("throw new Error");
  }

  return {
    "tool.execute.before": async (input, output) => {
      if (!["edit", "write"].includes(input.tool)) return;
      if (!targetsInventory(output.args)) return;
      const source = sourceFrom(output.args);
      if (!looksComplete(source)) {
        throw new Error(contract);
      }
    },
  };
};
