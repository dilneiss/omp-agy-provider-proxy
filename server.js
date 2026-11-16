#!/usr/bin/env node
'use strict';

/**
 * provider-agy - exposes the Antigravity CLI (agy) backend as an
 * OpenAI-compatible provider for omp (Oh My Pi) and other clients.
 *
 * Requests sent to Cloud Code replicate the envelope, headers, and request
 * shape of agy 1.5.9. Credentials are read from the same keyring used by agy
 * ("gemini:antigravity") and refreshed with its embedded OAuth client.
 */

const http = require('http');
const https = require('https');
const zlib = require('zlib');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { StringDecoder } = require('string_decoder');
const accounts = require('./lib/accounts');

const VERSION = '1.5.9';
const CLOUD_CODE_HOST = process.env.AGY_CLOUD_CODE_HOST || 'daily-cloudcode-pa.googleapis.com';
const PROJECT = process.env.AGY_PROJECT || 'aicode-consumers';
const HOST = process.env.AGY_PROVIDER_HOST || '127.0.0.1';
const PORT = Number(process.env.AGY_PROVIDER_PORT || process.env.PORT || 8788);

// "cl" is the build changelist embedded in the 1.5.9 binary; keeps the UA identical.
const CLIENT_CHANGELIST = process.env.AGY_CLIENT_CHANGELIST || '1021519450';
const USER_AGENT = `antigravity/cli/${VERSION} (aidev_client; os_type=windows; arch=amd64; cl=${CLIENT_CHANGELIST}; auth_method=consumer)`;

const MODELS = {
  'gemini-3.8-flash-high': {
    name: 'Gemini 3.8 Flash (High)',
    enum: 'MODEL_PLACEHOLDER_M318',
    provider: 'google',
    maxOutputTokens: 65536,
    contextWindow: 1048576,
    thinkingLevel: 'HIGH',
  },
  'gemini-3.8-flash-medium': {
    name: 'Gemini 3.8 Flash (Medium)',
    enum: 'MODEL_PLACEHOLDER_M319',
    provider: 'google',
    maxOutputTokens: 65536,
    contextWindow: 1048576,
    thinkingLevel: 'MEDIUM',
  },
  'gemini-3.8-flash-low': {
    name: 'Gemini 3.8 Flash (Low)',
    enum: 'MODEL_PLACEHOLDER_M320',
    provider: 'google',
    maxOutputTokens: 65536,
    contextWindow: 1048576,
    thinkingLevel: 'LOW',
  },
  'claude-sonnet-4-6': {
    name: 'Claude Sonnet 4.6 (Thinking)',
    enum: 'MODEL_PLACEHOLDER_M35',
    provider: 'anthropic',
    maxOutputTokens: 64000,
    contextWindow: 250000,
    thinkingBudget: 1024,
  },
  'claude-opus-4-6-thinking': {
    name: 'Claude Opus 4.6 (Thinking)',
    enum: 'MODEL_PLACEHOLDER_M26',
    provider: 'anthropic',
    maxOutputTokens: 64000,
    contextWindow: 250000,
    thinkingBudget: 2048,
  },
  'gpt-oss-120b-medium': {
    name: 'GPT-OSS 120B (Medium)',
    enum: 'MODEL_OPENAI_GPT_OSS_120B_MEDIUM',
    provider: 'openai',
    maxOutputTokens: 32768,
    contextWindow: 131072,
    thinkingBudget: 8192,
  },
};

const MODEL_ALIASES = {
  'gemini-3.8-flash': 'gemini-3.8-flash-high',
  'gemini-3.8': 'gemini-3.8-flash-high',
  'claude-sonnet': 'claude-sonnet-4-6',
  'claude-opus': 'claude-opus-4-6-thinking',
  'gpt-oss': 'gpt-oss-120b-medium',
};

// ---------------------------------------------------------------------------
// Credentials (Windows keyring, the same one used by agy)
// ---------------------------------------------------------------------------

// Credentials and account selection live in lib/accounts.js (multi-account vault).

// ---------------------------------------------------------------------------
// OpenAI -> Cloud Code translation (same shape as agy)
// ---------------------------------------------------------------------------

function resolveModel(raw) {
  let id = String(raw || '').trim();
  if (id.startsWith('agy/')) id = id.slice(4);
  if (MODELS[id]) return { id, def: MODELS[id] };
  const alias = MODEL_ALIASES[id];
  if (alias && MODELS[alias]) return { id: alias, def: MODELS[alias] };
  // fuzzy: prefix or contains, matching the omp behavior
  const found = Object.keys(MODELS).find((k) => k.includes(id) || id.includes(k));
  if (found) return { id: found, def: MODELS[found] };
  return { id: 'gemini-3.8-flash-high', def: MODELS['gemini-3.8-flash-high'] };
}

function uuid() {
  return crypto.randomUUID();
}

function randomInt64String() {
  const bytes = crypto.randomBytes(8);
  let v = BigInt('0x' + bytes.toString('hex'));
  if (v > 9223372036854775807n) v -= 18446744073709551616n;
  return v.toString();
}

function safeJsonParse(text) {
  if (text == null || text === '') return null;
  if (typeof text === 'object') return text;
  try { return JSON.parse(text); } catch { return null; }
}

function toGeminiType(type) {
  if (Array.isArray(type)) {
    return type.find((t) => t !== 'null') || 'string';
  }
  return type || 'string';
}

const ALLOWED_SCHEMA_KEYS = new Set([
  'type', 'description', 'properties', 'required', 'items', 'enum', 'nullable',
  'format', 'minimum', 'maximum', 'minItems', 'maxItems', 'minLength', 'maxLength',
]);

