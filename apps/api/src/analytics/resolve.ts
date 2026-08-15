import {
  chooseResolution,
  classifyTimezoneAlignment,
  DEFAULT_ANALYTICS_QUERY_CONFIG,
  importQueryParams,
  resolveForcedGrain,
  type ImportPointer,
  type AnalyticsQueryConfig,
  type RollupResolution,
  type SessionSplitUnit,
  type TimezoneAlignment,
} from '@openanalytics/domain'
import type { Resolution } from '@openanalytics/contracts'

/**
 * Turns a `[from, to)` request in an IANA timezone into a concrete gateway
 * operation and an effective, bucket-aligned range (plan Milestone 7 items 6/7,
 * docs snapshot 02 §15/§18).
 *
 * `chooseResolution` in `@openanalytics/domain` is the shared brain: it decides
 * grain and rollup family and refuses a range no rollup can answer honestly. This
 * module is the API-side adapter around it — it names the gateway operation for a
 * (report, grain) pair and snaps the requested range to the source rollup's UTC
 * bucket boundary so the gateway's own alignment check accepts it. The snapped
 * range is the response's `effective_range`; the caller's is `requested_range`
 * (§18 wants both surfaced, precisely because they can differ).
 */

const MS_PER_DAY = 86_400_000

export type SnapUnit = 'minute' | 'hour' | 'day'

/** Floors an ISO instant down to the start of its UTC minute/hour/day. */
export function floorToUtcBoundary(iso: string, unit: SnapUnit): string {
  const ms = Date.parse(iso)
  const size = unit === 'minute' ? 60_000 : unit === 'hour' ? 3_600_000 : MS_PER_DAY
  return new Date(Math.floor(ms / size) * size).toISOString()
}

export interface ResolvedTimeseries {
  readonly servable: true
  readonly operation: string
  readonly grain: Resolution
  readonly sourceRollup: RollupResolution
  readonly alignment: TimezoneAlignment
  readonly withTimezone: boolean
  readonly effectiveFrom: string
  readonly effectiveTo: string
}

export interface Unservable {
  readonly servable: false
  readonly reason: string
  readonly alignment: TimezoneAlignment
}

const snapForRollup: Record<RollupResolution, SnapUnit> = {
  '1m': 'minute',
  '1h': 'hour',
  '1d': 'day',
  // A raw read filters on instants, so it has no bucket boundary it must land on.
  // It still snaps to the minute: `effective_range` is a promise about what was
  // actually scanned, and the finest honest unit is the one every IANA offset is a
  // whole number of.
  raw: 'minute',
}

function snapRange(
  from: string,
  to: string,
  unit: SnapUnit,
): { effectiveFrom: string; effectiveTo: string } {
  return {
    effectiveFrom: floorToUtcBoundary(from, unit),
    effectiveTo: floorToUtcBoundary(to, unit),
  }
}

/** The timeseries operation ID for a resolution. */
function timeseriesOperationFor(
  grain: Resolution,
  sourceRollup: RollupResolution,
  composeDayFromHour: boolean,
): string {
  // Raw is checked before the grain fan-out: every operation below reads a
  // UTC-bucketed rollup, so a sub-hour request must never reach one. `minute` is
  // absent deliberately — the ladder serves that grain from `metrics_1m`, whose
  // buckets align to any whole-minute offset, so it never arrives here as raw.
  if (sourceRollup === 'raw') {
    if (grain === 'week') return 'analytics.timeseries_raw_week'
    return grain === 'day' ? 'analytics.timeseries_raw_day' : 'analytics.timeseries_raw_hour'
  }
  // Week has no rollup of its own — it is grouped at read time over whichever
  // family the zone allows — so the grain, not the table, names the operation.
  if (grain === 'week') {
    return sourceRollup === '1d' ? 'analytics.timeseries_week_utc' : 'analytics.timeseries_week'
  }
  if (sourceRollup === '1m') return 'analytics.timeseries_minute'
  if (sourceRollup === '1d') return 'analytics.timeseries_day_utc'
  // '1h': either the hour chart or a composed local-day chart.
  return composeDayFromHour ? 'analytics.timeseries_day' : 'analytics.timeseries_hour'
}

