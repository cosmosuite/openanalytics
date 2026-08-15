import { describe, expect, it } from 'vitest'
import {
  AnalyticsQueryConfigError,
  DEFAULT_ANALYTICS_QUERY_CONFIG,
  chooseResolution,
  classifyTimezoneAlignment,
  isUtcDayAligned,
  isUtcHourAligned,
  isUtcMinuteAligned,
  loadAnalyticsQueryConfig,
  timezoneOffsetMinutes,
} from '@openanalytics/domain'

/**
 * Rollup selection (docs snapshot 02 §15, plan Milestone 7 items 2 and 7).
 *
 * The invariant under test is that the function never hands back a resolution
 * that would misattribute buckets: a non-UTC day composes from the hour rollup,
 * and a sub-hour zone is refused at hour/day grain rather than answered wrong.
 */

const UTC = 'UTC'
const NY = 'America/New_York' // whole-hour, DST
const BERLIN = 'Europe/Berlin' // whole-hour, DST
const KOLKATA = 'Asia/Kolkata' // +05:30, no DST
const KATHMANDU = 'Asia/Kathmandu' // +05:45, no DST

describe('timezoneOffsetMinutes', () => {
  it('reads whole-hour, half-hour and quarter-hour offsets from the tz database', () => {
    const winter = new Date('2026-01-15T12:00:00.000Z')
    const summer = new Date('2026-07-15T12:00:00.000Z')

    expect(timezoneOffsetMinutes(winter, UTC)).toBe(0)
    // New York shifts -300 (EST) → -240 (EDT) across the year; both whole-hour.
    expect(timezoneOffsetMinutes(winter, NY)).toBe(-300)
    expect(timezoneOffsetMinutes(summer, NY)).toBe(-240)
    expect(timezoneOffsetMinutes(winter, KOLKATA)).toBe(330)
    expect(timezoneOffsetMinutes(winter, KATHMANDU)).toBe(345)
  })
})

describe('classifyTimezoneAlignment', () => {
  const from = new Date('2026-07-01T00:00:00.000Z')
  const to = new Date('2026-07-31T00:00:00.000Z')

  it('separates utc, whole-hour and sub-hour zones', () => {
    expect(classifyTimezoneAlignment(from, to, UTC)).toBe('utc')
    expect(classifyTimezoneAlignment(from, to, NY)).toBe('whole-hour')
    expect(classifyTimezoneAlignment(from, to, BERLIN)).toBe('whole-hour')
    expect(classifyTimezoneAlignment(from, to, KOLKATA)).toBe('sub-hour')
    expect(classifyTimezoneAlignment(from, to, KATHMANDU)).toBe('sub-hour')
  })

  it('classifies a DST-spanning range by its worst end', () => {
    // Lord Howe is +11:00 in the austral summer and +10:30 in winter, so a
    // range spanning the change has one whole-hour end and one sub-hour end.
    const summer = new Date('2026-01-01T00:00:00.000Z')
    const winter = new Date('2026-06-01T00:00:00.000Z')
    expect(classifyTimezoneAlignment(summer, winter, 'Australia/Lord_Howe')).toBe('sub-hour')
  })
})

describe('chooseResolution — grain by span (§15)', () => {
  it('uses minute grain for today and shorter', () => {
    const decision = chooseResolution({
      from: '2026-07-23T00:00:00.000Z',
      to: '2026-07-23T18:00:00.000Z',
      timezone: UTC,
    })
    expect(decision.grain).toBe('minute')
    expect(decision.sourceRollup).toBe('1m')
    expect(decision.servable).toBe(true)
  })

  it('uses hour grain for a week', () => {
    const decision = chooseResolution({
      from: '2026-07-16T00:00:00.000Z',
      to: '2026-07-23T00:00:00.000Z',
      timezone: UTC,
    })
    expect(decision.grain).toBe('hour')
    expect(decision.sourceRollup).toBe('1h')
  })

  it('uses day grain for a quarter', () => {
    const decision = chooseResolution({
      from: '2026-04-24T00:00:00.000Z',
      to: '2026-07-23T00:00:00.000Z',
      timezone: UTC,
    })
    expect(decision.grain).toBe('day')
    expect(decision.sourceRollup).toBe('1d')
    expect(decision.composeDayFromHour).toBe(false)
  })
})

describe('chooseResolution — timezone composition', () => {
  it('reads the day rollup directly only for UTC', () => {
    const decision = chooseResolution({
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-07-01T00:00:00.000Z',
      timezone: UTC,
    })
    expect(decision.sourceRollup).toBe('1d')
    expect(decision.composeDayFromHour).toBe(false)
  })

  it('composes a non-UTC day from the hour rollup, never the day rollup', () => {
    // A whole-hour, DST zone over six months: day grain, but the *_1d table is
    // UTC-bucketed and would be wrong, so it composes from *_1h.
    const decision = chooseResolution({
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-07-01T00:00:00.000Z',
      timezone: NY,
    })
    expect(decision.grain).toBe('day')
    expect(decision.sourceRollup).toBe('1h')
    expect(decision.composeDayFromHour).toBe(true)
    expect(decision.servable).toBe(true)
  })

  it('serves a whole-hour zone at hour grain from the hour rollup', () => {
    const decision = chooseResolution({
      from: '2026-07-16T00:00:00.000Z',
      to: '2026-07-23T00:00:00.000Z',
      timezone: BERLIN,
    })
    expect(decision.grain).toBe('hour')
    expect(decision.sourceRollup).toBe('1h')
    expect(decision.composeDayFromHour).toBe(false)
  })
})

