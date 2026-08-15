import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { loadServiceEnv } from '@openanalytics/domain'
import type { Auth } from '@openanalytics/auth'
import type { Database } from '@openanalytics/postgres'
import type * as PostgresModule from '@openanalytics/postgres'
import type { AnalyticsGateway } from '../../apps/api/src/gateway-client.ts'
import { createServiceMetadata } from '@openanalytics/observability'
import { createCapturedLogger, testEnv } from '@openanalytics/testkit'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Server-side authorization on the analytics read surface (plan Milestone 7 item
 * 5; docs snapshot 02 §19). The invariant: no analytics route reaches the gateway
 * without membership AND billing entitlement passing. Proven by driving the real
 * app with the real middleware chain, a scripted session and scripted membership/
 * site-status lookups, and asserting the gateway-backed service is only reached
 * on the authorized path.
 */

const membership = { value: null as { role: string; isBillingOwner: boolean } | null }
const siteBasics = {
  value: null as { siteId: string; slug: string; name: string; status: string } | null,
}
const finalizerState = {
  value: null as {
    siteId: string
    finalizedThrough: Date
    runSeq: number
    lastRunAt: Date | null
  } | null,
}

vi.mock('@openanalytics/postgres', async (importOriginal) => {
  const actual = await importOriginal<typeof PostgresModule>()
  return {
    ...actual,
    getMembership: async () => membership.value,
    getSiteBasics: async () => siteBasics.value,
    getFinalizerState: async () => finalizerState.value,
  }
})

const { createApp } = await import('../../apps/api/src/app.ts')
const { AnalyticsService } = await import('../../apps/api/src/analytics/service.ts')

const SITE = '3f2a1c64-9a1a-4e2f-9c1e-2a0f1d3b5c77'

function sessionAuthStub(hasSession: boolean): Auth {
  return {
    api: {
      getSession: async () =>
        hasSession
          ? {
              user: {
                id: 'user-1',
                email: 'a@b.test',
                emailVerified: true,
                createdAt: new Date('2026-01-01T00:00:00.000Z'),
              },
              session: { createdAt: new Date('2026-07-23T00:00:00.000Z') },
            }
          : null,
    },
    handler: async () => new Response(null),
  } as unknown as Auth
}

let gatewayCalls: string[] = []
let gatewayParams: Record<string, Record<string, unknown>> = {}

