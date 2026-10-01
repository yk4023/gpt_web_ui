const $ = id => document.getElementById(id);
let token = sessionStorage.getItem('gateway-admin-token') || '';
let lastKey = '';
let current = null;
let modelDirty = false;
let toastTimer;

const show = (id, value) => $(id).classList.toggle('hidden', !value);
function toast(message, error = false) {
  const element = $('toast');
  element.textContent = message;
  element.classList.toggle('error', error);
  element.classList.remove('hidden');
  $('dashboard-error').textContent = error ? message : '';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.add('hidden'), 4000);
}
async function api(route, method = 'GET', body) {
  const response = await fetch(route, {
    method,
    headers: { 'X-Admin-Token': token, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const value = await response.json();
  if (!response.ok) throw Error(value.error?.message || `HTTP ${response.status}`);
  return value;
}
async function withButton(button, action) {
  button.disabled = true;
  try { await action(); } catch (error) { toast(error.message, true); }
  finally { button.disabled = false; }
}
async function copy(text, success) {
  try { await navigator.clipboard.writeText(text); toast(success); }
  catch { toast('复制失败，请手动选中并复制。', true); }
}
function command(base, model, key) {
  return `$env:ANTHROPIC_BASE_URL="${base}"\n$env:ANTHROPIC_AUTH_TOKEN="${key || '<在此填入生成的 API Key>'}"\n$env:ANTHROPIC_MODEL="${model}"\n$env:ANTHROPIC_DEFAULT_HAIKU_MODEL="${model}"\n$env:ANTHROPIC_DEFAULT_SONNET_MODEL="${model}"\n$env:ANTHROPIC_DEFAULT_OPUS_MODEL="${model}"\n$env:CLAUDE_CODE_SUBAGENT_MODEL="${model}"\nclaude`;
}
function textCell(row, value, className = '') {
  const cell = row.insertCell();
  cell.textContent = String(value);
  if (className) cell.className = className;
  return cell;
}
function emptyTable(body, columns, message) {
  const row = body.insertRow();
  const cell = row.insertCell();
  cell.colSpan = columns;
  cell.className = 'empty-row';
  cell.textContent = message;
}
function stateBadge(text, off = false) {
  const badge = document.createElement('span');
  badge.className = `state-badge${off ? ' revoked' : ''}`;
  badge.textContent = text;
  return badge;
}
function renderKeys(keys) {
  const body = $('keys');
  body.replaceChildren();
  $('keys-total').textContent = `${keys.length} 个密钥`;
  if (!keys.length) return emptyTable(body, 5, '还没有调用密钥。左侧可创建第一枚密钥。');
  for (const key of keys) {
    const row = body.insertRow();
    const identity = row.insertCell();
    const name = document.createElement('strong'); name.textContent = key.name;
    const prefix = document.createElement('small'); prefix.textContent = `${key.prefix}…`;
    identity.append(name, prefix);
    textCell(row, `${key.requests} / ${key.maxRequests || '∞'}`);
    textCell(row, `${key.tokens.toLocaleString()} / ${key.maxTokens ? key.maxTokens.toLocaleString() : '∞'}`);
    row.insertCell().append(stateBadge(key.revoked ? '已吊销' : '有效', key.revoked));
    const action = document.createElement('button');
    action.className = 'table-action';
    action.textContent = key.revoked ? '启用' : '吊销';
    action.setAttribute('aria-label', `${key.revoked ? '启用' : '吊销'} ${key.name}`);
    action.addEventListener('click', () => withButton(action, async () => {
      await api(`/admin/api/keys/${key.id}`, 'PATCH', { revoked: !key.revoked });
      await refresh();
      toast(key.revoked ? '密钥已启用' : '密钥已吊销');
    }));
    row.insertCell().append(action);
  }
}
function renderLogs(logs) {
  const body = $('logs');
  body.replaceChildren();
  if (!logs.length) return emptyTable(body, 6, '暂无调用记录。完成第一次请求后将在这里显示。');
  for (const item of logs) {
    const row = body.insertRow();
    textCell(row, new Date(item.time).toLocaleString('zh-CN'));
    textCell(row, item.key);
    textCell(row, item.model);
    row.insertCell().append(stateBadge(item.status === 200 ? '成功' : `错误 ${item.status}`, item.status !== 200));
    textCell(row, item.inputTokens);
    textCell(row, item.outputTokens);
  }
}
function render(data) {
  current = data;
  show('login', false);
  show('dashboard', true);
  const chip = $('upstream');
  chip.lastChild.textContent = data.upstreamConfigured
    ? (data.authMode === 'openai-api-key' ? 'OpenAI API Key 已连接' : 'ChatGPT 方案已连接')
    : '未连接上游';
  chip.classList.toggle('status-off', !data.upstreamConfigured);
  const selected = data.chatgpt.profiles.find(profile => profile.clientId === data.chatgpt.selected);
  $('account-status').textContent = selected
    ? `当前账号 · ${selected.email || selected.clientId}`
    : (data.authMode === 'openai-api-key' && data.upstreamConfigured ? '当前使用 OpenAI API Key' : '尚未连接 ChatGPT 账号');
  const selector = $('account-select');
  selector.replaceChildren();
  if (!data.chatgpt.profiles.length) {
    const option = document.createElement('option'); option.textContent = '暂无已保存账号'; option.value = '';
    selector.append(option);
  }
  for (const profile of data.chatgpt.profiles) {
    const option = document.createElement('option');
    option.value = profile.clientId;
    option.textContent = profile.email || profile.clientId;
    option.selected = profile.clientId === data.chatgpt.selected;
    selector.append(option);
  }
  selector.disabled = !data.chatgpt.profiles.length;
  $('select-account').disabled = !data.chatgpt.profiles.length;
  $('reconnect-account').disabled = !data.chatgpt.profiles.length;
  $('base-url').textContent = data.baseUrl;
  $('key-count').textContent = data.keys.filter(key => !key.revoked).length.toLocaleString();
  $('request-count').textContent = data.keys.reduce((sum, key) => sum + key.requests, 0).toLocaleString();
  $('token-count').textContent = data.keys.reduce((sum, key) => sum + key.tokens, 0).toLocaleString();
  $('model-count').textContent = `${Object.keys(data.models).length} 个映射`;
  if (!modelDirty) $('model-map').value = JSON.stringify(data.models, null, 2);
  $('cli-command').textContent = command(data.baseUrl, Object.keys(data.models)[0] || 'codex-sol', lastKey);
  $('last-updated').textContent = `更新于 ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`;
  renderKeys(data.keys);
  renderLogs(data.log);
}
async function refresh() { render(await api('/admin/api/status')); }

$('login-button').addEventListener('click', async () => {
  const button = $('login-button');
  token = $('admin-token').value.trim();
  button.disabled = true;
  try { await refresh(); sessionStorage.setItem('gateway-admin-token', token); $('login-error').textContent = ''; }
  catch (error) { $('login-error').textContent = error.message; }
  finally { button.disabled = false; }
});
$('admin-token').addEventListener('keydown', event => { if (event.key === 'Enter') $('login-button').click(); });
$('refresh-button').addEventListener('click', () => withButton($('refresh-button'), async () => { await refresh(); toast('数据已更新'); }));
$('copy-base').addEventListener('click', () => copy(current?.baseUrl || '', 'Base URL 已复制'));
$('copy-command').addEventListener('click', () => copy($('cli-command').textContent, '接入配置已复制'));
$('copy-key').addEventListener('click', () => copy(lastKey, 'API Key 已复制'));
$('model-map').addEventListener('input', () => modelDirty = true);

$('create-key').addEventListener('click', () => withButton($('create-key'), async () => {
  const result = await api('/admin/api/keys', 'POST', {
    name: $('key-name').value.trim(),
    maxRequests: Number($('max-requests').value),
    maxTokens: Number($('max-tokens').value),
    maxConcurrent: Number($('max-concurrent').value)
  });
  lastKey = result.key;
  $('new-key').textContent = lastKey;
  show('new-key-box', true);
  await refresh();
  $('new-key-box').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  toast('密钥已创建，请立即复制保存。');
}));

async function connectAccount(clientId) {
  const popup = window.open('about:blank', '_blank');
  if (popup) popup.opener = null;
  try {
    const result = await api('/admin/api/chatgpt/start', 'POST', { clientId });
    if (popup) popup.location.href = result.url;
    else window.location.href = result.url;
    toast('请在新窗口完成 ChatGPT 授权。');
  } catch (error) { if (popup) popup.close(); toast(error.message, true); }
}
$('connect-account').addEventListener('click', () => connectAccount(null));
$('reconnect-account').addEventListener('click', () => connectAccount($('account-select').value || null));
$('select-account').addEventListener('click', () => withButton($('select-account'), async () => {
  await api('/admin/api/chatgpt/select', 'POST', { clientId: $('account-select').value });
  await refresh(); toast('上游账号已切换');
}));
$('discover-models').addEventListener('click', () => withButton($('discover-models'), async () => {
  const result = await api('/admin/api/upstream/models');
  const container = $('available-models');
  container.replaceChildren();
  if (!result.models.length) {
    const empty = document.createElement('span'); empty.className = 'empty-inline'; empty.textContent = '当前账号没有列出可用模型'; container.append(empty);
  }
  for (const model of result.models) {
    const chip = document.createElement('span'); chip.className = 'model-chip'; chip.textContent = `${model.name} · ${model.id}`; container.append(chip);
  }
  toast(`已获取 ${result.models.length} 个模型`);
}));
$('save-models').addEventListener('click', () => withButton($('save-models'), async () => {
  await api('/admin/api/models', 'PUT', JSON.parse($('model-map').value));
  modelDirty = false;
  await refresh(); toast('模型映射已保存');
}));

document.querySelectorAll('.nav-link').forEach(link => link.addEventListener('click', () => {
  document.querySelectorAll('.nav-link').forEach(item => item.classList.toggle('active', item === link));
}));
if (token) refresh().catch(() => { show('login', true); show('dashboard', false); });
window.addEventListener('focus', () => { if (token && !$('dashboard').classList.contains('hidden')) refresh().catch(() => {}); });
