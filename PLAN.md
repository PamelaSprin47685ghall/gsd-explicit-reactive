# 方案：显式依赖 DAG 适配层

## 0. 序：本方案的立场

这是一个*适配层*，不是一个独立运行平台。

核心目标是把 GSD slice 内 Task 的并行关系从隐式 IO 推导替换为**显式、可审计、可修复的依赖声明**。执行运行时仍借道 GSD dispatch 生命周期的接缝，但不用官方 `reactive-execute`，不用官方 `execute-task`，不依赖 `pi-subagents`。

本方案只写 GSD dispatch 规则、验证依赖文件、管理 task agent 生命周期。不写完整 AgentSession 平台，不写 Dashboard 引擎，不写自定义 agent 类型系统。

---

## 1. 审计：当前项目 vs gsd-2 契合度

### 1.1 gsd-explicit-reactive（当前）

| 模块 | 职责 | 状态 |
|---|---|---|
| `index.js` | pi 插件入口，注册 `session_start` hook + `/wave-size` 命令 | 需重写 |
| `src/discovery.js` | 动态发现并加载 GSD 核心模块 | 可保留，微调 |
| `src/engine.js` | 核心：拦截 DISPATCH_RULES，注入 WAVES 波次引擎 | 需整体替换 |

**当前架构核心问题：**
- **波次模型（Wave）过于扁平**：同一波次内任务无依赖顺序，靠手动声明
- **WAVES.json 人工编排**：需要人手动指定 T01→wave1, T02→wave1，无法表达细粒度依赖
- **硬编码并发上限**：假设用户需要限流，约束过长
- **直接禁用官方 reactive-execute**：无 fallback，插件失败等于 GSD 执行全面停摆

### 1.2 gsd-2（平台层）

| 模块 | 职责 | 对本方案的价值 |
|---|---|---|
| `reactive-graph.ts` | `getReadyTasks()` / `chooseNonConflictingSubset()` / `detectDeadlock()` / `graphMetrics()` / `saveReactiveState()` | 复用图选择 |
| `uok/execution-graph.ts` | `selectReactiveDispatchBatch()` / `ExecutionGraphScheduler` / `detectFileConflicts()` | 批量选择复用 |
| `auto-dispatch.ts` | DISPATCH_RULES 声明式调度表 | 在其机制内注册 dag-execution 规则 |
| `auto-prompts.ts` | `buildReactiveExecutePrompt()` | 本方案自行构造 task prompt |
| `auto-dashboard.ts` | `updateProgressWidget()` | 不覆盖 |

### 1.3 pi-subagents（参考架构）

`/tmp/pi-subagents` 已实现了许多能力，本方案不复制其源码，只参考其模式：

| 能力 | pi-subagents 实现 | 本方案参考方式 |
|---|---|---|
| 后台 agent 生命周期 | AgentManager（queued/running/completed/error） | 自含 DagTaskManager, 复用状态语义 |
| 中止 | AbortController → session.abort() | 直接使用 session.abort() |
| steer | session.steer() | 本方案不用 steer 做重试，改用 session.prompt() |
| Tool 活动事件 | tool_execution_start/end → activity tracker | 直接订阅 |
| Widget | 独立 `agents` widget | 独立 `dag-status` widget |
| 跨扩展 RPC | `subagents:rpc:ping/spawn/stop` | 不依赖 |
| 任务队列 | 超额排队，并发受限 | 本方案不限并发，全量 spawn |

---

## 2. 与旧方案的核心差异

旧方案（2025-04-30）将插件定位为"自建并行执行平台"，包含自建的 `DagTaskWorker`、monkey-patch dashboard、无上限并发、自含 topological sort。修订后收敛为适配层：

