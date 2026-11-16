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

async function isUp() {
  try {
    const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1200) });
    return res.ok;
  } catch {
    return false;
  }
}

async function ensureProvider() {
  if (await isUp()) return { ok: true, started: false };

  const dir = providerDir();
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
    await new Promise((resolve) => setTimeout(resolve, 200));
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
  if (event.type === "status") {
    const remaining = event.account?.remainingFraction;
    return remaining != null && remaining <= 0.2 ? "warning" : "info";
  }
  if (event.type === "recovered") return "info";
  return "warning";
}

export default function providerAgy(pi) {
  let timer = null;
  let polling = false;
  let seq = -1;

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