/**
 * Resolves a timeseries request. Uses the full minute/hour/day selector, so a
 * short "today" range gets the minute rollup and a sub-hour zone is served at
 * minute grain but refused at hour/day (never answered wrong).
 *
 * `input.resolution` forces the grain instead (CP3). The forced path is a
 * separate domain function rather than a flag threaded through the automatic
 * one, so a request that names no resolution takes byte-identical decisions to
 * the ones it took before the parameter existed. The effective range is snapped
 * the same way either way — to the *source rollup's* boundary, never to a week
 * boundary: `[from, to)` keeps filtering source buckets, and the week a partial
 * one belongs to is a grouping decision made after the filter (exactly as a
 * local day composed from hours already behaves at a range edge).
 */
export function resolveTimeseries(
  input: { from: string; to: string; timezone: string; resolution?: Resolution | undefined },
  config: AnalyticsQueryConfig = DEFAULT_ANALYTICS_QUERY_CONFIG,
): ResolvedTimeseries | Unservable {
  const requested = input.resolution
  const decision =
    requested === undefined
      ? chooseResolution(input, config)
      : resolveForcedGrain(input, requested, config)
  if (!decision.servable) {
    return {
      servable: false,
      reason: decision.reason ?? 'range is not servable',
      alignment: decision.timezoneAlignment,
    }
  }
  const unit = snapForRollup[decision.sourceRollup]
  const { effectiveFrom, effectiveTo } = snapRange(input.from, input.to, unit)
  const withTimezone = decision.sourceRollup !== '1d'
  return {
    servable: true,
    operation: timeseriesOperationFor(
      decision.grain,
      decision.sourceRollup,
      decision.composeDayFromHour,
    ),
    grain: decision.grain,
    sourceRollup: decision.sourceRollup,
    alignment: decision.timezoneAlignment,
    withTimezone,
    effectiveFrom,
    effectiveTo,
  }
}

export interface ResolvedAggregate {
  readonly servable: true
  readonly grain: Resolution
  readonly sourceRollup: RollupResolution
  readonly alignment: TimezoneAlignment
  readonly effectiveFrom: string
  readonly effectiveTo: string
}

/**
 * Resolves an *aggregate* request — overview totals and top-N reports, which have
 * no time bucketing and only exist at hour/day grain in the gateway registry.
 *
 * The rule mirrors the timezone logic in `chooseResolution` but without a minute
 * tier: a sub-hour zone is refused (its local-midnight boundaries never align to
 * a UTC hour, so no hour/day rollup can honour them); a whole-hour zone always
 * uses the hour rollup (only hour boundaries match its local midnight, and a
 * report over the hour rollup is correct at any length up to the hour cap); UTC
 * uses the day rollup once past the hour band and the hour rollup below it.
 *
 * `input.resolution` forces the source instead (CP3), and only `hour` or `day`
 * can be forced: those are the only two rollups these totals have. `minute`
 * would change nothing — a total is summed over the whole range either way, so a
 * minute scan would buy the same number at a much higher cost — and `week` is a
 * bucketing concept with no meaning for a figure that has no buckets. The route
 * layer rejects both before this point; they are refused here too so the
 * function is total on its own type.
 */