| 维度 | 旧方案 | 修订方案 |
|---|---|---|
| 主会话挂起 | dispatch prompt 后等后台跑完 | `_wait_for_dag_completion` 内部工具合法挂起 |
| 重试机制 | 失败后 steer() | `while(true)` 循环内 session.prompt() |
| DAG 宽度为 1 | dagExecutionLoop 内调用 pi.requestReplan | dispatch rule match 中拦截，写入 DEPS-ERROR.json 回退 |
| 上游 dashboard | monkey-patch updateProgressWidget | 不覆盖，独立 dag-status widget |
| 依赖冲突过滤 | 引用 selectReactiveDispatchBatch | 完全忽略，只以 DEPS.json 为准 |

---

## 3. 决策清单

| 领域 | 决策 |
|---|---|
| 命令 | 无 `/wave-size`，无 `/dag-size`，无任何用户命令 |
| 并发限制 | 不做硬性上限，不做持久化配置。并发受 LLM API rate limit 和 Node.js 内存运行时限制。不主动限流。 |
| 依赖格式 | 只认 `DEPS.json`。废弃 `WAVES.json`。不做兼容迁移。 |
| 串行策略 | 禁用官方 `reactive-execute`。禁用官方 `execute-task`。DAG 自然宽度为 1 时：第一次 prompt 反对要求重规，重试后仍然宽度为 1 则放行。 |
| IO 冲突 | 完全忽略 `inputFiles` / `outputFiles`。只以 LLM 显式声明的 `DEPS.json` 依赖为准。不拒绝写同文件的 ready task。 |
| DEPS 错误上下文 | 最新一次完整错误 JSON + 错误文本。下一轮规划 prompt 注入。"最新"指最近一次验证结果，不是累积历史。 |
| DEPS 无效失败策略 | 无限重试规划。不 hard stop。不回滚。不串行。LLM 必须看到自己犯过的错误，直到产出合法 DEPS.json。 |
| 执行接管 | 插件注册 `dag-execution` dispatch unit。通过内部工具 `_wait_for_dag_completion` 合法挂起主会话，并在后台并行执行 task agents。 |
| Task agent 上下文 | 不继承主会话完整聊天历史。注入：Milestone CONTEXT 摘要、slice 整体目标、task plan 全文、上游已完成 task 的依赖摘要、执行硬约束。 |
| 执行硬约束注入 | 禁止串行 fallback；必须调用 `gsd_task_complete`；未完成时不准退出（追问）。只以 DEPS.json 显式依赖为准。不依赖 IO 冲突过滤。 |
| 失败任务策略 | 失败 task 无限 retry，不兜底。下游依赖它的 task 不启动。已成功 task 保持完成。 |
| Task 退出策略 | 如果 agent turn 结束但未调用 `gsd_task_complete`，对其再次 `prompt()` 要求继续。不允许提前退出。 |
| 工具权限 | 全工具继承，包括 subagent（用户自由使用）。 |
| 运行时基底 | 不依赖 `pi-subagents` 包。不复制其内部代码。只参考其架构语义：后台 agent 生命周期、状态聚合、tool activity 事件、伴随 widget。 |
| GSD 接入方式 | 自定义 dispatch unit `dag-execution`，主会话调用等待工具挂起，后台并行跑 task。 |
| 文档更新顺序 | 写出最终代码后更新 方案.md 以外文档（README 等）。 |

---

## 3.1 实施后决策记录

### D001: 输出可见性策略
- **决策时间**: 2026-05-02
- **决策**: 所有后台 task session 的输出转发到主会话对话，允许交错显示
- **理由**: 
  - 用户需要实时看到每个 task 在做什么
  - Widget 只显示状态摘要，不显示详细工作内容
  - 主会话挂起期间聊天区域不应该是空白的
- **实现**:
  - 订阅每个 task session 的 `assistant_message` 事件
  - 将消息内容转发到主会话的 `onUpdate` 回调
  - 消息前缀标注 task ID，如 `[T02] Editing src/auth.ts...`
  - 允许多个 task 的输出交错显示