function convertSchema(node, root) {
  if (node == null) return { type: 'STRING' };
  if (typeof node === 'boolean') return { type: 'STRING' };
  if (typeof node === 'string') return { type: 'STRING' };

  if (node.$ref && typeof node.$ref === 'string') {
    const ref = node.$ref.replace(/^#\//, '').split('/').reduce((acc, part) => (acc ? acc[part] : null), root);
    if (ref) return convertSchema(ref, root);
    return { type: 'STRING' };
  }

  const union = node.anyOf || node.oneOf;
  if (Array.isArray(union) && union.length) {
    const nonNull = union.filter((v) => v && v.type !== 'null');
    const chosen = nonNull[0] || union[0];
    const out = convertSchema(chosen, root);
    if (union.some((v) => v && v.type === 'null')) out.nullable = true;
    if (node.description) out.description = node.description;
    return out;
  }

  const rawType = toGeminiType(node.type);
  const out = {};

  if (rawType === 'object' || node.properties || rawType === 'OBJECT') {
    out.type = 'OBJECT';
    const props = {};
    for (const [key, value] of Object.entries(node.properties || {})) {
      props[key] = convertSchema(value, root);
    }
    out.properties = props;
    if (Array.isArray(node.required) && node.required.length) out.required = node.required;
  } else if (rawType === 'array' || rawType === 'ARRAY') {
    out.type = 'ARRAY';
    out.items = convertSchema(node.items || { type: 'string' }, root);
  } else {
    out.type = String(rawType).toUpperCase();
    if (!['STRING', 'NUMBER', 'INTEGER', 'BOOLEAN'].includes(out.type)) {
      out.type = 'STRING';
    }
  }

  if (node.description) out.description = String(node.description);
  if (Array.isArray(node.enum)) out.enum = node.enum.map((v) => String(v));
  if (node.nullable === true) out.nullable = true;
  for (const key of ['format', 'minimum', 'maximum', 'minItems', 'maxItems', 'minLength', 'maxLength']) {
    if (node[key] !== undefined && ALLOWED_SCHEMA_KEYS.has(key)) out[key] = node[key];
  }
  // unsupported keys are intentionally dropped
  return out;
}

function convertTools(tools) {
  if (!Array.isArray(tools) || !tools.length) return undefined;
  const declarations = [];
  for (const tool of tools) {
    if (!tool || tool.type !== 'function' || !tool.function) continue;
    const fn = tool.function;
    declarations.push({
      functionDeclarations: [
        {
          name: fn.name,
          description: fn.description || '',
          parameters: convertSchema(fn.parameters || { type: 'object', properties: {} }, fn.parameters || {}),
        },
      ],
    });
  }
  return declarations.length ? declarations : undefined;
}

function messageText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((p) => p && (p.type === 'text' || p.type === 'input_text'))
      .map((p) => p.text || '')
      .join('');
  }
  return String(content);
}

function imageParts(content) {
  if (!Array.isArray(content)) return [];
  const parts = [];
  for (const p of content) {
    if (!p) continue;
    if (p.type === 'image_url' && p.image_url) {
      const url = typeof p.image_url === 'string' ? p.image_url : p.image_url.url;
      const m = /^data:([^;]+);base64,(.+)$/.exec(url || '');
      if (m) parts.push({ inlineData: { mimeType: m[1], data: m[2] } });
    } else if (p.type === 'input_image' && p.image_url) {
      const m = /^data:([^;]+);base64,(.+)$/.exec(p.image_url || '');
      if (m) parts.push({ inlineData: { mimeType: m[1], data: m[2] } });
    }
  }
  return parts;
}

const toolCallNames = new Map(); // tool_call_id -> function name
const thoughtSignatures = new Map(); // tool_call_id -> thoughtSignature
const STATE_DIR = process.env.AGY_STATE_DIR || path.join(os.homedir(), '.provider-agy');
const STATE_FILE = path.join(STATE_DIR, 'state.json');
let stateLoaded = false;
let persistTimer = null;

function loadState() {
  if (stateLoaded) return;
  stateLoaded = true;
  try {
    const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    for (const [id, name] of Object.entries(saved.names || {})) toolCallNames.set(id, name);
    for (const [id, sig] of Object.entries(saved.signatures || {})) thoughtSignatures.set(id, sig);
  } catch {}
}

function persistState() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      fs.writeFileSync(
        STATE_FILE,
        JSON.stringify({
          names: Object.fromEntries(toolCallNames),
          signatures: Object.fromEntries(thoughtSignatures),
        })
      );
    } catch (err) {
      console.warn(`[agy] could not save tool call state: ${err.message}`);
    }
  }, 500);
}

function rememberToolCall(id, name, signature) {
  loadState();
  toolCallNames.set(id, name);
  if (signature) thoughtSignatures.set(id, signature);
  if (toolCallNames.size > 5000) {
    const first = toolCallNames.keys().next().value;
    toolCallNames.delete(first);
    thoughtSignatures.delete(first);
  }
  persistState();
}

// The Antigravity backend rejects (429 RESOURCE_EXHAUSTED) requests with more
// than ~40k uncached input tokens. The default omp prompt with many skills/MCP
// entries exceeds that, so we enforce a conservative budget.
const MAX_INPUT_TOKENS = Number(process.env.AGY_MAX_INPUT_TOKENS || 38000);
const CHARS_PER_TOKEN = 3.5;

function estimateTokens(obj) {
  return Math.ceil(JSON.stringify(obj).length / CHARS_PER_TOKEN);
}

