import { z } from 'zod'
import { isValidTimezone, type Resolution } from '@openanalytics/contracts'

/**
 * Dashboard rollup selection (docs snapshot 02 §15 "Dashboard query rule",
 * plan Milestone 7 item 7).
 *
 * This is the one place that decides which rollup family answers a
 * `[from, to)` request in a given IANA timezone, and it is deliberately pure so
 * that both the query gateway (Checkpoint B) and the read API (Checkpoint C)
 * reach the same decision from the same inputs. §15's rule is span-based:
 *
 *   - today / realtime       → minute (or hour)
 *   - 7–30 days              → hour (or day)
 *   - 90 days, 6 mo, 1 y, all → day
 *
 * ### The timezone problem
 *
 * Every rollup buckets on `occurred_at` at **UTC** boundaries (migrations
 * 0003–0012): `metrics_1d.bucket_start` is a UTC midnight, `*_1h.bucket_start`
 * a UTC hour. A site's "day", however, begins at midnight in its own IANA
 * timezone. So a non-UTC day cannot be read from `*_1d` — its UTC-day buckets
 * straddle two local days. It must be composed from `*_1h` with ClickHouse's
 * timezone-aware `toStartOfDay(bucket_start, {tz:String})`, which also produces
 * the correct 23-/25-hour days across a DST transition.
 *
 * That composition only works when each UTC **hour** belongs wholly to one
 * local day — i.e. when the zone's offset is a whole number of hours. Zones
 * with a sub-hour offset (Asia/Kolkata +05:30, Asia/Kathmandu +05:45,
 * Australia/Lord_Howe +10:30) have a local-midnight — and every local hour
 * boundary — that falls in the *middle* of a UTC hour, so no `*_1h` bucket can
 * be split to honour it. The minute rollup (`metrics_1m`) aligns to any
 * whole-minute offset and every IANA offset is a whole number of minutes, so it
 * could compose sub-hour local hours/days — but only `metrics` has a minute
 * rollup, so it cannot answer for the other nine families.
 *
 * What every family *does* have is `events_raw`, which stores `occurred_at` as a
 * `DateTime64(3, 'UTC')` and is ordered `(site_id, occurred_at, event_id)`. A
 * whole-minute offset applied to an instant is exact, so
 * `toStartOfHour(toTimeZone(occurred_at, {tz:String}))` cuts a correct local
 * bucket for *any* IANA zone — the same read Plausible does, and the reason it
 * has no alignment classes to speak of. What it costs is a row scan instead of a
 * bucket scan, which is why {@link AnalyticsQueryConfig.MAX_SPAN_RAW_DAYS} caps
 * it far below the rollup spans rather than letting a year of a busy site
 * through.
 *
 * So a sub-hour zone is served from raw within that cap and refused beyond it,
 * with the reason naming the cap. Previously it was refused outright, which read
 * to a viewer in Asia/Kolkata (a fifth of the planet) as a broken dashboard: the
 * timezone picker offers the zone, and every chart then fails. Returning
 * misattributed buckets is still never an option — that is what the rollup path
 * cannot do and why this seam exists at all.
 *
 * The rule this encodes, therefore:
 *
 * | timezone class | minute grain | hour grain   | day grain            |
 * |----------------|--------------|--------------|----------------------|
 * | UTC            | `metrics_1m` | `*_1h`       | `*_1d` (direct)      |
 * | whole-hour     | `metrics_1m` | `*_1h`       | `*_1h` via toStartOfDay(tz) |
 * | sub-hour       | `metrics_1m` | `events_raw` | `events_raw`         |
 *
 * Timezone is never spliced into SQL here: this module only *classifies* the
 * zone and picks a resolution. The gateway binds the zone as a `{tz:String}`
 * parameter (docs snapshot 02 §18).
 */

