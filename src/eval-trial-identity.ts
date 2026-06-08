export type EvalTrialIdentity = {
  agentId: string;
  taskId: string;
  scenarioVariantId: string;
  runIndex: number;
};

const delimiter = "__";

export function createEvalTrialId(identity: EvalTrialIdentity) {
  const agentId = encodeArtifactSafePart(identity.agentId, "agentId");
  const taskId = encodeArtifactSafePart(identity.taskId, "taskId");
  const scenarioVariantId = encodeArtifactSafePart(identity.scenarioVariantId, "scenarioVariantId");
  if (!Number.isInteger(identity.runIndex) || identity.runIndex <= 0) {
    throw new Error(`invalid Eval Trial id: runIndex must be a positive integer: ${identity.runIndex}`);
  }
  return [agentId, taskId, scenarioVariantId, String(identity.runIndex)].join(delimiter);
}

export function parseEvalTrialId(evalTrialId: string): EvalTrialIdentity {
  const parts = evalTrialId.split(delimiter);
  if (parts.length > 4) throw new Error(`ambiguous Eval Trial id: ${evalTrialId}`);
  if (parts.length !== 4) throw new Error(`invalid Eval Trial id: ${evalTrialId}`);

  const [agentId, taskId, scenarioVariantId, runIndexText] = parts;
  const runIndex = Number(runIndexText);
  const identity = { agentId, taskId, scenarioVariantId, runIndex };
  createEvalTrialId(identity);
  return identity;
}

function encodeArtifactSafePart(value: string, label: string) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`invalid Eval Trial id: ${label} must be non-empty`);
  if (value.includes(delimiter)) throw new Error(`ambiguous Eval Trial id: ${label} must not contain ${delimiter}`);
  if (value.includes("/") || value.includes("\\") || value === "." || value === "..") {
    throw new Error(`invalid Eval Trial id: ${label} must be artifact-safe`);
  }
  return value;
}
