#!/usr/bin/env node
'use strict';

const accounts = require('../lib/accounts');

function fmtPct(value) {
  if (value == null) return '?';
  return `${Math.round(value * 100)}%`;
}

function fmtReset(value) {
  if (!value) return '-';
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return value;
  return new Date(ms).toLocaleString('pt-BR');
}

function quotaSummary(account) {
  const parts = [];
  for (const model of accounts.SUPPORTED_MODELS) {
    const q = account.quota?.[model];
    if (!q) continue;
    const label = model.replace('gemini-3.8-flash-', 'flash-').replace('claude-', '');
    if (q.remainingFraction != null) {
      parts.push(`${label}=${fmtPct(q.remainingFraction)}`);
    } else if (q.resetTime) {
      parts.push(`${label}=0% (reset ${fmtReset(q.resetTime)})`);
    }
  }
  return parts.join(' ');
}

function printList() {
  const list = accounts.publicList();
  if (!list.length) {
    console.log('Nenhuma conta no cofre. Rode: npm run accounts -- add');
    return;
  }
  console.log(`Contas no cofre (${list.length}):`);
  list.forEach((a, i) => {
    const active = a.active ? '*' : ' ';
    const invalid = a.invalid ? ' [inválida]' : '';
    console.log(`${active} ${i + 1}. ${a.email || a.id}${invalid}`);
    console.log(`     projeto: ${a.project}`);
    if (a.lastError) console.log(`     erro: ${a.lastError}`);
    const summary = quotaSummary(a);
    if (summary) console.log(`     quota: ${summary}`);
  });
  console.log('\n* = conta ativa no provider');
}

async function cmdAdd(label) {
  const account = accounts.importFromKeyring(label);
  console.log(`Importada: ${account.email || account.id}`);
  try {
    await accounts.refreshAccountMeta(account);
    console.log(`Projeto: ${account.project}`);
    const summary = quotaSummary(account);
    if (summary) console.log(`Quota: ${summary}`);
  } catch (err) {
    console.log(`Aviso: não foi possível consultar projeto/quota agora (${err.message})`);
  }
  console.log('O token anterior não foi removido do cofre.');
}

async function cmdUse(query) {
  const account = accounts.findAccount(query);
  if (!account) throw new Error(`conta não encontrada: ${query}`);
  accounts.writeAccountToKeyring(account);
  console.log(`agy agora usa: ${account.email || account.id}`);
  console.log('O provider continua com todas as contas no cofre.');
}

async function cmdQuota() {
  const list = accounts.listAccounts();
  if (!list.length) {
    console.log('Nenhuma conta no cofre. Rode: npm run accounts -- add');
    return;
  }
  for (const account of list) {
    console.log(`\n=== ${account.email || account.id} (${account.project || accounts.DEFAULT_PROJECT})`);
    try {
      await accounts.refreshAccountMeta(account);
      for (const model of accounts.SUPPORTED_MODELS) {
        const q = account.quota?.[model];
        if (!q) {
          console.log(`${model}: sem informação`);
          continue;
        }
        if (q.remainingFraction != null) {
          console.log(`${model}: ${fmtPct(q.remainingFraction)} restante, reset ${fmtReset(q.resetTime)}`);
        } else {
          console.log(`${model}: 0% restante, reset ${fmtReset(q.resetTime)}`);
        }
      }
    } catch (err) {
      console.log(`erro: ${err.message}`);
    }
  }
}

function cmdRemove(query) {
  const account = accounts.removeAccount(query);
  console.log(`Removida do cofre: ${account.email || account.id} (o keyring não foi alterado)`);
}

function cmdLogin() {
  console.log(`Fluxo para adicionar outra conta sem perder as atuais:

1. Salve a conta que está logada agora:
   npm run accounts -- add

2. No agy, entre na outra conta (por exemplo com /login na TUI ou agy acp --login).

3. Importe a nova conta para o cofre:
   npm run accounts -- add

4. Veja as contas e quotas:
   npm run accounts -- list
   npm run accounts -- quota

5. Para o agy abrir com uma conta específica:
   npm run accounts -- use <email-ou-índice>

O provider usa o cofre inteiro e troca de conta sozinho quando a quota de
uma acaba. O keyring do agy só muda quando você roda "use".`);
}

(async () => {
  const [cmd = 'list', ...rest] = process.argv.slice(2);
  try {
    if (cmd === 'add') return await cmdAdd(rest[0]);
    if (cmd === 'use') return await cmdUse(rest[0]);
    if (cmd === 'remove' || cmd === 'rm') return cmdRemove(rest[0]);
    if (cmd === 'quota') return await cmdQuota();
    if (cmd === 'login') return cmdLogin();
    if (cmd === 'list' || cmd === 'ls') {
      await accounts.bootstrap();
      return printList();
    }
    if (cmd === 'help' || cmd === '--help' || cmd === '-h') return cmdLogin();

    console.error(`comando desconhecido: ${cmd}`);
    cmdLogin();
    process.exitCode = 1;
  } catch (err) {
    console.error(`erro: ${err.message}`);
    process.exitCode = 1;
  }
})();