/**
 * Which source answers the query.
 *
 * `raw` is not a rollup: it is `events_raw` itself, read with
 * `toStartOfHour(toTimeZone(occurred_at, {tz:String}))`. It exists for the one
 * class no rollup can serve honestly — a sub-hour zone (see the class table
 * above) — where the alternative is not a cheaper answer but a wrong one. It is
 * span-capped harder than any rollup because it scans rows rather than buckets,
 * and a caller that lands on it is told so via {@link QueryResolution.reason}.
 */
export const ROLLUP_RESOLUTIONS = ['1m', '1h', '1d', 'raw'] as const
export type RollupResolution = (typeof ROLLUP_RESOLUTIONS)[number]

/** How the requested zone's UTC offset aligns to rollup bucket boundaries. */
export const TIMEZONE_ALIGNMENTS = ['utc', 'whole-hour', 'sub-hour'] as const
export type TimezoneAlignment = (typeof TIMEZONE_ALIGNMENTS)[number]

const MS_PER_HOUR = 3_600_000
const MS_PER_DAY = 86_400_000

/**
 * Engineering values for rollup selection (docs snapshot 02 §5: typed config,
 * not scattered literals). None of these is a `GATE` value in
 * docs snapshot 05 — G-005 enumerates abuse ceilings and rate limits, not query
 * planning — so they are ordinary defaults with recorded invariants, mirroring
 * the precedent `policy.ts` sets.
 */
export const analyticsQueryConfigSchema = z
  .object({
    /**
     * Longest span still answered at minute grain. "Today" (≤24h) and shorter
     * recent ranges get the minute rollup; 48h keeps a "yesterday + today"
     * view at minute grain without spilling into a week of minute buckets.
     */
    MINUTE_GRAIN_MAX_HOURS: z.coerce.number().int().min(1).max(168).default(24),
    /**
     * Longest span answered at hour grain. Beyond a month the chart moves to
     * day grain (§15: 90 days and up are day-grain), and an hourly chart past a
     * month is more points than a dashboard renders usefully.
     */
    HOUR_GRAIN_MAX_DAYS: z.coerce.number().int().min(1).max(400).default(31),

    /** Hard cap on a minute-rollup scan, independent of grain selection. */
    MAX_SPAN_MINUTE_HOURS: z.coerce.number().int().min(1).max(336).default(48),
    /**
     * Hard cap on an hour-rollup scan. It must clear a full year, because a
     * non-UTC "1 year" day chart composes its days from `*_1h` (see the class
     * table above) — 366 days × 24 = 8 784 hour buckets per series.
     */
    MAX_SPAN_HOUR_DAYS: z.coerce.number().int().min(1).max(1_000).default(400),
    /** Hard cap on a day-rollup scan — the "all time" ceiling for UTC sites. */
    MAX_SPAN_DAY_DAYS: z.coerce.number().int().min(1).max(36_600).default(3_660),
    /**
     * Hard cap on a raw-events scan, the sub-hour zone's only source.
     *
     * Deliberately the tightest cap here: this reads rows, not buckets, so its
     * cost scales with a site's traffic rather than with elapsed time. 92 days
     * covers the dashboard's "today", 7d, 30d and 90d presets — every range a
     * sub-hour viewer reaches by clicking rather than by hand — and refuses the
     * 6-month/1-year/all presets, where a busy site would turn one chart into a
     * multi-hundred-million-row scan. A self-hoster who knows their volume can
     * raise it; the default protects the person who does not.
     */
    MAX_SPAN_RAW_DAYS: z.coerce.number().int().min(1).max(3_660).default(92),
  })
  .superRefine((config, ctx) => {
    // A grain can only be offered up to the span its own source rollup is
    // allowed to scan; otherwise selection would hand back a resolution the
    // range-bound check then rejects.
    if (config.MINUTE_GRAIN_MAX_HOURS > config.MAX_SPAN_MINUTE_HOURS) {
      ctx.addIssue({
        code: 'custom',
        path: ['MINUTE_GRAIN_MAX_HOURS'],
        message:
          `MINUTE_GRAIN_MAX_HOURS (${config.MINUTE_GRAIN_MAX_HOURS}h) must not exceed ` +
          `MAX_SPAN_MINUTE_HOURS (${config.MAX_SPAN_MINUTE_HOURS}h)`,
      })
    }
    if (config.HOUR_GRAIN_MAX_DAYS > config.MAX_SPAN_HOUR_DAYS) {
      ctx.addIssue({
        code: 'custom',
        path: ['HOUR_GRAIN_MAX_DAYS'],
        message:
          `HOUR_GRAIN_MAX_DAYS (${config.HOUR_GRAIN_MAX_DAYS}d) must not exceed ` +
          `MAX_SPAN_HOUR_DAYS (${config.MAX_SPAN_HOUR_DAYS}d)`,
      })
    }
    // Grain thresholds must be ordered: the minute band ends before the hour
    // band does, or a span could match both and the result would depend on
    // check order.
    if (config.MINUTE_GRAIN_MAX_HOURS / 24 >= config.HOUR_GRAIN_MAX_DAYS) {
      ctx.addIssue({
        code: 'custom',
        path: ['MINUTE_GRAIN_MAX_HOURS'],
        message:
          `MINUTE_GRAIN_MAX_HOURS (${config.MINUTE_GRAIN_MAX_HOURS}h) must be shorter than ` +
          `HOUR_GRAIN_MAX_DAYS (${config.HOUR_GRAIN_MAX_DAYS}d)`,
      })
    }
    // Source caps must be ordered coarsest-longest: a finer rollup never
    // outscans a coarser one.
    if (config.MAX_SPAN_HOUR_DAYS > config.MAX_SPAN_DAY_DAYS) {
      ctx.addIssue({
        code: 'custom',
        path: ['MAX_SPAN_HOUR_DAYS'],
        message:
          `MAX_SPAN_HOUR_DAYS (${config.MAX_SPAN_HOUR_DAYS}d) must not exceed ` +
          `MAX_SPAN_DAY_DAYS (${config.MAX_SPAN_DAY_DAYS}d)`,
      })
    }
  })

