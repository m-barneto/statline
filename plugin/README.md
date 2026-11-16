# statline (app band)

A Claude Code plugin that draws a row above the prompt, in the desktop app's Code tab and in the terminal, showing your model, effort, context usage, and 5-hour / weekly plan-limit bars with an estimate of whether you'll run out before each limit resets:

```
Opus 5.5 ●●○○○  ·  █░░░░░░░ 110k/1M  ·  █████▒▒▒ ~150% 5:41pm/7:21pm  ·  ██████▒░ 2d 1h ~97%
```

Install:

```
/plugin install statline --marketplace m-barneto/statline
```

It only reads usage Claude Code already reports and records readings to `~/.claude/statline-usage.json` to learn your usage pattern; it adds nothing to Claude's context. See the [repository README](../README.md) for how to read the band, how the estimates work, and optional sync across computers.
