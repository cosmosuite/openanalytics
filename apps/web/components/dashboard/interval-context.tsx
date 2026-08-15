"use client";

import { useParams } from "next/navigation";
import * as React from "react";
import {
  LIVE_API,
  resolveSiteSlugCached,
  sites,
  type AnalyticsRange,
} from "@/lib/api";
import { useSession } from "@/lib/auth-client";
import { resolveTimezone, sessionTimezone } from "@/lib/timezone";

/**
 * The overview screen's shared time range. One provider per screen; every
 * analytics panel reads the same `range`, so picking an interval refetches
 * them all together instead of each panel keeping its own idea of "now".
 *
 * Calendar boundaries are cut in the *resolved* timezone — the user's stored
 * preference (flattened onto the session as `user.timezone`), else the
 * browser's zone — and the same zone is sent as the `timezone` parameter, so
 * "Today" always means the user's today even on a travelling laptop.
 *
 * "All time" anchors on `min(created_at, first_event_at)`: `first_event_at`
 * can precede `created_at` by up to 24 hours (a client-stamped event the
 * collector accepted late), and anchoring on `created_at` alone could exclude
 * the very first event.
 */

export const INTERVALS = [
  { key: "today", label: "Today" },
  { key: "yesterday", label: "Yesterday" },
  { key: "24h", label: "Last 24 hours" },
  { key: "7d", label: "Last 7 days" },
  { key: "30d", label: "Last 30 days" },
  // Calendar month to date, not a rolling 30 days — the two answer different
  // questions and a dashboard that offers only the rolling one cannot be
  // reconciled against anything billed or reported monthly.
  { key: "month", label: "This month" },
  { key: "90d", label: "Last 90 days" },
  { key: "6mo", label: "Last 6 months" },
  { key: "12mo", label: "Last 12 months" },
  { key: "all", label: "All time" },
] as const;

export type IntervalKey = (typeof INTERVALS)[number]["key"];

export const DEFAULT_INTERVAL: IntervalKey = "7d";

/**
 * The picker remembers its last selection across reloads: a refresh must not
 * reset a deliberately chosen interval. The memory has a shelf life — coming
 * back after a long absence starts at Today, because yesterday afternoon's
 * "Last 90 days" says nothing about what this morning's visit is for. The
 * timestamp is re-stamped while the screen is in use, so "stale" measures
 * absence, not how long a working session lasted.
 */
const INTERVAL_STALE_AFTER_MS = 8 * 3_600_000;
/** What a fresh visit (nothing remembered, or remembered too long ago) shows. */
const RETURNING_INTERVAL: IntervalKey = "today";

/**
 * Where a picked interval is remembered.
 *
 * `account` is the dashboard's own long-lived entry: it survives a browser
 * restart, because a person's working window is a preference.
 *
 * `visit` is for surfaces that render in someone else's browser — the public
 * share board. It has to survive a refresh (an interval that resets itself is
 * just broken) but must not touch the `account` entry in either direction:
 * reading a stranger's share link was rewriting the viewer's own dashboard
 * picker, and the viewer's preference was leaking onto the shared page. A
 * per-tab entry under its own key is exactly that much memory and no more.
 */
export type IntervalMemory = "account" | "visit";

const MEMORY_STORE: Record<
  IntervalMemory,
  { key: string; area: () => Storage }
> = {
  account: {
    key: "oa:analytics-interval:v1",
    area: () => window.localStorage,
  },
  visit: {
    key: "oa:share-interval:v1",
    area: () => window.sessionStorage,
  },
};

const isIntervalKey = (value: unknown): value is IntervalKey =>
  INTERVALS.some((interval) => interval.key === value);

/** Fresh remembered selection, or `null` (missing, corrupt, or stale). */
function readStoredInterval(memory: IntervalMemory): IntervalKey | null {
  try {
    const store = MEMORY_STORE[memory];
    const raw = store.area().getItem(store.key);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as { key?: unknown; atMs?: unknown };
    if (!isIntervalKey(parsed.key)) return null;
    if (typeof parsed.atMs !== "number") return null;
    if (Date.now() - parsed.atMs > INTERVAL_STALE_AFTER_MS) return null;
    return parsed.key;
  } catch {
    return null;
  }
}

function storeInterval(key: IntervalKey, memory: IntervalMemory): void {
  try {
    const store = MEMORY_STORE[memory];
    store.area().setItem(store.key, JSON.stringify({ key, atMs: Date.now() }));
  } catch {
    // Blocked storage: selection still holds for this tab via state.
  }
}

const emptySubscribe = () => () => {};

/* --------------------------------------------------------------------- */
/* Calendar math in an arbitrary IANA zone                                */
/* --------------------------------------------------------------------- */

/** The zone's UTC offset at `at`, in milliseconds. */
function tzOffsetMs(timezone: string, at: Date): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(at)
      .map((part) => [part.type, part.value])
  );
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second)
  );
  return asUtc - at.getTime();
}

/**
 * The UTC instant at which the calendar day containing `base` — shifted by
 * whole years/months/days *on that zone's calendar* — starts in `timezone`.
 * Two offset passes converge across DST transitions.
 */
