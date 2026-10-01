// Optional manual compatibility check against the installed Claude Code CLI.
// All inference is served by a local mock, so no OpenAI/ChatGPT account is used.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-claude-smoke-'));
let upstreamCalls = 0;
let sawToolResult = false;
const mock = http.createServer(async (req, res) => {
  if (req.url === '/v1/models') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ data: [{ id: 'gpt-6.1-sol' }] })); }
  if (req.url !== '/v1/responses') { res.writeHead(404); return res.end(); }
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  upstreamCalls++;
  if (upstreamCalls > 1) sawToolResult ||= body.input?.some(item => item.type === 'function_call_output' && item.call_id === 'call_smoke');
  console.log(`Upstream request: model=${body.model}, tools=${body.tools?.length || 0}, inputs=${body.input?.length || 0}`);
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const args = JSON.stringify({ file_path: path.join(root, 'package.json') });
  const events = upstreamCalls === 1 ? [
    { type: 'response.created', response: { id: 'resp_smoke_tool' } },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'call_smoke', name: 'Read', arguments: '' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, delta: args },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', call_id: 'call_smoke', name: 'Read', arguments: args } },
    { type: 'response.completed', response: { usage: { input_tokens: 5, output_tokens: 1 } } }
  ] : [
    { type: 'response.created', response: { id: 'resp_smoke_text' } },
    { type: 'response.output_text.delta', output_index: 0, delta: 'OK' },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'message', content: [{ type: 'output_text', text: 'OK' }] } },
    { type: 'response.completed', response: { usage: { input_tokens: 5, output_tokens: 1 } } }
  ];
  for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`);
  res.end('data: [DONE]\n\n');
});
let gateway, claude;
try {
  await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
  const tempServer = http.createServer();
  await new Promise(resolve => tempServer.listen(0, '127.0.0.1', resolve));
  const port = tempServer.address().port;
  await new Promise(resolve => tempServer.close(resolve));
  gateway = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, GATEWAY_PORT: String(port), GATEWAY_DATA_DIR: dataDir, OPENAI_API_KEY: 'smoke-test', OPENAI_BASE_URL: `http://127.0.0.1:${mock.address().port}/v1` }, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { ready = (await fetch(`${base}/health`)).ok; if (ready) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  if (!ready) throw Error('Gateway did not start');
  const adminToken = fs.readFileSync(path.join(dataDir, 'admin-token'), 'utf8').trim();
  const response = await fetch(`${base}/admin/api/keys`, { method: 'POST', headers: { 'X-Admin-Token': adminToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'smoke', maxRequests: 10, maxTokens: 100000, maxConcurrent: 1 }) });
  const { key } = await response.json();
  const cli = path.join(process.env.APPDATA, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
  if (!fs.existsSync(cli)) throw Error('Claude Code CLI executable not found');
  claude = spawn(cli, ['-p', 'Read package.json, then reply with exactly OK', '--model', 'codex-sol', '--max-turns', '2', '--no-session-persistence'], {
    cwd: root, env: { ...process.env, ANTHROPIC_BASE_URL: base, ANTHROPIC_AUTH_TOKEN: key, ANTHROPIC_MODEL: 'codex-sol', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'codex-sol', ANTHROPIC_DEFAULT_SONNET_MODEL: 'codex-sol', ANTHROPIC_DEFAULT_OPUS_MODEL: 'codex-sol', CLAUDE_CODE_SUBAGENT_MODEL: 'codex-sol', CI: '1' }, stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '', stderr = '';
  claude.stdout.on('data', chunk => stdout += chunk.toString());
  claude.stderr.on('data', chunk => stderr += chunk.toString());
  let timer;
  const exitCode = await Promise.race([
    new Promise(resolve => claude.on('exit', resolve)),
    new Promise((_, reject) => { timer = setTimeout(() => { claude.kill(); reject(Error('Claude Code smoke test timed out')); }, 60000); })
  ]).finally(() => clearTimeout(timer));
  console.log(`Claude Code exit: ${exitCode}`);
  console.log(`Output: ${stdout.slice(0, 2000)}`);
  if (stderr) console.log(`Stderr: ${stderr.slice(0, 2000)}`);
  console.log(`Upstream calls: ${upstreamCalls}`);
  console.log(`Tool result returned: ${sawToolResult}`);
  if (exitCode !== 0 || !stdout.includes('OK') || upstreamCalls < 2 || !sawToolResult) process.exitCode = 1;
} finally {
  claude?.kill(); gateway?.kill(); mock.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
