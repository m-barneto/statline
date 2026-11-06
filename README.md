# statline

A single-file, dependency-free status line for Claude Code that shows the model, effort, context usage, and your plan limits, with an estimate of whether you'll run out before each limit resets.

```
Opus 5.5 ●●○○○  ·  ██░░░░░░ 305k/1M  ·  █████▒▒▒ 2h 59m ~150% (5:32pm)  ·  ██████▒░ 2d 1h ~97%
```

| Part | Meaning |
|---|---|
| `Opus 5.5 ●●○○○` | Model and effort level (low ●○○○○ … max ●●●●●) |
| `██░░░░░░ 305k/1M` | Context window used / size |
| `█████▒▒▒ 2h 59m` | 5-hour limit: █ used, ▒ projected by reset, ░ headroom; time until reset |
| `██████▒░ 2d 1h` | Weekly limit, same layout |
| `~97%` (yellow) | Close call: projected 90–99% by reset |
| `~150% (5:32pm)` (red) | On pace to run out: projected total at your pace, and when you'd hit the limit |

Limit bars only appear on Pro / Max / Ultra plans (Claude Code sends them after the session's first reply). Without them, the estimated session cost is shown instead.

## Install

Requires Node 18+.

```bash
node install.mjs          # copies statline.mjs to ~/.claude and updates settings.json
node install.mjs --link   # or point settings.json at this repo's file (git pull updates it)
```

The installer backs up anything it changes to `*.bak` and only touches the `statusLine` key in `~/.claude/settings.json`.

## How the estimates work

Every refresh records a reading (time, 5h %, weekly %, reset times) to `~/.claude/statline-usage.json`. Estimates are derived from that history:

- **5-hour:** blends your pace over the last 45 minutes with the window average, so it reacts when you speed up or wind down.
- **Weekly:** learns how much you typically use in each hour of the week (Tue 2pm vs Sat 2pm) and sums that over the hours left until reset. Uses plain average pace until there are ~2 days of history, fully learned after a week.
- **5-hour lockouts:** the weekly estimate pauses during a predicted 5-hour lockout, and once it has learned how much weekly % one 5-hour window costs you, caps every future 5-hour window accordingly.

History keeps 6 weeks; readings older than a day are thinned to one per 15 minutes.

## Sync across computers (optional)

Limits are account-wide, so readings from any computer describe the same usage. Sharing the history through a **secret GitHub gist** lets every computer learn from all of it.

1. Create a fine-grained GitHub token with only **Account permissions → Gists: Read and write**.
2. Create `~/.claude/statline-sync.json`:
   ```json
   {
     "token": "<your token>"
   }
   ```
   (Or set `CLAUDE_USAGE_GIST_TOKEN`, which takes precedence.)
3. First computer: `node ~/.claude/statline.mjs --sync-setup` — creates the gist and saves its id.
4. Other computers: `node ~/.claude/statline.mjs --sync-setup <gist-id>`

The status line then syncs in the background at most every 5 minutes. `--sync` syncs on demand. Errors go to `~/.claude/statline-usage-sync.log`; the status line keeps working from the local copy.

Secret gists are unlisted, not private: anyone with the link can read them. The gist only ever contains timestamps and percentages — never the token.

## Customizing

Colours live in the `PALETTE` block at the top of `statline.mjs` (24-bit hex). Bar widths are `bar(pct, width = 8)` and `LIMIT_WIDTH`.

## Files it creates

| File | Contents |
|---|---|
| `~/.claude/statline-usage.json` | Usage readings (2-space JSON) |
| `~/.claude/statline-sync.json` | Gist id and token — keep it out of any repo |
| `~/.claude/statline-usage-sync.log` | Last sync result |

## Tests

```bash
npm test
```

- `test/sim.mjs` — simulates 2½ weeks of weekday 9–5 usage and checks the learned weekly projection lands on the true total.
- `test/synctest.mjs` — runs two "computers" against a local mock of the GitHub gist API and checks setup, merging, background sync, and bad-token handling.
