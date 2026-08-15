import type {
  CurrentRevenueEvent,
  RevenueBucketAggregate,
  RevenueBucketMeasures,
  RevenueRollupRow,
  RevenueRollupUnit,
  StoredRevenueRollupBucket,
} from '@openanalytics/clickhouse'

/**
 * The revenue rollup's pure half (ADR-0033, D2d/D7; ClickHouse migration 0018).
 * Milestone 12 Checkpoint 5.
 *
 * `apps/worker/src/sessions/plan.ts` one milestone later, and deliberately the
 * same shape: aggregate the current facts into buckets, compare each affected
 * bucket against what is stored, emit rows only for the ones that moved, all at
 * one generation above the highest stored. Nothing here talks to ClickHouse or
 * to Postgres, so every rule below is provable in the always-run unit project
 * rather than only against a live database.
 *
 * ============================================================================
 * THE SIGN RULE (D2d) — stated once, here, and mirrored in migration 0018
 * ============================================================================
 *
 * Every fact contributes to the bucket of its **own** `occurred_at`. A refund
 * reduces net revenue in the refund's bucket, never retroactively in the
 * charge's: that is what makes a July report stay what it was when September's
 * refund arrives, and it is how the provider's own reporting behaves.
 *
 *   sign(charge)              = +1
 *   sign(refund)              = -1
 *   sign(dispute, withdrawn)  = -1
 *   sign(dispute, reinstated) = +1
 *
 *   charge_gross_minor       += reporting_gross            (charges only)
 *   refund_minor             += reporting_gross            (refunds only)
 *   dispute_withdrawn_minor  += reporting_gross            (magnitude)
 *   dispute_reinstated_minor += reporting_gross            (magnitude)
 *   fee_minor                += sign * (gross - net)
 *   net_minor                += sign * reporting_net
 *
 * so that the identity a reader will check holds exactly:
 *
 *   net = charge_gross - refund - dispute_withdrawn + dispute_reinstated - fee
 *
 * **A refunded charge is not double-negative.** A charge whose status moved to
 * `refunded`/`partially_refunded` keeps contributing its FULL gross in its own
 * bucket; the refund object carries the negative in its own. Deducting on both
 * sides removes the money twice, and the charge's status is a description of
 * what later happened to it rather than a second money movement. This is the
 * single most tempting thing to get wrong here, so it is pinned by name in the
 * test suite.
 *
 * **A `failed`/`canceled` object contributes nothing and is not counted.** It
 * moved no money. Counting it would make `charge_gross / charge_count` — the
 * average order value every revenue dashboard shows — quietly wrong, and it is
 * the same eligibility rule CP4's matcher already applies when it decides which
 * charge owns a journey.
 *
 * **A `pending` object counts.** An asynchronous payment method sits `pending`
 * for days and the money is genuinely in flight; if it later fails, the fact
 * gains a new version, the bucket is recomputed and the money leaves again.
 * That round trip is exactly what the versioned-fact-plus-generation-swap design
 * exists to make possible, and refusing to count `pending` would trade a correct
 * revision for a permanent understatement.
 *
 * **An unconverted fact contributes ZERO to every money column and to every kind
 * count.** `conversion_source = 'unavailable'` means D2c found no usable rate,
 * and the fact's reporting amounts are zeros that mean "unknown", not "nothing"
 * (CP3's projection says so in as many words). Folding them into a total is the
 * confident-zero failure this milestone is named after. They increment
 * `unconverted_count` instead, and the read layer surfaces their original-
 * currency totals separately, from the facts.
 */

const MS_PER_MINUTE = 60_000
const MS_PER_HOUR = 3_600_000
const MS_PER_DAY = 86_400_000

export const REVENUE_ROLLUP_UNIT_MS: Readonly<Record<RevenueRollupUnit, number>> = {
  '1h': MS_PER_HOUR,
  '1d': MS_PER_DAY,
  // The minute unit reuses every rule above unchanged — the sign convention, the
  // refunded-charge rule, the unconverted rule. That is the point of the unit
  // being a parameter: a second grain must never become a second opinion about
  // what a refund does to a number.
  '1m': MS_PER_MINUTE,
}

