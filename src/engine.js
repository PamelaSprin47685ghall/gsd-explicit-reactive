import fs from "node:fs";
import path from "node:path";

const WAVES_PROMPT_INJECTION = `
## 🛑 EXPLICIT WAVES REQUIRED (CRITICAL) 🛑
You MUST create a file at \`.gsd/milestones/{mid}/slices/{sid}/WAVES.json\`.
Group all tasks into numbered parallel execution waves (1, 2, 3...).
Independent tasks MUST share the same wave number to maximize concurrency.
Format:
\`\`\`json
{
  "T01": 1,
  "T02": 1,
  "T03": 2
}
\`\`\`
`;

export function injectExplicitWavesEngine(core, ctx, getWaveSize) {
  const autoDispatch = core["auto-dispatch"];
  if (!autoDispatch || !autoDispatch.DISPATCH_RULES) return;
  const rules = autoDispatch.DISPATCH_RULES;

  if (rules._wavesInjected) return;
  rules._wavesInjected = true;

  // 1. 拦截 Plan-Slice: 注入 WAVES.json 要求
  const planRules = rules.filter(r => r.name.includes("plan-slice") || r.name.includes("refine-slice"));
  for (const rule of planRules) {
    const origMatch = rule.match;
    rule.match = async (dispatchCtx) => {
      const res = await origMatch(dispatchCtx);
      if (res && res.prompt) {
        const injection = WAVES_PROMPT_INJECTION
            .replace("{mid}", dispatchCtx.mid)
            .replace("{sid}", dispatchCtx.state.activeSlice?.id || "SXX");
        res.prompt += `\n\n${injection}`;
      }
      return res;
    };
  }

  // 2. 禁用官方 Reactive-Execute
  const reactiveExecRule = rules.find(r => r.name.includes("reactive-execute"));
  if (reactiveExecRule) {
    reactiveExecRule.match = async () => null;
    reactiveExecRule.name += " (Disabled by Explicit Waves)";
  }

  // 3. 注册 Explicit WAVES 引擎规则
  const explicitRule = {
    name: "executing → explicit-waves-engine",
    match: async (dispatchCtx) => executeExplicitWaves(dispatchCtx, core, rules, getWaveSize())
  };

  const execIndex = rules.findIndex(r => r.name.includes("executing →"));
  rules.splice(execIndex > -1 ? execIndex : 0, 0, explicitRule);

  ctx.ui?.notify?.("🌊 Explicit Waves 并发引擎已挂载并接管调度。", "success");
}

