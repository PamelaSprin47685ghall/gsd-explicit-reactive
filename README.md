# GSD Explicit Reactive (显式并行波次插件)

`gsd-explicit-reactive` 是为 GSD 开发的一款调度拦截插件，旨在将 GSD 核心原生那些“理想化但脆弱”的隐式文件依赖算法，重置为基于静态文件的**显式并行波次（Explicit Waves）**控制。它强制大模型通过集中的 JSON 配置文件去声明并发结构，彻底消灭了不可控的竞态条件和死锁。

通过极致的重构，整个插件仅以一个不到 200 行的原生 JavaScript 文件 (`index.js`) 构成，完全抛弃了复杂的 TypeScript 定义和厚重的模块加载器，直接将“显式并行的确定性”注入到 Auto-Mode 的血脉之中。

## 核心特性：化“隐式盲猜”为“显式掌控”

### 1. 强制静态波次配置 (Centralized JSON Sidecar)
在原生的 GSD 中，系统试图通过扫描所有任务的文件读写记录动态拼凑出无冲突的任务依赖图，稍有不慎即全盘崩溃。
本插件拦截了初始计划流程，强制要求大模型**不准**把 `wave` 参数写在任务文档里，而是必须在切片目录下生成唯一的 `.gsd/milestones/<M>/slices/<S>/WAVES.json`，集中调度并发波次：
```json
{
  "T01": 1,
  "T02": 1,
  "T03": 2
}
```

### 2. 硬核并发截流 (Forced Max Parallelism)
不管大模型在某个波次安排了多少个任务，插件在重写的派发算法里强制设下了**最高 8 并发 (`FORCED_MAX_PARALLEL = 8`)**的不可逾越红线。超出的任务会遵循自然数字排序（A-Z, 0-9）被截断到后续批次执行，保护机器性能和 API 速率配额不被击穿。

### 3. “绝不将就”的自动修复环 (Strict Repair Loop)
如果 JSON 文件缺失、格式错误或者大模型规划的任务列表跟配置文件对不上号：
- 系统**绝对不会**允许静默降级为串行执行，因为这会掩盖大模型的错误。
- 插件会立刻阻断接下来的执行，替换常规指令为一则严厉的“修复提示词 (Repair Prompt)”，强制要求 LLM 停下手中的活先将 `WAVES.json` 修复好。
- 当处于该修复分支时，底层的残余 Reactive 状态会被强制清洗，保证环境卫生。

## 用户命令 (Commands)

插件提供了一条直观的控制命令：

```bash
/wave-size 5
```

这可以将最大并发数量 (`FORCED_MAX_PARALLEL`) 动态变更为 `5`。你所设置的阈值将自动持久化保存到 `~/.gsd/explicit-reactive.json`，因此只需设置一次，所有新开的终端和代理运行都会共享这一防并发击穿的上限配置。

## 安装

这是为 `pi-coding-agent` (GSD) 开发的非官方社区插件。进入 GSD 配置的插件目录中：

```bash
git clone https://github.com/your-username/gsd-explicit-reactive.git
```

确保 `package.json` 包含如下挂载项：

```json
{
  "gsd": {
    "extension": true
  },
  "pi": {
    "extensions": ["index.js"]
  }
}
```

在下次运行 `/gsd auto` 时，本插件会自动拦截 `auto-dispatch` 内部队列并完成替换。

## 架构：少即是多

相较于早先包含庞杂模块发现机制与文件遍历工具的版本，目前的 `index.js` 单文件完美利用了 JavaScript 动态加载的强大优势。不仅直接打进 `DISPATCH_RULES` 的内部数组并保证顺序正确（在原有串行 `execute-task` 之前抢先起飞），还使用了纯净原生的数组过滤机制。再也没有繁重的依赖编译，只有绝对确定的并行。

## 运行测试

只需安装 Node.js (>=20) ，即可运行零外部依赖的内建断言测试：

```bash
npm run test
# 或者: node --test index.test.mjs
```

```text
▶ gsd-explicit-reactive
  ✔ injects WAVES.json prompt into plan-slice (0.51ms)
  ✔ replaces reactive-execute with explicit rules (0.11ms)
  ✔ enforce-explicit-waves returns repair prompt if WAVES.json missing (0.31ms)
✔ gsd-explicit-reactive (11.31ms)
```

## 证书

MIT License