function buildApp(hasSession: boolean) {
  gatewayCalls = []
  gatewayParams = {}
  const gateway: AnalyticsGateway = {
    query: <TRow = Record<string, unknown>>(operation: string, params?: unknown) => {
      gatewayCalls.push(operation)
      gatewayParams[operation] = (params ?? {}) as Record<string, unknown>
      let rows: unknown[]
      if (operation === 'analytics.freshness') {
        rows = [{ watermark: '2026-07-23 14:35:00.000', buckets: '5' }]
      } else if (operation.startsWith('analytics.sessions_')) {
        rows = [
          {
            bucket: '2026-07-16 00:00:00',
            sessions: '4',
            engaged_sessions: '3',
            bounced_sessions: '1',
            pageviews: '9',
            total_session_duration_ms: '400000',
            total_active_duration_ms: '120000',
          },
        ]
      } else if (operation.startsWith('analytics.funnel_')) {
        rows = [{ step_1: '100', step_2: '40', step_3: '10' }]
      } else if (operation === 'analytics.recent_visitors') {
        rows = [
          {
            visitor: 'v-newest',
            country: 'AZ',
            device_type: 'desktop',
            browser: 'chrome',
            os: 'windows',
            // The CP3 fold: the identify() hash as a row attribute, never a
            // row identity. The response must not carry it; the revenue join
            // below must use it.
            user_id: 'u-hash-1',
            first_seen: '2026-07-23 13:00:00.000',
            last_seen: '2026-07-23 14:30:00.000',
            pageviews: '4',
          },
        ]
      } else if (operation === 'analytics.visitor_revenue') {
        // One charge attributed under the anonymous id, one under the
        // identify() hash — the ADR-0033 CP4 merge seen from the read side.
        rows = [
          {
            visitor_key: 'v-newest',
            amount_minor: '2599',
            currency: 'USD',
            transaction_count: '1',
          },
          {
            visitor_key: 'u-hash-1',
            amount_minor: '1000',
            currency: 'USD',
            transaction_count: '1',
          },
        ]
      } else if (operation === 'analytics.visitor_revenue_entries') {
        rows = [
          {
            object_id: 'ch_1',
            occurred_at: '2026-07-23 14:25:00.000',
            status: 'succeeded',
            currency: 'usd',
            gross_minor: '2599',
            reporting_currency: 'USD',
            reporting_gross_minor: '2599',
            conversion_source: 'ecb',
            session_id: 's2',
          },
        ]
      } else if (operation === 'analytics.visitor_trail') {
        // Newest first, as the operation orders them: two sessions interleaved
        // in time so the grouping and the per-session re-ordering both show.
        rows = [
          {
            session_id: 's2',
            event_id: 'e4',
            occurred_at: '2026-07-23 14:30:00.000',
            page_path: '/checkout',
            page_title: 'Checkout',
            referrer_domain: '',
          },
          {
            session_id: 's2',
            event_id: 'e3',
            occurred_at: '2026-07-23 14:20:00.000',
            page_path: '/cart',
            page_title: 'Cart',
            referrer_domain: '',
          },
          {
            session_id: 's1',
            event_id: 'e2',
            occurred_at: '2026-07-23 13:10:00.000',
            page_path: '/pricing',
            page_title: 'Pricing',
            referrer_domain: 'google.com',
          },
          {
            session_id: 's1',
            event_id: 'e1',
            occurred_at: '2026-07-23 13:00:00.000',
            page_path: '/',
            page_title: 'Home',
            referrer_domain: 'google.com',
          },
        ]
      } else {
        rows = [{ events: '10', pageviews: '8', visitors: '4', billable_events: '9' }]
      }
      return Promise.resolve({
        operation,
        rows: rows as unknown as readonly TRow[],
        meta: { row_count: rows.length, truncated: false, elapsed_ms: 1, cached: false },
      })
    },
  }
  const { logger } = createCapturedLogger()
  return createApp({
    service: createServiceMetadata({ name: 'api', version: '0.0.0-test', environment: 'test' }),
    logger,
    env: loadServiceEnv('api', testEnv()),
    auth: sessionAuthStub(hasSession),
    db: {} as Database,
    analytics: new AnalyticsService(gateway),
  })
}

const overviewUrl = `http://api.test/v1/sites/${SITE}/analytics/overview?from=2026-07-16T00:00:00.000Z&to=2026-07-23T00:00:00.000Z&timezone=UTC`