- **状态**: ✅ 已实现（2026-05-02）

### D002: 包导入策略
- **决策时间**: 2026-05-02
- **决策**: 直接使用 `pi.createAgentSession`，不动态导入 `@gsd/pi-coding-agent`
- **理由**: 
  - `@gsd/pi-coding-agent` 不是独立 npm 包，导入会失败
  - pi 插件 API 已提供 `createAgentSession` 工厂函数
  - 简化依赖，避免版本冲突
- **状态**: ✅ 已实现（2026-05-02）

### D003: 并发执行策略
- **决策时间**: 2026-05-02
- **决策**: 不依赖 `ctx.state.activeTask`，查询所有 ready tasks 并行执行
- **理由**: 
  - `activeTask` 是 GSD 状态机推导的单个 task，用于串行执行
  - 并行执行需要查询所有满足依赖的 ready tasks
  - unitId 格式改为 `M001/S01/dag+T01,T02,T03` 表示批量执行
- **状态**: ✅ 已实现（2026-05-02）

### D004: 状态同步策略
- **决策时间**: 2026-05-02
- **决策**: dispatch 前将所有 ready tasks 标记为 `in_progress`
- **理由**: 
  - GSD 状态机需要知道这些 tasks 正在后台执行
  - 避免状态机重复 dispatch 同一个 task
  - 防止无限循环
- **状态**: ✅ 已实现（2026-05-02）

---

## 4. 架构总览

```
index.js                  ← 插件入口。注册 session_start hook。无命令。
src/
  discovery.js            ← 动态加载 GSD 核心模块
  deps.js                 ← DEPS schema 验证 + 环检测 + 错误诊断 + 最新错误持久化
  dag-engine.js           ← DAG 调度核心：ready set + task agent 管理 + 状态聚合
  engine.js               ← dispatch rule 注册 (dag-execution) + 拦截宽度为 1
  widget.js               ← 伴随 widget（不覆盖 gsd-progress）
```

### 4.1 执行流程

```
PLAN 阶段
  │
  ├── AI 写 S##-PLAN.md
  ├── AI 写 DEPS.json
  │
  ├── compliance check（deps.js 验证）
  │
  └── EXECUTE 阶段
        │
        ├── dispatch rule 匹配 executing phase
        │     ├── 若 DEPS 无效 → 写入 DEPS-ERROR.json，退回 replan-slice
        │     ├── 若 DEPS 有效但 ready.length === 1 且是首次：
        │     │     → 写入 DEPS-ERROR.json，退回 replan-slice
        │     └── 若通过验证：
        │           → dispatch "dag-execution" unit
        │
        ├── dispatch session 启动（主会话）
        │     ├── 插件动态注入内部工具 `_wait_for_dag_completion`
        │     ├── Prompt: "You MUST call _wait_for_dag_completion immediately."
        │     ├── LLM 调用该工具，主会话合法挂起
        │     └── 工具内部触发后台 DAG 引擎：
        │           ├── 为每个 ready task 创建 AgentSession
        │           ├── 异步 start，订阅 tool_execution_start/end → notify
        │           ├── 任意 task 完成 → 更新 ready set → spawn 新 task
        │           ├── 失败/异常退出的 task → session.prompt() 继续重试
        │           └── 所有 task 完成 → tool resolve → 主会话结束
        │
        └── GSD 检测到 slice 内 task 全部完成
              → 自动推进到 slice completion
```

---

## 5. DEPS.json 格式

路径：`.gsd/milestones/<MID>/slices/<SID>/DEPS.json`

```json
{
  "version": 1,
  "tasks": {
    "T01": { "depends_on": [] },
    "T02": { "depends_on": ["T01"] },
    "T03": { "depends_on": ["T01"] },
    "T04": { "depends_on": ["T02", "T03"] }
  }
}
```

设计约束：

