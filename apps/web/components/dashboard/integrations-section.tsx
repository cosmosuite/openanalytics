"use client";

import { AnimatePresence } from "motion/react";
import * as React from "react";
import { CircleDashedIcon } from "@/components/icons/hugeicons";
import { Badge } from "@/components/ui/badge";
import { ApiErrorPanel } from "@/components/dashboard/api-error";
import { FlowDialog } from "@/components/dashboard/flow-dialog";
import {
  ProviderMark,
  ProviderRowsSkeleton,
} from "@/components/dashboard/provider-card";
import { RevenueModeChoice } from "@/components/dashboard/revenue-mode-choice";
import {
  SectionHeading,
  SettingsPanel,
} from "@/components/dashboard/settings-panel";
import { CopyButton } from "@/components/ui/copy-button";
import { Button } from "@/components/ui/button";
import { SaveButton } from "@/components/ui/save-button";
import { SkeletonBar, SkeletonReveal } from "@/components/ui/skeleton-reveal";
import { useApiResource } from "@/hooks/use-api-resource";
import {
  ApiError,
  ingestSettings,
  LIVE_API,
  revenue,
  type RevenueConnection,
  type RevenueConnectionState,
  type RevenueProvider,
  type SiteSummary,
} from "@/lib/api";
import { useAction } from "@/lib/use-api";
import { cn } from "@/lib/utils";

/**
 * Integrations — the Stripe half is real (M12, ADR-0033; frontend_tasks §24).
 *
 * **This is a different door from the Revenue card.** Connecting is
 * `credentials:manage`, so owner *and* admin; reading a number out of it is
 * `revenue:read`, owner-only. An admin may wire Stripe up and never see a
 * total. A viewer sees the panel read-only rather than not at all — hiding it
 * would make the screen lie about what the site has.
 *
 * **The catalog is the feature probe.** `POST` and `PATCH` are registered only
 * where the deployment holds a credential keyring, so they answer `404` where
 * it has none while the catalog, `GET` and `DELETE` keep working. A `404` from
 * connect therefore means "this build cannot connect a provider", never a bad
 * site id — the same shape as the imports probe.
 *
 * **Connecting is two steps and the screen is built as two.** The signing
 * secret is deliberately absent from the connect body because it does not
 * exist yet: it can only be obtained after creating an endpoint at the
 * `webhook_url` that the connect call itself mints. Between the steps the
 * connection is `active` and **already ingesting** — the backfill and reconcile
 * sweeps run on the API key alone — so step one is never rendered as an error
 * or a half-broken state. A customer who closes the tab in between comes back
 * to a connection that works and a screen that still asks for the secret.
 */

/* ------------------------------------------------------------------ */
/* Local artwork, keyed by the catalog's own ids                       */
/* ------------------------------------------------------------------ */

/**
 * Logos we happen to have, by provider id. The catalog is the source of truth
 * for *which* providers exist and what they are called — this map only decides
 * whether a row gets a picture, and a provider we have no logo for still
 * renders under its `display_name`.
 */
const LOGOS: Record<string, { src: string; inset?: boolean }> = {
  stripe: { src: "/images/stripe.avif" },
  polar: { src: "/images/polar.avif" },
  creem: { src: "/images/creem.avif" },
  dodo: { src: "/images/dodo.avif" },
  "lemon-squeezy": { src: "/images/lemonsqueezy.avif" },
  lemonsqueezy: { src: "/images/lemonsqueezy.avif" },
  paddle: { src: "/images/paddle.avif" },
};

/**
 * How many rows the catalog's skeleton draws.
 *
 * The catalog is a server list, so its length is the one thing this screen
 * cannot know before it answers. Counting the logos above is the closest
 * honest guess and it maintains itself: a logo is added when a provider is,
 * so the number moves with the catalog instead of ageing into a constant
 * nobody revisits. Deduplicated by file because a few ids are spelling
 * variants of one provider.
 */
const CATALOG_ROWS = new Set(Object.values(LOGOS).map((logo) => logo.src)).size;

/**
 * The restricted-key permissions, verbatim from the connect guide.
 *
 * Rendered rather than paraphrased on purpose: a customer who grants one
 * permission short gets a connection that probes fine and then silently
 * under-reports, and "amounts and currency" is not a thing anyone can
 * reconstruct from memory. The *why* column is what stops the list reading as
 * an over-broad ask.
 */
