import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { authenticate, checkQuota, createTranslator, day, digest, id, randomKey, toResponses, usageSeries } from './lib.js';
import { ChatGPTAuth } from './oauth.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.GATEWAY_DATA_DIR || path.join(root, '.data');
fs.mkdirSync(dataDir, { recursive: true });
const networkFile = path.join(dataDir, 'network.json');
const network = fs.existsSync(networkFile) ? JSON.parse(fs.readFileSync(networkFile, 'utf8')) : {};
const proxyUrl = (process.env.GATEWAY_PROXY_URL || network.proxyUrl || '').trim();
if (proxyUrl) {
  const parsed = new URL(proxyUrl);
  if (!['http:', 'https:'].includes(parsed.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) {
    throw Error('GATEWAY_PROXY_URL must be a local HTTP or HTTPS proxy URL');
  }
  if (typeof http.setGlobalProxyFromEnv !== 'function') {
    throw Error('Local proxy support requires Node.js 22.21+ or 24.5+');
  }
  http.setGlobalProxyFromEnv({ http_proxy: proxyUrl, https_proxy: proxyUrl, no_proxy: 'localhost,127.0.0.1,[::1]' });
}
const stateFile = path.join(dataDir, 'state.json');
const adminFile = path.join(dataDir, 'admin-token');
const host = process.env.GATEWAY_HOST || '127.0.0.1';
if (host !== '127.0.0.1') throw Error('This version only binds to 127.0.0.1');
const port = Number(process.env.GATEWAY_PORT || 8765);
const upstream = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
const staticToken = process.env.OPENAI_API_KEY || process.env.OPENAI_ACCESS_TOKEN || '';
const chatgpt = new ChatGPTAuth(dataDir, port);
const oauth = !process.env.OPENAI_API_KEY;
const upstreamConfigured = () => !!staticToken || !!chatgpt.data.profiles.find(p => p.clientId === chatgpt.data.selected && p.refreshToken);
const upstreamUrl = () => oauth && !staticToken ? 'https://api.openai.com/v1' : upstream;
const reasoningCache = new Map();

if (!fs.existsSync(adminFile)) fs.writeFileSync(adminFile, randomKey('admin'), { mode: 0o600 });
const adminToken = fs.readFileSync(adminFile, 'utf8').trim();
let state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {
  models: { 'codex-sol': 'gpt-6.1-sol' }, keys: [], log: [], usageDaily: {}
};
if (!state.usageDaily) {
  const today = day();
  const keys = state.keys.filter(key => key.day === today);
  state.usageDaily = { [today]: { requests: keys.reduce((sum, key) => sum + key.requests, 0), inputTokens: 0, outputTokens: 0, legacyTokens: keys.reduce((sum, key) => sum + key.tokens, 0) } };
}
for (const key of state.keys) key.active = 0;
function usageBucket(date = day()) {
  const bucket = state.usageDaily[date] ||= { requests: 0, inputTokens: 0, outputTokens: 0 };
  const cutoff = new Date(); cutoff.setUTCDate(cutoff.getUTCDate() - 400);
  const oldest = cutoff.toISOString().slice(0, 10);
  for (const key of Object.keys(state.usageDaily)) if (key < oldest) delete state.usageDaily[key];
  return bucket;
}
let savePending = Promise.resolve();
function save() {
  const snapshot = JSON.stringify(state, (key, value) => key === 'active' ? undefined : value, 2);
  savePending = savePending.then(async () => {
    const tmp = `${stateFile}.${process.pid}.tmp`;
    await fs.promises.writeFile(tmp, snapshot, { mode: 0o600 });
    await fs.promises.rename(tmp, stateFile);
  });
  return savePending;
}
if (!fs.existsSync(stateFile)) await save();

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(body);
}
function error(res, status, message, type = 'invalid_request_error') {
  json(res, status, { type: 'error', error: { type, message } });
}
function authResult(res, success, message) {
  const safe = String(message).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const title = success ? 'ChatGPT 账号已连接' : 'ChatGPT 授权未完成';
  const body = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f4f7fc;color:#17233e;font:15px/1.7 system-ui,sans-serif}.card{box-sizing:border-box;width:min(560px,calc(100% - 36px));padding:38px;background:#fff;border:1px solid #e6eaf2;border-radius:20px;box-shadow:0 18px 50px #18315a16}h1{font-size:25px;line-height:1.3;margin:0 0 15px}p{color:#52637d;overflow-wrap:anywhere}a{display:inline-block;margin-top:12px;padding:10px 16px;border-radius:9px;background:#315ee4;color:#fff;text-decoration:none}</style><main class="card"><h1>${title}</h1><p>${safe}</p><a href="/">返回管理器</a></main></html>`;
  res.writeHead(success ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'", 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(body);
}
async function readJson(req) {
  let size = 0, chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 8 * 1024 * 1024) throw Object.assign(new Error('Request too large'), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }
}
function bearer(req) {
  const auth = req.headers.authorization || '';
  return auth.startsWith('Bearer ') ? auth.slice(7) : req.headers['x-api-key'];
}
function safeKey(key) {
  const { hash, ...rest } = key;
  if (rest.day !== day()) { rest.requests = 0; rest.tokens = 0; rest.day = day(); }
  return rest;
}
function admin(req) {
  const input = req.headers['x-admin-token'];
  if (typeof input !== 'string' || input.length !== adminToken.length) return false;
  return Buffer.from(input).equals(Buffer.from(adminToken));
}
function log(key, model, status, usage, message = '') {
  state.log.unshift({ time: new Date().toISOString(), key: key.name, model, status, inputTokens: usage.input_tokens || 0, outputTokens: usage.output_tokens || 0, message: message.slice(0, 200) });
  state.log = state.log.slice(0, 100);
}

