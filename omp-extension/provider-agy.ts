/**
 * Extensão do omp para o provider-agy.
 *
 * - sobe o servidor local automaticamente no início da sessão, se ele ainda
 *   não estiver respondendo;
 * - consulta os eventos de troca de conta e mostra um aviso no omp com a conta
 *   anterior, o motivo, o reset e a situação da conta nova.
 *
 * Instale com `npm run install:omp`. O instalador copia este arquivo para
 * ~/.omp/agent/extensions/ e grava o caminho do projeto em
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
    return { ok: false, error: `servidor não encontrado em ${dir}` };
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
  return { ok: false, error: "o servidor não respondeu em 6s" };
}

function pct(value) {
  if (value == null) return "sem leitura";
  return `${Math.round(value * 100)}% restante`;
}

function when(value) {
  if (!value) return "sem reset informado";
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return value;
  return new Date(ms).toLocaleString("pt-BR");
}

export function formatBlocked(block) {
  if (!block) return null;
  return [
    "🛑 BLOQUEIO DE CONTAS — provider parado",
    `Conta: ${block.email || block.accountId || "?"}`,
    `Motivo: ${block.message || "possível banimento/suspensão"}`,
    `Desde: ${when(block.at)}`,
    "Nenhuma conta será tentada. Resolva a situação com o Google e rode:",
    "npm run accounts -- unblock",
  ].join("\n");
}

export function formatStatus(event) {
  const account = event.account || {};
  return [
    `📊 provider-agy — status da conta (${event.requests} requisições)`,
    `Conta: ${account.email || account.id || "?"}`,
    `Modelo: ${event.model}`,
    `Quota: ${pct(account.remainingFraction)} | reset: ${when(account.resetTime)}`,
    `Requisições nesta conta: ${event.accountRequests ?? "?"}`,
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
      `provider-agy: conta liberada, voltando para ${to.email || to.id || "?"}`,
      `Modelo: ${event.model}`,
      `Quota atual: ${pct(to.remainingFraction)} | reset: ${when(to.resetTime)}`,
    ].join("\n");
  }

  if (event.type !== "switch") return null;

  const from = event.from || {};
  const to = event.to || {};
  const reasons = {
    quota: "quota esgotada",
    invalid: "conta inválida ou token recusado",
    error: "erro temporário na conta",
  };
  const reason = reasons[event.reason] || event.reason || "indisponível";

  return [
    `provider-agy trocou de conta (${event.model})`,
    `Motivo: ${reason}`,
    `De: ${from.email || from.id || "?"} | ${pct(from.remainingFraction)} | reset: ${when(from.resetTime)}`,
    `Para: ${to.email || to.id || "?"} | ${pct(to.remainingFraction)} | reset: ${when(to.resetTime)}`,
  ].join("\n");
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

      // O provider reiniciou: o contador voltou para zero.
      if (Number.isFinite(data.lastSeq) && data.lastSeq < seq) seq = data.lastSeq;

      for (const event of data.data || []) {
        if (Number.isFinite(event.seq)) seq = Math.max(seq, event.seq);
        const text = formatEvent(event);
        if (text && ctx.hasUI) {
          const level =
            event.type === "blocked"
              ? "error"
              : event.type === "status" || event.type === "recovered"
                ? "info"
                : "warning";
          ctx.ui.notify(text, level);
        }
      }
      if (Number.isFinite(data.lastSeq)) seq = Math.max(seq, data.lastSeq);
    } catch {
      // provider parado ou reiniciando; tenta de novo no próximo ciclo
    } finally {
      polling = false;
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    const result = await ensureProvider();
    if (!result.ok) {
      if (ctx.hasUI) {
        ctx.ui.notify(
          `provider-agy não subiu automaticamente: ${result.error}\nRode "npm start" na pasta do provider.`,
          "error"
        );
      }
      return;
    }
    if (result.started && ctx.hasUI) {
      ctx.ui.notify("provider-agy iniciado automaticamente em segundo plano", "info");
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