const STRIPE_PERMISSIONS: Array<[string, string, string]> = [
  ["Charges", "Amounts, currency, status, refund linkage", "rak_charge_read"],
  ["Refunds", "So a refund lands in its own bucket", "rak_refund_read"],
  [
    "Disputes",
    "Chargebacks; funds withdrawn and reinstated",
    "rak_dispute_read",
  ],
  [
    "Customers",
    "Metadata used to match a payment to a visitor",
    "rak_customer_read",
  ],
  [
    "Checkout Sessions",
    "`client_reference_id`, the second matching signal",
    "rak_checkout_session_read",
  ],
  [
    "PaymentIntents",
    "Order identity across charge retries",
    "rak_payment_intent_read",
  ],
  ["Invoices", "Subscription revenue context", "rak_invoice_read"],
  ["Subscriptions", "Plan and product context", "rak_subscription_read"],
  ["Products", "Display names for product breakdowns", "rak_product_read"],
  // `rak_plan_read`, not `rak_price_read`: the row is called Prices in the
  // dashboard, but its permission still carries the API's original name for the
  // object. Verified against the live create-key screen — `rak_price_read` is
  // silently ignored and leaves the row unticked.
  ["Prices", "Display names for product breakdowns", "rak_plan_read"],
  // Likewise verified: the row Stripe ticks for balance transactions is
  // "Balance Transaction Sources", and `rak_balance_transaction_read` matches
  // nothing.
  [
    "Balance transactions",
    "Provider fees",
    "rak_balance_transaction_source_read",
  ],
  ["Events", "Backfill verification window", "rak_event_read"],
];

/**
 * Stripe's create-key screen with the twelve permissions pre-selected.
 *
 * Built from `STRIPE_PERMISSIONS` rather than written out, so the link and the
 * list rendered below it cannot drift: adding a resource to that array ticks it
 * in Stripe's form and shows it to the customer in the same edit.
 *
 * **The query parameters are undocumented.** Stripe has never published them and
 * has changed this screen before, so they may stop being honoured without
 * notice. That is survivable here only because the full list stays on screen
 * underneath: if the prefill silently stops working, the customer is looking at
 * exactly the twelve rows they need to tick by hand. A link like this in a
 * dialog that did NOT show the list would be the bad version — one grant short
 * is a connection that probes fine and under-reports for ever.
 */
const STRIPE_CREATE_KEY_URL = `https://dashboard.stripe.com/apikeys/create?${new URLSearchParams([
  ["name", "OpenAnalytics"],
  ...STRIPE_PERMISSIONS.map(([, , token]): [string, string] => ["permissions[]", token]),
]).toString()}`;

/**
 * The webhook endpoint's event subscription, verbatim from the connect guide
 * (ADR-0033's consumed allowlist). Shown where the customer copies the
 * endpoint address, because Stripe's add-endpoint form asks "which events?"
 * right there and this screen used to leave that question unanswered.
 *
 * "Select all events" is the recommended answer — everything outside this
 * list is acknowledged and ignored, never retried and never an error — so
 * the list exists for the customer who prefers a narrow subscription. For
 * them it must be complete: one event type short is a payment state that
 * silently never updates.
 */
const STRIPE_WEBHOOK_EVENTS = [
  "charge.succeeded",
  "charge.updated",
  "charge.captured",
  "charge.refunded",
  "refund.created",
  "refund.updated",
  "refund.failed",
  "charge.dispute.created",
  "charge.dispute.closed",
  "charge.dispute.funds_withdrawn",
  "charge.dispute.funds_reinstated",
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
];

const inputClass =
  "h-9 w-full rounded-xl border border-input bg-white px-3 text-sm outline-none transition-[box-shadow,border-color] focus-visible:border-ring focus-visible:[outline:2px_solid_var(--ring)] focus-visible:[outline-offset:-2px]";

/* ------------------------------------------------------------------ */
/* Alerts — still genuinely nothing                                    */
/* ------------------------------------------------------------------ */

const ALERT_APPS = [
  {
    id: "telegram",
    name: "Telegram",
    logo: "/images/telegram.avif",
    gains: "Alerts land in the chat you pick.",
  },
  {
    id: "slack",
    name: "Slack",
    logo: "/images/slack.avif",
    inset: true,
    gains: "Alerts post to the channel you pick.",
  },
];

/**
 * The Integrations tab, in the house model: every panel's chrome — frame,
 * title — is real from the first frame, and only content that waits on a
 * read stands in as a skeleton and comes into focus. Alerts waits on
 * nothing, so it is simply there, like the API panel's create form.
 */
