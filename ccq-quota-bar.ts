/**
 * Command Code quota bar for pi.
 *
 * Shows Command Code subscription usage (5h / 7d / monthly windows) as a
 * persistent line above the default footer, with colored progress bars,
 * auto-refreshing. Standalone: reads pi's OAuth credentials and calls
 * Command Code's alpha usage endpoints directly; does not depend on
 * pi-commandcode-provider internals.
 *
 * Line shape (example):
 *   usage 5h ▓░░░░░░░░░░░ 9% $1.20/$14 resets in 2h 12m  7d ░░░░░░░░░░░░ 4% $1.34/$35 resets in 5d 20h  mo ░░░░░░░░░░░░ 2% $1.43/$70
 *
 * The monthly cap is not returned by the usage API; it is mapped from the
 * plan (see PLAN_MONTHLY_CAP, official pricing table). When the plan is
 * unrecognized, monthly shows remaining credits only, without a bar.
 *
 * Commands:
 *   /ccq-bar on|off|toggle   show / hide the quota line
 *   /ccq-bar refresh         fetch immediately
 *   /ccq-bar status          print cached state and config
 *
 * Refresh triggers: startup, every 60 s, and after each agent turn settles.
 * On fetch failure the last good data is kept and an error hint is shown;
 * it never interrupts work.
 *
 * Progress bar: ▓ fill, colored by usage: <70% success (green), <90%
 * warning (yellow), >=90% error (red); exhausted (used>=cap) fills solid
 * red. Reset countdown is precise to the minute (resets in Xh Ym / Xd Yh,
 * same wording as the official /usage).
 *
 * Placement: setWidget({ placement: "belowEditor" }), i.e. below the input
 * editor and above the default footer. The default footer (pwd / token /
 * model) is left untouched.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CCQ_API_BASE = "https://api.commandcode.ai";
const REFRESH_INTERVAL_MS = 60_000;
const FETCH_TIMEOUT_MS = 8_000;
const WIDGET_KEY = "ccq-quota-bar";

/**
 * Monthly credit cap per plan (official pricing:
 * commandcode.ai/docs/resources/pricing-limits). The /alpha/billing/credits
 * endpoint only returns remaining credits (monthlyCredits), not the monthly
 * cap, so the denominator comes from here. Unknown plans fall back to
 * remaining-credits-only display (no bar).
 */
const PLAN_MONTHLY_CAP: Record<string, number> = {
  // keys are matched against the subscription planId with includes()
  "individual-go": 10, // Go $1/mo, monthly credits $10
  "individual-goat": 70, // GOAT $10/mo, monthly credits $70
  "individual-pro": 80, // Pro $20/mo, monthly credits $80
  "max-10x": 100,
  "max-20x": 200,
  "team-pro": 40,
};

/**
 * Resolve the monthly cap from a planId. Longest key wins so
 * "individual-goat" is not shadowed by "individual-go".
 */
function monthlyCapForPlan(planId: string | null | undefined): number | undefined {
  if (!planId) return undefined;
  const id = planId.toLowerCase();
  const matches = Object.entries(PLAN_MONTHLY_CAP)
    .filter(([key]) => id.includes(key.toLowerCase()))
    .sort(([a], [b]) => b.length - a.length); // most specific key first
  return matches[0]?.[1] ?? undefined;
}

/** Shape aligned with pi-commandcode-provider's alpha endpoint (fields used only). */
interface CreditsResponse {
  credits?: {
    belowThreshold?: boolean;
    monthlyCredits?: number;
    purchasedCredits?: number;
    freeCredits?: number;
    remainingCredits?: number;
  };
  windowLimits?: {
    limited?: boolean;
    fiveHour?: { used?: number; cap?: number; resetAt?: number | null; exceeded?: boolean | null };
    weekly?: { used?: number; cap?: number; resetAt?: number | null; exceeded?: boolean | null };
  };
}

interface SubscriptionResponse {
  success?: boolean;
  data?: {
    planId?: string | null;
    status?: string | null;
    currentPeriodStart?: string | null;
    currentPeriodEnd?: string | null;
  };
}

interface QuotaState {
  ok: boolean;
  error?: string;
  fetchedAt?: number;
  // monthlyCredits is the *remaining* amount; cap comes from the plan map
  // and may be undefined when the plan is unrecognized.
  monthlyRemaining?: number;
  monthlyCap?: number;
  purchased?: number;
  free?: number;
  fiveHour?: { used: number; cap: number; resetAt: number | null };
  weekly?: { used: number; cap: number; resetAt: number | null };
}

