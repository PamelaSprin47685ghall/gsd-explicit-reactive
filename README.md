# GSD Explicit Reactive (显式并行波次插件)

`gsd-explicit-reactive` 是一款 GSD 调度拦截扩展，将 GSD 核心的隐式文件依赖算法替换为基于 `WAVES.json` 的**显式并行波次（Explicit Waves）**控制。受 `gsd-context-prune` 架构启发，采用模块化 `src/` 结构。

---

## 解决了什么问题

| 问题 | 方案 |
|---|---|
| GSD 原生依赖图算法复杂度高、难以调试 | 用静态 JSON 配置文件 `WAVES.json` 替代动态依赖计算 |
| 大模型并行调度不可预测，易产生竞态 | 强制波次声明——同一波次的任务并行执行 |
| 并发失控导致 API 超限或机器过载 | 硬性并发上限（默认 8） |

---

## 架构

```
index.js          ← 插件入口，注册 hooks/commands
src/
  discovery.js    ← GSD 核心模块动态发现与加载
  patch.js        ← DISPATCH_RULES 拦截与重写
  waves.js        ← WAVES.json 加载、解析、校验
  settings.js     ← 波次大小持久化配置
  util.js         ← 文件读写工具函数
test/
  helpers.mjs     ← 测试工具（临时目录、环境变量、WAVES 生成）
  waves.test.mjs  ← waves 模块测试
  settings.test.mjs ← settings 模块测试
  patch.test.mjs  ← patch 模块集成测试
  plugin-registration.test.mjs ← 插件注册生命周期测试
```

### 模块职责

**`discovery.js`** — 通过 `@gsd/pi-coding-agent` 包路径及环境变量，定位并加载 `auto-dispatch`、`gsd-db`、`auto-prompts`、`reactive-graph`、`preferences-models` 五个核心模块。支持多层 fallback 路径。

**`patch.js`** — 在 `session_start` 时通过 `patchDispatchRules()` 修改 `DISPATCH_RULES` 数组：
1. **plan-slice 规则增强**：在计划提示中注入 WAVES.json 格式要求
2. **替换 reactive-execute 规则**：插入两条新规则
   - `enforce-explicit-waves`：在 WAVES.json 无效时阻止执行，触发修复提示
   - `explicit-reactive-execute`：按波次并行派发任务，遵守并发上限

**`waves.js`** — 纯函数式 WAVES.json 校验：
- `getTaskIds()`：从文件系统读取切片的任务 ID 列表
- `loadWaves()`：加载并校验 WAVES.json，返回 `{ ok, reason }` 或 `{ ok, waves }`
- 校验内容包括：文件存在性、JSON 格式、任务覆盖度、波号正整性

**`settings.js`** — 通过 `~/.gsd/explicit-reactive.json` 持久化 `waveSize`。默认 8，支持 `/wave-size` 命令动态修改。

---

## 使用

```bash
# 设置最大并行数为 5
/wave-size 5

# 查看当前设置
/wave-size
```

---

## 安装

```json
{
  "gsd": { "extension": true },
  "pi": { "extensions": ["index.js"] }
}
```

将插件目录放入 GSD 插件搜索路径，下次 `/gsd auto` 时自动激活。

---

## 测试

```bash
npm test
```

20 个测试覆盖了 WAVES.json 校验、设置持久化、DISPATCH_RULES 拦截修复、插件注册生命周期。

---

## 与 gsd-context-prune 的架构对比

| 维度 | gsd-context-prune | gsd-explicit-reactive (重写后) |
|---|---|---|
| 模块数 | 8 个 `src/` 文件 | 5 个 `src/` 文件 |
| 入口文件职责 | import + 生命周期注册 | import + 生命周期注册 |
| 测试目录 | `test/` | `test/` |
| 测试 helpers | `test/helpers.mjs` | `test/helpers.mjs` |
| 关注分离 | 单文件 → 多模块 | 单文件 → 多模块 |
| 副作用管理 | 纯函数 + 显式状态 | 纯函数 + 显式状态 |

---

## 证书

MIT License