export function resolveAggregate(
  input: { from: string; to: string; timezone: string; resolution?: Resolution | undefined },
  config: AnalyticsQueryConfig = DEFAULT_ANALYTICS_QUERY_CONFIG,
  /**
   * Whether this surface has a raw operation to fall back on for a sub-hour zone.
   *
   * Opt-in per surface, and defaulting to `false`, because the raw operations are
   * being added one family at a time: `overview` has one, the top-N reports and
   * the custom-event samples do not yet. A surface that opts in without an
   * operation to answer with would reach `reportOperationFor`'s throw, so the
   * default keeps an un-migrated surface on the honest refusal it already gave.
   */
  options: { readonly rawCapable?: boolean } = {},
): ResolvedAggregate | Unservable {
  const fromMs = Date.parse(input.from)
  const toMs = Date.parse(input.to)
  if (Number.isNaN(fromMs) || Number.isNaN(toMs) || toMs <= fromMs) {
    return { servable: false, reason: 'range must be half-open with from < to', alignment: 'utc' }
  }
  const alignment = classifyTimezoneAlignment(new Date(fromMs), new Date(toMs), input.timezone)
  const spanDays = (toMs - fromMs) / MS_PER_DAY
  const requested = input.resolution

  if (requested !== undefined && requested !== 'hour' && requested !== 'day') {
    return {
      servable: false,
      alignment,
      reason: `${requested} grain has no meaning for range totals; these read the hour or day rollup`,
    }
  }

  // A sub-hour zone reads raw events instead. No rollup can align to its local
  // boundaries, but `events_raw` has no boundaries to align to — it is filtered on
  // instants and grouped by a timezone-shifted expression, which is exact for any
  // whole-minute offset. The cap is the raw one, far below the hour cap, because
  // this scans rows rather than buckets.
  if (alignment === 'sub-hour') {
    if (options.rawCapable !== true) {
      return {
        servable: false,
        alignment,
        reason:
          'a sub-hour timezone offset cannot be aligned to the hour/day rollups these totals read',
      }
    }
    if (spanDays > config.MAX_SPAN_RAW_DAYS) {
      return {
        servable: false,
        alignment,
        reason:
          `a sub-hour timezone offset reads raw events, and span ${spanDays.toFixed(1)}d exceeds ` +
          `the ${config.MAX_SPAN_RAW_DAYS}d raw-scan cap`,
      }
    }
    const { effectiveFrom, effectiveTo } = snapRange(input.from, input.to, 'minute')
    return {
      servable: true,
      // `hour` is the reported grain because these totals have no buckets and the
      // api's response shape has to name one; the source is what actually differs.
      grain: 'hour',
      sourceRollup: 'raw',
      alignment,
      effectiveFrom,
      effectiveTo,
    }
  }

  // A forced `day` is the same day rule as the automatic one, minus the span
  // threshold that would otherwise have chosen hour: the day rollup buckets on
  // UTC midnight, so only a UTC request can read it without misattributing the
  // edges of every local day in the range.
  if (requested === 'day') {
    if (alignment !== 'utc') {
      return {
        servable: false,
        alignment,
        reason:
          'day grain totals read the UTC-day rollup, which cannot honour a non-UTC timezone’s ' +
          'local day boundaries; use hour grain',
      }
    }
    if (spanDays > config.MAX_SPAN_DAY_DAYS) {
      return {
        servable: false,
        alignment,
        reason: `range span ${spanDays.toFixed(1)}d exceeds the ${config.MAX_SPAN_DAY_DAYS}d cap`,
      }
    }
    const { effectiveFrom, effectiveTo } = snapRange(input.from, input.to, 'day')
    return {
      servable: true,
      grain: 'day',
      sourceRollup: '1d',
      alignment,
      effectiveFrom,
      effectiveTo,
    }
  }

  // A forced `hour` skips the UTC day-rollup branch below and falls through to
  // the hour path, which already carries the only guard it needs (the hour cap).
  if (requested === undefined && alignment === 'utc' && spanDays > config.HOUR_GRAIN_MAX_DAYS) {
    if (spanDays > config.MAX_SPAN_DAY_DAYS) {
      return {
        servable: false,
        alignment,
        reason: `range span ${spanDays.toFixed(1)}d exceeds the ${config.MAX_SPAN_DAY_DAYS}d cap`,
      }
    }
    const { effectiveFrom, effectiveTo } = snapRange(input.from, input.to, 'day')
    return {
      servable: true,
      grain: 'day',
      sourceRollup: '1d',
      alignment,
      effectiveFrom,
      effectiveTo,
    }
  }

  if (spanDays > config.MAX_SPAN_HOUR_DAYS) {
    return {
      servable: false,
      alignment,
      reason: `range span ${spanDays.toFixed(1)}d exceeds the ${config.MAX_SPAN_HOUR_DAYS}d hour-rollup cap`,
    }
  }
  const { effectiveFrom, effectiveTo } = snapRange(input.from, input.to, 'hour')
  return {
    servable: true,
    grain: 'hour',
    sourceRollup: '1h',
    alignment,
    effectiveFrom,
    effectiveTo,
  }
}

