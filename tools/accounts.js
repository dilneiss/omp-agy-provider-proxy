#!/usr/bin/env node
'use strict';

const accounts = require('../lib/accounts');

const COLOR =
  !process.env.NO_COLOR &&
  (process.env.FORCE_COLOR === '1' || Boolean(process.stdout.isTTY));

function paint(code, text) {
  return COLOR ? `\x1b[${code}m${text}\x1b[0m` : text;
}

const style = {
  bold: (text) => paint('1', text),
  dim: (text) => paint('2', text),
  gray: (text) => paint('90', text),
  red: (text) => paint('31', text),
  green: (text) => paint('32', text),
  yellow: (text) => paint('33', text),
  cyan: (text) => paint('36', text),
};

const MODEL_LABELS = {
  'gemini-3.8-flash-high': 'Gemini 3.8 Flash · High',
  'gemini-3.8-flash-medium': 'Gemini 3.8 Flash · Medium',
  'gemini-3.8-flash-low': 'Gemini 3.8 Flash · Low',
  'claude-sonnet-4-6': 'Claude Sonnet 4.6',
  'claude-opus-4-6-thinking': 'Claude Opus 4.6 · Thinking',
  'gpt-oss-120b-medium': 'GPT-OSS 120B · Medium',
};

function fmtPct(value) {
  if (value == null) return '?';
  return `${Math.round(value * 100)}%`;
}

function fmtReset(value) {
  if (!value) return '-';
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return value;
  return new Date(ms).toLocaleString('en-US');
}

function fmtResetShort(value) {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return value || '-';
  const date = new Date(ms);
  const now = new Date();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  const year = date.getFullYear() === now.getFullYear() ? '' : `/${date.getFullYear()}`;
  return `${month}/${day}${year} ${hour}:${minute}`;
}

