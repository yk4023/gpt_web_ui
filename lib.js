import crypto from 'node:crypto';

export const day = () => new Intl.DateTimeFormat('en-CA', { timeZone: process.env.GATEWAY_TIMEZONE || 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
export const hour = () => new Intl.DateTimeFormat('en-CA', { timeZone: process.env.GATEWAY_TIMEZONE || 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).format(new Date()).replace(', ', ' ');
export function hourlyUsageSeries(hourly, now = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: process.env.GATEWAY_TIMEZONE || 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' });
  return Array.from({ length: 24 }, (_, index) => {
    const date = formatter.format(new Date(now.getTime() - (23 - index) * 3_600_000)).replace(', ', ' ');
    return { date, requests: 0, inputTokens: 0, outputTokens: 0, legacyTokens: 0, ...hourly[date] };
  });
}
export function usageSeries(daily, period, today = day()) {
  const date = new Date(`${today}T00:00:00Z`);
  if (period === 'week') date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  if (period === 'month') date.setUTCDate(1);
  const count = period === 'day' ? 14 : 12;
  const points = [];
  for (let offset = count - 1; offset >= 0; offset--) {
    const start = new Date(date);
    if (period === 'month') start.setUTCMonth(start.getUTCMonth() - offset);
    else start.setUTCDate(start.getUTCDate() - offset * (period === 'week' ? 7 : 1));
    const end = new Date(start);
    if (period === 'month') end.setUTCMonth(end.getUTCMonth() + 1);
    else end.setUTCDate(end.getUTCDate() + (period === 'week' ? 7 : 1));
    const startKey = start.toISOString().slice(0, 10), endKey = end.toISOString().slice(0, 10);
    const point = { date: startKey, requests: 0, inputTokens: 0, outputTokens: 0, legacyTokens: 0 };
    for (const [key, value] of Object.entries(daily)) {
      if (key >= startKey && key < endKey) {
        point.requests += value.requests || 0;
        point.inputTokens += value.inputTokens || 0;
        point.outputTokens += value.outputTokens || 0;
        point.legacyTokens += value.legacyTokens || 0;
      }
    }
    points.push(point);
  }
  return points;
}
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

export function toResponses(body, model, { oauth = false, reasoningByCall = null, reasoningEffort = '' } = {}) {
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
  if (reasoningEffort) result.reasoning = { effort: reasoningEffort };
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

export function openaiToAnthropic(body) {
  if (!body || !Array.isArray(body.messages) || !body.messages.length) throw Object.assign(new Error('messages must be a nonempty array'), { status: 400 });
  if (body.n !== undefined && body.n !== 1) throw Object.assign(new Error('Only n=1 is supported'), { status: 422 });
  if (body.response_format && body.response_format.type !== 'text') throw Object.assign(new Error('Only text response_format is supported'), { status: 422 });
  if (body.modalities || body.audio) throw Object.assign(new Error('Audio output is not supported'), { status: 422 });
  const system = [];
  const messages = [];
  for (const message of body.messages) {
    if (message.role === 'system' || message.role === 'developer') {
      if (typeof message.content !== 'string') throw Object.assign(new Error('Unsupported system content'), { status: 422 });
      system.push(message.content);
    } else if (message.role === 'tool') {
      if (!message.tool_call_id) throw Object.assign(new Error('tool_call_id is required'), { status: 400 });
      messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: message.tool_call_id, content: String(message.content ?? '') }] });
    } else if (message.role === 'assistant') {
      if (message.content !== null && message.content !== undefined && typeof message.content !== 'string') throw Object.assign(new Error('Unsupported assistant content'), { status: 422 });
      if (message.tool_calls !== undefined && !Array.isArray(message.tool_calls)) throw Object.assign(new Error('Invalid tool_calls'), { status: 400 });
      const content = [];
      if (typeof message.content === 'string' && message.content) content.push({ type: 'text', text: message.content });
      for (const call of message.tool_calls || []) {
        if (call.type !== 'function' || !call.id || !call.function?.name) throw Object.assign(new Error('Unsupported tool call'), { status: 422 });
        let input;
        try { input = JSON.parse(call.function.arguments || '{}'); } catch { throw Object.assign(new Error('Invalid tool call arguments'), { status: 400 }); }
        content.push({ type: 'tool_use', id: call.id, name: call.function.name, input });
      }
      messages.push({ role: 'assistant', content });
    } else if (message.role === 'user') {
      if (typeof message.content === 'string') messages.push({ role: 'user', content: message.content });
      else if (Array.isArray(message.content)) {
        const content = message.content.map(part => {
          if (part.type === 'text') return { type: 'text', text: part.text || '' };
          if (part.type === 'image_url' && typeof part.image_url?.url === 'string') {
            const url = part.image_url.url;
            const match = /^data:([^;]+);base64,(.+)$/.exec(url);
            return { type: 'image', source: match ? { type: 'base64', media_type: match[1], data: match[2] } : { type: 'url', url } };
          }
          throw Object.assign(new Error(`Unsupported user content: ${part.type || 'unknown'}`), { status: 422 });
        });
        messages.push({ role: 'user', content });
      } else throw Object.assign(new Error('Unsupported user content'), { status: 422 });
    } else throw Object.assign(new Error(`Unsupported message role: ${message.role || 'unknown'}`), { status: 422 });
  }
  if (body.tools !== undefined && !Array.isArray(body.tools)) throw Object.assign(new Error('Invalid tools'), { status: 400 });
  const tools = (body.tools || []).map(tool => {
    if (tool.type !== 'function' || !tool.function?.name || !tool.function?.parameters) throw Object.assign(new Error('Unsupported tool definition'), { status: 422 });
    return { name: tool.function.name, description: tool.function.description || '', input_schema: tool.function.parameters };
  });
  let tool_choice;
  if (body.tool_choice === 'none') tool_choice = { type: 'none' };
  else if (body.tool_choice === 'required') tool_choice = { type: 'any' };
  else if (body.tool_choice?.type === 'function') {
    if (!body.tool_choice.function?.name) throw Object.assign(new Error('tool_choice.function.name is required'), { status: 400 });
    tool_choice = { type: 'tool', name: body.tool_choice.function.name };
  }
  else if (body.tool_choice !== undefined && body.tool_choice !== 'auto') throw Object.assign(new Error('Unsupported tool_choice'), { status: 422 });
  return { model: body.model, stream: !!body.stream, messages, system: system.join('\n'), tools, tool_choice, max_tokens: body.max_completion_tokens || body.max_tokens };
}

