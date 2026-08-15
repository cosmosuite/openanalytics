import { ApiError, buildCursorPage } from '@openanalytics/contracts'
import type { components } from '@openanalytics/contracts'
import {
  classifyImportedRange,
  coarsenPublicGeography,
  derivePreviousPeriod,
  MAX_FUNNEL_RANGE_MS,
  mergeImportedRows,
  mergeSessionLayers,
  resolveAnalyticsSources,
  spansOneProviderDay,
  splitSessionRange,
  type AnalyticsSourceVerdict,
  type FunnelScope,
  type GeographyRow as DomainGeographyRow,
  type ImportPointer,
  type ImportedSurface,
  renderRevenueJourneyEntry,
  type MoneyEntryInput,
  type SessionMeasures,
  type SessionMetrics,
} from '@openanalytics/domain'
import type { AnalyticsGateway } from '../gateway-client.ts'
import {
  IMPORT_RUN_OPERATIONS,
  customEventSamplesOperationFor,
  importedReportOperationFor,
  operationParamsFor,
  overviewOperationFor,
  RAW_REPORT_SLUGS,
  reportOperationFor,
  resolveAggregate,
  resolveRevenue,
  resolveSession,
  resolveTimeseries,
  type ReportSlug,
} from './resolve.ts'
import { encodeRevenueCursor, type RevenueCursor } from './revenue-cursor.ts'

/**
 * The analytics read service (plan Milestone 7 items 6 and 9).
 *
 * It owns everything between an authorized request and a contract-shaped
 * response: resolve the range to a gateway operation, call the signed gateway,
 * map raw rollup rows onto the typed response shapes, read freshness, and build
 * the §18 metadata block (requested vs effective range, timezone, resolution,
 * freshness state, comparison range, truncation/cache/partial). Authorization is
 * *not* here — it has already passed in the route middleware; this service is
 * only reached once membership and billing entitlement are established.
 *
 * A gateway failure propagates as a typed `ApiError` (from the client), never as
 * empty rows: the route turns that into a 503, so "the service is down" can never
 * be mistaken for "this site has no data" (AGENTS.md).
 */

type Schemas = components['schemas']

/**
 * How far the *pipeline* may fall behind before a read is `stale` (ADR-0025).
 *
 * It bounds processing lag — the age of the ingest loop's last tick, and the age
 * of the oldest message still waiting in the queue — not the recency of the
 * site's own traffic. A site nobody visited all night is not stale; a pipeline
 * that stopped ten minutes ago is. An engineering value (the worker's flush lag
 * is seconds), not a gate item.
 */
const STALE_AFTER_MS = 10 * 60_000

/**
 * How far behind the revenue pipeline may fall before a revenue read is `stale`.
 *
 * Thirty minutes, which is twice the attribution job's own staleness clause: a
 * site with no new heads and no new hints is re-run when its watermark passes
 * fifteen minutes, so a watermark past thirty means a pass was skipped or the
 * loop is not running. Two intervals rather than one, for the same reason
 * ADR-0025 measures the pipeline's heartbeat rather than the site's last
 * visitor — a single interval would flag every site during the ordinary gap
 * between passes, and an alarm that is usually on is an alarm nobody reads.
 *
 * An engineering value derived from a loop constant, not a gate item.
 */
const REVENUE_ROLLUP_STALE_AFTER_MS = 30 * 60_000

/**
 * The site's cache generation (`sites.config_version`), threaded to the gateway
 * as `cache_epoch` (ADR-0030, decision 6).
 *
 * Optional throughout: a caller with no site row to source it from behaves
 * exactly as every caller did before the field existed. The routes take it from
 * the row the authorization middleware already loaded, so it costs no extra read.
 */
export interface CacheEpochScoped {
  readonly cacheEpoch?: number | undefined
}

/**
 * The site's published import, threaded from the row the authorization
 * middleware already loaded (ADR-0032, D2b).
 *
 * Optional throughout, and absent means "no published import" rather than
 * "unknown": a caller with no site row to source it from — a test, or a surface
 * that predates M11 — reads exactly as it did before imports existed, because
 * the gateway then binds the nil run and the epoch cutover.
 *
 * Never cached. The pointer **is** the invalidation mechanism: it reaches the
 * gateway as a bound parameter, so the gateway's cache key changes the moment a
 * publish or a rollback moves it.
 */
export interface ImportScoped {
  readonly importPointer?: ImportPointer | null | undefined
}

export interface AnalyticsRequest extends CacheEpochScoped, ImportScoped {
  readonly siteId: string
  readonly from: string
  readonly to: string
  readonly timezone: string
}

export interface AnalyticsReportRequest extends AnalyticsRequest {
  readonly limit: number
}

export interface AnalyticsOverviewRequest extends AnalyticsRequest {
  readonly compare: boolean
  /**
   * Forced source rollup (CP3). Absent = automatic selection. Only `hour` and
   * `day` are accepted; the route layer rejects anything else.
   */
  readonly resolution?: Schemas['Resolution'] | undefined
}

export interface AnalyticsTimeseriesRequest extends AnalyticsRequest {
  readonly compare: boolean
  /** Forced bucket grain (CP3). Absent = automatic selection. */
  readonly resolution?: Schemas['Resolution'] | undefined
}

export interface AnalyticsSessionsRequest extends AnalyticsRequest {
  /** The site's session-finalizer watermark from Postgres, or null when the
   * finalizer has never run for it (then the whole range is provisional). */
  readonly finalizedThrough: Date | null
}

/**
 * A short recent window over the event facts (ADR-0024). Deliberately not an
 * `AnalyticsRequest`: there is no rollup resolution to resolve here, so the
 * range is used as given rather than snapped to a bucket boundary.
 */
export interface AnalyticsRecentRequest extends CacheEpochScoped, ImportScoped {
  readonly siteId: string
  readonly from: string
  readonly to: string
  readonly timezone: string
}

/**
 * Page views one trail returns at most. Not a caller's parameter: a trail is
 * read whole or not at all, and the number exists so `meta.truncated` has
 * something to be true about.
 */
const VISITOR_TRAIL_LIMIT = 500

/**
 * The site's revenue connection, as the route reads it from Postgres (D7).
 *
 * Threaded in rather than read here for the reason `finalizedThrough` is: this
 * service holds a gateway and nothing else, and the credential row is a Postgres
 * read the route is already positioned to make. It is also the only input that
 * can distinguish "no sales" from "no provider" from "the provider is down", so
 * it is required rather than optional -- a revenue response with no connection
 * block would be exactly the uninterpretable empty result AGENTS.md forbids.
 */
export interface RevenueConnectionInput {
  /** The connected provider id, or null when nothing has ever been connected. */
  readonly provider: string | null
  readonly connectionStatus: 'connected' | 'degraded' | 'disconnected' | 'not_connected'
  readonly lastSyncedAt: string | null
  readonly lastWebhookAt: string | null
  /**
   * `revenue_attribution_state.computed_through` — the instant OUR pipeline last
   * computed this site's buckets against, or null if it never has.
   *
   * The other three fields are all about the *provider*. This one is about us,
   * and without it acceptance criterion 3 is only half-covered: a provider that
   * is answering perfectly while our own projection or attribution loop is dead
   * would render zeros under `connected` and a cheerful `ok`, which is the
   * confident-zero failure with the blame moved rather than removed.
   */
  readonly rollupThrough: string | null
}

export interface RevenueRequest extends CacheEpochScoped {
  readonly siteId: string
  readonly from: string
  readonly to: string
  readonly timezone: string
  /** The site's `reporting_currency`, from the row the middleware already read. */
  readonly reportingCurrency: string
  readonly connection: RevenueConnectionInput
}

export interface RevenueSummaryRequest extends RevenueRequest {
  readonly compare: boolean
  /** Forced grain. `hour` or `day` only -- revenue has no other rollup. */
  readonly resolution?: Schemas['Resolution'] | undefined
}

export interface RevenueTimeseriesRequest extends RevenueRequest {
  readonly resolution?: Schemas['Resolution'] | undefined
}

export interface RevenueTransactionsRequest extends RevenueRequest {
  /** Decoded keyset position, or null for the first page. */
  readonly cursor: RevenueCursor | null
  readonly limit: number
}

export interface RevenueJourneyRequest extends RevenueRequest {
  readonly objectId: string
}

export interface AnalyticsFunnelRequest extends CacheEpochScoped, ImportScoped {
  readonly siteId: string
  readonly from: string
  readonly to: string
  readonly timezone: string
  readonly scope: FunnelScope
  readonly steps: readonly string[]
  readonly windowMs: number
}

/** Coerces a ClickHouse JSON scalar (UInt64 arrives as a string) to a number. */
function num(value: unknown): number {
  if (typeof value === 'number') return value
  if (typeof value === 'string') {
    const n = Number(value)
    return Number.isFinite(n) ? n : 0
  }
  return 0
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value)
}

/**
 * Normalises a ClickHouse bucket value to an ISO-8601 UTC instant. ClickHouse
 * renders DateTime as `YYYY-MM-DD HH:MM:SS(.mmm)` with no zone; the gateway binds
 * and reads everything in UTC, so the wall-clock string is a UTC instant.
 *
 * That last sentence is the invariant this function rests on, and it is true by
 * construction rather than by convention: every stored bucket column is
 * DateTime('UTC') or DateTime64(3, 'UTC'), and the gateway wraps each of its
 * timezone-parameterised bucket expressions — `toStartOf*(col, {tz:String})`,
 * which would otherwise be *typed* in the request's zone and therefore rendered
 * as that zone's wall clock — in `toDateTime64(…, 3, 'UTC')`. A future operation
 * that re-buckets to a local grain without that wrapper would feed this function
 * a local wall clock it would then stamp "Z" onto, silently shifting every bucket
 * by the zone's offset; `tests/unit/query-gateway-operations.test.ts` fails such
 * an operation structurally.
 */
function bucketToIso(value: unknown): string {
  const s = str(value)
  if (s.endsWith('Z')) return s
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d+)?$/.exec(s)
  if (m) return `${m[1]}T${m[2]}${m[3] ?? '.000'}Z`
  const parsed = Date.parse(s)
  return Number.isNaN(parsed) ? s : new Date(parsed).toISOString()
}

interface FreshnessResult {
  readonly state: Schemas['FreshnessState']
  /**
   * The site's latest data instant — the newest rollup bucket it has. It is a
   * fact about the site's traffic, not a claim about pipeline health: an old
   * watermark on a quiet site is ordinary, and `state` is what says whether
   * anything is wrong (ADR-0025).
   */
  readonly watermark: string | null
  readonly partial: boolean
}

/**
 * The ingest pipeline's last observed tick (ADR-0025), as the read API sees it.
 *
 * Deliberately not the site's data: this says whether the *pipeline* is running
 * and keeping up, which is the only thing that can distinguish "this site had no
 * visitors" from "we are not processing".
 */
export interface PipelineHeartbeat {
  readonly lastTickAt: Date
  readonly queueOldestAgeMs: number
}

export interface AnalyticsServiceOptions {
  readonly now?: () => Date
  /**
   * Reads the ingest pipeline's heartbeat, or null when it has never written
   * one. Optional: without it (and on any read failure) freshness falls back to
   * the pre-ADR-0025 watermark-age rule, which is conservative — it can call a
   * quiet site stale, but it never calls a stalled pipeline healthy.
   */
  readonly pipelineHeartbeat?: () => Promise<PipelineHeartbeat | null>
}