function zonedDayStart(
  base: Date,
  timezone: string,
  shift: {
    years?: number
    months?: number
    days?: number
    /**
     * Absolute day of month, replacing today's rather than shifting it — the
     * "this month" anchor. A relative `days` cannot express it: the shift needed
     * to reach the 1st depends on today's date, which the caller does not know
     * in the request timezone (that is the whole reason this helper exists).
     */
    dayOfMonth?: number
  } = {}
): Date {
  const [y, m, d] = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .format(base)
    .split("-")
    .map(Number);
  const target = Date.UTC(
    y + (shift.years ?? 0),
    m - 1 + (shift.months ?? 0),
    (shift.dayOfMonth ?? d) + (shift.days ?? 0)
  );
  let instant = target - tzOffsetMs(timezone, new Date(target));
  instant = target - tzOffsetMs(timezone, new Date(instant));
  return new Date(instant);
}

/**
 * Half-open `[from, to)` for an interval, cut at the resolved zone's calendar
 * boundaries and sent with that zone. The backend snaps endpoints to the
 * served grain and echoes the effective range; a sub-hour-offset zone can be
 * refused at hour/day grain (`RESOLUTION_NOT_AVAILABLE`), which the panels
 * present as a range error.
 *
 * `allFromMs` anchors the "all" interval; while it is still unknown the view
 * falls back to the trailing 12 months and refines the moment the site read
 * answers.
 */
export function rangeForInterval(
  key: IntervalKey,
  timezone?: string,
  allFromMs?: number | null,
  now: Date = new Date()
): AnalyticsRange {
  const tz = timezone ?? resolveTimezone(null);
  const day = (shift: Parameters<typeof zonedDayStart>[2]) =>
    zonedDayStart(now, tz, shift);
  const tomorrow = day({ days: 1 });

  const bounds: Record<IntervalKey, [Date, Date]> = {
    today: [day({}), tomorrow],
    yesterday: [day({ days: -1 }), day({})],
    "24h": [new Date(now.getTime() - 86_400_000), now],
    "7d": [day({ days: -6 }), tomorrow],
    "30d": [day({ days: -29 }), tomorrow],
    // The 1st of the current month in the request timezone, through tomorrow —
    // month-to-date, so it grows through the month rather than being a fixed
    // window.
    month: [day({ dayOfMonth: 1 }), tomorrow],
    "90d": [day({ days: -89 }), tomorrow],
    "6mo": [day({ months: -6, days: 1 }), tomorrow],
    "12mo": [day({ years: -1, days: 1 }), tomorrow],
    all: [
      allFromMs === null || allFromMs === undefined
        ? day({ years: -1, days: 1 })
        : zonedDayStart(new Date(allFromMs), tz),
      tomorrow,
    ],
  };

  const [from, to] = bounds[key];
  return { from: from.toISOString(), to: to.toISOString(), timezone: tz };
}

type IntervalContextValue = {
  interval: IntervalKey;
  setInterval: (key: IntervalKey) => void;
  range: AnalyticsRange;
  /**
   * True while "All time" is chosen but the site's birthday is still being
   * fetched — the range in hand is the 12-month fallback and about to be
   * replaced. Panels hold their first skeleton through it instead of
   * fetching a range that is one anchor away from wrong: firing on the
   * fallback played every load twice on an all-time refresh.
   */
  rangePending: boolean;
  /**
   * The intervals this screen offers. The picker reads it rather than the
   * module constant, so a surface can withhold one it cannot honestly serve —
   * the public board withholds "All time", whose anchor needs a site the
   * viewer cannot see.
   */
  intervals: readonly (typeof INTERVALS)[number][];
};

const IntervalContext = React.createContext<IntervalContextValue | null>(null);

/** Mock mode's stable "site birth" — matches the mock series' opening day. */
const MOCK_ALL_FROM_MS = Date.parse("2026-06-20T00:00:00Z");