export type AnalyticsQueryConfig = z.infer<typeof analyticsQueryConfigSchema>

export class AnalyticsQueryConfigError extends Error {
  readonly issues: readonly { path: string; message: string }[]

  constructor(error: z.ZodError) {
    const issues = error.issues.map((issue) => ({
      path: issue.path.join('.') || '(root)',
      message: issue.message,
    }))
    super(
      `Invalid analytics query configuration:\n${issues
        .map((issue) => `  - ${issue.path}: ${issue.message}`)
        .join('\n')}`,
    )
    this.name = 'AnalyticsQueryConfigError'
    this.issues = issues
  }
}

export function loadAnalyticsQueryConfig(
  source: Record<string, string | undefined> = process.env,
): AnalyticsQueryConfig {
  const result = analyticsQueryConfigSchema.safeParse(source)
  if (!result.success) {
    throw new AnalyticsQueryConfigError(result.error)
  }
  return result.data
}

/** Defaults, resolved once. The gateway's per-operation span caps read these. */
export const DEFAULT_ANALYTICS_QUERY_CONFIG: AnalyticsQueryConfig = loadAnalyticsQueryConfig({})

/**
 * UTC offset, in minutes, that `timezone` had at `instant`.
 *
 * Read from the runtime's own timezone database via `longOffset` ("GMT+05:45"),
 * so DST and historical shifts are honoured rather than approximated. `GMT`
 * with no suffix is offset zero.
 */
export function timezoneOffsetMinutes(instant: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    timeZoneName: 'longOffset',
  }).formatToParts(instant)
  const name = parts.find((part) => part.type === 'timeZoneName')?.value ?? 'GMT'
  const match = /GMT([+-])(\d{2}):(\d{2})/.exec(name)
  if (!match) return 0
  const sign = match[1] === '-' ? -1 : 1
  return sign * (Number(match[2]) * 60 + Number(match[3]))
}

