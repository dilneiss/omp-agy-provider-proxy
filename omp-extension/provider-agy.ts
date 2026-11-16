/**
 * omp extension for provider-agy.
 *
 * - starts the local provider at the beginning of a session when it is not
 *   responding yet;
 * - polls account switch events and shows the previous account, reason, reset
 *   time, token usage, and new account status in the omp UI.
 *
 * Install with `npm run install:omp`. The installer copies this file to
 * ~/.omp/agent/extensions/ and records the project path in
 * ~/.provider-agy/config.json.
 */

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = (process.env.AGY_PROVIDER_URL || "http://127.0.0.1:8788").replace(/\/+$/, "");
const STATE_DIR = process.env.AGY_STATE_DIR || path.join(os.homedir(), ".provider-agy");
const POLL_MS = 2000;
const RULE = "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━";

function providerDir() {
  if (process.env.AGY_PROVIDER_DIR) return process.env.AGY_PROVIDER_DIR;
  try {
    const config = JSON.parse(fs.readFileSync(path.join(STATE_DIR, "config.json"), "utf8"));
    if (config.providerDir) return config.providerDir;
  } catch {}
  return path.resolve(HERE, "..");
}

function delay(ms) {
  const { promise, resolve } = Promise.withResolvers();
  setTimeout(resolve, ms);
  return promise;
}

async function isUp() {
  try {
    const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1200) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Same derivation as the provider: sha256(server.js + lib/accounts.js)[0..12]. */
function localBuild(dir) {
  try {
    const hash = crypto.createHash("sha256");
    hash.update(fs.readFileSync(path.join(dir, "server.js")));
    hash.update(fs.readFileSync(path.join(dir, "lib", "accounts.js")));
    return hash.digest("hex").slice(0, 12);
  } catch {
    return "unknown";
  }
}

async function runningBuild() {
  try {
    const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1200) });
    if (!res.ok) return null;
    const data = await res.json();
    return typeof data.build === "string" ? data.build : null;
  } catch {
    return null;
  }
}

async function shutdownProvider() {
  try {
    await fetch(`${BASE}/v1/shutdown`, { method: "POST", signal: AbortSignal.timeout(1500) });
  } catch {}
  for (let i = 0; i < 25; i++) {
    await delay(200);
    if (!(await isUp())) return true;
  }
  return !(await isUp());
}

/**
 * True when the provider answering on the port was started from different
 * files than the ones on disk. A provider that reports no build at all predates
 * this handshake, so it counts as stale too. An unreadable local build is not a
 * reason to stop anything.
 */
export function providerNeedsRestart(actual, expected) {
  if (!expected || expected === "unknown") return false;
  return actual !== expected;
}

async function ensureProvider() {
  const dir = providerDir();
  const expected = localBuild(dir);

  if (await isUp()) {
    const actual = await runningBuild();
    if (!providerNeedsRestart(actual, expected)) {
      return { ok: true, started: false };
    }
    await shutdownProvider();
    if (await isUp()) {
      return {
        ok: false,
        started: false,
        stale: true,
        error:
          "a provider started from older code is still running and did not stop on its own; " +
          "stop the node process on the provider port and restart omp",
      };
    }
  }

  if (!fs.existsSync(path.join(dir, "server.js"))) {
    return { ok: false, error: `server not found in ${dir}` };
  }

  const child = spawn(process.env.AGY_NODE || "node", ["server.js"], {
    cwd: dir,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: process.env,
  });
  child.unref();

  for (let i = 0; i < 30; i++) {
    await delay(200);
    if (await isUp()) return { ok: true, started: true };
  }
  return { ok: false, error: "the server did not respond within 6s" };
}

function pct(value) {
  if (value == null) return "no reading";
  return `${Math.round(value * 100)}% remaining`;
}

function pctShare(value) {
  if (value == null || !Number.isFinite(value)) return "?";
  return `${value.toFixed(1)}%`;
}

function number(value) {
  if (!Number.isFinite(value)) return "?";
  return Math.round(value).toLocaleString("en-US");
}

function compact(value) {
  if (!Number.isFinite(value)) return "?";
  if (value >= 1_000_000) {
    const scaled = value / 1_000_000;
    return `${scaled >= 10 ? Math.round(scaled) : scaled.toFixed(1)}M`;
  }
  if (value >= 1_000) {
    const scaled = value / 1_000;
    return `${scaled >= 100 ? Math.round(scaled) : scaled.toFixed(1)}K`;
  }
  return String(Math.round(value));
}

function quotaCircle(value) {
  if (value == null) return "⚪";
  if (value <= 0) return "🔴";
  if (value < 0.5) return "🟡";
  return "🟢";
}

