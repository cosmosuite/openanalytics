import { externalUserIdHash, type IdentityKey } from '@openanalytics/domain'
import { NOOP_METRICS, createRecordingMetrics } from '@openanalytics/observability'
import type * as PostgresModule from '@openanalytics/postgres'
import type { Database, RevenueMatchHintRow } from '@openanalytics/postgres'
import { createCapturedLogger } from '@openanalytics/testkit'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The attribution job's loop behaviour (ADR-0033, D6). Milestone 12 CP4.
 *
 * The matching decision has its own pure suite; what is asserted here is
 * everything the *loop* promises, and each of the four is a lesson an earlier
 * checkpoint paid for:
 *
 * 1. **Per-site failure isolation** (the CP3 lesson). Discovery is
 *    `ORDER BY site_id LIMIT n`, so an uncaught throw on one site would starve
 *    every site sorting after it — permanently, silently, and only for the
 *    customers unlucky enough to have a later uuid.
 * 2. **Watermark monotonicity.** A failed run releases without advancing, and a
 *    successful one never moves the watermark backwards.
 * 3. **The horizon rule**, all three terms: the rolling `window + lateness`
 *    re-read that makes a late conversion event flip an answer, the epoch floor
 *    that makes a fresh site cover its backfill, and the changed-head escape
 *    hatch for a backfill that lands after the watermark moved.
 * 4. **Stop between sites** (the CP2 lesson), which is safe precisely because
 *    each site's watermark is durable before the next is claimed.
 *
 * Postgres is mocked at the module boundary rather than stood up: what these
 * assert is the sequence of control-state calls and the arguments the horizon
 * produced, and the SQL those repositories wrap has its own embedded-PG suite.
 */

const claimMock = vi.fn()
const advanceMock = vi.fn()
const releaseMock = vi.fn()
const listSitesMock = vi.fn()
const oldestChangedMock = vi.fn()
const oldestWatermarkMock = vi.fn()
const hintsMock = vi.fn()
/** CP5's conditional advance of the full-site rollup re-roll cursor. */
const advanceRecomputeMock = vi.fn()
const markRecomputeMock = vi.fn()
const projectedMock = vi.fn()
const oldestChangedObjectMock = vi.fn()
/** The site's own `attributed_revenue` switch (ADR-0064 D4a). */
const ingestSettingsMock = vi.fn()

vi.mock('@openanalytics/postgres', async (importOriginal) => {
  const actual = await importOriginal<typeof PostgresModule>()
  return {
    ...actual,
    claimRevenueAttributionSite: (...args: unknown[]) => claimMock(...args),
    advanceRevenueAttributionWatermark: (...args: unknown[]) => advanceMock(...args),
    releaseRevenueAttributionSite: (...args: unknown[]) => releaseMock(...args),
    listSitesForRevenueAttribution: (...args: unknown[]) => listSitesMock(...args),
    readOldestChangedRevenueChargeOccurrence: (...args: unknown[]) => oldestChangedMock(...args),
    readOldestRevenueAttributionWatermark: (...args: unknown[]) => oldestWatermarkMock(...args),
    readRevenueMatchHintsByOrder: (...args: unknown[]) => hintsMock(...args),
    advanceRevenueRollupRecompute: (...args: unknown[]) => advanceRecomputeMock(...args),
    markRevenueRollupRecompute: (...args: unknown[]) => markRecomputeMock(...args),
    isSiteFullyProjected: (...args: unknown[]) => projectedMock(...args),
    readSiteIngestSettings: (...args: unknown[]) => ingestSettingsMock(...args),
    readOldestChangedRevenueObjectOccurrence: (...args: unknown[]) =>
      oldestChangedObjectMock(...args),
  }
})

const { attributeRevenueOnce } = await import('../../apps/worker/src/revenue/attribute.ts')

const DAY = 86_400_000
const LATENESS_MS = 24 * 60 * 60_000
const NOW = Date.parse('2026-07-31T09:00:00.000Z')
const CHARGE_AT = Date.parse('2026-07-30T12:00:00.000Z')

const SITE_A = '11111111-1111-4111-8111-111111111111'
const SITE_B = '22222222-2222-4222-8222-222222222222'

const KEY: IdentityKey = { keyVersion: 1, secret: 'test-identity-secret-000000000000' }

interface Recorded {
  readonly factReads: { siteId: string; fromMs: number; toMs: number }[]
  readonly touchpointReads: { siteId: string; fromMs: number; toMs: number }[]
  readonly inserted: { siteId: string; objectId: string; version: number }[]
  /** CP5: the rollup step's own reads and swaps, on the shared claim. */
  readonly rollupReads: { siteId: string; unit: string; loMs: number; hiMs: number }[]
  readonly rollupWrites: { unit: string; rows: number }[]
  readonly rollupGenerations: number[]
  /** Signal-1 reads, so "no attribution work happened" is checkable. */
  conversionReads: number
}

