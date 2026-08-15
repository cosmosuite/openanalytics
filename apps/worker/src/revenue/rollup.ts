import type { RevenueRollupUnit, RevenueRollupsStore } from '@openanalytics/clickhouse'
import type { Logger, Metrics } from '@openanalytics/observability'
import { WORKER_METRICS } from '../ingest/metrics.ts'
import {
  affectedBucketSecondsOf,
  aggregateRevenueBuckets,
  planRevenueRollupSwap,
  type RollupFact,
} from './rollup-plan.ts'

/**
 * The revenue rollup step (ADR-0033, D7; ClickHouse migration 0018). Milestone
 * 12 Checkpoint 5.
 *
 * ============================================================================
 * WHY THIS IS A STEP OF THE ATTRIBUTION JOB RATHER THAN A LOOP OF ITS OWN
 * ============================================================================
 *
 * It could have been a third worker loop beside the projection and the
 * attribution. It is not, for four reasons that all point the same way:
 *
 *  1. **The lease already exists.** `revenue_attribution_state` holds a per-site
 *     lease and a watermark whose meaning — "the instant whose inputs this site
 *     was computed against" — is exactly as true of a bucket as of a journey. A
 *     second loop would need a second lease table, a second discovery query and
 *     a second set of lease bugs to find.
 *  2. **The input read is the same read.** Both need current facts for the site
 *     over a horizon, through the one argMax-by-version implementation. Sharing
 *     the loop means sharing that ClickHouse round trip instead of doubling it.
 *  3. **The ordering is the guarantee.** The session finalizer's rule — facts
 *     durable, then the rollups that summarise them, then the watermark — is a
 *     property of running inside one claimed unit of work. Two loops advancing
 *     two watermarks over overlapping horizons cannot express it.
 *  4. **Discovery is already correct.** A site is due when a head changed, when
 *     a hint changed, or when its watermark went stale; a bucket is due under
 *     precisely the first and third of those. There is no fourth trigger a
 *     separate loop would have noticed.
 *
 * The cost accepted: a site whose attribution read fails does not get its
 * rollups either. That is the right direction — the run releases without
 * advancing and the next pass recomputes the identical range — and the reverse
 * (rolled-up money whose journeys silently lag) is the confusing one.
 *
 * ============================================================================
 * THE RANGE, AND WHY IT IS NOT THE ATTRIBUTION HORIZON
 * ============================================================================
 *
 * The attribution horizon is a statement about which *charges* might have a new
 * answer. The rollup range is a statement about which *buckets* might have a new
 * total, and the two differ in both directions:
 *
 *  - **Wider at the edges.** The horizon's floor is an instant, typically in the
 *    middle of an hour. Recomputing that hour from only the facts above the
 *    floor would rebuild it missing its own first minutes. So both ends are
 *    snapped to a UTC **day** boundary — the coarser of the two units — and the
 *    fact read is widened to match. One read then serves both units, and every
 *    bucket it can produce is complete.
 *
 *  - **Wider on a reporting-currency change.** Every stored amount is
 *    materialized in the site's reporting currency (D2c). Changing it
 *    re-projects every fact at a higher version — but the rolling horizon only
 *    reaches back a month, so buckets older than that would keep amounts in the
 *    *previous* currency forever, silently, with no marker anywhere saying so.
 *    `revenue_attribution_state.rollup_recompute_from` (Postgres 0037) is the
 *    full-site re-roll path: the currency `PATCH` sets it, in the same
 *    transaction as the projection reset, and it drops this range's floor to it
 *    until a pass observes the site fully re-projected. See
 *    `clearRevenueRollupRecomputeFrom` for why the clear is conditional — a
 *    rollup that ran before the projection caught up must not be the one that
 *    declares the job done.
 *
 * ============================================================================
 * Idempotence
 * ============================================================================
 *
 * A recompute that agrees with what is stored writes nothing (the planner
 * compares before it emits), and an insert that is retried after a crash
 * rebuilds byte-identical rows and is dropped by ClickHouse's content token. So
 * this step is safe to run on every tick of a job that re-reads a rolling month,
 * which is precisely what it does.
 */

const MS_PER_DAY = 86_400_000

// `'1m'` writes migration 0022's table in the same pass and the same generation
// swap, from the same facts and the same plan. It is not an optimisation: it is
// the only grain a sub-hour timezone can compose a local hour or day from, and
// writing it here rather than deriving it at read time is what keeps one
// implementation of the money rules.
const UNITS: readonly RevenueRollupUnit[] = ['1h', '1d', '1m']