export class AnalyticsService {
  readonly #gateway: AnalyticsGateway
  readonly #now: () => Date
  readonly #pipelineHeartbeat: (() => Promise<PipelineHeartbeat | null>) | undefined

  constructor(gateway: AnalyticsGateway, options: AnalyticsServiceOptions = {}) {
    this.#gateway = gateway
    this.#now = options.now ?? (() => new Date())
    this.#pipelineHeartbeat = options.pipelineHeartbeat
  }

  /**
   * Reads the site watermark and the pipeline heartbeat, and decides freshness
   * from them (ADR-0025).
   *
   * The two answer different questions and only the second one is about us: the
   * watermark is the instant of the site's latest data, so its age is how long
   * ago somebody visited — a number that says nothing about whether ingest is
   * running. `stale` is therefore decided by the pipeline's own liveness and
   * backlog, and a site with no traffic since yesterday reads `ok`.
   *
   * A gateway failure here degrades freshness but never fails the whole read —
   * the data query is what matters. A *heartbeat* failure is quieter still: it
   * is not evidence of anything, so it falls back to the old watermark rule
   * rather than reporting `degraded` on a working read.
   */
  async #freshness(
    siteId: string,
    cacheEpoch: number | undefined,
    pointer: ImportPointer | null = null,
  ): Promise<FreshnessResult> {
    const nowMs = this.#now().getTime()
    // Started before the gateway probe so the Postgres read overlaps it rather
    // than adding its latency to every analytics request. It never rejects.
    const heartbeatRead = this.#readHeartbeat()

    let watermark: string
    try {
      const result = await this.#gateway.query<{ watermark: unknown; buckets: unknown }>(
        'analytics.freshness',
        { site_id: siteId },
        { cacheEpoch },
      )
      const row = result.rows[0]
      const buckets = num(row?.buckets)
      if (buckets === 0) {
        // **Imported-only sites read as alive** (ADR-0032, D5). The primary
        // migration case is "import first, install the tracker second", and a
        // site whose entire history is a published import has no live bucket at
        // all — the pre-M11 rule would answer `no_data` and paint every panel
        // with an empty state while the data sits right there. The watermark
        // stays null because it is a statement about *live* ingest, and there
        // has been none.
        if (pointer !== null) return { state: 'ok', watermark: null, partial: false }
        return { state: 'no_data', watermark: null, partial: false }
      }
      watermark = bucketToIso(row?.watermark)
    } catch {
      // The freshness probe is the one degradable sub-query: mark it, keep going.
      return { state: 'degraded', watermark: null, partial: true }
    }

    const heartbeat = await heartbeatRead
    if (heartbeat === null) {
      // No heartbeat wired, no row yet (pre-migration, or a worker that has not
      // ticked since deploy), or the read failed. Fall back to the old rule: it
      // is wrong about quiet sites, but it is wrong in the safe direction.
      const wmMs = Date.parse(watermark)
      const stale = Number.isNaN(wmMs) || nowMs - wmMs > STALE_AFTER_MS
      return { state: stale ? 'stale' : 'ok', watermark, partial: false }
    }

    // Two ways to be behind, one verdict. A loop that stopped ticking is dead;
    // a loop that ticks in front of a backlog older than the threshold is alive
    // and still not delivering data the customer would call current.
    const behind =
      nowMs - heartbeat.lastTickAt.getTime() > STALE_AFTER_MS ||
      heartbeat.queueOldestAgeMs > STALE_AFTER_MS
    return { state: behind ? 'stale' : 'ok', watermark, partial: false }
  }

  /** The heartbeat read, reduced to "a heartbeat or nothing" — it never throws. */
  async #readHeartbeat(): Promise<PipelineHeartbeat | null> {
    if (this.#pipelineHeartbeat === undefined) return null
    try {
      return await this.#pipelineHeartbeat()
    } catch {
      return null
    }
  }

  #meta(input: {
    requested: { from: string; to: string }
    effective: { from: string; to: string }
    timezone: string
    resolution: Schemas['Resolution']
    freshness: FreshnessResult
    comparisonRange: { from: string; to: string } | null
    truncated: boolean
    cached: boolean
    /** Absent on the surfaces that have no imported branch at all (sessions,
     * funnels, recent visitors), which is the same answer as `['live']`/`exact`
     * and keeps their metadata byte-identical to CP2's. */
    sources?: AnalyticsSourceVerdict
    /**
     * A degradation this response knows about that freshness does not.
     *
     * OR'd with the freshness probe's own `partial`, because both mean the same
     * thing to a client — "some part of this answer is missing" — and a second
     * field for the second cause would make a caller check two.
     */
    partial?: boolean
  }): Schemas['AnalyticsMeta'] {
    const sources = input.sources ?? LIVE_ONLY_SOURCES
    return {
      requested_range: { from: input.requested.from, to: input.requested.to },
      effective_range: { from: input.effective.from, to: input.effective.to },
      timezone: input.timezone,
      resolution: input.resolution,
      data_sources: [...sources.dataSources],
      accuracy: sources.accuracy,
      freshness: {
        state: input.freshness.state,
        watermark: input.freshness.watermark,
        as_of: this.#now().toISOString(),
      },
      comparison_range: input.comparisonRange,
      truncated: input.truncated,
      cached: input.cached,
      partial: input.freshness.partial || input.partial === true,
    }
  }

  #notServable(reason: string): never {
    throw new ApiError('RESOLUTION_NOT_AVAILABLE', reason, {
      details: { reason },
    })
  }

  // ---- Overview ---------------------------------------------------------

  async overview(req: AnalyticsOverviewRequest): Promise<Schemas['AnalyticsOverviewResponse']> {
    // Raw-capable: `analytics.overview_raw` answers a sub-hour zone from
    // `events_raw`, so these totals no longer refuse one. The top-N reports below
    // still do — they have no raw operation yet.
    const resolved = resolveAggregate(req, undefined, { rawCapable: true })
    if (!resolved.servable) this.#notServable(resolved.reason)

    const pointer = req.importPointer ?? null
    const operation = overviewOperationFor(resolved.sourceRollup)
    // The `no_data` override is only honest where the import is actually being
    // read: a range entirely after the cutover that comes back empty *is* empty,
    // and answering `ok` because the site imported something a year ago would
    // replace one wrong empty state with a wrong healthy one.
    const touchesImported =
      classifyImportedRange(
        { from: resolved.effectiveFrom, to: resolved.effectiveTo },
        pointer,
        req.timezone,
      ) !== 'live_only'
    const [primary, freshness] = await Promise.all([
      this.#queryOverview(
        operation,
        req.siteId,
        resolved.effectiveFrom,
        resolved.effectiveTo,
        req.cacheEpoch,
        pointer,
        req.timezone,
      ),
      this.#freshness(req.siteId, req.cacheEpoch, touchesImported ? pointer : null),
    ])

    let comparison: Schemas['AnalyticsOverviewResponse']['comparison'] = null
    let comparisonRange: { from: string; to: string } | null = null
    if (req.compare) {
      const prev = derivePreviousPeriod({ from: resolved.effectiveFrom, to: resolved.effectiveTo })
      if (prev) {
        comparisonRange = prev
        const prevTotals = await this.#queryOverview(
          operation,
          req.siteId,
          prev.from,
          prev.to,
          req.cacheEpoch,
          pointer,
          req.timezone,
        )
        comparison = { totals: prevTotals.totals }
      }
    }

    return {
      meta: this.#meta({
        requested: { from: req.from, to: req.to },
        effective: { from: resolved.effectiveFrom, to: resolved.effectiveTo },
        timezone: req.timezone,
        resolution: resolved.grain,
        freshness,
        comparisonRange,
        truncated: primary.truncated,
        cached: primary.cached,
        sources: resolveAnalyticsSources({
          ranges: rangesOf(
            { from: resolved.effectiveFrom, to: resolved.effectiveTo },
            comparisonRange,
          ),
          pointer,
          timezone: req.timezone,
          surface: 'imported',
          // A range total is `provider_defined` in exactly one case: the range is
          // one provider day, so the total *is* that day's row. Two days already
          // means summing dailies the provider refuses to add — the number is
          // then ours, not theirs.
          providerDefinedWhenFullyImported: spansOneProviderDay(
            { from: resolved.effectiveFrom, to: resolved.effectiveTo },
            req.timezone,
          ),
        }),
      }),
      totals: primary.totals,
      comparison,
    }
  }

  async #queryOverview(
    operation: string,
    siteId: string,
    from: string,
    to: string,
    cacheEpoch: number | undefined,
    pointer: ImportPointer | null,
    timezone: string,
  ): Promise<{ totals: Schemas['OverviewTotals']; truncated: boolean; cached: boolean }> {
    if (Date.parse(to) <= Date.parse(from)) {
      return { totals: emptyTotals(), truncated: false, cached: false }
    }
    const result = await this.#gateway.query<Record<string, unknown>>(
      operation,
      // The zone is bound even though a total has no bucket to label: it decides
      // which provider days the window contains, and the chart of this window
      // decides the same thing the same way.
      { site_id: siteId, from, to, ...operationParamsFor(operation, pointer, timezone) },
      { cacheEpoch },
    )
    const row = result.rows[0]
    return {
      totals: {
        events: num(row?.['events']),
        pageviews: num(row?.['pageviews']),
        visitors: num(row?.['visitors']),
        billable_events: num(row?.['billable_events']),
      },
      truncated: result.meta.truncated,
      cached: result.meta.cached,
    }
  }

  // ---- Timeseries -------------------------------------------------------

  async timeseries(
    req: AnalyticsTimeseriesRequest,
  ): Promise<Schemas['AnalyticsTimeseriesResponse']> {
    const resolved = resolveTimeseries(req)
    if (!resolved.servable) this.#notServable(resolved.reason)

    const pointer = req.importPointer ?? null
    // Minute and hour charts have no imported branch (an aggregate-only export
    // has no sub-day grain) but do apply the cutover, so they answer a knowable
    // subset rather than the whole range.
    const surface: ImportedSurface = IMPORT_RUN_OPERATIONS.has(resolved.operation)
      ? 'imported'
      : 'partitioned_live'
    const touchesImported =
      surface === 'imported' &&
      classifyImportedRange(
        { from: resolved.effectiveFrom, to: resolved.effectiveTo },
        pointer,
        req.timezone,
      ) !== 'live_only'
    const [primary, freshness] = await Promise.all([
      this.#queryTimeseries(
        resolved.operation,
        req.siteId,
        resolved.effectiveFrom,
        resolved.effectiveTo,
        req.timezone,
        req.cacheEpoch,
        pointer,
      ),
      this.#freshness(req.siteId, req.cacheEpoch, touchesImported ? pointer : null),
    ])

    let comparison: Schemas['AnalyticsTimeseriesResponse']['comparison'] = null
    let comparisonRange: { from: string; to: string } | null = null
    if (req.compare) {
      const prev = derivePreviousPeriod({ from: resolved.effectiveFrom, to: resolved.effectiveTo })
      if (prev) {
        comparisonRange = prev
        const prevSeries = await this.#queryTimeseries(
          resolved.operation,
          req.siteId,
          prev.from,
          prev.to,
          req.timezone,
          req.cacheEpoch,
          pointer,
        )
        comparison = { series: prevSeries.series }
      }
    }

    return {
      meta: this.#meta({
        requested: { from: req.from, to: req.to },
        effective: { from: resolved.effectiveFrom, to: resolved.effectiveTo },
        timezone: req.timezone,
        resolution: resolved.grain,
        freshness,
        comparisonRange,
        truncated: primary.truncated,
        cached: primary.cached,
        sources: resolveAnalyticsSources({
          ranges: rangesOf(
            { from: resolved.effectiveFrom, to: resolved.effectiveTo },
            comparisonRange,
          ),
          pointer,
          timezone: req.timezone,
          surface,
          // Day resolution is one bucket per provider day, so every number in the
          // series is that day's row unmodified — `provider_defined` at any
          // length. A week bucket groups dailies the provider refuses to add, so
          // it only qualifies in the degenerate case where the whole range is one
          // provider day anyway.
          providerDefinedWhenFullyImported:
            resolved.grain === 'day' ||
            spansOneProviderDay(
              { from: resolved.effectiveFrom, to: resolved.effectiveTo },
              req.timezone,
            ),
        }),
      }),
      series: primary.series,
      comparison,
    }
  }

  async #queryTimeseries(
    operation: string,
    siteId: string,
    from: string,
    to: string,
    timezone: string,
    cacheEpoch: number | undefined,
    pointer: ImportPointer | null,
  ): Promise<{ series: Schemas['TimeseriesPoint'][]; truncated: boolean; cached: boolean }> {
    if (Date.parse(to) <= Date.parse(from)) {
      return { series: [], truncated: false, cached: false }
    }
    // The operation id decides what it takes, in one place: every parameter
    // schema is a `strictObject`, so binding a zone or a cutover an operation
    // does not declare is rejected exactly as loudly as omitting one it does.
    const params: Record<string, unknown> = {
      site_id: siteId,
      from,
      to,
      ...operationParamsFor(operation, pointer, timezone),
    }
    const result = await this.#gateway.query<Record<string, unknown>>(operation, params, {
      cacheEpoch,
    })
    return {
      series: result.rows.map((row) => ({
        bucket: bucketToIso(row['bucket']),
        events: num(row['events']),
        pageviews: num(row['pageviews']),
        visitors: num(row['visitors']),
      })),
      truncated: result.meta.truncated,
      cached: result.meta.cached,
    }
  }

  // ---- Top-N reports ----------------------------------------------------

  /**
   * One breakdown read, and the imported one beside it when the range needs it
   * (ADR-0032, D2b).
   *
   * The two operations run concurrently and come back in the **same column
   * names**, because the imported operations project the live report's shape —
   * so the caller maps both lists with one mapper and merges the results. What
   * the merge cannot do is invent a dimension: an imported geography row carries
   * no city and an imported devices row carries no browser or OS, so those
   * columns come back empty, exactly as a live row with an unresolved value
   * already does. No city, browser or OS is ever fabricated for an imported row.
   *
   * A range with no imported days runs **only** the live operation and returns
   * its rows untouched — no second query, no re-sort, no re-cut.
   *
   * When it does merge, **each side is asked for twice the requested top-N**
   * (capped at the gateway's own 500). Two independently ranked top-N lists
   * cannot be merged exactly: a key that is 101st on both sides can outrank the
   * 100th of the merged list. Doubling does not remove that — it moves the bound
   * to "rank > 2 × limit on *both* sides", which for the shapes this serves (a
   * page that is popular in neither half of the range) is a row nobody was going
   * to read. Fetching everything is the only exact answer and is unbounded, which
   * is what the top-N cap exists to refuse.
   */
  async #report(
    slug: ReportSlug,
    req: AnalyticsReportRequest,
  ): Promise<{
    meta: Schemas['AnalyticsMeta']
    rows: readonly Record<string, unknown>[]
    imported: readonly Record<string, unknown>[]
  }> {
    // Raw-capable for every report that has a raw operation. `performance` does
    // not — its web vitals are in `performance_events` — so it keeps refusing a
    // sub-hour zone rather than reaching a source that cannot answer it.
    const resolved = resolveAggregate(req, undefined, {
      rawCapable: RAW_REPORT_SLUGS.has(slug),
    })
    if (!resolved.servable) this.#notServable(resolved.reason)

    const pointer = req.importPointer ?? null
    const effective = { from: resolved.effectiveFrom, to: resolved.effectiveTo }
    const operation = reportOperationFor(slug, resolved.sourceRollup)
    const importedOperation = importedReportOperationFor(slug)
    const surface: ImportedSurface = importedOperation === null ? 'live' : 'imported'
    const touchesImported =
      importedOperation !== null &&
      classifyImportedRange(effective, pointer, req.timezone) !== 'live_only'

    const liveParams: Record<string, unknown> = {
      site_id: req.siteId,
      from: effective.from,
      to: effective.to,
      // Deepened only when there is a second list to merge with, so a live-only
      // range still asks for exactly what it returns.
      limit: touchesImported ? mergeFetchLimit(req.limit) : req.limit,
      // The operation id decides whether it takes a zone and a cutover at all.
      // `performance` takes neither, and binding either would be rejected by its
      // strict parameter schema exactly as loudly as omitting a required one.
      ...operationParamsFor(operation, pointer, req.timezone),
    }

    const [primary, importedResult, freshness] = await Promise.all([
      this.#gateway.query<Record<string, unknown>>(operation, liveParams, {
        cacheEpoch: req.cacheEpoch,
      }),
      touchesImported && importedOperation !== null
        ? this.#gateway.query<Record<string, unknown>>(
            importedOperation,
            { ...liveParams, ...operationParamsFor(importedOperation, pointer, req.timezone) },
            { cacheEpoch: req.cacheEpoch },
          )
        : Promise.resolve(null),
      this.#freshness(req.siteId, req.cacheEpoch, touchesImported ? pointer : null),
    ])

    return {
      meta: this.#meta({
        requested: { from: req.from, to: req.to },
        effective,
        timezone: req.timezone,
        resolution: resolved.grain,
        freshness,
        comparisonRange: null,
        truncated: primary.meta.truncated || (importedResult?.meta.truncated ?? false),
        cached: primary.meta.cached && (importedResult?.meta.cached ?? true),
        sources: resolveAnalyticsSources({
          ranges: [effective],
          pointer,
          timezone: req.timezone,
          surface,
          // A breakdown over one provider day returns that day's rows unmodified;
          // over two it sums dailies, which is ours rather than theirs.
          providerDefinedWhenFullyImported: spansOneProviderDay(effective, req.timezone),
        }),
      }),
      rows: primary.rows,
      imported: importedResult?.rows ?? [],
    }
  }

  async pages(req: AnalyticsReportRequest): Promise<Schemas['AnalyticsPagesResponse']> {
    const { meta, rows, imported } = await this.#report('pages', req)
    return {
      meta,
      // Merged on the **page path alone**. The live pages report has no hostname
      // dimension, and the staged table has one because a provider export can
      // span several hosts of the same property — so the imported operation sums
      // across hostnames before the top-N cut and the two lists share a key.
      items: mergeImportedRows(rows.map(mapPageRow), imported.map(mapPageRow), {
        keyOf: (row) => row.page_path,
        add: (a, b) => ({ ...a, views: a.views + b.views, visitors: a.visitors + b.visitors }),
        rank: (row) => row.views,
        limit: req.limit,
      }) as Schemas['AnalyticsPagesResponse']['items'],
    }
  }

  async sources(req: AnalyticsReportRequest): Promise<Schemas['AnalyticsSourcesResponse']> {
    const { meta, rows, imported } = await this.#report('sources', req)
    return {
      meta,
      items: mergeImportedRows(rows.map(mapSourceRow), imported.map(mapSourceRow), {
        keyOf: (row) =>
          [row.referrer_domain, row.utm_source, row.utm_medium, row.utm_campaign].join('\u0000'),
        add: (a, b) => ({ ...a, views: a.views + b.views, visitors: a.visitors + b.visitors }),
        rank: (row) => row.views,
        limit: req.limit,
      }) as Schemas['AnalyticsSourcesResponse']['items'],
    }
  }

  async geography(req: AnalyticsReportRequest): Promise<Schemas['AnalyticsGeographyResponse']> {
    const { meta, rows, imported } = await this.#report('geography', req)
    return { meta, items: this.#mergeGeography(rows, imported, req.limit) }
  }

  /** Geography for the public surface: the same read, then city coarsening. */
  async publicGeography(
    req: AnalyticsReportRequest,
    cityThreshold: number | undefined,
  ): Promise<Schemas['PublicGeographyResponse']> {
    const { meta, rows, imported } = await this.#report('geography', req)
    const coarsened = coarsenPublicGeography(
      this.#mergeGeography(rows, imported, req.limit),
      cityThreshold,
    )
    return { meta: toPublicMeta(meta), items: coarsened }
  }

  /**
   * Live geography rows plus the imported country totals.
   *
   * The merge key is the live report's own `(country, city)`, and every imported
   * row carries the empty city — which is not a placeholder but the same value a
   * live row whose GeoLite2 lookup missed already carries. An imported country
   * therefore lands on the site's existing "country, city unknown" row rather
   * than beside it, and no city is invented for a provider that ships a GeoNames
   * id nothing here can resolve. City-level rows over an imported range come
   * from live data only.
   */
  #mergeGeography(
    rows: readonly Record<string, unknown>[],
    imported: readonly Record<string, unknown>[],
    limit: number,
  ): DomainGeographyRow[] {
    return mergeImportedRows(rows.map(mapGeographyRow), imported.map(mapGeographyRow), {
      keyOf: (row) => `${row.country}\u0000${row.city}`,
      add: (a, b) => ({ ...a, views: a.views + b.views, visitors: a.visitors + b.visitors }),
      rank: (row) => row.views,
      limit,
    }) as DomainGeographyRow[]
  }

  async devices(req: AnalyticsReportRequest): Promise<Schemas['AnalyticsDevicesResponse']> {
    const { meta, rows, imported } = await this.#report('devices', req)
    return {
      meta,
      // Only the imported **devices** report merges here, never the browser or OS
      // ones. The live row is a joint `(device_type, browser, os)` tuple and an
      // aggregate-only export carries one of the three per file: adding all three
      // lists would count the same visits three times, and each row would have
      // two invented blanks. The browser and OS imports are read through their
      // own operations, which is where a per-dimension surface would take them.
      items: mergeImportedRows(rows.map(mapDeviceRow), imported.map(mapImportedDeviceRow), {
        keyOf: (row) => [row.device_type, row.browser, row.os].join('\u0000'),
        add: (a, b) => ({ ...a, views: a.views + b.views, visitors: a.visitors + b.visitors }),
        rank: (row) => row.views,
        limit: req.limit,
      }) as Schemas['AnalyticsDevicesResponse']['items'],
    }
  }

  /**
   * Custom events, and what each one last did (ADR-0038, D5).
   *
   * The samples are a *decoration*: a second, additive operation over the
   * migration-0021 tables, joined onto the live rows by the response's own key.
   * It runs beside the report rather than inside it because it reads different
   * tables with different parameters — no zone, no cutover — and because the
   * counts operation is read by callers these fields have no business on.
   *
   * A failure is **not** swallowed. The two queries fail together, so `null` on
   * these fields keeps meaning exactly the three things the contract says it
   * means; a caught error would silently add a fourth, indistinguishable one.
   *
   * Only live rows are decorated. An imported row's three fields are null by
   * construction (`mapImportedCustomEventRow`) and the merge keeps them null,
   * because a provider's daily aggregate carries no event to sample.
   */
  async customEvents(
    req: AnalyticsReportRequest,
  ): Promise<Schemas['AnalyticsCustomEventsResponse']> {
    const [{ meta, rows, imported }, samples] = await Promise.all([
      this.#report('custom_events', req),
      this.#customEventSamples(req),
    ])
    return {
      meta,
      items: mergeImportedRows(
        rows.map((row) => decorateCustomEventRow(mapCustomEventRow(row), samples)),
        imported.map(mapImportedCustomEventRow),
        {
          keyOf: (row) => customEventKey(row.event_name, row.event_type),
          add: (a, b) => ({
            ...a,
            events: a.events + b.events,
            billable_events: a.billable_events + b.billable_events,
            visitors: a.visitors + b.visitors,
          }),
          rank: (row) => row.events,
          limit: req.limit,
        },
      ) as Schemas['AnalyticsCustomEventsResponse']['items'],
    }
  }

  /**
   * The sample rows for one custom-events read, keyed by the response's own key.
   *
   * It asks for `mergeFetchLimit(limit)` unconditionally rather than repeating
   * the report's import classification. The deeper list is what the live half
   * takes whenever the range touches an import, and a decoration that covered
   * fewer names than the list it decorates would render as a null on a row that
   * has data — a wrong answer, where a few extra rows off a small aggregate are
   * only a slightly larger read.
   *
   * A range the resolver cannot serve returns nothing and issues no query: the
   * report is about to raise the same refusal with the reason in it.
   */
  async #customEventSamples(
    req: AnalyticsReportRequest,
  ): Promise<ReadonlyMap<string, Record<string, unknown>>> {
    const resolved = resolveAggregate(req)
    if (!resolved.servable) return new Map()

    const result = await this.#gateway.query<Record<string, unknown>>(
      customEventSamplesOperationFor(resolved.sourceRollup),
      {
        site_id: req.siteId,
        from: resolved.effectiveFrom,
        to: resolved.effectiveTo,
        limit: mergeFetchLimit(req.limit),
      },
      { cacheEpoch: req.cacheEpoch },
    )

    return new Map(
      result.rows.map((row) => [
        customEventKey(str(row['event_name']), str(row['event_type'])),
        row,
      ]),
    )
  }

  async performance(req: AnalyticsReportRequest): Promise<Schemas['AnalyticsPerformanceResponse']> {
    const { meta, rows } = await this.#report('performance', req)
    return {
      meta,
      items: rows.map((r) => {
        const samples = num(r['samples'])
        const valueSum = num(r['value_sum'])
        const percentiles = Array.isArray(r['percentiles'])
          ? (r['percentiles'] as unknown[]).map(num)
          : []
        return {
          metric: str(r['metric']),
          device_type: str(r['device_type']),
          samples,
          mean: samples > 0 ? valueSum / samples : 0,
          p50: percentiles[0] ?? 0,
          p75: percentiles[1] ?? 0,
          p90: percentiles[2] ?? 0,
          p95: percentiles[3] ?? 0,
          p99: percentiles[4] ?? 0,
          good_samples: num(r['good_samples']),
          needs_improvement_samples: num(r['needs_improvement_samples']),
          poor_samples: num(r['poor_samples']),
        }
      }),
    }
  }

  // ---- Session metrics (finalized + provisional layer merge, §15) -------

  async sessions(req: AnalyticsSessionsRequest): Promise<Schemas['AnalyticsSessionsResponse']> {
    const resolved = resolveSession(req)
    if (!resolved.servable) this.#notServable(resolved.reason)

    const finalizedThroughIso = req.finalizedThrough ? req.finalizedThrough.toISOString() : null
    const split = splitSessionRange({
      effectiveFrom: resolved.effectiveFrom,
      effectiveTo: resolved.effectiveTo,
      finalizedThrough: finalizedThroughIso,
      splitUnit: resolved.splitUnit,
    })
    const tz = resolved.withTimezone ? req.timezone : undefined

    const [finalizedLayer, provisionalLayer, freshness] = await Promise.all([
      split.finalized
        ? this.#querySessionLayer(
            resolved.finalizedOperation,
            req.siteId,
            split.finalized,
            tz,
            req.cacheEpoch,
          )
        : Promise.resolve(EMPTY_LAYER),
      split.provisional
        ? this.#querySessionLayer(
            resolved.provisionalOperation,
            req.siteId,
            split.provisional,
            tz,
            req.cacheEpoch,
          )
        : Promise.resolve(EMPTY_LAYER),
      this.#freshness(req.siteId, req.cacheEpoch, null),
    ])

    const merged = mergeSessionLayers(finalizedLayer.rows, provisionalLayer.rows)

    return {
      meta: this.#meta({
        requested: { from: req.from, to: req.to },
        effective: { from: resolved.effectiveFrom, to: resolved.effectiveTo },
        timezone: req.timezone,
        resolution: resolved.grain,
        freshness,
        comparisonRange: null,
        truncated: finalizedLayer.truncated || provisionalLayer.truncated,
        cached: finalizedLayer.cached && provisionalLayer.cached,
      }),
      layering: {
        // finalized_through comes from Postgres (the finalizer watermark);
        // provisional_through is the leading edge of the data we have, reported
        // from the freshness watermark so a client can bound the revisable window
        // [finalized_through, provisional_through] (docs snapshot 02 §10, §15).
        finalized_through: finalizedThroughIso,
        provisional_through: freshness.watermark,
      },
      totals: mapSessionMetrics(merged.totals),
      series: merged.series.map((point) => ({
        bucket: point.bucket,
        ...mapSessionMetrics(point),
      })),
    }
  }

  /**
   * Session metrics for the public surface: the same read, minus `layering`
   * (ADR-0039, D4).
   *
   * `finalized_through` and `provisional_through` are not metrics or dimensions
   * of the site — they are the revisable-window bounds of *our* session
   * finalizer, and `finalized_through` is the watermark of a batch job we run.
   * A share page has nothing to render from them, and publishing them would make
   * every share link an unauthenticated probe of this pipeline's lag.
   *
   * The watermark is still **read**, and still decides the answer: it splits the
   * range into the finalized and provisional layers exactly as on the private
   * surface, so the two surfaces report identical numbers. It stops being
   * reported, not being used.
   *
   * The narrowing is structural rather than a delete: the declared return type
   * has no `layering`, so putting it back is a type error, and the schema's
   * `additionalProperties: false` rejects it on the wire.
   */
  async publicSessions(req: AnalyticsSessionsRequest): Promise<Schemas['PublicSessionsResponse']> {
    const { meta, totals, series } = await this.sessions(req)
    return { meta: toPublicMeta(meta), totals, series }
  }

  /**
   * The public traffic chart (ADR-0039, D8; narrowed by D10).
   *
   * `comparison` is deliberately kept and is always `null` — the route passes
   * `compare: false`, and D8 already weighed whether one permanently-null field
   * justifies a second response shape and said no. What changes here is `meta`.
   */
  async publicTimeseries(
    req: AnalyticsTimeseriesRequest,
  ): Promise<Schemas['PublicTimeseriesResponse']> {
    const { meta, series, comparison } = await this.timeseries(req)
    return { meta: toPublicMeta(meta), series, comparison }
  }

  /** Public top pages (ADR-0039, D10). Rows unchanged — a path is not a person. */
  async publicPages(req: AnalyticsReportRequest): Promise<Schemas['PublicPagesResponse']> {
    const { meta, items } = await this.pages(req)
    return { meta: toPublicMeta(meta), items }
  }

  /** Public traffic sources (ADR-0039, D10). */
  async publicSources(req: AnalyticsReportRequest): Promise<Schemas['PublicSourcesResponse']> {
    const { meta, items } = await this.sources(req)
    return { meta: toPublicMeta(meta), items }
  }

  /** Public device/browser/OS breakdown (ADR-0039, D10). */
  async publicDevices(req: AnalyticsReportRequest): Promise<Schemas['PublicDevicesResponse']> {
    const { meta, items } = await this.devices(req)
    return { meta: toPublicMeta(meta), items }
  }

  /**
   * Range totals for the public share surface (ADR-0039, decision 4 as amended).
   *
   * The private read, then a literal built field by field. `billable_events` is
   * a billing quantity — how much of this site's traffic is charged for — and an
   * owner who shares the overview is publishing how many people visited, not
   * what they pay. `comparison` goes with it for a duller reason: the public
   * route asks for no comparison period, so the field was `null` on every
   * response this surface has ever sent.
   *
   * Field by field rather than a destructure-and-spread, and that is the whole
   * mechanism: a field added to `OverviewTotals` tomorrow cannot reach the
   * public surface by inheritance, because this literal would not compile
   * without someone deciding to add it here.
   */
  async publicOverview(req: AnalyticsOverviewRequest): Promise<Schemas['PublicOverviewResponse']> {
    const { meta, totals } = await this.overview(req)
    return {
      meta: toPublicMeta(meta),
      totals: { events: totals.events, pageviews: totals.pageviews, visitors: totals.visitors },
    }
  }

  async #querySessionLayer(
    operation: string,
    siteId: string,
    range: { from: string; to: string },
    timezone: string | undefined,
    cacheEpoch: number | undefined,
  ): Promise<{
    rows: (SessionMeasures & { bucket: string })[]
    truncated: boolean
    cached: boolean
  }> {
    const params: Record<string, unknown> = { site_id: siteId, from: range.from, to: range.to }
    if (timezone !== undefined) params['timezone'] = timezone
    const result = await this.#gateway.query<Record<string, unknown>>(operation, params, {
      cacheEpoch,
    })
    return {
      rows: result.rows.map((row) => ({
        bucket: bucketToIso(row['bucket']),
        sessions: num(row['sessions']),
        engagedSessions: num(row['engaged_sessions']),
        bouncedSessions: num(row['bounced_sessions']),
        pageviews: num(row['pageviews']),
        totalSessionDurationMs: num(row['total_session_duration_ms']),
        totalActiveDurationMs: num(row['total_active_duration_ms']),
      })),
      truncated: result.meta.truncated,
      cached: result.meta.cached,
    }
  }

  // ---- Funnels (ordered steps over events_raw, bounded, §15) ------------

  async funnel(req: AnalyticsFunnelRequest): Promise<Schemas['AnalyticsFunnelResponse']> {
    const fromMs = Date.parse(req.from)
    const toMs = Date.parse(req.to)
    if (Number.isNaN(fromMs) || Number.isNaN(toMs) || toMs <= fromMs) {
      throw new ApiError('VALIDATION_FAILED', 'Funnel range must be half-open with from < to')
    }
    if (toMs - fromMs > MAX_FUNNEL_RANGE_MS) {
      // A larger range is an async job (§15), which is a documented follow-up
      // (ADR-0012); refuse rather than run an unbounded synchronous scan.
      this.#notServable(
        'funnel range exceeds the synchronous maximum; a larger range needs the async funnel job',
      )
    }

    const operation =
      req.scope === 'session' ? 'analytics.funnel_session' : 'analytics.funnel_visitor'
    const [result, freshness] = await Promise.all([
      this.#gateway.query<Record<string, unknown>>(
        operation,
        {
          site_id: req.siteId,
          from: req.from,
          to: req.to,
          steps: req.steps,
          window_ms: req.windowMs,
        },
        { cacheEpoch: req.cacheEpoch },
      ),
      this.#freshness(req.siteId, req.cacheEpoch, null),
    ])

    const row = result.rows[0]
    const entry = num(row?.['step_1'])
    const steps = req.steps.map((key, index) => {
      const count = num(row?.[`step_${index + 1}`])
      return {
        step: index + 1,
        key,
        count,
        conversion_rate: entry > 0 ? count / entry : 0,
      }
    })

    return {
      meta: {
        requested_range: { from: req.from, to: req.to },
        timezone: req.timezone,
        scope: req.scope,
        window_ms: req.windowMs,
        freshness: {
          state: freshness.state,
          watermark: freshness.watermark,
          as_of: this.#now().toISOString(),
        },
        cached: result.meta.cached,
      },
      steps,
    }
  }

  // ---- Recent visitors (event facts at the leading edge, ADR-0024) ------

  async recentVisitors(
    req: AnalyticsRecentRequest & { limit: number; includeRevenue: boolean },
  ): Promise<Schemas['AnalyticsRecentVisitorsResponse']> {
    const [result, freshness, revenue] = await Promise.all([
      this.#gateway.query<Record<string, unknown>>(
        'analytics.recent_visitors',
        { site_id: req.siteId, from: req.from, to: req.to, limit: req.limit },
        { cacheEpoch: req.cacheEpoch },
      ),
      this.#freshness(req.siteId, req.cacheEpoch, null),
      // Owner-only (revenue:read), decided by the route. The rows come back
      // keyed on the attribution's own identity — the identify() hash for an
      // identified buyer, the anonymous id otherwise — so a visitor row is
      // matched on either of its two ids below.
      req.includeRevenue
        ? this.#gateway.query<Record<string, unknown>>(
            'analytics.visitor_revenue',
            { site_id: req.siteId, from: req.from, to: req.to },
            { cacheEpoch: req.cacheEpoch },
          )
        : Promise.resolve(null),
    ])

    const revenueByKey = new Map<string, Schemas['VisitorRevenue']>()
    for (const row of revenue?.rows ?? []) {
      revenueByKey.set(str(row['visitor_key']), {
        amount_minor: num(row['amount_minor']),
        currency: str(row['currency']),
        transaction_count: num(row['transaction_count']),
      })
    }

    return {
      // The gateway's own `truncated` cannot fire here — its row cap is the
      // parameter's own maximum, so a bound query never exceeds it. A full page
      // is the honest signal instead: "this is exactly what you asked for, and
      // there may be more behind it".
      meta: this.#recentMeta(req, result.meta, freshness, result.rows.length >= req.limit),
      items: result.rows.map((row) => {
        const item: Schemas['RecentVisitor'] = {
          visitor: str(row['visitor']),
          country: str(row['country']),
          device_type: str(row['device_type']),
          browser: str(row['browser']),
          os: str(row['os']),
          first_seen: bucketToIso(row['first_seen']),
          last_seen: bucketToIso(row['last_seen']),
          pageviews: num(row['pageviews']),
        }
        // A marker, not a column: attached only when the window holds
        // attributed revenue for either of the row's identities. The row key
        // is the anonymous id; `user_id` is the CP3 fold the response never
        // carries — it exists on the gateway row precisely for this join.
        const parts = [
          revenueByKey.get(str(row['visitor'])),
          str(row['user_id']) !== '' ? revenueByKey.get(str(row['user_id'])) : undefined,
        ].filter((part): part is Schemas['VisitorRevenue'] => part !== undefined)
        if (parts.length > 0) {
          item.revenue = {
            amount_minor: parts.reduce((sum, part) => sum + part.amount_minor, 0),
            currency: parts[0]!.currency,
            transaction_count: parts.reduce((sum, part) => sum + part.transaction_count, 0),
          }
        }
        return item
      }),
    }
  }

  async visitorTrail(
    req: AnalyticsRecentRequest & { visitor: string; includeRevenue: boolean },
  ): Promise<Schemas['AnalyticsVisitorResponse']> {
    const [result, freshness, revenue] = await Promise.all([
      this.#gateway.query<Record<string, unknown>>(
        'analytics.visitor_trail',
        {
          site_id: req.siteId,
          from: req.from,
          to: req.to,
          visitor: req.visitor,
          limit: VISITOR_TRAIL_LIMIT,
        },
        { cacheEpoch: req.cacheEpoch },
      ),
      this.#freshness(req.siteId, req.cacheEpoch, null),
      // Owner-only (revenue:read), decided by the route. The operation widens
      // the match to the identify() hash through the identify event's own
      // dual carry, so an identified buyer's charges land on their one row.
      req.includeRevenue
        ? this.#gateway.query<Record<string, unknown>>(
            'analytics.visitor_revenue_entries',
            { site_id: req.siteId, from: req.from, to: req.to, visitor: req.visitor },
            { cacheEpoch: req.cacheEpoch },
          )
        : Promise.resolve(null),
    ])

    const response: Schemas['AnalyticsVisitorResponse'] = {
      meta: this.#recentMeta(
        req,
        result.meta,
        freshness,
        result.rows.length >= VISITOR_TRAIL_LIMIT,
      ),
      visitor: req.visitor,
      sessions: groupVisitorSessions(
        result.rows.map((row) => ({
          sessionId: str(row['session_id']),
          pageView: {
            event_id: str(row['event_id']),
            occurred_at: bucketToIso(row['occurred_at']),
            page_path: str(row['page_path']),
            page_title: str(row['page_title']),
            referrer_domain: str(row['referrer_domain']),
          },
        })),
      ),
    }

    const charges = revenue?.rows ?? []
    if (charges.length > 0) {
      // The summed marker counts converted charges only — an unconverted
      // amount belongs in the summary's per-currency remainder, and folding
      // its zeroed reporting value in would show a real payment as worthless.
      const converted = charges.filter((row) => str(row['conversion_source']) !== 'unavailable')
      response.revenue = {
        amount_minor: converted.reduce((sum, row) => sum + num(row['reporting_gross_minor']), 0),
        currency: str((converted[0] ?? charges[0])!['reporting_currency']),
        transaction_count: converted.length,
      }
      response.revenue_events = charges.map((row) => {
        const entry = renderRevenueJourneyEntry({
          kind: 'revenue_charge',
          objectId: str(row['object_id']),
          occurredAt: bucketToIso(row['occurred_at']),
          status: str(row['status']),
          currency: str(row['currency']),
          amountMinor: num(row['gross_minor']),
          reportingCurrency: str(row['reporting_currency']),
          reportingAmountMinor: num(row['reporting_gross_minor']),
          conversionSource: str(row['conversion_source']),
        })
        return {
          ...entry,
          properties: {
            ...entry.properties,
            // The attribution row's LAST-TOUCH session — an approximation,
            // stated as such on the contract: which session a payment
            // happened inside is not measured anywhere.
            session_id: str(row['session_id']),
          },
        }
      })
    }

    return response
  }

  #recentMeta(
    req: AnalyticsRecentRequest,
    result: { truncated: boolean; cached: boolean },
    freshness: FreshnessResult,
    hitRowCap: boolean,
  ): Schemas['RecentVisitorsMeta'] {
    return {
      requested_range: { from: req.from, to: req.to },
      timezone: req.timezone,
      freshness: {
        state: freshness.state,
        watermark: freshness.watermark,
        as_of: this.#now().toISOString(),
      },
      cached: result.cached,
      truncated: result.truncated || hitRowCap,
      // Not a computed field. These reads sit where the sessionizer has not
      // finalized and late events can still arrive — there is no range over which
      // they could honestly claim otherwise.
      provisional: true,
    }
  }

  // ---- Revenue (ADR-0033, D7; ClickHouse 0016/0017/0018). CP5. -----------
  //
  // Four reads, one metadata rule. Everything below builds the section 18
  // `AnalyticsMeta` through the same `#meta` and `#freshness` the rest of this
  // service uses -- so a revenue panel's freshness means exactly what the
  // chart's does -- and adds the `revenue` block, which is the part that makes an
  // empty response interpretable.
  //
  // **The empty-state trichotomy is decidable from one response** (D7,
  // 03 section 17, and the rule AGENTS.md states as "a provider failure is never
  // an empty result"):
  //
  //   * `meta.revenue.connection_status = 'not_connected'` -- nothing has ever
  //     been connected. Zero is not a number about this site's sales.
  //   * `'connected'` with zero totals -- genuinely no sales in the range.
  //   * `'degraded'` or `'disconnected'` -- the facts we have are served, and the
  //     status plus `last_synced_at` says how far they can be trusted. The
  //     totals are NOT zeroed, and that is the whole point: legacy showed a
  //     provider outage as a confident "0 revenue" (01 section 12.3).
  //
  // The service never invents that status. It is derived from the credential row
  // the route reads, and a site with no row at all is `not_connected` -- a
  // distinction the API can only make because CP1 kept the row after a
  // disconnect.

  /**
   * The revenue-specific freshness verdict, from the shared probe plus this
   * site's own rollup watermark. See `revenueFreshness` for the four rules and
   * why the event pipeline's answer is not the revenue answer.
   */
  #revenueFreshness(base: FreshnessResult, connection: RevenueConnectionInput): FreshnessResult {
    return revenueFreshness({
      base,
      rollupThrough: connection.rollupThrough,
      connected: connection.connectionStatus !== 'not_connected',
      nowMs: this.#now().getTime(),
    })
  }

  /** The connection facts the route reads from Postgres and threads in. */
  #revenueMeta(connection: RevenueConnectionInput): Schemas['RevenueConnectionMeta'] {
    return {
      provider: connection.provider,
      connection_status: connection.connectionStatus,
      last_synced_at: connection.lastSyncedAt,
      last_webhook_at: connection.lastWebhookAt,
      rollup_through: connection.rollupThrough,
    }
  }

  /**
   * Range totals, an optional comparison, and the unconverted remainder.
   *
   * The remainder is a **separate read of the facts**, per original currency,
   * and it is the contract CP3's projection demanded in as many words: a fact
   * with no usable exchange rate carries zeroed reporting amounts that mean
   * "unknown", and folding them into a total would be the confident zero this
   * milestone is named after. It is fetched only for the primary range --
   * a comparison period's remainder would be a fourth number nobody could act
   * on, and the comparison exists to say "up or down", which a per-currency
   * residue cannot.
   */
  async revenueSummary(req: RevenueSummaryRequest): Promise<Schemas['RevenueSummaryResponse']> {
    const resolved = resolveRevenue(req)
    if (!resolved.servable) this.#notServable(resolved.reason)

    const [primary, unconverted, freshness] = await Promise.all([
      this.#queryRevenueTotals(resolved.summaryOperation, req, {
        from: resolved.effectiveFrom,
        to: resolved.effectiveTo,
      }),
      this.#queryRevenueUnconverted(req, {
        from: resolved.effectiveFrom,
        to: resolved.effectiveTo,
      }),
      this.#freshness(req.siteId, req.cacheEpoch, null),
    ])

    let comparison: Schemas['RevenueSummaryResponse']['comparison'] = null
    let comparisonRange: { from: string; to: string } | null = null
    if (req.compare) {
      const prev = derivePreviousPeriod({ from: resolved.effectiveFrom, to: resolved.effectiveTo })
      if (prev) {
        comparisonRange = prev
        comparison = {
          totals: (await this.#queryRevenueTotals(resolved.summaryOperation, req, prev)).totals,
        }
      }
    }

    return {
      meta: {
        ...this.#meta({
          requested: { from: req.from, to: req.to },
          effective: { from: resolved.effectiveFrom, to: resolved.effectiveTo },
          timezone: req.timezone,
          resolution: resolved.grain,
          freshness: this.#revenueFreshness(freshness, req.connection),
          comparisonRange,
          truncated: primary.truncated,
          cached: primary.cached,
          // The remainder read degraded. The totals are still the answer that
          // was asked for, so the response is served — but `partial` is what
          // stops a client reading an empty `unconverted` as "everything
          // converted" when it means "we could not find out".
          partial: unconverted.degraded,
        }),
        revenue: this.#revenueMeta(req.connection),
      },
      totals: primary.totals,
      comparison,
      unconverted: unconverted.rows,
    }
  }

  async #queryRevenueTotals(
    operation: string,
    req: RevenueRequest,
    range: { from: string; to: string },
  ): Promise<{
    totals: Schemas['RevenueTotals']
    truncated: boolean
    cached: boolean
  }> {
    if (Date.parse(range.to) <= Date.parse(range.from)) {
      return { totals: emptyRevenueTotals(req.reportingCurrency), truncated: false, cached: false }
    }
    const result = await this.#gateway.query<Record<string, unknown>>(
      operation,
      { site_id: req.siteId, from: range.from, to: range.to },
      { cacheEpoch: req.cacheEpoch },
    )
    const row = result.rows[0]
    return {
      totals:
        row === undefined
          ? emptyRevenueTotals(req.reportingCurrency)
          : mapRevenueTotals(row, req.reportingCurrency),
      truncated: result.meta.truncated,
      cached: result.meta.cached,
    }
  }

  /**
   * The unconverted remainder, per original currency.
   *
   * Degrades rather than fails: a gateway error here marks the response
   * `partial` and returns an empty list, exactly as the freshness probe does.
   * The totals are the answer to the question that was asked, and losing a whole
   * revenue summary because a secondary read failed would be the wrong trade —
   * but silently reporting "no remainder" would be the worse one, which is what
   * `degraded` is threaded back for.
   */
  async #queryRevenueUnconverted(
    req: RevenueRequest,
    range: { from: string; to: string },
  ): Promise<{ rows: Schemas['RevenueUnconvertedCurrency'][]; degraded: boolean }> {
    if (Date.parse(range.to) <= Date.parse(range.from)) return { rows: [], degraded: false }
    try {
      const result = await this.#gateway.query<Record<string, unknown>>(
        'analytics.revenue_unconverted',
        { site_id: req.siteId, from: range.from, to: range.to },
        { cacheEpoch: req.cacheEpoch },
      )
      return {
        rows: result.rows.map((row) => ({
          currency: str(row['currency']).toUpperCase(),
          charge_gross_minor: num(row['charge_gross_minor']),
          refund_minor: num(row['refund_minor']),
          dispute_minor: num(row['dispute_minor']),
          transactions: num(row['transactions']),
        })),
        degraded: false,
      }
    } catch {
      return { rows: [], degraded: true }
    }
  }

  /** Bucketed revenue over the range, at the grain the rollups can honestly serve. */
  async revenueTimeseries(
    req: RevenueTimeseriesRequest,
  ): Promise<Schemas['RevenueTimeseriesResponse']> {
    const resolved = resolveRevenue(req)
    if (!resolved.servable) this.#notServable(resolved.reason)

    const [primary, freshness] = await Promise.all([
      this.#gateway.query<Record<string, unknown>>(
        resolved.timeseriesOperation,
        {
          site_id: req.siteId,
          from: resolved.effectiveFrom,
          to: resolved.effectiveTo,
          ...(resolved.withTimezone ? { timezone: req.timezone } : {}),
        },
        { cacheEpoch: req.cacheEpoch },
      ),
      this.#freshness(req.siteId, req.cacheEpoch, null),
    ])

    return {
      meta: {
        ...this.#meta({
          requested: { from: req.from, to: req.to },
          effective: { from: resolved.effectiveFrom, to: resolved.effectiveTo },
          timezone: req.timezone,
          resolution: resolved.grain,
          freshness: this.#revenueFreshness(freshness, req.connection),
          comparisonRange: null,
          truncated: primary.meta.truncated,
          cached: primary.meta.cached,
        }),
        revenue: this.#revenueMeta(req.connection),
      },
      series: primary.rows.map((row) => ({
        bucket: bucketToIso(row['bucket']),
        ...mapRevenueTotals(row, req.reportingCurrency),
      })),
    }
  }

  /**
   * One page of transactions, newest first.
   *
   * The **first consumer of `packages/contracts/src/pagination.ts`**, which has
   * defined `{ items, next_cursor, has_more }` and the over-fetch-by-one rule
   * since M0 with no call site. The gateway is asked for `limit + 1` rows and
   * `buildCursorPage` decides `has_more` from whether it got them -- exact on the
   * last page, and without the second count query an offset scheme would need.
   */
  async revenueTransactions(
    req: RevenueTransactionsRequest,
  ): Promise<Schemas['RevenueTransactionsResponse']> {
    const [result, freshness] = await Promise.all([
      this.#gateway.query<Record<string, unknown>>(
        'analytics.revenue_transactions',
        {
          site_id: req.siteId,
          from: req.from,
          to: req.to,
          // The first page starts at the range's own upper bound with an empty
          // id, so one statement serves the first page and every later one.
          cursor_occurred_at:
            req.cursor === null ? req.to : new Date(req.cursor.occurredAtMs).toISOString(),
          cursor_object_id: req.cursor === null ? '' : req.cursor.objectId,
          limit: req.limit + 1,
        },
        { cacheEpoch: req.cacheEpoch },
      ),
      this.#freshness(req.siteId, req.cacheEpoch, null),
    ])

    const rows = result.rows.map((row) => mapRevenueTransaction(row))
    const page = buildCursorPage(rows, req.limit, (row) =>
      encodeRevenueCursor({
        occurredAtMs: Date.parse(row.occurred_at),
        objectId: row.object_id,
      }),
    )

    return {
      meta: {
        ...this.#meta({
          requested: { from: req.from, to: req.to },
          effective: { from: req.from, to: req.to },
          timezone: req.timezone,
          // A list is not bucketed. `hour` is reported because the field is
          // required and is the grain this range would have been served at; a
          // client reading a resolution off a transactions response is reading a
          // field with no meaning here, and inventing a `none` value for one
          // surface would widen a shared enum for nothing.
          resolution: 'hour',
          freshness: this.#revenueFreshness(freshness, req.connection),
          comparisonRange: null,
          truncated: result.meta.truncated,
          cached: result.meta.cached,
        }),
        revenue: this.#revenueMeta(req.connection),
      },
      items: page.items,
      next_cursor: page.next_cursor,
      has_more: page.has_more,
    }
  }

  /**
   * One transaction's journey: its session touchpoints and the money events of
   * its order, rendered through the 03 section 11 display contract.
   *
   * Two reads rather than one, because they answer different questions and
   * neither can be derived from the other: the attribution row carries the
   * touchpoints and the model metadata, and the fact read carries the charge
   * plus every refund and dispute pointing at it. D2d deliberately put the
   * refund's *money* in its own bucket while keeping the *link* -- this is the
   * surface that link exists for.
   *
   * An unmatched charge is not an error. It has no attribution row, so the
   * journey is the money events alone with `confidence = 'none'` -- a
   * first-class outcome (D6), and the response says so rather than 404ing a
   * transaction that plainly exists.
   */
  async revenueTransactionJourney(
    req: RevenueJourneyRequest,
  ): Promise<Schemas['RevenueJourneyResponse']> {
    const [attribution, objects, freshness] = await Promise.all([
      this.#gateway.query<Record<string, unknown>>(
        'analytics.revenue_transaction_journey',
        { site_id: req.siteId, object_id: req.objectId },
        { cacheEpoch: req.cacheEpoch },
      ),
      this.#gateway.query<Record<string, unknown>>(
        'analytics.revenue_order_objects',
        {
          site_id: req.siteId,
          object_id: req.objectId,
          // Bounded so one journey does not scan every partition the site has
          // ever had. A day below the viewed range absorbs the resolver's
          // boundary snapping, and the ceiling runs to now because a refund or a
          // dispute can be issued long after the range being looked at — they
          // only ever FOLLOW their charge, never precede it.
          ...journeyObjectWindow(req.from, req.to, this.#now()),
        },
        { cacheEpoch: req.cacheEpoch },
      ),
      this.#freshness(req.siteId, req.cacheEpoch, null),
    ])

    if (objects.rows.length === 0) {
      throw new ApiError('NOT_FOUND', 'No such revenue transaction on this site')
    }

    const row = attribution.rows[0]
    /**
     * Whether this transaction has a journey at all.
     *
     * **Not `row !== undefined`**, and that distinction is the CP7 deviation.
     * The matcher writes an attribution row for an unmatched charge too — that
     * is D6's "unmatched is a first-class outcome", and the row carries
     * `matched_via: 'none'`, `confidence: 'none'`, empty touch blocks and a
     * `ft_session_start` of zero. Reading row-presence as "matched" therefore
     * served an unmatched charge a first-touch block of empty strings dated
     * **1970-01-01**, beside `model_version: 1` and `window_days: 30`, where the
     * contract requires all five to be null. A client rendering "first seen"
     * from that shows the epoch.
     *
     * `none` on either field is the matcher's own vocabulary for "there is no
     * journey here", so it is what this reads.
     */
    const matchedVia_ = matchedVia(row === undefined ? '' : str(row['matched_via']))
    const confidence_ = matchConfidence(row === undefined ? '' : str(row['confidence']))
    const matched = row !== undefined && matchedVia_ !== 'none' && confidence_ !== 'none'

    const entries: Schemas['RevenueJourneyEntry'][] = [
      ...parseJourneyTouchpoints(matched ? str(row['journey']) : ''),
      ...objects.rows.map((object) =>
        renderRevenueJourneyEntry({
          kind: moneyEntryKind(str(object['object_kind'])),
          objectId: str(object['object_id']),
          occurredAt: bucketToIso(object['occurred_at']),
          status: str(object['status']),
          currency: str(object['currency']).toUpperCase(),
          amountMinor: num(object['gross_minor']),
          reportingCurrency: str(object['reporting_currency']).toUpperCase(),
          reportingAmountMinor: num(object['reporting_gross_minor']),
          conversionSource: str(object['conversion_source']),
        }),
      ),
    ].sort((a, b) => (a.occurred_at < b.occurred_at ? -1 : a.occurred_at > b.occurred_at ? 1 : 0))

    return {
      meta: {
        ...this.#meta({
          requested: { from: req.from, to: req.to },
          effective: { from: req.from, to: req.to },
          timezone: req.timezone,
          resolution: 'hour',
          freshness: this.#revenueFreshness(freshness, req.connection),
          comparisonRange: null,
          truncated: false,
          cached: attribution.meta.cached && objects.meta.cached,
        }),
        revenue: this.#revenueMeta(req.connection),
      },
      object_id: req.objectId,
      // `none`/`none` is the matcher's own answer for an unmatched charge and is
      // never null: an unmatched transaction is a first-class outcome (D6), not
      // a gap. Everything BELOW is null in that case — see `matched`.
      matched_via: matchedVia_,
      confidence: confidence_,
      identity_scope: matched ? identityScope(str(row['identity_scope'])) : null,
      model_version: matched ? num(row['model_version']) : null,
      window_days: matched ? num(row['window_days']) : null,
      touchpoint_count: matched ? num(row['touchpoint_count']) : 0,
      journey_truncated: matched ? num(row['journey_truncated']) === 1 : false,
      first_touch: matched ? mapTouchBlock(row, 'ft_') : null,
      last_touch: matched ? mapTouchBlock(row, 'lt_') : null,
      entries,
    }
  }
}