/** Read the OAuth access token pi stores for commandcode (same credential the provider uses). */
function commandCodeAccessToken(): string | undefined {
  const candidates = [
    process.env.COMMAND_CODE_API_KEY,
    join(homedir(), ".pi", "agent", "auth.json"),
    join(homedir(), ".commandcode", "auth.json"),
  ];
  for (const c of candidates) {
    if (!c) continue;
    if (c.startsWith("user_") || c.startsWith("sk-")) return c; // env provided a raw key
    try {
      const auth = JSON.parse(readFileSync(c, "utf8"));
      const cc = auth?.commandcode ?? auth;
      const tok = cc?.access ?? cc?.apiKey ?? cc?.key;
      if (typeof tok === "string" && tok.length > 8) return tok;
    } catch {
      /* file missing or unparsable; try the next candidate */
    }
  }
  return undefined;
}

async function fetchQuota(token: string): Promise<QuotaState> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const headers = { accept: "application/json", Authorization: `Bearer ${token}` };
  try {
    const res = await fetch(`${CCQ_API_BASE}/alpha/billing/credits`, {
      headers,
      signal: controller.signal,
    });
    if (!res.ok) {
      return {
        ok: false,
        error:
          res.status === 401 || res.status === 403
            ? "commandcode credentials rejected (401/403)"
            : `usage endpoint HTTP ${res.status}`,
      };
    }
    const data = (await res.json()) as CreditsResponse;
    const fh = data.windowLimits?.fiveHour;
    const wk = data.windowLimits?.weekly;
    const monthlyRemaining = data.credits?.monthlyCredits;
    // Fetch the subscription to get the planId for the monthly cap map.
    // Failure here does not break the main data (degrades to no monthly bar).
    let monthlyCap: number | undefined;
    try {
      const subRes = await fetch(`${CCQ_API_BASE}/alpha/billing/subscriptions`, {
        headers,
        signal: controller.signal,
      });
      if (subRes.ok) {
        const sub = (await subRes.json()) as SubscriptionResponse;
        monthlyCap = monthlyCapForPlan(sub.data?.planId ?? null);
      }
    } catch {
      monthlyCap = undefined;
    }
    return {
      ok: true,
      fetchedAt: Date.now(),
      monthlyRemaining,
      monthlyCap,
      purchased: data.credits?.purchasedCredits,
      free: data.credits?.freeCredits,
      fiveHour:
        fh && typeof fh.cap === "number"
          ? { used: fh.used ?? 0, cap: fh.cap, resetAt: fh.resetAt ?? null }
          : undefined,
      weekly:
        wk && typeof wk.cap === "number"
          ? { used: wk.used ?? 0, cap: wk.cap, resetAt: wk.resetAt ?? null }
          : undefined,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/** Compact dollar formatting; whole numbers drop decimals ($14, not $14.0). */
function fmtDollar(n: number | undefined): string {
  if (n === undefined) return "–";
  if (n >= 100) return `$${n.toFixed(0)}`;
  if (n >= 10) return `$${Number.isInteger(n) ? n.toFixed(0) : n.toFixed(1)}`;
  return `$${n.toFixed(2)}`;
}

/** Reset countdown, precise to the minute (same wording as official /usage). Under 24h: Xh Ym; over: Xd Yh. */
function fmtReset(resetAt: number | null): string {
  if (!resetAt) return "";
  const diffMs = resetAt - Date.now();
  if (diffMs <= 0) return "resets soon";
  const totalMinutes = Math.ceil(diffMs / 60_000);
  if (totalMinutes < 24 * 60) {
    const h = Math.floor(totalMinutes / 60);
    const m = totalMinutes % 60;
    if (h <= 0) return `resets in ${m}m`;
    if (m === 0) return `resets in ${h}h`;
    return `resets in ${h}h ${m}m`;
  }
  const days = Math.floor(totalMinutes / (24 * 60));
  const remHours = Math.round((totalMinutes % (24 * 60)) / 60);
  if (remHours === 24) return `resets in ${days + 1}d`;
  if (remHours === 0) return `resets in ${days}d`;
  return `resets in ${days}d ${remHours}h`;
}

/**
 * Draw a fixed-width progress bar.
 * @param width bar width in characters
 */
function bar(theme: { fg(name: string, text: string): string }, used: number, cap: number, width: number): string {
  const pct = cap > 0 ? used / cap : 0;
  const filled = Math.min(width, Math.round(pct * width));
  const exhausted = cap > 0 && used >= cap;
  const color = exhausted || pct >= 0.9 ? "error" : pct >= 0.7 ? "warning" : "success";
  const fill = theme.fg(color, "▓".repeat(exhausted ? width : filled));
  const rest = "░".repeat(width - (exhausted ? width : filled));
  const pctStr = `${(pct * 100).toFixed(0)}%`;
  return `${fill}${rest} ${pctStr}`;
}

interface WidgetTheme {
  fg(name: string, text: string): string;
}

function buildLine(state: QuotaState, theme: WidgetTheme): string {
  const dim = (s: string) => theme.fg("dim", s);
  const label = theme.fg("text", "usage");
  if (!state.ok) {
    const why = state.error ? ` (${state.error})` : "";
    return `${label} ${dim(`fetch failed${why} — run /ccq-bar refresh to retry`)}`;
  }
  const parts: string[] = [label];
  const fh = state.fiveHour;
  const wk = state.weekly;
  if (fh) {
    parts.push(
      `${dim("5h")} ${bar(theme, fh.used, fh.cap, 12)} ${dim(`${fmtDollar(fh.used)}/${fmtDollar(fh.cap)}${fh.resetAt ? " " + fmtReset(fh.resetAt) : ""}`)}`,
    );
  }
  if (wk) {
    parts.push(
      `${dim("7d")} ${bar(theme, wk.used, wk.cap, 12)} ${dim(`${fmtDollar(wk.used)}/${fmtDollar(wk.cap)}${wk.resetAt ? " " + fmtReset(wk.resetAt) : ""}`)}`,
    );
  }
  // Monthly: draw a bar when the cap is known (mapped from plan); otherwise
  // show remaining credits only.
  if (state.monthlyCap !== undefined && state.monthlyRemaining !== undefined) {
    const used = Math.max(0, state.monthlyCap - state.monthlyRemaining);
    parts.push(
      `${dim("mo")} ${bar(theme, used, state.monthlyCap, 12)} ${dim(`${fmtDollar(used)}/${fmtDollar(state.monthlyCap)} left ${fmtDollar(state.monthlyRemaining)}`)}`,
    );
  } else if (state.monthlyRemaining !== undefined) {
    parts.push(`${dim("mo")} ${dim(`left ${fmtDollar(state.monthlyRemaining)}`)}`);
  }
  if (state.fetchedAt) {
    const t = new Date(state.fetchedAt);
    const hh = String(t.getHours()).padStart(2, "0");
    const mm = String(t.getMinutes()).padStart(2, "0");
    parts.push(dim(`${hh}:${mm}`));
  }
  return parts.join("  ");
}

interface CtxLike {
  ui?: {
    setWidget(
      key: string,
      content:
        | string[]
        | ((tui: unknown, theme: { fg(name: string, text: string): string }) => { render(): string[]; invalidate(): void })
        | undefined,
      options?: { placement: "aboveEditor" | "belowEditor" },
    ): void;
    notify(message: string, type?: "info" | "warning" | "error"): void;
  };
  mode?: string;
}

interface PiLike {
  on(event: string, handler: (_event: unknown, ctx: CtxLike) => void | Promise<void>): void;
  registerCommand(
    name: string,
    opts: {
      description: string;
      handler: (_args: string, ctx: CtxLike) => void | Promise<void>;
    },
  ): void;
  getSessionName?(): string;
}

export default function (pi: PiLike): void {
  let state: QuotaState = { ok: false, error: "not fetched yet" };
  let enabled = true;
  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight: Promise<void> | null = null;
  // TUI handle held by the current widget; used to request a repaint after
  // a refresh so new data reaches the screen.
  let tuiRef: { requestRender(force?: boolean): void } | null = null;

  function renderNow(): void {
    if (tuiRef) tuiRef.requestRender();
  }

  async function refresh(): Promise<void> {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const token = commandCodeAccessToken();
      if (!token) {
        state = { ok: false, error: "commandcode credentials not found (run /login?)" };
        return;
      }
      const next = await fetchQuota(token);
      // On failure keep the last good data and only update the error hint.
      if (!next.ok && state.ok && state.fetchedAt) {
        state = { ...state, error: next.error };
      } else {
        state = next;
      }
    })()
      .catch((err) => {
        state = { ok: false, error: err instanceof Error ? err.message : String(err) };
      })
      .finally(() => {
        inFlight = null;
        renderNow();
      });
    return inFlight;
  }

  function updateWidget(ctx: CtxLike): void {
    if (!ctx?.ui?.setWidget) return;
    if (!enabled) {
      ctx.ui.setWidget(WIDGET_KEY, undefined, { placement: "belowEditor" });
      return;
    }
    ctx.ui.setWidget(
      WIDGET_KEY,
      (_tui, theme) => {
        tuiRef = _tui as { requestRender(force?: boolean): void };
        return {
          render: () => [buildLine(state, theme as { fg(name: string, text: string): string })],
          invalidate: () => {},
        };
      },
      { placement: "belowEditor" },
    );
    renderNow(); // make the first content appear immediately
    void refresh();
  }

  // Interval refresh only needs to trigger a repaint; the token is read per fetch.
  function startTimer(): void {
    if (timer) clearInterval(timer);
    timer = setInterval(() => {
      void refresh();
    }, REFRESH_INTERVAL_MS);
  }

  pi.registerCommand("ccq-bar", {
    description: "Command Code usage line: on|off|toggle|refresh|status",
    handler: async (args, ctx) => {
      const cmd = (args || "").trim().split(/\s+/)[0] || "status";
      if (cmd === "on") {
        enabled = true;
        updateWidget(ctx);
        startTimer();
        ctx.ui?.notify?.("Command Code usage line enabled", "info");
      } else if (cmd === "off") {
        enabled = false;
        if (timer) clearInterval(timer);
        timer = null;
        ctx.ui?.setWidget?.(WIDGET_KEY, undefined, { placement: "belowEditor" });
        ctx.ui?.notify?.("Command Code usage line disabled", "info");
      } else if (cmd === "toggle") {
        if (enabled) {
          enabled = false;
          if (timer) clearInterval(timer);
          timer = null;
          ctx.ui?.setWidget?.(WIDGET_KEY, undefined, { placement: "belowEditor" });
          ctx.ui?.notify?.("Command Code usage line disabled", "info");
        } else {
          enabled = true;
          updateWidget(ctx);
          startTimer();
          ctx.ui?.notify?.("Command Code usage line enabled", "info");
        }
      } else if (cmd === "refresh") {
        await refresh();
        renderNow();
        ctx.ui?.notify?.(
          state.ok ? "Command Code usage refreshed" : `Command Code usage refresh failed: ${state.error}`,
          state.ok ? "info" : "error",
        );
      } else {
        // status
        const cred = commandCodeAccessToken() ? "found" : "missing";
        const lines = [
          "Command Code usage line",
          `  enabled: ${enabled ? "yes" : "no"}`,
          `  credentials: ${cred}`,
          `  last fetch: ${state.ok ? (state.fetchedAt ? new Date(state.fetchedAt).toLocaleTimeString() : "none") : "none"}`,
          `  state: ${state.ok
            ? state.fetchedAt
              ? (() => {
                  const fh = state.fiveHour ? `${fmtDollar(state.fiveHour.used)}/${fmtDollar(state.fiveHour.cap)}` : "–";
                  const wk = state.weekly ? `${fmtDollar(state.weekly.used)}/${fmtDollar(state.weekly.cap)}` : "–";
                  const mo =
                    state.monthlyCap !== undefined && state.monthlyRemaining !== undefined
                      ? `${fmtDollar(Math.max(0, state.monthlyCap - state.monthlyRemaining))}/${fmtDollar(state.monthlyCap)} (${fmtDollar(state.monthlyRemaining)} left)`
                      : state.monthlyRemaining !== undefined
                        ? `${fmtDollar(state.monthlyRemaining)} left (plan cap not mapped)`
                        : "–";
                  return `5h ${fh} · 7d ${wk} · mo ${mo}`;
                })()
              : "waiting for first fetch"
            : `failed: ${state.error ?? ""}`}`,
          "  usage: /ccq-bar on|off|toggle|refresh|status",
        ];
        ctx.ui?.notify?.(lines.join("\n"), "info");
      }
    },
  });

  pi.on("session_start", (_event, ctx) => {
    updateWidget(ctx);
    startTimer();
  });

  // Refresh after each agent turn settles so usage stays close to live.
  pi.on("agent_settled", (_event, _ctx) => {
    if (!enabled) return;
    void refresh();
  });

  pi.on("session_shutdown", () => {
    if (timer) clearInterval(timer);
    timer = null;
  });
}