function isUserTextEntry(entry) {
  const parts = entry.parts || [];
  return (
    entry.role === 'user' &&
    parts.some((p) => typeof p.text === 'string') &&
    !parts.some((p) => p.functionResponse)
  );
}

function trimToBudget(body) {
  if (process.env.AGY_TRIM === '0' || !MAX_INPUT_TOKENS) return { body, trimmedTokens: 0, droppedTurns: 0 };
  const original = estimateTokens(body);
  if (original <= MAX_INPUT_TOKENS) return { body, trimmedTokens: 0, droppedTurns: 0 };

  let droppedTurns = 0;
  // remove whole old turns (never split functionCall from functionResponse)
  while (estimateTokens(body) > MAX_INPUT_TOKENS) {
    const contents = body.request.contents;
    let first = -1;
    let second = -1;
    for (let i = 0; i < contents.length; i++) {
      if (!isUserTextEntry(contents[i])) continue;
      if (first === -1) first = i;
      else { second = i; break; }
    }
    if (second <= 0) break;
    contents.splice(0, second);
    droppedTurns++;
  }

  let trimmedTokens = 0;
  if (estimateTokens(body) > MAX_INPUT_TOKENS) {
    const sys = body.request.systemInstruction?.parts?.[0];
    if (sys && typeof sys.text === 'string') {
      const excessTokens = estimateTokens(body) - MAX_INPUT_TOKENS;
      const cutChars = Math.ceil(excessTokens * CHARS_PER_TOKEN);
      const keep = Math.max(20000, sys.text.length - cutChars);
      if (keep < sys.text.length) {
        const before = sys.text.length;
        sys.text =
          sys.text.slice(0, keep) +
          '\n\n[... skills/MCP catalog truncated by provider-agy to fit the backend context limit ...]';
        trimmedTokens = before - keep;
      }
    }
  }

  return { body, trimmedTokens, droppedTurns };
}

function buildCloudRequest(openaiReq, project = PROJECT) {
  loadState();
  const model = resolveModel(openaiReq.model);
  const messages = Array.isArray(openaiReq.messages) ? openaiReq.messages : [];
  const droppedToolIds = new Set();
  const systemTexts = [];
  const contents = [];

  const push = (role, parts) => {
    if (!parts || !parts.length) return;
    const last = contents[contents.length - 1];
    if (last && last.role === role) {
      last.parts.push(...parts);
    } else {
      contents.push({ role, parts });
    }
  };

  for (const msg of messages) {
    const role = msg.role;
    if (role === 'system' || role === 'developer') {
      const text = messageText(msg.content);
      if (text) systemTexts.push(text);
      continue;
    }

    if (role === 'tool' || role === 'function') {
      const id = msg.tool_call_id || msg.name || '';
      if (droppedToolIds.has(id)) continue;
      const name = msg.name || toolCallNames.get(id) || 'tool';
      const parsed = safeJsonParse(msg.content);
      const response = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed
        : { result: msg.content == null ? '' : String(msg.content) };
      push('user', [{ functionResponse: { id, name, response } }]);
      continue;
    }

    if (role === 'assistant') {
      const parts = [];
      const text = messageText(msg.content);
      if (text) parts.push({ text });
      for (const tc of msg.tool_calls || []) {
        if (!tc || !tc.function) continue;
        const name = tc.function.name;
        const args = safeJsonParse(tc.function.arguments) || {};
        const id = tc.id || `call_${uuid()}`;
        const signature = thoughtSignatures.get(id);
        // Gemini 3 requires thoughtSignature on every functionCall. For older
        // sessions (provider restarted before persistence), drop the tool call/result
        // pair instead of returning 400.
        if (!signature && model.def.provider === 'google') {
          droppedToolIds.add(id);
          continue;
        }
        const part = { functionCall: { id, name, args } };
        if (signature) part.thoughtSignature = signature;
        parts.push(part);
        rememberToolCall(id, name, signature);
      }
      push('model', parts);
      continue;
    }

    if (role === 'user') {
      const parts = [];
      const text = messageText(msg.content);
      if (text) parts.push({ text });
      parts.push(...imageParts(msg.content));
      push('user', parts);
    }
  }

  if (!contents.length) {
    contents.push({ role: 'user', parts: [{ text: '' }] });
  }

  const cascadeId = uuid();
  const trajectoryId = uuid();
  const step = 0;
  const request = {
    contents,
    labels: {
      cascade_id: cascadeId,
      last_step_index: String(step),
      model_enum: model.def.enum,
      request_id: `${trajectoryId}-${step}`,
      root_cascade_id: cascadeId,
      trajectory_id: trajectoryId,
      used_claude: String(model.def.provider === 'anthropic'),
      used_claude_conservative: 'false',
      used_non_gemini_model: String(model.def.provider !== 'google'),
    },
    generationConfig: buildGenerationConfig(model.def, openaiReq),
    sessionId: randomInt64String(),
  };

  if (systemTexts.length) {
    request.systemInstruction = { role: 'user', parts: [{ text: systemTexts.join('\n\n') }] };
  }

  const tools = convertTools(openaiReq.tools);
  if (tools) request.tools = tools;

  // keep the agy key order
  const ordered = {
    contents: request.contents,
    ...(request.systemInstruction ? { systemInstruction: request.systemInstruction } : {}),
    ...(request.tools ? { tools: request.tools } : {}),
    labels: request.labels,
    generationConfig: request.generationConfig,
    sessionId: request.sessionId,
  };

  const body = {
    project: project || PROJECT,
    requestId: `agent/${cascadeId}/${Date.now()}/${trajectoryId}/${step}`,
    request: ordered,
    model: model.id,
    userAgent: 'antigravity',
    requestType: 'agent',
  };
  const fitted = trimToBudget(body);
  if (fitted.trimmedTokens || fitted.droppedTurns) {
    console.warn(
      `[agy] context trimmed: ${fitted.trimmedTokens} system chars and ${fitted.droppedTurns} old turn(s) removed (limit ~${MAX_INPUT_TOKENS} tokens)`
    );
  }
  return { model, body: fitted.body };
}