/**
 * Interior sampling step for {@link classifyTimezoneAlignment}.
 *
 * Endpoints alone are not enough: a range whose two ends share a whole-hour
 * offset can still enclose a stretch on a *different* offset. Australia/Lord_Howe
 * is the worst case — it runs +11:00 in its summer DST and +10:30 (sub-hour) for
 * the ~six standard-time months between. A range from one summer to the next
 * samples +11:00 at both ends and would be called `whole-hour`, then compose
 * local days from the hour rollup across a stretch the hour rollup cannot honour.
 *
 * So the interior is walked too. A daily step catches any offset regime that
 * lasts a day or more, which every real IANA sub-hour period does (the shortest
 * is months). The walk is bounded to {@link MAX_ALIGNMENT_SAMPLES} `Intl` lookups
 * regardless of range length: up to that many days it steps daily; past it (only
 * for ranges longer than ~two years, which are already beyond the hour-rollup
 * composed-day domain and refused by the span caps) it coarsens the step to stay
 * cheap. The step is not a correctness knob a caller sets — it is fixed here so
 * the classification a caller gets is the same one the gateway's range check
 * enforces.
 */
const ALIGNMENT_SAMPLE_STEP_MS = MS_PER_DAY

/**
 * Ceiling on interior samples, so a pathological multi-decade range cannot turn
 * classification into thousands of `Intl` lookups. Chosen above the hour-rollup
 * cap (400 days) so every range that can actually be composed from the hour
 * rollup — the only case where a missed interior sub-hour stretch would matter —
 * is still sampled at full daily granularity.
 */
const MAX_ALIGNMENT_SAMPLES = 750

/**
 * How the zone aligns to UTC bucket boundaries across the whole of `[from, to)`.
 *
 * The offset is sampled at both ends **and** at every interior day boundary, so a
 * range that dips through a sub-hour offset in its middle (Lord Howe's +10:30
 * between two +11:00 summers) is classified by its worst sample, not by its ends.
 * `utc` requires a zero offset at every sample; `whole-hour` requires every
 * sample to be a whole number of hours; anything else is `sub-hour`. A worse
 * sample can only *demote* the result (utc → whole-hour → sub-hour), so the walk
 * can stop the moment it sees a sub-hour offset.
 */
export function classifyTimezoneAlignment(
  from: Date,
  to: Date,
  timezone: string,
): TimezoneAlignment {
  const fromMs = from.getTime()
  const toMs = to.getTime()
  let sawNonZero = false

  // Daily by default; coarsened only when the range is long enough that a daily
  // walk would exceed the sample budget (see MAX_ALIGNMENT_SAMPLES).
  const step = Math.max(
    ALIGNMENT_SAMPLE_STEP_MS,
    Math.ceil((toMs - fromMs) / MAX_ALIGNMENT_SAMPLES),
  )

  // Both endpoints and every step boundary strictly inside the range. `to` is
  // exclusive (the range is half-open) so it is sampled but a bucket starting at
  // `to` is not part of the answer; sampling it is harmless and catches an
  // end-exact transition.
  for (let at = fromMs; ; at += step) {
    const sampleAt = at > toMs ? toMs : at
    const offset = timezoneOffsetMinutes(new Date(sampleAt), timezone)
    if (offset % 60 !== 0) return 'sub-hour'
    if (offset !== 0) sawNonZero = true
    if (sampleAt === toMs) break
  }

  return sawNonZero ? 'whole-hour' : 'utc'
}

export interface ResolutionInput {
  /** Half-open range start, ISO-8601 UTC instant. */
  readonly from: string
  /** Half-open range end (exclusive), ISO-8601 UTC instant. */
  readonly to: string
  /** IANA timezone the caller's calendar boundaries are expressed in. */
  readonly timezone: string
}