export interface RevenueRollupDeps {
  readonly logger: Logger
  readonly metrics: Metrics
  readonly rollups: RevenueRollupsStore
}

/** The half-open, UTC-day-aligned range one rollup run is responsible for. */
export interface RevenueRollupRange {
  readonly loMs: number
  readonly hiMs: number
}

/**
 * How many whole UTC days of buckets one pass may recompute while walking a
 * pending re-roll cursor.
 *
 * One month, which finishes a three-year history in about thirty-six passes of a
 * sixty-second loop. The number that matters is not the elapsed time — a
 * currency change is rare and nobody is watching the buckets from 2023 — but the
 * memory ceiling: `readCurrentRows` has no LIMIT, so an unchunked walk would
 * pull a whole fact table into a process that is also ingesting events, on every
 * tick until it finished.
 *
 * It is deliberately larger than the attribution horizon (30 d window + 1 d
 * lateness), so the ORDINARY pass can never trip the chunk logic and start
 * writing a cursor for a site that has no recompute pending.
 * `tests/unit/revenue-rollup.test.ts` asserts that relation rather than trusting
 * two constants to stay in the right order.
 */
export const REVENUE_ROLLUP_RECOMPUTE_CHUNK_DAYS = 31

const CHUNK_MS = REVENUE_ROLLUP_RECOMPUTE_CHUNK_DAYS * MS_PER_DAY

export interface RevenueRollupInput {
  readonly siteId: string
  readonly range: RevenueRollupRange
  /**
   * Current facts covering **the whole range**, already read by the caller.
   *
   * Passed in rather than read here, and for the ordinary range that is the
   * point of running as a step of the attribution job: one ClickHouse round trip
   * serves both the journeys and the buckets. The caller reads the wider (rollup)
   * range and filters down to the attribution horizon in memory — safe because
   * `occurred_at` is not a column a version can change, so an in-memory filter
   * and a narrower query return the identical set.
   *
   * A recompute CHUNK is read separately, because it is disjoint from the
   * horizon by construction and unioning the two would mean reading every year
   * in between — the unbounded read the chunk exists to avoid.
   */
  readonly facts: readonly RollupFact[]
  /**
   * This run's swap generation, minted by the lease claim
   * (`revenue_attribution_state.rollup_generation_seq`).
   *
   * NOT `max(stored) + 1`. Nothing renews the five-minute lease, so a long pass
   * and the worker that stole its lease would read the same stored maximum and
   * write the same generation — the one tie ReplacingMergeTree cannot resolve.
   */
  readonly generation: number
  /** The tick's clock, so every row of one run carries one `computed_at` and a
   * retry rebuilds the identical bytes. */
  readonly computedAtMs: number
}

export interface RevenueRollupResult {
  /** Buckets whose stored value moved, summed across both units. */
  readonly changed: number
}

/** Floors an instant to the start of its UTC day. */
function floorUtcDay(ms: number): number {
  return Math.floor(ms / MS_PER_DAY) * MS_PER_DAY
}

/** Ceils an instant to the start of the next UTC day (half-open upper bound). */
function ceilUtcDay(ms: number): number {
  return Math.ceil(ms / MS_PER_DAY) * MS_PER_DAY
}

export interface RevenueRollupRangeResult {
  readonly range: RevenueRollupRange
  /**
   * A floor this pass refused to read inline because it was more than one chunk
   * below the horizon, or null.
   *
   * Non-null means the caller must hand it to the re-roll cursor
   * (`markRevenueRollupRecompute`) so the chunk walk picks it up. That is the
   * single mechanism: a late dispute close and a reporting-currency change reach
   * the same walk rather than each getting their own special case.
   */
  readonly deferredFloorMs: number | null
}

