export function uiLog(ctx, msg, level = "info") {
  const prefix = "🌊 [Waves]";
  console.log(`${prefix} ${msg}`);
  try {
    if (ctx?.ui?.notify) {
      ctx.ui.notify(`${prefix} ${msg}`, level);
    } else if (ctx?.session?.cmdCtx?.ui?.notify) {
      ctx.session.cmdCtx.ui.notify(`${prefix} ${msg}`, level);
    }
  } catch (e) {
    // silent
  }
}