function buildGenerationConfig(def, req) {
  const floor = def.thinkingBudget ? def.thinkingBudget + 1 : 1024;
  const maxOut = Math.max(
    floor,
    Math.min(
      def.maxOutputTokens,
      Number(req.max_completion_tokens || req.max_tokens || def.maxOutputTokens) || def.maxOutputTokens
    )
  );
  const config = { maxOutputTokens: maxOut };
  if (def.thinkingLevel) {
    const effort = String(req.reasoning_effort || '').toLowerCase();
    const level =
      effort === 'low' ? 'LOW'
      : effort === 'high' ? 'HIGH'
      : effort === 'medium' ? 'MEDIUM'
      : def.thinkingLevel;
    config.thinkingConfig = { includeThoughts: true, thinkingLevel: level };
  } else {
    config.thinkingConfig = { includeThoughts: true, thinkingBudget: def.thinkingBudget || 1024 };
  }
  return config;
}

// ---------------------------------------------------------------------------
// Cloud Code -> OpenAI
// ---------------------------------------------------------------------------

function cloudPost(body, accessToken) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body));
    const req = https.request(
      {
        hostname: CLOUD_CODE_HOST,
        path: '/v1internal:streamGenerateContent?alt=sse',
        method: 'POST',
        headers: {
          'user-agent': USER_AGENT,
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json',
          'accept-encoding': 'gzip',
          'content-length': payload.length,
        },
      },
      (res) => resolve(res)
    );
    req.on('error', reject);
    req.end(payload);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readResponseText(res, limit = 64 * 1024) {
  return new Promise((resolve) => {
    const stream = responseStream(res);
    const chunks = [];
    let size = 0;
    stream.on('data', (chunk) => {
      if (size >= limit) return;
      const slice = chunk.length > limit - size ? chunk.subarray(0, limit - size) : chunk;
      chunks.push(slice);
      size += slice.length;
    });
    const done = () => resolve(Buffer.concat(chunks).toString('utf8'));
    stream.on('end', done);
    stream.on('error', done);
  });
}

async function callAccount(body, account) {
  if (account.project && account.project !== body.project) {
    body = { ...body, project: account.project };
  }
  let accessToken;
  try {
    accessToken = await accounts.ensureToken(account);
  } catch (err) {
    return { tokenError: err.message };
  }

  let res;
  try {
    res = await cloudPost(body, accessToken);
  } catch (err) {
    return { networkError: err.message };
  }

  if (res.statusCode === 200) return { ok: true, res };
  let text = await readResponseText(res);

  if (res.statusCode === 401) {
    try {
      accessToken = await accounts.ensureToken(account, true);
    } catch (err) {
      return { statusCode: 401, text: err.message, invalid: true };
    }
    try {
      res = await cloudPost(body, accessToken);
    } catch (err) {
      return { networkError: err.message };
    }
    if (res.statusCode === 200) return { ok: true, res };
    text = await readResponseText(res);
    if (res.statusCode === 401) return { statusCode: 401, text, invalid: true };
  }

  return { statusCode: res.statusCode, headers: res.headers, text };
}

// ---------------------------------------------------------------------------
// Account switch events (consumed by the omp extension)
// ---------------------------------------------------------------------------

const accountEvents = [];
let accountEventSeq = 0;
let servedRequests = 0;
const MAX_ACCOUNT_EVENTS = 100;
const rawStatusEvery = Number(process.env.AGY_STATUS_EVERY || 10);
const STATUS_EVERY =
  Number.isFinite(rawStatusEvery) && rawStatusEvery > 0 ? Math.floor(rawStatusEvery) : 10;

function tokenNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function normalizeUsage(usage = {}) {
  const promptTokens = tokenNumber(usage.promptTokenCount);
  const completionTokens = tokenNumber(usage.candidatesTokenCount);
  const thoughtTokens = tokenNumber(usage.thoughtsTokenCount);
  const cachedTokens = tokenNumber(usage.cachedContentTokenCount);
  const totalTokens = tokenNumber(usage.totalTokenCount) ||
    promptTokens + completionTokens + thoughtTokens;
  return { promptTokens, completionTokens, thoughtTokens, cachedTokens, totalTokens };
}

function emptyStatusWindow() {
  return {
    requests: 0,
    usageRequests: 0,
    promptTokens: 0,
    completionTokens: 0,
    thoughtTokens: 0,
    cachedTokens: 0,
    totalTokens: 0,
    last: null,
    startedAt: new Date().toISOString(),
  };
}

let statusWindow = emptyStatusWindow();

