# gsd-explicit-reactive：回归矩阵与验证口径

本文件固化插件的最小可复现回归检查，用于后续切片复用。

## 1) 设计语义不变（验收前提）

以下语义必须保持不变，不属于可调整范围：

- 强制接管 `reactive-execute` dispatch 规则。
- 强制触发 wave sidecar 兜底修复（`executing → enforce-wave-breakdown`）。
- 固定并发上限 `FORCED_MAX_PARALLEL = 8`。
- Task wave 不写入 task-plan frontmatter；每个 slice 恰好使用一个 JSON sidecar：`.gsd/milestones/<M>/slices/<S>/<S>-TASK-WAVES.json`。
- 初次 `plan-slice` 派发同时包含 GSD 标准 plan prompt 和插件并发/sidecar prompt；兜底重试只发送插件 repair prompt。

## 2) 最小回归矩阵

> 所有场景都绑定统一诊断字段：`[dispatch] <phase> <cause> ...`。

| 场景 | 回归目的 | 执行命令 | 关键日志关键字（示例） | 通过标准 |
|---|---|---|---|---|
| 初次计划提示词 | 确认标准 plan prompt 与插件 sidecar prompt 一起发出 | `node --test --test-name-pattern "initial plan-slice" tests/reactive-dispatch.test.mjs` | `Plugin overlay: explicit task waves` | prompt 保留标准 `buildPlanSlicePrompt` 内容，并要求创建唯一 `Sxx-TASK-WAVES.json`；明确禁止 `wave` frontmatter |
| 兜底修复提示词 | 确认 sidecar 缺失/异常时只发送插件 repair prompt | `node --test --test-name-pattern "fallback wave rewrite" tests/reactive-dispatch.test.mjs` | `# Repair explicit task waves sidecar` | 不重发标准 plan prompt；repair prompt 含当前 task set、canonical sidecar path、slice goal |
| 主线（deterministic dispatch） | 确认当前 wave 从 sidecar 读取，任务选择/排序/截断稳定，且状态落盘语义一致 | `node --test --test-name-pattern "reads waves from the single sidecar" tests/reactive-dispatch.test.mjs` | `reactive-dispatch batch-selected`<br>`reactive-dispatch state-written` | 产生 `reactive-execute` 派发；`unitId` 与 `dispatched` 顺序稳定；`graphSnapshot` 计数一致 |
| 模块加载失败（fail-loud） | 确认内部模块导入失败时不会静默吞错，且挂载被安全中止 | `node --test --test-name-pattern "module import failure remains fail-loud" tests/reactive-dispatch.test.mjs` | `module-load core-modules-import-failed` | 出现 fail-loud 诊断；不会出现 `patch-mount mounted` |
| 空批次（无 pending sidecar wave 任务） | 确认不再保留陈旧 reactive state，顺序降级前先清理状态 | `node --test --test-name-pattern "no pending sidecar wave tasks remain" tests/reactive-dispatch.test.mjs` | `reactive-dispatch state-cleared`<br>`reason=no-pending-wave-tasks` | 不派发 reactive 批次、不写新状态、清理旧状态 |
| 异常 sidecar | 确认缺失/异常 sidecar 时安全降级，避免误派发与状态污染 | `node --test --test-name-pattern "invalid/missing wave sidecar" tests/reactive-dispatch.test.mjs` | `reactive-dispatch wave-sidecar-invalid`<br>`wave-sidecar-task-set-mismatch` | 不派发 reactive 批次、不写新状态、清理旧状态，并输出可定位原因 |
| JSON 解析失败 | 确认 malformed JSON 不会被容错误读或误派发 | `node --test --test-name-pattern "malformed JSON wave sidecar" tests/reactive-dispatch.test.mjs` | `json-invalid`<br>`reactive-dispatch state-cleared` | 不派发 reactive 批次、不写新状态、清理旧状态，并输出 JSON 解析失败原因 |

## 3) 可重复执行步骤（推荐）

运行完整回归集：

```bash
node --test tests/reactive-dispatch.test.mjs
```

## 4) 统一验收口径

当且仅当以下条件同时满足时，可认为相关变更验收通过：

- **语义保持**：forced dispatch takeover / wave sidecar fallback / fixed parallel=8 均未被弱化或门控。
- **实现正确性**：同输入可复现同批次；边界路径（模块失败、空批次、异常 sidecar）行为一致。
- **可诊断性**：关键路径日志统一带 `phase/cause`，能够直接定位失败阶段与原因。
- **状态卫生**：顺序降级分支不会遗留陈旧 reactive state，避免污染后续恢复与诊断。