- `version` 必须为 `1`。
- `tasks` 必须覆盖当前 slice 的所有 task。
- `depends_on` 只能引用当前 slice 内 task。
- 不能有环。
- 不检查 `inputFiles` / `outputFiles`。执行以显式依赖为准。

---

## 6. DEPS 验证器

### 6.1 核心校验

```js
function validateExplicitDeps(deps, sliceTasks) {
  const errors = [];
  const taskIds = new Set(sliceTasks.map(t => t.id));
  const declaredIds = new Set(Object.keys(deps.tasks ?? {}));

  if (deps.version !== 1) errors.push(`Unsupported DEPS version: ${deps.version}`);

  for (const id of taskIds) {
    if (!declaredIds.has(id)) errors.push(`Missing: ${id}`);
  }

  for (const [id, spec] of Object.entries(deps.tasks ?? {})) {
    if (!taskIds.has(id)) { errors.push(`Unknown: ${id}`); continue; }
    if (!Array.isArray(spec.depends_on)) {
      errors.push(`Task ${id}: depends_on is not array`);
      continue;
    }
    for (const dep of spec.depends_on) {
      if (!declaredIds.has(dep)) errors.push(`${id} -> unknown ${dep}`);
      if (dep === id) errors.push(`${id} -> self`);
    }
  }

  const cycle = findCycle(deps.tasks ?? {});
  if (cycle.length > 0) errors.push(`Cycle: ${cycle.join(" -> ")}`);

  return { ok: errors.length === 0, errors };
}
```

环检测（DFS）：

```js
function findCycle(tasks) {
  const visited = {};
  let path = [];

  function dfs(id) {
    if (visited[id] === 'done') return false;
    if (visited[id] === 'visiting') { path.push(id); return true; }
    visited[id] = 'visiting';
    path.push(id);
    for (const dep of tasks[id]?.depends_on ?? []) {
      if (dfs(dep)) return true;
    }
    visited[id] = 'done';
    path.pop();
    return false;
  }

  for (const id of Object.keys(tasks)) {
    path = [];
    if (dfs(id)) return path;
  }
  return [];
}
```

### 6.2 最新错误持久化

```json
// .gsd/milestones/<MID>/slices/<SID>/DEPS-ERROR.json
{
  "errors": [
    "Missing: T03",
    "DAG natural width is 1. Please restructure dependencies."
  ],
  "invalidDeps": { /* 提交的 DEPS 全文 */ },
  "attemptedAt": "2026-05-01T14:30:00.000Z"
}
```

- 每次验证失败时覆盖写入。
- 规划 prompt 注入时附带完整 `DEPS-ERROR.json` 内容 + 错误摘要文本。
- 验证通过后删除 `DEPS-ERROR.json`。

---

## 7. DAG 调度器

### 7.1 Ready set 计算

```js
function computeReadySet(deps, allTasks) {
  const statuses = new Map(allTasks.map(t => [t.id, t.status]));
  const doneStatuses = new Set(["complete", "done", "skipped"]);

  return Object.entries(deps.tasks)
    .filter(([id, spec]) => {
      const s = String(statuses.get(id) ?? "pending").toLowerCase();
      if (doneStatuses.has(s)) return false;
      return spec.depends_on.every(d => {
        const ds = String(statuses.get(d) ?? "complete").toLowerCase();
        return doneStatuses.has(ds);
      });
    })
    .map(([id]) => id);
}
```

### 7.2 调度与重试管理