function recordSuccessfulRequest({ account, modelId, usage }) {
  servedRequests += 1;
  const tokens = normalizeUsage(usage);
  const reported = Boolean(usage && Object.keys(usage).length);
  if (reported) {
    statusWindow.usageRequests += 1;
    statusWindow.promptTokens += tokens.promptTokens;
    statusWindow.completionTokens += tokens.completionTokens;
    statusWindow.thoughtTokens += tokens.thoughtTokens;
    statusWindow.cachedTokens += tokens.cachedTokens;
    statusWindow.totalTokens += tokens.totalTokens;
  }
  statusWindow.requests += 1;
  statusWindow.last = {
    modelId,
    contextWindow: MODELS[modelId]?.contextWindow || null,
    reported,
    ...tokens,
  };

  if (servedRequests % STATUS_EVERY !== 0) return;

  const stats = {
    ...statusWindow,
    averageTotalTokens: Math.round(
      statusWindow.totalTokens / Math.max(1, statusWindow.usageRequests)
    ),
    averagePromptTokens: Math.round(
      statusWindow.promptTokens / Math.max(1, statusWindow.usageRequests)
    ),
    averageCompletionTokens: Math.round(
      statusWindow.completionTokens / Math.max(1, statusWindow.usageRequests)
    ),
    hasUsage: statusWindow.usageRequests > 0,
  };
  const totalRequests = servedRequests;
  statusWindow = emptyStatusWindow();
  void emitStatusEvent({
    accountId: account.id,
    modelId,
    stats,
    totalRequests,
  });
}

function accountSnapshot(id, modelId) {
  const account = accounts.findAccount(id);
  if (!account) return null;
  const q = account.quota?.[modelId] || {};
  return {
    id: account.id,
    email: account.email,
    project: account.project || accounts.DEFAULT_PROJECT,
    remainingFraction: q.remainingFraction ?? null,
    resetTime: q.exhaustedUntil || q.resetTime || null,
    invalid: Boolean(account.invalid),
    lastError: account.lastError || null,
  };
}

function pushAccountEvent(event) {
  accountEventSeq += 1;
  const full = { seq: accountEventSeq, at: new Date().toISOString(), ...event };
  accountEvents.push(full);
  if (accountEvents.length > MAX_ACCOUNT_EVENTS) accountEvents.shift();

  const from = full.from?.email || full.account?.email || '?';
  const to = full.to?.email || full.account?.email || '?';
  if (full.type === 'switch') {
    console.warn(`[agy] account switch (${full.model}): ${from} -> ${to} [${full.reason}]`);
  } else if (full.type === 'recovered') {
    console.warn(`[agy] account recovered (${full.model}): returning to ${to}`);
  } else if (full.type === 'blocked') {
    console.error(
      `\x1b[31m[agy] BLOCK: ${from || 'account'} rejected by Google (${full.statusCode || '?'}); all accounts have been stopped.\x1b[0m`
    );
  } else if (full.type === 'status') {
    console.log(
      `[agy] status (${full.requests} requests): ${to} | ${full.account?.remainingFraction != null ? Math.round(full.account.remainingFraction * 100) + '% remaining' : 'no reading'} | ${full.window?.totalTokens || 0} tokens in window`
    );
  }
}

function blockedMessage() {
  const block = accounts.getBlock();
  const who = block?.email || block?.accountId || 'an account';
  const detail = block?.message ? ` Detail: ${block.message}` : '';
  return [
    `SECURITY BLOCK: Google rejected ${who} for a possible ban, suspension, or terms violation.${detail}`,
    'The provider stopped using ALL accounts and will not make further attempts.',
    'Resolve the issue with Google, then run: npm run accounts -- unblock',
  ].join(' ');
}

async function emitStatusEvent({ accountId, modelId, stats, totalRequests }) {
  try {
    const account = accounts.findAccount(accountId);
    if (!account) return;
    try { await accounts.refreshAccountMeta(account); } catch {}
    pushAccountEvent({
      type: 'status',
      model: modelId,
      reason: 'periodic',
      requests: totalRequests,
      interval: STATUS_EVERY,
      accountRequests: account.requestCount || 0,
      contextWindow: MODELS[modelId]?.contextWindow || null,
      window: stats,
      account: accountSnapshot(accountId, modelId),
    });
  } catch (err) {
    console.warn(`[agy] failed to record periodic status: ${err.message}`);
  }
}

function emitBlockedEvent({ block, accountId, modelId, statusCode, message }) {
  pushAccountEvent({
    type: 'blocked',
    model: modelId,
    reason: 'ban',
    statusCode: statusCode || null,
    message: String(message || '').slice(0, 1000),
    account: accountSnapshot(accountId, modelId),
    blocked: block,
  });
}

async function refreshSnapshots(ids) {
  for (const id of ids) {
    if (!id) continue;
    const account = accounts.findAccount(id);
    if (!account) continue;
    try { await accounts.refreshAccountMeta(account); } catch {}
  }
}

async function emitSwitchEvent({ fromId, toId, modelId, reason, message }) {
  try {
    await refreshSnapshots([fromId, toId]);
    pushAccountEvent({
      type: 'switch',
      model: modelId,
      reason,
      message: message || null,
      from: accountSnapshot(fromId, modelId),
      to: accountSnapshot(toId, modelId),
    });
  } catch (err) {
    console.warn(`[agy] failed to record account switch: ${err.message}`);
  }
}

async function emitRecoveredEvent({ accountId, previousActive, modelId }) {
  try {
    await refreshSnapshots([accountId, previousActive]);
    pushAccountEvent({
      type: 'recovered',
      model: modelId,
      reason: 'reset',
      from: accountSnapshot(previousActive, modelId),
      to: accountSnapshot(accountId, modelId),
    });
  } catch (err) {
    console.warn(`[agy] failed to record account recovery: ${err.message}`);
  }
}

/**
 * Tries vault accounts in preference order. On a quota 429, marks the account
 * exhausted for that model and moves to the next one. A generic 429 (request
 * limit) does not switch accounts. A 401 refreshes the token and retries;
 * 5xx gets one retry per account. Returns { res } on success or
 * { statusCode, text } on failure.
 */