export interface QueryResolution {
  /**
   * Bucket size of the answer. `chooseResolution` only ever picks
   * `minute`/`hour`/`day`; `week` reaches here solely through
   * {@link resolveForcedGrain}, which the caller opts into.
   */
  readonly grain: Resolution
  /** Rollup family to read. */
  readonly sourceRollup: RollupResolution
  /**
   * Whether a day-grain answer must be composed with `toStartOfDay(bucket, tz)`
   * over an hour rollup (`true`) rather than read straight from a day rollup
   * (`false`). Only meaningful when `grain === 'day'`.
   */
  readonly composeDayFromHour: boolean
  readonly timezoneAlignment: TimezoneAlignment
  readonly requestedSpanMs: number
  /** `false` when no rollup can answer this range/timezone honestly. */
  readonly servable: boolean
  /** Set when `servable` is false, or as a caveat on the chosen resolution. */
  readonly reason?: string
}

/**
 * The sub-hour answer, shared by automatic and forced selection so both refuse
 * at exactly the same span — a forced grain must never reach a source the
 * automatic ladder would have declined.
 *
 * `composeDayFromHour` stays `false` for every grain here, including `day`: that
 * flag means "compose local days over an *hour rollup*", and a raw read has no
 * hour buckets to compose from. It cuts the local day straight off `occurred_at`
 * instead, so a gateway branching on the flag would build the wrong query.
 */
function serveRaw(
  grain: Resolution,
  alignment: TimezoneAlignment,
  spanMs: number,
  spanDays: number,
  config: AnalyticsQueryConfig,
): QueryResolution {
  if (spanDays > config.MAX_SPAN_RAW_DAYS) {
    return {
      grain,
      sourceRollup: 'raw',
      composeDayFromHour: false,
      timezoneAlignment: alignment,
      requestedSpanMs: spanMs,
      servable: false,
      reason:
        `${grain} grain in a sub-hour timezone reads raw events, and span ${spanDays.toFixed(1)}d ` +
        `exceeds the ${config.MAX_SPAN_RAW_DAYS}d raw-scan cap`,
    }
  }
  return {
    grain,
    sourceRollup: 'raw',
    composeDayFromHour: false,
    timezoneAlignment: alignment,
    requestedSpanMs: spanMs,
    servable: true,
    // A caveat, not a refusal: the answer is correct, and the caller may want to
    // know it cost a row scan — the freshness/telemetry surfaces read this.
    reason: 'sub-hour timezone offset: served from raw events rather than a rollup',
  }
}

/**
 * Picks the rollup resolution for a `[from, to)` range in an IANA timezone.
 *
 * Pure and total: it never throws. An inverted or malformed range comes back
 * `servable: false` rather than as an exception, so a caller can render a
 * message from `reason`. The gateway still validates the instants and the
 * `from < to` invariant on its own before binding.
 */