export function IntegrationsSection({ site }: { site: SiteSummary }) {
  const canManage = site.role === "owner" || site.role === "admin";

  const loadCatalog = React.useCallback(async (): Promise<RevenueProvider[]> => {
    if (!LIVE_API) {
      return [
        { id: "stripe", display_name: "Stripe", available: true },
        { id: "polar", display_name: "Polar", available: false },
        { id: "paddle", display_name: "Paddle", available: false },
      ];
    }
    const response = await revenue.providers();
    return response.items;
  }, []);

  /**
   * A version counter, because `useApiResource` refetches when its `load`
   * identity changes and exposes `retry` only on the error branch. Every
   * mutation here — connect, secret, rotate, disconnect — answers with a
   * connection we could merge locally, but re-reading is what keeps the
   * screen honest about fields the server owns (`last_verified_at`, a
   * `degraded` that cleared) rather than the subset a response happened to
   * carry.
   */
  const [version, setVersion] = React.useState(0);
  const reload = React.useCallback(() => setVersion((n) => n + 1), []);

  const loadState = React.useCallback(async (): Promise<RevenueConnectionState> => {
    void version;
    if (!LIVE_API) return { status: "not_connected" };
    return revenue.state(site.site_id);
  }, [site.site_id, version]);

  const catalog = useApiResource(loadCatalog);
  const state = useApiResource(loadState);

  // Either read failing used to leave the panel pulsing forever, because the
  // old guard only ever asked whether both were ready. An error is an answer:
  // it settles the panel and renders as its content.
  const failed =
    catalog.status === "error"
      ? catalog
      : state.status === "error"
        ? state
        : null;
  const settled =
    catalog.status === "ready" && state.status === "ready"
      ? { providers: catalog.data, connection: state.data }
      : null;
  const revealed = failed !== null || settled !== null;

  return (
    <>
      <SectionHeading
        description="Connect the provider that takes your money, and every payment lands beside the visit that produced it."
        title="Integrations"
      />
      <SettingsPanel title="Revenue">
        {/* Drawn as the catalog: a site that has not connected anything,
            which is what almost every first visit here is. A connected site
            lands on a taller card instead, and nothing can know which before
            the state read answers — so this draws the common one rather than
            an average of the two that would be wrong for both. */}
        <SkeletonReveal
          ready={revealed}
          skeleton={
            <ProviderRowsSkeleton
              action={
                <SkeletonBar className="h-8 w-20 shrink-0 rounded-full" />
              }
              rows={CATALOG_ROWS}
            />
          }
        >
          {failed ? (
            <ApiErrorPanel error={failed.error} onRetry={failed.retry} />
          ) : settled ? (
            // A disabled connection renders as the pristine catalog, not as
            // a connected card in a special state: the customer ended the
            // relationship, and a card still showing the old key's ending
            // reads as "something is still attached". The record the server
            // keeps (so recorded revenue stays served) is its business;
            // connecting again through the catalog is the same POST a
            // reconnect would be, minting a fresh key probe and webhook.
            settled.connection.status === "not_connected" ||
            settled.connection.status === "disabled" ? (
              <ProviderList
                canManage={canManage}
                onConnected={reload}
                providers={settled.providers}
                siteId={site.site_id}
              />
            ) : (
              <ConnectedPanel
                canManage={canManage}
                connection={settled.connection}
                onChanged={reload}
                providers={settled.providers}
                siteId={site.site_id}
              />
            )
          ) : null}
        </SkeletonReveal>
      </SettingsPanel>
      <RevenueModePanel
        canManage={canManage}
        revealed={revealed}
        siteId={site.site_id}
      />
      <AlertsPanel revealed={revealed} />
    </>
  );
}

/**
 * The same choice the connect flow's second step makes, for the far more
 * common case: somebody who connected months ago and is deciding now.
 *
 * It sits under Revenue rather than in General because this is where a customer
 * comes when journeys have no money in them, and it is the answer to that. The
 * flag itself is a site ingest setting and holds with no provider connected at
 * all (ADR-0064 D4a), so the panel does not gate on a connection: a site that
 * disconnected Stripe still gets to decide what its pages send.
 *
 * A viewer sees the choice and cannot move it. `PATCH /ingest-settings` is
 * owner and admin, and discovering that through a `403` on the first click is
 * worse than a control that was never live.
 */