/**
 * Resolves a *session-metrics* request to the pair of gateway operations that
 * read its finalized and provisional layers, plus the grain, effective range and
 * the UTC unit the finalized/provisional split is aligned on (docs snapshot 02
 * §10, §15; plan Milestone 8 items 6-7).
 *
 * Session rollups exist only at 1h/1d, so unlike the metrics chart there is no
 * minute grain: a short "today" range is served at hour grain, and a sub-hour
 * timezone — which has no whole-hour bucket that could carry its local
 * boundaries, and no minute session rollup to fall back to — is refused. The
 * grain/timezone decision is delegated to the shared `chooseResolution` and then
 * mapped: its minute tier folds into hour, its UTC-day tier reads the 1d layers,
 * and its non-UTC composed-day tier composes local days from the 1h layers.
 */
export interface ResolvedSession {
  readonly servable: true
  readonly grain: Resolution
  readonly finalizedOperation: string
  readonly provisionalOperation: string
  /** UTC unit the split boundary and the effective range are aligned on. */
  readonly splitUnit: SessionSplitUnit
  readonly withTimezone: boolean
  readonly effectiveFrom: string
  readonly effectiveTo: string
}

export function resolveSession(
  input: { from: string; to: string; timezone: string },
  config: AnalyticsQueryConfig = DEFAULT_ANALYTICS_QUERY_CONFIG,
): ResolvedSession | Unservable {
  const decision = chooseResolution(input, config)
  if (!decision.servable) {
    return {
      servable: false,
      reason: decision.reason ?? 'range is not servable',
      alignment: decision.timezoneAlignment,
    }
  }
  // A sub-hour zone reads `session_facts_versions` for both layers.
  //
  // Both, and not just the provisional one, because the finalized rollup is
  // *computed from* those same facts by the finalizer — the facts are the source
  // of truth, so reading them for the settled half costs a scan and changes no
  // number. It cannot double-count either: `splitSessionRange` hands the two
  // operations **disjoint** ranges either side of `finalized_through`, so each
  // session is read by exactly one of them.
  if (decision.timezoneAlignment === 'sub-hour') {
    const rawOperation =
      decision.grain === 'day' ? 'analytics.sessions_raw_day' : 'analytics.sessions_raw_hour'
    const { effectiveFrom, effectiveTo } = snapRange(input.from, input.to, 'minute')
    return {
      servable: true,
      grain: decision.grain === 'day' ? 'day' : 'hour',
      finalizedOperation: rawOperation,
      provisionalOperation: rawOperation,
      // The split boundary stays on a UTC hour while the buckets are local. A
      // bucket straddling it is counted partly by each layer and summed back
      // together by `mergeSessionLayers` — the same thing that already happens
      // for a whole-hour zone's local days, whose boundaries do not land on the
      // split either.
      splitUnit: 'hour',
      withTimezone: true,
      effectiveFrom,
      effectiveTo,
    }
  }

  if (decision.sourceRollup === '1d') {
    // UTC day: read the 1d layers directly.
    const { effectiveFrom, effectiveTo } = snapRange(input.from, input.to, 'day')
    return {
      servable: true,
      grain: 'day',
      finalizedOperation: 'analytics.sessions_finalized_day',
      provisionalOperation: 'analytics.sessions_provisional_day',
      splitUnit: 'day',
      withTimezone: false,
      effectiveFrom,
      effectiveTo,
    }
  }

  if (decision.grain === 'day' && decision.composeDayFromHour) {
    // Non-UTC local day: compose from the 1h layers, split on the UTC hour.
    const { effectiveFrom, effectiveTo } = snapRange(input.from, input.to, 'hour')
    return {
      servable: true,
      grain: 'day',
      finalizedOperation: 'analytics.sessions_finalized_day_local',
      provisionalOperation: 'analytics.sessions_provisional_day_local',
      splitUnit: 'hour',
      withTimezone: true,
      effectiveFrom,
      effectiveTo,
    }
  }

  // Minute or hour tier: session metrics are served at hour grain from the 1h
  // layers (the finest session rollup).
  const { effectiveFrom, effectiveTo } = snapRange(input.from, input.to, 'hour')
  return {
    servable: true,
    grain: 'hour',
    finalizedOperation: 'analytics.sessions_finalized_hour',
    provisionalOperation: 'analytics.sessions_provisional_hour',
    splitUnit: 'hour',
    withTimezone: true,
    effectiveFrom,
    effectiveTo,
  }
}