/**
 * Groups a visitor's page views into client-hinted sessions.
 *
 * The gateway returns rows newest-first (its row cap has to cut the *oldest*
 * activity, not the newest), so each session's pages are reversed back into the
 * order they happened. Sessions come out newest-first by start instant, which is
 * the order a trail is read in.
 *
 * A page view whose client sent no session hint lands in a single group keyed by
 * the empty string rather than being dropped or given a session of its own: it is
 * honestly unattributed, and inventing a session per orphan would read as a
 * visitor bouncing in and out.
 */
function groupVisitorSessions(
  rows: readonly { sessionId: string; pageView: Schemas['VisitorPageView'] }[],
): Schemas['VisitorSession'][] {
  const bySession = new Map<string, Schemas['VisitorPageView'][]>()
  for (const row of rows) {
    const pages = bySession.get(row.sessionId)
    if (pages === undefined) bySession.set(row.sessionId, [row.pageView])
    else pages.push(row.pageView)
  }

  const sessions = [...bySession.entries()].map(([sessionId, pages]) => {
    const ordered = [...pages].reverse()
    return {
      session_id: sessionId,
      started_at: ordered[0]?.occurred_at ?? '',
      ended_at: ordered[ordered.length - 1]?.occurred_at ?? '',
      pages: ordered,
    }
  })

  // Ties break on session_id so a visitor with two sessions starting in the same
  // millisecond gets a stable order rather than insertion order.
  return sessions.sort((a, b) =>
    a.started_at === b.started_at
      ? a.session_id < b.session_id
        ? 1
        : -1
      : a.started_at < b.started_at
        ? 1
        : -1,
  )
}

