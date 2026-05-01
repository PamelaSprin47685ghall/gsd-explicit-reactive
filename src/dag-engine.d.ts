/**
 * Type definitions for dag-engine.js
 */

export interface DagTaskRecord {
  session: any;
  status: "running" | "completed";
  startedAt: number;
}

export interface DagTaskStatus {
  id: string;
  status: string;
  elapsed: number;
}

export interface DagExecutionResult {
  completed: string[];
  total: number;
}

export interface ContextToolkit {
  milestoneContext: string | null;
  sliceGoal: string;
  taskPlans: Record<string, string>;
  completedDeps: string[];
  db: any;
  depsError?: any;
}

export class DagTaskManager {
  agents: Map<string, DagTaskRecord>;
  
  constructor();
  
  /**
   * Run a single task agent with infinite retry loop.
   * @param taskId - Task identifier (e.g. "T01")
   * @param planContent - Task plan markdown content
   * @param contextToolkit - Context for task agent prompt
   * @param pi - pi harness instance
   * @param createAgentSessionFn - createAgentSession from pi-coding-agent
   */
  runTask(
    taskId: string,
    planContent: string,
    contextToolkit: ContextToolkit,
    pi: any,
    createAgentSessionFn: Function
  ): Promise<void>;
  
  getStatus(): DagTaskStatus[];
}

/**
 * Main DAG execution loop.
 * @param deps - Validated DEPS object
 * @param allTasks - All tasks in the slice
 * @param contextToolkit - Context for task agents
 * @param pi - pi harness instance
 * @param db - GSD DB facade
 * @param widget - Optional dag-status widget instance
 * @param createAgentSessionFn - createAgentSession from pi-coding-agent
 */
export function dagExecutionLoop(
  deps: any,
  allTasks: any[],
  contextToolkit: ContextToolkit,
  pi: any,
  db: any,
  widget?: any,
  createAgentSessionFn?: Function
): Promise<DagExecutionResult>;