/** Report slugs whose gateway operations are `analytics.<slug>_hour|_day`. */
export const REPORT_SLUGS = [
  'pages',
  'sources',
  'geography',
  'devices',
  'custom_events',
  'performance',
] as const
export type ReportSlug = (typeof REPORT_SLUGS)[number]

/**
 * The report operation ID for a resolved aggregate grain.
 *
 * `raw` throws rather than falling through to the hour operation, and that is the
 * point: `_hour` reads `metrics_*_1h`, whose UTC-hour buckets are the thing a
 * sub-hour zone cannot align to. A fall-through here would answer a +05:30
 * request from misattributed buckets — a plausible wrong number instead of a
 * refusal, which is the one outcome this whole seam exists to prevent. The raw
 * report operations are not built yet; until they are, the caller must refuse.
 */
export function reportOperationFor(slug: ReportSlug, sourceRollup: RollupResolution): string {
  if (sourceRollup === 'raw') return `analytics.${slug}_raw`
  return `analytics.${slug}_${sourceRollup === '1d' ? 'day' : 'hour'}`
}

/**
 * The reports that can answer a sub-hour zone — all six.
 *
 * `performance` is in the set despite having no `performance_events` source of
 * its own: `performance_1h_mv` reads `events_raw WHERE type = 'web_vital'` and
 * pulls the metric, value and rating out of `properties`, so the raw operation
 * reads exactly what the rollup was built from.
 */
export const RAW_REPORT_SLUGS: ReadonlySet<ReportSlug> = new Set(REPORT_SLUGS)

/**
 * The custom-event sample operation for a resolved aggregate grain (ADR-0038,
 * D5; ClickHouse migration 0021).
 *
 * Its own function rather than a `REPORT_SLUGS` entry, because it is not a
 * report: it produces no rows of its own for a caller, it decorates the
 * custom-events report with three fields, and it takes neither the zone nor the
 * import parameters the report family takes. It is therefore absent from
 * `TIMEZONE_OPERATIONS` and from both import sets below, and that absence is
 * asserted rather than assumed — the registry walk in
 * `tests/unit/query-gateway-operations.test.ts` fails on a set that drifts from
 * the statements.
 */
export function customEventSamplesOperationFor(sourceRollup: RollupResolution): string {
  if (sourceRollup === 'raw') {
    throw new Error('custom-event samples have no raw operation (see reportOperationFor)')
  }
  return sourceRollup === '1d'
    ? 'analytics.custom_event_samples_day'
    : 'analytics.custom_event_samples_hour'
}

/** The overview operation ID for a resolved aggregate grain. */
export function overviewOperationFor(sourceRollup: RollupResolution): string {
  if (sourceRollup === 'raw') return 'analytics.overview_raw'
  return sourceRollup === '1d' ? 'analytics.overview_day' : 'analytics.overview_hour'
}

/**
 * The operations that carry the import parameters (ADR-0032, D2b/D4).
 *
 * Named here rather than inferred, because the gateway rejects both directions:
 * an operation whose SQL has the placeholders and receives no value fails to
 * bind, and one that receives values its SQL does not use fails as "bound unused
 * parameter". A unit test walks the gateway registry and asserts this set is
 * exactly the set of operations whose SQL contains `{import_run_id:UUID}`, so the
 * two ends cannot drift.
 *
 * **Minute and hour timeseries take the cutover but no imported branch.** An
 * aggregate-only provider ships one row per day and nothing finer, so there is
 * nothing honest to union — inventing one would spread a daily total across 24
 * buckets nobody measured. They still apply the partition, because two charts of
 * the same range disagreeing about whether the pre-cutover days exist is worse
 * than one of them being empty, and the empty one is explained by `estimated`.
 */
