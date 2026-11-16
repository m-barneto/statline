// Installs the status line into ~/.claude and points Claude Code at it.
//   node install.mjs          copy statline.mjs to ~/.claude (default)
//   node install.mjs --link   use this repo's file directly (git pull updates it)
// Existing files are backed up to *.bak before being changed.
import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const claudeDir = join(homedir(), ".claude");
const repoScript = fileURLToPath(new URL("./statline.mjs", import.meta.url));
const link = process.argv.includes("--link");
const fwd = (p) => p.replace(/\\/g, "/");

mkdirSync(claudeDir, { recursive: true });

// 1. The script itself.
let target = repoScript;
if (!link) {
  target = join(claudeDir, "statline.mjs");
  if (existsSync(target) && readFileSync(target, "utf8") !== readFileSync(repoScript, "utf8")) {
    copyFileSync(target, `${target}.bak`);
    console.log(`Backed up existing script to ${target}.bak`);
  }
  copyFileSync(repoScript, target);
  console.log(`Installed ${target}`);
}
// 2. settings.json → statusLine (everything else left untouched).
const settingsPath = join(claudeDir, "settings.json");
let settings = {};
if (existsSync(settingsPath)) {
  try { settings = JSON.parse(readFileSync(settingsPath, "utf8")); }
  catch { console.error(`Could not parse ${settingsPath}; fix it and re-run.`); process.exit(1); }
}
const statusLine = { type: "command", command: `node "${fwd(target)}"` };
if (JSON.stringify(settings.statusLine) === JSON.stringify(statusLine)) {
  console.log("settings.json already points at this status line.");
} else {
  if (existsSync(settingsPath)) copyFileSync(settingsPath, `${settingsPath}.bak`);
  settings.statusLine = statusLine;
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  console.log(`Updated statusLine in ${settingsPath}`);
}

// 3. Sync status / next steps.
const syncPath = join(claudeDir, "statline-sync.json");
let sync = {};
try { sync = JSON.parse(readFileSync(syncPath, "utf8")); } catch {}
console.log("");
if (sync.gistId && (sync.token || process.env.CLAUDE_USAGE_GIST_TOKEN)) {
  console.log(`Gist sync is set up (${sync.gistId}).`);
} else {
  console.log("Optional: share usage history across computers via a secret gist.");
  console.log(`  1. Put a GitHub token (Gists: read/write) in ${fwd(syncPath)} as {"token": "..."}`);
  console.log(`  2. First computer:   node "${fwd(target)}" --sync-setup`);
  console.log(`     Other computers:  node "${fwd(target)}" --sync-setup <gist-id>`);
}
console.log("\nRestart Claude Code (or wait for the next refresh) to see it.");
