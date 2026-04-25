# gsd-explicit-reactive：S01 回归矩阵与验证口径

本文件固化 **M001 / S01** 的最小可复现回归检查，用于后续切片（S02/S03）复用。

## 1) 设计语义不变（验收前提）

以下语义必须保持不变，不属于可调整范围：

- 强制接管 `reactive-execute` dispatch 规则。
- 强制触发 wave rewrite（`executing → enforce-wave-breakdown`）。
- 固定并发上限 `FORCED_MAX_PARALLEL = 8`。

S01 的目标是 **实现正确性与稳定性提升**，不是重新设计行为目标。

## 2) S01 最小回归矩阵

> 所有场景都绑定统一诊断字段：`plugin / phase / cause`。

| 场景 | 回归目的 | 执行命令 | 关键日志关键字（示例） | 通过标准 |
|---|---|---|---|---|
| 主线（deterministic dispatch） | 确认当前 wave 任务选择/排序/截断稳定，且状态落盘语义一致 | `node --test --test-name-pattern "deterministic, truncated at 8" gsd-explicit-reactive/tests/reactive-dispatch.test.mjs` | `phase=reactive-dispatch cause=batch-selected`<br>`phase=reactive-dispatch cause=state-written` | 产生 `reactive-execute` 派发；`unitId` 与 `dispatched` 顺序稳定；`graphSnapshot` 计数一致 |
| 模块加载失败（fail-loud） | 确认内部模块导入失败时不会静默吞错，且挂载被安全中止 | `node --test --test-name-pattern "module import failure remains fail-loud" gsd-explicit-reactive/tests/reactive-dispatch.test.mjs` | `phase=module-load cause=core-modules-import-failed` | 出现 fail-loud 诊断；不会出现 `phase=patch-mount cause=mounted` |
| 空批次（无 pending wave 任务） | 确认不再保留陈旧 reactive state，顺序降级前先清理状态 | `node --test --test-name-pattern "no pending wave tasks remain" gsd-explicit-reactive/tests/reactive-dispatch.test.mjs` | `phase=reactive-dispatch cause=state-cleared`<br>`reason=no-pending-wave-tasks` | 不派发 reactive 批次、不写新状态、清理旧状态 |
| 异常 wave 元数据 | 确认缺失/异常 `wave` 时安全降级，避免误派发与状态污染 | `node --test --test-name-pattern "invalid/missing wave metadata degrades safely" gsd-explicit-reactive/tests/reactive-dispatch.test.mjs` | `phase=reactive-dispatch cause=wave-metadata-invalid`<br>`phase=reactive-dispatch cause=state-cleared` | 不派发 reactive 批次、不写新状态、清理旧状态，并输出可定位原因 |

## 3) 可重复执行步骤（推荐）

1. 运行完整回归集：

```bash
node --test gsd-explicit-reactive/tests/reactive-dispatch.test.mjs
```

2. 核对切片级日志字段与关键路径覆盖：

```bash
rg -n "dispatch-diagnostic plugin=\$\{PLUGIN_NAME\} phase=\$\{phase\} cause=\$\{cause\}|module-discovery|module-load|patch-mount|wave-rewrite|reactive-dispatch" gsd-explicit-reactive/index.ts
```

## 4) 统一验收口径（供后续切片复用）

当且仅当以下条件同时满足时，可认为 S01 相关变更验收通过：

- **语义保持**：forced dispatch takeover / wave rewrite / fixed parallel=8 均未被弱化或门控。
- **实现正确性**：同输入可复现同批次；边界路径（模块失败、空批次、异常 wave）行为一致。
- **可诊断性**：关键路径日志统一带 `plugin/phase/cause`，能够直接定位失败阶段与原因。
- **状态卫生**：顺序降级分支不会遗留陈旧 reactive state，避免污染后续恢复与诊断。