export const IMPORT_AWARE_OPERATIONS: ReadonlySet<string> = new Set([
  'analytics.timeseries_minute',
  'analytics.timeseries_raw_day',
  'analytics.timeseries_raw_hour',
  'analytics.timeseries_raw_week',
  'analytics.timeseries_hour',
  'analytics.timeseries_day',
  'analytics.timeseries_day_utc',
  'analytics.timeseries_week',
  'analytics.timeseries_week_utc',
  'analytics.overview_day',
  'analytics.overview_hour',
  'analytics.overview_raw',
  // The live breakdowns take the cutover but no union: their imported rows
  // arrive through the `analytics.imported_*` operations and are merged in the
  // api. `performance` is absent — no provider exports web vitals, so there is
  // nothing to partition against.
  'analytics.pages_hour',
  'analytics.pages_day',
  'analytics.pages_raw',
  'analytics.sources_hour',
  'analytics.sources_day',
  'analytics.sources_raw',
  'analytics.geography_hour',
  'analytics.geography_day',
  'analytics.geography_raw',
  'analytics.devices_hour',
  'analytics.devices_day',
  'analytics.devices_raw',
  'analytics.custom_events_hour',
  'analytics.custom_events_day',
  'analytics.custom_events_raw',
  'analytics.imported_pages',
  'analytics.imported_sources',
  'analytics.imported_geography',
  'analytics.imported_devices',
  'analytics.imported_browsers',
  'analytics.imported_os',
  'analytics.imported_custom_events',
])

/**
 * The subset that also binds `import_run_id` — the operations that actually read
 * a staged row.
 *
 * A live breakdown is import-aware without being one of these: it needs to know
 * where live data starts and nothing more, and binding a run id its statement
 * cannot use is precisely what the gateway rejects as "bound unused parameter".
 */
export const IMPORT_RUN_OPERATIONS: ReadonlySet<string> = new Set([
  'analytics.timeseries_day',
  'analytics.timeseries_day_utc',
  'analytics.timeseries_week',
  'analytics.timeseries_week_utc',
  'analytics.overview_day',
  'analytics.overview_hour',
  'analytics.overview_raw',
  'analytics.imported_pages',
  'analytics.imported_sources',
  'analytics.imported_geography',
  'analytics.imported_devices',
  'analytics.imported_browsers',
  'analytics.imported_os',
  'analytics.imported_custom_events',
])

/** The import parameters one operation takes — none, the cutover, or both. */
export function importParamsFor(
  operation: string,
  pointer: ImportPointer | null,
): Record<string, string> {
  if (!IMPORT_AWARE_OPERATIONS.has(operation)) return {}
  const params = importQueryParams(pointer)
  return IMPORT_RUN_OPERATIONS.has(operation)
    ? { ...params }
    : { import_cutover: params.import_cutover }
}

/**
 * The operations whose statement binds `{tz:String}`.
 *
 * A **separate** list from the import-aware one, because the two sets are not the
 * same and assuming they were is a 400 on a working endpoint: the UTC-bucketed
 * charts read the import and take no zone (they are only ever routed a UTC
 * request), while `performance` takes neither. Every operation's parameter schema
 * is a `strictObject`, so an unexpected `timezone` is rejected exactly as loudly
 * as a missing one — which is the property that makes this list worth pinning
 * rather than inferring.
 *
 * A unit test asserts it is exactly the registry's `{tz:String}` set. The session
 * operations are in it for completeness; the session read path passes the zone
 * through its own resolver.
 */
