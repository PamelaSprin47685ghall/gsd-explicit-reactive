# 方案：显式依赖 DAG 适配层

## 0. 序

这是一个*适配层*，不是一个独立运行平台。

核心目标是把 GSD slice 内 Task 的并行关系从隐式 IO 推导替换为**显式、可审计、可修复的依赖声明**（DEPS.json）。执行借道 GSD 原生 `reactive-execute` unitType 的生命周期接缝，不修改 gsd-2 源码。禁用官方 `execute-task` 和 `reactive-execute` 规则。

---

## 1. 模块清单

| 文件 | 职责 |
|---|---|
| `index.js` | 插件入口。注册 `session_start` / `session_shutdown` hook，管理 widget 和 DagTaskManager 的 session 级生命周期 |
| `src/discovery.js` | 动态发现并加载 GSD 核心模块（auto-dispatch, gsd-db, rule-registry 等） |
| `src/deps.js` | DEPS.json schema 验证 + 环检测 + DAG 指标计算 + ready set 计算 + 错误持久化 |
| `src/dag-engine.js` | DAG 调度核心：`DagTaskManager`（后台 task agent 生命周期）、`dagExecutionLoop`（事件循环） |
| `src/engine.js` | dispatch rule 注册 + `_wait_for_dag_completion` 工具注册 + plan-slice prompt 注入 DEPS 提示 |
| `src/task-helpers.js` | task agent 的 session 创建、prompt 构造、无限重试循环 |
| `src/payload-store.js` | 内存 KV（带 TTL），桥接 dispatch 阶段和 tool 执行阶段的上下文传递 |
| `src/widget.js` | 独立 `dag-status` widget（不覆盖 gsd-progress） |

---

## 2. 执行流程

```
PLAN 阶段
  │
  ├── AI 写 S##-PLAN.md
  ├── AI 写 DEPS.json
  │
  ├── plan-slice rule 被 patch，prompt 自动注入 DEPS.json 格式提示
  │
  └── EXECUTE 阶段
        │
        ├── dispatch rule 匹配 executing phase
        │     ├── 若 DEPS.json 缺失或无效 → 写入 DEPS-ERROR.json，退回 plan-slice
        │     ├── 若 DEPS 有效，ready set 为空且 task 未全部完成 → 死锁，退回 plan-slice
        │     ├── 若 totalTasks >= 3 且 averageWidth < 1.5（首次） → 退回 plan-slice
        │     └── 若通过验证，标记所有 ready task 为 in_progress：
        │           → dispatch 为 unitType "reactive-execute"
        │           → unitId 格式: {mid}/{sid}/reactive+T01,T02,...
        │           → payload 写入 payloadStore（TTL 10min）
        │
        ├── GSD 创建 reactive-execute session（原生生命周期）
        │     ├── Prompt: "You MUST call _wait_for_dag_completion with { unitId: ... }"
        │     ├── LLM 调用该工具 → 主会话挂起
        │     └── 工具内部触发 dagExecutionLoop：
        │           ├── 为每个 ready task 调用 pi.createAgentSession()
        │           ├── 异步并行执行，订阅 assistant_message → onUpdate 转发
        │           ├── 任意 task 完成 → 更新 ready set → spawn 新 task
        │           ├── 失败 task → 无限 retry（while 循环内 session.prompt）
        │           └── 所有 task 完成 → tool resolve → 主会话结束
        │
        └── GSD verifyExpectedArtifact 识别 reactive-execute unitType
              → 检查每个 dispatched task 的 SUMMARY.md 存在
              → 通过后 deriveState 检测全部完成 → summarizing → slice completion
```

---

## 3. 决策清单

| 领域 | 决策 |
|---|---|
| 命令 | 无任何用户命令 |
| 并发限制 | 不做硬性上限。并发受 LLM API rate limit 和 Node.js 运行时限制 |
| 依赖格式 | 只认 `DEPS.json`。废弃 `WAVES.json` |
| 串行策略 | 禁用 `execute-task` 和 `reactive-execute`。averageWidth < 1.5 时退回规划 |
| IO 冲突 | 完全忽略 `inputFiles` / `outputFiles`。只以 DEPS.json 显式依赖为准 |
| DEPS 错误 | 最新一次错误持久化到 DEPS-ERROR.json，注入下一轮规划 prompt |
| DEPS 无效 | 无限重试规划，不 hard stop |
| 执行接管 | dispatch 为 `reactive-execute` unitType（GSD 原生支持），`_wait_for_dag_completion` 工具挂起主会话 |
| Task agent 上下文 | 注入：Milestone CONTEXT 摘要 + slice goal + task plan 全文 + 上游已完成 task 摘要 |
| 失败任务 | 无限 retry，不兜底。下游不启动。成功 task 保持完成 |
| Task 退出 | 未调用 `gsd_task_complete` 则 `session.prompt()` 继续，不提前退出 |
| 工具权限 | 全工具继承，包括 subagent |
| 运行时 | 不依赖 `pi-subagents`，不修改 gsd-2 |
| Widget | 独立 `dag-status`，不覆盖 `gsd-progress` |

---

## 4. 实施决策记录

### D001: 输出可见性策略
- **决策时间**: 2026-05-02
- **决策**: 后台 task session 的 assistant_message 转发到主会话 `onUpdate`，交错显示
- **实现**: 订阅 `assistant_message` 事件，前缀标注 `[T##]`
- **状态**: ✅ 已实现