const EMPTY_LAYER = {
  rows: [] as (SessionMeasures & { bucket: string })[],
  truncated: false,
  cached: true,
}

function mapSessionMetrics(m: SessionMetrics): Schemas['SessionMetricValues'] {
  return {
    sessions: m.sessions,
    engaged_sessions: m.engagedSessions,
    bounced_sessions: m.bouncedSessions,
    bounce_rate: m.bounceRate,
    pageviews: m.pageviews,
    avg_session_duration_ms: m.avgSessionDurationMs,
    avg_active_duration_ms: m.avgActiveDurationMs,
  }
}

function emptyTotals(): Schemas['OverviewTotals'] {
  return { events: 0, pageviews: 0, visitors: 0, billable_events: 0 }
}

function mapGeographyRow(r: Record<string, unknown>): DomainGeographyRow {
  return {
    country: str(r['country']),
    city: str(r['city']),
    views: num(r['views']),
    visitors: num(r['visitors']),
  }
}

/**
 * The verdict every surface with no imported branch reports.
 *
 * A frozen constant rather than a fresh object per response, so a surface that
 * never touches an import cannot accidentally start reporting something else.
 */
const LIVE_ONLY_SOURCES: AnalyticsSourceVerdict = Object.freeze({
  dataSources: Object.freeze(['live'] as const),
  accuracy: 'exact',
})

