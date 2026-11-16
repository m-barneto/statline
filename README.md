# statline

See your Claude Code usage at a glance: model, effort, context, and your 5-hour and weekly plan limits, with an estimate of whether you'll run out before each one resets.

```
Opus 5.5 ●●○○○  ·  █░░░░░░░ 110k/1M  ·  █████▒▒▒ ~150% 5:41pm/7:21pm  ·  ██████▒░ 2d 1h ~97%
```

It comes in two forms that share the same estimates and history:

| | Where it shows | Install |
|---|---|---|
| **App band** ([`plugin/`](plugin)) | A row above the prompt in the Claude desktop app's Code tab (and in the terminal) | Claude Code plugin, below |
| **Terminal status line** ([`terminal/`](terminal)) | Claude Code's status line in a terminal | `node terminal/install.mjs` |

## Reading it

| Part | Meaning |
|---|---|
| `Opus 5.5 ●●○○○` | Model and effort level (low ●○○○○ … max ●●●●●) |
| `█░░░░░░░ 110k/1M` | Context window used / size |
| `██████▒░ 2d 1h` | A plan limit: █ used, ▒ projected by reset at your pace, ░ headroom; time until reset |
| `~97%` (yellow) | Close call: projected 90–99% by reset |
| `~150% 5:41pm/7:21pm` (red) | On pace to run out: projected total, when you'd hit the limit / when it resets |

The first limit bar is the 5-hour window, the second the weekly one. Limit bars appear on Pro / Max / Ultra plans once a session has had its first reply; without them the estimated session cost is shown instead.

## Install the app band

In a terminal Claude Code session:

```
/plugin install statline --marketplace m-barneto/statline
```

Answer `y` to add the marketplace, then pick a scope (user scope makes it load everywhere, the desktop app included). Or from a shell:

```bash
claude plugin install statline --marketplace m-barneto/statline
```

In the desktop app: click **+** next to the prompt box → **Plugins** → **Add marketplace** with `m-barneto/statline` → **Add plugin**.

If this repository is private, installing needs read access to it on GitHub and a git credential for github.com on your machine (an SSH key, or `gh auth login` then `gh auth setup-git`).

## Install the terminal status line

Requires Node 18+.

```bash
node terminal/install.mjs          # copies statline.mjs to ~/.claude and updates settings.json
node terminal/install.mjs --link   # or point settings.json at this repo's file (git pull updates it)
```

The installer backs up anything it changes to `*.bak` and only touches the `statusLine` key in `~/.claude/settings.json`.

## How the estimates work

Every refresh records a reading (time, 5h %, weekly %, reset times) to `~/.claude/statline-usage.json`; both forms read and write it, so they learn from one history and agree.

- **5-hour:** blends your pace over the last 45 minutes with the window average, so it reacts when you speed up or wind down.
- **Weekly:** learns how much you typically use in each hour of the week (Tue 2pm vs Sat 2pm) and sums that over the hours left until reset. Uses plain average pace until there are ~2 days of history, fully learned after a week.
- **5-hour lockouts:** the weekly estimate pauses during a predicted 5-hour lockout, and once it has learned how much weekly % one 5-hour window costs you, caps every future 5-hour window accordingly.

History keeps 6 weeks; readings older than a day are thinned to one per 15 minutes.

## Files it creates

| File | Contents |
|---|---|
| `~/.claude/statline-usage.json` | Usage readings (2-space JSON), kept on this computer only |

## Repository layout

```
.claude-plugin/marketplace.json   makes this repo installable with /plugin install
plugin/                           the app band (Claude Code plugin)
  .claude-plugin/plugin.json
  hooks/register.tsx              reads usage, draws the band
  hooks/estimate.ts               history + projections (port of the terminal logic)
  types/index.d.ts                the plugin's state contract
  tests/statline.test.tsx
terminal/                         the terminal status line
  statline.mjs                    the status line script
  install.mjs
  test/
```

## Customizing

Colours: `C` at the top of `plugin/hooks/register.tsx`, and `PALETTE` at the top of `terminal/statline.mjs` (24-bit hex). Bar width: `BAR` / `LIMIT_WIDTH`. Keep the estimator in `plugin/hooks/estimate.ts` and `terminal/statline.mjs` in step so both forms agree.

## Development

```bash
npm test               # terminal simulation test, then the plugin's tests
npm run validate       # claude plugin validate plugin
claude --plugin-dir plugin   # run a session with your working copy of the band
```