export function chooseResolution(
  input: ResolutionInput,
  config: AnalyticsQueryConfig = DEFAULT_ANALYTICS_QUERY_CONFIG,
): QueryResolution {
  const fromMs = Date.parse(input.from)
  const toMs = Date.parse(input.to)

  if (Number.isNaN(fromMs) || Number.isNaN(toMs) || !isValidTimezone(input.timezone)) {
    return {
      grain: 'day',
      sourceRollup: '1d',
      composeDayFromHour: false,
      timezoneAlignment: 'utc',
      requestedSpanMs: 0,
      servable: false,
      reason: 'range instants or timezone are invalid',
    }
  }

  const spanMs = toMs - fromMs
  if (spanMs <= 0) {
    return {
      grain: 'day',
      sourceRollup: '1d',
      composeDayFromHour: false,
      timezoneAlignment: 'utc',
      requestedSpanMs: spanMs,
      servable: false,
      reason: 'range must be half-open with from < to',
    }
  }

  const alignment = classifyTimezoneAlignment(new Date(fromMs), new Date(toMs), input.timezone)

  // Grain by span (§15).
  let grain: Resolution
  if (spanMs <= config.MINUTE_GRAIN_MAX_HOURS * MS_PER_HOUR) {
    grain = 'minute'
  } else if (spanMs <= config.HOUR_GRAIN_MAX_DAYS * MS_PER_DAY) {
    grain = 'hour'
  } else {
    grain = 'day'
  }

  const notServable = (reason: string): QueryResolution => ({
    grain,
    sourceRollup: '1m',
    composeDayFromHour: false,
    timezoneAlignment: alignment,
    requestedSpanMs: spanMs,
    servable: false,
    reason,
  })

  const spanHours = spanMs / MS_PER_HOUR
  const spanDays = spanMs / MS_PER_DAY

  if (grain === 'minute') {
    if (spanHours > config.MAX_SPAN_MINUTE_HOURS) {
      return notServable(
        `minute grain span ${spanHours.toFixed(1)}h exceeds the ${config.MAX_SPAN_MINUTE_HOURS}h minute-rollup cap`,
      )
    }
    // Minute buckets align to any whole-minute offset — every IANA zone.
    return {
      grain,
      sourceRollup: '1m',
      composeDayFromHour: false,
      timezoneAlignment: alignment,
      requestedSpanMs: spanMs,
      servable: true,
    }
  }

  if (grain === 'hour') {
    if (alignment === 'sub-hour') {
      return serveRaw(grain, alignment, spanMs, spanDays, config)
    }
    if (spanDays > config.MAX_SPAN_HOUR_DAYS) {
      return notServable(
        `hour grain span ${spanDays.toFixed(1)}d exceeds the ${config.MAX_SPAN_HOUR_DAYS}d hour-rollup cap`,
      )
    }
    return {
      grain,
      sourceRollup: '1h',
      composeDayFromHour: false,
      timezoneAlignment: alignment,
      requestedSpanMs: spanMs,
      servable: true,
    }
  }

  // grain === 'day'
  if (alignment === 'sub-hour') {
    return serveRaw(grain, alignment, spanMs, spanDays, config)
  }

  if (alignment === 'utc') {
    if (spanDays > config.MAX_SPAN_DAY_DAYS) {
      return notServable(
        `day grain span ${spanDays.toFixed(1)}d exceeds the ${config.MAX_SPAN_DAY_DAYS}d day-rollup cap`,
      )
    }
    // UTC days == the day rollup's own buckets: read it directly.
    return {
      grain,
      sourceRollup: '1d',
      composeDayFromHour: false,
      timezoneAlignment: alignment,
      requestedSpanMs: spanMs,
      servable: true,
    }
  }

  // whole-hour, non-UTC: compose local days from the hour rollup so DST 23/25h
  // days are correct. The day rollup would be UTC-day-bucketed and therefore
  // wrong for this zone.
  if (spanDays > config.MAX_SPAN_HOUR_DAYS) {
    return notServable(
      `day grain for a non-UTC timezone composes from the hour rollup, and span ${spanDays.toFixed(
        1,
      )}d exceeds the ${config.MAX_SPAN_HOUR_DAYS}d hour-rollup cap`,
    )
  }
  return {
    grain,
    sourceRollup: '1h',
    composeDayFromHour: true,
    timezoneAlignment: alignment,
    requestedSpanMs: spanMs,
    servable: true,
  }
}