/**
 * Statuses that moved no money, on any kind.
 *
 * A closed set rather than an allowlist, and that direction is deliberate: an
 * unknown status the provider invents next quarter is counted rather than
 * dropped. Losing a customer's revenue to a vocabulary change is a worse failure
 * than counting a status we have not learned about yet, and the versioned fact
 * makes the correction a recompute.
 */
const NO_MONEY_STATUSES: ReadonlySet<string> = new Set(['failed', 'canceled', 'cancelled'])

/** What a dispute did to the money, from its provider status. */
export type DisputeMoneyEffect = 'withdrawn' | 'reinstated' | 'none'

/**
 * The dispute lifecycle, mapped onto money.
 *
 * The fact carries the provider's own dispute status, lowercased and otherwise
 * untouched (CP2's normalizer refuses to collapse the vocabulary, because
 * "we are still arguing" and "we lost" are different things on a dispute
 * screen). Money, however, only has three states:
 *
 * - **`won`** — the funds were withdrawn when the dispute opened and have been
 *   reinstated. Both columns move, so a dashboard can show that it happened at
 *   all; their difference is zero, which is the correct net effect.
 * - **`warning_*`** — Stripe's early-fraud-warning family. No funds have moved
 *   and none may ever move. The dispute is still counted (three warnings are
 *   three disputes) with zero money, which is an honest row rather than an
 *   invisible one.
 * - **everything else, including an unknown status** — the funds are held.
 *   Conservative on purpose: understating revenue while a dispute is unresolved
 *   is the safe direction, and it matches what the provider has actually done to
 *   the balance.
 */
export function disputeMoneyEffect(status: string): DisputeMoneyEffect {
  const normalized = status.trim().toLowerCase()
  if (normalized === 'won') return 'reinstated'
  if (normalized.startsWith('warning_')) return 'none'
  return 'withdrawn'
}

const ZERO_MEASURES: RevenueBucketMeasures = Object.freeze({
  chargeGrossMinor: 0,
  refundMinor: 0,
  disputeWithdrawnMinor: 0,
  disputeReinstatedMinor: 0,
  feeMinor: 0,
  netMinor: 0,
  chargeCount: 0,
  refundCount: 0,
  disputeCount: 0,
  unconvertedCount: 0,
})

interface MutableMeasures {
  chargeGrossMinor: number
  refundMinor: number
  disputeWithdrawnMinor: number
  disputeReinstatedMinor: number
  feeMinor: number
  netMinor: number
  chargeCount: number
  refundCount: number
  disputeCount: number
  unconvertedCount: number
}

function zeroMutable(): MutableMeasures {
  return { ...ZERO_MEASURES }
}

/** The fact fields the rollup reads. A structural type, so a test drives it
 * without constructing a whole `CurrentRevenueEvent`. */
export interface RollupFact {
  readonly objectKind: string
  readonly status: string
  readonly occurredAtMs: number
  readonly conversionSource: string
  readonly reportingGrossMinor: number
  readonly reportingNetMinor: number
}

/** Floors an instant to the start of its UTC bucket, in epoch **seconds**. */
export function bucketSecondsOf(occurredAtMs: number, unit: RevenueRollupUnit): number {
  const width = REVENUE_ROLLUP_UNIT_MS[unit]
  return Math.floor(occurredAtMs / width) * (width / 1000)
}

/** A `DateTime('UTC')` literal, `YYYY-MM-DD HH:MM:SS`, from epoch seconds. */
export function bucketLiteral(bucketSeconds: number): string {
  return new Date(bucketSeconds * 1000).toISOString().slice(0, 19).replace('T', ' ')
}

/** A `DateTime64(3, 'UTC')` literal from epoch ms. */
function chInstant(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').replace('Z', '')
}

