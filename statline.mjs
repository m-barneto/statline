// statline: context + usage status line for Claude Code.
// Reads the session JSON from stdin (see code.claude.com/docs/en/statusline).
import { readFileSync, writeFileSync, renameSync, openSync, readSync, fstatSync, closeSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HOME_DIR = process.env.USERPROFILE ?? process.env.HOME ?? "";
const now = Number(process.env.STATLINE_NOW) || Date.now() / 1000;
const HOUR = 3600, WEEK = 7 * 86400;
// ── usage history ──────────────────────────────────────────────────────
// Raw readings: [time, 5h %, 5h reset, weekly %, weekly reset] (null if absent).
// Limits are account-wide, so readings from any computer describe the same
// usage — merging histories is just a union by timestamp.
const STORE = process.env.STATLINE_STORE ?? `${HOME_DIR}/.claude/statline-usage.json`;
const same = (a, b) => a != null && b != null && Math.abs(a - b) <= 120;
const loadStore = () => {
  try { const s = JSON.parse(readFileSync(STORE, "utf8")); return Array.isArray(s.samples) ? s : {}; }
  catch { return {}; }   // missing, corrupt, or old format: start fresh
};
const serialize = (s) =>  // 2-space JSON, one reading per line
  `{\n  "lastSync": ${JSON.stringify(s.lastSync ?? null)},\n  "samples": [\n`
  + (s.samples ?? []).map((x) => "    " + JSON.stringify(x)).join(",\n") + "\n  ]\n}\n";
function saveStore(s) {
  try { // write-then-rename so parallel sessions never see a half-written file
    const tmp = `${STORE}.${process.pid}.tmp`;
    writeFileSync(tmp, serialize(s));
    renameSync(tmp, STORE);
  } catch {}
}
// Union by timestamp, sort, keep 6 weeks, thin readings older than a day to
// one per 15 minutes (values are cumulative, so nothing is lost by thinning).
function tidy(samples) {
  const byT = new Map();
  for (const s of samples) if (Array.isArray(s) && s.length === 5) byT.set(Math.round(s[0]), s);
  const out = [];
  for (const s of [...byT.values()].sort((a, b) => a[0] - b[0])) {
    if (s[0] < now - 6 * WEEK) continue;
    const p = out.at(-1);
    const sameSlot = p && s[0] < now - 86400 && Math.floor(p[0] / 900) === Math.floor(s[0] / 900)
      && (p[2] == null || same(p[2], s[2])) && (p[4] == null || same(p[4], s[4]));
    if (sameSlot) out[out.length - 1] = s; else out.push(s);
  }
  return out;
}

// ── gist sync ──────────────────────────────────────────────────────────
// Shares the history across computers through a secret GitHub gist.
//   node statline.mjs --sync-setup          create the gist (first computer)
//   node statline.mjs --sync-setup <id>     use an existing gist (other computers)
//   node statline.mjs --sync                sync now
// Needs a GitHub token with Gists read/write: "token" in statline-sync.json,
// or the CLAUDE_USAGE_GIST_TOKEN environment variable (takes precedence).
// While set up, the status line syncs in the background every 5 minutes.
// A custom STATLINE_STORE (tests) never uses the real sync config unless one
// is given explicitly — test readings must not reach your real gist.
const SYNC_CONFIG = process.env.STATLINE_SYNC_CONFIG
  ?? (process.env.STATLINE_STORE ? null : `${HOME_DIR}/.claude/statline-sync.json`);
const SYNC_LOG = `${STORE.replace(/\.json$/, "")}-sync.log`;
const GIST_FILE = "claude-usage.json";
let syncCfg = {};
if (SYNC_CONFIG) try { syncCfg = JSON.parse(readFileSync(SYNC_CONFIG, "utf8")); } catch {}
// Token: environment variable if set, otherwise "token" in statline-sync.json.
const TOKEN = SYNC_CONFIG ? process.env.CLAUDE_USAGE_GIST_TOKEN || syncCfg.token : null;

async function gh(method, path, body) {
  const api = process.env.STATLINE_GITHUB_API ?? "https://api.github.com";  // override for tests
  const res = await fetch(`${api}${path}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/vnd.github+json",
               "User-Agent": "statline", ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function syncNow() {
  const g = await gh("GET", `/gists/${syncCfg.gistId}`);
  const f = g.files?.[GIST_FILE];
  let remote = [];
  if (f) {
    const text = f.truncated ? await (await fetch(f.raw_url)).text() : f.content;
    try { remote = JSON.parse(text).samples ?? []; } catch {}
  }
  const local = loadStore().samples ?? [];
  const merged = tidy([...local, ...remote]);
  saveStore({ lastSync: now, samples: merged });
  const content = serialize({ samples: merged });
  if (f?.content !== content) {
    await gh("PATCH", `/gists/${syncCfg.gistId}`, { files: { [GIST_FILE]: { content } } });
  }
  return { local: local.length, remote: remote.length, merged: merged.length };
}

const cli = process.argv.slice(2);
if (cli[0] === "--sync" || cli[0] === "--sync-setup") {
  const log = (m) => { try { writeFileSync(SYNC_LOG, `${new Date().toISOString()} ${m}\n`); } catch {} };
  try {
    if (!TOKEN) throw new Error(`No GitHub token: add "token" to ${SYNC_CONFIG} or set CLAUDE_USAGE_GIST_TOKEN.`);
    if (cli[0] === "--sync-setup") {
      if (cli[1]) syncCfg.gistId = cli[1];
      else {
        const g = await gh("POST", "/gists", {
          description: "Claude Code usage history (status line)", public: false,
          files: { [GIST_FILE]: { content: serialize({ samples: tidy(loadStore().samples ?? []) }) } },
        });
        syncCfg.gistId = g.id;
      }
      writeFileSync(SYNC_CONFIG, JSON.stringify(syncCfg, null, 2) + "\n");
      console.log(`Gist sync set up: ${syncCfg.gistId}`);
      console.log(`On your other computers run:  node ~/.claude/statline.mjs --sync-setup ${syncCfg.gistId}`);
    }
    if (!syncCfg.gistId) throw new Error("No gist set up yet. Run with --sync-setup first.");
    const r = await syncNow();
    const msg = `synced: ${r.local} local + ${r.remote} remote -> ${r.merged} readings`;
    log(msg);
    if (process.stdout.isTTY || cli[0] === "--sync-setup" || !cli.includes("--quiet")) console.log(msg);
  } catch (e) {
    log(`error: ${e.message}`);
    if (!cli.includes("--quiet")) console.error(`sync failed: ${e.message}`);
    process.exitCode = 1;
  }
  process.exit();
}

const input = JSON.parse(readFileSync(0, "utf8") || "{}");

// ── styling ────────────────────────────────────────────────────────────
const c = (code) => (s) => `\x1b[${code}m${s}\x1b[0m`;
// Soft palette (24-bit colour). Tweak the hex values here to taste.
const PALETTE = {
  model: "#8AADF4",   // soft periwinkle
  ok:    "#8CC9A0",   // sage green
  warn:  "#E8C27A",   // warm sand
  bad:   "#EE8F8F",   // soft coral
  muted: "#6E7383",   // slate gray (labels, empty bar, separators)
  effort:"#F5BDE6",   // soft pink (effort dots)
};
const rgb = (hex) => { const n = parseInt(hex.slice(1), 16); return `38;2;${n >> 16};${(n >> 8) & 255};${n & 255}`; };
const dim = c(rgb(PALETTE.muted)), cyan = c(rgb(PALETTE.model)), bold = c("1");
const green = c(rgb(PALETTE.ok)), yellow = c(rgb(PALETTE.warn)), red = c(rgb(PALETTE.bad));
const tint = (p) => (p < 50 ? green : p < 80 ? yellow : red);
const SEP = dim("  ·  ");

const fmtTok = (t) =>
  t >= 1_000_000 ? `${+(t / 1_000_000).toFixed(1)}M`
  : t >= 1000 ? `${Math.round(t / 1000)}k` : `${t}`;

function fmtDur(sec) {
  const s = Math.max(0, sec);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

function bar(pct, width = 8) {
  const filled = Math.round((Math.min(100, pct) / 100) * width);
  return tint(pct)("█".repeat(filled)) + dim("░".repeat(width - filled));
}

// ── model + effort ─────────────────────────────────────────────────────
const model = input.model?.display_name ?? "Claude";

function effortLevel() {
  const direct = input.effort?.level ?? input.effort;
  if (typeof direct === "string") return direct;
  // Fallback: saved settings (project overrides user; per-model, then global).
  const id = input.model?.id ?? "";
  const base = id.replace(/\[.*\]$/, "");
  const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
  const ws = input.workspace?.project_dir ?? input.workspace?.current_dir ?? input.cwd;
  const files = [`${home}/.claude/settings.json`];
  if (ws) files.push(`${ws}/.claude/settings.json`, `${ws}/.claude/settings.local.json`);
  let level = process.env.CLAUDE_CODE_EFFORT_LEVEL ?? null;
  for (const f of files) {
    try {
      const s = JSON.parse(readFileSync(f, "utf8"));
      level = s.modelSettings?.[id]?.effortLevel ?? s.modelSettings?.[base]?.effortLevel
        ?? s.effortLevel ?? level;
    } catch {}
  }
  return level;
}
const effort = effortLevel();

// ── context window ─────────────────────────────────────────────────────
const cw = input.context_window ?? {};
const size = cw.context_window_size
  ?? (/\[1m\]/i.test(input.model?.id ?? "") ? 1_000_000 : 200_000);

function fromTranscript(path) {
  try {
    const fd = openSync(path, "r");
    const len = fstatSync(fd).size;
    const n = Math.min(len, 2_000_000);
    const buf = Buffer.alloc(n);
    readSync(fd, buf, 0, n, len - n);
    closeSync(fd);
    const lines = buf.toString("utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      let e;
      try { e = JSON.parse(lines[i]); } catch { continue; }
      const u = e?.message?.usage;
      if (!u || e.isSidechain) continue;
      return (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0)
           + (u.cache_creation_input_tokens ?? 0);
    }
  } catch {}
  return null;
}

let used = null;
const cu = cw.current_usage;
if (cu) {
  used = (cu.input_tokens ?? 0) + (cu.cache_read_input_tokens ?? 0)
       + (cu.cache_creation_input_tokens ?? 0);
} else if (cw.used_percentage != null) {
  used = Math.round((cw.used_percentage / 100) * size);
} else if (input.transcript_path) {
  used = fromTranscript(input.transcript_path);
}

let ctx = `${bar(0)} ${dim(`—/${fmtTok(size)}`)}`;
if (used != null) {
  const pct = Math.round((used / size) * 100);
  ctx = `${bar(pct)} ${dim(`${fmtTok(used)}/${fmtTok(size)}`)}`;
}

// ── plan limits + run-out estimate ─────────────────────────────────────
// Sent only for Pro/Max/Ultra (or a gateway spend limit), after the first
// response. Projections are derived from the reading history (shared across
// computers when gist sync is on):
//   • 5h window: blends your pace over the last 45 min with the window average,
//     so speeding up or slowing down shows quickly.
//   • weekly: learns how much you typically use in each hour of the week
//     (e.g. Tue 2pm vs Sat 2pm) and sums that over the hours left until reset.
//     Blends in gradually over the first week of history.
//   • 5h lockouts: learns how much weekly % one 5h-window % costs, and caps
//     each 5h window in the weekly projection accordingly.
const WINDOWS = [
  { key: "five_hour", len: 5 * HOUR, minElapsed: 15 * 60 },
  { key: "seven_day", len: WEEK, minElapsed: 12 * HOUR },
];

const hourOfWeek = (t) => { const d = new Date(t * 1000); return d.getDay() * 24 + d.getHours(); };
// Walk [a, b) in clock-hour slices: fn(hourOfWeekBucket, secondsInSlice).
function eachHour(a, b, fn) {
  for (let t = a; t < b; ) {
    const next = Math.min(b, (Math.floor(t / HOUR) + 1) * HOUR);
    fn(hourOfWeek(t), next - t);
    t = next;
  }
}

const store = loadStore();
store.samples ??= [];
let dirty = false;

// Add the current reading: when it changed (at most once a minute), or every
// 10 minutes regardless (an unchanged reading still says "no use since").
function recordReading(rl) {
  const f = rl.five_hour, w = rl.seven_day;
  const row = [Math.round(now), f?.used_percentage ?? null, f?.resets_at ?? null,
               w?.used_percentage ?? null, w?.resets_at ?? null];
  if (row[1] == null && row[3] == null) return;
  const last = store.samples.at(-1);
  if (last) {
    const changed = last[1] !== row[1] || last[3] !== row[3];
    if (now - last[0] < 60 || (!changed && now - last[0] < 600)) return;
  }
  store.samples.push(row);
  dirty = true;
}

// Build the hour-of-week profile and the 5h→weekly ratio from the readings.
let hist = null;
function history() {
  if (hist) return hist;
  const buckets = new Array(168).fill(0);
  let since = null, d5 = 0, dw = 0, prev = null;
  for (const [t, p5, r5, pw, rw] of store.samples) {
    if (pw != null && rw != null) {
      if (prev?.pw != null && same(prev.rw, rw)) {           // same week: credit the increase
        if (pw > prev.pw) eachHour(prev.t, t, (k, s) => { buckets[k] += (pw - prev.pw) * s / (t - prev.t); });
      } else {                                               // new week (or first reading)
        const from = Math.max(rw - WEEK, prev?.t ?? -Infinity);
        if (pw > 0 && t > from) eachHour(from, t, (k, s) => { buckets[k] += pw * s / (t - from); });
        since ??= Math.min(from, t);
      }
    }
    if (prev && p5 != null && prev.p5 != null && pw != null && prev.pw != null
        && same(prev.r5, r5) && same(prev.rw, rw)) {
      const a = p5 - prev.p5, b = pw - prev.pw;
      if (a > 0 && b >= 0) { d5 += a; dw += b; }
    }
    prev = { t, p5, r5, pw, rw };
  }
  // Ratio needs at least half a 5h window of evidence.
  return (hist = { buckets, since, ratio: d5 >= 50 ? dw / d5 : null });
}
let five = null; // current 5h window: { pct, resets_at, outAt } — filled by limitSegment

// Both return { projected: % at reset, outAt: epoch secs the limit is hit, or null }.
function linear(pct, rate, left) {
  const projected = pct + rate * left;
  const outAt = projected >= 100 && rate > 0 ? now + (100 - pct) / rate : null;
  return { projected, outAt };
}

function projectFiveHour({ key, len, minElapsed }, pct, left) {
  const elapsed = len - left;
  if (elapsed < minElapsed || pct <= 0) return { projected: pct, outAt: null };
  const avg = pct / elapsed;
  const cur = five?.resets_at ?? input.rate_limits?.five_hour?.resets_at;
  const recent = store.samples
    .filter(([t, p5, r5]) => t >= now - 45 * 60 && p5 != null && same(r5, cur))
    .map(([t, p5]) => [t, p5]);
  let rate = avg;
  if (recent.length >= 2) {
    const [[ta, pa], [tb, pb]] = [recent[0], recent.at(-1)];
    if (tb - ta >= 10 * 60) rate = 0.5 * Math.max(0, (pb - pa) / (tb - ta)) + 0.5 * avg;
  }
  return linear(pct, rate, left);
}

function projectWeekly({ len, minElapsed }, pct, left) {
  const elapsed = len - left;
  const avg = elapsed > 0 ? pct / elapsed : 0;
  const prof = history();
  const tracked = prof.since ? now - prof.since : 0;
  const haveAvg = elapsed >= minElapsed && pct > 0;
  const useProfile = tracked >= 2 * 86400;
  if (!useProfile && !haveAvg) return { projected: pct, outAt: null };

  // How many times each hour-of-week has been observed since tracking began.
  const seen = new Array(168).fill(0);
  if (useProfile) eachHour(prof.since, now, (k, s) => { seen[k] += s / HOUR; });
  const conf = useProfile ? Math.min(1, tracked / WEEK) : 0;
  const rateAt = (t) => {                                     // expected weekly %/sec at time t
    const k = hourOfWeek(t);
    const learned = seen[k] >= 0.5 ? prof.buckets[k] / seen[k] / HOUR : avg;
    return conf * learned + (1 - conf) * (haveAvg ? avg : learned);
  };

  // 5h lockouts: pause weekly use during the current window's predicted
  // lockout; with a learned ratio, also cap every 5h window (current and
  // future) at (5h headroom × ratio) weekly %.
  const ratio = prof.ratio;
  let winEnd = five?.resets_at ?? null;
  let budget = five && ratio != null ? (100 - five.pct) * ratio : null;

  // Walk forward in 15-minute steps; note when the total crosses 100%.
  const STEP = 900, end = now + left;
  let total = pct, outAt = null;
  for (let t = now; t < end; t += STEP) {
    const s = Math.min(STEP, end - t);
    let inc = rateAt(t) * s;
    if (winEnd != null) {
      if (t >= winEnd) {                                      // next 5h window (assumed back-to-back)
        while (t >= winEnd) winEnd += 5 * HOUR;
        budget = ratio != null ? 100 * ratio : null;
      }
      // Current window: no use during the 5h projection's predicted lockout.
      if (five.outAt != null && t >= five.outAt && t < five.resets_at) inc = 0;
      if (budget != null) { inc = Math.min(inc, budget); budget -= inc; }
    }
    if (outAt == null && total < 100 && total + inc >= 100) outAt = t + s * (100 - total) / inc;
    total += inc;
  }
  return { projected: total, outAt };
}

// Today: "4:12pm". Within 24h but another day: "Sat 11:17am". Further: "Sun 2pm".
function fmtClock(epoch) {
  const d = new Date(epoch * 1000);
  const h = d.getHours() % 12 || 12, m = d.getMinutes(), ap = d.getHours() < 12 ? "am" : "pm";
  const time = `${h}:${String(m).padStart(2, "0")}${ap}`;
  if (d.toDateString() === new Date(now * 1000).toDateString()) return time;
  const day = d.toLocaleDateString("en-US", { weekday: "short" });
  return epoch - now < 24 * HOUR ? `${day} ${time}` : `${day} ${h}${ap}`;
}

// Bar:  █ (solid)  = used so far, coloured by current usage
//       ▒ (shaded) = projected extra use by reset at current pace, coloured by
//                    projected total — red to the end means you'd run out first
//       ░ (dim)    = headroom
const LIMIT_WIDTH = 8;
// Projection colour: green = comfortable, yellow = close, red = runs out first.
const projTint = (p) => (p < 80 ? green : p < 100 ? yellow : red);
function limitSegment(win, w) {
  const pct = Math.min(100, w.used_percentage);
  const left = w.resets_at ? w.resets_at - now : null;

  let projected = pct, outAt = null;
  if (left != null) {
    ({ projected, outAt } = win.key === "seven_day" ? projectWeekly(win, pct, left)
                                                    : projectFiveHour(win, pct, left));
    if (win.key === "five_hour") five = { pct, resets_at: w.resets_at, outAt };
  }

  const cells = (p) => Math.round((Math.min(100, p) / 100) * LIMIT_WIDTH);
  const hashes = Math.max(pct > 0 ? 1 : 0, cells(pct));
  // A full bar must mean "runs out": below 100% never fill the last cell.
  const projCells = projected >= 100 ? LIMIT_WIDTH : Math.min(LIMIT_WIDTH - 1, cells(projected));
  const dollars = Math.max(0, projCells - hashes);
  const under = LIMIT_WIDTH - hashes - dollars;

  const barStr = tint(pct)("█".repeat(hashes))
    + projTint(projected)("▒".repeat(dollars))
    + dim("░".repeat(under));
  if (left == null) return barStr;
  // Running out: say when, and when it comes back. Otherwise: time to reset.
  if (outAt != null) {
    // Same layout as a close call: time to reset, projected % (past 100 = how
    // far over your pace is), then when you'd hit the limit and when it resets.
    // (No countdown here: the reset clock time after the slash covers it.)
    return `${barStr} ${red(`~${Math.round(projected)}% ${fmtClock(outAt)}`)}`
      + dim(`/${fmtClock(w.resets_at)}`);
  }
  const close = projected >= 90 ? ` ${yellow(`~${Math.round(projected)}%`)}` : "";
  return `${barStr} ${dim(fmtDur(left))}${close}`;
}

const limits = [];
const rl = input.rate_limits ?? {};
recordReading(rl);
for (const win of WINDOWS) {   // five_hour first: the weekly projection uses its result
  const w = rl[win.key];
  if (w?.used_percentage != null) limits.push(limitSegment(win, w));
}
// Background gist sync, at most every 5 minutes (also pulls fresh history
// when you switch to this computer).
const wantSync = syncCfg.gistId && TOKEN && now - (store.lastSync ?? 0) > 300;
if (wantSync) { store.lastSync = now; dirty = true; }
if (dirty) { store.samples = tidy(store.samples); saveStore(store); }
if (wantSync) {
  try {
    spawn(process.execPath, [fileURLToPath(import.meta.url), "--sync", "--quiet"],
          { detached: true, stdio: "ignore", windowsHide: true }).unref();
  } catch {}
}
const sl = rl.spend_limit;
if (sl?.used_percentage != null) {
  const p = sl.used_percentage;
  const amt = sl.used_usd != null && sl.limit_usd != null
    ? `$${Math.round(sl.used_usd)} / $${Math.round(sl.limit_usd)}` : `${Math.round(p)}%`;
  limits.push(`${dim("spend")} ${tint(p)(amt)}`);
}
const cost = input.cost?.total_cost_usd;
if (!limits.length && cost != null) limits.push(dim(`~$${cost.toFixed(2)} this session`));

// ── output ─────────────────────────────────────────────────────────────
// Effort as dots: low ●○○○○ … max ●●●●●. Unknown values fall back to text.
const LEVELS = ["low", "medium", "high", "xhigh", "max"];
const lvl = LEVELS.indexOf(effort) + 1;
const pips = lvl ? " " + c(rgb(PALETTE.effort))("●".repeat(lvl)) + dim("○".repeat(5 - lvl))
  : effort ? " " + dim(effort) : "";
const head = `${cyan(bold(model))}${pips}`;
process.stdout.write([head, ctx, ...limits].join(SEP));