/**
 * Picks the rollup for a grain the **caller named**, rather than one derived
 * from the span (the `resolution` query parameter, CP3).
 *
 * `chooseResolution` above is untouched by this and stays the only automatic
 * path: a request with no `resolution` never reaches here, so the span-based
 * ladder and everything that depends on it behave exactly as before.
 *
 * The forcing rule is deliberately *not* "anything the caller asks for". A
 * grain is honoured only where the automatic selector could already have served
 * it for this range and timezone — the same source-rollup span caps, the same
 * timezone-alignment classes. What forcing buys the caller is the freedom to ask
 * for hour buckets over a fortnight the ladder would have given days for, not
 * the freedom to ask for a number no rollup can produce truthfully. A grain that
 * fails those checks comes back `servable: false` with the precise reason, which
 * the API surfaces as `RESOLUTION_NOT_AVAILABLE`.
 *
 * ### Week
 *
 * `week` is the one grain automatic selection never picks, and the only one with
 * no rollup family of its own. It is the ISO week — Monday start — **in the
 * request timezone**, which is exactly why no week rollup exists: a stored
 * UTC-week bucket would be the wrong seven days for every zone but UTC, and the
 * DST-crossing weeks (167h and 169h) would be wrong for all of them. So it is
 * grouped at read time, from the same sources the day grain uses and under the
 * same class rules:
 *
 * | timezone class | week source                                    |
 * |----------------|------------------------------------------------|
 * | UTC            | `metrics_1d`, grouped by `toStartOfWeek(…, 1)` |
 * | whole-hour     | `metrics_1h`, grouped by the local Monday      |
 * | sub-hour       | `events_raw`, grouped by the local Monday      |
 *
 * A UTC week always starts on a UTC midnight, so the day rollup's buckets nest
 * inside it exactly; a non-UTC week starts on a local midnight, which only the
 * hour rollup can honour, and only when the zone's offset is a whole number of
 * hours. Grouping (rather than summing seven day-buckets client-side) is also
 * what keeps weekly unique visitors correct: the read merges the stored
 * `uniq` states across the whole week instead of adding seven overlapping
 * counts.
 */
export function resolveForcedGrain(
  input: ResolutionInput,
  requested: Resolution,
  config: AnalyticsQueryConfig = DEFAULT_ANALYTICS_QUERY_CONFIG,
): QueryResolution {
  const fromMs = Date.parse(input.from)
  const toMs = Date.parse(input.to)

  if (Number.isNaN(fromMs) || Number.isNaN(toMs) || !isValidTimezone(input.timezone)) {
    return {
      grain: requested,
      sourceRollup: '1d',
      composeDayFromHour: false,
      timezoneAlignment: 'utc',
      requestedSpanMs: 0,
      servable: false,
      reason: 'range instants or timezone are invalid',
    }
  }

  const spanMs = toMs - fromMs
  if (spanMs <= 0) {
    return {
      grain: requested,
      sourceRollup: '1d',
      composeDayFromHour: false,
      timezoneAlignment: 'utc',
      requestedSpanMs: spanMs,
      servable: false,
      reason: 'range must be half-open with from < to',
    }
  }

  const alignment = classifyTimezoneAlignment(new Date(fromMs), new Date(toMs), input.timezone)
  const spanHours = spanMs / MS_PER_HOUR
  const spanDays = spanMs / MS_PER_DAY

  const refuse = (reason: string): QueryResolution => ({
    grain: requested,
    sourceRollup: '1m',
    composeDayFromHour: false,
    timezoneAlignment: alignment,
    requestedSpanMs: spanMs,
    servable: false,
    reason,
  })

  const serve = (sourceRollup: RollupResolution, composeDayFromHour = false): QueryResolution => ({
    grain: requested,
    sourceRollup,
    composeDayFromHour,
    timezoneAlignment: alignment,
    requestedSpanMs: spanMs,
    servable: true,
  })

  if (requested === 'minute') {
    if (spanHours > config.MAX_SPAN_MINUTE_HOURS) {
      return refuse(
        `minute grain span ${spanHours.toFixed(1)}h exceeds the ${config.MAX_SPAN_MINUTE_HOURS}h minute-rollup cap`,
      )
    }
    // Every IANA offset is a whole number of minutes, so no zone is refused here.
    return serve('1m')
  }

  if (requested === 'hour') {
    if (alignment === 'sub-hour') {
      return serveRaw(requested, alignment, spanMs, spanDays, config)
    }
    if (spanDays > config.MAX_SPAN_HOUR_DAYS) {
      return refuse(
        `hour grain span ${spanDays.toFixed(1)}d exceeds the ${config.MAX_SPAN_HOUR_DAYS}d hour-rollup cap`,
      )
    }
    return serve('1h')
  }

  // day and week share their sources and therefore their class rules.
  if (alignment === 'sub-hour') {
    // Week reaches raw on the same terms as day. `toStartOfWeek(toTimeZone(…), 1)`
    // needs no bucket to nest inside, so the ISO week is the one grain a raw read
    // serves *more* cheaply than the rollup path does — it never had a week
    // rollup to miss.
    return serveRaw(requested, alignment, spanMs, spanDays, config)
  }

  if (alignment === 'utc') {
    if (spanDays > config.MAX_SPAN_DAY_DAYS) {
      return refuse(
        `${requested} grain span ${spanDays.toFixed(1)}d exceeds the ${config.MAX_SPAN_DAY_DAYS}d day-rollup cap`,
      )
    }
    // UTC days are the day rollup's own buckets, and a UTC week is a whole
    // number of them: both read `*_1d` directly.
    return serve('1d')
  }

  // whole-hour, non-UTC: local days (and therefore local weeks) start on an hour
  // boundary the day rollup cannot express, so compose from `*_1h`.
  if (spanDays > config.MAX_SPAN_HOUR_DAYS) {
    return refuse(
      `${requested} grain for a non-UTC timezone composes from the hour rollup, and span ${spanDays.toFixed(
        1,
      )}d exceeds the ${config.MAX_SPAN_HOUR_DAYS}d hour-rollup cap`,
    )
  }
  return serve('1h', requested === 'day')
}

