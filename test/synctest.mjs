// End-to-end sync test against a local mock of the GitHub gist API.
// Two "computers" (separate store + config files) share one mock gist.
import http from "node:http";
import { execFileSync, execFile } from "node:child_process";
import { readFileSync, rmSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";

const S = fileURLToPath(new URL("../statline.mjs", import.meta.url));
const DIR = process.argv[2] ?? join(tmpdir(), "statline-synctest");
mkdirSync(DIR, { recursive: true });
const gists = {};
let calls = [];
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    calls.push(`${req.method} ${req.url} auth=${req.headers.authorization === "Bearer test-token"}`);
    const send = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (req.headers.authorization !== "Bearer test-token") return send(401, { message: "bad creds" });
    if (req.method === "POST" && req.url === "/gists") {
      const b = JSON.parse(body); const id = "abc123";
      gists[id] = { id, public: b.public, files: Object.fromEntries(Object.entries(b.files).map(([k, v]) => [k, { content: v.content, truncated: false }])) };
      return send(201, gists[id]);
    }
    const m = req.url.match(/^\/gists\/(\w+)$/);
    if (!m || !gists[m[1]]) return send(404, { message: "not found" });
    if (req.method === "GET") return send(200, gists[m[1]]);
    if (req.method === "PATCH") {
      for (const [k, v] of Object.entries(JSON.parse(body).files)) gists[m[1]].files[k] = { content: v.content, truncated: false };
      return send(200, gists[m[1]]);
    }
    send(405, {});
  });
});
await new Promise((r) => server.listen(0, r));
const API = `http://127.0.0.1:${server.address().port}`;

const machine = (name) => ({
  ...process.env, CLAUDE_USAGE_GIST_TOKEN: "test-token", STATLINE_GITHUB_API: API,
  STATLINE_STORE: `${DIR}/${name}-usage.json`, STATLINE_SYNC_CONFIG: `${DIR}/${name}-sync.json`,
});
const runAsync = (args, env, input) => new Promise((res, rej) => {
  const p = execFile("node", [S, ...args], { env }, (e, out, err) => (e && !args.includes("--quiet") ? rej(new Error(err || e.message)) : res(out + err)));
  if (input) { p.stdin.end(input); }
});
for (const f of ["A-usage.json", "A-sync.json", "B-usage.json", "B-sync.json"]) rmSync(`${DIR}/${f}`, { force: true });

const T0 = 2000000000, RW = T0 + 4 * 86400, R5 = T0 + 3 * 3600;
const reading = (t, p5, pw) => JSON.stringify({ model: { display_name: "Opus 5.5" },
  rate_limits: { five_hour: { used_percentage: p5, resets_at: R5 }, seven_day: { used_percentage: pw, resets_at: RW } } });
const statusline = (who, t, p5, pw) => runAsync([], { ...machine(who), STATLINE_NOW: String(t) }, reading(t, p5, pw));

// Computer A: readings, then set up the gist.
await statusline("A", T0, 10, 40);
await statusline("A", T0 + 600, 20, 42);
console.log("A setup:", (await runAsync(["--sync-setup"], { ...machine("A"), STATLINE_NOW: String(T0 + 700) })).trim().split("\n").join(" | "));
// Computer B: join the same gist, add its own readings, sync.
console.log("B setup:", (await runAsync(["--sync-setup", "abc123"], { ...machine("B"), STATLINE_NOW: String(T0 + 800) })).trim().split("\n").at(-1));
await statusline("B", T0 + 1200, 30, 44);
console.log("B sync :", (await runAsync(["--sync"], { ...machine("B"), STATLINE_NOW: String(T0 + 1300) })).trim());
// Back on A: pull B's readings.
console.log("A sync :", (await runAsync(["--sync"], { ...machine("A"), STATLINE_NOW: String(T0 + 1400) })).trim());

const A = JSON.parse(readFileSync(`${DIR}/A-usage.json`, "utf8"));
const G = JSON.parse(gists.abc123.files["claude-usage.json"].content);
console.log("A readings:", JSON.stringify(A.samples.map((s) => [s[0] - T0, s[1], s[3]])));
console.log("gist readings:", G.samples.length, "| gist public:", gists.abc123.public);
console.log("A file formatted (first 3 lines):\n" + readFileSync(`${DIR}/A-usage.json`, "utf8").split("\n").slice(0, 4).join("\n"));

// Background auto-sync: a status line run with lastSync stale should spawn a sync.
const before = calls.length;
await statusline("B", T0 + 2000, 35, 45);
await new Promise((r) => setTimeout(r, 2500));
console.log("auto-sync calls from status line:", calls.slice(before));

// Bad token -> error logged, status line unaffected.
console.log("bad token:", await runAsync(["--sync"], { ...machine("A"), CLAUDE_USAGE_GIST_TOKEN: "nope" }).catch((e) => e.message.trim()));
server.close();
rmSync(DIR, { recursive: true, force: true });