export function openaiCompletion(message) {
  const calls = message.content.filter(item => item.type === 'tool_use').map(item => ({ id: item.id, type: 'function', function: { name: item.name, arguments: JSON.stringify(item.input) } }));
  return {
    id: `chatcmpl_${message.id}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: message.model,
    choices: [{ index: 0, message: { role: 'assistant', content: message.content.filter(item => item.type === 'text').map(item => item.text).join('') || null, ...(calls.length ? { tool_calls: calls } : {}) }, finish_reason: calls.length ? 'tool_calls' : 'stop' }],
    usage: { prompt_tokens: message.usage.input_tokens, completion_tokens: message.usage.output_tokens, total_tokens: message.usage.input_tokens + message.usage.output_tokens }
  };
}

export function createOpenAIStream(send, model) {
  let responseId = `chatcmpl_${id().replaceAll('-', '')}`;
  const created = Math.floor(Date.now() / 1000);
  const emit = (delta, finish_reason = null) => send(`data: ${JSON.stringify({ id: responseId, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  const toolIndices = new Map();
  function accept(frame) {
    const data = JSON.parse(frame.slice(frame.indexOf('data: ') + 6));
    if (data.type === 'message_start') { responseId = `chatcmpl_${data.message.id}`; emit({ role: 'assistant', content: '' }); }
    if (data.type === 'content_block_start' && data.content_block.type === 'tool_use') {
      const index = toolIndices.size; toolIndices.set(data.index, index);
      emit({ tool_calls: [{ index, id: data.content_block.id, type: 'function', function: { name: data.content_block.name, arguments: '' } }] });
    }
    if (data.type === 'content_block_delta' && data.delta.type === 'text_delta') emit({ content: data.delta.text });
    if (data.type === 'content_block_delta' && data.delta.type === 'input_json_delta') emit({ tool_calls: [{ index: toolIndices.get(data.index), function: { arguments: data.delta.partial_json } }] });
    if (data.type === 'message_delta') emit({}, data.delta.stop_reason === 'tool_use' ? 'tool_calls' : data.delta.stop_reason === 'max_tokens' ? 'length' : 'stop');
    if (data.type === 'message_stop') send('data: [DONE]\n\n');
  }
  return { accept };
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