async function executeExplicitWaves(ctx, core, allRules, maxWaveSize) {
  if (ctx.state.phase !== "executing" || !ctx.state.activeTask || !ctx.state.activeSlice) return null;

  const mid = ctx.mid;
  const sid = ctx.state.activeSlice.id;
  const basePath = ctx.basePath;
  const db = core["gsd-db"];

  if (!db.isDbAvailable()) return null;
  const tasks = db.getSliceTasks(mid, sid);
  if (!tasks || tasks.length === 0) return null;

  // 读取 WAVES.json
  const wavesPath = path.join(basePath, ".gsd", "milestones", mid, "slices", sid, "WAVES.json");
  if (!fs.existsSync(wavesPath)) {
    return rejectInvalidWaves(ctx, allRules, "缺少 WAVES.json 文件，必须显式声明并行波次！");
  }

  let wavesMap;
  try {
    const raw = fs.readFileSync(wavesPath, "utf-8").replace(/```json/g, '').replace(/```/g, '');
    wavesMap = JSON.parse(raw);
  } catch (e) {
    return rejectInvalidWaves(ctx, allRules, "WAVES.json JSON 格式不合法！");
  }

  const missing = tasks.filter(t => !wavesMap[t.id]).map(t => t.id);
  if (missing.length > 0) {
    return rejectInvalidWaves(ctx, allRules, `WAVES.json 漏掉了任务: ${missing.join(", ")}`);
  }

  // 计算波次状态
  const activeStatuses = ["running", "in_progress", "dispatched", "active"];
  const doneStatuses = ["complete", "done", "skipped", "success"];

  const pendingTasks = [];
  const runningTasks = [];

  for (const t of tasks) {
    const waveNum = parseInt(wavesMap[t.id], 10) || 999;
    const status = (t.status || "pending").toLowerCase();
    if (doneStatuses.includes(status)) continue;
    const obj = { id: t.id, wave: waveNum, title: t.title };
    if (activeStatuses.includes(status)) runningTasks.push(obj);
    else pendingTasks.push(obj);
  }

  if (pendingTasks.length === 0) return null;

  const incompleteTasks = [...pendingTasks, ...runningTasks];
  const minWave = Math.min(...incompleteTasks.map(t => t.wave));
  const eligiblePending = pendingTasks.filter(t => t.wave === minWave).sort((a, b) => a.id.localeCompare(b.id));
  const currentRunningCount = runningTasks.filter(t => t.wave === minWave).length;

  if (eligiblePending.length === 0) return null;
  if (currentRunningCount >= maxWaveSize) return null;

  const dispatchLimit = maxWaveSize - currentRunningCount;
  const selectedTasks = eligiblePending.slice(0, dispatchLimit).map(t => t.id);

  // 构建执行 Prompt
  const prompts = core["auto-prompts"];
  let dispatchPrompt = await prompts.buildReactiveExecutePrompt(
    mid, ctx.midTitle, sid, ctx.state.activeSlice.title,
    selectedTasks, basePath, undefined, { sessionContextWindow: ctx.sessionContextWindow }
  );

  const doneTasks = tasks.filter(t => {
    const s = (t.status || "pending").toLowerCase();
    return ["complete", "done", "skipped", "success"].includes(s);
  });

  dispatchPrompt += `\n\n## 🌊 EXPLICIT WAVE EXECUTION (Wave ${minWave}) 🌊\n` +
    `Execute the requested tasks in parallel. Strict isolation is required to prevent merge conflicts.`;

  // 抹平状态树，支持断点恢复
  const reactiveGraph = core["reactive-graph"];
  if (reactiveGraph?.saveReactiveState) {
    reactiveGraph.saveReactiveState(basePath, mid, sid, {
      sliceId: sid,
      completed: doneTasks.map(t => t.id),
      dispatched: selectedTasks,
      graphSnapshot: { taskCount: tasks.length, edgeCount: 0, readySetSize: selectedTasks.length, ambiguous: false },
      updatedAt: new Date().toISOString()
    });
  }

  ctx.ui?.notify?.(`🌊 派发 波次 ${minWave} | 任务: [${selectedTasks.join(", ")}] | 并发上限: ${maxWaveSize}`, "success");

  return {
    action: "dispatch",
    unitType: "reactive-execute",
    unitId: `${mid}/${sid}/waves+${selectedTasks.join(",")}`,
    prompt: dispatchPrompt
  };
}

async function rejectInvalidWaves(ctx, allRules, reason) {
  ctx.ui?.notify?.(`🚨 WAVES 格式违规: ${reason}`, "error");

  const planRule = allRules.find(r => r.name.includes("plan-slice"));
  if (!planRule) return null;

  const originalPhase = ctx.state.phase;
  ctx.state.phase = "planning";
  const planResult = await planRule.match(ctx);
  ctx.state.phase = originalPhase;

  if (planResult && planResult.prompt) {
    planResult.prompt = `# 🚨 PLAN REJECTED: WAVES.json ERROR 🚨\n**Reason:** ${reason}\n\nYou MUST rewrite \`.gsd/milestones/${ctx.mid}/slices/${ctx.state.activeSlice.id}/WAVES.json\` correctly.\n\n---\n\n` + planResult.prompt;
    return planResult;
  }

  return null;
}
