// Usage history + run-out estimates, ported from statline.mjs so the terminal
// status line and this mod share ~/.claude/statline-usage.json and agree.
// Pure functions: every one takes `now` (epoch seconds) rather than reading a clock.

export const HOUR = 3600
export const WEEK = 7 * 86400
export const FIVE = 5 * HOUR

/** [time, 5h %, 5h reset, weekly %, weekly reset]; null where not reported. */
export type Row = [number, number | null, number | null, number | null, number | null]
export type Store = { samples: Row[] }
export type Projection = { projected: number; outAt: number | null }
export type FiveInfo = { pct: number; resetsAt: number; outAt: number | null }

export const same = (a: number | null | undefined, b: number | null | undefined) =>
  a != null && b != null && Math.abs(a - b) <= 120

export function parseStore(text: string | null): Store {
  try {
    const s = JSON.parse(text ?? '')
    if (Array.isArray(s?.samples)) {
      return { samples: s.samples }
    }
  } catch {}
  return { samples: [] }
}

/** Same 2-space, one-reading-per-line format the terminal script writes. */
export const serialize = (s: Store) =>
  `{\n  "samples": [\n`
  + s.samples.map((x) => '    ' + JSON.stringify(x)).join(',\n') + '\n  ]\n}\n'

/** Union by timestamp, sort, keep 6 weeks, thin readings older than a day to one per 15 min. */
export function tidy(samples: readonly Row[], now: number): Row[] {
  const byT = new Map<number, Row>()
  for (const s of samples) if (Array.isArray(s) && s.length === 5) byT.set(Math.round(s[0]), s)
  const out: Row[] = []
  for (const s of [...byT.values()].sort((a, b) => a[0] - b[0])) {
    if (s[0] < now - 6 * WEEK) continue
    const p = out.at(-1)
    const sameSlot = p !== undefined && s[0] < now - 86400
      && Math.floor(p[0] / 900) === Math.floor(s[0] / 900)
      && (p[2] == null || same(p[2], s[2])) && (p[4] == null || same(p[4], s[4]))
    if (sameSlot) out[out.length - 1] = s
    else out.push(s)
  }
  return out
}

/** Append the reading when it changed (at most once a minute) or every 10 minutes. */
export function record(samples: Row[], row: Row, now: number): boolean {
  if (row[1] == null && row[3] == null) return false
  const last = samples.at(-1)
  if (last) {
    const changed = last[1] !== row[1] || last[3] !== row[3]
    if (now - last[0] < 60 || (!changed && now - last[0] < 600)) return false
  }
  samples.push(row)
  return true
}

const hourOfWeek = (t: number) => { const d = new Date(t * 1000); return d.getDay() * 24 + d.getHours() }
function eachHour(a: number, b: number, fn: (k: number, s: number) => void) {
  for (let t = a; t < b; ) {
    const next = Math.min(b, (Math.floor(t / HOUR) + 1) * HOUR)
    fn(hourOfWeek(t), next - t)
    t = next
  }
}

/** Hour-of-week profile and the 5h→weekly cost ratio, learned from the readings. */
export function history(samples: readonly Row[]) {
  const buckets = new Array<number>(168).fill(0)
  let since: number | null = null, d5 = 0, dw = 0
  let prev: { t: number; p5: number | null; r5: number | null; pw: number | null; rw: number | null } | null = null
  for (const [t, p5, r5, pw, rw] of samples) {
    if (pw != null && rw != null) {
      if (prev?.pw != null && same(prev.rw, rw)) {
        const p = prev
        if (pw > p.pw!) eachHour(p.t, t, (k, s) => { buckets[k] = (buckets[k] ?? 0) + (pw - p.pw!) * s / (t - p.t) })
      } else {
        const from = Math.max(rw - WEEK, prev?.t ?? -Infinity)
        if (pw > 0 && t > from) eachHour(from, t, (k, s) => { buckets[k] = (buckets[k] ?? 0) + pw * s / (t - from) })
        since ??= Math.min(from, t)
      }
    }
    if (prev && p5 != null && prev.p5 != null && pw != null && prev.pw != null
        && same(prev.r5, r5) && same(prev.rw, rw)) {
      const a = p5 - prev.p5, b = pw - prev.pw
      if (a > 0 && b >= 0) { d5 += a; dw += b }
    }
    prev = { t, p5, r5, pw, rw }
  }
  return { buckets, since, ratio: d5 >= 50 ? dw / d5 : null }
}