export const TIMEZONE_OPERATIONS: ReadonlySet<string> = new Set([
  'analytics.timeseries_minute',
  'analytics.timeseries_raw_day',
  'analytics.timeseries_raw_hour',
  'analytics.timeseries_raw_week',
  'analytics.timeseries_hour',
  'analytics.timeseries_day',
  'analytics.timeseries_week',
  'analytics.overview_hour',
  'analytics.overview_day',
  'analytics.overview_raw',
  'analytics.pages_hour',
  'analytics.pages_day',
  'analytics.pages_raw',
  'analytics.sources_hour',
  'analytics.sources_day',
  'analytics.sources_raw',
  'analytics.geography_hour',
  'analytics.geography_day',
  'analytics.geography_raw',
  'analytics.devices_hour',
  'analytics.devices_day',
  'analytics.devices_raw',
  'analytics.custom_events_hour',
  'analytics.custom_events_day',
  'analytics.custom_events_raw',
  'analytics.imported_pages',
  'analytics.imported_sources',
  'analytics.imported_geography',
  'analytics.imported_devices',
  'analytics.imported_browsers',
  'analytics.imported_os',
  'analytics.imported_custom_events',
  'analytics.sessions_finalized_hour',
  'analytics.sessions_finalized_day_local',
  'analytics.sessions_provisional_hour',
  'analytics.sessions_raw_day',
  'analytics.sessions_raw_hour',
  'analytics.sessions_provisional_day_local',
  // The revenue charts (CP5). Only the two that BUCKET in local time are here:
  // `revenue_timeseries_day` reads the UTC-day rollup and is only ever routed a
  // UTC request, and the two summaries have no bucket to label at all — a zone
  // bound to any of the three is a "bound unused parameter" rejection.
  'analytics.revenue_timeseries_hour',
  'analytics.revenue_timeseries_day_local',
  'analytics.revenue_timeseries_day_1m',
  'analytics.revenue_timeseries_hour_1m',
])

/**
 * Everything one operation needs beyond `site_id`, the range and its own limit.
 *
 * One helper for both, so a caller cannot get the zone right and the cutover
 * wrong (or bind a zone to an operation that has none). The whole point is that
 * the *operation id* decides, not the request.
 */
export function operationParamsFor(
  operation: string,
  pointer: ImportPointer | null,
  timezone: string,
): Record<string, string> {
  return {
    ...(TIMEZONE_OPERATIONS.has(operation) ? { timezone } : {}),
    ...importParamsFor(operation, pointer),
  }
}

/**
 * The imported-only operation whose rows merge into a live report's, or null for
 * a report the import cannot answer.
 *
 * `performance` is null and always will be: web vitals are a browser
 * measurement, not an analytics aggregate, and no provider export carries them.
 */
export function importedReportOperationFor(slug: ReportSlug): string | null {
  switch (slug) {
    case 'pages':
      return 'analytics.imported_pages'
    case 'sources':
      return 'analytics.imported_sources'
    case 'geography':
      return 'analytics.imported_geography'
    case 'devices':
      return 'analytics.imported_devices'
    case 'custom_events':
      return 'analytics.imported_custom_events'
    case 'performance':
      return null
  }
}

/**
 * Resolves a *revenue* request to its rollup pair and effective range
 * (ADR-0033, D7; ClickHouse migration 0018). Milestone 12 Checkpoint 5.
 *
 * `resolveSession` again, and deliberately so: the revenue rollups have exactly
 * the session rollups' shape — 1h and 1d only, no minute grain, versioned
 * generation swaps rather than an incremental view — so the grain decision is
 * the same decision. Three consequences follow, and each is the session rule
 * with money in it:
 *
 * - **A sub-hour timezone is refused.** There is no minute revenue rollup to
 *   fall back to, and a zone whose local midnight never lands on a UTC hour
 *   cannot be answered from hour buckets without misattributing the edge of
 *   every day. `RESOLUTION_NOT_AVAILABLE` rather than a plausible wrong total.
 * - **A minute-tier range is served at hour grain.** "Today" on a revenue chart
 *   is hourly, which is also the finest grain the money is meaningful at — a
 *   per-minute revenue series is noise around individual transactions, and the
 *   transactions list is the surface for those.
 * - **A non-UTC day is composed from the hour rollup**, so a DST 23/25-hour day
 *   sums the hours it actually had.
 *
 * The summary shares this resolver rather than having one of its own: a range
 * total is the same buckets without the `GROUP BY`, so a range the chart refuses
 * is a range the total would have to guess at.
 */