/** Applies one fact's contribution to a bucket, per the sign rule above. */
export function applyFactToMeasures(target: MutableMeasures, fact: RollupFact): void {
  if (NO_MONEY_STATUSES.has(fact.status.trim().toLowerCase())) return

  // Zeroed reporting amounts that mean "unknown". Counted, never summed.
  if (fact.conversionSource === 'unavailable') {
    target.unconvertedCount += 1
    return
  }

  const gross = fact.reportingGrossMinor
  const net = fact.reportingNetMinor
  const fee = gross - net

  switch (fact.objectKind) {
    case 'charge': {
      target.chargeGrossMinor += gross
      target.feeMinor += fee
      target.netMinor += net
      target.chargeCount += 1
      return
    }
    case 'refund': {
      target.refundMinor += gross
      target.feeMinor -= fee
      target.netMinor -= net
      target.refundCount += 1
      return
    }
    case 'dispute': {
      target.disputeCount += 1
      const effect = disputeMoneyEffect(fact.status)
      if (effect === 'withdrawn') {
        target.disputeWithdrawnMinor += gross
        target.feeMinor -= fee
        target.netMinor -= net
        return
      }
      if (effect === 'reinstated') {
        // Both sides move: the money left and came back. Their difference is the
        // zero net effect, and keeping the two totals visible is what lets a
        // dashboard say a dispute happened at all.
        target.disputeWithdrawnMinor += gross
        target.disputeReinstatedMinor += gross
        return
      }
      return
    }
    default:
      // An object kind this build does not know. Counted nowhere rather than
      // guessed into a money column — the head's `object_kind` is a closed set
      // today, and a future one arrives with its own columns.
      return
  }
}

/**
 * Aggregates current facts into buckets of one unit.
 *
 * The caller is responsible for the input being **bucket-complete**: every fact
 * of every bucket it wants recomputed must be in `facts`. That is why the rollup
 * step widens its fact read to bucket-aligned bounds rather than reusing the
 * attribution horizon's — a floor in the middle of an hour would otherwise
 * rebuild that hour from the fraction of it the horizon happened to cover.
 */
export function aggregateRevenueBuckets(
  facts: readonly RollupFact[],
  unit: RevenueRollupUnit,
): Map<number, RevenueBucketAggregate> {
  const buckets = new Map<number, MutableMeasures>()
  for (const fact of facts) {
    const seconds = bucketSecondsOf(fact.occurredAtMs, unit)
    let measures = buckets.get(seconds)
    if (measures === undefined) {
      measures = zeroMutable()
      buckets.set(seconds, measures)
    }
    applyFactToMeasures(measures, fact)
  }

  const result = new Map<number, RevenueBucketAggregate>()
  for (const [seconds, measures] of buckets) {
    result.set(seconds, {
      bucketSeconds: seconds,
      bucketStart: bucketLiteral(seconds),
      ...measures,
    })
  }
  return result
}

function measuresEqual(a: RevenueBucketMeasures, b: RevenueBucketMeasures): boolean {
  return (
    a.chargeGrossMinor === b.chargeGrossMinor &&
    a.refundMinor === b.refundMinor &&
    a.disputeWithdrawnMinor === b.disputeWithdrawnMinor &&
    a.disputeReinstatedMinor === b.disputeReinstatedMinor &&
    a.feeMinor === b.feeMinor &&
    a.netMinor === b.netMinor &&
    a.chargeCount === b.chargeCount &&
    a.refundCount === b.refundCount &&
    a.disputeCount === b.disputeCount &&
    a.unconvertedCount === b.unconvertedCount
  )
}

function isEmpty(measures: RevenueBucketMeasures): boolean {
  return measuresEqual(measures, ZERO_MEASURES)
}

function zeroAggregate(bucketSeconds: number): RevenueBucketAggregate {
  return { bucketSeconds, bucketStart: bucketLiteral(bucketSeconds), ...ZERO_MEASURES }
}

export interface RevenueRollupSwapPlanInput {
  readonly siteId: string
  readonly recomputed: ReadonlyMap<number, RevenueBucketAggregate>
  readonly stored: readonly StoredRevenueRollupBucket[]
  /** Every bucket this run is responsible for, as epoch seconds. */
  readonly affectedBucketSeconds: readonly number[]
  /**
   * This run's swap generation, minted by the lease claim.
   *
   * Taken from the caller rather than computed as `max(stored) + 1` — 0014's
   * rule, which is collision-free only while exactly one writer is awake. This
   * job's five-minute lease is never renewed, so a pass that outlives it runs
   * beside the worker that took it, and both would read the same stored maximum
   * and mint the same number. A tie is the one thing ReplacingMergeTree cannot
   * resolve, and per-column `argMax` can then return a bucket assembled from
   * both. Migration 0037 carries the counter and the argument.
   */
  readonly generation: number
  readonly computedAtMs: number
}