describe('chooseResolution — sub-hour zones read raw rather than a misaligned rollup', () => {
  it('serves a sub-hour zone at minute grain (minute buckets align to any offset)', () => {
    const decision = chooseResolution({
      from: '2026-07-23T00:00:00.000Z',
      to: '2026-07-23T12:00:00.000Z',
      timezone: KATHMANDU,
    })
    expect(decision.grain).toBe('minute')
    expect(decision.sourceRollup).toBe('1m')
    expect(decision.servable).toBe(true)
  })

  it('serves a sub-hour zone at hour grain from raw events', () => {
    const decision = chooseResolution({
      from: '2026-07-16T00:00:00.000Z',
      to: '2026-07-23T00:00:00.000Z',
      timezone: KOLKATA,
    })
    expect(decision.servable).toBe(true)
    expect(decision.grain).toBe('hour')
    expect(decision.sourceRollup).toBe('raw')
    expect(decision.timezoneAlignment).toBe('sub-hour')
    // The caveat still names the zone class, so a caller can tell a raw-backed
    // answer from a rollup-backed one without re-deriving the classification.
    expect(decision.reason).toMatch(/sub-hour/)
  })

  it('serves a sub-hour zone at day grain from raw events inside the raw cap', () => {
    const decision = chooseResolution({
      from: '2026-04-01T00:00:00.000Z',
      to: '2026-06-01T00:00:00.000Z',
      timezone: KATHMANDU,
    })
    expect(decision.servable).toBe(true)
    expect(decision.grain).toBe('day')
    expect(decision.sourceRollup).toBe('raw')
    // Never set for a raw read: there are no hour buckets to compose a day from.
    expect(decision.composeDayFromHour).toBe(false)
  })

  it('refuses a sub-hour zone past the raw-scan cap, naming the cap not the zone', () => {
    const decision = chooseResolution({
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-07-01T00:00:00.000Z',
      timezone: KATHMANDU,
    })
    expect(decision.servable).toBe(false)
    expect(decision.sourceRollup).toBe('raw')
    expect(decision.reason).toMatch(/raw-scan cap/)
  })
})

describe('chooseResolution — cost caps and bad input', () => {
  it('refuses a day range longer than the day-rollup cap', () => {
    const decision = chooseResolution({
      from: '1990-01-01T00:00:00.000Z',
      to: '2026-07-23T00:00:00.000Z',
      timezone: UTC,
    })
    expect(decision.servable).toBe(false)
    expect(decision.reason).toMatch(/day-rollup cap/)
  })

  it('refuses a non-UTC day range past the hour-rollup cap', () => {
    // 2 years composed from hours exceeds the 400-day hour cap.
    const decision = chooseResolution({
      from: '2024-01-01T00:00:00.000Z',
      to: '2026-01-01T00:00:00.000Z',
      timezone: NY,
    })
    expect(decision.servable).toBe(false)
    expect(decision.reason).toMatch(/hour-rollup cap/)
  })

  it('refuses an inverted range without throwing', () => {
    const decision = chooseResolution({
      from: '2026-07-23T00:00:00.000Z',
      to: '2026-07-22T00:00:00.000Z',
      timezone: UTC,
    })
    expect(decision.servable).toBe(false)
    expect(decision.reason).toMatch(/half-open/)
  })

  it('refuses an invalid timezone without throwing', () => {
    const decision = chooseResolution({
      from: '2026-07-23T00:00:00.000Z',
      to: '2026-07-23T12:00:00.000Z',
      timezone: 'Mars/Phobos',
    })
    expect(decision.servable).toBe(false)
  })
})

describe('analytics query config invariants', () => {
  it('defaults are internally consistent', () => {
    expect(DEFAULT_ANALYTICS_QUERY_CONFIG.MINUTE_GRAIN_MAX_HOURS).toBe(24)
    expect(DEFAULT_ANALYTICS_QUERY_CONFIG.HOUR_GRAIN_MAX_DAYS).toBe(31)
  })

  it('rejects a grain threshold that outruns its source cap', () => {
    expect(() => loadAnalyticsQueryConfig({ MINUTE_GRAIN_MAX_HOURS: '100' })).toThrow(
      AnalyticsQueryConfigError,
    )
  })

  it('rejects unordered source caps', () => {
    expect(() =>
      loadAnalyticsQueryConfig({ MAX_SPAN_HOUR_DAYS: '900', MAX_SPAN_DAY_DAYS: '400' }),
    ).toThrow(AnalyticsQueryConfigError)
  })
})

describe('UTC alignment helpers', () => {
  it('recognises minute, hour and day boundaries', () => {
    expect(isUtcMinuteAligned('2026-07-23T10:30:00.000Z')).toBe(true)
    expect(isUtcMinuteAligned('2026-07-23T10:30:15.000Z')).toBe(false)

    expect(isUtcHourAligned('2026-07-23T10:00:00.000Z')).toBe(true)
    expect(isUtcHourAligned('2026-07-23T10:30:00.000Z')).toBe(false)

    expect(isUtcDayAligned('2026-07-23T00:00:00.000Z')).toBe(true)
    expect(isUtcDayAligned('2026-07-23T01:00:00.000Z')).toBe(false)
  })
})