### D002: 创建 Agent 策略
- **决策时间**: 2026-05-02
- **决策**: 仅使用 `pi.createAgentSession`，不动态 import
- **理由**: `@gsd/pi-coding-agent` 不是独立 npm 包，动态 import 不可用；pi API 已提供工厂函数
- **状态**: ✅ 已实现

### D003: 并发执行策略
- **决策时间**: 2026-05-02
- **决策**: 不依赖 `ctx.state.activeTask`，查询所有 ready tasks 并行执行
- **unitId 格式**: `{mid}/{sid}/reactive+T01,T02,T03`
- **状态**: ✅ 已实现

### D004: 状态同步策略
- **决策时间**: 2026-05-02
- **决策**: dispatch 前将所有 ready tasks 标记为 `in_progress`
- **理由**: GSD 状态机需要知道这些 tasks 正在后台执行，避免重复 dispatch
- **状态**: ✅ 已实现

### D005: 日志输出策略
- **决策时间**: 2026-05-03
- **决策**: dispatch/runtime 日志全部通过 `ctx.ui.notify` 输出，禁止 `process.stderr.write`
- **理由**: stderr 直写导致 TUI 界面撕裂；ui.notify 走 GSD 通知管道，节流安全
- **状态**: ✅ 已实现

### D006: UnitType 选择
- **决策时间**: 2026-05-03
- **决策**: 使用 GSD 原生 `reactive-execute` unitType，禁用官方 `reactive-execute` 和 `execute-task` 规则
- **理由**: 自定义 unitType 导致 GSD 的 verifyExpectedArtifact、auto-artifact-paths、state derivation 全部返回 null/false，session closeout 失败。复用 reactive-execute unitType + GSD 原生生命周期，同时禁用官方规则确保只走 DAG 路径
- **状态**: ✅ 已实现

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

约束：version=1、覆盖所有 task、无跨 slice 引用、无环、不涉及 IO 文件。

---

## 6. 关键函数签名

### deps.js

```js
validateExplicitDeps(deps, sliceTasks) → { ok, errors }
findCycle(tasks) → string[]
computeReadySet(deps, allTasks, completedIds) → string[]
calculateDagMetrics(deps) → { totalTasks, criticalPathLength, averageWidth }
persistLatestError(basePath, mid, sid, errors, invalidDeps, ctx)
clearLatestError(basePath, mid, sid, ctx)
loadAndValidateDeps(basePath, mid, sid, sliceTasks) → { deps, error, errors }
```

### dag-engine.js

```js
class DagTaskManager
  agents: Map<taskId, { session, status, startedAt, tool, unsubscribes }>
  failedTasks: Set<taskId>
  abortControllers: Map<taskId, AbortController>
  runTask(taskId, planContent, dynamicToolkit, createAgentSessionFn, abortSignal, onUpdate, ctx)
  abortAll()
  getStatus()

dagExecutionLoop(deps, allTasks, contextToolkit, db, widget, createAgentSessionFn, abortSignal, onUpdate, ctx, dagTaskManagers)
```

### engine.js

```js
injectExplicitDagEngine(core, pi, sessionCtx, dagWidgets, dagTaskManagers)
// Registers:
//   1. Disables "executing → execute-task" and "executing → reactive-execute"
//   2. Injects "executing → dag (reactive-execute)" rule
//   3. Registers _wait_for_dag_completion tool via pi.registerTool()
//   4. Syncs rule-registry singleton
//   5. Patches plan-slice prompt to include DEPS.json hint
```

### task-helpers.js

```js
buildTaskPrompt(taskId, planContent, contextToolkit) → string
isTaskCompleteInDb(taskId, contextToolkit) → boolean
createTaskSession(taskId, ctx, createAgentSessionFn) → AgentSession
setupSessionAbort(session, taskAbort, record)
runTaskLoop(session, taskId, basePrompt, contextToolkit, abortSignal, taskAbort, record, ctx)
```

---

## 7. 架构图

```
                    ┌──────────────────────────┐
                    │    GSD auto-loop          │
                    │    DISPATCH_RULES          │
                    └────────┬─────────────────┘
                             │ match executing & DEPS valid
                             ▼
   ┌──────────────────────────────────────────────────┐
   │ dispatch "reactive-execute" session               │
   │ unitId: M001/S01/reactive+T01,T02                 │
   │ Prompt: call _wait_for_dag_completion              │
   └────────┬─────────────────────────────────────────┘
            │
            ▼
   ┌──────────────────────────────────────────────────┐
   │ _wait_for_dag_completion tool executing...        │
   │ (主会话通过 GSD Tool Execution 状态合法挂起)        │
   └────────┬─────────────────────────────────────────┘
            │
  ┌─────────┴─────────┐
  │ DAG Engine 启动    │
  └─────────┬─────────┘
            │ pi.createAgentSession()
            ▼
   ┌────────────────────┐
   │ Task Agent 1 (T01) │ ─┐
   ├────────────────────┤  │ while(true) 内部重试
   │ Task Agent 2 (T02) │ ─┤ catch + session.prompt()
   ├────────────────────┤  │ 直到 gsd_task_complete
   │ Task Agent N (...) │ ─┘
   └────────┬───────────┘
            │ all completed
            ▼
   ┌──────────────────────────────────────────────────┐
   │ _wait_for_dag_completion tool resolves            │
   │ 主会话结束 → verifyExpectedArtifact 通过           │
   │ → deriveState 全部完成 → summarizing              │
   └──────────────────────────────────────────────────┘
```
