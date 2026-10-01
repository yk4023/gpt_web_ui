import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { authenticate, checkQuota, createTranslator, digest, toResponses } from '../lib.js';
import { ChatGPTAuth } from '../oauth.js';

test('Anthropic tool messages convert to Responses calls and results', () => {
  const body = { model: 'codex-sol', messages: [
    { role: 'user', content: 'Read a file' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'Read', input: { file_path: 'a.txt' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'hello' }] }
  ], tools: [{ name: 'Read', description: 'Read a file', input_schema: { type: 'object', properties: { file_path: { type: 'string' } } } }] };
  const result = toResponses(body, 'gpt-test');
  assert.equal(result.input[1].type, 'function_call');
  assert.equal(result.input[2].type, 'function_call_output');
  assert.equal(result.tools[0].name, 'Read');
  const oauthResult = toResponses(body, 'gpt-test', { oauth: true });
  assert.equal(oauthResult.tools[0].type, 'namespace');
  assert.equal(oauthResult.input[1].name, 'Read');
  assert.equal(oauthResult.input[1].namespace, 'claude_code');
});

test('ChatGPT sign-in verifies identity and renews an expiring token', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-oauth-test-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-kid', use: 'sig' };
  let nonce = '';
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const idToken = () => {
    const data = `${encode({ alg: 'RS256', kid: 'test-kid' })}.${encode({ iss: 'https://auth.openai.com', aud: 'oaiapp_test', sub: 'user-1', email: 'test@example.com', nonce, exp: Math.floor(Date.now() / 1000) + 3600 })}`;
    return `${data}.${crypto.sign('RSA-SHA256', Buffer.from(data), privateKey).toString('base64url')}`;
  };
  const fetcher = async (url, options) => {
    if (url.endsWith('/oauth/token')) {
      const refresh = options.body.get('grant_type') === 'refresh_token';
      return new Response(JSON.stringify(refresh ? { access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 } :
        { id_token: idToken(), access_token: 'first-access', refresh_token: 'first-refresh', expires_in: 3600, scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct' }), { status: 200 });
    }
    if (url.endsWith('/.well-known/openid-configuration')) return new Response(JSON.stringify({ issuer: 'https://auth.openai.com', jwks_uri: 'https://auth.openai.com/keys' }));
    if (url.endsWith('/keys')) return new Response(JSON.stringify({ keys: [jwk] }));
    throw Error(`Unexpected URL: ${url}`);
  };
  const auth = new ChatGPTAuth(tmp, 8765, fetcher);
  const authorize = new URL(await auth.start());
  assert.equal(authorize.searchParams.get('client_id'), 'dynamic_agent_client');
  const state = authorize.searchParams.get('state');
  nonce = auth.pending.get(state).nonce;
  await auth.complete(`http://127.0.0.1:8765/auth/callback?state=${state}&code=test-code&client_id=oaiapp_test`);
  assert.equal(await auth.token(), 'first-access');
  auth.data.profiles[0].expiresAt = 0;
  assert.equal(await auth.token(), 'new-access');
  assert.equal(auth.status().profiles[0].email, 'test@example.com');
});

test('ChatGPT sign-in reports the upstream token error without saving a profile', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-oauth-error-test-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const auth = new ChatGPTAuth(tmp, 8765, async () => new Response(JSON.stringify({
    error: { code: 'unsupported_country_region_territory', message: 'Country, region, or territory not supported' }
  }), { status: 403, headers: { 'Content-Type': 'application/json', 'x-request-id': 'req_test' } }));
  const state = new URL(await auth.start()).searchParams.get('state');
  await assert.rejects(
    auth.complete(`http://127.0.0.1:8765/auth/callback?state=${state}&code=test-code&client_id=oaiapp_test`),
    /HTTP 403 \(unsupported_country_region_territory\); request ID req_test.*地区不受 OpenAI 服务支持/
  );
  assert.equal(auth.status().profiles.length, 0);
});

test('translator emits a complete tool-use event sequence', () => {
  const frames = [];
  const translator = createTranslator('codex-sol', frame => frames.push(frame), true);
  translator.accept({ type: 'response.created', response: { id: 'resp_1' } });
  translator.accept({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'call_1', name: 'Read' } });
  translator.accept({ type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"file_path":"a.txt"}' });
  translator.accept({ type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', call_id: 'call_1', name: 'Read', arguments: '{"file_path":"a.txt"}' } });
  translator.accept({ type: 'response.completed', response: { usage: { input_tokens: 12, output_tokens: 5 } } });
  assert.equal(translator.result().content[0].input.file_path, 'a.txt');
  assert.equal(translator.result().stop_reason, 'tool_use');
  assert.deepEqual(frames.map(f => f.match(/^event: ([^\n]+)/)[1]), ['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']);
});

test('quota uses the current day and rejects revoked keys', () => {
  const token = 'cg_example';
  const key = { hash: digest(token), revoked: false, models: [], day: '2000-01-01', requests: 100, tokens: 100, active: 0, maxRequests: 1, maxTokens: 10, maxConcurrent: 1 };
  assert.equal(authenticate({ keys: [key] }, token), key);
  assert.equal(checkQuota(key, 'codex-sol'), null);
  key.requests = 1;
  assert.equal(checkQuota(key, 'codex-sol'), 'request_limit_exceeded');
  key.revoked = true;
  assert.equal(authenticate({ keys: [key] }, token), null);
});

test('local server creates a key, forwards a request, and records usage', async t => {
  const mock = http.createServer(async (req, res) => {
    if (req.url !== '/v1/responses') { res.writeHead(404); return res.end(); }
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    assert.equal(body.model, 'gpt-6.1-sol');
    assert.equal(body.store, false);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const item of [
      { type: 'response.created', response: { id: 'resp_test' } },
      { type: 'response.output_text.delta', output_index: 0, delta: 'hello' },
      { type: 'response.output_item.done', output_index: 0, item: { type: 'message', content: [{ type: 'output_text', text: 'hello' }] } },
      { type: 'response.completed', response: { usage: { input_tokens: 7, output_tokens: 2 } } }
    ]) res.write(`data: ${JSON.stringify(item)}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
  t.after(() => mock.close());
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-gateway-test-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const tempServer = http.createServer();
  await new Promise(resolve => tempServer.listen(0, '127.0.0.1', resolve));
  const port = tempServer.address().port;
  await new Promise(resolve => tempServer.close(resolve));
  const child = spawn(process.execPath, ['server.js'], { cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), env: { ...process.env, GATEWAY_PORT: String(port), GATEWAY_DATA_DIR: tmp, OPENAI_BASE_URL: `http://127.0.0.1:${mock.address().port}/v1`, OPENAI_API_KEY: 'test-key' }, stdio: 'ignore' });
  t.after(() => child.kill());
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { ready = (await fetch(`${base}/health`)).ok; if (ready) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert.equal(ready, true, 'server started');
  const adminToken = fs.readFileSync(path.join(tmp, 'admin-token'), 'utf8').trim();
  const keyResponse = await fetch(`${base}/admin/api/keys`, { method: 'POST', headers: { 'X-Admin-Token': adminToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'test', maxRequests: 2, maxTokens: 100, maxConcurrent: 1 }) });
  assert.equal(keyResponse.status, 201);
  const { key } = await keyResponse.json();
  const message = stream => fetch(`${base}/v1/messages`, { method: 'POST', headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'codex-sol', stream, messages: [{ role: 'user', content: 'hi' }] }) });
  const streamed = await message(true);
  assert.equal(streamed.status, 200);
  assert.match(streamed.headers.get('content-type'), /text\/event-stream/);
  const events = await streamed.text();
  assert.match(events, /event: message_start/);
  assert.match(events, /event: content_block_delta/);
  assert.match(events, /event: message_stop/);
  const result = await message();
  assert.equal(result.status, 200);
  assert.equal((await result.json()).content[0].text, 'hello');
  const limited = await message();
  assert.equal(limited.status, 429);
  const status = await fetch(`${base}/admin/api/status`, { headers: { 'X-Admin-Token': adminToken } });
  assert.equal((await status.json()).keys[0].tokens, 18);
});
