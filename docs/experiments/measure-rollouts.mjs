// Recompute M2 from the operator's own rollouts: for every session on a given
// day, the wall gap between consecutive successful inference calls, and the dead
// time between the last successful call and a failing task_complete.
//   node docs/experiments/measure-rollouts.mjs 2026/09/08
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const day = process.argv[2] ?? "2026/09/08";
const dir = join(homedir(), ".codex/sessions", day);
if (!existsSync(dir)) { console.error(`no sessions at ${dir}`); process.exit(1); }

const gaps = [], failures = [];
for (const name of readdirSync(dir).filter((n) => n.endsWith(".jsonl"))) {
  const rows = readFileSync(join(dir, name), "utf8").split("\n").filter(Boolean)
    .map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  const usage = [];
  let completed = null;
  for (const row of rows) {
    const kind = row.payload?.type ?? row.type;
    if (kind === "token_count" && row.payload?.info?.last_token_usage)
      usage.push({ at: Date.parse(row.timestamp), input: row.payload.info.last_token_usage.input_tokens });
    if (kind === "task_complete")
      completed = { at: Date.parse(row.timestamp), failed: Boolean(row.payload.error) };
  }
  if (!usage.length || !completed) continue;
  for (let i = 1; i < usage.length; i++)
    if (usage[i].input !== usage[i - 1].input) gaps.push((usage[i].at - usage[i - 1].at) / 1000);
  // The final token_count is a duplicate emitted at task_complete; walk back past it.
  let last = usage.length - 1;
  while (last > 0 && usage[last].input === usage[last - 1].input) last--;
  if (completed.failed) failures.push({ name: name.slice(8, 26), dead: (completed.at - usage[last].at) / 1000 });
}

gaps.sort((a, b) => a - b);
const at = (p) => gaps[Math.floor(gaps.length * p)].toFixed(1);
console.log(`successful call-to-call gaps (n=${gaps.length}, includes tool time):`);
console.log(`  min ${gaps[0].toFixed(1)}s  p50 ${at(0.5)}s  p90 ${at(0.9)}s  max ${gaps.at(-1).toFixed(1)}s`);
console.log(`  exceeding 15s: ${gaps.filter((g) => g > 15).length}/${gaps.length}`);
console.log("\ndead time before each failure:");
for (const f of failures) console.log(`  ${f.name}  ${f.dead.toFixed(2)}s`);
const cluster = failures.filter((f) => f.dead > 15 && f.dead < 15.2);
console.log(`\nfailures in the 15.0-15.2s band: ${cluster.length} of ${failures.length}`);