async function handleAdmin(req, res, url) {
  if (!admin(req)) return error(res, 401, 'Admin token required', 'authentication_error');
  const route = url.pathname;
  if (req.method === 'GET' && route === '/admin/api/status') return json(res, 200, {
    baseUrl: `http://${host}:${port}`, upstreamConfigured: upstreamConfigured(), authMode: process.env.OPENAI_API_KEY ? 'openai-api-key' : 'chatgpt-plan', chatgpt: chatgpt.status(),
    models: state.models, keys: state.keys.map(safeKey), log: state.log,
    usage: { day: usageSeries(state.usageDaily, 'day'), week: usageSeries(state.usageDaily, 'week'), month: usageSeries(state.usageDaily, 'month') }
  });
  if (req.method === 'POST' && route === '/admin/api/chatgpt/start') {
    const body = await readJson(req);
    return json(res, 200, { url: await chatgpt.start(body.clientId || null) });
  }
  if (req.method === 'POST' && route === '/admin/api/chatgpt/select') {
    const body = await readJson(req);
    chatgpt.select(body.clientId); return json(res, 200, chatgpt.status());
  }
  if (req.method === 'GET' && route === '/admin/api/upstream/models') {
    const token = staticToken || await chatgpt.token();
    if (!token) return error(res, 503, 'Connect an upstream account first');
    const response = await fetch(`${upstreamUrl()}/models`, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) return error(res, response.status, `Model lookup failed: ${response.status}`);
    const body = await response.json();
    const models = (body.models || body.data || []).filter(x => !x.visibility || x.visibility === 'list').map(x => ({ id: x.slug || x.id, name: x.display_name || x.id || x.slug }));
    return json(res, 200, { models });
  }
  if (req.method === 'POST' && route === '/admin/api/keys') {
    const body = await readJson(req);
    const name = String(body.name || '').trim();
    if (!name || name.length > 80) return error(res, 400, 'Name must be 1–80 characters');
    const maxRequests = Number(body.maxRequests || 0), maxTokens = Number(body.maxTokens || 0), maxConcurrent = Number(body.maxConcurrent || 1);
    if (![maxRequests, maxTokens, maxConcurrent].every(x => Number.isSafeInteger(x) && x >= 0) || maxConcurrent < 1) return error(res, 400, 'Invalid quota');
    const models = Array.isArray(body.models) ? body.models.filter(x => typeof x === 'string' && state.models[x]) : [];
    const raw = randomKey('cg');
    const key = { id: id(), name, prefix: raw.slice(0, 10), hash: digest(raw), createdAt: new Date().toISOString(), revoked: false, models, maxRequests, maxTokens, maxConcurrent, day: day(), requests: 0, tokens: 0, active: 0 };
    state.keys.push(key); await save();
    return json(res, 201, { key: raw, record: safeKey(key) });
  }
  const match = route.match(/^\/admin\/api\/keys\/([0-9a-f-]+)$/);
  if (match && req.method === 'PATCH') {
    const key = state.keys.find(x => x.id === match[1]);
    if (!key) return error(res, 404, 'Key not found');
    const body = await readJson(req);
    for (const field of ['maxRequests', 'maxTokens', 'maxConcurrent']) {
      if (body[field] !== undefined) {
        if (!Number.isSafeInteger(body[field]) || body[field] < (field === 'maxConcurrent' ? 1 : 0)) return error(res, 400, `Invalid ${field}`);
        key[field] = body[field];
      }
    }
    if (body.revoked !== undefined) key.revoked = !!body.revoked;
    if (body.models !== undefined) {
      if (!Array.isArray(body.models) || body.models.some(x => !state.models[x])) return error(res, 400, 'Invalid models');
      key.models = body.models;
    }
    await save(); return json(res, 200, safeKey(key));
  }
  if (req.method === 'PUT' && route === '/admin/api/models') {
    const body = await readJson(req);
    if (!body || typeof body !== 'object' || Array.isArray(body) || !Object.keys(body).length || Object.keys(body).length > 30 ||
        Object.entries(body).some(([alias, model]) => !/^[a-zA-Z0-9._-]{1,80}$/.test(alias) || typeof model !== 'string' || !/^[a-zA-Z0-9._-]{1,120}$/.test(model))) return error(res, 400, 'Invalid model map');
    state.models = body; await save(); return json(res, 200, state.models);
  }
  error(res, 404, 'Not found');
}