async function postWithAccounts(body, modelId) {
  const tried = new Set();
  let last = null;
  let pendingSwitch = null;

  if (accounts.isBlocked()) {
    return { statusCode: 403, text: blockedMessage() };
  }

  while (true) {
    if (accounts.isBlocked()) {
      return { statusCode: 403, text: blockedMessage() };
    }
    const account = accounts.selectAccountsFor(modelId).find((a) => !tried.has(a.id));
    if (!account) break;
    tried.add(account.id);

    for (let attempt = 1; attempt <= 2; attempt++) {
      if (accounts.isBlocked()) {
        return { statusCode: 403, text: blockedMessage() };
      }
      const out = await callAccount(body, account);

      if (out.ok) {
        const info = accounts.markSuccess(account.id, modelId);
        if (pendingSwitch && pendingSwitch.fromId !== account.id) {
          void emitSwitchEvent({ ...pendingSwitch, toId: account.id, modelId });
        } else if (info.recovered && info.previousActive !== account.id) {
          void emitRecoveredEvent({
            accountId: account.id,
            previousActive: info.previousActive || null,
            modelId,
          });
        }
        return { res: out.res, account };
      }

      if (out.tokenError) {
        console.warn(`[agy] account ${account.email} unavailable (${out.tokenError}); trying next`);
        if (!pendingSwitch) {
          pendingSwitch = { fromId: account.id, reason: 'invalid', message: out.tokenError };
        }
        last = { statusCode: 502, text: `account ${account.email}: ${out.tokenError}` };
        break;
      }

      if (out.networkError) {
        last = { statusCode: 502, text: `account ${account.email}: ${out.networkError}` };
        if (attempt < 2) {
          await sleep(1500 * attempt);
          continue;
        }
        if (!pendingSwitch) {
          pendingSwitch = { fromId: account.id, reason: 'error', message: out.networkError };
        }
        break;
      }

      // Ban/suspension: stop immediately without trying another account.
      if (accounts.isBanError(out.text)) {
        const block = accounts.blockAll({
          accountId: account.id,
          modelId,
          statusCode: out.statusCode,
          message: out.text.slice(0, 1000),
        });
        emitBlockedEvent({
          block,
          accountId: account.id,
          modelId,
          statusCode: out.statusCode,
          message: out.text,
        });
        return { statusCode: 403, text: blockedMessage() };
      }

      if (out.invalid) {
        accounts.markInvalid(account.id, out.text.slice(0, 300));
        if (!pendingSwitch) {
          pendingSwitch = { fromId: account.id, reason: 'invalid', message: out.text.slice(0, 300) };
        }
      }

      if (out.statusCode === 429) {
        const quota = accounts.parseQuotaExhaustion(out.text);
        if (!quota.isQuota) {
          // Per-request limit (for example, a large Gemini input): switching
          // accounts would not help and would burn the others.
          return { statusCode: 429, headers: out.headers, text: out.text };
        }
        accounts.markExhausted(account.id, modelId, quota.resetAt, quota.message);
        console.warn(
          `[agy] quota for ${modelId} exhausted on ${account.email} (reset ${quota.resetAt}); trying next account`
        );
        if (!pendingSwitch) {
          pendingSwitch = { fromId: account.id, reason: 'quota', message: quota.message };
        }
        last = { statusCode: 429, text: out.text };
        break;
      }

      if (out.statusCode >= 500) {
        last = { statusCode: out.statusCode, text: out.text };
        if (attempt < 2) {
          await sleep(1500 * attempt);
          continue;
        }
        if (!pendingSwitch) {
          pendingSwitch = {
            fromId: account.id,
            reason: 'error',
            message: `HTTP ${out.statusCode}`,
          };
        }
        break;
      }

      return { statusCode: out.statusCode, headers: out.headers, text: out.text };
    }
  }

  const next = accounts.nextResetFor(modelId);
  if (last) {
    const suffix = next
      ? last.statusCode === 429
        ? `\n\nAll vault accounts are out of quota for ${modelId}. Next reset: ${next}.`
        : `\n\nNo vault account could respond for ${modelId}. Next quota available: ${next}.`
      : '';
    return { statusCode: last.statusCode, text: last.text + suffix };
  }
  const err = new Error(
    next
      ? `all vault accounts are out of quota for ${modelId}; next reset at ${next}`
      : `no account available for ${modelId}`
  );
  err.code = 'NO_ACCOUNTS';
  err.statusCode = next ? 429 : 503;
  throw err;
}

function responseStream(res) {
  const encoding = String(res.headers['content-encoding'] || '').toLowerCase();
  if (encoding.includes('gzip')) return res.pipe(zlib.createGunzip());
  if (encoding.includes('deflate')) return res.pipe(zlib.createInflate());
  if (encoding.includes('br')) return res.pipe(zlib.createBrotliDecompress());
  return res;
}

function parseCloudEvents(stream, onEvent, onDone, onError) {
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  let finished = false;

  const finish = () => {
    if (finished) return;
    finished = true;
    onDone();
  };

  stream.on('data', (chunk) => {
    if (finished) return;
    buffer += decoder.write(chunk);
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).replace(/\r$/, '');
      buffer = buffer.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const raw = line.slice(5).trim();
      if (!raw || raw === '[DONE]') continue;
      let parsed;
      try { parsed = JSON.parse(raw); } catch { continue; }
      if (parsed.error) {
        const err = new Error(parsed.error.message || JSON.stringify(parsed.error));
        err.rawText = JSON.stringify(parsed.error || parsed);
        finished = true;
        onError(err);
        return;
      }
      const body = parsed.response || parsed;
      onEvent(body);
    }
  });
  stream.on('end', finish);
  stream.on('error', (err) => {
    if (!finished) {
      finished = true;
      onError(err);
    }
  });
}

