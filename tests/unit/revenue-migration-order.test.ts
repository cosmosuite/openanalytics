import { readFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Plan 04 Milestone 12, acceptance criterion 4: **the revenue rollup does not
 * exist before the normalized fact** (ADR-0033, D5/D7/D10; docs snapshot 05,
 * D-212).
 *
 * The proof the ADR names is the migration ledger itself — the runner applies
 * ClickHouse migrations in version order and refuses to skip, so a database that
 * holds `revenue_1h` necessarily holds `revenue_events` already. That is only
 * true while the *numbers* stay in the right relation, and nothing else in the
 * repository enforces that relation. This suite does.
 *
 * It is written in CP3, when there is no rollup migration at all, and therefore
 * **passes trivially today**. That is the point: it exists so that the CP5
 * checkpoint which adds `revenue_1h`/`revenue_1d` cannot land them under a lower
 * number than the fact. A test written at the same time as the thing it guards
 * has already lost the chance to catch the mistake.
 *
 * Deliberately reads the files rather than a constant. A pair of hard-coded
 * version numbers would assert that somebody typed two numbers consistently; the
 * question worth asking is what the migration directory actually contains, since
 * that is what the runner will apply.
 *
 * Deliberately does **not** need a ClickHouse: this is a statement about
 * filenames and file contents, so it belongs in the always-run unit project
 * rather than in the CH-gated migration project that skips without
 * `TEST_CLICKHOUSE_URL`.
 */

const MIGRATIONS_DIR = fileURLToPath(
  new URL('../../packages/clickhouse/migrations/', import.meta.url),
)

const FILENAME = /^(\d{4})_([a-z0-9_]+)\.sql$/

/**
 * `CREATE TABLE [IF NOT EXISTS] [<database>.]<name>`, over a comment-stripped
 * body.
 *
 * The optional database qualifier matters. This directory's convention is
 * unqualified names — the runner applies statements with the configured database
 * as the session default, which is what lets the same files build production's
 * `analytics` and a throwaway one in CI — but nothing *enforces* it, and a
 * migration writing `CREATE TABLE analytics.revenue_1h` would otherwise slip
 * past this guard entirely and land a rollup under any version it liked. The
 * qualifier is consumed and discarded, so the captured name is comparable either
 * way.
 */
const CREATE_TABLE =
  /^\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:[a-z0-9_]+\.)?([a-z0-9_]+)/gim

/**
 * A revenue rollup, by name: `revenue_1h`, `revenue_1d`, and anything a future
 * checkpoint might call `revenue_net_1d`.
 *
 * A pattern rather than the two literal names, so a rollup landing under a name
 * nobody anticipated is still caught. `revenue_events` and
 * `revenue_attributions` do not match it, which is correct — they are facts, not
 * rollups.
 *
 * Note that it is **not** the ADR's literal wording. D10 describes the family as
 * `revenue_.*(_1h|_1d)`, and that expression does not match `revenue_1h` at all:
 * after `revenue_` there is no further `_` before `1h`, so the guard written
 * from the ADR verbatim would have silently ignored the exact two tables it
 * exists to catch. The optional middle segment fixes it, and the test below
 * pins the behaviour so nobody "corrects" it back.
 */
const REVENUE_ROLLUP = /^revenue_(?:.*_)?1[hdm]$/

const FACT_TABLE = 'revenue_events'

interface Migration {
  readonly version: number
  readonly filename: string
  readonly tables: readonly string[]
}

/** Comments are stripped before the table scan: this file's own header talks
 * about `revenue_1h` at length, and a scanner that read comments would find a
 * rollup in a migration that creates none. */
function stripComments(sql: string): string {
  return sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
}

async function loadMigrations(): Promise<Migration[]> {
  const entries = await readdir(MIGRATIONS_DIR)
  const migrations: Migration[] = []
  for (const entry of entries.sort()) {
    const match = FILENAME.exec(entry)
    if (!match) continue
    const sql = stripComments(await readFile(`${MIGRATIONS_DIR}${entry}`, 'utf8'))
    const tables = [...sql.matchAll(CREATE_TABLE)].map((found) => (found[1] ?? '').toLowerCase())
    migrations.push({ version: Number(match[1]), filename: entry, tables })
  }
  return migrations
}

