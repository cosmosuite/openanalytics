import { describe, expect, it } from 'vitest'
import { resolveRevenue } from '../../apps/api/src/analytics/resolve.ts'

/**
 * Revenue resolution selection (ADR-0033, D7; ClickHouse migration 0018).
 * Milestone 12 Checkpoint 5.
 *
 * The revenue rollups have exactly the session rollups' shape — 1h and 1d only —
 * so the grain decision is the session decision with money in it. What this pins
 * is the three places that shape bites: no minute grain, a sub-hour zone refused
 * rather than answered wrong, and a non-UTC day composed from hours.
 */

const UTC = 'UTC'
const ISTANBUL = 'Europe/Istanbul' // +03:00, whole-hour
const KATHMANDU = 'Asia/Kathmandu' // +05:45, sub-hour

function servable(result: ReturnType<typeof resolveRevenue>) {
  expect(result.servable, 'servable' in result ? String(result) : '').toBe(true)
  return result as Extract<typeof result, { servable: true }>
}

describe('grain selection', () => {
  it('serves a short UTC range at hour grain from revenue_1h', () => {
    const r = servable(
      resolveRevenue({
        from: '2026-07-20T00:00:00.000Z',
        to: '2026-07-21T00:00:00.000Z',
        timezone: UTC,
      }),
    )
    expect(r.grain).toBe('hour')
    expect(r.timeseriesOperation).toBe('analytics.revenue_timeseries_hour')
    expect(r.summaryOperation).toBe('analytics.revenue_summary_hour')
    expect(r.withTimezone).toBe(true)
  })

  it('has no minute grain — "today" is hourly', () => {
    // The additive family would pick the minute rollup for a six-hour range.
    // Revenue has none, and a per-minute revenue series is noise around
    // individual transactions anyway — the transactions list is that surface.
    const r = servable(
      resolveRevenue({
        from: '2026-07-20T00:00:00.000Z',
        to: '2026-07-20T06:00:00.000Z',
        timezone: UTC,
      }),
    )
    expect(r.grain).toBe('hour')
    expect(r.timeseriesOperation).toBe('analytics.revenue_timeseries_hour')
  })

  it('reads the UTC day rollup for a long UTC range', () => {
    const r = servable(
      resolveRevenue({
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-07-01T00:00:00.000Z',
        timezone: UTC,
      }),
    )
    expect(r.grain).toBe('day')
    expect(r.timeseriesOperation).toBe('analytics.revenue_timeseries_day')
    expect(r.summaryOperation).toBe('analytics.revenue_summary_day')
    // The UTC-day operation binds no zone: it is only ever routed a UTC request.
    expect(r.withTimezone).toBe(false)
  })

  it('composes a non-UTC local day from the hour rollup', () => {
    // So a DST 23- or 25-hour day sums the hours it actually had, rather than
    // wearing a local label over UTC-day buckets.
    const r = servable(
      resolveRevenue({
        from: '2026-01-01T21:00:00.000Z',
        to: '2026-07-01T21:00:00.000Z',
        timezone: ISTANBUL,
      }),
    )
    expect(r.grain).toBe('day')
    expect(r.timeseriesOperation).toBe('analytics.revenue_timeseries_day_local')
    // The summary over the same range reads the hour rollup, so a range the
    // chart can serve is a range the total can serve — they cannot disagree.
    expect(r.summaryOperation).toBe('analytics.revenue_summary_hour')
    expect(r.withTimezone).toBe(true)
  })

  it('snaps the effective range to the source rollup’s boundary', () => {
    const r = servable(
      resolveRevenue({
        from: '2026-07-20T10:37:00.000Z',
        to: '2026-07-21T09:12:00.000Z',
        timezone: UTC,
      }),
    )
    expect(r.effectiveFrom).toBe('2026-07-20T10:00:00.000Z')
    expect(r.effectiveTo).toBe('2026-07-21T09:00:00.000Z')
  })
})

describe('refusals', () => {
  it('serves a sub-hour timezone from revenue_1m rather than misattributing every day edge', () => {
    const r = resolveRevenue({
      from: '2026-07-19T18:15:00.000Z',
      to: '2026-07-20T18:15:00.000Z',
      timezone: KATHMANDU,
    })
    expect(r.servable).toBe(true)
    if (!r.servable) return
    // The minute rollup (migration 0022). +05:45's local hour begins inside a UTC
    // hour bucket, so the hourly operations would misattribute the edge of every
    // bucket — which is what this test was pinning before 0022 existed.
    expect(r.timeseriesOperation).toBe('analytics.revenue_timeseries_hour_1m')
    expect(r.summaryOperation).toBe('analytics.revenue_summary_1m')
    expect(r.withTimezone).toBe(true)
    expect(r.timeseriesOperation).not.toMatch(/_hour$|_day$|_day_local$/)
  })

  it('refuses a sub-hour timezone past the raw-scan cap', () => {
    const r = resolveRevenue({
      // ~180 days, past MAX_SPAN_RAW_DAYS (92).
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-07-01T00:00:00.000Z',
      timezone: KATHMANDU,
    })
    expect(r.servable).toBe(false)
    if (r.servable) return
    expect(r.alignment).toBe('sub-hour')
    expect(r.reason).toMatch(/raw-scan cap/)
  })

  it('refuses a forced minute or week grain', () => {
    for (const resolution of ['minute', 'week'] as const) {
      const r = resolveRevenue({
        from: '2026-07-20T00:00:00.000Z',
        to: '2026-07-21T00:00:00.000Z',
        timezone: UTC,
        resolution,
      })
      expect(r.servable, resolution).toBe(false)
      if (!r.servable) expect(r.reason).toContain('hour or day grain only')
    }
  })

  it('honours a forced day grain on a UTC range', () => {
    const r = servable(
      resolveRevenue({
        from: '2026-07-20T00:00:00.000Z',
        to: '2026-07-21T00:00:00.000Z',
        timezone: UTC,
        resolution: 'day',
      }),
    )
    expect(r.grain).toBe('day')
    expect(r.timeseriesOperation).toBe('analytics.revenue_timeseries_day')
  })

  it('honours a forced hour grain on a long range within the hour cap', () => {
    const r = servable(
      resolveRevenue({
        from: '2026-06-01T00:00:00.000Z',
        to: '2026-07-01T00:00:00.000Z',
        timezone: UTC,
        resolution: 'hour',
      }),
    )
    expect(r.grain).toBe('hour')
  })

  it('refuses an inverted range', () => {
    const r = resolveRevenue({
      from: '2026-07-21T00:00:00.000Z',
      to: '2026-07-20T00:00:00.000Z',
      timezone: UTC,
    })
    expect(r.servable).toBe(false)
  })
})