interface FakeCharge {
  objectId: string
  orderId: string
  occurredAtMs?: number
  externalUserHash?: string
}

interface FakeConversion {
  eventId: string
  orderId: string
  occurredAtMs: number
  userId: string
  anonymousId: string
}

function fakes(
  options: {
    charges?: Record<string, FakeCharge[]>
    conversions?: FakeConversion[]
    failInsertFor?: string
    /** Non-charge object kinds in the window, for the CP7 defect-2 case. */
    extraFacts?: Record<string, ('refund' | 'dispute')[]>
    /** Session facts the touchpoint read answers with, for the hash-join signals. */
    sessions?: { sessionId: string; sessionStartMs: number; userId: string }[]
  } = {},
) {
  const recorded: Recorded = {
    factReads: [],
    touchpointReads: [],
    inserted: [],
    rollupReads: [],
    rollupWrites: [],
    rollupGenerations: [],
    conversionReads: 0,
  }

  const facts = {
    async readCurrentRows(input: { siteId: string; fromMs: number; toMs: number }) {
      recorded.factReads.push(input)
      const rows = options.charges?.[input.siteId] ?? [{ objectId: 'ch_1', orderId: 'pi_1' }]
      const extra = (options.extraFacts?.[input.siteId] ?? []).map((kind, index) => ({
        objectId: `${kind}_${index}`,
        provider: 'stripe',
        objectKind: kind as string,
        version: 1,
        occurredAtMs: CHARGE_AT,
        status: 'succeeded',
        livemode: 1,
        currency: 'usd',
        grossMinor: 400,
        feeMinor: 0,
        netMinor: 400,
        reportingCurrency: 'usd',
        reportingGrossMinor: 400,
        reportingNetMinor: 400,
        conversionSource: 'none',
        parentObjectId: 'ch_1',
        orderId: 'pi_1',
        checkoutSessionId: '',
        customerHash: '',
        externalUserHash: '',
      }))
      return extra.concat(
        rows.map((row) => ({
          objectId: row.objectId,
          provider: 'stripe',
          objectKind: 'charge',
          version: 1,
          occurredAtMs: row.occurredAtMs ?? CHARGE_AT,
          status: 'succeeded',
          livemode: 1,
          currency: 'usd',
          grossMinor: 1000,
          feeMinor: 0,
          netMinor: 1000,
          reportingCurrency: 'usd',
          reportingGrossMinor: 1000,
          reportingNetMinor: 1000,
          conversionSource: 'none',
          parentObjectId: '',
          orderId: row.orderId,
          checkoutSessionId: '',
          customerHash: '',
          externalUserHash: row.externalUserHash ?? '',
        })),
      )
    },
    insertRows: async () => ({ token: null }),
    readCurrentRowsCount: 0,
    ping: async () => true,
    close: async () => {},
  }

  const store = {
    async insertRows(rows: { site_id: string; object_id: string; version: number }[]) {
      if (options.failInsertFor && rows.some((row) => row.site_id === options.failInsertFor)) {
        throw new Error('clickhouse unreachable')
      }
      for (const row of rows) {
        recorded.inserted.push({
          siteId: row.site_id,
          objectId: row.object_id,
          version: row.version,
        })
      }
      return { token: 'tok' }
    },
    readStoredAttributions: async () => [],
    readConversionSignals: async () => {
      recorded.conversionReads += 1
      return options.conversions ?? []
    },
    async readSessionTouchpoints(input: { siteId: string; fromMs: number; toMs: number }) {
      recorded.touchpointReads.push({
        siteId: input.siteId,
        fromMs: input.fromMs,
        toMs: input.toMs,
      })
      return (options.sessions ?? []).map((session) => ({
        sessionId: session.sessionId,
        sessionStartMs: session.sessionStartMs,
        userId: session.userId,
        anonymousId: '',
        referrerDomain: 'google.com',
        utmSource: '',
        utmMedium: '',
        utmCampaign: '',
        utmContent: '',
        utmTerm: '',
        entryPagePath: '/pricing',
      }))
    },
    ping: async () => true,
    close: async () => {},
  }

  /**
   * The CP5 rollup targets, on the same claim as the attribution.
   *
   * Present in every case here rather than only in the rollup ones, because the
   * step runs on **every** path that reaches a decided state — including the "no
   * charges to attribute" one, which is exactly the path a site whose only
   * activity this month is a refund takes.
   */
  const rollups = {
    async readStoredRollups(input: { siteId: string; unit: string; loMs: number; hiMs: number }) {
      recorded.rollupReads.push(input)
      return []
    },
    async insertRollups(input: { unit: string; rows: readonly { generation: number }[] }) {
      recorded.rollupWrites.push({ unit: input.unit, rows: input.rows.length })
      for (const row of input.rows) recorded.rollupGenerations.push(row.generation)
    },
    ping: async () => true,
    close: async () => {},
  }

  return { recorded, facts, store, rollups }
}