/** The gateway's own top-N ceiling. Asking past it is a validation failure, not
 * a deeper read. */
const TOP_N_MAX = 500

/** How deep each side of a merge is read (ADR-0032, D2b). */
function mergeFetchLimit(limit: number): number {
  return Math.min(limit * 2, TOP_N_MAX)
}

/** The ranges a response actually answered over: primary, then comparison. */
function rangesOf(
  primary: { from: string; to: string },
  comparison: { from: string; to: string } | null,
): { from: string; to: string }[] {
  return comparison === null ? [primary] : [primary, comparison]
}

// The live and imported operations project the same column names for a given
// report, so one mapper reads both — which is what makes a merged row
// indistinguishable from a live one. The only exception is custom events, where
// the imported side has no event type to report.

function mapPageRow(r: Record<string, unknown>): Schemas['PageRow'] {
  return { page_path: str(r['page_path']), views: num(r['views']), visitors: num(r['visitors']) }
}

function mapSourceRow(r: Record<string, unknown>): Schemas['SourceRow'] {
  return {
    referrer_domain: str(r['referrer_domain']),
    utm_source: str(r['utm_source']),
    utm_medium: str(r['utm_medium']),
    utm_campaign: str(r['utm_campaign']),
    views: num(r['views']),
    visitors: num(r['visitors']),
  }
}

