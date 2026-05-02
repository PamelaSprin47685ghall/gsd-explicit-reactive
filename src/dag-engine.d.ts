/**
 * Type definitions for dag-engine.js
 */

export interface DagTaskRecord {
  session: any;
  status: "starting" | "running" | "completed" | "aborted";
  startedAt: number;
  endedAt?: number;
  unsubscribes: Array<() => void>;
  tool?: string;
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
  mid: string;
  sid: string;
  basePath: string;
  milestoneContext: string | null;
  sliceGoal: string;
  taskPlans: Record<string, string>;
  dynamicCompletedDeps?: string;
  db: any;
}

export class DagTaskManager {
  agents: Map<string, DagTaskRecord>;
  failedTasks: Set<string>;
  abortControllers: Map<string, AbortController>;
  
  constructor();
  
  /**
   * Run a single task agent with infinite retry loop.
   */
  runTask(
    taskId: string,
    planContent: string,
    contextToolkit: ContextToolkit,
    createAgentSessionFn: Function,
    abortSignal?: AbortSignal,
    onUpdate?: (chunk: { type: string; text: string }) => void,
    ctx?: any
  ): Promise<void>;
  
  abortAll(): void;
  getStatus(): DagTaskStatus[];
}

/**
 * Main DAG execution loop.
 * @param deps - Validated DEPS object
 * @param allTasks - All tasks in the slice
 * @param contextToolkit - Context for task agents
 * @param db - GSD DB facade
 * @param widget - Optional dag-status widget instance
 * @param createAgentSessionFn - createAgentSession from pi-coding-agent
 * @param abortSignal - Signal to abort the entire DAG execution
 * @param onUpdate - Streaming callback for forwarded task output
 * @param ctx - ExtensionContext for ui.notify
 * @param dagTaskManagers - Map of sessionId -> DagTaskManager
 */
export function dagExecutionLoop(
  deps: any,
  allTasks: any[],
  contextToolkit: ContextToolkit,
  db: any,
  widget: any,
  createAgentSessionFn: Function,
  abortSignal?: AbortSignal,
  onUpdate?: (chunk: { type: string; text: string }) => void,
  ctx?: any,
  dagTaskManagers?: Map<string, DagTaskManager>
): Promise<DagExecutionResult>;