export function IntervalProvider({
  children,
  memory = "account",
  intervals = INTERVALS,
  allAnchorMs,
  timezone: timezoneProp,
}: {
  children: React.ReactNode;
  /** Which store remembers the pick — see `IntervalMemory`. */
  memory?: IntervalMemory;
  /** Which intervals this screen offers; see `intervals` on the context. */
  intervals?: readonly (typeof INTERVALS)[number][];
  /**
   * The "All time" anchor, supplied by a screen that already holds it —
   * the share board reads it off the public identity route (ADR-0044),
   * where this provider's own slug-based site fetch has no session to run
   * with. `undefined` means "not supplied; fetch it here as usual", `null`
   * means "supplied, and there is no anchor" (the 12-month fallback is
   * final). A screen that offers "all" only after its anchor read settles
   * never leaves panels waiting on this value.
   */
  allAnchorMs?: number | null;
  /**
   * The clock ranges are cut in, supplied by a screen whose clock is not
   * the signed-in user's — the share board passes the viewer's pick,
   * defaulting to the site's reporting zone (ADR-0044). Omitted, the
   * account preference (else the browser) applies as ever.
   */
  timezone?: string;
}) {
  /**
   * Read through `useSyncExternalStore` so the server render (no storage)
   * and hydration agree on `null`, then the client's remembered value takes
   * over in the post-hydration pass — no mismatch, no flash of a wrong
   * range in the address of a hydration error.
   */
  const readStored = React.useCallback(
    () => readStoredInterval(memory),
    [memory]
  );
  const stored = React.useSyncExternalStore(
    emptySubscribe,
    readStored,
    () => null
  );
  const [chosen, setChosen] = React.useState<IntervalKey | null>(null);
  const interval = chosen ?? stored ?? RETURNING_INTERVAL;

  const { data: session } = useSession();
  const timezone =
    timezoneProp ?? resolveTimezone(sessionTimezone(session?.user));

  const params = useParams<{ site?: string }>();
  const slug = params.site ? decodeURIComponent(params.site) : "";

  /**
   * The "All time" anchor: `min(created_at, first_event_at)`, fetched from
   * the site read the first time the interval is chosen. Keyed by slug so a
   * site switch cannot serve another site's birthday.
   */
  const [allAnchor, setAllAnchor] = React.useState<{
    slug: string;
    /** Null is *resolved without an anchor* — the fallback range is final. */
    fromMs: number | null;
  } | null>(null);
  React.useEffect(() => {
    // A supplied anchor makes the fetch moot — and on a slug-less surface
    // (the share board) there is no site read to make anyway.
    if (allAnchorMs !== undefined) return;
    if (interval !== "all" || slug === "") return;
    if (allAnchor !== null && allAnchor.slug === slug) return;
    let cancelled = false;
    const fetchAnchor = async () => {
      if (!LIVE_API) {
        if (!cancelled) setAllAnchor({ slug, fromMs: MOCK_ALL_FROM_MS });
        return;
      }
      try {
        const { site_id } = await resolveSiteSlugCached(slug);
        const site = await sites.get(site_id);
        const created = Date.parse(site.created_at);
        const first =
          site.first_event_at === null
            ? Number.NaN
            : Date.parse(site.first_event_at);
        const fromMs = Number.isNaN(first)
          ? created
          : Math.min(created, first);
        if (!cancelled) {
          // NaN settles as anchorless too — an unparseable birthday must
          // resolve the wait, not strand every panel in its skeleton.
          setAllAnchor({
            slug,
            fromMs: Number.isNaN(fromMs) ? null : fromMs,
          });
        }
      } catch {
        // Resolved without an anchor: the 12-month fallback keeps the view
        // honest, and panels stop holding for a refinement that isn't coming.
        if (!cancelled) setAllAnchor({ slug, fromMs: null });
      }
    };
    void fetchAnchor();
    return () => {
      cancelled = true;
    };
  }, [interval, slug, allAnchor, allAnchorMs]);

  const setInterval = React.useCallback(
    (key: IntervalKey) => {
      setChosen(key);
      storeInterval(key, memory);
    },
    [memory]
  );

  // Re-stamp the remembered selection while the screen is in use — absence
  // is what should age it out, not a long afternoon of work.
  React.useEffect(() => {
    // Nothing picked and nothing remembered: there is no selection to stamp,
    // and writing the fallback here is what broke the memory. On the first
    // client pass `stored` is still the server snapshot (`null`), so an
    // unconditional write put "today" into storage *before* the real value
    // could be read back — every reload reset the picker to Today.
    if (chosen === null && stored === null) return;
    storeInterval(interval, memory);
  }, [interval, memory, chosen, stored]);

  // One range per (interval, zone, anchor) — recomputing per render would
  // move the endpoints between renders and refire every panel's request.
  const allFromMs =
    allAnchorMs !== undefined
      ? allAnchorMs
      : allAnchor !== null && allAnchor.slug === slug
        ? allAnchor.fromMs
        : null;
  const range = React.useMemo(
    () => rangeForInterval(interval, timezone, allFromMs),
    [interval, timezone, allFromMs]
  );
  // A supplied anchor is never pending, and slug-less surfaces without one
  // (the public share board before ADR-0044) have nothing to wait for.
  const rangePending =
    interval === "all" &&
    allAnchorMs === undefined &&
    slug !== "" &&
    (allAnchor === null || allAnchor.slug !== slug);

  const value = React.useMemo(
    () => ({ interval, setInterval, range, rangePending, intervals }),
    [interval, setInterval, range, rangePending, intervals]
  );

  return (
    <IntervalContext.Provider value={value}>
      {children}
    </IntervalContext.Provider>
  );
}

/**
 * The screen's shared interval. Falls back to a static default range when no
 * provider is mounted, so a panel reused on a screen without a picker still
 * has an honest, fixed window instead of crashing.
 */
export function useAnalyticsInterval(): IntervalContextValue {
  const context = React.useContext(IntervalContext);
  const fallback = React.useMemo<IntervalContextValue>(
    () => ({
      interval: DEFAULT_INTERVAL,
      setInterval: () => {},
      range: rangeForInterval(DEFAULT_INTERVAL),
      // A static default window is never waiting on an anchor.
      rangePending: false,
      intervals: INTERVALS,
    }),
    []
  );
  return context ?? fallback;
}
