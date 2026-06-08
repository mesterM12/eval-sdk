export type MatrixItem = { id: string };

export type EvalTrial = {
  id: string;
  agentId: string;
  taskId: string;
  scenarioVariantId: string;
  runIndex: number;
};

export type MatrixSelector = {
  agent: string;
  task: string;
  scenarioVariant: string;
  runIndex: number;
};

export type TrialMatrixInput = {
  agents: MatrixItem[];
  tasks: MatrixItem[];
  scenarioVariants: MatrixItem[];
  runIndexes?: number[];
  include?: MatrixSelector[];
  exclude?: MatrixSelector[];
  matrix?: {
    runIndexes: number[];
    include?: MatrixSelector[];
    exclude?: MatrixSelector[];
  };
};

export function expandTrialMatrix(input: TrialMatrixInput): EvalTrial[] {
  const evalTrialsById = new Map<string, EvalTrial>();
  const runIndexes = input.matrix?.runIndexes ?? input.runIndexes ?? [];
  const exclude = input.matrix?.exclude ?? input.exclude ?? [];
  const include = input.matrix?.include ?? input.include ?? [];
  for (const agent of input.agents) {
    for (const task of input.tasks) {
      for (const scenarioVariant of input.scenarioVariants) {
        for (const runIndex of runIndexes) {
          addEvalTrial(evalTrialsById, agent.id, task.id, scenarioVariant.id, runIndex);
        }
      }
    }
  }

  for (const selector of exclude) {
    evalTrialsById.delete(evalTrialId(selector.agent, selector.task, selector.scenarioVariant, selector.runIndex));
  }
  for (const selector of include) {
    addEvalTrial(evalTrialsById, selector.agent, selector.task, selector.scenarioVariant, selector.runIndex);
  }

  return [...evalTrialsById.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function addEvalTrial(evalTrialsById: Map<string, EvalTrial>, agentId: string, taskId: string, scenarioVariantId: string, runIndex: number) {
  const id = evalTrialId(agentId, taskId, scenarioVariantId, runIndex);
  evalTrialsById.set(id, { id, agentId, taskId, scenarioVariantId, runIndex });
}

function evalTrialId(agentId: string, taskId: string, scenarioVariantId: string, runIndex: number) {
  return `${agentId}__${taskId}__${scenarioVariantId}__${runIndex}`;
}