function mapFinishReason(reason, hasTools) {
  if (hasTools) return 'tool_calls';
  switch (reason) {
    case 'MAX_TOKENS': return 'length';
    case 'SAFETY':
    case 'RECITATION':
    case 'BLOCKLIST':
    case 'PROHIBITED_CONTENT':
      return 'content_filter';
    default:
      return 'stop';
  }
}

function consumePart(part, state) {
  if (!part) return;
  const out = [];

  if (part.functionCall) {
    if (process.env.AGY_DEBUG_FC === '1') console.log('[agy] functionCall part:', JSON.stringify(part).slice(0, 500));
    const name = part.functionCall.name || 'tool';
    const id = part.functionCall.id || `call_${crypto.randomBytes(12).toString('hex')}`;
    const signature = part.thoughtSignature || state.pendingSignature || null;
    state.pendingSignature = null;
    rememberToolCall(id, name, signature);
    state.toolCalls.push({
      index: state.toolCalls.length,
      id,
      type: 'function',
      function: {
        name,
        arguments: JSON.stringify(part.functionCall.args || {}),
      },
    });
    out.push({ toolCall: state.toolCalls[state.toolCalls.length - 1] });
    return out;
  }

  if (part.thoughtSignature && !part.text) {
    // loose signature: belongs to the next functionCall (or this turn)
    state.pendingSignature = part.thoughtSignature;
    return out;
  }

  if (typeof part.text === 'string' && part.text.length) {
    if (part.thought === true) {
      state.reasoning += part.text;
      out.push({ reasoning: part.text });
    } else {
      state.content += part.text;
      out.push({ content: part.text });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function openAiError(message, status = 500, type = 'api_error') {
  return { error: { message, type, param: null, code: status } };
}

function chunkBase(id, model) {
  return {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
  };
}

function handleStreamFailure(err, res, modelId, account) {
  const raw = err.rawText || err.message || String(err);
  if (accounts.isBanError(raw)) {
    const block = accounts.blockAll({
      accountId: account?.id,
      modelId,
      statusCode: 200,
      message: raw.slice(0, 1000),
    });
    emitBlockedEvent({
      block,
      accountId: account?.id,
      modelId,
      statusCode: 200,
      message: raw,
    });
    const message = blockedMessage();
    if (!res.headersSent) {
      sendJson(res, 403, openAiError(message, 403, 'account_blocked'));
    } else {
      res.write(`data: ${JSON.stringify(openAiError(message, 403, 'account_blocked'))}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    }
    return true;
  }

  if (!res.headersSent) sendJson(res, 502, openAiError(err.message, 502));
  else res.end();
  return false;
}

async function handleChat(req, res, payload) {
  const model = resolveModel(payload.model);
  const stream = payload.stream !== false;
  const id = `chatcmpl-${crypto.randomBytes(12).toString('hex')}`;
  const state = {
    content: '',
    reasoning: '',
    toolCalls: [],
    finishReason: null,
    usage: null,
    pendingSignature: null,
  };

  let cloud;
  try {
    cloud = buildCloudRequest(payload);
  } catch (err) {
    sendJson(res, 400, openAiError(`invalid request: ${err.message}`, 400, 'invalid_request_error'));
    return;
  }

  if (process.env.AGY_DUMP === '1') {
    try {
      fs.mkdirSync(path.join(__dirname, 'logs'), { recursive: true });
      fs.writeFileSync(
        path.join(__dirname, 'logs', 'last-request.json'),
        JSON.stringify({ openai: payload, cloud: cloud.body }, null, 2)
      );
    } catch {}
  }

  let result;
  try {
    result = await postWithAccounts(cloud.body, model.id);
  } catch (err) {
    sendJson(
      res,
      err.statusCode || 502,
      openAiError(`failed to reach Cloud Code: ${err.message}`, err.statusCode || 502)
    );
    return;
  }

  if (!result.res) {
    let text = result.text || 'Cloud Code failure';
    console.error(`[agy] upstream ${result.statusCode}: ${text.slice(0, 800)}`);
    try {
      const parsed = JSON.parse(text);
      text = parsed.error?.message || text;
    } catch {}
    if (!res.headersSent) {
      sendJson(res, result.statusCode || 502, openAiError(text.slice(0, 2000), result.statusCode || 502));
    }
    return;
  }

  const upstream = result.res;
  console.log(
    `[agy] model=${model.id} account=${result.account.email || result.account.id} bytes=${Buffer.byteLength(JSON.stringify(cloud.body))} status=${upstream.statusCode}`
  );

  if (!stream) {
    const events = [];
    parseCloudEvents(
      responseStream(upstream),
      (ev) => {
        const cand = ev.candidates?.[0];
        if (!cand) return;
        for (const part of cand.content?.parts || []) consumePart(part, state);
        if (cand.finishReason) state.finishReason = cand.finishReason;
        if (ev.usageMetadata) state.usage = ev.usageMetadata;
      },
      () => {
        const message = { role: 'assistant', content: state.content || '' };
        if (state.reasoning) message.reasoning_content = state.reasoning;
        if (state.toolCalls.length) message.tool_calls = state.toolCalls;
        const usage = state.usage || {};
        sendJson(res, 200, {
          id,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: model.id,
          choices: [
            {
              index: 0,
              message,
              finish_reason: mapFinishReason(state.finishReason, state.toolCalls.length > 0),
            },
          ],
          usage: {
            prompt_tokens: usage.promptTokenCount || 0,
            completion_tokens: usage.candidatesTokenCount || 0,
            total_tokens: usage.totalTokenCount || 0,
          },
        });
        recordSuccessfulRequest({
          account: result.account,
          modelId: model.id,
          usage: state.usage,
        });
      },
      (err) => {
        handleStreamFailure(err, res, model.id, result.account);
      }
    );
    return;
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });

  let sentRole = false;
  const writeChunk = (delta, finishReason = null) => {
    if (!sentRole) {
      sentRole = true;
      delta = { role: 'assistant', ...delta };
    }
    res.write(`data: ${JSON.stringify({
      ...chunkBase(id, model.id),
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    })}\n\n`);
  };

  parseCloudEvents(
    responseStream(upstream),
    (ev) => {
      const cand = ev.candidates?.[0];
      if (!cand) return;
      for (const part of cand.content?.parts || []) {
        for (const item of consumePart(part, state)) {
          if (item.content) writeChunk({ content: item.content });
          if (item.reasoning) writeChunk({ reasoning_content: item.reasoning });
          if (item.toolCall) {
            writeChunk({
              tool_calls: [
                {
                  index: item.toolCall.index,
                  id: item.toolCall.id,
                  type: 'function',
                  function: item.toolCall.function,
                },
              ],
            });
          }
        }
      }
      if (cand.finishReason) state.finishReason = cand.finishReason;
      if (ev.usageMetadata) state.usage = ev.usageMetadata;
    },
    () => {
      const finish = mapFinishReason(state.finishReason, state.toolCalls.length > 0);
      writeChunk({}, finish);
      if (state.usage) {
        res.write(`data: ${JSON.stringify({
          ...chunkBase(id, model.id),
          choices: [],
          usage: {
            prompt_tokens: state.usage.promptTokenCount || 0,
            completion_tokens: state.usage.candidatesTokenCount || 0,
            total_tokens: state.usage.totalTokenCount || 0,
          },
        })}\n\n`);
      }
      res.write('data: [DONE]\n\n');
      res.end();
      recordSuccessfulRequest({
        account: result.account,
        modelId: model.id,
        usage: state.usage,
      });
    },
    (err) => {
      if (handleStreamFailure(err, res, model.id, result.account)) {
        upstream.destroy();
      }
    }
  );
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/')) {
    const list = accounts.publicList();
    sendJson(res, 200, {
      ok: true,
      provider: 'provider-agy',
      version: VERSION,
      blocked: accounts.getBlock(),
      accounts: list.map((a) => ({
        email: a.email,
        project: a.project,
        active: a.active,
        invalid: a.invalid,
        lastError: a.lastError,
      })),
    });
    return;
  }

  if (req.method === 'GET' && (url.pathname === '/v1/accounts' || url.pathname === '/accounts')) {
    sendJson(res, 200, {
      object: 'list',
      blocked: accounts.getBlock(),
      data: accounts.publicList(),
    });
    return;
  }

  if (
    req.method === 'GET' &&
    (url.pathname === '/v1/accounts/events' || url.pathname === '/accounts/events')
  ) {
    const raw = url.searchParams.get('since');
    const since = raw == null ? -1 : Number(raw);
    const data = Number.isFinite(since) && since >= 0
      ? accountEvents.filter((event) => event.seq > since)
      : [];
    sendJson(res, 200, { object: 'list', lastSeq: accountEventSeq, data });
    return;
  }

  if (req.method === 'GET' && (url.pathname === '/v1/models' || url.pathname === '/models')) {
    sendJson(res, 200, {
      object: 'list',
      data: Object.entries(MODELS).map(([id, def]) => ({
        id,
        object: 'model',
        created: 0,
        owned_by: def.provider === 'google' ? 'google' : def.provider,
        name: def.name,
        context_window: def.contextWindow,
      })),
    });
    return;
  }

  if (req.method === 'POST' && (url.pathname === '/v1/chat/completions' || url.pathname === '/chat/completions')) {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      let payload;
      try { payload = JSON.parse(raw || '{}'); } catch {
        sendJson(res, 400, openAiError('invalid JSON', 400, 'invalid_request_error'));
        return;
      }
      handleChat(req, res, payload).catch((err) => {
        if (!res.headersSent) sendJson(res, 500, openAiError(err.message, 500));
        else res.end();
      });
    });
    return;
  }

  sendJson(res, 404, openAiError('not found', 404, 'invalid_request_error'));
});

server.listen(PORT, HOST, () => {
  console.log(`provider-agy ${VERSION} listening at http://${HOST}:${PORT}/v1`);
  console.log(`models: ${Object.keys(MODELS).join(', ')}`);
  // import the account currently signed in to agy (if not in the vault yet)
  // and refresh project/quota for all accounts in the background
  accounts.bootstrap().then(
    async () => {
      const block = accounts.getBlock();
      if (block) {
        console.error(
          `\x1b[31m[agy] accounts blocked since ${block.at} (${block.email || block.accountId || '?'}): no attempts will be made. Run: npm run accounts -- unblock\x1b[0m`
        );
        return;
      }
      const list = accounts.listAccounts();
      console.log(`vault: ${list.length} account(s) [${list.map((a) => a.email || a.id).join(', ')}]`);
      for (const account of list) {
        try {
          await accounts.refreshAccountMeta(account);
        } catch (err) {
          console.warn(`warning (${account.email || account.id}): ${err.message}`);
        }
      }
      console.log('quotas refreshed');
    },
    (err) => console.error(`warning: ${err.message}`)
  );
});

process.on('SIGINT', () => {
  server.close(() => process.exit(0));
});
process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});
