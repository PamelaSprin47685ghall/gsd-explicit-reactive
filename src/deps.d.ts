/**
 * Type definitions for deps.js
 */

export interface DepsSpec {
  version: number;
  tasks: Record<string, { depends_on: string[] }>;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

export interface DepsError {
  errors: string[];
  invalidDeps: any;
  attemptedAt: string;
}

export interface DagMetrics {
  totalTasks: number;
  criticalPathLength: number;
  averageWidth: number;
}

/**
 * Load DEPS-ERROR.json for a slice, returning null when absent.
 */
export function loadDepsError(basePath: string, mid: string, sid: string): DepsError | null;

/**
 * Validate DEPS.json structure and semantics.
 */
export function validateExplicitDeps(deps: DepsSpec, sliceTasks: any[]): ValidationResult;

/**
 * Compute the set of ready-to-execute tasks given DEPS and current statuses.
 */
export function computeReadySet(deps: DepsSpec, allTasks: any[]): string[];

/**
 * Calculate average concurrency width of a DAG.
 * W_avg = N / L where N = total tasks, L = critical path length.
 */
export function calculateDagMetrics(deps: DepsSpec): DagMetrics;

/**
 * Persist the latest DEPS validation error to DEPS-ERROR.json.
 */
export function persistLatestError(
  basePath: string,
  mid: string,
  sid: string,
  errors: string | string[],
  invalidDeps: any,
  ctx?: any
): void;

/**
 * Clear DEPS-ERROR.json after successful validation.
 */
export function clearLatestError(
  basePath: string,
  mid: string,
  sid: string,
  ctx?: any
): void;

/**
 * Load DEPS.json, parse it, and validate.
 */
export function loadAndValidateDeps(
  basePath: string,
  mid: string,
  sid: string,
  sliceTasks: any[]
): {
  deps: DepsSpec | null;
  error: string | null;
  errors: string[] | null;
};