/**
 * The ordinary rollup range for one pass: the attribution horizon widened to
 * whole UTC days, and lowered to a late-changed object's occurrence when that is
 * close enough to read in one go.
 *
 * Snapped to the **day** rather than to each unit separately, because the day is
 * the coarser of the two and one read then serves both. A floor in the middle of
 * an hour would rebuild that hour from the fraction of it the horizon happened
 * to cover; a floor in the middle of a day would do the same to the day bucket.
 *
 * `changedObjectFloorMs` is the CP5 escape hatch and exists for one case the
 * charge-only horizon structurally cannot see: **a dispute resolving outside the
 * rolling window**. A dispute is one object whose status changes, so winning it
 * bumps only the dispute head while its `occurred_at` stays the day it was
 * opened — sixty to ninety days earlier, on Stripe's normal timeline. Without
 * this the bucket keeps `dispute_withdrawn_minor` forever while the transactions
 * list shows the dispute as won.
 */
export function revenueRollupRange(input: {
  readonly fromMs: number
  readonly toMs: number
  /** Oldest occurrence among heads of ANY kind that changed since the watermark. */
  readonly changedObjectFloorMs?: number | null
}): RevenueRollupRangeResult {
  const horizonFloor = Math.max(0, floorUtcDay(input.fromMs))
  const hiMs = ceilUtcDay(input.toMs)
  const changed = input.changedObjectFloorMs ?? null

  if (changed === null || changed >= horizonFloor) {
    return { range: { loMs: horizonFloor, hiMs }, deferredFloorMs: null }
  }

  const changedFloor = Math.max(0, floorUtcDay(changed))
  // Close enough to fold into this pass's single read, so no cursor is involved
  // and the common case (a dispute that closed last week) costs nothing extra.
  if (horizonFloor - changedFloor <= CHUNK_MS) {
    return { range: { loMs: changedFloor, hiMs }, deferredFloorMs: null }
  }
  // Too far back to read in one go. The cursor walk owns it.
  return { range: { loMs: horizonFloor, hiMs }, deferredFloorMs: changedFloor }
}

/**
 * The next chunk of a pending re-roll walk, or null when the cursor has caught
 * up with the ordinary range.
 *
 * Strictly below `normalFloorMs`, so the chunk and the ordinary range are always
 * disjoint and the pass's two rollups can share one generation without competing
 * for a bucket. `reachedHorizon` is what tells the caller to CLEAR the cursor
 * rather than advance it: from that point the ordinary pass covers everything.
 */
export interface RevenueRecomputeChunk {
  readonly range: RevenueRollupRange
  readonly reachedHorizon: boolean
}

export function revenueRecomputeChunk(input: {
  readonly cursorMs: number
  readonly normalFloorMs: number
}): RevenueRecomputeChunk | null {
  const loMs = Math.max(0, floorUtcDay(input.cursorMs))
  if (loMs >= input.normalFloorMs) return null
  const hiMs = Math.min(loMs + CHUNK_MS, input.normalFloorMs)
  return { range: { loMs, hiMs }, reachedHorizon: hiMs >= input.normalFloorMs }
}

/**
 * Recompute and swap every affected bucket of one site.
 *
 * Throws on a store failure, deliberately: the caller runs inside the
 * attribution job's per-site try/catch, which releases the lease without
 * advancing the watermark, so the next pass retries the identical range. A
 * swallowed failure here would advance past buckets that were never written.
 */
export async function rollUpRevenueSite(
  deps: RevenueRollupDeps,
  input: RevenueRollupInput,
): Promise<RevenueRollupResult> {
  const { loMs, hiMs } = input.range
  if (hiMs <= loMs) return { changed: 0 }

  const facts = input.facts

  let changed = 0
  for (const unit of UNITS) {
    const stored = await deps.rollups.readStoredRollups({
      siteId: input.siteId,
      unit,
      loMs,
      hiMs,
    })
    const affectedBucketSeconds = affectedBucketSecondsOf({ facts, stored, unit })
    if (affectedBucketSeconds.length === 0) continue

    const plan = planRevenueRollupSwap({
      siteId: input.siteId,
      recomputed: aggregateRevenueBuckets(facts, unit),
      stored,
      affectedBucketSeconds,
      generation: input.generation,
      computedAtMs: input.computedAtMs,
    })

    if (plan.rows.length > 0) {
      await deps.rollups.insertRollups({ unit, rows: plan.rows })
      deps.metrics.increment(WORKER_METRICS.revenueRollupSwaps, { unit }, plan.changed)
      changed += plan.changed
    }
  }

  if (changed > 0) {
    deps.logger.info('revenue_rolled_up', {
      site_id: input.siteId,
      changed,
      facts: facts.length,
      from_ms: loMs,
      to_ms: hiMs,
      generation: input.generation,
    })
  }

  return { changed }
}