function RevenueModePanel({
  canManage,
  revealed,
  siteId,
}: {
  canManage: boolean;
  revealed: boolean;
  siteId: string;
}) {
  const load = React.useCallback(async (): Promise<boolean> => {
    if (!LIVE_API) return false;
    // Only one field of the row is this panel's business. A site that has
    // never written these settings has no row and the endpoint answers with
    // the product defaults, so there is no not-configured branch to draw.
    const settings = await ingestSettings.get(siteId);
    return settings.attributed_revenue;
  }, [siteId]);

  const resource = useApiResource(load);

  /**
   * Reflected only after the server confirms, like every other write on this
   * screen. The radio therefore does not move under the pointer and then move
   * back if the `PATCH` fails, which on a control that changes what visitors'
   * browsers do is the wrong way round.
   */
  const [confirmed, setConfirmed] = React.useState<boolean | null>(null);
  const value =
    confirmed ?? (resource.status === "ready" ? resource.data : false);

  const write = useAction(async (next: boolean) => {
    if (LIVE_API) await ingestSettings.update(siteId, {
      attributed_revenue: next,
    });
    setConfirmed(next);
  });

  return (
    <SettingsPanel title="Revenue mode">
      <SkeletonReveal
        ready={revealed && resource.status !== "loading"}
        skeleton={
          // Shaped like what it stands in for rather than one bar: two option
          // rows and the paragraph under them, so the swap does not resize the
          // card. `ApiErrorPanel` stays outside this padding because it brings
          // its own, the same way the Revenue panel beside this one is built.
          <div className="flex flex-col gap-3 p-5">
            <SkeletonBar className="h-[104px] w-full rounded-lg" />
            <SkeletonBar className="h-[84px] w-full rounded-lg" />
            <SkeletonBar className="h-16 w-full rounded-md" />
          </div>
        }
      >
        {resource.status === "error" ? (
          <ApiErrorPanel error={resource.error} onRetry={resource.retry} />
        ) : (
          <div className="flex flex-col gap-3 p-5">
            <RevenueModeChoice
              disabled={!canManage || write.busy}
              onValueChange={(next) => write.run(next)}
              value={value}
            />
            {/* The gap between "saved" and "in effect" is real and small, and
                naming it here is cheaper than the support thread from somebody
                who flipped this, reloaded their own site, saw the old
                behaviour and concluded the switch does nothing. */}
            <p className="text-xs leading-5 text-muted-foreground">
              Saved the moment you choose it. Visitors&rsquo; browsers hold
              their copy of this configuration for about thirty seconds, so a
              change reaches them a moment later rather than instantly.
            </p>
            {write.error ? (
              <p className="text-xs leading-5 text-destructive-foreground">
                <strong>{write.error.title}</strong> {write.error.body}
              </p>
            ) : null}
          </div>
        )}
      </SkeletonReveal>
    </SettingsPanel>
  );
}

/**
 * Still genuinely nothing: M10 was the lifecycle milestone, not the
 * notification one. There is no preference API to wire.
 *
 * It fetches nothing, yet its content still stands in and reveals on the
 * tab's gate. That is not theatre about latency — the *tab* is genuinely
 * loading, and which of its panels happens to already hold its data is an
 * implementation detail the customer cannot see. What they would see is one
 * finished card beside a pulsing one, which is the thing a skeleton exists
 * to prevent.
 */
