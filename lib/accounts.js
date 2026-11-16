'use strict';

/**
 * Antigravity account vault.
 *
 * - imports the current keyring login (gemini:antigravity) without deleting others;
 * - stores a copy of each login blob in ~/.provider-agy/accounts.json;
 * - refreshes tokens individually;
 * - fetches project and quota per account/model;
 * - selects the active account and falls back when quota runs out.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const zlib = require('zlib');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const USER_AGENT = `antigravity/cli/1.5.9 (aidev_client; os_type=windows; arch=amd64; cl=${process.env.AGY_CLIENT_CHANGELIST || '1021519450'}; auth_method=consumer)`;
const DEFAULT_PROJECT = process.env.AGY_PROJECT || 'aicode-consumers';
const KEYRING_TARGET = process.env.AGY_KEYRING_TARGET || 'gemini:antigravity';
const STATE_DIR = process.env.AGY_STATE_DIR || path.join(os.homedir(), '.provider-agy');
const VAULT_FILE = path.join(STATE_DIR, 'accounts.json');
const OAUTH_FILE = path.join(STATE_DIR, 'oauth.json');
const CLOUD_CODE_HOST = process.env.AGY_CLOUD_CODE_HOST || 'daily-cloudcode-pa.googleapis.com';
const KEYRING_SCRIPT = path.join(__dirname, '..', 'tools', 'keyring.ps1');

const SUPPORTED_MODELS = [
  'gemini-3.8-flash-high',
  'gemini-3.8-flash-medium',
  'gemini-3.8-flash-low',
  'claude-sonnet-4-6',
  'claude-opus-4-6-thinking',
  'gpt-oss-120b-medium',
];

let vaultCache = null;
let vaultMtime = 0;
const refreshPromises = new Map();

// ---------------------------------------------------------------------------
// Keyring
// ---------------------------------------------------------------------------

function runKeyring(args) {
  const outName = `.agy-kr-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.bin`;
  const cwd = os.tmpdir();
  const finalArgs = [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    KEYRING_SCRIPT,
    ...args,
  ];
  if (args[0] === 'read' && !args.includes('-OutFile')) {
    finalArgs.push('-OutFile', outName);
  }
  try {
    execFileSync('powershell.exe', finalArgs, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 20000,
      windowsHide: true,
    });
  } catch (err) {
    const detail = err.stderr ? String(err.stderr).trim().split('\n')[0] : err.message;
    throw new Error(`keyring (${args[0] || 'read'}) failed: ${detail}`);
  }
  return path.join(cwd, outName);
}

function readKeyringBlob() {
  const outName = `.agy-kr-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.bin`;
  runKeyring(['-Action', 'read', '-Target', KEYRING_TARGET, '-OutFile', outName]);
  const outPath = path.join(os.tmpdir(), outName);
  try {
    const raw = fs.readFileSync(outPath, 'utf8').replace(/^\uFEFF/, '');
    const blob = JSON.parse(raw);
    if (!blob.token || !blob.token.access_token) {
      throw new Error('keyring blob has no token.access_token');
    }
    return blob;
  } finally {
    try { fs.unlinkSync(outPath); } catch {}
  }
}

function writeKeyringBlob(blob) {
  const inName = `.agy-kr-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`;
  const inPath = path.join(os.tmpdir(), inName);
  fs.writeFileSync(inPath, JSON.stringify(blob));
  try {
    runKeyring(['-Action', 'write', '-Target', KEYRING_TARGET, '-InFile', inName, '-User', 'antigravity']);
  } finally {
    try { fs.unlinkSync(inPath); } catch {}
  }
}

// ---------------------------------------------------------------------------
// Identity / token
// ---------------------------------------------------------------------------

function parseIdentity(blob) {
  let email = blob.id_token_email || blob.token?.email || null;
  let sub = blob.token?.sub || null;
  let name = blob.id_token_name || null;

  const idToken = blob.id_token || blob.token?.id_token;
  if (typeof idToken === 'string' && idToken.split('.').length === 3) {
    try {
      const payload = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString('utf8'));
      email = email || payload.email || null;
      sub = sub || payload.sub || null;
      name = name || payload.name || null;
    } catch {}
  }
  return { email, sub, name };
}

function accountIdFor(blob, identity, label) {
  if (identity.email) return identity.email;
  if (identity.sub) return `sub:${identity.sub}`;
  if (label) return label;
  const seed = blob.token?.refresh_token || blob.token?.access_token || String(Date.now());
  return `account-${crypto.createHash('sha256').update(seed).digest('hex').slice(0, 8)}`;
}

function tokenExpired(blob, marginMs = 60_000) {
  const expiry = blob.token?.expiry ? Date.parse(blob.token.expiry) : 0;
  return !expiry || expiry - Date.now() < marginMs;
}

/**
 * The OAuth client is the same one embedded in the agy binary. It is NOT
 * stored in this repository: it comes from environment variables or
 * ~/.provider-agy/oauth.json.
 */