function quotaBar(value, width = 10) {
  const fraction = value == null ? 0 : Math.max(0, Math.min(1, value));
  const filled = Math.round(fraction * width);
  return `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
}

function when(value) {
  if (!value) return "no reset information";
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return value;
  const date = new Date(ms);
  const now = new Date();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  const year = date.getFullYear() === now.getFullYear() ? "" : `/${date.getFullYear()}`;
  return `${month}/${day}${year} ${hour}:${minute}`;
}

function resetInfo(value) {
  if (!value) return "no reset information";
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return value;
  const diff = ms - Date.now();
  let relative = "expired";
  if (diff > 0) {
    const minutes = Math.ceil(diff / 60000);
    if (minutes < 60) relative = `in ${minutes}min`;
    else {
      const hours = Math.floor(minutes / 60);
      if (hours < 24) {
        const rest = minutes % 60;
        relative = `in ${hours}h${rest ? ` ${rest}min` : ""}`;
      } else {
        const days = Math.floor(hours / 24);
        const rest = hours % 24;
        relative = `in ${days}d${rest ? ` ${rest}h` : ""}`;
      }
    }
  }
  return `${when(value)} (${relative})`;
}

function accountName(account) {
  return account?.email || account?.id || "?";
}

function truncate(value, length = 160) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

function quotaLine(account) {
  const value = account?.remainingFraction;
  return `${quotaCircle(value)} ${pct(value)}  ${quotaBar(value)}`;
}

function modelUsageLines(event) {
  const list = Array.isArray(event.accounts) ? event.accounts : [];
  if (!list.length) return [];
  const lines = ["📉 USAGE ON THIS MODEL"];
  for (const account of list) {
    const value = account.remainingFraction;
    const percent = value == null ? "    ?" : `${String(Math.round(value * 100)).padStart(4)}%`;
    const details = [];
    if (account.resetTime) details.push(`reset ${when(account.resetTime)}`);
    if (account.cooldownUntil) details.push(`parked until ${when(account.cooldownUntil)}`);
    if (account.invalid) details.push("invalid");
    const suffix = details.length ? ` · ${details.join(" · ")}` : "";
    lines.push(`${quotaCircle(value)} ${percent}  ${accountName(account)}${suffix}`);
  }
  return lines;
}

function usageLines(event) {
  const window = event.window;
  if (!window || !window.hasUsage) {
    return ["🧠 Tokens    no usage reported in this window"];
  }

  const total = window.totalTokens || 0;
  const prompt = window.promptTokens || 0;
  const completion = window.completionTokens || 0;
  const inputShare = total ? (prompt / total) * 100 : null;
  const outputShare = total ? (completion / total) * 100 : null;
  const average = window.averageTotalTokens || 0;
  const last = window.last || {};
  const context = last.contextWindow || event.contextWindow;
  const lastPromptPct =
    context && last.promptTokens ? (last.promptTokens / context) * 100 : null;

  const lines = [
    `🧠 Tokens    ${number(total)} total this window`,
    `   📥 Input ${number(prompt)} (${pctShare(inputShare)}) · 📤 Output ${number(completion)} (${pctShare(outputShare)})`,
    `   📈 Average ${number(average)}/request`,
  ];
  if (lastPromptPct != null) {
    lines.push(
      `   🧮 Last prompt ${number(last.promptTokens)} · ${pctShare(lastPromptPct)} of ${compact(
        context
      )} context`
    );
  }
  if (window.thoughtTokens) {
    lines.push(`   💭 Thinking ${number(window.thoughtTokens)}`);
  }
  if (window.cachedTokens) {
    lines.push(`   ♻️ Cached ${number(window.cachedTokens)}`);
  }
  return lines;
}

export function formatBlocked(block) {
  if (!block) return null;
  return [
    "🚨 ACCOUNT BLOCK · ALL ATTEMPTS STOPPED",
    RULE,
    `👤 Account   ${block.email || block.accountId || "?"}`,
    `🛑 Reason    ${truncate(block.message || "possible ban/suspension", 220)}`,
    `🕒 Since     ${when(block.at)}`,
    "⚠️ Action    no accounts will be tried",
    "🔓 Fix       resolve it with Google, then run:",
    "   npm run accounts -- unblock",
    RULE,
  ].join("\n");
}

export function formatStatus(event) {
  const account = event.account || {};
  const requests = event.window?.requests ?? event.interval ?? "?";
  return [
    "📊 PROVIDER-AGY · ACCOUNT PULSE",
    RULE,
    `👤 Account   ${accountName(account)}`,
    `🤖 Model     ${event.model}`,
    `🎯 Quota     ${quotaLine(account)}`,
    `⏳ Reset     ${resetInfo(account.resetTime)}`,
    `📨 Requests  ${requests} this window · ${event.accountRequests ?? "?"} on account`,
    ...usageLines(event),
    RULE,
  ].join("\n");
}

export function formatEvent(event) {
  if (event.type === "status") return formatStatus(event);

  if (event.type === "blocked") {
    return formatBlocked(
      event.blocked || {
        email: event.account?.email,
        accountId: event.account?.id,
        message: event.message,
        at: event.at,
      }
    );
  }

  if (event.type === "paused") {
    const pause = event.pause || {};
    const lines = [
      "⏸️ PROVIDER PAUSED · ALL ACCOUNTS OUT OF QUOTA",
      RULE,
      `🤖 Model     ${event.model}`,
      `🛑 Reason    every account in the vault is exhausted`,
      `⏳ Resume    ${resetInfo(pause.nextResetAt)}`,
      "🚫 Requests  rejected until the first account resets",
    ];
    const usage = modelUsageLines(event);
    if (usage.length) lines.push(RULE, ...usage);
    lines.push(RULE);
    return lines.join("\n");
  }

  if (event.type === "usage") {
    const reasons = {
      "rate-limited": "every account answered 429 while quota still shows availability",
      "all-failed": "no account could answer this request",
    };
    const lines = [
      "📉 MODEL QUOTA · ALL ACCOUNTS FAILED",
      RULE,
      `🤖 Model     ${event.model}`,
      `📌 Reason    ${reasons[event.reason] || event.reason || "all accounts failed"}`,
    ];
    if (event.message) lines.push(`📝 Detail    ${truncate(event.message, 200)}`);
    const usage = modelUsageLines(event);
    if (usage.length) lines.push(RULE, ...usage);
    lines.push(RULE);
    return lines.join("\n");
  }

  if (event.type === "resumed") {
    const account = event.account || {};
    return [
      "▶️ PROVIDER RESUMED",
      RULE,
      `👤 Account   ${accountName(account)}`,
      `🤖 Model     ${event.model}`,
      `🎯 Quota     ${quotaLine(account)}`,
      `⏳ Reset     ${resetInfo(account.resetTime)}`,
      "✅ Requests  accepted again",
      RULE,
    ].join("\n");
  }

  if (event.type === "recovered") {
    const to = event.to || {};
    return [
      "✅ ACCOUNT RECOVERED",
      RULE,
      `🎉 Active    ${accountName(to)}`,
      `🤖 Model     ${event.model}`,
      `🎯 Quota     ${quotaLine(to)}`,
      `⏳ Reset     ${resetInfo(to.resetTime)}`,
      RULE,
    ].join("\n");
  }

  if (event.type !== "switch") return null;

  const from = event.from || {};
  const to = event.to || {};
  const reasons = {
    quota: "quota exhausted",
    invalid: "invalid account or rejected token",
    error: "temporary account error",
    "rate-limited": "429 without quota evidence (shared project throttle)",
  };
  const reason = reasons[event.reason] || event.reason || "unavailable";
  const lines = [
    "🔄 ACCOUNT SWITCH",
    RULE,
    `🤖 Model     ${event.model}`,
    `📌 Reason    ${reason}`,
    `⬅️ From      ${accountName(from)}`,
    `   ${quotaLine(from)} · reset ${resetInfo(from.resetTime)}`,
    `➡️ To        ${accountName(to)}`,
    `   ${quotaLine(to)} · reset ${resetInfo(to.resetTime)}`,
  ];
  if (event.message) lines.push(`📝 Detail    ${truncate(event.message)}`);
  lines.push(RULE);
  return lines.join("\n");
}

function levelFor(event) {
  if (event.type === "blocked") return "error";
  if (event.type === "paused") return "warning";
  if (event.type === "usage") return "warning";
  if (event.type === "resumed") return "info";
  if (event.type === "status") {
    const remaining = event.account?.remainingFraction;
    return remaining != null && remaining <= 0.2 ? "warning" : "info";
  }
  if (event.type === "recovered") return "info";
  return "warning";
}

/**
 * True when the session sits at or above the provider's compaction threshold.
 * Kept pure so the trigger can be tested without an omp session.
 */
export function shouldCompact(tokens, budget) {
  if (!budget || !Number.isFinite(budget.maxInputTokens) || budget.maxInputTokens <= 0) return false;
  if (!Number.isFinite(tokens) || tokens <= 0) return false;
  const percent = Number.isFinite(budget.compactAtPercent) ? budget.compactAtPercent : 80;
  return tokens >= budget.maxInputTokens * (percent / 100);
}

export default function providerAgy(pi) {
  let timer = null;
  let polling = false;
  let seq = -1;

  // Auto-compaction. The provider enforces a budget much smaller than the
  // model's advertised window, so the client's own accounting never reaches
  // its threshold. Ask the provider for the real budget and compact the
  // session once it is this close.
  let limits = null;
  let limitsAt = 0;
  let compacting = false;
  let lastCompactAt = 0;

  async function providerLimits() {
    if (limits && Date.now() - limitsAt < 60_000) return limits;
    try {
      const res = await fetch(`${BASE}/v1/limits`, { signal: AbortSignal.timeout(1500) });
      if (!res.ok) return limits;
      const data = await res.json();
      if (Number.isFinite(data.maxInputTokens) && data.maxInputTokens > 0) {
        limits = {
          maxInputTokens: data.maxInputTokens,
          compactAtPercent: Number.isFinite(data.compactAtPercent) ? data.compactAtPercent : 80,
        };
        limitsAt = Date.now();
      }
    } catch {}
    return limits;
  }

  async function maybeCompact(ctx) {
    if (compacting) return;
    // A compaction leaves the session idle for a while; do not stack them.
    if (lastCompactAt && Date.now() - lastCompactAt < 60_000) return;

    const budget = await providerLimits();
    if (!budget) return;

    const usage = typeof ctx.getContextUsage === "function" ? ctx.getContextUsage() : null;
    const tokens = Number(usage?.tokens);
    if (!Number.isFinite(tokens) || tokens <= 0) return;

    if (!shouldCompact(tokens, budget)) return;

    compacting = true;
    lastCompactAt = Date.now();
    const percent = Math.round((tokens / budget.maxInputTokens) * 100);
    try {
      if (ctx.hasUI) {
        ctx.ui.notify(
          `Provider context at ${percent}% of ${budget.maxInputTokens} tokens (threshold ${budget.compactAtPercent}%); compacting automatically`,
          "warning"
        );
      }
      await ctx.compact();
    } catch (err) {
      if (ctx.hasUI) {
        ctx.ui.notify(`Automatic compaction failed: ${err?.message ?? err}`, "error");
      }
    } finally {
      compacting = false;
    }
  }

  async function notifyBlockedState(ctx) {
    if (!ctx.hasUI) return;
    try {
      const res = await fetch(`${BASE}/v1/accounts`, { signal: AbortSignal.timeout(1500) });
      if (!res.ok) return;
      const data = await res.json();
      const text = formatBlocked(data.blocked);
      if (text) ctx.ui.notify(text, "error");
    } catch {}
  }

  async function initCursor() {
    try {
      const res = await fetch(`${BASE}/v1/accounts/events?since=-1`, {
        signal: AbortSignal.timeout(1500),
      });
      if (!res.ok) return;
      const data = await res.json();
      seq = Number.isFinite(data.lastSeq) ? data.lastSeq : 0;
    } catch {}
  }

  async function poll(ctx) {
    if (polling || seq < 0) return;
    polling = true;
    try {
      const res = await fetch(`${BASE}/v1/accounts/events?since=${seq}`, {
        signal: AbortSignal.timeout(1500),
      });
      if (!res.ok) return;
      const data = await res.json();

      // The provider restarted: its event counter is back at zero.
      if (Number.isFinite(data.lastSeq) && data.lastSeq < seq) seq = data.lastSeq;

      for (const event of data.data || []) {
        if (Number.isFinite(event.seq)) seq = Math.max(seq, event.seq);
        const text = formatEvent(event);
        if (text && ctx.hasUI) ctx.ui.notify(text, levelFor(event));
      }
      if (Number.isFinite(data.lastSeq)) seq = Math.max(seq, data.lastSeq);
    } catch {
      // Provider stopped or restarting; retry on the next poll.
    } finally {
      polling = false;
    }
  }

  // Compaction cannot run mid-turn, so the check happens once the turn ends.
  pi.on("turn_end", async (_event, ctx) => {
    await maybeCompact(ctx);
  });

  pi.on("session_start", async (_event, ctx) => {
    const result = await ensureProvider();
    if (!result.ok) {
      if (ctx.hasUI) {
        ctx.ui.notify(
          `provider-agy did not start automatically: ${result.error}\nRun "npm run install:omp" and restart omp.`,
          "error"
        );
      }
      return;
    }
    if (result.started && ctx.hasUI) {
      ctx.ui.notify("provider-agy started automatically in the background", "info");
    }
    await initCursor();
    await notifyBlockedState(ctx);
    timer = setInterval(() => poll(ctx), POLL_MS);
  });

  pi.on("session_shutdown", () => {
    if (timer) clearInterval(timer);
    timer = null;
  });
}
