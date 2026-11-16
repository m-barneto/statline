// statline for the Claude app (and terminal): a band above the prompt with the
// model, effort, context meter and 5h / weekly limit bars with run-out estimates.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Limit, Snapshot } from '../types'
import {
  fmtClock, fmtDur, fmtTok, modelName, parseStore, projectFiveHour, projectWeekly,
  record, serialize, tidy, type FiveInfo, type Row,
} from './estimate'

const snap = atom({ plugin: 'statline', key: 'snap' } as const, null)

const C = {
  model: '#8AADF4', ok: '#8CC9A0', warn: '#E8C27A', bad: '#EE8F8F', muted: '#6E7383', effort: '#F5BDE6',
}
const tint = (p: number) => (p < 50 ? C.ok : p < 80 ? C.warn : C.bad)
const projTint = (p: number) => (p < 80 ? C.ok : p < 100 ? C.warn : C.bad)
const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max']
const BAR = 8

const isoToEpoch = (iso?: string) => (iso ? Date.parse(iso) / 1000 : null)

// Per-session values (a reload starts them over).
let effort: string | null = null
let home: string | null = null

async function claudeDir($: EngineInterface) {
  home ??= (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? null
  return home ? `${home.replace(/\\/g, '/')}/.claude` : null
}

// Read usage, update the shared history, project, and publish the snapshot.
async function refresh($: EngineInterface) {
  const now = (await $.clock.now()) / 1000
  const usage = await $.session.usage()
  const model = modelName(await $.session.model())

  if (effort === null) {
    // Before the first request reports one: the saved setting for this model.
    const id = await $.session.model()
    const ms = (await $.settings.read({ key: 'modelSettings' })) as Record<string, { effortLevel?: string }> | undefined
    effort = ms?.[id.replace(/\[.*\]$/, '')]?.effortLevel
      ?? ((await $.settings.read({ key: 'effortLevel' })) as string | undefined) ?? null
  }

  const rl = (kind: string) => usage.rateLimits.find((r) => r.kind === kind)
  const f = rl('five_hour'), w = rl('seven_day')
  const fReset = isoToEpoch(f?.resetsAt), wReset = isoToEpoch(w?.resetsAt)

  // Shared history with the terminal script.
  const dir = await claudeDir($)
  const path = dir ? `${dir}/statline-usage.json` : null
  let store = parseStore(path ? await $.fs.read(path).catch(() => null) : null)
  const row: Row = [Math.round(now), f?.percentUsed ?? null, fReset, w?.percentUsed ?? null, wReset]
  if (record(store.samples, row, now) && path) {
    store = { samples: tidy(store.samples, now) }
    await $.fs.write(path, serialize(store)).catch(() => {})
  }

  let five: Limit | null = null, week: Limit | null = null, fiveInfo: FiveInfo | null = null
  if (f && fReset) {
    const p = projectFiveHour(store.samples, f.percentUsed, fReset, now)
    five = { pct: f.percentUsed, ...p, resetsAt: fReset }
    fiveInfo = { pct: f.percentUsed, resetsAt: fReset, outAt: p.outAt }
  }
  if (w && wReset) {
    week = { pct: w.percentUsed, ...projectWeekly(store.samples, w.percentUsed, wReset, fiveInfo, now), resetsAt: wReset }
  }

  const next: Snapshot = {
    model, effort,
    ctxTokens: usage.context.tokens ?? null, ctxWindow: usage.context.window,
    five, week, cost: usage.cost?.usd ?? null, at: now,
  }
  await update($, snap, () => next)
}

async function safeRefresh($: EngineInterface) {
  await refresh($).catch((err: unknown) => $.ui.log(`statline: ${String(err)}`, { to: 'debug' }))
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await safeRefresh($)
    return started
  })

  on('session.measure', async ($, e, next) => {
    await safeRefresh($)
    return next(e)
  })

  // The effort each main-thread request actually goes out with. turn.step
  // streams, so this is a generator that passes the response straight through.
  on('turn.step', async function* ($, e, next) {
    if ((e as { agentId?: string }).agentId === undefined && typeof e.effort === 'string' && e.effort !== effort) {
      effort = e.effort
      const cur = await read($, snap)
      if (cur) await update($, snap, () => ({ ...cur, effort }))
    }
    return yield* next(e)
  })

  // ── the band ─────────────────────────────────────────────────────────
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const s = await read($, snap)
    if (e.props.hasSurvey || !s) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const now = s.at

    const sep = <Text color={C.muted}>{'  ·  '}</Text>
    const cells = (p: number) => Math.round((Math.min(100, p) / 100) * BAR)

    const ctxPct = s.ctxTokens != null ? Math.round((s.ctxTokens / s.ctxWindow) * 100) : 0
    const ctxFill = cells(ctxPct)

    const limit = (l: Limit) => {
      const used = Math.max(l.pct > 0 ? 1 : 0, cells(l.pct))
      const projCells = l.projected >= 100 ? BAR : Math.min(BAR - 1, cells(l.projected))
      const proj = Math.max(0, projCells - used)
      const left = l.resetsAt != null ? l.resetsAt - now : null
      return (
        <Text>
          <Text color={tint(l.pct)}>{'█'.repeat(used)}</Text>
          <Text color={projTint(l.projected)}>{'▒'.repeat(proj)}</Text>
          <Text color={C.muted}>{'░'.repeat(BAR - used - proj)}</Text>
          {l.outAt != null && l.resetsAt != null ? (
            <Text>
              <Text color={C.bad}>{` ~${Math.round(l.projected)}% ${fmtClock(l.outAt, now)}`}</Text>
              <Text color={C.muted}>{`/${fmtClock(l.resetsAt, now)}`}</Text>
            </Text>
          ) : (
            <Text>
              {left != null ? <Text color={C.muted}>{` ${fmtDur(left)}`}</Text> : null}
              {l.projected >= 90 ? <Text color={C.warn}>{` ~${Math.round(l.projected)}%`}</Text> : null}
            </Text>
          )}
        </Text>
      )
    }

    const lvl = s.effort ? LEVELS.indexOf(s.effort) + 1 : 0

    return (
      <Box>
        <Text mono wrap="truncate-end">
          <Text color={C.model} bold>{s.model}</Text>
          {lvl ? (
            <Text>
              {' '}
              <Text color={C.effort}>{'●'.repeat(lvl)}</Text>
              <Text color={C.muted}>{'○'.repeat(5 - lvl)}</Text>
            </Text>
          ) : s.effort ? <Text color={C.muted}>{` ${s.effort}`}</Text> : null}
          {sep}
          <Text color={tint(ctxPct)}>{'█'.repeat(ctxFill)}</Text>
          <Text color={C.muted}>{'░'.repeat(BAR - ctxFill)}</Text>
          <Text color={C.muted}>
            {` ${s.ctxTokens != null ? fmtTok(s.ctxTokens) : '—'}/${fmtTok(s.ctxWindow)}`}
          </Text>
          {s.five ? <Text>{sep}{limit(s.five)}</Text> : null}
          {s.week ? <Text>{sep}{limit(s.week)}</Text> : null}
          {!s.five && !s.week && s.cost != null
            ? <Text>{sep}<Text color={C.muted}>{`~$${s.cost.toFixed(2)} this session`}</Text></Text>
            : null}
        </Text>
      </Box>
    )
  })
}