function AlertsPanel({ revealed }: { revealed: boolean }) {
  return (
    <SettingsPanel title="Alerts">
      <SkeletonReveal
        ready={revealed}
        skeleton={
          <ProviderRowsSkeleton
            action={<SkeletonBar className="h-6 w-24 shrink-0 rounded-full" />}
            rows={ALERT_APPS.length}
          />
        }
      >
        {!revealed ? null : (
          <ul className="divide-y divide-border">
            {ALERT_APPS.map((app) => (
              <li className="flex items-center gap-3 px-5 py-3" key={app.id}>
                <ProviderMark alt="" inset={app.inset} src={app.logo} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">
                    {app.name}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {app.gains}
                  </span>
                </span>
                <Badge icon={<CircleDashedIcon />} size="sm" variant="secondary">
                  Coming soon
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </SkeletonReveal>
    </SettingsPanel>
  );
}

/** A provider's display name from the catalog, falling back to its id. */
function nameOf(providers: RevenueProvider[], id: string): string {
  return providers.find((entry) => entry.id === id)?.display_name ?? id;
}

/* ------------------------------------------------------------------ */
/* Not connected: the catalog, and the connect form                    */
/* ------------------------------------------------------------------ */

function ProviderList({
  providers,
  siteId,
  canManage,
  onConnected,
}: {
  providers: RevenueProvider[];
  siteId: string;
  canManage: boolean;
  onConnected: () => void;
}) {
  const [connecting, setConnecting] = React.useState<RevenueProvider | null>(
    null
  );

  return (
    <div className="flex flex-col">
      <ul className="divide-y divide-border">
        {providers.map((provider) => {
          const logo = LOGOS[provider.id];
          return (
            <li className="flex items-center gap-3 px-5 py-3" key={provider.id}>
              <ProviderMark alt="" inset={logo?.inset} src={logo?.src ?? ""} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">
                  {provider.display_name}
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  {provider.available
                    ? "Payments matched to the visits that produced them."
                    : "The adapter is planned, not half-built."}
                </span>
              </span>
              {/* Unavailable rows are rendered rather than filtered: a
                  customer looking for their provider should find out that we
                  know about it, not be left wondering. */}
              {provider.available ? (
                canManage ? (
                  <Button onClick={() => setConnecting(provider)} size="xs">
                    Connect
                  </Button>
                ) : null
              ) : (
                <Badge icon={<CircleDashedIcon />} size="sm" variant="secondary">
                  Coming soon
                </Badge>
              )}
            </li>
          );
        })}
      </ul>
      {!canManage ? (
        <p className="border-t border-border px-5 py-3 text-xs leading-5 text-muted-foreground">
          Only an owner or admin can connect a provider.
        </p>
      ) : null}
      <AnimatePresence>
        {connecting ? (
          <ConnectProviderFlow
            onClose={() => setConnecting(null)}
            onConnected={() => {
              setConnecting(null);
              onConnected();
            }}
            provider={connecting}
            siteId={siteId}
          />
        ) : null}
      </AnimatePresence>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* The connect modal — the shared flow-dialog shell, two steps         */
/* ------------------------------------------------------------------ */

/**
 * Connecting a provider, in the shared `FlowDialog` shell. Three steps because
 * the work is three acts: step one is what to do *in Stripe* (create a
 * restricted key with the right reads), step two is the one decision only the
 * customer can make, step three is the one field we need back. The inline form
 * this replaces buried the permissions behind a toggle; here they are the
 * content of their own step, and so is the decision.
 *
 * **The decision comes before the key, not after it**, because everything is
 * written by the last button. Connecting first and asking afterwards would
 * leave a live connection whose mode is whatever the site had before, changeable
 * only by a customer who has already closed this dialog.
 */
function ConnectProviderFlow({
  provider,
  siteId,
  onClose,
  onConnected,
}: {
  provider: RevenueProvider;
  siteId: string;
  onClose: () => void;
  onConnected: () => void;
}) {
  const [step, setStep] = React.useState<1 | 2 | 3>(1);
  const [dir, setDir] = React.useState(1);
  const [apiKey, setApiKey] = React.useState("");
  /**
   * ADR-0064 D4a, and `false` is the answer a site that says nothing gets.
   *
   * Written on connect whichever way it lands, including `false`: a site
   * reconnecting after a disconnect may carry `true` from the 0044 backfill,
   * and leaving that alone would turn a linking behaviour back on for somebody
   * who just chose totals on this screen.
   */
  const [attributed, setAttributed] = React.useState(false);
  /** A connection that came up while its mode did not. See `connect`. */
  const [modeUnsaved, setModeUnsaved] = React.useState(false);
  /**
   * A `404` here is the feature probe answering, not a missing site: connect
   * is registered only where the deployment holds a credential keyring. It
   * deserves its own sentence rather than the generic not-found copy.
   */
  const [unsupported, setUnsupported] = React.useState(false);

  const goTo = (next: 1 | 2 | 3) => {
    setDir(next > step ? 1 : -1);
    setStep(next);
  };

  const connect = useAction(async () => {
    setUnsupported(false);
    setModeUnsaved(false);
    if (LIVE_API) {
      try {
        await revenue.connect(siteId, {
          api_key: apiKey.trim(),
          provider: provider.id,
        });
      } catch (raised) {
        if (raised instanceof ApiError && raised.status === 404) {
          setUnsupported(true);
          return;
        }
        throw raised;
      }
      /**
       * Two calls, and only the first one is the connection. If the mode fails
       * to save we do NOT unwind the connection: it is live, ingesting and
       * useful, and tearing it down over a settings write would be the larger
       * loss. The dialog says which half landed and where to finish, instead of
       * reporting a failure that would send somebody looking for a connection
       * that is already there.
       */
      try {
        await ingestSettings.update(siteId, {
          attributed_revenue: attributed,
        });
      } catch {
        setModeUnsaved(true);
        return;
      }
    }
    setApiKey("");
    onConnected();
  });

  const stepTitles = {
    1: `Connect ${provider.display_name}`,
    2: "How revenue is measured",
    3: "Paste your restricted key",
  } as const;

  return (
    <FlowDialog
      ariaLabel={stepTitles[1]}
      counter={`${step} / 3`}
      dir={dir}
      onClose={onClose}
      panelKey={step}
      title={stepTitles[step]}
      footer={
        step === 1 ? (
          <>
            <Button variant="ghost" size="xs" onClick={onClose}>
              Cancel
            </Button>
            <Button size="xs" onClick={() => goTo(2)}>
              Continue
            </Button>
          </>
        ) : step === 2 ? (
          <>
            <Button variant="ghost" size="xs" onClick={() => goTo(1)}>
              Back
            </Button>
            {/* Never disabled: one of the two is always chosen, and the
                default is the answer that asks nothing of anybody. */}
            <Button size="xs" onClick={() => goTo(3)}>
              Continue
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" size="xs" onClick={() => goTo(2)}>
              Back
            </Button>
            <Button
              size="xs"
              disabled={apiKey.trim().length === 0}
              loading={connect.busy}
              onClick={() => connect.run()}
            >
              Connect
            </Button>
          </>
        )
      }
    >
      {step === 1 ? (
        <div className="flex flex-col gap-3 p-4">
          <p className="text-xs leading-5 text-muted-foreground">
            Create a{" "}
            <strong className="text-foreground/80">
              restricted
            </strong>{" "}
            key in your {provider.display_name} dashboard with read
            access to the resources below. We store it encrypted and
            never show it again.
          </p>

          {/* Straight to the create-key screen rather than "go
              find it in your dashboard". Stripe's own URL, and it
              follows whichever mode the customer is signed into,
              so a sandbox key is one click from here too.

              The permissions ride along as query parameters, so
              the form opens with the twelve boxes already ticked.
              They are undocumented and Stripe may drop them at any
              release — see STRIPE_CREATE_KEY_URL, which is why the
              full list stays visible below rather than being
              replaced by the link. */}
          {provider.id === "stripe" ? (
            <a
              className="text-xs font-medium text-primary underline-offset-4 hover:underline"
              href={STRIPE_CREATE_KEY_URL}
              rel="noreferrer noopener"
              target="_blank"
            >
              Open Stripe&rsquo;s create-key screen ↗
            </a>
          ) : null}

          {/* The permissions are the step's content, not a
              footnote behind a toggle: one grant short means a
              connection that probes fine and silently
              under-reports. All twelve rows in full — a person
              ticking boxes in Stripe's form needs the whole list
              in view, not a viewport to fish rows out of. */}
          <dl className="flex flex-col gap-1 rounded-2xl bg-secondary/40 p-3 text-xs">
            {STRIPE_PERMISSIONS.map(([resource, why]) => (
              <div className="flex items-baseline gap-3" key={resource}>
                <dt className="w-36 shrink-0 font-medium">
                  {resource}
                </dt>
                <dd className="min-w-0 text-muted-foreground">
                  Read: {why}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      ) : step === 2 ? (
        <div className="flex flex-col gap-3 p-4">
          {/* Not "whether your pages send anything about the visitor": that
              was true of the browser half alone, and D4b made the switch the
              decision itself. The framing has to survive somebody reading it
              beside a journey that never appeared. */}
          <p className="text-xs leading-5 text-muted-foreground">
            Both modes read the same payments. The difference is whether one is
            tied back to the visit that produced it, and that is yours to decide
            rather than ours to assume.
          </p>
          <RevenueModeChoice
            onValueChange={setAttributed}
            value={attributed}
          />
          <p className="text-xs leading-5 text-muted-foreground">
            You can change this later under Settings, and nothing about it is
            permanent.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-3 p-4">
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">
              Restricted API key
            </span>
            <input
              autoComplete="off"
              autoFocus
              className={inputClass}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder="rk_live_…"
              spellCheck={false}
              type="password"
              value={apiKey}
            />
          </label>
          <p className="text-xs leading-5 text-muted-foreground">
            Connecting checks the key with {provider.display_name}{" "}
            and starts the backfill. After that, the panel gives you
            a webhook address to create there, so new payments land
            in seconds instead of minutes.
          </p>
          {connect.busy ? (
            // The call takes a live round trip to the provider, so
            // the wait is real and worth naming rather than
            // leaving the button spinning.
            <p className="text-xs text-muted-foreground">
              Checking the key with {provider.display_name}…
            </p>
          ) : null}
          {unsupported ? (
            <p className="text-xs leading-5 text-muted-foreground">
              This deployment cannot connect a payment provider;
              it has no credential store configured. Nothing is
              wrong with your key.
            </p>
          ) : null}
          {modeUnsaved ? (
            // Half-landed, and saying so beats a bare failure: the
            // connection is up and working, only the mode is not
            // what was picked a step ago.
            <p className="text-xs leading-5 text-muted-foreground">
              <strong className="text-foreground/80">
                {provider.display_name} is connected
              </strong>{" "}
              and already ingesting, but the revenue mode did not
              save. It is still whatever it was before. Set it
              under Settings, Ingest.
            </p>
          ) : null}
          {connect.error ? (
            <p className="text-xs leading-5 text-destructive-foreground">
              <strong>{connect.error.title}</strong>{" "}
              {connect.error.body}
            </p>
          ) : null}
        </div>
      )}
    </FlowDialog>
  );
}

/* ------------------------------------------------------------------ */
/* Connected                                                           */
/* ------------------------------------------------------------------ */

const STATUS_COPY: Record<
  RevenueConnection["status"],
  { label: string; tone: string }
> = {
  active: { label: "Connected", tone: "text-success-foreground" },
  degraded: { label: "Sync failing", tone: "text-amber-700" },
  disabled: { label: "Disconnected", tone: "text-muted-foreground" },
};

function ConnectedPanel({
  connection,
  providers,
  siteId,
  canManage,
  onChanged,
}: {
  connection: RevenueConnection;
  providers: RevenueProvider[];
  siteId: string;
  canManage: boolean;
  onChanged: () => void;
}) {
  const [secret, setSecret] = React.useState("");
  const [rotateKey, setRotateKey] = React.useState("");
  const [confirmingDisconnect, setConfirmingDisconnect] = React.useState(false);
  const [replacingKey, setReplacingKey] = React.useState(false);
  const logo = LOGOS[connection.provider];
  const name = nameOf(providers, connection.provider);

  const saveSecret = useAction(async () => {
    await revenue.rotate(siteId, { webhook_secret: secret.trim() });
    setSecret("");
    onChanged();
  });
  const saveKey = useAction(async () => {
    await revenue.rotate(siteId, { api_key: rotateKey.trim() });
    setRotateKey("");
    setReplacingKey(false);
    onChanged();
  });
  const disconnect = useAction(async () => {
    try {
      await revenue.disconnect(siteId);
    } catch (raised) {
      // "Already gone" is the state this button exists to reach, not an
      // error to strand the panel on — the screen can simply be stale
      // (disconnected in another tab, or the server dropped the connection
      // itself). Unlike connect's 404, this one is unambiguous: DELETE is
      // registered on every deployment, so 404 only ever means "no
      // connection". Re-reading below lets the panel catch up.
      if (!(raised instanceof ApiError && raised.status === 404)) {
        throw raised;
      }
    }
    setConfirmingDisconnect(false);
    onChanged();
  });

  const status = STATUS_COPY[connection.status];

  return (
    <div className="flex flex-col gap-5 p-5">
      <div className="flex items-center gap-3">
        <ProviderMark alt="" inset={logo?.inset} src={logo?.src ?? ""} />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">{name}</span>
          <span className="block text-xs text-muted-foreground">
            Key ending {connection.api_key_last4 || "—"}
          </span>
        </span>
        <span className={cn("text-xs font-medium", status.tone)}>
          {status.label}
        </span>
      </div>

      {/* Degraded says when the numbers were last actually correct, from a
          field a failure deliberately does not move. */}
      {connection.status === "degraded" ? (
        <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs leading-5 text-amber-700">
          {connection.last_error ?? "The provider is not answering."} Your
          recorded revenue is still served in full and is correct as of{" "}
          {connection.last_synced_at
            ? new Date(connection.last_synced_at).toLocaleString()
            : "the last successful sync"}
          . Replacing the key below re-checks it.
        </p>
      ) : null}

      {/* Step two, when it is still owed. Not an error state: the connection
          is active and ingesting on the API key alone — what is missing is the
          low-latency path, which is why `last_webhook_at` is still null. */}
      {!connection.webhook_secret_set ? (
        <div className="flex flex-col gap-3 rounded-lg border border-border bg-[#f6f6f6] p-4">
          <div>
            {/* "Optional, recommended" up front, per the connect guide: a
                key-only connection is a working connection with a slower
                path, and a heading that just says "finish" reads as a broken
                half-done state to the customer it interrupted. */}
            <p className="flex items-baseline gap-2 text-sm font-medium">
              Step 2: Finish the webhook
              <span className="text-xs font-normal text-muted-foreground">
                Optional, recommended
              </span>
            </p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              Your revenue is already complete without it: the scheduled sync
              picks up every payment within a few minutes. The webhook only
              shortens that to seconds. Create an endpoint at the address
              below in {name}, then paste its signing secret here.
            </p>
          </div>
          {connection.webhook_url ? (
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-lg border border-border bg-card px-3 py-2 font-mono text-xs">
                {connection.webhook_url}
              </code>
              <CopyButton
                label="Copy webhook address"
                text={connection.webhook_url}
              />
            </div>
          ) : null}
          {/* Stripe's add-endpoint form asks which events to send, and this
              is the only screen open when that question comes up. Select-all
              first because it cannot under-report; the full list follows for
              the customer who subscribes narrowly, complete for the same
              reason the permissions list is: one row short means a payment
              state that silently never updates. */}
          {connection.provider === "stripe" ? (
            <div className="flex flex-col gap-2">
              <p className="text-xs leading-5 text-muted-foreground">
                When {name} asks which events to send, the simplest correct
                answer is <strong className="text-foreground/80">Select
                all events</strong>: anything we do not consume is
                acknowledged and ignored, so a broad subscription costs
                nothing. If the form asks for a payload style, choose{" "}
                <strong className="text-foreground/80">Snapshot</strong>;
                thin payloads are not consumed. If you prefer to subscribe
                narrowly, send exactly these:
              </p>
              <ul className="flex flex-wrap gap-1.5">
                {STRIPE_WEBHOOK_EVENTS.map((event) => (
                  <li key={event}>
                    <code className="rounded-md border border-border bg-card px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                      {event}
                    </code>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {canManage ? (
            <div className="flex items-end gap-2">
              <label className="flex flex-1 flex-col gap-1.5">
                <span className="text-xs font-medium">Signing secret</span>
                <input
                  autoComplete="off"
                  className={inputClass}
                  onChange={(event) => setSecret(event.target.value)}
                  placeholder="whsec_…"
                  spellCheck={false}
                  type="password"
                  value={secret}
                />
              </label>
              <SaveButton
                disabled={secret.trim().length === 0}
                onClick={() => saveSecret.run()}
                size="sm"
                state={saveSecret.busy ? "saving" : "idle"}
              >
                Save
              </SaveButton>
            </div>
          ) : null}
          {saveSecret.error ? (
            <p className="text-xs leading-5 text-destructive-foreground">
              {saveSecret.error.body}
            </p>
          ) : null}
        </div>
      ) : null}

      {connection.webhook_secret_set ? (
        <p className="text-xs leading-5 text-muted-foreground">
          Webhook signing secret stored.{" "}
          {connection.last_webhook_at
            ? `Last delivery ${new Date(connection.last_webhook_at).toLocaleString()}.`
            : "No delivery has arrived yet."}
        </p>
      ) : null}

      {/* One action footer, both doors closed by default. The key input
          used to sit permanently open here, and a permanently open field
          reads as a step: a customer who does not read the label goes and
          mints a fresh key in Stripe to fill it. Rotation is for the one
          who already rotated — behind a button, it stops advertising
          itself. The two reveals share the row and displace each other, so
          only one of them is ever open. */}
      {canManage ? (
        <div className="flex flex-col gap-2 border-t border-border pt-4">
          {replacingKey ? (
            <>
              <div className="flex items-end gap-2">
                <label className="flex flex-1 flex-col gap-1.5">
                  <span className="text-xs font-medium">
                    New restricted key
                  </span>
                  <input
                    autoComplete="off"
                    autoFocus
                    className={inputClass}
                    onChange={(event) => setRotateKey(event.target.value)}
                    placeholder="rk_live_…"
                    spellCheck={false}
                    type="password"
                    value={rotateKey}
                  />
                </label>
                <SaveButton
                  disabled={rotateKey.trim().length === 0}
                  onClick={() => saveKey.run()}
                  size="sm"
                  state={saveKey.busy ? "saving" : "idle"}
                >
                  Replace
                </SaveButton>
                <Button
                  onClick={() => {
                    setReplacingKey(false);
                    setRotateKey("");
                  }}
                  size="sm"
                  variant="ghost"
                >
                  Cancel
                </Button>
              </div>
              <p className="text-xs leading-5 text-muted-foreground">
                Only needed if you rotated the restricted key in {name}. The
                webhook and its signing secret stay untouched.
              </p>
              {saveKey.error ? (
                <p className="text-xs leading-5 text-destructive-foreground">
                  <strong>{saveKey.error.title}</strong> {saveKey.error.body}
                </p>
              ) : null}
            </>
          ) : confirmingDisconnect ? (
            <>
              {/* Three sentences the customer is owed, and all three are
                  consequences they cannot see from the button. */}
              <p className="text-xs leading-5 text-muted-foreground">
                The revenue already recorded stays and keeps showing on your
                dashboard. Nothing new will arrive. Reconnecting later mints a{" "}
                <strong>new</strong> webhook address, which has to be created in{" "}
                {name} again, because the current one stops working.
              </p>
              <div className="flex items-center gap-2">
                <Button
                  onClick={() => disconnect.run()}
                  size="sm"
                  variant="destructive"
                >
                  {disconnect.busy ? "Disconnecting…" : "Yes, disconnect"}
                </Button>
                <Button
                  onClick={() => setConfirmingDisconnect(false)}
                  size="sm"
                  variant="secondary"
                >
                  Keep it
                </Button>
              </div>
            </>
          ) : (
            <div className="flex items-center gap-2">
              <Button
                onClick={() => setReplacingKey(true)}
                size="sm"
                variant="secondary"
              >
                Replace API key
              </Button>
              <Button
                onClick={() => setConfirmingDisconnect(true)}
                size="sm"
                variant="secondary"
              >
                Disconnect {name}
              </Button>
            </div>
          )}
          {disconnect.error ? (
            <p className="text-xs leading-5 text-destructive-foreground">
              {disconnect.error.body}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
