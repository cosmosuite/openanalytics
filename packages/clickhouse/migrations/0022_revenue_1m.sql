-- Minute-grain revenue rollup, for timezones whose offset is not a whole number
-- of hours (Asia/Kolkata +05:30, Asia/Kathmandu +05:45, Australia/Lord_Howe
-- +10:30).
--
-- ## Why this table exists
--
-- `revenue_1h`/`revenue_1d` (0018) bucket on UTC boundaries, and the read path
-- re-buckets them into local grains with `toStartOfHour(bucket_start, tz)`. That
-- composition is exact only when the zone's offset is a whole number of hours: a
-- +05:30 local hour begins in the MIDDLE of a UTC hour bucket, and an aggregate
-- cannot be split. So those zones had no revenue answer at all — the read layer
-- refused them rather than return a total whose edges belonged to the wrong day.
--
-- A minute bucket has no such problem. Every IANA offset is a whole number of
-- minutes, so every local hour and local day boundary lands exactly on a minute
-- boundary, and `toStartOfHour(bucket_start, tz)` over minute buckets composes
-- any zone exactly.
--
-- ## Why minute grain rather than a timezone-keyed rollup
--
-- The obvious alternative — bucket each site's rollup in that site's
-- `reporting_timezone` — was rejected, and the reason is a property of the
-- product rather than of the schema: the reporting timezone is a **setting a
-- customer can change**. Changing it would invalidate every stored bucket for
-- that site, requiring a full historical recompute before the dashboard was
-- correct again, and showing old-zone buckets in the meantime with nothing to
-- say so. A UTC minute bucket is true regardless of the setting, so the setting
-- becomes a read-time decision and changing it costs one query.
--
-- ## Why the cost is acceptable here and not for the additive family
--
-- `metrics_1m` exists and is affordable because it aggregates page views. This
-- table aggregates *transactions*: a site with a thousand orders a day writes at
-- most a thousand minute rows a day, against 1,440 possible. In practice revenue
-- facts are sparse enough that the minute table is smaller than the hour table's
-- own index for most sites, because an empty minute is simply not a row.
--
-- ## Not a materialized view, for 0018's reason
--
-- A refund REVERSES money a previous read already reported, and the facts are
-- versioned (`revenue_events` is ReplacingMergeTree(version), 0016). An
-- insert-only view can un-count neither. This is written by the same finalizer
-- pass that writes 0018's tables, in the same generation swap, from the same
-- plan — so the money rules live in exactly one place and this table can never
-- disagree with `revenue_1h` about the same money.
-- `tests/unit/revenue-migration-order.test.ts` enforces the no-view rule by
-- name, and its pattern covers `_1m` as well as `_1h`/`_1d`.

CREATE TABLE IF NOT EXISTS revenue_1m
(
  site_id                   UUID,
  -- A UTC minute. The only difference from `revenue_1h`, and the whole point.
  bucket_start              DateTime('UTC'),
  generation                UInt64,

  charge_gross_minor        Int64,
  refund_minor              Int64,
  dispute_withdrawn_minor   Int64,
  dispute_reinstated_minor  Int64,
  fee_minor                 Int64,
  net_minor                 Int64,

  charge_count              UInt64,
  refund_count              UInt64,
  dispute_count             UInt64,
  unconverted_count         UInt64,

  computed_at               DateTime64(3, 'UTC')
)
ENGINE = ReplacingMergeTree(generation)
-- Monthly partitions like its siblings. A minute bucket is 60x finer than an
-- hour one, but the partition key is about how parts are pruned and dropped, not
-- about row count, and a range read still prunes to the months it touches.
PARTITION BY toYYYYMM(bucket_start)
ORDER BY (site_id, bucket_start)
SETTINGS non_replicated_deduplication_window = 1000;