/** A half-open UTC range as ISO-8601 instants. */
export interface UtcRange {
  readonly from: string
  readonly to: string
}

/**
 * The comparison range for a `[from, to)` request (docs snapshot 02 §18:
 * "comparison interval"; plan Milestone 7 item 9).
 *
 * The previous period is the equal-length half-open range that ends exactly where
 * the current one begins: `[from - span, from)`. It is derived here, in domain
 * code, so the API and any future caller compute the same comparison from the
 * same inputs rather than each doing date maths at the edge.
 *
 * The definition is span-based, not calendar-based, and that is deliberate: an
 * equal-UTC-span preceding window is exact and reversible, and it lines up bucket
 * for bucket with the current range at whatever grain answered it. A
 * calendar-based "same days last month" comparison changes length across DST and
 * month boundaries and is a Milestone 8 refinement once session facts land; the
 * metadata already carries the comparison range explicitly so a client is never
 * left guessing which window a comparison number came from.
 *
 * Returns `null` for a malformed or non-positive range, mirroring
 * `chooseResolution`'s total, throw-free contract.
 */
export function derivePreviousPeriod(range: UtcRange): UtcRange | null {
  const fromMs = Date.parse(range.from)
  const toMs = Date.parse(range.to)
  if (Number.isNaN(fromMs) || Number.isNaN(toMs) || toMs <= fromMs) return null
  const span = toMs - fromMs
  return {
    from: new Date(fromMs - span).toISOString(),
    to: new Date(fromMs).toISOString(),
  }
}

/** True when the instant lands exactly on a UTC minute (`:ss.mmm` are zero). */
export function isUtcMinuteAligned(instant: string): boolean {
  const ms = Date.parse(instant)
  return !Number.isNaN(ms) && ms % 60_000 === 0
}

/** True when the instant lands exactly on a UTC hour. */
export function isUtcHourAligned(instant: string): boolean {
  const ms = Date.parse(instant)
  return !Number.isNaN(ms) && ms % MS_PER_HOUR === 0
}

/** True when the instant lands exactly on a UTC day (midnight UTC). */
export function isUtcDayAligned(instant: string): boolean {
  const ms = Date.parse(instant)
  return !Number.isNaN(ms) && ms % MS_PER_DAY === 0
}
