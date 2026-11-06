// Simulate 2+ weeks of weekday 9-17 usage (1.5%/h -> 60%/week) and compare
// the learned weekly projection against the naive average-pace one.
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";

const S = fileURLToPath(new URL("../statline.mjs", import.meta.url));
const STORE = process.argv[2] ?? join(tmpdir(), "statline-sim-store.json");
rmSync(STORE, { force: true });

// Week starts Monday 00:00 local, 2026-10-12.
const week0 = new Date(2026, 9, 12, 0, 0, 0).getTime() / 1000;
const WEEK = 7 * 86400;
const usageAt = (t) => {             // cumulative % within the week containing t
  const ws = week0 + Math.floor((t - week0) / WEEK) * WEEK;
  let u = 0;
  for (let h = ws; h < t; h += 1800) {
    const d = new Date(h * 1000), day = d.getDay(), hr = d.getHours();
    if (day >= 1 && day <= 5 && hr >= 9 && hr < 17) u += 0.75;
  }
  return { u, resets: ws + WEEK };
};

function run(t, quiet = true) {
  const { u, resets } = usageAt(t);
  const input = JSON.stringify({ model: { display_name: "Opus 5.5" },
    rate_limits: { seven_day: { used_percentage: u, resets_at: resets } } });
  const out = execFileSync("node", [S], { input,
    env: { ...process.env, STATLINE_NOW: String(t), STATLINE_STORE: STORE } }).toString();
  return { u, out: out.replace(/\x1b\[[0-9;]*m/g, "") };
}

// Only sample while "working" (status line runs only during sessions).
const end = week0 + 2 * WEEK + 3 * 86400 + 17 * 3600;   // week 3, Thursday 17:00
let n = 0;
for (let t = week0 + 9 * 3600; t < end; t += 1800) {
  const d = new Date(t * 1000);
  if (d.getDay() >= 1 && d.getDay() <= 5 && d.getHours() >= 9 && d.getHours() < 17) { run(t); n++; }
}
const r = run(end);
console.log(`samples: ${n}; Thu 17:00 week 3, used ${r.u}% (actual week total will be 60%)`);
console.log("learned :", r.out);
rmSync(STORE, { force: true });
console.log("no hist :", run(end).out);