function fmtRelative(value) {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return '';
  const diff = ms - Date.now();
  if (diff <= 0) return 'expired';
  const minutes = Math.ceil(diff / 60000);
  if (minutes < 60) return `in ${minutes}min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return `in ${hours}h${rest ? ` ${rest}min` : ''}`;
  }
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  return `in ${days}d${rest ? ` ${rest}h` : ''}`;
}

function quotaPct(q) {
  if (!q) return null;
  if (q.remainingFraction != null) return Math.round(q.remainingFraction * 100);
  if (q.resetTime) return 0;
  return null;
}

function pctTone(pct) {
  if (pct == null) return 'gray';
  if (pct <= 0) return 'red';
  if (pct < 50) return 'yellow';
  return 'green';
}

function accountTone(account) {
  if (account.invalid) return 'red';
  const values = accounts.SUPPORTED_MODELS.map((model) => quotaPct(account.quota?.[model])).filter(
    (value) => value != null
  );
  if (!values.length) return 'gray';
  if (values.every((value) => value <= 0)) return 'red';
  if (values.some((value) => value < 50)) return 'yellow';
  return 'green';
}

function quotaBar(pct, width = 16) {
  const filled = pct == null ? 0 : Math.round((Math.max(0, Math.min(100, pct)) / 100) * width);
  const tone = pctTone(pct);
  return style[tone](`${'█'.repeat(filled)}${'░'.repeat(width - filled)}`);
}

function quotaReset(q) {
  if (!q?.resetTime) return '';
  return `${fmtResetShort(q.resetTime)} (${fmtRelative(q.resetTime)})`;
}

function printBlockWarning() {
  const block = accounts.getBlock();
  if (!block) return;
  console.log('\x1b[31m' + '='.repeat(70));
  console.log('ACCOUNTS BLOCKED - the provider stopped making new attempts');
  console.log(`Account: ${block.email || block.accountId || '?'} | model: ${block.modelId || '?'}`);
  console.log(`Reason: ${block.message || 'ban/suspension error'}`);
  console.log(`Since: ${new Date(block.at).toLocaleString('en-US')}`);
  console.log('Resolve it with Google and run: npm run accounts -- unblock');
  console.log('='.repeat(70) + '\x1b[0m');
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
  printBlockWarning();
  const list = accounts.publicList();
  if (!list.length) {
    console.log('No accounts in the vault. Run: npm run accounts -- add');
    return;
  }
  console.log(`Vault accounts (${list.length}):`);
  list.forEach((a, i) => {
    const active = a.active ? '*' : ' ';
    const invalid = a.invalid ? ' [invalid]' : '';
    console.log(`${active} ${i + 1}. ${a.email || a.id}${invalid}`);
    console.log(`     project: ${a.project}`);
    if (a.requestCount) console.log(`     requests: ${a.requestCount}`);
    if (a.lastError) console.log(`     error: ${a.lastError}`);
    const summary = quotaSummary(a);
    if (summary) console.log(`     quota: ${summary}`);
  });
  console.log('\n* = active provider account');
}

async function cmdAdd(label) {
  const account = accounts.importFromKeyring(label);
  console.log(`Imported: ${account.email || account.id}`);
  try {
    await accounts.refreshAccountMeta(account);
    console.log(`Project: ${account.project}`);
    const summary = quotaSummary(account);
    if (summary) console.log(`Quota: ${summary}`);
  } catch (err) {
    console.log(`Warning: could not fetch project/quota right now (${err.message})`);
  }
  console.log('The previous token was not removed from the vault.');
}

async function cmdUse(query) {
  const account = accounts.findAccount(query);
  if (!account) throw new Error(`account not found: ${query}`);
  accounts.writeAccountToKeyring(account);
  console.log(`agy now uses: ${account.email || account.id}`);
  console.log('The provider still uses all accounts in the vault.');
}

async function cmdQuota() {
  const accountsList = accounts
    .publicList()
    .sort((a, b) => Number(b.active) - Number(a.active) || String(a.email || '').localeCompare(String(b.email || '')));
  if (!accountsList.length) {
    console.log('No accounts in the vault. Run: npm run accounts -- add');
    return;
  }

  console.log('');
  console.log(style.bold('provider-agy quotas'));
  console.log(
    style.dim(
      `${accountsList.length} ${accountsList.length === 1 ? 'account' : 'accounts'} · updated ${fmtResetShort(
        new Date().toISOString()
      )}`
    )
  );
  printBlockWarning();

  for (const [index, account] of accountsList.entries()) {
    let refreshError = null;
    try {
      await accounts.refreshAccountMeta(account);
    } catch (err) {
      refreshError = err.message;
    }
    const live = accounts.findAccount(account.id) || account;
    const merged = { ...account, ...live };
    const tone = accountTone(merged);
    const known = accounts.SUPPORTED_MODELS.map((model) => quotaPct(merged.quota?.[model])).filter(
      (value) => value != null
    );
    const available = known.filter((value) => value > 0).length;
    const badges = [];
    if (account.active) badges.push(style.cyan('ACTIVE'));
    if (account.invalid) badges.push(style.red('INVALID'));
    if (known.length) {
      badges.push(style[tone](`${available}/${known.length} models available`));
    }

    console.log('');
    const badgeText = badges.length ? `  ${badges.join(style.dim(' · '))}` : '';
    console.log(
      `${style[tone]('●')} ${style.bold(`${index + 1}. ${live.email || live.id}`)}${badgeText}`
    );
    console.log(`   ${style.dim('project')} ${live.project || accounts.DEFAULT_PROJECT}`);
    if (refreshError) console.log(`   ${style.red(`refresh error: ${refreshError}`)}`);
    console.log(style.dim(`   ${'─'.repeat(84)}`));
    console.log(
      style.dim(`   ${'MODEL'.padEnd(30)}  ${'QUOTA'.padEnd(16)}  ${'LEFT'.padStart(5)}  RESET`)
    );

    for (const model of accounts.SUPPORTED_MODELS) {
      const q = live.quota?.[model];
      const pct = quotaPct(q);
      const label = MODEL_LABELS[model] || model;
      const pctText = pct == null ? '    ?' : `${String(pct).padStart(4)}%`;
      const resetText = quotaReset(q);
      console.log(
        `   ${label.padEnd(30)}  ${quotaBar(pct, 16)}  ${style[pctTone(pct)](pctText)}  ${
          resetText ? style.dim(resetText) : style.dim('—')
        }`
      );
    }
  }

  console.log('');
  console.log(
    `${style.green('●')} healthy  ${style.yellow('●')} attention  ${style.red('●')} exhausted  ${style.gray('○')} no data`
  );
  console.log(
    style.dim('The provider uses the active account first and switches automatically when a quota runs out.')
  );
}

function cmdRemove(query) {
  const account = accounts.removeAccount(query);
  console.log(`Removed from vault: ${account.email || account.id} (keyring unchanged)`);
}

/**
 * Accounts that look blocked: either the account the persisted global block
 * points at, or an account whose last error is a ban/suspension error.
 * Matches are deduplicated so one account is reported once.
 */
function findBlockedAccounts() {
  const block = accounts.getBlock();
  const blockId = block?.accountId ? String(block.accountId).toLowerCase() : null;
  const blockEmail = block?.email ? String(block.email).toLowerCase() : null;
  const seen = new Set();
  const matches = [];

  for (const account of accounts.listAccounts()) {
    const id = String(account.id || '').toLowerCase();
    const email = String(account.email || '').toLowerCase();
    const matchesBlock = Boolean(
      (blockId && (id === blockId || email === blockId)) ||
        (blockEmail && (email === blockEmail || id === blockEmail))
    );
    const banError = accounts.isBanError(account.lastError) ? account.lastError : null;
    if (!matchesBlock && !banError) continue;
    if (seen.has(account.id)) continue;
    seen.add(account.id);
    matches.push({
      account,
      reason: banError || block?.message || block?.reason || 'ban/suspension error',
    });
  }

  return { block, matches };
}

function cmdBlocked() {
  const { block, matches } = findBlockedAccounts();
  if (!matches.length) {
    console.log('No blocked accounts found.');
  } else {
    console.log(`Blocked accounts (${matches.length}):`);
    for (const { account, reason } of matches) {
      console.log(`- ${account.email || account.id}`);
      console.log(`  reason: ${reason}`);
    }
  }
  if (block) {
    console.log(
      `\nPersisted global block: ${block.email || block.accountId || '?'} since ${block.at} (${
        block.message || block.reason || 'ban/suspension error'
      }).`
    );
    console.log('Clear it after resolving the accounts with: npm run accounts -- remove-blocked');
  }
}

function cmdRemoveBlocked() {
  const { block, matches } = findBlockedAccounts();

  if (!matches.length) {
    if (!block) {
      console.log('No blocked accounts found. Nothing to remove.');
      return;
    }
    accounts.unblockAll();
    console.log(
      `No matching account records. Cleared the stale global block (was ${
        block.email || block.accountId || '?'
      } since ${block.at}).`
    );
    console.log('No accounts were removed.');
    return;
  }

  for (const { account, reason } of matches) {
    try {
      const removed = accounts.removeAccount(account.id);
      console.log(`Removed from vault: ${removed.email || removed.id} (keyring unchanged)`);
      console.log(`  reason: ${reason}`);
    } catch (err) {
      console.log(`Could not remove ${account.email || account.id}: ${err.message}`);
    }
  }

  if (block) {
    accounts.unblockAll();
    console.log('\nCleared the persisted global block so remaining accounts can be attempted again.');
  }
}

function cmdUnblock() {
  const previous = accounts.unblockAll();
  if (!previous) {
    console.log('Accounts were not blocked.');
    return;
  }
  console.log(`Block removed (was ${previous.email || previous.accountId || '?'} since ${previous.at}).`);
  console.log('The provider will try accounts again on the next request.');
}

function cmdLogin() {
  console.log(`Add another account without losing the current one:

1. Save the account that is signed in now:
   npm run accounts -- add

2. Sign in to the other account in agy (for example /login in the TUI or agy acp --login).

3. Import the new account into the vault:
   npm run accounts -- add

4. Check accounts and quotas:
   npm run accounts -- list
   npm run accounts -- quota

5. Make agy use a specific account:
   npm run accounts -- use <email-or-index>

If Google rejects an account for a ban/suspension, the provider blocks all
accounts and stops attempts. After resolving it, unlock with:
   npm run accounts -- unblock

To inspect or clean up banned accounts:
   npm run accounts -- blocked          # list accounts matching the block or a ban error
   npm run accounts -- remove-blocked   # remove those accounts and clear the global block

The provider uses the entire vault and switches accounts automatically when
quota runs out. The agy keyring only changes when you run "use".`);
}

(async () => {
  const [cmd = 'list', ...rest] = process.argv.slice(2);
  try {
    if (cmd === 'add') return await cmdAdd(rest[0]);
    if (cmd === 'use') return await cmdUse(rest[0]);
    if (cmd === 'remove' || cmd === 'rm') return cmdRemove(rest[0]);
    if (cmd === 'unblock' || cmd === 'reset-block') return cmdUnblock();
    if (cmd === 'blocked') return cmdBlocked();
    if (cmd === 'remove-blocked') return cmdRemoveBlocked();
    if (cmd === 'quota') return await cmdQuota();
    if (cmd === 'login') return cmdLogin();
    if (cmd === 'list' || cmd === 'ls') {
      await accounts.bootstrap();
      return printList();
    }
    if (cmd === 'help' || cmd === '--help' || cmd === '-h') return cmdLogin();

    console.error(`unknown command: ${cmd}`);
    cmdLogin();
    process.exitCode = 1;
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exitCode = 1;
  }
})();