function deps(overrides: Record<string, unknown> = {}) {
  const { facts, store, rollups, recorded } =
    (overrides['_fakes'] as ReturnType<typeof fakes>) ?? fakes()
  const logger = createCapturedLogger()
  return {
    recorded,
    logger,
    deps: {
      db: {} as Database,
      logger: logger.logger,
      metrics: NOOP_METRICS,
      store,
      facts,
      rollups,
      identityKey: KEY,
      filterAttributable: async (siteIds: readonly string[]) => [...siteIds],
      claimedBy: 'worker-1',
      latenessMs: LATENESS_MS,
      now: () => new Date(NOW),
      ...overrides,
    },
  }
}

/**
 * The ordinary state of every mocked repository call.
 *
 * A named function rather than only a `beforeEach` body because one case below
 * runs the same site twice with the switch in both positions, and the second run
 * needs the defaults back after `vi.clearAllMocks()`.
 */
function resetDefaultMocks(): void {
  claimMock.mockImplementation(async (_db: unknown, input: { siteId: string }) => ({
    computedThrough: new Date(NOW - 60_000),
    runSeq: 1,
    siteId: input.siteId,
    // CP5: no pending full-site re-roll on the ordinary path.
    rollupRecomputeFrom: null,
    // The claim mints the swap generation, so a stolen lease cannot tie.
    rollupGenerationSeq: 7,
  }))
  advanceMock.mockResolvedValue(undefined)
  advanceRecomputeMock.mockResolvedValue(true)
  markRecomputeMock.mockResolvedValue(undefined)
  // The ordinary path: the projection is quiet and nothing old changed.
  projectedMock.mockResolvedValue(true)
  oldestChangedObjectMock.mockResolvedValue(null)
  releaseMock.mockResolvedValue(undefined)
  listSitesMock.mockResolvedValue([SITE_A])
  oldestChangedMock.mockResolvedValue(null)
  oldestWatermarkMock.mockResolvedValue(new Date(NOW - 60_000))
  hintsMock.mockResolvedValue(new Map<string, RevenueMatchHintRow>())
  // Attribution on, which is the state every case below except the switch's own
  // assumes. The column defaults to `false`, so this is the site that chose it.
  ingestSettingsMock.mockResolvedValue({
    configVersion: 3,
    settings: { attributedRevenue: true },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  resetDefaultMocks()
})

describe('per-site failure isolation (the CP3 lesson)', () => {
  it('keeps sweeping after one site throws, and releases it without advancing', async () => {
    listSitesMock.mockResolvedValue([SITE_A, SITE_B])
    const built = fakes({ failInsertFor: SITE_A })
    // Both sites produce a charge, so both reach the insert; only A's throws.
    const context = deps({ _fakes: built })

    const result = await attributeRevenueOnce(
      context.deps as unknown as Parameters<typeof attributeRevenueOnce>[0],
    )

    expect(result.failed).toBe(1)
    expect(result.attributed).toBe(1)
    // The second site was reached — this is the assertion the whole lesson is
    // about. An escaping throw would have left `sites` unprocessed after A.
    expect(built.recorded.factReads.map((read) => read.siteId)).toEqual([SITE_A, SITE_B])
    // A released without advancing; B advanced.
    expect(releaseMock.mock.calls.map((call) => (call[1] as { siteId: string }).siteId)).toEqual([
      SITE_A,
    ])
    expect(advanceMock.mock.calls.map((call) => (call[1] as { siteId: string }).siteId)).toEqual([
      SITE_B,
    ])
    expect(context.logger.lines.some((line) => line['msg'] === 'revenue_attribution_failed')).toBe(
      true,
    )
  })

  it('skips a site whose lease another worker holds, without touching it', async () => {
    claimMock.mockResolvedValue(null)
    const context = deps()

    const result = await attributeRevenueOnce(
      context.deps as unknown as Parameters<typeof attributeRevenueOnce>[0],
    )

    expect(result.skipped).toBe(1)
    expect(advanceMock).not.toHaveBeenCalled()
    expect(releaseMock).not.toHaveBeenCalled()
  })

  it('releases and skips a site the lifecycle fence refuses after the claim', async () => {
    // The inner half of the fence: this run may have been queued before the site
    // was marked `deleting`. The lease is RELEASED rather than held, so a
    // deletion's own phase does not wait out the full TTL for nothing.
    let calls = 0
    const context = deps({
      filterAttributable: async (siteIds: readonly string[]) => {
        calls += 1
        return calls === 1 ? [...siteIds] : []
      },
    })

    const result = await attributeRevenueOnce(
      context.deps as unknown as Parameters<typeof attributeRevenueOnce>[0],
    )

    expect(result.skipped).toBe(1)
    expect(releaseMock).toHaveBeenCalledTimes(1)
    expect(advanceMock).not.toHaveBeenCalled()
  })
})

describe('the watermark', () => {
  it('advances to the run instant on success', async () => {
    const context = deps()
    await attributeRevenueOnce(
      context.deps as unknown as Parameters<typeof attributeRevenueOnce>[0],
    )

    const advance = advanceMock.mock.calls[0]?.[1] as { computedThrough: Date; claimedBy: string }
    expect(advance.computedThrough.getTime()).toBe(NOW)
    // Only the lease holder may advance.
    expect(advance.claimedBy).toBe('worker-1')
  })

  it('still advances for a site whose charges have all aged out of the horizon', async () => {
    // Otherwise the staleness clause would rediscover this site on every single
    // tick forever, doing no work and never going quiet.
    const built = fakes({ charges: { [SITE_A]: [] } })
    const context = deps({ _fakes: built })

    const result = await attributeRevenueOnce(
      context.deps as unknown as Parameters<typeof attributeRevenueOnce>[0],
    )

    expect(result.attributed).toBe(1)
    expect(result.rows).toBe(0)
    expect(advanceMock).toHaveBeenCalledTimes(1)
  })
})

/**
 * The UTC day `ms` falls in, as an epoch instant.
 *
 * CP5 widened the FACT READ to whole UTC days without changing the horizon: the
 * rollup step needs bucket-complete input (a floor in the middle of an hour
 * would rebuild that hour from the fraction of it the horizon covered), and one
 * read now serves both answers. The attribution horizon itself is unchanged and
 * is re-imposed in memory — safe because `occurred_at` is not a column a version
 * can change, so the filter and a narrower query return the identical set.
 */
function floorDay(ms: number): number {
  return Math.floor(ms / DAY) * DAY
}

function ceilDay(ms: number): number {
  return Math.ceil(ms / DAY) * DAY
}

describe('the horizon rule', () => {
  it('re-reads a rolling window + lateness of charges, not only new ones', async () => {
    // The late-flip guarantee, expressed as an assertion about the read: a
    // charge from three days ago has to still be inside the window a run reads,
    // or a conversion event arriving today could never change its answer.
    const built = fakes()
    const context = deps({ _fakes: built })
    await attributeRevenueOnce(
      context.deps as unknown as Parameters<typeof attributeRevenueOnce>[0],
    )

    const read = built.recorded.factReads[0]!
    expect(read.fromMs).toBe(floorDay(NOW - (30 * DAY + LATENESS_MS)))
    expect(read.toMs).toBe(ceilDay(NOW + 1))
    // The horizon proper is unchanged: the touchpoint read is derived from it
    // and is the observable that did not move.
    expect(read.fromMs).toBeLessThanOrEqual(NOW - (30 * DAY + LATENESS_MS))
    expect(read.toMs).toBeGreaterThanOrEqual(NOW + 1)
  })

  it('rolls up on the same claim, over all three units, from the same read', async () => {
    // The reason the rollup is a step of this job rather than a loop of its own:
    // one ClickHouse round trip serves both the journeys and the buckets.
    const built = fakes()
    const context = deps({ _fakes: built })
    await attributeRevenueOnce(
      context.deps as unknown as Parameters<typeof attributeRevenueOnce>[0],
    )

    expect(built.recorded.factReads).toHaveLength(1)
    expect(built.recorded.rollupReads.map((read) => read.unit)).toEqual(['1h', '1d', '1m'])
    const read = built.recorded.factReads[0]!
    for (const rollupRead of built.recorded.rollupReads) {
      expect(rollupRead.loMs).toBe(read.fromMs)
      expect(rollupRead.hiMs).toBe(read.toMs)
    }
    // One charge, so one bucket moves in each of the three units — the minute
    // bucket included, which is what a sub-hour timezone composes its local hour
    // and day from (migration 0022).
    expect(built.recorded.rollupWrites).toEqual([
      { unit: '1h', rows: 1 },
      { unit: '1d', rows: 1 },
      { unit: '1m', rows: 1 },
    ])
    // Every unit carries the generation the CLAIM minted, not one derived from
    // what is stored — the property that makes a stolen lease harmless, and the
    // reason the minute table can never disagree with the hourly one: they are
    // written in the same swap, from the same plan, under the same generation.
    expect(built.recorded.rollupGenerations).toEqual([7, 7, 7])
  })

  it('rolls up a window whose facts contain NO charge change at all (CP7 defect 2)', async () => {
    // The production shape: the only thing in the window is a refund. The pass
    // must still read, recompute and swap — there is nothing to attribute and a
    // bucket that must absolutely change.
    const built = fakes({ charges: { [SITE_A]: [] }, extraFacts: { [SITE_A]: ['refund'] } })
    const context = deps({ _fakes: built })
    const result = await attributeRevenueOnce(
      context.deps as unknown as Parameters<typeof attributeRevenueOnce>[0],
    )

    expect(result.attributed).toBe(1)
    expect(result.rows).toBe(0)
    // All three units were read and all three written: the refund moved its bucket.
    expect(built.recorded.rollupReads.map((read) => read.unit)).toEqual(['1h', '1d', '1m'])
    expect(built.recorded.rollupWrites).toEqual([
      { unit: '1h', rows: 1 },
      { unit: '1d', rows: 1 },
      { unit: '1m', rows: 1 },
    ])
    expect(advanceMock).toHaveBeenCalledTimes(1)
  })

  it('rolls up a site with no charges at all — a refund still moves a bucket', async () => {
    // The path the "no charges to attribute" early return takes. A site whose
    // only activity this month is a refund has nothing to attribute and a bucket
    // that must absolutely change; skipping the rollup with the attribution
    // would lose exactly the case D2d is about.
    const built = fakes({ charges: { [SITE_A]: [] } })
    const context = deps({ _fakes: built })
    await attributeRevenueOnce(
      context.deps as unknown as Parameters<typeof attributeRevenueOnce>[0],
    )

    expect(built.recorded.rollupReads.map((read) => read.unit)).toEqual(['1h', '1d', '1m'])
    expect(advanceMock).toHaveBeenCalledTimes(1)
  })

  it('reads ONE bounded chunk of a pending re-roll, not the whole history', async () => {
    // S3. The first CP5 draft read every fact a site had ever had, on every
    // tick, until the marker cleared. The chunk walk bounds that to a month per
    // pass — and reads it SEPARATELY, because the chunk is disjoint from the
    // horizon and unioning them would mean reading every year in between.
    const cursor = Date.parse('2023-01-01T00:00:00.000Z')
    claimMock.mockResolvedValue({
      computedThrough: new Date(NOW - 60_000),
      runSeq: 1,
      rollupRecomputeFrom: new Date(cursor),
      rollupGenerationSeq: 7,
    })
    const built = fakes()
    const context = deps({ _fakes: built })
    await attributeRevenueOnce(
      context.deps as unknown as Parameters<typeof attributeRevenueOnce>[0],
    )

    // Two reads: the ordinary horizon, and the chunk.
    expect(built.recorded.factReads).toHaveLength(2)
    const chunkRead = built.recorded.factReads[1]!
    expect(chunkRead.fromMs).toBe(cursor)
    expect(chunkRead.toMs - chunkRead.fromMs).toBe(31 * DAY)
    // The ATTRIBUTION horizon is untouched — a reporting currency changes no
    // journey, and neither does a dispute.
    const horizonRead = built.recorded.factReads[0]!
    expect(horizonRead.fromMs).toBeGreaterThan(cursor)

    // The cursor advances to the end of the chunk rather than clearing.
    expect(advanceRecomputeMock).toHaveBeenCalledTimes(1)
    const advance = advanceRecomputeMock.mock.calls[0]?.[1] as {
      to: Date | null
      onlyIfWasProjected: boolean
    }
    expect(advance.to?.getTime()).toBe(cursor + 31 * DAY)
    expect(advance.onlyIfWasProjected).toBe(true)
  })

  it('clears the cursor when the walk reaches the rolling horizon', async () => {
    const built = fakes()
    const context = deps({ _fakes: built })
    // Already inside the ordinary range: the ordinary rollup covered it.
    claimMock.mockResolvedValue({
      computedThrough: new Date(NOW - 60_000),
      runSeq: 1,
      rollupRecomputeFrom: new Date(NOW),
      rollupGenerationSeq: 7,
    })
    await attributeRevenueOnce(
      context.deps as unknown as Parameters<typeof attributeRevenueOnce>[0],
    )
    // No second read: there is no chunk left below the horizon.
    expect(built.recorded.factReads).toHaveLength(1)
    expect(advanceRecomputeMock.mock.calls[0]?.[1]).toMatchObject({ to: null })
  })

  it('passes the pre-read projection snapshot into the advance (B2)', async () => {
    // The half a `NOT EXISTS` at advance time cannot see: if the projection was
    // behind when this pass READ, the amounts it rolled up may be in the site's
    // previous reporting currency, and the cursor must not move even though the
    // projection has since caught up.
    projectedMock.mockResolvedValue(false)
    claimMock.mockResolvedValue({
      computedThrough: new Date(NOW - 60_000),
      runSeq: 1,
      rollupRecomputeFrom: new Date(NOW),
      rollupGenerationSeq: 7,
    })
    advanceRecomputeMock.mockResolvedValue(false)
    const built = fakes()
    const context = deps({ _fakes: built })
    await attributeRevenueOnce(
      context.deps as unknown as Parameters<typeof attributeRevenueOnce>[0],
    )
    expect(advanceRecomputeMock.mock.calls[0]?.[1]).toMatchObject({ onlyIfWasProjected: false })
    // And the snapshot is taken BEFORE the facts are read, not after.
    expect(projectedMock).toHaveBeenCalled()
  })

  it('leaves the re-roll cursor alone when there is none', async () => {
    const built = fakes()
    const context = deps({ _fakes: built })
    await attributeRevenueOnce(
      context.deps as unknown as Parameters<typeof attributeRevenueOnce>[0],
    )
    expect(advanceRecomputeMock).not.toHaveBeenCalled()
    expect(built.recorded.factReads).toHaveLength(1)
  })

  it('lowers the rollup floor to a late-closed dispute, and not the horizon (B3)', async () => {
    // A dispute opened three weeks ago and closed today. Its bucket is inside
    // one chunk of the horizon, so it is folded into the ordinary read rather
    // than handed to the cursor.
    const opened = NOW - 21 * DAY
    oldestChangedObjectMock.mockResolvedValue(new Date(opened))
    const built = fakes()
    const context = deps({ _fakes: built })
    await attributeRevenueOnce(
      context.deps as unknown as Parameters<typeof attributeRevenueOnce>[0],
    )
    // Already inside the 31-day horizon, so nothing moved — the point is that the
    // widened read is consulted at all, which the next case proves.
    expect(oldestChangedObjectMock).toHaveBeenCalled()
    expect(built.recorded.factReads).toHaveLength(1)
  })

  it('hands a dispute older than a chunk to the cursor rather than reading it inline', async () => {
    // Stripe resolves disputes in sixty to ninety days. One that opened a year
    // ago and closed today would otherwise make this pass read a year of facts.
    const opened = NOW - 400 * DAY
    oldestChangedObjectMock.mockResolvedValue(new Date(opened))
    const built = fakes()
    const context = deps({ _fakes: built })
    await attributeRevenueOnce(
      context.deps as unknown as Parameters<typeof attributeRevenueOnce>[0],
    )

    // The pass itself stays bounded...
    expect(built.recorded.factReads).toHaveLength(1)
    expect(built.recorded.factReads[0]!.fromMs).toBeGreaterThan(opened)
    // ...and the walk owns the old bucket. One mechanism, not two.
    expect(markRecomputeMock).toHaveBeenCalledTimes(1)
    const mark = markRecomputeMock.mock.calls[0]?.[1] as { from: Date }
    expect(mark.from.getTime()).toBeLessThanOrEqual(opened)
  })

  it('reads from the epoch on a site that has never been attributed', async () => {
    // What makes the first pass cover a 90-day backfill even though the rolling
    // window is 31 days.
    claimMock.mockResolvedValue({ computedThrough: new Date(0), runSeq: 0 })
    const built = fakes()
    const context = deps({ _fakes: built })

    await attributeRevenueOnce(
      context.deps as unknown as Parameters<typeof attributeRevenueOnce>[0],
    )

    expect(built.recorded.factReads[0]!.fromMs).toBe(0)
  })

  it('drops the floor to a backfill that landed after the watermark had moved', async () => {
    // The escape hatch. Without it, every charge older than the rolling window
    // in a late-completing backfill would sit unattributed forever, because
    // nothing would ever pull the horizon back to it.
    const backfilled = NOW - 80 * DAY
    oldestChangedMock.mockResolvedValue(new Date(backfilled))
    const built = fakes()
    const context = deps({ _fakes: built })

    await attributeRevenueOnce(
      context.deps as unknown as Parameters<typeof attributeRevenueOnce>[0],
    )

    expect(built.recorded.factReads[0]!.fromMs).toBe(floorDay(backfilled))
  })

  it('does not raise the floor when the changed head is newer than the rolling window', async () => {
    oldestChangedMock.mockResolvedValue(new Date(NOW - 60_000))
    const built = fakes()
    const context = deps({ _fakes: built })

    await attributeRevenueOnce(
      context.deps as unknown as Parameters<typeof attributeRevenueOnce>[0],
    )

    expect(built.recorded.factReads[0]!.fromMs).toBe(floorDay(NOW - (30 * DAY + LATENESS_MS)))
  })

  it('anchors the touchpoint read on matchable charges only, not on the whole horizon', async () => {
    // The session GROUP BY is the expensive read of this job, and it runs 96
    // times a day per site. Anchoring it on every charge in the horizon would
    // scan up to 61 days of one site's sessions forever because of one ancient
    // unmatchable charge; anchoring it on the charges that actually produced a
    // visitor key cannot change a result — an unmatchable charge is `none`
    // whatever the session read returned.
    const ancient = NOW - 25 * DAY
    const built = fakes({
      charges: {
        [SITE_A]: [
          // No conversion event, no hash: contributes no visitor key at all.
          { objectId: 'ch_old_unmatchable', orderId: 'pi_old', occurredAtMs: ancient },
          // Matchable through its own client-reference hash.
          {
            objectId: 'ch_recent',
            orderId: 'pi_recent',
            occurredAtMs: CHARGE_AT,
            externalUserHash: 'user-hash-1',
          },
        ],
      },
    })
    const context = deps({ _fakes: built })

    await attributeRevenueOnce(
      context.deps as unknown as Parameters<typeof attributeRevenueOnce>[0],
    )

    const read = built.recorded.touchpointReads[0]!
    // Anchored on the recent charge, not on the ancient one.
    expect(read.fromMs).toBe(CHARGE_AT - 30 * DAY)
    expect(read.toMs).toBe(CHARGE_AT)
  })

  it('includes a charge made matchable only by a conversion event in that anchor', async () => {
    // The other half: an old charge with no hash of its own IS matchable when a
    // conversion event names it, and its full 30-day window has to be read or the
    // journey would be silently truncated.
    const older = CHARGE_AT - 10 * DAY
    const built = fakes({
      charges: {
        [SITE_A]: [
          { objectId: 'ch_old_signalled', orderId: 'pi_signalled', occurredAtMs: older },
          { objectId: 'ch_recent', orderId: 'pi_recent', occurredAtMs: CHARGE_AT },
        ],
      },
      conversions: [
        {
          eventId: 'ev_1',
          orderId: 'pi_signalled',
          occurredAtMs: older,
          userId: 'user-hash-1',
          anonymousId: 'anon-hash-1',
        },
      ],
    })
    const context = deps({ _fakes: built })

    await attributeRevenueOnce(
      context.deps as unknown as Parameters<typeof attributeRevenueOnce>[0],
    )

    const read = built.recorded.touchpointReads[0]!
    expect(read.fromMs).toBe(older - 30 * DAY)
    // The upper bound is the newest MATCHABLE charge, which here is the signalled
    // one — the unmatched recent charge cannot widen it.
    expect(read.toMs).toBe(older)
  })

  it('does not read sessions at all when no charge produced a visitor key', async () => {
    const built = fakes()
    const context = deps({ _fakes: built })

    await attributeRevenueOnce(
      context.deps as unknown as Parameters<typeof attributeRevenueOnce>[0],
    )

    expect(built.recorded.touchpointReads).toHaveLength(0)
  })

  it('asks discovery for sites whose watermark is older than the refresh interval', async () => {
    // Conversion events and session facts live in ClickHouse and a Postgres
    // discovery query cannot see them at any price, so this staleness clause is
    // the ONLY way either is ever noticed.
    const context = deps({ refreshIntervalMs: 900_000 })
    await attributeRevenueOnce(
      context.deps as unknown as Parameters<typeof attributeRevenueOnce>[0],
    )

    const discovery = listSitesMock.mock.calls[0]?.[1] as { staleBefore: Date; limit: number }
    expect(discovery.staleBefore.getTime()).toBe(NOW - 900_000)
  })
})

describe('shutdown', () => {
  it('cuts between sites rather than mid-site (the CP2 lesson)', async () => {
    listSitesMock.mockResolvedValue([SITE_A, SITE_B])
    const built = fakes()
    let seen = 0
    const context = deps({
      _fakes: built,
      stopped: () => {
        seen += 1
        // Not stopped for the first site, stopped before the second.
        return seen > 1
      },
    })

    const result = await attributeRevenueOnce(
      context.deps as unknown as Parameters<typeof attributeRevenueOnce>[0],
    )

    expect(built.recorded.factReads.map((read) => read.siteId)).toEqual([SITE_A])
    expect(result.skipped).toBe(1)
    // The site that DID run reached a decided state — nothing is lost by
    // cutting here.
    expect(advanceMock).toHaveBeenCalledTimes(1)
  })
})

describe("the site's own switch (ADR-0064 D4a, extended)", () => {
  /**
   * `attributed_revenue` decides whether a site is attributed at all.
   *
   * The tracker and the collector already enforce it on D6's **first** signal,
   * the browser's `order_id`. The other two — a checkout `client_reference_id`
   * and an identity carried on the Stripe object — travel from the site's own
   * server to the provider and reach us on the webhook, so no ingest rule can
   * see them and a site with the switch off used to be attributed through them
   * anyway. Both are set up here, so the assertion is about the signals that
   * actually escaped rather than about the one already closed.
   */
  const HOUR = 3_600_000

  /** What the job derives from a hint's `client_reference_id`, derived the same way. */
  const clientReferenceHash = externalUserIdHash({
    siteId: SITE_A,
    externalUserId: 'cust_42',
    key: KEY,
  }).userId

  const withBothServerSignals = () => {
    hintsMock.mockResolvedValue(
      new Map<string, RevenueMatchHintRow>([
        [
          'pi_2',
          {
            siteId: SITE_A,
            provider: 'stripe',
            orderId: 'pi_2',
            checkoutSessionId: 'cs_2',
            clientReferenceId: 'cust_42',
          } as unknown as RevenueMatchHintRow,
        ],
      ]),
    )
    return fakes({
      charges: {
        [SITE_A]: [
          // Signal 3: the identity the projection put on the charge itself.
          { objectId: 'ch_1', orderId: 'pi_1', externalUserHash: 'hash-visitor-1' },
          // Signal 2: nothing on the fact; the hint above carries the reference.
          { objectId: 'ch_2', orderId: 'pi_2' },
        ],
      },
      sessions: [
        { sessionId: 's_1', sessionStartMs: CHARGE_AT - HOUR, userId: 'hash-visitor-1' },
        { sessionId: 's_2', sessionStartMs: CHARGE_AT - HOUR, userId: clientReferenceHash },
      ],
    })
  }

  it('attributes both server-side signals when the site turned the switch on', async () => {
    // The positive control, and it comes first deliberately: the absence
    // asserted below proves nothing unless this data attributes without it.
    const built = withBothServerSignals()
    const context = deps({ _fakes: built })

    const result = await attributeRevenueOnce(
      context.deps as unknown as Parameters<typeof attributeRevenueOnce>[0],
    )

    expect(result.matchedVia.client_reference).toBe(2)
    expect(built.recorded.inserted.map((row) => row.objectId).sort()).toEqual(['ch_1', 'ch_2'])
  })

  it('writes no attribution at all when the switch is off, with the two signals present', async () => {
    ingestSettingsMock.mockResolvedValue({
      configVersion: 3,
      settings: { attributedRevenue: false },
    })
    const built = withBothServerSignals()
    const metrics = createRecordingMetrics()
    const context = deps({ _fakes: built, metrics })

    const result = await attributeRevenueOnce(
      context.deps as unknown as Parameters<typeof attributeRevenueOnce>[0],
    )

    // Nothing written, and nothing even read: the decision is above the reads,
    // so a site with linking off does not pay for the joins either.
    expect(built.recorded.inserted).toEqual([])
    expect(built.recorded.touchpointReads).toEqual([])
    expect(built.recorded.conversionReads).toBe(0)
    expect(hintsMock).not.toHaveBeenCalled()
    expect(result.matchedVia).toEqual({
      conversion_event: 0,
      client_reference: 0,
      customer_identity: 0,
      none: 0,
    })

    // Never silent: the reason is in the metric and in the log.
    expect(metrics.countOf('worker_revenue_attribution_skipped')).toBe(1)
    expect(
      metrics.recorded.find((entry) => entry.name === 'worker_revenue_attribution_skipped')?.labels,
    ).toMatchObject({ reason: 'attribution_off' })
    expect(
      context.logger.lines.some((line) => line['msg'] === 'revenue_attribution_skipped_flag'),
    ).toBe(true)
  })

  it('leaves the money alone: the same buckets are written either way', async () => {
    // ADR-0064 D4. Revenue totals are measurement and are outside this switch,
    // so the rollup step and the watermark both still run — otherwise turning
    // linking off would quietly freeze a site's revenue chart.
    const on = withBothServerSignals()
    await attributeRevenueOnce(
      deps({ _fakes: on }).deps as unknown as Parameters<typeof attributeRevenueOnce>[0],
    )
    const advancesWithAttribution = advanceMock.mock.calls.length

    vi.clearAllMocks()
    resetDefaultMocks()
    ingestSettingsMock.mockResolvedValue({
      configVersion: 3,
      settings: { attributedRevenue: false },
    })
    const off = withBothServerSignals()
    await attributeRevenueOnce(
      deps({ _fakes: off }).deps as unknown as Parameters<typeof attributeRevenueOnce>[0],
    )

    expect(off.recorded.rollupWrites).toEqual(on.recorded.rollupWrites)
    expect(off.recorded.rollupGenerations).toEqual(on.recorded.rollupGenerations)
    expect(off.recorded.factReads).toEqual(on.recorded.factReads)
    expect(advanceMock.mock.calls.length).toBe(advancesWithAttribution)
  })

  it('does not attribute a site whose settings row cannot be read', async () => {
    // A site that has vanished under the run answers `null`. The conservative
    // direction is the same one the column's default takes: no linking.
    ingestSettingsMock.mockResolvedValue(null)
    const built = withBothServerSignals()
    const context = deps({ _fakes: built })

    await attributeRevenueOnce(
      context.deps as unknown as Parameters<typeof attributeRevenueOnce>[0],
    )

    expect(built.recorded.inserted).toEqual([])
  })
})