describe('analytics read authorization', () => {
  beforeEach(() => {
    membership.value = null
    siteBasics.value = null
    finalizerState.value = null
  })

  it('401 when there is no session, and never touches the gateway', async () => {
    const app = buildApp(false)
    const res = await app.fetch(new Request(overviewUrl))
    expect(res.status).toBe(401)
    expect(gatewayCalls).toHaveLength(0)
  })

  it('404 SITE_NOT_FOUND when the caller is not a member', async () => {
    const app = buildApp(true)
    membership.value = null // not a member
    const res = await app.fetch(new Request(overviewUrl))
    expect(res.status).toBe(404)
    expect(gatewayCalls).toHaveLength(0)
  })

  it('403 SITE_SUSPENDED closes analytics read for a blocked site', async () => {
    const app = buildApp(true)
    membership.value = { role: 'viewer', isBillingOwner: false }
    siteBasics.value = { siteId: SITE, slug: 's', name: 'S', status: 'suspended' }
    const res = await app.fetch(new Request(overviewUrl))
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('SITE_SUSPENDED')
    expect(gatewayCalls).toHaveLength(0)
  })

  it('404 for a deleting site, without revealing it exists', async () => {
    const app = buildApp(true)
    membership.value = { role: 'owner', isBillingOwner: true }
    siteBasics.value = { siteId: SITE, slug: 's', name: 'S', status: 'deleting' }
    const res = await app.fetch(new Request(overviewUrl))
    expect(res.status).toBe(404)
    expect(gatewayCalls).toHaveLength(0)
  })

  it('200 for an active-site viewer — viewer suffices for analytics read', async () => {
    const app = buildApp(true)
    membership.value = { role: 'viewer', isBillingOwner: false }
    siteBasics.value = { siteId: SITE, slug: 's', name: 'S', status: 'active' }
    const res = await app.fetch(new Request(overviewUrl))
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      totals: { events: number }
      meta: { data_sources: string[]; accuracy: string }
    }
    expect(body.totals.events).toBe(10)
    expect(gatewayCalls).toContain('analytics.overview_hour')
    // The D5 block is required on every analytics response, and a site with no
    // published import reports exactly what it reported before imports existed.
    expect(body.meta.data_sources).toEqual(['live'])
    expect(body.meta.accuracy).toBe('exact')
  })

  it('serves session metrics with layering metadata for an authorized viewer', async () => {
    const app = buildApp(true)
    membership.value = { role: 'viewer', isBillingOwner: false }
    siteBasics.value = { siteId: SITE, slug: 's', name: 'S', status: 'active' }
    finalizerState.value = {
      siteId: SITE,
      finalizedThrough: new Date('2026-07-20T00:00:00.000Z'),
      runSeq: 3,
      lastRunAt: null,
    }
    const res = await app.fetch(
      new Request(
        `http://api.test/v1/sites/${SITE}/analytics/sessions?from=2026-07-16T00:00:00.000Z&to=2026-07-23T00:00:00.000Z&timezone=UTC`,
      ),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      totals: { sessions: number; bounce_rate: number }
      layering: { finalized_through: string | null }
    }
    expect(body.totals.sessions).toBeGreaterThan(0)
    expect(body.layering.finalized_through).toBe('2026-07-20T00:00:00.000Z')
    expect(gatewayCalls.some((op) => op.startsWith('analytics.sessions_'))).toBe(true)
  })

  it('serves a funnel and refuses one missing its steps', async () => {
    const app = buildApp(true)
    membership.value = { role: 'viewer', isBillingOwner: false }
    siteBasics.value = { siteId: SITE, slug: 's', name: 'S', status: 'active' }

    const ok = await app.fetch(
      new Request(
        `http://api.test/v1/sites/${SITE}/analytics/funnel?from=2026-07-16T00:00:00.000Z&to=2026-07-23T00:00:00.000Z&timezone=UTC&steps=/pricing&steps=signup&window_ms=1800000`,
      ),
    )
    expect(ok.status).toBe(200)
    const body = (await ok.json()) as { steps: { count: number }[] }
    expect(body.steps).toHaveLength(2)
    expect(body.steps[0]!.count).toBe(100)

    const bad = await app.fetch(
      new Request(
        `http://api.test/v1/sites/${SITE}/analytics/funnel?from=2026-07-16T00:00:00.000Z&to=2026-07-23T00:00:00.000Z&timezone=UTC&steps=/only&window_ms=1800000`,
      ),
    )
    expect(bad.status).toBe(400)
  })

  describe('recent visitors (ADR-0024)', () => {
    const authorized = () => {
      const app = buildApp(true)
      membership.value = { role: 'viewer', isBillingOwner: false }
      siteBasics.value = { siteId: SITE, slug: 's', name: 'S', status: 'active' }
      return app
    }
    const recentUrl = (query = '') =>
      `http://api.test/v1/sites/${SITE}/analytics/recent-visitors?timezone=UTC${query}`
    const visitorUrl = (query = '') =>
      `http://api.test/v1/sites/${SITE}/analytics/visitor?timezone=UTC${query}`

    it('runs the same membership and billing chain as every other analytics route', async () => {
      const anonymous = buildApp(false)
      expect((await anonymous.fetch(new Request(recentUrl()))).status).toBe(401)
      expect((await anonymous.fetch(new Request(visitorUrl('&hash=v1')))).status).toBe(401)
      expect(gatewayCalls).toHaveLength(0)

      const blocked = buildApp(true)
      membership.value = { role: 'owner', isBillingOwner: true }
      siteBasics.value = { siteId: SITE, slug: 's', name: 'S', status: 'suspended' }
      expect((await blocked.fetch(new Request(recentUrl()))).status).toBe(403)
      expect((await blocked.fetch(new Request(visitorUrl('&hash=v1')))).status).toBe(403)
      expect(gatewayCalls).toHaveLength(0)
    })

    it('lists visitors and marks the answer provisional', async () => {
      const app = authorized()
      const res = await app.fetch(new Request(recentUrl()))

      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        meta: { provisional: boolean; freshness: { state: string } }
        items: { visitor: string; last_seen: string; pageviews: number }[]
      }
      expect(body.meta.provisional).toBe(true)
      expect(body.items[0]).toMatchObject({
        visitor: 'v-newest',
        last_seen: '2026-07-23T14:30:00.000Z',
        pageviews: 4,
      })
      expect(gatewayCalls).toContain('analytics.recent_visitors')
    })

    it('defaults to a two-hour window ending now, not on a whole minute', async () => {
      const app = authorized()
      const before = Date.now()
      await app.fetch(new Request(recentUrl()))
      const after = Date.now()

      const params = gatewayParams['analytics.recent_visitors'] as { from: string; to: string }
      const span = Date.parse(params.to) - Date.parse(params.from)
      expect(span).toBe(2 * 3_600_000)

      // **Inverted deliberately by ADR-0035 D7.** This used to assert the end
      // was floored to a whole minute so a polling panel reused one gateway
      // cache key. The price was that the freshest 0–60 s of traffic sat outside
      // the range by construction, on the one screen that exists to be live —
      // and the floor was buying almost nothing, because a 60 s poll against a
      // 60-second quantum misses its own cache nearly every time. Both
      // operations are `cacheable: false` instead.
      expect(Date.parse(params.to)).toBeGreaterThanOrEqual(before)
      expect(Date.parse(params.to)).toBeLessThanOrEqual(after)
    })

    it('honours an explicit window and refuses one past the cap', async () => {
      const app = authorized()
      await app.fetch(new Request(recentUrl('&hours=24')))
      const params = gatewayParams['analytics.recent_visitors'] as { from: string; to: string }
      expect(Date.parse(params.to) - Date.parse(params.from)).toBe(24 * 3_600_000)

      for (const bad of ['&hours=25', '&hours=0', '&hours=1.5', '&limit=201', '&limit=0']) {
        const res = await app.fetch(new Request(recentUrl(bad)))
        expect(res.status, bad).toBe(400)
      }
    })

    it('splits a trail into sessions, newest session first, pages oldest-first', async () => {
      const app = authorized()
      const res = await app.fetch(new Request(visitorUrl('&hash=v-newest')))

      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        visitor: string
        sessions: { session_id: string; started_at: string; ended_at: string; pages: unknown[] }[]
      }
      expect(body.visitor).toBe('v-newest')
      expect(body.sessions.map((s) => s.session_id)).toEqual(['s2', 's1'])
      expect(body.sessions[0]).toMatchObject({
        started_at: '2026-07-23T14:20:00.000Z',
        ended_at: '2026-07-23T14:30:00.000Z',
      })
      // The gateway returns newest-first so its row cap cuts the oldest activity;
      // within a session the pages read forwards.
      expect(
        (body.sessions[1]!.pages as { page_path: string }[]).map((page) => page.page_path),
      ).toEqual(['/', '/pricing'])
      expect(gatewayParams['analytics.visitor_trail']).toMatchObject({ visitor: 'v-newest' })
    })

    it('reports truncation when the result fills its cap, and not otherwise', async () => {
      const app = authorized()

      // The stub returns one visitor row, so limit=1 is a full page.
      const full = await app.fetch(new Request(recentUrl('&limit=1')))
      expect(((await full.json()) as { meta: { truncated: boolean } }).meta.truncated).toBe(true)

      const partial = await app.fetch(new Request(recentUrl('&limit=50')))
      expect(((await partial.json()) as { meta: { truncated: boolean } }).meta.truncated).toBe(
        false,
      )
    })

    it('refuses a visitor request with no hash, before reaching the gateway', async () => {
      const app = authorized()
      const res = await app.fetch(new Request(visitorUrl()))
      expect(res.status).toBe(400)
      expect(gatewayCalls).not.toContain('analytics.visitor_trail')
    })

    it('attaches the revenue marker for an owner, summed over both identity halves (ADR-0036 CP7)', async () => {
      const app = buildApp(true)
      membership.value = { role: 'owner', isBillingOwner: true }
      siteBasics.value = { siteId: SITE, slug: 's', name: 'S', status: 'active' }

      const list = (await (await app.fetch(new Request(recentUrl()))).json()) as {
        items: Record<string, unknown>[]
      }
      // One charge sat under the anonymous id and one under the identify()
      // hash the row's fold carries; the marker is their sum. The fold itself
      // never reaches the response.
      expect(list.items[0]!['revenue']).toEqual({
        amount_minor: 3599,
        currency: 'USD',
        transaction_count: 2,
      })
      expect(list.items[0]).not.toHaveProperty('user_id')
      expect(gatewayCalls).toContain('analytics.visitor_revenue')

      const trail = (await (
        await app.fetch(new Request(visitorUrl('&hash=v-newest')))
      ).json()) as Record<string, unknown>
      expect(trail['revenue']).toEqual({
        amount_minor: 2599,
        currency: 'USD',
        transaction_count: 1,
      })
      const entries = trail['revenue_events'] as {
        display: { kind: string }
        properties: Record<string, unknown>
      }[]
      expect(entries).toHaveLength(1)
      expect(entries[0]!.display.kind).toBe('revenue_charge')
      // The last-touch session, the stated approximation — never an exact
      // in-session position.
      expect(entries[0]!.properties['session_id']).toBe('s2')
    })

    it('keeps the revenue fields ABSENT — not zero — for a non-owner', async () => {
      const app = buildApp(true)
      // Admin is the strongest non-owner: credentials:manage without
      // revenue:read. Absent means "not yours to see"; a zero would be a false
      // claim about the business.
      membership.value = { role: 'admin', isBillingOwner: false }
      siteBasics.value = { siteId: SITE, slug: 's', name: 'S', status: 'active' }

      const list = (await (await app.fetch(new Request(recentUrl()))).json()) as {
        items: Record<string, unknown>[]
      }
      expect(list.items[0]).not.toHaveProperty('revenue')

      const trail = (await (
        await app.fetch(new Request(visitorUrl('&hash=v-newest')))
      ).json()) as Record<string, unknown>
      expect(trail).not.toHaveProperty('revenue')
      expect(trail).not.toHaveProperty('revenue_events')

      // Not filtered out of the response — never computed at all.
      expect(gatewayCalls).not.toContain('analytics.visitor_revenue')
      expect(gatewayCalls).not.toContain('analytics.visitor_revenue_entries')
    })

    it('is documented, and only under the authenticated site path', async () => {
      const spec = await readFile(
        fileURLToPath(new URL('../../packages/contracts/openapi/openapi.yaml', import.meta.url)),
        'utf8',
      )
      expect(spec).toContain('/v1/sites/{site_id}/analytics/recent-visitors:')
      expect(spec).toContain('/v1/sites/{site_id}/analytics/visitor:')
      expect(spec).toContain('operationId: getAnalyticsRecentVisitors')
      expect(spec).toContain('operationId: getAnalyticsVisitor')
      // Never on the public share surface (ADR-0024): individual visitors are
      // not a thing an anonymous share slug may read.
      expect(spec).not.toMatch(/\/v1\/public\/\{share_slug\}\/(recent-visitors|visitor)/)
    })
  })

  /**
   * The `resolution` override (CP3), end to end through the route.
   *
   * Three outcomes have to stay distinguishable, and each is asserted here:
   * a value the API does not have is `VALIDATION_FAILED` (the caller mistyped),
   * a grain this range/timezone cannot carry is `RESOLUTION_NOT_AVAILABLE` (the
   * caller asked for something real that is not available *here*), and a served
   * request reports the grain it was actually served at in `meta.resolution`.
   */
  describe('forced resolution (CP3)', () => {
    const authorized = () => {
      const app = buildApp(true)
      membership.value = { role: 'viewer', isBillingOwner: false }
      siteBasics.value = { siteId: SITE, slug: 's', name: 'S', status: 'active' }
      return app
    }
    const seriesUrl = (query: string) =>
      `http://api.test/v1/sites/${SITE}/analytics/timeseries?from=2026-04-24T00:00:00.000Z&to=2026-07-23T00:00:00.000Z&${query}`
    const totalsUrl = (query: string) =>
      `http://api.test/v1/sites/${SITE}/analytics/overview?from=2026-04-24T00:00:00.000Z&to=2026-07-23T00:00:00.000Z&${query}`

    it('routes a UTC week request to the day-rollup week operation', async () => {
      const app = authorized()
      const res = await app.fetch(new Request(seriesUrl('timezone=UTC&resolution=week')))

      expect(res.status).toBe(200)
      const body = (await res.json()) as { meta: { resolution: string } }
      expect(body.meta.resolution).toBe('week')
      expect(gatewayCalls).toContain('analytics.timeseries_week_utc')
      // No zone is bound: a UTC week is a whole number of metrics_1d buckets.
      expect(gatewayParams['analytics.timeseries_week_utc']).not.toHaveProperty('timezone')
    })

    it('routes a whole-hour zone week request to the hour-composed week operation', async () => {
      const app = authorized()
      const res = await app.fetch(
        new Request(seriesUrl('timezone=Europe/Istanbul&resolution=week')),
      )

      expect(res.status).toBe(200)
      const body = (await res.json()) as { meta: { resolution: string } }
      expect(body.meta.resolution).toBe('week')
      expect(gatewayParams['analytics.timeseries_week']).toMatchObject({
        timezone: 'Europe/Istanbul',
      })
    })

    it('overrides the span ladder: hour buckets over a quarter, day totals over a week', async () => {
      const app = authorized()
      // Left to itself this range is day grain; forced, it reads the hour rollup.
      const series = await app.fetch(new Request(seriesUrl('timezone=UTC&resolution=hour')))
      expect(series.status).toBe(200)
      expect(((await series.json()) as { meta: { resolution: string } }).meta.resolution).toBe(
        'hour',
      )
      expect(gatewayCalls).toContain('analytics.timeseries_hour')

      // And the mirror image on overview: a short range forced onto the day rollup.
      const totals = await app.fetch(
        new Request(
          `http://api.test/v1/sites/${SITE}/analytics/overview?from=2026-07-16T00:00:00.000Z&to=2026-07-23T00:00:00.000Z&timezone=UTC&resolution=day`,
        ),
      )
      expect(totals.status).toBe(200)
      expect(((await totals.json()) as { meta: { resolution: string } }).meta.resolution).toBe(
        'day',
      )
      expect(gatewayCalls).toContain('analytics.overview_day')
    })

    it('400 VALIDATION_FAILED for a value the API does not have, before any gateway call', async () => {
      const app = authorized()
      for (const query of [
        'timezone=UTC&resolution=fortnight',
        'timezone=UTC&resolution=',
        'timezone=UTC&resolution=DAY',
      ]) {
        const res = await app.fetch(new Request(seriesUrl(query)))
        expect(res.status, query).toBe(400)
        expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
          'VALIDATION_FAILED',
        )
      }
      // Overview has only two source rollups, so minute and week are not values
      // it offers at all — a contract-level 400, not a resolution refusal.
      for (const query of ['timezone=UTC&resolution=minute', 'timezone=UTC&resolution=week']) {
        const res = await app.fetch(new Request(totalsUrl(query)))
        expect(res.status, query).toBe(400)
        expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
          'VALIDATION_FAILED',
        )
      }
      expect(gatewayCalls).toHaveLength(0)
    })

    it('400 RESOLUTION_NOT_AVAILABLE for a real grain this range or zone cannot carry', async () => {
      const app = authorized()
      const refused: [string, string][] = [
        // 90 days of minute buckets is far past the minute rollup's scan cap.
        [seriesUrl('timezone=UTC&resolution=minute'), 'minute over a quarter'],
        // The day rollup buckets on UTC midnight, so a +03:00 zone cannot use it.
        [totalsUrl('timezone=Europe/Istanbul&resolution=day'), 'non-UTC day totals'],
      ]
      for (const [url, label] of refused) {
        const res = await app.fetch(new Request(url))
        expect(res.status, label).toBe(400)
        const body = (await res.json()) as { error: { code: string } }
        expect(body.error.code, label).toBe('RESOLUTION_NOT_AVAILABLE')
      }
      // Resolution is decided before any gateway call, forced or not.
      expect(gatewayCalls).toHaveLength(0)
    })

    it('serves a forced day and week in a sub-hour zone from the raw operations', async () => {
      // These two were refusals until the raw chart existed. They are served now,
      // and the assertion is the *operation*: a 200 from `timeseries_day`/`_week`
      // would be UTC-bucketed numbers wearing +05:45 labels, which is the failure
      // the refusal was protecting against.
      const app = authorized()
      for (const [url, operation] of [
        [seriesUrl('timezone=Asia/Kathmandu&resolution=week'), 'analytics.timeseries_raw_week'],
        [seriesUrl('timezone=Asia/Kathmandu&resolution=day'), 'analytics.timeseries_raw_day'],
      ] as [string, string][]) {
        gatewayCalls.length = 0
        const res = await app.fetch(new Request(url))
        expect(res.status, operation).toBe(200)
        expect(gatewayCalls, operation).toContain(operation)
      }
    })

    it('is documented on both endpoints, with week only on the bucketed one', async () => {
      const spec = await readFile(
        fileURLToPath(new URL('../../packages/contracts/openapi/openapi.yaml', import.meta.url)),
        'utf8',
      )
      expect(spec).toContain('TimeseriesResolution:')
      expect(spec).toContain('OverviewResolution:')
      expect(spec).toContain("$ref: '#/components/parameters/TimeseriesResolution'")
      expect(spec).toContain("$ref: '#/components/parameters/OverviewResolution'")
      // The bucketed endpoint offers the full grain set; totals only have two
      // source rollups and say so in their own enum.
      expect(spec).toContain('enum: [minute, hour, day, week]')
      expect(spec).toContain('enum: [hour, day]')
    })
  })

  it('200 for a sub-hour timezone within the raw cap, answered from raw events', async () => {
    const app = buildApp(true)
    membership.value = { role: 'viewer', isBillingOwner: false }
    siteBasics.value = { siteId: SITE, slug: 's', name: 'S', status: 'active' }
    const res = await app.fetch(
      new Request(
        `http://api.test/v1/sites/${SITE}/analytics/overview?from=2026-07-16T00:00:00.000Z&to=2026-07-23T00:00:00.000Z&timezone=Asia/Kolkata`,
      ),
    )
    expect(res.status).toBe(200)
    // Which operation answered is the contract here, not just the status: a 200
    // produced by `overview_raw` is the local boundary honoured, while a 200
    // produced by `overview_hour` would be a +05:30 range read from UTC-hour
    // buckets — the wrong number this endpoint used to refuse rather than give.
    expect(gatewayCalls).toContain('analytics.overview_raw')
    expect(gatewayCalls).not.toContain('analytics.overview_hour')
  })

  it('400 RESOLUTION_NOT_AVAILABLE for a sub-hour timezone past the raw-scan cap', async () => {
    const app = buildApp(true)
    membership.value = { role: 'viewer', isBillingOwner: false }
    siteBasics.value = { siteId: SITE, slug: 's', name: 'S', status: 'active' }
    const res = await app.fetch(
      new Request(
        // ~180 days: inside the hour cap, past the 92-day raw cap.
        `http://api.test/v1/sites/${SITE}/analytics/overview?from=2026-01-01T00:00:00.000Z&to=2026-07-01T00:00:00.000Z&timezone=Asia/Kolkata`,
      ),
    )
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('RESOLUTION_NOT_AVAILABLE')
    // Resolution is decided before any gateway call.
    expect(gatewayCalls).toHaveLength(0)
  })
})