function mapDeviceRow(r: Record<string, unknown>): Schemas['DeviceRow'] {
  return {
    device_type: str(r['device_type']),
    browser: str(r['browser']),
    os: str(r['os']),
    views: num(r['views']),
    visitors: num(r['visitors']),
  }
}

/**
 * An imported device class, in the live row's shape.
 *
 * `browser` and `os` are **`unknown`**, not the empty string. `unknown` is the
 * token the live user-agent classifier emits when it could not tell
 * (`normalizeUserAgentClass`), so an imported device row lands on the site's
 * existing "device known, browser and OS unknown" row instead of forming a third
 * value that merges with neither. Geography is deliberately the opposite: the
 * live geo path stores `''` for an unresolved city, so that is what an imported
 * geography row carries.
 */
function mapImportedDeviceRow(r: Record<string, unknown>): Schemas['DeviceRow'] {
  return {
    device_type: str(r['device_type']),
    browser: 'unknown',
    os: 'unknown',
    views: num(r['views']),
    visitors: num(r['visitors']),
  }
}

function mapCustomEventRow(r: Record<string, unknown>): Schemas['CustomEventRow'] {
  return {
    event_name: str(r['event_name']),
    event_type: str(r['event_type']),
    events: num(r['events']),
    billable_events: num(r['billable_events']),
    visitors: num(r['visitors']),
    // Filled in by the route, which is the only layer with a Postgres handle
    // (ADR-0034, D7). Null here rather than absent, so the shape is complete
    // whichever caller assembles it.
    display_name: null,
    display_template: null,
    // Filled in from the sample operation when it has something to say
    // (ADR-0038, D5). Null is the shipped answer for every range that ends
    // before ClickHouse migration 0021 — nothing backfills a materialized view.
    last_seen_at: null,
    sample_page_path: null,
    sample_properties: null,
  }
}

