import crypto from 'node:crypto';

export const day = () => new Intl.DateTimeFormat('en-CA', { timeZone: process.env.GATEWAY_TIMEZONE || 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
export const randomKey = (prefix) => `${prefix}_${crypto.randomBytes(32).toString('base64url')}`;
export const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
export const id = () => crypto.randomUUID();

export function authenticate(state, token) {
  if (!token || !token.startsWith('cg_')) return null;
  const hash = digest(token);
  return state.keys.find(k => k.hash === hash && !k.revoked) || null;
}

export function checkQuota(key, requestedModel) {
  if (key.models.length && !key.models.includes(requestedModel)) return 'model_not_allowed';
  if (key.day !== day()) { key.day = day(); key.requests = 0; key.tokens = 0; }
  if (key.maxRequests > 0 && key.requests + key.active >= key.maxRequests) return 'request_limit_exceeded';
  if (key.maxTokens > 0 && key.tokens >= key.maxTokens) return 'token_limit_exceeded';
  if (key.maxConcurrent > 0 && key.active >= key.maxConcurrent) return 'concurrency_limit_exceeded';
  return null;
}

function textParts(content) {
  if (typeof content === 'string') return [{ type: 'input_text', text: content }];
  if (!Array.isArray(content)) throw Object.assign(new Error('Invalid content blocks'), { status: 400 });
  return content.flatMap(p => {
    if (p.type === 'text') return [{ type: 'input_text', text: p.text || '' }];
    if (p.type === 'image' && p.source?.type === 'base64') return [{ type: 'input_image', image_url: `data:${p.source.media_type};base64,${p.source.data}` }];
    if (p.type === 'image' && p.source?.type === 'url' && /^https:\/\//.test(p.source.url || '')) return [{ type: 'input_image', image_url: p.source.url }];
    if (p.type === 'tool_result') return [];
    throw Object.assign(new Error(`Unsupported content block: ${p.type || 'unknown'}`), { status: 422 });
  });
}

export function toResponses(body, model, { oauth = false, reasoningByCall = null } = {}) {
  const input = [];
  const addedReasoning = new Set();
  const system = typeof body.system === 'string' ? body.system :
    Array.isArray(body.system) ? body.system.filter(x => x.type === 'text').map(x => x.text).join('\n') : '';
  for (const msg of body.messages || []) {
    const blocks = typeof msg.content === 'string' ? [{ type: 'text', text: msg.content }] : msg.content || [];
    if (!Array.isArray(blocks)) throw Object.assign(new Error('Invalid message content'), { status: 400 });
    if (msg.role === 'assistant') {
      for (const p of blocks) if (!['text', 'tool_use', 'thinking', 'redacted_thinking'].includes(p.type)) throw Object.assign(new Error(`Unsupported assistant block: ${p.type || 'unknown'}`), { status: 422 });
      const text = blocks.filter(p => p.type === 'text').map(p => p.text || '').join('');
      if (text) input.push({ role: 'assistant', content: [{ type: 'output_text', text }] });
      for (const p of blocks.filter(p => p.type === 'tool_use')) {
        for (const item of reasoningByCall?.get(p.id) || []) {
          if (!addedReasoning.has(item.id)) { input.push(item); addedReasoning.add(item.id); }
        }
        input.push({ type: 'function_call', call_id: p.id, name: p.name, ...(oauth ? { namespace: 'claude_code' } : {}), arguments: JSON.stringify(p.input || {}) });
      }
    } else if (msg.role === 'user') {
      for (const p of blocks.filter(p => p.type === 'tool_result')) {
        const value = typeof p.content === 'string' ? p.content : Array.isArray(p.content) ? textParts(p.content) : JSON.stringify(p.content ?? '');
        input.push({ type: 'function_call_output', call_id: p.tool_use_id, output: value });
      }
      const parts = textParts(blocks);
      if (parts.length) input.push({ role: 'user', content: parts });
    }
  }
  const tools = (body.tools || []).filter(t => t.name && t.input_schema).map(t => ({ type: 'function', name: t.name, description: t.description || '', parameters: t.input_schema, strict: false }));
  const result = { model, input, stream: true, store: false, include: ['reasoning.encrypted_content'] };
  if (system) result.instructions = system;
  if (tools.length) {
    result.tools = oauth ? [{ type: 'namespace', name: 'claude_code', description: 'Tools executed by the Claude Code client in the local project.', tools }] : tools;
  }
  if (!oauth && Number.isSafeInteger(body.max_tokens) && body.max_tokens > 0) result.max_output_tokens = body.max_tokens;
  if (body.tool_choice?.type === 'none') result.tool_choice = 'none';
  else if (body.tool_choice?.type === 'any') result.tool_choice = 'required';
  else if (body.tool_choice?.type === 'tool' && body.tool_choice.name) result.tool_choice = { type: 'function', name: body.tool_choice.name, ...(oauth ? { namespace: 'claude_code' } : {}) };
  return result;
}

export function createTranslator(requestModel, send, streaming) {
  let responseId = `msg_${id().replaceAll('-', '')}`;
  let started = false, completed = false, failed = null, usage = { input_tokens: 0, output_tokens: 0 };
  let blocks = [], open = new Map(), outputToBlock = new Map(), toolSeen = false, reasoning = [];
  const emit = (event, data) => { if (streaming) send(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
  function start() {
    if (started) return;
    started = true;
    emit('message_start', { type: 'message_start', message: { id: responseId, type: 'message', role: 'assistant', model: requestModel, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
  }
  function add(index, block) {
    start();
    const n = blocks.length;
    blocks.push(block); outputToBlock.set(index, n); open.set(n, true);
    emit('content_block_start', { type: 'content_block_start', index: n, content_block: block.type === 'text' ? { type: 'text', text: '' } : { type: 'tool_use', id: block.id, name: block.name, input: {} } });
    return n;
  }
  function close(n) {
    if (!open.get(n)) return;
    open.set(n, false); emit('content_block_stop', { type: 'content_block_stop', index: n });
  }
  function accept(event) {
    const type = event.type;
    if (type === 'response.created' && event.response?.id) responseId = event.response.id;
    if (type === 'response.output_item.added' && event.item?.type === 'function_call') {
      toolSeen = true;
      add(event.output_index, { type: 'tool_use', id: event.item.call_id, name: event.item.name?.replace(/^claude_code\./, ''), input: {}, raw: '' });
    }
    if (type === 'response.output_text.delta') {
      let n = outputToBlock.get(event.output_index);
      if (n === undefined) n = add(event.output_index, { type: 'text', text: '' });
      blocks[n].text += event.delta || '';
      emit('content_block_delta', { type: 'content_block_delta', index: n, delta: { type: 'text_delta', text: event.delta || '' } });
    }
    if (type === 'response.function_call_arguments.delta') {
      let n = outputToBlock.get(event.output_index);
      if (n === undefined) { toolSeen = true; n = add(event.output_index, { type: 'tool_use', id: event.call_id || `call_${id()}`, name: (event.name || 'unknown').replace(/^claude_code\./, ''), input: {}, raw: '' }); }
      blocks[n].raw += event.delta || '';
      emit('content_block_delta', { type: 'content_block_delta', index: n, delta: { type: 'input_json_delta', partial_json: event.delta || '' } });
    }
    if (type === 'response.output_item.done') {
      const item = event.item || {};
      if (item.type === 'reasoning' && item.encrypted_content) reasoning.push(item);
      let n = outputToBlock.get(event.output_index);
      if (item.type === 'function_call') {
        toolSeen = true;
        if (n === undefined) n = add(event.output_index, { type: 'tool_use', id: item.call_id, name: item.name?.replace(/^claude_code\./, ''), input: {}, raw: '' });
        if (!blocks[n].raw && item.arguments) {
          blocks[n].raw = item.arguments;
          emit('content_block_delta', { type: 'content_block_delta', index: n, delta: { type: 'input_json_delta', partial_json: item.arguments } });
        }
        try { blocks[n].input = JSON.parse(blocks[n].raw || '{}'); } catch { blocks[n].input = {}; }
        close(n);
      } else if (item.type === 'message') {
        const finalText = (item.content || []).filter(p => p.type === 'output_text').map(p => p.text || '').join('');
        if (n === undefined && finalText) { n = add(event.output_index, { type: 'text', text: finalText }); emit('content_block_delta', { type: 'content_block_delta', index: n, delta: { type: 'text_delta', text: finalText } }); }
        if (n !== undefined) close(n);
      }
    }
    if (type === 'response.completed' || type === 'response.incomplete') {
      completed = type === 'response.completed';
      usage = { input_tokens: event.response?.usage?.input_tokens || 0, output_tokens: event.response?.usage?.output_tokens || 0 };
      for (const n of open.keys()) close(n);
      start();
      const stop = completed ? (toolSeen ? 'tool_use' : 'end_turn') : 'max_tokens';
      emit('message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: usage.output_tokens } });
      emit('message_stop', { type: 'message_stop' });
    }
    if (type === 'response.failed' || type === 'error') failed = event.response?.error?.message || event.error?.message || 'Upstream response failed';
  }
  function result() {
    if (failed) throw Error(failed);
    if (!completed) throw Error('Upstream stream ended before response.completed');
    return { id: responseId, type: 'message', role: 'assistant', model: requestModel, content: blocks.map(b => b.type === 'tool_use' ? { type: 'tool_use', id: b.id, name: b.name, input: b.input } : { type: 'text', text: b.text }), stop_reason: toolSeen ? 'tool_use' : 'end_turn', stop_sequence: null, usage };
  }
  return { accept, result, get usage() { return usage; }, get reasoning() { return reasoning; } };
}
