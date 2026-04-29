export function renderWaveDashboard(activeWave, totalWaves, waveSize, statusMap) {
  const { completed, running, unstarted } = statusMap;

  let md = `### 🌊 Wave Execution: ${activeWave} / ${totalWaves} (Max Concurrency: ${waveSize})\n\n`;

  // Progress bar (▇▇▇░░░)
  const totalTasks = completed.length + running.length + unstarted.length;
  const progress = totalTasks > 0 ? Math.round((completed.length / totalTasks) * 10) : 0;
  const bar = "▇".repeat(progress) + "░".repeat(10 - progress);
  md += `**Progress:** [${bar}] ${completed.length}/${totalTasks} Tasks\n\n`;

  // Current wave activity view
  md += `#### Current Wave (${activeWave}) Activity:\n`;
  const runningInWave = running.filter(t => t.wave === activeWave);
  const unstartedInWave = unstarted.filter(t => t.wave === activeWave);

  if (runningInWave.length === 0 && unstartedInWave.length === 0) {
    md += `> ✨ Wave ${activeWave} is complete.\n`;
  } else {
    for (const t of runningInWave) {
      md += `- 🔄 **${t.id}**: Running in sandbox...\n`;
    }
    for (const t of unstartedInWave) {
      md += `- ⏳ **${t.id}**: Pending dispatch\n`;
    }
  }

  // Completed tasks in this wave
  const completedInWave = completed.filter(t => t.wave === activeWave);
  if (completedInWave.length > 0) {
    md += `\n**Completed in Wave ${activeWave}:**\n`;
    for (const t of completedInWave) {
      md += `- ✅ **${t.id}**\n`;
    }
  }

  // Upcoming waves summary
  const future = unstarted.filter(t => t.wave > activeWave);
  if (future.length > 0) {
    const futureByWave = {};
    for (const t of future) {
      futureByWave[t.wave] = (futureByWave[t.wave] || 0) + 1;
    }
    md += `\n*Upcoming: `;
    md += Object.entries(futureByWave)
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([w, count]) => `W${w}(${count} tasks)`)
      .join(", ") + "*\n";
  }

  return md;
}