function loadOAuthClient() {
  if (process.env.AGY_OAUTH_CLIENT_ID && process.env.AGY_OAUTH_CLIENT_SECRET) {
    return {
      clientId: process.env.AGY_OAUTH_CLIENT_ID,
      clientSecret: process.env.AGY_OAUTH_CLIENT_SECRET,
    };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(OAUTH_FILE, 'utf8'));
    const clientId = parsed.clientId || parsed.client_id;
    const clientSecret = parsed.clientSecret || parsed.client_secret;
    if (clientId && clientSecret) return { clientId, clientSecret };
  } catch {}
  throw new Error(
    `agy OAuth client is not configured: set AGY_OAUTH_CLIENT_ID and AGY_OAUTH_CLIENT_SECRET or create ${OAUTH_FILE}`
  );
}

function refreshToken(refreshTokenValue) {
  return new Promise((resolve, reject) => {
    const { clientId, clientSecret } = loadOAuthClient();
    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshTokenValue,
      grant_type: 'refresh_token',
    }).toString();

    const req = https.request(
      {
        hostname: 'oauth2.googleapis.com',
        path: '/token',
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'content-length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let parsed = null;
          try { parsed = JSON.parse(data); } catch {}
          if (res.statusCode === 200 && parsed?.access_token) {
            resolve({
              access_token: parsed.access_token,
              refresh_token: refreshTokenValue,
              expires_in: parsed.expires_in || 3599,
              expiry: new Date(Date.now() + (parsed.expires_in || 3599) * 1000).toISOString(),
              token_type: parsed.token_type || 'Bearer',
              scope: parsed.scope,
            });
          } else {
            reject(new Error(`OAuth refresh failed (${res.statusCode}): ${parsed?.error || data.slice(0, 200)}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.end(body);
  });
}

async function ensureToken(account, force = false) {
  const live = findAccount(account.id) || account;
  if (process.env.AGY_ACCESS_TOKEN && live.static) return live.blob.token.access_token;
  if (!force && !tokenExpired(live.blob)) return live.blob.token.access_token;

  const refresh = live.blob.token?.refresh_token;
  if (!refresh) {
    live.invalid = true;
    live.lastError = 'token expired and no refresh_token';
    saveVault();
    throw new Error(live.lastError);
  }

  if (!refreshPromises.has(live.id)) {
    refreshPromises.set(
      live.id,
      refreshToken(refresh)
        .then((fresh) => {
          live.blob.token = { ...live.blob.token, ...fresh };
          live.invalid = false;
          live.lastError = null;
          live.updatedAt = new Date().toISOString();
          saveVault();
          return fresh.access_token;
        })
        .catch((err) => {
          live.invalid = true;
          live.lastError = err.message;
          saveVault();
          throw err;
        })
        .finally(() => refreshPromises.delete(live.id))
    );
  }
  return refreshPromises.get(live.id);
}

// ---------------------------------------------------------------------------
// HTTP client for Cloud Code
// ---------------------------------------------------------------------------

function cloudRequest(route, bodyObj, accessToken) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(bodyObj));
    const req = https.request(
      {
        hostname: CLOUD_CODE_HOST,
        path: `/v1internal:${route}`,
        method: 'POST',
        headers: {
          'user-agent': USER_AGENT,
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json',
          'accept-encoding': 'gzip',
          'content-length': payload.length,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          let raw = Buffer.concat(chunks);
          const enc = String(res.headers['content-encoding'] || '').toLowerCase();
          if (enc.includes('gzip')) {
            try { raw = zlib.gunzipSync(raw); } catch {}
          } else if (enc.includes('deflate')) {
            try { raw = zlib.inflateSync(raw); } catch {}
          } else if (enc.includes('br')) {
            try { raw = zlib.brotliDecompressSync(raw); } catch {}
          }
          const text = raw.toString('utf8');
          let json = null;
          try { json = JSON.parse(text); } catch {}
          resolve({ status: res.statusCode, headers: res.headers, json, text });
        });
      }
    );
    req.on('error', reject);
    req.end(payload);
  });
}

async function fetchProject(account) {
  const token = await ensureToken(account);
  const res = await cloudRequest('loadCodeAssist', { metadata: { ideType: 'ANTIGRAVITY' } }, token);
  if (res.status === 200 && res.json?.cloudaicompanionProject) {
    account.project = res.json.cloudaicompanionProject;
    return account.project;
  }
  return account.project || DEFAULT_PROJECT;
}

async function fetchQuota(account) {
  const live = findAccount(account.id) || account;
  const token = await ensureToken(live);
  const project = live.project || (await fetchProject(live)) || DEFAULT_PROJECT;
  const res = await cloudRequest('fetchAvailableModels', { project }, token);
  if (res.status !== 200 || !res.json?.models) {
    live.lastError = `fetchAvailableModels ${res.status}: ${extractErrorMessage(res.text)}`;
    saveVault();
    return live.quota || {};
  }

  const now = new Date().toISOString();
  const quota = {};
  for (const [id, model] of Object.entries(res.json.models)) {
    if (!model || !model.displayName) continue;
    const q = model.quotaInfo;
    if (!q) {
      quota[id] = { checkedAt: now, unknown: true };
      continue;
    }
    const remaining =
      q.remainingFraction != null ? q.remainingFraction : q.resetTime ? 0 : null;
    quota[id] = {
      remainingFraction: remaining,
      resetTime: q.resetTime || null,
      checkedAt: now,
    };
  }
  live.quota = quota;
  live.lastQuotaAt = now;
  live.lastError = null;
  saveVault();
  return quota;
}

async function refreshAccountMeta(account) {
  const live = findAccount(account.id) || account;
  await fetchProject(live);
  await fetchQuota(live);
  return live;
}

function extractErrorMessage(text) {
  try {
    const j = JSON.parse(text);
    return j.error?.message || j.message || text.slice(0, 300);
  } catch {
    return String(text || '').slice(0, 300);
  }
}

function parseDuration(value) {
  if (typeof value === 'number') return value * 1000;
  const m = String(value || '').match(
    /(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?/
  );
  if (!m || (!m[1] && !m[2] && !m[3])) return 0;
  return (
    (Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0)) * 1000
  );
}

function parseQuotaExhaustion(text) {
  let j = null;
  try { j = JSON.parse(text); } catch {}
  const err = j?.error || j || {};
  const message = String(err.message || text || '');
  const details = Array.isArray(err.details) ? err.details : [];
  const info = details.find((d) => String(d?.['@type'] || '').includes('ErrorInfo'));
  const retry = details.find((d) => String(d?.['@type'] || '').includes('RetryInfo'));

  // Do not treat the generic 429 "Resource has been exhausted (e.g. check quota)"
  // as account quota: that is the Gemini per-request limit and must not burn
  // the account for an hour. Only mark it when there is quota evidence.
  const isQuota =
    info?.reason === 'QUOTA_EXHAUSTED' ||
    Boolean(info?.metadata?.quotaResetTimeStamp || info?.metadata?.quotaResetDelay) ||
    /individual quota|quota (?:reached|exceeded|exhausted)|exceeded (?:your )?quota/i.test(message);

  if (!isQuota) return { isQuota: false, resetAt: null, message };

  let resetAt = info?.metadata?.quotaResetTimeStamp || null;
  if (!resetAt && retry?.retryDelay) {
    resetAt = new Date(Date.now() + parseDuration(retry.retryDelay)).toISOString();
  }
  if (!resetAt && info?.metadata?.quotaResetDelay) {
    resetAt = new Date(Date.now() + parseDuration(info.metadata.quotaResetDelay)).toISOString();
  }
  if (!resetAt) {
    const m = message.match(/resets? in\s+(.+?)(?:\.|$)/i);
    if (m) {
      const ms = parseDuration(m[1]);
      if (ms) resetAt = new Date(Date.now() + ms).toISOString();
    }
  }
  if (!resetAt) resetAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

  return { isQuota: true, resetAt, message };
}

// ---------------------------------------------------------------------------
// Account ban / suspension
// ---------------------------------------------------------------------------

// Only specific ban/suspension/violation patterns belong here. Quota, input
// size, and model safety errors must NOT block accounts. The patterns also
// include Portuguese because Google may localize these errors.
const BAN_PATTERNS = [
  /\b(?:account|user|conta|usuário)\b[^.\n]{0,80}\b(?:banned|suspended|disabled|terminated|deactivated|banid[ao]|suspens[ao]|desativad[ao])\b/i,
  /\b(?:banned|suspended|terminated|banid[ao]|suspens[ao])\b[^.\n]{0,40}\b(?:account|user|conta|usuário)\b/i,
  /\b(?:account|user|conta|usuário)\b[^.\n]{0,120}\b(?:violat(?:e|ed|ion|ing)|breach(?:ed)?|viola(?:ção|ram|m)?|violou)\b[^.\n]{0,80}\b(?:terms(?: of (?:service|use))?|policies|agreement|termos)\b/i,
  /\b(?:account|user|conta|usuário)\s+(?:access\s+)?(?:has been|was|is)?\s*(?:blocked|bloquead[ao])\b/i,
  /\b(?:abusive use|abuse detected|abuse of (?:the )?service|fraudulent activity|automated access|scraping|unauthorized use)\b/i,
  /\b(?:ACCOUNT_DISABLED|USER_DISABLED|ACCOUNT_SUSPENDED|CONSUMER_SUSPENDED|TERMS_VIOLATION|ABUSE_DETECTED)\b/,
];

function isBanError(text) {
  const value = String(text || '');
  return BAN_PATTERNS.some((pattern) => pattern.test(value));
}

function getBlock() {
  return loadVault().blocked || null;
}

function isBlocked() {
  return Boolean(getBlock());
}

function blockAll(info = {}) {
  const vault = loadVault();
  if (vault.blocked) return vault.blocked;
  const account = info.accountId ? vault.accounts[info.accountId] : null;
  vault.blocked = {
    at: new Date().toISOString(),
    reason: info.reason || 'ban',
    message: String(info.message || '').slice(0, 1000),
    accountId: info.accountId || null,
    email: account?.email || null,
    modelId: info.modelId || null,
    statusCode: info.statusCode || null,
  };
  saveVault(vault);
  return vault.blocked;
}

function unblockAll() {
  const vault = loadVault();
  const previous = vault.blocked || null;
  vault.blocked = null;
  saveVault(vault);
  return previous;
}

// ---------------------------------------------------------------------------
// Vault
// ---------------------------------------------------------------------------

function ensureVaultShape(v) {
  if (!v || typeof v !== 'object') v = {};
  if (!v.accounts || typeof v.accounts !== 'object') v.accounts = {};
  if (!('active' in v)) v.active = null;
  if (!('blocked' in v)) v.blocked = null;
  v.version = 1;
  for (const account of Object.values(v.accounts)) {
    if (!account.quota || typeof account.quota !== 'object') account.quota = {};
    if (!account.addedAt) account.addedAt = new Date().toISOString();
  }
  return v;
}

const securedFiles = new Set();

function secureFile(file) {
  try { fs.chmodSync(file, 0o600); } catch {}
  if (process.platform !== 'win32') return;
  if (securedFiles.has(file)) return;
  securedFiles.add(file);
  try {
    const user = process.env.USERNAME || os.userInfo().username;
    execFileSync('icacls', [file, '/inheritance:r', '/grant:r', `${user}:F`], {
      stdio: 'ignore',
      timeout: 5000,
      windowsHide: true,
    });
  } catch {}
}

function loadVault(force = false) {
  if (!force && vaultCache) {
    try {
      const st = fs.statSync(VAULT_FILE);
      if (st.mtimeMs === vaultMtime) return vaultCache;
    } catch {
      return vaultCache;
    }
  }
  let vault = { version: 1, active: null, accounts: {} };
  try {
    vault = JSON.parse(fs.readFileSync(VAULT_FILE, 'utf8'));
  } catch {}
  vaultCache = ensureVaultShape(vault);
  try { vaultMtime = fs.statSync(VAULT_FILE).mtimeMs; } catch { vaultMtime = 0; }
  return vaultCache;
}

function saveVault(vault = vaultCache) {
  if (!vault) return;
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(VAULT_FILE, JSON.stringify(vault, null, 2));
  secureFile(VAULT_FILE);
  vaultCache = vault;
  try { vaultMtime = fs.statSync(VAULT_FILE).mtimeMs; } catch {}
}

function importFromKeyring(label) {
  const blob = readKeyringBlob();
  const identity = parseIdentity(blob);
  const id = accountIdFor(blob, identity, label);
  const vault = loadVault(true);
  const now = new Date().toISOString();
  const existing = vault.accounts[id];

  const account = existing || {
    id,
    addedAt: now,
    quota: {},
  };
  account.email = identity.email || account.email || id;
  account.name = identity.name || account.name || null;
  account.sub = identity.sub || account.sub || null;
  account.project = blob.project || account.project || DEFAULT_PROJECT;
  account.blob = blob;
  account.invalid = false;
  account.lastError = null;
  account.updatedAt = now;

  vault.accounts[id] = account;
  if (!vault.active || !vault.accounts[vault.active]) vault.active = id;
  saveVault(vault);
  return account;
}

function envAccount() {
  const vault = loadVault(true);
  const id = 'env';
  if (!vault.accounts[id]) {
    vault.accounts[id] = {
      id,
      email: 'AGY_ACCESS_TOKEN',
      name: 'environment variable',
      project: DEFAULT_PROJECT,
      blob: {
        token: {
          access_token: process.env.AGY_ACCESS_TOKEN,
          token_type: 'Bearer',
          expiry: null,
        },
        auth_method: 'consumer',
      },
      static: true,
      addedAt: new Date().toISOString(),
      quota: {},
    };
    saveVault(vault);
  }
  return vault.accounts[id];
}

async function bootstrap() {
  loadVault(true);
  if (process.env.AGY_ACCESS_TOKEN) {
    const account = envAccount();
    if (!loadVault().active) {
      loadVault().active = account.id;
      saveVault();
    }
    return account;
  }
  try {
    return importFromKeyring();
  } catch (err) {
    const vault = loadVault();
    if (Object.keys(vault.accounts).length) return null;
    throw err;
  }
}

function listAccounts() {
  return Object.values(loadVault().accounts);
}

function findAccount(query) {
  const vault = loadVault();
  if (query == null || query === '') {
    if (vault.active && vault.accounts[vault.active]) return vault.accounts[vault.active];
    return null;
  }
  const q = String(query).trim().toLowerCase();
  const accounts = Object.values(vault.accounts);
  const exact = accounts.find(
    (a) => String(a.id).toLowerCase() === q || String(a.email).toLowerCase() === q
  );
  if (exact) return exact;
  const index = Number(q);
  if (Number.isInteger(index) && index >= 1 && index <= accounts.length) {
    return accounts[index - 1];
  }
  return accounts.find(
    (a) =>
      String(a.email || '').toLowerCase().includes(q) ||
      String(a.id).toLowerCase().includes(q)
  ) || null;
}

function selectAccountsFor(modelId) {
  const vault = loadVault();
  if (vault.blocked) return [];
  const now = Date.now();
  const accounts = Object.values(vault.accounts).filter((a) => !a.invalid);
  const available = accounts.filter((a) => {
    const q = a.quota?.[modelId];
    if (!q) return true;
    const resetAt = q.exhaustedUntil || q.resetTime;
    const resetMs = resetAt ? Date.parse(resetAt) : 0;
    if (q.exhaustedUntil && resetMs > now) return false;
    if (q.remainingFraction != null && q.remainingFraction <= 0 && resetMs > now) return false;
    return true;
  });

  // An account whose reset window has passed moves to the front of the queue:
  // this is the "return to the previous account" behavior after quota resets.
  const recovered = (account) => {
    const q = account.quota?.[modelId];
    if (!q) return false;
    const reset = q.exhaustedUntil || q.resetTime;
    if (!reset) return false;
    const resetMs = Date.parse(reset);
    if (!Number.isFinite(resetMs) || resetMs > now) return false;
    return Boolean(q.exhaustedUntil) || q.remainingFraction === 0;
  };

  available.sort((a, b) => {
    const aRecovered = recovered(a) ? 1 : 0;
    const bRecovered = recovered(b) ? 1 : 0;
    if (aRecovered !== bRecovered) return bRecovered - aRecovered;
    const aActive = a.id === vault.active ? 1 : 0;
    const bActive = b.id === vault.active ? 1 : 0;
    if (aActive !== bActive) return bActive - aActive;
    const aq = a.quota?.[modelId]?.remainingFraction;
    const bq = b.quota?.[modelId]?.remainingFraction;
    if (aq != null && bq != null && aq !== bq) return bq - aq;
    return (Date.parse(a.lastUsedAt || 0) || 0) - (Date.parse(b.lastUsedAt || 0) || 0);
  });
  return available;
}

function nextResetFor(modelId) {
  const vault = loadVault();
  let next = null;
  for (const account of Object.values(vault.accounts)) {
    const q = account.quota?.[modelId];
    const reset = q?.exhaustedUntil || q?.resetTime;
    if (!reset) continue;
    const ms = Date.parse(reset);
    if (Number.isFinite(ms) && ms > Date.now() && (!next || ms < next)) next = ms;
  }
  return next ? new Date(next).toISOString() : null;
}

function markSuccess(accountId, modelId) {
  const vault = loadVault();
  const account = vault.accounts[accountId];
  if (!account) return { previousActive: vault.active, recovered: false, requestCount: 0 };
  const previousActive = vault.active;
  const q = account.quota?.[modelId];
  const reset = q?.exhaustedUntil || q?.resetTime;
  const recovered = Boolean(
    reset &&
      Date.parse(reset) <= Date.now() &&
      (q?.exhaustedUntil || q?.remainingFraction === 0)
  );

  account.lastUsedAt = new Date().toISOString();
  account.requestCount = (account.requestCount || 0) + 1;
  account.invalid = false;
  account.lastError = null;
  vault.active = accountId;
  if (q) {
    // If the account responded, it is no longer exhausted even if the
    // previously fetched quota still said 0.
    delete q.exhaustedUntil;
    if (q.remainingFraction === 0) q.remainingFraction = null;
  }
  saveVault(vault);
  return { previousActive, recovered, requestCount: account.requestCount };
}

function markExhausted(accountId, modelId, resetAt, message) {
  const vault = loadVault();
  const account = vault.accounts[accountId];
  if (!account) return;
  account.quota = account.quota || {};
  account.quota[modelId] = {
    ...(account.quota[modelId] || {}),
    remainingFraction: 0,
    exhaustedUntil: resetAt,
    resetTime: resetAt,
    checkedAt: new Date().toISOString(),
    reason: message || 'quota exhausted',
  };
  account.lastError = message || 'quota exhausted';
  if (vault.active === accountId) vault.active = null;
  saveVault(vault);
}

function markInvalid(accountId, message) {
  const vault = loadVault();
  const account = vault.accounts[accountId];
  if (!account) return;
  account.invalid = true;
  account.lastError = message || 'invalid account';
  if (vault.active === accountId) vault.active = null;
  saveVault(vault);
}

function setActive(accountId) {
  const vault = loadVault();
  if (!vault.accounts[accountId]) throw new Error(`account not found: ${accountId}`);
  vault.active = accountId;
  saveVault(vault);
  return vault.accounts[accountId];
}

function writeAccountToKeyring(account) {
  const live = findAccount(account.id) || account;
  writeKeyringBlob(live.blob);
  setActive(live.id);
  return live;
}

function removeAccount(accountId) {
  const vault = loadVault();
  const account = findAccount(accountId);
  if (!account) throw new Error(`account not found: ${accountId}`);
  delete vault.accounts[account.id];
  if (vault.active === account.id) vault.active = null;
  saveVault(vault);
  return account;
}

function publicList() {
  const vault = loadVault();
  return Object.values(vault.accounts).map((a) => ({
    id: a.id,
    email: a.email,
    name: a.name,
    project: a.project || DEFAULT_PROJECT,
    active: vault.active === a.id,
    invalid: Boolean(a.invalid),
    lastError: a.lastError || null,
    lastUsedAt: a.lastUsedAt || null,
    requestCount: a.requestCount || 0,
    quota: a.quota || {},
  }));
}

module.exports = {
  DEFAULT_PROJECT,
  KEYRING_TARGET,
  SUPPORTED_MODELS,
  STATE_DIR,
  VAULT_FILE,
  readKeyringBlob,
  writeKeyringBlob,
  parseIdentity,
  loadOAuthClient,
  ensureToken,
  refreshToken,
  fetchProject,
  fetchQuota,
  refreshAccountMeta,
  parseQuotaExhaustion,
  isBanError,
  getBlock,
  isBlocked,
  blockAll,
  unblockAll,
  extractErrorMessage,
  bootstrap,
  importFromKeyring,
  listAccounts,
  findAccount,
  selectAccountsFor,
  nextResetFor,
  markSuccess,
  markExhausted,
  markInvalid,
  setActive,
  writeAccountToKeyring,
  removeAccount,
  publicList,
  loadVault,
  saveVault,
};