/**
 * An imported custom event, in the live row's shape.
 *
 * `event_type` is `custom_event` rather than the empty string, and that choice is
 * what lets an imported "Signup" merge onto the live "Signup" instead of sitting
 * beside it as a second row with a blank type. `conversion` is our own
 * classification of a customer's own goal and no provider export carries it.
 *
 * `billable_events` is zero: import data is not billable (D10), and there is no
 * code path from the import pipeline to the usage ledger for it to have come
 * from.
 */
function mapImportedCustomEventRow(r: Record<string, unknown>): Schemas['CustomEventRow'] {
  return {
    event_name: str(r['event_name']),
    event_type: 'custom_event',
    events: num(r['events']),
    billable_events: 0,
    visitors: num(r['visitors']),
    display_name: null,
    display_template: null,
    // An aggregate-only export has no event instant, no path and no properties
    // in it, so these are null for an imported row permanently, not pending a
    // migration (ADR-0038, D5).
    last_seen_at: null,
    sample_page_path: null,
    sample_properties: null,
  }
}

/**
 * The key a custom-event row is identified by everywhere: its name and its
 * type. One function, so the sample join and the imported merge below cannot
 * drift into keying on different things.
 */
function customEventKey(name: string, type: string): string {
  return `${name}\u0000${type}`
}

/**
 * Joins one sample row onto its live custom-event row (ADR-0038, D5).
 *
 * A name with no sample keeps the three nulls it was mapped with — the shipped
 * answer for a range that ends before ClickHouse migration 0021, for an event
 * that has not fired inside the range, and for anything the top-N cut left out.
 * An empty `sample_page_path` becomes `null` rather than travelling as `""`: a
 * custom event fired outside any page context has no path, and the empty string
 * would render as a link to the site root.
 */
function decorateCustomEventRow(
  row: Schemas['CustomEventRow'],
  samples: ReadonlyMap<string, Record<string, unknown>>,
): Schemas['CustomEventRow'] {
  const sample = samples.get(customEventKey(row.event_name, row.event_type))
  if (!sample) return row
  const path = str(sample['sample_page_path'])
  return {
    ...row,
    last_seen_at: bucketToIso(sample['last_seen_at']),
    sample_page_path: path === '' ? null : path,
    sample_properties: parseSampleProperties(sample['sample_properties']),
  }
}

/**
 * Parses one stored properties bag (ADR-0038, D5/D7).
 *
 * The column is JSON *text* — `events_raw.properties` as the collector wrote it
 * — and a bag that does not parse, or that parses to something other than an
 * object, answers `null` rather than throwing: one unreadable sample must not
 * fail a whole custom-events read. An event that fired with no properties
 * stored `{}` and answers `{}`, which is a different fact from `null`.
 */