function linear(pct: number, rate: number, left: number, now: number): Projection {
  const projected = pct + rate * left
  return { projected, outAt: projected >= 100 && rate > 0 ? now + (100 - pct) / rate : null }
}

/** 5h: blend the last 45 minutes' pace with the window average. */
export function projectFiveHour(samples: readonly Row[], pct: number, resetsAt: number, now: number): Projection {
  const left = resetsAt - now, elapsed = FIVE - left
  if (elapsed < 15 * 60 || pct <= 0) return { projected: pct, outAt: null }
  const avg = pct / elapsed
  const recent = samples.filter(([t, p5, r5]) => t >= now - 45 * 60 && p5 != null && same(r5, resetsAt))
  let rate = avg
  if (recent.length >= 2) {
    const a = recent[0]!, b = recent.at(-1)!
    if (b[0] - a[0] >= 10 * 60) rate = 0.5 * Math.max(0, (b[1]! - a[1]!) / (b[0] - a[0])) + 0.5 * avg
  }
  return linear(pct, rate, left, now)
}

/** Weekly: learned hour-of-week pace, paused/capped by 5h lockouts. */
export function projectWeekly(samples: readonly Row[], pct: number, resetsAt: number,
                              five: FiveInfo | null, now: number): Projection {
  const left = resetsAt - now, elapsed = WEEK - left
  const avg = elapsed > 0 ? pct / elapsed : 0
  const prof = history(samples)
  const tracked = prof.since != null ? now - prof.since : 0
  const haveAvg = elapsed >= 12 * HOUR && pct > 0
  const useProfile = tracked >= 2 * 86400
  if (!useProfile && !haveAvg) return { projected: pct, outAt: null }

  const seen = new Array<number>(168).fill(0)
  if (useProfile) eachHour(prof.since!, now, (k, s) => { seen[k] = (seen[k] ?? 0) + s / HOUR })
  const conf = useProfile ? Math.min(1, tracked / WEEK) : 0
  const rateAt = (t: number) => {
    const k = hourOfWeek(t)
    const n = seen[k] ?? 0
    const learned = n >= 0.5 ? (prof.buckets[k] ?? 0) / n / HOUR : avg
    return conf * learned + (1 - conf) * (haveAvg ? avg : learned)
  }

  const ratio = prof.ratio
  let winEnd = five?.resetsAt ?? null
  let budget = five && ratio != null ? (100 - five.pct) * ratio : null
  const STEP = 900, end = now + left
  let total = pct, outAt: number | null = null
  for (let t = now; t < end; t += STEP) {
    const s = Math.min(STEP, end - t)
    let inc = rateAt(t) * s
    if (winEnd != null && five) {
      if (t >= winEnd) {
        while (t >= winEnd) winEnd += FIVE
        budget = ratio != null ? 100 * ratio : null
      }
      if (five.outAt != null && t >= five.outAt && t < five.resetsAt) inc = 0
      if (budget != null) { inc = Math.min(inc, budget); budget -= inc }
    }
    if (outAt == null && total < 100 && total + inc >= 100) outAt = t + s * (100 - total) / inc
    total += inc
  }
  return { projected: total, outAt }
}

// ── formatting ─────────────────────────────────────────────────────────
export const fmtTok = (t: number) =>
  t >= 1_000_000 ? `${+(t / 1_000_000).toFixed(1)}M` : t >= 1000 ? `${Math.round(t / 1000)}k` : `${t}`

export function fmtDur(sec: number) {
  const s = Math.max(0, sec)
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60)
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
/** Today: "4:12pm". Within 24h, another day: "Sat 11:17am". Further: "Sun 2pm". */
export function fmtClock(epoch: number, now: number) {
  const d = new Date(epoch * 1000)
  const h = d.getHours() % 12 || 12, m = d.getMinutes(), ap = d.getHours() < 12 ? 'am' : 'pm'
  const time = `${h}:${String(m).padStart(2, '0')}${ap}`
  if (d.toDateString() === new Date(now * 1000).toDateString()) return time
  return epoch - now < 24 * HOUR ? `${DAYS[d.getDay()]} ${time}` : `${DAYS[d.getDay()]} ${h}${ap}`
}

/** "claude-opus-5-5[1m]" → "Opus 5.5"; anything else passes through. */
export function modelName(id: string) {
  const m = id.replace(/\[.*\]$/, '').match(/^claude-([a-z]+)-(\d+)(?:-(\d+))?/i)
  if (!m) return id
  const family = m[1] ?? ''
  return `${family.charAt(0).toUpperCase()}${family.slice(1)} ${m[2]}${m[3] ? '.' + m[3] : ''}`
}
