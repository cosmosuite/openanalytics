#!/bin/bash
# Renders the least-privilege ClickHouse user set at container start.
#
# WITHOUT THIS FILE A SELF-HOSTED DEPLOYMENT HAS NO CLICKHOUSE USERS AT ALL.
# `.env.example` used to claim the migration runner creates them on first run;
# it does not, and nothing else did either. This is the real path: four users
# and their grants, declared as a `users.d` drop-in that is re-applied on every
# start and never depends on first-boot init.
#
# Generalised from the hosted service's own entrypoint. Two differences, both
# deliberate:
#
#   * the off-host backup wiring is gone. That file hard-requires eight
#     object-storage variables and REFUSES TO START without them, which is
#     right for the hosted service and wrong for a first `docker compose up`.
#     Backups for a self-hosted install are covered in SELF-HOSTING.md.
#   * the network allow-lists are `0.0.0.0/0` rather than one private /24.
#     A compose network assigns addresses the operator did not choose, so an
#     allow-list here would be a guess. The boundary that actually holds is
#     that the ClickHouse container publishes no ports: it is reachable from
#     the compose network and from nowhere else. See SELF-HOSTING.md if you
#     move ClickHouse onto a host others can route to.
#
# A user declared in XML cannot be extended with a SQL GRANT afterwards
# (measured on 26.3.17.56 — the grant is accepted and then simply is not
# there), so every privilege a user needs has to be written IN this file.
set -euo pipefail

: "${CLICKHOUSE_INGEST_PASSWORD:?required}"
: "${CLICKHOUSE_READ_PASSWORD:?required}"
: "${CLICKHOUSE_MIGRATION_PASSWORD:?required}"
: "${CLICKHOUSE_MAINTENANCE_PASSWORD:?required}"

# Which addresses each non-default user may connect from. Override only if you
# have moved ClickHouse somewhere the compose network does not reach.
OA_CLICKHOUSE_ALLOWED_NETWORK="${OA_CLICKHOUSE_ALLOWED_NETWORK:-0.0.0.0/0}"

case "$OA_CLICKHOUSE_ALLOWED_NETWORK" in
  *'&'* | *'<'* | *'>'* | *'"'* | *"'"*)
    echo "oa-entrypoint: OA_CLICKHOUSE_ALLOWED_NETWORK contains a character that cannot be written into XML (one of & < > \" '); refusing to render a config.d file the server would fail to parse" >&2
    exit 1
    ;;
esac

sha() { printf '%s' "$1" | sha256sum | cut -d' ' -f1; }

TARGET=/etc/clickhouse-server/users.d/openanalytics-roles.xml
umask 077