function parseSampleProperties(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string' || value === '') return null
  try {
    const parsed: unknown = JSON.parse(value)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Revenue mappers (ADR-0033, D7). Milestone 12 Checkpoint 5.
// ---------------------------------------------------------------------------

/**
 * Freshness for a revenue read, which is a different question from freshness
 * for a pageview read (ADR-0025's philosophy, applied to a second pipeline).
 *
 * The shared `#freshness` answers "is the EVENT pipeline running and current",
 * from the ingest heartbeat and the newest `metrics_1m` bucket. Neither input
 * says anything about revenue, and two consequences follow that this function
 * exists to fix:
 *
 * 1. **A revenue-only site reads `no_data`.** A customer who connected Stripe
 *    and has not installed the tracker has no live bucket at all, so the shared
 *    probe answers `no_data` — beside real, non-zero revenue totals. That is the
 *    same shape ADR-0032 D5 fixed for imported-only sites, and the same escape
 *    applies: when this site's revenue pipeline has a watermark, that watermark
 *    is what freshness is about.
 * 2. **A dead projection or attribution loop reads `ok`.** The provider is
 *    answering, the credential is `connected`, the event pipeline is healthy —
 *    and the buckets stopped being computed an hour ago, so the totals are
 *    silently frozen. This is the internal half of acceptance criterion 3, and
 *    nothing in the credential row can see it.
 *
 * The rules, in order:
 *
 * - **Never connected** — nothing revenue-specific to say. The base verdict
 *   stands and `connection_status` carries the story.
 * - **No watermark** — `no_data`. Our pipeline has computed nothing for this
 *   site, which is exactly true and is distinguishable from `ok` with zeros.
 * - **Watermark older than the threshold** — `stale`. The loop is behind
 *   whatever the provider is doing.
 * - **Otherwise** — `ok`, unless the base probe itself degraded, which is a
 *   statement about the gateway and outranks a healthy watermark.
 *
 * The reported watermark is always the revenue one when there is one: a client
 * showing "as of" beside a revenue figure should be shown when that figure was
 * computed, not when somebody last loaded a page.
 */
export function revenueFreshness(input: {
  readonly base: FreshnessResult
  readonly rollupThrough: string | null
  readonly connected: boolean
  readonly nowMs: number
}): FreshnessResult {
  if (!input.connected) return input.base
  if (input.base.state === 'degraded') return input.base

  if (input.rollupThrough === null) {
    return { state: 'no_data', watermark: null, partial: input.base.partial }
  }

  const throughMs = Date.parse(input.rollupThrough)
  if (Number.isNaN(throughMs)) {
    return { state: 'no_data', watermark: null, partial: input.base.partial }
  }
  const behind = input.nowMs - throughMs > REVENUE_ROLLUP_STALE_AFTER_MS
  return {
    state: behind ? 'stale' : 'ok',
    watermark: input.rollupThrough,
    partial: input.base.partial,
  }
}

/**
 * A bucket or a range total, in the site's reporting currency.
 *
 * `currency` comes from the site row rather than from the rollup, and that is
 * deliberate: the rollup has no currency column because every amount in it is
 * already materialized in the site's reporting currency (0018), and a column
 * repeating the setting on every bucket would be a second place for it to be
 * wrong. If a reporting-currency change is mid-flight, the label is the NEW
 * currency while some old buckets may still hold the old one -- which is exactly
 * why the currency change queues a full-site re-roll rather than trusting the
 * rolling horizon.
 */
function mapRevenueTotals(r: Record<string, unknown>, currency: string): Schemas['RevenueTotals'] {
  return {
    currency,
    charge_gross_minor: num(r['charge_gross_minor']),
    refund_minor: num(r['refund_minor']),
    dispute_withdrawn_minor: num(r['dispute_withdrawn_minor']),
    dispute_reinstated_minor: num(r['dispute_reinstated_minor']),
    fee_minor: num(r['fee_minor']),
    net_minor: num(r['net_minor']),
    charge_count: num(r['charge_count']),
    refund_count: num(r['refund_count']),
    dispute_count: num(r['dispute_count']),
    unconverted_count: num(r['unconverted_count']),
  }
}

/**
 * The all-zero total.
 *
 * Returned only when the range is empty or degenerate -- never as a substitute
 * for a failed read. A gateway failure propagates as a typed `ApiError` and the
 * route answers 503, because "the provider is down" and "you earned nothing" are
 * the two things this milestone exists to keep apart.
 */
function emptyRevenueTotals(currency: string): Schemas['RevenueTotals'] {
  return {
    currency,
    charge_gross_minor: 0,
    refund_minor: 0,
    dispute_withdrawn_minor: 0,
    dispute_reinstated_minor: 0,
    fee_minor: 0,
    net_minor: 0,
    charge_count: 0,
    refund_count: 0,
    dispute_count: 0,
    unconverted_count: 0,
  }
}

/**
 * One transaction row, with money in the `money.ts` shapes.
 *
 * `reporting` and `conversion` are **null together** when there was no usable
 * rate. Null rather than zero, and that is the single most important line in
 * this mapper: a zero is a number a client will happily add up, and the whole
 * D2c contract is that an unconverted amount is *unknown*, not *nothing*. The
 * original `gross`/`refund`/`fee`/`net` are always present and always real.
 */
function mapRevenueTransaction(r: Record<string, unknown>): Schemas['RevenueTransaction'] {
  const currency = str(r['currency']).toUpperCase()
  const kind = str(r['object_kind'])
  const conversionSource = str(r['conversion_source'])
  const converted = conversionSource !== 'unavailable'
  const grossMinor = num(r['gross_minor'])
  const feeMinor = num(r['fee_minor'])
  const netMinor = num(r['net_minor'])

  return {
    object_id: str(r['object_id']),
    provider: str(r['provider']),
    object_kind: objectKind(kind),
    occurred_at: bucketToIso(r['occurred_at']),
    status: str(r['status']),
    livemode: num(r['livemode']) === 1,
    // Gross and refund are the same stored magnitude read through the kind: a
    // refund object's `gross_minor` IS the refunded amount (D2d applies the sign
    // at rollup and read, never in storage). Separate fields so a client never
    // has to infer a refund by subtracting rounded values (03 section 6.5).
    gross: { amount_minor: kind === 'charge' ? grossMinor : 0, currency },
    refund: { amount_minor: kind === 'refund' ? grossMinor : 0, currency },
    fee: { amount_minor: feeMinor, currency },
    net: { amount_minor: netMinor, currency },
    reporting: converted
      ? {
          amount_minor: num(r['reporting_net_minor']),
          currency: str(r['reporting_currency']).toUpperCase(),
        }
      : null,
    conversion: converted
      ? {
          source: conversionSource,
          rate: num(r['conversion_rate']),
          // The ECB banking day the rate came from, at midnight UTC. It is a
          // date in ClickHouse and an instant on the wire, because every other
          // timestamp in this contract is.
          rate_at: `${str(r['conversion_rate_date'])}T00:00:00.000Z`,
        }
      : null,
    parent_object_id: emptyToNull(str(r['parent_object_id'])),
    order_id: emptyToNull(str(r['order_id'])),
    product_name: emptyToNull(str(r['product_name'])),
    // The attribution is a LEFT JOIN, so an unmatched transaction arrives with
    // empty strings rather than absent keys. Normalized to the matcher's own
    // vocabulary: `none` is a first-class outcome (D6), not a gap.
    matched_via: matchedVia(str(r['matched_via'])),
    confidence: matchConfidence(str(r['confidence'])),
  }
}

/**
 * The window the order's money objects are read over.
 *
 * A day below the viewed range and up to a day past now. The charge is inside
 * the viewed range by construction — the caller reached this endpoint from the
 * transactions list — and refunds and disputes only ever follow it, so nothing
 * relevant can be missed at either end. What this buys is the difference between
 * reading the monthly partitions of one range and reading every partition the
 * site has ever had, on every journey a customer opens.
 */
function journeyObjectWindow(from: string, to: string, now: Date): { from: string; to: string } {
  const fromMs = Date.parse(from) - 86_400_000
  // `now` rather than `to`, and a day past it for clock skew: a refund issued
  // after the range being viewed still belongs to this journey.
  const toMs = Math.max(Date.parse(to), now.getTime()) + 86_400_000
  return { from: new Date(Math.max(0, fromMs)).toISOString(), to: new Date(toMs).toISOString() }
}

/** ClickHouse's absence sentinel is `''`; the wire's is `null`. */
function emptyToNull(value: string): string | null {
  return value === '' ? null : value
}

/** `object_kind` to the journey's display kind. */
function moneyEntryKind(objectKind: string): MoneyEntryInput['kind'] {
  if (objectKind === 'refund') return 'revenue_refund'
  if (objectKind === 'dispute') return 'revenue_dispute'
  return 'revenue_charge'
}

/**
 * The stored journey document, rendered as display entries.
 *
 * Defensive about the parse and silent about a failure, which is unusual here
 * and is the right call for this one field: the document is written by the
 * worker and is a bounded JSON array by construction, so a parse failure means
 * a corrupted row rather than a client error, and answering the journey with its
 * money events and no touchpoints is strictly better than 500ing a page that
 * would otherwise render.
 */
function parseJourneyTouchpoints(document: string): Schemas['RevenueJourneyEntry'][] {
  if (document === '') return []
  let parsed: unknown
  try {
    parsed = JSON.parse(document)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []

  const entries: Schemas['RevenueJourneyEntry'][] = []
  for (const raw of parsed) {
    if (typeof raw !== 'object' || raw === null) continue
    const touchpoint = raw as Record<string, unknown>
    entries.push(
      renderRevenueJourneyEntry({
        kind: 'session_entry',
        sessionId: str(touchpoint['session_id']),
        occurredAt: str(touchpoint['session_start']),
        entryPage: str(touchpoint['entry_page']),
        referrerDomain: str(touchpoint['referrer_domain']),
        utmSource: str(touchpoint['utm_source']),
        utmMedium: str(touchpoint['utm_medium']),
        utmCampaign: str(touchpoint['utm_campaign']),
        utmContent: str(touchpoint['utm_content']),
        utmTerm: str(touchpoint['utm_term']),
      }),
    )
  }
  return entries
}

/**
 * A first- or last-touch block, from its `ft_`/`lt_` prefixed columns.
 *
 * An unmatched charge has no attribution row at all and gets `null` from the
 * caller; a matched one whose touch block is empty (structurally impossible
 * today, since a match implies at least one session) would render as a block of
 * empty strings, which is honest rather than absent.
 */
function mapTouchBlock(r: Record<string, unknown>, prefix: 'ft_' | 'lt_'): Schemas['RevenueTouch'] {
  return {
    session_id: str(r[`${prefix}session_id`]),
    session_start: bucketToIso(r[`${prefix}session_start`]),
    referrer_domain: str(r[`${prefix}referrer_domain`]),
    utm_source: str(r[`${prefix}utm_source`]),
    utm_medium: str(r[`${prefix}utm_medium`]),
    utm_campaign: str(r[`${prefix}utm_campaign`]),
    utm_content: str(r[`${prefix}utm_content`]),
    utm_term: str(r[`${prefix}utm_term`]),
    entry_page: str(r[`${prefix}entry_page`]),
  }
}

/**
 * ClickHouse returns a `LowCardinality(String)`, the contract declares a closed
 * enum, and the two are only the same set while both ends agree. These three
 * narrow explicitly and fall back to the vocabulary's own "nothing here" value.
 *
 * Falling back rather than throwing is deliberate and it is the same judgement
 * the matcher makes about an unknown provider status: a value this build has not
 * learned about should degrade a single field, not fail a whole revenue page. An
 * empty string is what a `LEFT JOIN` produces for an unmatched transaction, and
 * `none` is precisely what the matcher itself would have written for one.
 */
function matchedVia(value: string): Schemas['RevenueMatchedVia'] {
  return value === 'conversion_event' ||
    value === 'client_reference' ||
    value === 'customer_identity'
    ? value
    : 'none'
}

function matchConfidence(value: string): Schemas['RevenueMatchConfidence'] {
  return value === 'exact' || value === 'linked' ? value : 'none'
}

function identityScope(value: string): Schemas['RevenueIdentityScope'] | null {
  return value === 'identified' || value === 'anonymous_day' ? value : null
}

/** The three kinds `revenue_events` stores. `charge` is the fallback because it
 * is the only kind that can exist without a parent, so an unknown kind renders
 * as a standalone money movement rather than as an orphan refund. */
function objectKind(value: string): Schemas['RevenueTransaction']['object_kind'] {
  return value === 'refund' || value === 'dispute' ? value : 'charge'
}

/**
 * `AnalyticsMeta` narrowed for the public share surface (ADR-0039, D10).
 *
 * **Field by field, and that is the whole mechanism** — the same one
 * `publicOverview` uses for `OverviewTotals` and `toPublicSnapshot` uses for the
 * realtime board (ADR-0024, D2). A field added to `AnalyticsMeta` tomorrow
 * cannot reach an anonymous caller by inheritance, because this literal would
 * not compile without someone deciding to add it here. A spread with a `delete`,
 * or a filter at the route, would both have carried the next field silently.
 *
 * What is dropped, and why each is not a fact about the site being shared:
 *
 * - **`freshness`** — `state` is our ingest pipeline's health, computed from the
 *   worker's heartbeat and its queue age (ADR-0025). Publishing it makes every
 *   share link an unauthenticated probe of our own lag, which is exactly what D4
 *   removed `layering` for one level down. `watermark` is the site's newest
 *   rolled-up minute **for all time** — `analytics.freshness` is
 *   `max(bucket_start) FROM metrics_1m WHERE site_id = …` with no range filter —
 *   so on an anonymous surface it answers "when did this site last have a
 *   visitor", to the minute, including right now and including outside the
 *   window the share displays. `as_of` goes with them rather than moving to a
 *   new home: nothing on the share page renders it, and relocating a field is a
 *   decision to add one.
 * - **`revenue`** — present only on revenue reads, which are owner-only behind
 *   `revenue:read` and can never be reached through a share slug. Omitting it
 *   from the type makes that structural instead of incidental.
 *
 * Everything kept describes the *query*: what was asked for, what was served, in
 * which zone, at which grain, from which stores, and how far the answer can be
 * trusted. That is what this object is for (ADR-0039 D9).
 */
function toPublicMeta(meta: Schemas['AnalyticsMeta']): Schemas['PublicAnalyticsMeta'] {
  return {
    requested_range: meta.requested_range,
    effective_range: meta.effective_range,
    timezone: meta.timezone,
    resolution: meta.resolution,
    data_sources: meta.data_sources,
    accuracy: meta.accuracy,
    comparison_range: meta.comparison_range,
    truncated: meta.truncated,
    cached: meta.cached,
    partial: meta.partial,
  }
}