```js
class DagTaskManager {
  constructor() {
    this.agents = new Map(); // taskId → { session, status, promise }
  }

  // 核心方法：运行一个 task agent，包含内部无限重试循环
  async runTask(taskId, planContent, contextToolkit, pi) {
    const { session } = await createAgentSession({
      cwd: pi.cwd,
      tools: pi.tools, // 全工具继承，包括 subagent
    });

    const record = { session, status: "running", startedAt: Date.now() };
    this.agents.set(taskId, record);

    session.subscribe(event => {
      if (event.type === "tool_execution_start") {
        pi.notifyTaskActivity?.(taskId, event.toolName, event.args);
      }
    });

    let currentPrompt = buildTaskPrompt(taskId, planContent, contextToolkit);

    while (true) {
      try {
        await session.prompt(currentPrompt);

        if (isTaskCompleteInDb(taskId)) {
          record.status = "completed";
          return;
        }

        currentPrompt =
          "You exited without calling `gsd_task_complete`. " +
          "You MUST finish the task and call the tool.";
      } catch (err) {
        currentPrompt =
          `Previous attempt failed with error: ${err.message}. ` +
          `Please try another approach. Do not give up.`;
      }
    }
  }
}
```

---

## 8. Dispatch 规则注册

### 8.1 executing → dag-execution

```js
{
  name: "executing → dag-execution",
  match: async (ctx) => {
    if (ctx.state.phase !== "executing" || !ctx.state.activeTask || !ctx.state.activeSlice)
      return null;

    const { deps, error } = await loadAndValidateDeps(ctx);

    // DEPS 无效 → 回退规划
    if (error) {
      await persistLatestError(ctx, error, deps);
      return backToPlanWithError(ctx);
    }

    // DAG 宽度为 1（首次）→ 反对，回退规划
    const ready = computeReadySet(deps, getAllTasks(ctx));
    if (ready.length === 1 && !hasWarnedWidth1(ctx)) {
      setWarnedWidth1(ctx);
      await persistLatestError(
        ctx,
        "DAG natural width is 1. Please restructure dependencies to allow parallel execution if possible.",
        deps
      );
      return backToPlanWithError(ctx);
    }

    clearLatestError(ctx);

    return {
      action: "dispatch",
      unitType: "dag-execution",
      unitId: `${ctx.mid}/${ctx.state.activeSlice.id}/dag`,
      prompt:
        "You are the DAG Execution Coordinator.\n" +
        "You MUST immediately call the `_wait_for_dag_completion` tool.\n" +
        "Do not output any other text.\n" +
        "The tool will block until all parallel background tasks finish."
    };
  }
}
```

### 8.2 主会话挂起工具

在 `session_start` hook 中，识别 `dag-execution` unit 后注入等待工具：

```js
pi.on("session_start", async (event, ctx) => {
  if (ctx.unitType !== "dag-execution") return;

  ctx.session.registerCustomTool({
    name: "_wait_for_dag_completion",
    description: "Blocks until all DAG tasks complete.",
    execute: async () => {
      await dagExecutionLoop(deps, allTasks, contextToolkit, pi);
      return "All DAG tasks completed successfully.";
    }
  });
});
```

GSD 的 Tool Execution 状态会合法挂起主会话，直到工具 resolve。这避免了 `dag-execution` 被反复派发的问题，也完全不碰官方 reactive-execute path。

### 8.3 禁用官方规则

```js
const re = rules.find(r => r.name.includes("reactive-execute"));
if (re) re.match = async () => null;

const et = rules.find(r => r.name.includes("execute-task"));
if (et) et.match = async () => null;
```

### 8.4 subagent 禁用已移除

插件不再全局禁用 subagent。task agent 继承全工具列表，用户可以自由决定是否使用 subagent。

在 `session_start` hook 中，task agent 会话的可用工具只过滤内部工具 `_wait_for_dag_completion`，subagent 保留在工具列表中供自由使用。

---

## 9. Task agent prompt 结构