cat >"$TARGET" <<XML
<clickhouse>
  <users>
    <!-- The stock \`default\` user has no password and full access. Confining
         it to loopback keeps the least-privilege split below from being
         decorative, and leaves the container's own health check working. -->
    <default>
      <networks><ip>127.0.0.1</ip><ip>::1</ip></networks>
    </default>

    <!-- Worker only (ingest pipeline, session finalizer, import staging,
         revenue projection).
         INSERT: the exact tables the worker writes directly.
         SELECT: required on events_raw because ClickHouse checks the
         inserting user's SELECT on a materialized view's SOURCE while pushing
         (measured on 26.3.17.56); required on the session tables because the
         finalizer reads stored facts and rollups back; required on
         revenue_events and revenue_attributions because the attribution job
         compares its stored answers before writing.
         The list is enumerated rather than analytics.* so a leaked ingest
         credential cannot read tables it does not write. EVERY MIGRATION THAT
         ADDS A WORKER-WRITTEN TABLE HAS TO ADD A LINE HERE AND RECREATE THE
         CONTAINER: users.d is rendered at start, and \`docker compose restart\`
         re-runs this script with the container's ORIGINAL environment, so a
         new grant never appears. Recreate the container instead of restarting
         it. (No double hyphen may appear inside an XML comment, which is why
         the compose flag is described rather than quoted here: one of those
         took the hosted ClickHouse down for two minutes, because the server
         refuses to merge a users.d file it cannot parse.) -->
    <oa_ingest>
      <password_sha256_hex>$(sha "$CLICKHOUSE_INGEST_PASSWORD")</password_sha256_hex>
      <networks><ip>${OA_CLICKHOUSE_ALLOWED_NETWORK}</ip><ip>127.0.0.1</ip></networks>
      <profile>oa_ingest</profile>
      <quota>default</quota>
      <grants>
        <query>GRANT INSERT ON analytics.events_raw</query>
        <query>GRANT INSERT ON analytics.session_facts_versions</query>
        <query>GRANT INSERT ON analytics.session_rollups_1h</query>
        <query>GRANT INSERT ON analytics.session_rollups_1d</query>
        <query>GRANT SELECT ON analytics.events_raw</query>
        <query>GRANT SELECT ON analytics.session_facts_versions</query>
        <query>GRANT SELECT ON analytics.session_rollups_1h</query>
        <query>GRANT SELECT ON analytics.session_rollups_1d</query>

        <!-- Import staging targets the prepare job writes. -->
        <query>GRANT INSERT ON analytics.imported_metrics_1d</query>
        <query>GRANT INSERT ON analytics.imported_pages_1d</query>
        <query>GRANT INSERT ON analytics.imported_sources_1d</query>
        <query>GRANT INSERT ON analytics.imported_geography_1d</query>
        <query>GRANT INSERT ON analytics.imported_devices_1d</query>
        <query>GRANT INSERT ON analytics.imported_browsers_1d</query>
        <query>GRANT INSERT ON analytics.imported_os_1d</query>
        <query>GRANT INSERT ON analytics.imported_custom_events_1d</query>

        <!-- Revenue facts, attributions and their two rollups. The rollups
             need SELECT as well as INSERT: the rollup step reads the current
             generation of every affected bucket first and writes only what
             actually moved. Without the SELECT that comparison is impossible
             and every pass would rewrite a rolling month of identical rows,
             four times an hour, forever. -->
        <query>GRANT INSERT ON analytics.revenue_events</query>
        <query>GRANT SELECT ON analytics.revenue_events</query>
        <query>GRANT INSERT ON analytics.revenue_attributions</query>
        <query>GRANT SELECT ON analytics.revenue_attributions</query>
        <query>GRANT INSERT ON analytics.revenue_1h</query>
        <query>GRANT SELECT ON analytics.revenue_1h</query>
        <query>GRANT INSERT ON analytics.revenue_1d</query>
        <query>GRANT SELECT ON analytics.revenue_1d</query>
        <!-- Minute grain (migration 0022), the sub-hour timezone's source. The
             rollup pass writes all three units together, so a missing grant here
             does not degrade to "no minute buckets" — it fails the whole revenue
             rollup run, hourly and daily included. -->
        <query>GRANT INSERT ON analytics.revenue_1m</query>
        <query>GRANT SELECT ON analytics.revenue_1m</query>

        <!-- Preview and test-mode events. INSERT only: the worker writes this
             table instead of events_raw whenever an event is test_mode, and
             nothing reads it back on the ingest credential. Without this grant
             a preview session's events fail to insert while ordinary traffic
             keeps flowing, which is the quiet half of the failure. -->
        <query>GRANT INSERT ON analytics.events_preview</query>
      </grants>
    </oa_ingest>

    <!-- Query gateway only. Read-only over everything analytics: the gateway
         is the sole identity that ever serves a dashboard read. -->
    <oa_read>
      <password_sha256_hex>$(sha "$CLICKHOUSE_READ_PASSWORD")</password_sha256_hex>
      <networks><ip>${OA_CLICKHOUSE_ALLOWED_NETWORK}</ip><ip>127.0.0.1</ip></networks>
      <profile>oa_read</profile>
      <quota>default</quota>
      <grants>
        <query>GRANT SELECT ON analytics.*</query>
      </grants>
    </oa_read>

    <!-- Worker only, and only for site and account deletion.
         ALTER DELETE: the per-site purge is \`ALTER TABLE ... DELETE WHERE
         site_id = ...\`, which is a mutation and therefore an ALTER privilege
         rather than a DELETE one.
         SELECT on analytics.*: the purge is not complete until a
         \`SELECT count()\` returns zero for the site; verification is the only
         statement that observes the end state.
         SELECT on system.mutations: a mutation is asynchronous, so its id is
         recorded and polled to completion.
         Deliberately NOT oa_ingest (which must stay insert-only) and NOT
         oa_migration (which can also DROP tables, a privilege no long-running
         service should hold). Without this user, deletion requests queue and
         retry forever instead of erasing anything. An XML comment must not
         contain two consecutive hyphens, which is why these read as prose. -->
    <oa_maintenance>
      <password_sha256_hex>$(sha "$CLICKHOUSE_MAINTENANCE_PASSWORD")</password_sha256_hex>
      <networks><ip>${OA_CLICKHOUSE_ALLOWED_NETWORK}</ip><ip>127.0.0.1</ip></networks>
      <profile>default</profile>
      <quota>default</quota>
      <grants>
        <query>GRANT ALTER DELETE ON analytics.*</query>
        <query>GRANT SELECT ON analytics.*</query>
        <query>GRANT SELECT ON system.mutations</query>
      </grants>
    </oa_maintenance>

    <!-- Migration runner only. DDL lives here and nowhere else. CREATE covers
         CREATE DATABASE, which the runner issues before anything else: the
         analytics database does not exist on a fresh volume. -->
    <oa_migration>
      <password_sha256_hex>$(sha "$CLICKHOUSE_MIGRATION_PASSWORD")</password_sha256_hex>
      <networks><ip>${OA_CLICKHOUSE_ALLOWED_NETWORK}</ip><ip>127.0.0.1</ip></networks>
      <profile>default</profile>
      <quota>default</quota>
      <grants>
        <query>GRANT CREATE, DROP, ALTER, SELECT, INSERT ON analytics.*</query>
        <query>GRANT SELECT ON system.*</query>
      </grants>
    </oa_migration>
  </users>

  <profiles>
    <!-- Synchronous insert with the stable batch token is the correctness
         mechanism for at-least-once delivery. Turning async_insert on here
         would make the worker's acknowledgement a lie. -->
    <oa_ingest>
      <async_insert>0</async_insert>
      <wait_for_async_insert>1</wait_for_async_insert>
      <insert_deduplicate>1</insert_deduplicate>
      <max_execution_time>60</max_execution_time>
    </oa_ingest>

    <!-- readonly=2: the grant list forbids writes; level 1 would also reject
         the per-query settings the gateway sends. -->
    <oa_read>
      <readonly>2</readonly>
      <max_execution_time>30</max_execution_time>
      <max_result_rows>1000000</max_result_rows>
    </oa_read>
  </profiles>
</clickhouse>
XML

chown root:clickhouse "$TARGET"
chmod 0640 "$TARGET"

exec /entrypoint.sh "$@"