async function runInference(req, res, body, key) {
  let upstreamToken;
  try { upstreamToken = staticToken || await chatgpt.token(); }
  catch (e) { return error(res, 503, e.message); }
  if (!upstreamToken) return error(res, 503, 'Connect a ChatGPT account or set OPENAI_API_KEY before starting inference');
  if (!body || !Array.isArray(body.messages) || !body.messages.length) return error(res, 400, 'messages must be a nonempty array');
  const alias = body.model;
  const model = state.models[alias];
  if (!model) return error(res, 404, `Unknown model: ${alias}`);
  const quotaError = checkQuota(key, alias);
  if (quotaError) return error(res, 429, quotaError, 'rate_limit_error');
  let payload;
  const perKeyReasoning = new Map();
  for (const msg of body.messages) for (const block of (Array.isArray(msg.content) ? msg.content : [])) {
    if (block.type === 'tool_use' && block.id) {
      const saved = reasoningCache.get(`${key.id}:${block.id}`);
      if (saved && saved.expiresAt > Date.now()) perKeyReasoning.set(block.id, saved.items);
    }
  }
  try { payload = toResponses(body, model, { oauth, reasoningByCall: perKeyReasoning }); }
  catch (e) { return error(res, e.status || 400, e.message); }
  const requestId = id();
  key.active++; key.requests++; usageBucket().requests++;
  await save();
  const controller = new AbortController();
  res.on('close', () => { if (!res.writableEnded) controller.abort(); });
  let translator;
  try {
    const upstreamResponse = await fetch(`${upstreamUrl()}/responses`, {
      method: 'POST', headers: { 'Authorization': `Bearer ${upstreamToken}`, 'Content-Type': 'application/json', 'X-Client-Request-Id': requestId },
      body: JSON.stringify(payload), signal: controller.signal
    });
    if (!upstreamResponse.ok) {
      const text = (await upstreamResponse.text()).slice(0, 2000);
      log(key, alias, upstreamResponse.status, {}, text); await save();
      return error(res, upstreamResponse.status, `Upstream: ${text}`);
    }
    if (body.stream) res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
    translator = createTranslator(alias, data => res.write(data), !!body.stream);
    let pending = '';
    const decoder = new TextDecoder();
    for await (const chunk of upstreamResponse.body) {
      pending += decoder.decode(chunk, { stream: true });
      let boundary;
      while ((boundary = /\r?\n\r?\n/.exec(pending)) !== null) {
        const frame = pending.slice(0, boundary.index).replaceAll('\r', ''); pending = pending.slice(boundary.index + boundary[0].length);
        const data = frame.split('\n').filter(x => x.startsWith('data:')).map(x => x.slice(5).trimStart()).join('\n');
        if (!data || data === '[DONE]') continue;
        try { translator.accept(JSON.parse(data)); } catch (e) { if (e instanceof SyntaxError) throw Error('Invalid upstream stream frame'); else throw e; }
      }
    }
    const result = translator.result();
    for (const block of result.content) if (block.type === 'tool_use' && translator.reasoning.length) reasoningCache.set(`${key.id}:${block.id}`, { items: translator.reasoning, expiresAt: Date.now() + 30 * 60_000 });
    if (reasoningCache.size > 1000) for (const [cacheKey, value] of reasoningCache) if (value.expiresAt < Date.now()) reasoningCache.delete(cacheKey);
    key.tokens += result.usage.input_tokens + result.usage.output_tokens;
    const bucket = usageBucket();
    bucket.inputTokens += result.usage.input_tokens;
    bucket.outputTokens += result.usage.output_tokens;
    log(key, alias, 200, result.usage); await save();
    if (body.stream) res.end(); else json(res, 200, result);
  } catch (e) {
    log(key, alias, 502, translator?.usage || {}, e.message); await save();
    if (res.headersSent) {
      res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message: e.message } })}\n\n`); res.end();
    } else error(res, 502, e.message, 'api_error');
  } finally { key.active--; await save(); }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true, upstreamConfigured: upstreamConfigured() });
    if (req.method === 'GET' && url.pathname === '/auth/callback') {
      try {
        await chatgpt.complete(url.toString());
        return authResult(res, true, '授权成功。现在可以返回管理器查看已连接的账号。');
      } catch (e) { return authResult(res, false, e.message); }
    }
    if (req.method === 'GET' && url.pathname === '/') {
      const html = await fs.promises.readFile(path.join(root, 'web', 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'", 'X-Frame-Options': 'DENY', 'Cache-Control': 'no-store' });
      return res.end(html);
    }
    if (req.method === 'GET' && url.pathname === '/app.js') {
      const js = await fs.promises.readFile(path.join(root, 'web', 'app.js'));
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(js);
    }
    if (req.method === 'GET' && url.pathname === '/app.css') {
      const css = await fs.promises.readFile(path.join(root, 'web', 'app.css'));
      res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(css);
    }
    if (req.method === 'HEAD' && url.pathname === '/api/hello') { res.writeHead(200); return res.end(); }
    if (url.pathname.startsWith('/admin/api/')) return await handleAdmin(req, res, url);
    if (url.pathname === '/v1/models' && req.method === 'GET') {
      const key = authenticate(state, bearer(req));
      if (!key) return error(res, 401, 'Invalid API key', 'authentication_error');
      return json(res, 200, { data: Object.keys(state.models).filter(m => !key.models.length || key.models.includes(m)).map(m => ({ id: m, object: 'model' })), object: 'list' });
    }
    if (url.pathname === '/v1/messages/count_tokens' && req.method === 'POST') {
      const key = authenticate(state, bearer(req));
      if (!key) return error(res, 401, 'Invalid API key', 'authentication_error');
      const body = await readJson(req);
      const chars = JSON.stringify(body.messages || []).length + JSON.stringify(body.system || '').length;
      return json(res, 200, { input_tokens: Math.ceil(chars / 4), estimated: true });
    }
    if (url.pathname === '/v1/messages' && req.method === 'POST') {
      const key = authenticate(state, bearer(req));
      if (!key) return error(res, 401, 'Invalid API key', 'authentication_error');
      return await runInference(req, res, await readJson(req), key);
    }
    error(res, 404, 'Not found');
  } catch (e) { if (!res.headersSent) error(res, e.status || 500, e.message || 'Internal error'); else res.end(); }
});
server.listen(port, host, () => {
  console.log(`Gateway: http://${host}:${port}`);
  console.log(`Admin token file: ${adminFile}`);
  console.log(`Outbound proxy: ${proxyUrl ? new URL(proxyUrl).host : 'disabled'}`);
  console.log(`Upstream: ${upstreamConfigured() ? (oauth ? 'ChatGPT plan' : 'OpenAI API key') : 'not configured'}`);
});