export interface ResolvedRevenue {
  readonly servable: true
  readonly grain: Resolution
  /** The bucketed operation — the timeseries surface. */
  readonly timeseriesOperation: string
  /** The range-total operation — the summary surface. */
  readonly summaryOperation: string
  readonly withTimezone: boolean
  readonly effectiveFrom: string
  readonly effectiveTo: string
}

export function resolveRevenue(
  input: { from: string; to: string; timezone: string; resolution?: Resolution | undefined },
  config: AnalyticsQueryConfig = DEFAULT_ANALYTICS_QUERY_CONFIG,
): ResolvedRevenue | Unservable {
  const requested = input.resolution
  // `minute` and `week` are refused here as well as at the route edge, so the
  // function is total on its own type: revenue has hour and day rollups and
  // nothing else, and a forced grain neither of them can serve is a refusal
  // rather than a silent downgrade.
  if (requested !== undefined && requested !== 'hour' && requested !== 'day') {
    return {
      servable: false,
      alignment: classifyTimezoneAlignment(
        new Date(Date.parse(input.from)),
        new Date(Date.parse(input.to)),
        input.timezone,
      ),
      reason: `revenue has no ${requested} rollup; it is bucketed at hour or day grain only`,
    }
  }

  const decision =
    requested === undefined
      ? chooseResolution(input, config)
      : resolveForcedGrain(input, requested, config)
  if (!decision.servable) {
    return {
      servable: false,
      reason: decision.reason ?? 'range is not servable',
      alignment: decision.timezoneAlignment,
    }
  }

  // A sub-hour zone composes from `revenue_1m` (migration 0022). The minute
  // rollup exists precisely because this zone's local hour begins inside a UTC
  // hour bucket that cannot be split — every IANA offset is a whole number of
  // minutes, so a minute bucket always nests cleanly.
  //
  // The money rules are not restated anywhere for this path: the finalizer writes
  // all three units in one pass from one plan, so `revenue_1m` cannot disagree
  // with `revenue_1h` about what a refund did.
  if (decision.timezoneAlignment === 'sub-hour') {
    const { effectiveFrom, effectiveTo } = snapRange(input.from, input.to, 'minute')
    return {
      servable: true,
      grain: decision.grain === 'day' ? 'day' : 'hour',
      timeseriesOperation:
        decision.grain === 'day'
          ? 'analytics.revenue_timeseries_day_1m'
          : 'analytics.revenue_timeseries_hour_1m',
      summaryOperation: 'analytics.revenue_summary_1m',
      withTimezone: true,
      effectiveFrom,
      effectiveTo,
    }
  }

  if (decision.sourceRollup === '1d') {
    const { effectiveFrom, effectiveTo } = snapRange(input.from, input.to, 'day')
    return {
      servable: true,
      grain: 'day',
      timeseriesOperation: 'analytics.revenue_timeseries_day',
      summaryOperation: 'analytics.revenue_summary_day',
      withTimezone: false,
      effectiveFrom,
      effectiveTo,
    }
  }

  const { effectiveFrom, effectiveTo } = snapRange(input.from, input.to, 'hour')
  if (decision.grain === 'day' && decision.composeDayFromHour) {
    return {
      servable: true,
      grain: 'day',
      timeseriesOperation: 'analytics.revenue_timeseries_day_local',
      summaryOperation: 'analytics.revenue_summary_hour',
      withTimezone: true,
      effectiveFrom,
      effectiveTo,
    }
  }

  return {
    servable: true,
    grain: 'hour',
    timeseriesOperation: 'analytics.revenue_timeseries_hour',
    summaryOperation: 'analytics.revenue_summary_hour',
    withTimezone: true,
    effectiveFrom,
    effectiveTo,
  }
}