```markdown
# Execute task {T##}

## Milestone context
{注入 milestone CONTEXT 摘要或"无 milestone context 文件"}

## Slice goal
{注入 slice 整体目标、成功标准、边界}

## Task plan
{注入 T##-PLAN.md 全文}

## Completed dependencies
{上游已完成 task 的摘要，只读}

## Error / Retry context
{如果 DEPS 曾验证失败，注入最新 DEPS-ERROR.json}
{如果该 agent 在重试，while 循环自动注入重试提示}

## Execution rules (MANDATORY — follow exactly)
- This task runs in parallel with other tasks. Do NOT depend on other running tasks.
- You MUST call the `gsd_task_complete` tool after finishing this task.
- You MUST NOT exit without calling `gsd_task_complete`.
- Use subagent at your discretion as needed.
- Do NOT rely on file IO conflict analysis. Dependencies are explicitly declared in DEPS.json.
- If you need to read/write files, just do it. Finish the task and call gsd_task_complete.
```

---

## 10. 伴随 Widget

- 不覆盖 GSD 官方 `gsd-progress` widget。
- 独立的 widget key `dag-status`。
- 只显示 DAG 执行时的状态，DAG 不活跃时不显示。

渲染示例：

```
DAG: S01 ready 3 tasks ──────
▶ T02 (editing src/auth.ts)  [5.2s]
▶ T03 (running npm test)     [3.1s]
⏳ T04 waiting for [T02,T03]
✅ T01 done                  [12.3s]
────────────────────────────
1/4 done · 2 running · 1 ready
```

---

## 11. 状态推进与失败处理

| 场景 | 处理方式 |
|---|---|
| Agent 成功完成 | 调用 `gsd_task_complete` → DB 标记完成 → `isTaskCompleteInDb()` 返回 true → while 循环退出 |
| Agent 未报错但未调用 complete | `isTaskCompleteInDb()` 检查失败 → `session.prompt("You MUST call gsd_task_complete")` 继续 |
| Agent 异常崩溃 | catch → `session.prompt("Previous attempt failed: ... Please try another approach.")` 继续 |
| DEPS 无效 | dispatch rule 写入 DEPS-ERROR.json → 退回规划 → 无限重试直到 LLM 产出合法 DEPS |
| DAG 宽度为 1（首次） | dispatch rule 拦截 → 写入 DEPS-ERROR.json → 退回规划 → 重试后仍然为 1 则放行 |

无 hard stop。无兜底失败。无官方 fallback。

---

## 12. 最终目标架构图

```
                           ┌─────────────────────────┐
                           │    GSD auto-loop         │
                           │    dispatch rules         │
                           └────────┬────────────────┘
                                    │ match executing & DEPS valid
                                    ▼
          ┌─────────────────────────────────────────────┐
          │ dispatch "dag-execution" session            │
          │ Prompt: call _wait_for_dag_completion       │
          └────────┬────────────────────────────────────┘
                   │
                   ▼
          ┌─────────────────────────────────────────────┐
          │ _wait_for_dag_completion tool executing...  │
          │ (主会话通过 Tool Execution 状态合法挂起)       │
          └────────┬────────────────────────────────────┘
                   │
         ┌─────────┴─────────┐
         │ DAG Engine 启动    │
         └─────────┬─────────┘
                   │ createAgentSession()
                   ▼
          ┌────────────────────┐
          │ Task Agent 1 (T02) │ ─┐
          ├────────────────────┤  │ while(true) 内部重试
          │ Task Agent 2 (T03) │ ─┤ catch + session.prompt()
          ├────────────────────┤  │ 直到 gsd_task_complete
          │ Task Agent N (...) │ ─┘
          └────────┬───────────┘
                   │ all completed
                   ▼
          ┌─────────────────────────────────────────────┐
          │ _wait_for_dag_completion tool resolves      │
          │ 主会话自然结束                                │
          └────────┬────────────────────────────────────┘
                   │
                   ▼
           GSD 检测到 slice tasks 全部完成
           → 自动推进至 slice completion
```

不依赖官方 `reactive-execute`。
不依赖官方 `execute-task`。
不强制禁用 subagent（用户可自由使用）。
不依赖 `pi-subagents`。
不修改 `../gsd-2`。
不覆盖 `gsd-progress` widget。