export interface RevenueRollupSwapPlan {
  readonly rows: readonly RevenueRollupRow[]
  readonly generation: number
  readonly changed: number
}

/**
 * The swap plan: 0014's idiom, applied to money.
 *
 * One generation for the whole run, taken from the per-site counter the lease
 * claim bumped, so a run is one monotonic step and two runs can never interleave
 * into a state where a later recompute of one bucket loses to an earlier
 * recompute of its neighbour — nor, under a stolen lease, tie with it.
 *
 * Two skip conditions, and both are the point of the exercise:
 *
 * - a bucket that was never stored and recomputes to nothing writes nothing (an
 *   empty hour must not become a row per hour forever);
 * - a bucket whose recompute equals what is stored writes nothing, so
 *   **re-running an unchanged range is a genuine no-op** rather than a new
 *   generation of identical rows. That is the property the attribution job's
 *   15-minute staleness sweep depends on: it re-reads a rolling month on every
 *   pass, and without this comparison every site would grow a generation per
 *   bucket every quarter hour.
 */
export function planRevenueRollupSwap(input: RevenueRollupSwapPlanInput): RevenueRollupSwapPlan {
  const storedBySeconds = new Map<number, StoredRevenueRollupBucket>()
  for (const bucket of input.stored) storedBySeconds.set(bucket.bucketSeconds, bucket)
  const generation = input.generation

  const rows: RevenueRollupRow[] = []
  let changed = 0

  // Sorted so the emitted rows — and therefore the insert's content-derived
  // deduplication token — do not depend on Map iteration order.
  for (const bucketSeconds of [...new Set(input.affectedBucketSeconds)].sort((a, b) => a - b)) {
    const recomputed = input.recomputed.get(bucketSeconds) ?? zeroAggregate(bucketSeconds)
    const stored = storedBySeconds.get(bucketSeconds)

    if (stored === undefined && isEmpty(recomputed)) continue
    if (stored !== undefined && measuresEqual(stored, recomputed)) continue

    rows.push({
      site_id: input.siteId,
      bucket_start: recomputed.bucketStart,
      generation,
      charge_gross_minor: recomputed.chargeGrossMinor,
      refund_minor: recomputed.refundMinor,
      dispute_withdrawn_minor: recomputed.disputeWithdrawnMinor,
      dispute_reinstated_minor: recomputed.disputeReinstatedMinor,
      fee_minor: recomputed.feeMinor,
      net_minor: recomputed.netMinor,
      charge_count: recomputed.chargeCount,
      refund_count: recomputed.refundCount,
      dispute_count: recomputed.disputeCount,
      unconverted_count: recomputed.unconvertedCount,
      computed_at: chInstant(input.computedAtMs),
    })
    changed += 1
  }

  return { rows, generation, changed }
}

/**
 * The buckets one run is responsible for: every bucket that holds a fact, plus
 * every bucket that already has a stored row in the range.
 *
 * The second half is not redundant. Facts never disappear, but a charge can
 * become `failed` under a new version and stop contributing, which empties a
 * bucket that still has a row. Without the stored side that bucket would keep
 * its old total forever, because nothing in `facts` would name it.
 */
export function affectedBucketSecondsOf(input: {
  readonly facts: readonly RollupFact[]
  readonly stored: readonly StoredRevenueRollupBucket[]
  readonly unit: RevenueRollupUnit
}): number[] {
  const seconds = new Set<number>()
  for (const fact of input.facts) seconds.add(bucketSecondsOf(fact.occurredAtMs, input.unit))
  for (const bucket of input.stored) seconds.add(bucket.bucketSeconds)
  return [...seconds].sort((a, b) => a - b)
}

/** Narrowing helper so the loop can pass `CurrentRevenueEvent`s straight in. */
export function toRollupFact(fact: CurrentRevenueEvent): RollupFact {
  return {
    objectKind: fact.objectKind,
    status: fact.status,
    occurredAtMs: fact.occurredAtMs,
    conversionSource: fact.conversionSource,
    reportingGrossMinor: fact.reportingGrossMinor,
    reportingNetMinor: fact.reportingNetMinor,
  }
}