describe('revenue migration order (plan 04 M12, acceptance criterion 4)', () => {
  it('creates the revenue fact in exactly one migration', async () => {
    const migrations = await loadMigrations()
    const creating = migrations.filter((migration) => migration.tables.includes(FACT_TABLE))

    // Two migrations creating the same table would make "which version is the
    // fact?" ambiguous, and the ordering assertion below meaningless.
    expect(
      creating.map((migration) => migration.filename),
      'exactly one ClickHouse migration may create `revenue_events`',
    ).toHaveLength(1)
  })

  it('finds a schema-qualified CREATE TABLE too', async () => {
    // The guard is only worth anything if it cannot be sidestepped by writing
    // `CREATE TABLE analytics.revenue_1h`. Asserted against the pattern directly
    // rather than against a fixture migration, because adding one would mean
    // committing a migration whose only purpose is to be found.
    const qualified = 'CREATE TABLE IF NOT EXISTS analytics.revenue_1h\n(\n  site_id UUID\n)'
    const found = [...qualified.matchAll(CREATE_TABLE)].map((match) => match[1])
    expect(found).toEqual(['revenue_1h'])
    expect(REVENUE_ROLLUP.test(found[0] as string)).toBe(true)
  })

  it('recognises the rollup names CP5 will actually use', () => {
    // Written out because the ADR's own `revenue_.*(_1h|_1d)` wording does NOT
    // match `revenue_1h` — see the pattern's comment. Without these four lines
    // the whole guard would pass forever while catching nothing.
    // `revenue_1m` (0022) is in the pattern for the same reason the other two
    // are: it is a rollup of the same facts, written by the same generation
    // swap, and a future edit that made it a materialized view or landed it
    // before 0016 would be the same defect this guard exists to catch.
    for (const table of ['revenue_1h', 'revenue_1d', 'revenue_1m', 'revenue_net_1d']) {
      expect(REVENUE_ROLLUP.test(table), table).toBe(true)
    }
    for (const table of ['revenue_events', 'revenue_attributions', 'metrics_1h']) {
      expect(REVENUE_ROLLUP.test(table), table).toBe(false)
    }
  })

  it('places every revenue rollup strictly after the fact', async () => {
    const migrations = await loadMigrations()

    const fact = migrations.find((migration) => migration.tables.includes(FACT_TABLE))
    expect(fact, '`revenue_events` must exist in the ClickHouse migrations').toBeDefined()
    const factVersion = (fact as Migration).version

    const rollups = migrations.flatMap((migration) =>
      migration.tables
        .filter((table) => REVENUE_ROLLUP.test(table))
        .map((table) => ({ table, version: migration.version, filename: migration.filename })),
    )

    // Empty in CP3 — the rollups arrive in 0018 (CP5) — so this loop asserts
    // nothing today and everything the moment they land. That is the guard.
    for (const rollup of rollups) {
      expect(
        rollup.version,
        `${rollup.table} (${rollup.filename}) must be created strictly after ` +
          `${FACT_TABLE} (${String(factVersion).padStart(4, '0')}) — D-212 orders the ` +
          `normalized fact before any rollup, and the migration ledger is the proof`,
      ).toBeGreaterThan(factVersion)
    }
  })

  it('creates no revenue rollup as a materialized view', async () => {
    // D-211/D7: revenue is refundable and versioned, so an insert-only view is
    // structurally wrong for it. Asserted here rather than left to review,
    // because the failure mode of getting it wrong is a dashboard that quietly
    // cannot un-count a refund.
    const entries = await readdir(MIGRATIONS_DIR)
    for (const entry of entries) {
      if (!FILENAME.test(entry)) continue
      const sql = stripComments(await readFile(`${MIGRATIONS_DIR}${entry}`, 'utf8'))
      const views = [
        ...sql.matchAll(
          /CREATE\s+MATERIALIZED\s+VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:[a-z0-9_]+\.)?(\S+)/gi,
        ),
      ]
      for (const view of views) {
        expect(
          /revenue/i.test(view[1] ?? ''),
          `${entry} creates a materialized view named ${String(view[1])} — revenue facts ` +
            `and rollups are never MV targets (D-211, ADR-0033 D7)`,
        ).toBe(false)
      }
      if (/revenue/i.test(entry)) {
        expect(views, `${entry} must contain no CREATE MATERIALIZED VIEW at all`).toHaveLength(0)
      }
    }
  })
})
