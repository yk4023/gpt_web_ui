const $ = id => document.getElementById(id);
let token = sessionStorage.getItem('gateway-admin-token') || '';
let lastKey = '';
let current = null;
let modelDirty = false;
let templateFormat = 'json';
let availableModels = [];
let usagePeriod = 'day';
let usageMetric = 'requests';
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
function templateValues() {
  const model = id => $(id).value || 'codex-luna';
  const context = $('env-context-tokens').value.trim();
  return {
    ANTHROPIC_AUTH_TOKEN: $('env-key').value.trim() || '<粘贴网关 API Key>',
    ANTHROPIC_BASE_URL: current?.baseUrl || 'http://127.0.0.1:8765',
    ANTHROPIC_MODEL: model('env-main-model'),
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model('env-haiku-model'),
    ANTHROPIC_DEFAULT_SONNET_MODEL: model('env-sonnet-model'),
    ANTHROPIC_DEFAULT_OPUS_MODEL: model('env-opus-model'),
    CLAUDE_CODE_SUBAGENT_MODEL: model('env-subagent-model'),
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: /^\d+$/.test(context) && Number(context) > 0 ? context : '983616'
  };
}
function updateTemplate() {
  if (!current) return;
  const values = templateValues();
  $('cli-command').textContent = templateFormat === 'json'
    ? JSON.stringify({ env: values }, null, 2)
    : `${Object.entries(values).map(([name, value]) => `$env:${name}='${value.replaceAll("'", "''")}'`).join('\n')}\nclaude`;
  $('template-title').textContent = templateFormat === 'json' ? 'settings.json · Claude Code' : 'PowerShell · Claude Code';
  $('format-json').classList.toggle('active', templateFormat === 'json');
  $('format-ps').classList.toggle('active', templateFormat === 'ps');
  $('openai-base-url').textContent = `${current.baseUrl}/v1`;
  const openaiModel = $('openai-model').value || values.ANTHROPIC_MODEL;
  $('openai-config').textContent = `$env:OPENAI_BASE_URL='${current.baseUrl}/v1'\n$env:OPENAI_API_KEY='${values.ANTHROPIC_AUTH_TOKEN.replaceAll("'", "''")}'\n$env:OPENAI_MODEL='${openaiModel.replaceAll("'", "''")}'`;
}
function modelRow(alias = '', route = '') {
  const upstream = typeof route === 'string' ? route : route.model || '';
  const effort = typeof route === 'string' ? '' : route.reasoningEffort || '';
  const row = document.createElement('div'); row.className = 'model-row';
  const name = document.createElement('input'); name.className = 'model-alias'; name.placeholder = '例如 codex-luna'; name.setAttribute('aria-label', '客户端模型别名'); name.value = alias;
  const targetBox = document.createElement('div'); targetBox.className = 'model-target-box';
  const picker = document.createElement('select'); picker.className = 'model-picker'; picker.setAttribute('aria-label', '选择已查询的上游模型');
  const target = document.createElement('input'); target.className = 'model-target'; target.placeholder = '或手动输入模型 ID'; target.setAttribute('aria-label', '上游模型 ID'); target.value = upstream;
  picker.addEventListener('change', () => { if (picker.value) { target.value = picker.value; modelDirty = true; } });
  targetBox.append(picker, target);
  const reasoning = document.createElement('select'); reasoning.className = 'model-reasoning'; reasoning.setAttribute('aria-label', '思考等级');
  for (const [value, label] of [['', '默认'], ['low', '低'], ['medium', '中'], ['high', '高'], ['xhigh', '极高']]) {
    const option = document.createElement('option'); option.value = value; option.textContent = label; reasoning.append(option);
  }
  reasoning.value = effort;
  reasoning.addEventListener('change', () => { modelDirty = true; });
  const remove = document.createElement('button'); remove.className = 'button button-secondary button-small'; remove.type = 'button'; remove.textContent = '移除'; remove.setAttribute('aria-label', `移除映射 ${alias || '空行'}`);
  for (const input of [name, target]) input.addEventListener('input', () => { modelDirty = true; });
  remove.addEventListener('click', () => { row.remove(); modelDirty = true; });
  row.append(name, targetBox, reasoning, remove);
  $('model-rows').append(row);
  updateModelPicker(row);
}
function updateModelPicker(row) {
  const picker = row.querySelector('.model-picker');
  const target = row.querySelector('.model-target');
  picker.replaceChildren();
  const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = availableModels.length ? '从可用模型中选择' : '先查询可用模型'; picker.append(placeholder);
  for (const model of availableModels) {
    const option = document.createElement('option'); option.value = model.id; option.textContent = `${model.name} · ${model.id}`; picker.append(option);
  }
  picker.disabled = !availableModels.length;
  picker.value = availableModels.some(model => model.id === target.value) ? target.value : '';
}
function renderModelRows(models) {
  $('model-rows').replaceChildren();
  for (const [alias, route] of Object.entries(models)) modelRow(alias, route);
  if (!Object.keys(models).length) modelRow();
}
function collectModels() {
  const models = {};
  for (const row of $('model-rows').children) {
    const alias = row.querySelector('.model-alias').value.trim();
    const target = row.querySelector('.model-target').value.trim();
    if (!alias && !target) continue;
    if (!alias || !target) throw Error('请完整填写每一条模型映射');
    if (Object.hasOwn(models, alias)) throw Error(`模型别名重复：${alias}`);
    models[alias] = { model: target, reasoningEffort: row.querySelector('.model-reasoning').value };
  }
  if (!Object.keys(models).length) throw Error('请至少添加一条模型映射');
  return models;
}
function renderQuota(data) {
  const selected = data.chatgpt.profiles.find(profile => profile.clientId === data.chatgpt.selected);
  $('account-quota').textContent = '—';
  $('account-quota-note').textContent = data.authMode === 'openai-api-key'
    ? 'API Key 用量由 OpenAI 平台管理，本地未获取余额。'
    : selected ? '当前授权未提供余额查询接口，请查看官方用量页。' : '连接 ChatGPT 账号后，可在官方用量页查看。';
  show('account-usage-link', data.authMode !== 'openai-api-key');
  const selector = $('quota-key-select');
  const previous = selector.value;
  selector.replaceChildren();
  const active = data.keys.filter(key => !key.revoked);
  if (!active.length) {
    const option = document.createElement('option'); option.value = ''; option.textContent = '暂无有效密钥'; selector.append(option);
  }
  for (const key of active) {
    const option = document.createElement('option'); option.value = key.id; option.textContent = `${key.name} · ${key.prefix}…`; selector.append(option);
  }
  selector.disabled = !active.length;
  if (active.some(key => key.id === previous)) selector.value = previous;
  updateQuotaValues();
}
const planEstimates = {
  'gpt-6-astra': [[5, 45], [25, 225], [100, 900], [5, 45]],
  'gpt-5.6-sol': [[10, 100], [50, 500], [200, 2000], [10, 100]],
  'gpt-5.6-terra': [[25, 200], [125, 1000], [500, 4000], [25, 200]],
  'gpt-5.6-luna': [[250, 2000], [1250, 10000], [5000, 40000], [250, 2000]],
  'gpt-5.5': [[15, 80], [75, 400], [300, 1600], [15, 80]],
  'gpt-5.4': [[20, 100], [100, 500], [400, 2000], [20, 100]],
  'gpt-5.4-mini': [[60, 350], [300, 1750], [1200, 7000], [60, 350]]
};
function renderPlanEstimate() {
  const plan = $('estimate-plan').value;
  const index = { plus: 0, pro5: 1, pro20: 2, business: 3 }[plan];
  const range = planEstimates[$('estimate-model').value]?.[index];
  $('estimate-range').textContent = range ? `${range[0].toLocaleString()}–${range[1].toLocaleString()} 条` : '—';
  $('estimate-note').textContent = plan === 'free'
    ? '普通会员暂无适用于此处的公开估算；实际可用性以账号授权和官方用量页为准。'
    : plan === 'businessPremium'
      ? 'Business 高级席位约为标准席位 5 倍包含用量，但无五小时限额，不能换算为此处的五小时消息数。'
      : plan ? '公开范围仅供参考，不代表剩余额度。实际消耗受任务、模型和思考等级影响，也可能受每周限额约束。'
        : '授权未提供套餐等级，请手动选择。模型、任务与思考等级都会影响实际用量；部分套餐还有每周限制。';
}
function renderNetwork(network = { proxyUrl: '', source: 'dashboard' }) {
  const input = $('proxy-url');
  if (document.activeElement !== input) input.value = network.proxyUrl || '';
  const locked = network.source === 'environment';
  input.disabled = locked;
  $('save-proxy').disabled = locked;
  $('proxy-status').textContent = locked
    ? `当前代理由 GATEWAY_PROXY_URL 环境变量设置：${network.proxyUrl}`
    : network.proxyUrl ? `当前通过本机代理访问上游：${network.proxyUrl}` : '当前直连上游';
}
function updateQuotaValues() {
  const key = current?.keys.find(item => item.id === $('quota-key-select').value);
  const remaining = (limit, used) => limit ? Math.max(0, limit - used).toLocaleString() : '不限';
  $('quota-requests').textContent = key ? remaining(key.maxRequests, key.requests) : '—';
  $('quota-tokens').textContent = key ? remaining(key.maxTokens, key.tokens) : '—';
}
function renderUsage(data) {
  const points = data.usage?.[usagePeriod] || [];
  const value = point => usageMetric === 'requests' ? point.requests : point.inputTokens + point.outputTokens + point.legacyTokens;
  const values = points.map(value);
  const max = Math.max(1, ...values);
  const format = number => number.toLocaleString('zh-CN');
  $('usage-current').textContent = format(values.at(-1) || 0);
  $('usage-total').textContent = format(values.reduce((sum, item) => sum + item, 0));
  $('usage-peak').textContent = format(Math.max(0, ...values));
  for (const period of ['hour', 'day', 'week', 'month']) $('usage-' + period).classList.toggle('active', usagePeriod === period);
  for (const metric of ['requests', 'tokens']) $('usage-' + metric).classList.toggle('active', usageMetric === metric);
  const chart = $('usage-chart'); chart.replaceChildren();
  const periodName = { hour: '小时', day: '日', week: '周', month: '月' }[usagePeriod];
  const metricName = usageMetric === 'requests' ? '请求' : 'Token';
  chart.setAttribute('aria-label', `本地网关按${periodName}统计${metricName}；当前周期 ${values.at(-1) || 0}，图表范围合计 ${values.reduce((sum, item) => sum + item, 0)}`);
  for (const [index, point] of points.entries()) {
    const item = document.createElement('div'); item.className = 'usage-bar-item';
    const label = usagePeriod === 'month' ? point.date.slice(0, 7) : usagePeriod === 'hour' ? point.date.slice(11) : point.date.slice(5);
    const track = document.createElement('div'); track.className = 'usage-bar-track';
    const bar = document.createElement('div'); bar.className = 'usage-bar';
    bar.style.height = `${Math.max(values[index] ? 4 : 0, values[index] / max * 100)}%`;
    const caption = document.createElement('span'); caption.textContent = label;
    item.title = `${point.date} · ${format(values[index])} ${metricName}`;
    track.append(bar); item.append(track, caption); chart.append(item);
  }
}
function renderModelSelectors(models) {
  const aliases = Object.keys(models);
  const fallback = aliases.includes('codex-luna') ? 'codex-luna' : aliases[0] || '';
  for (const id of ['env-main-model', 'env-haiku-model', 'env-sonnet-model', 'env-opus-model', 'env-subagent-model', 'openai-model']) {
    const selector = $(id);
    const previous = selector.value;
    selector.replaceChildren();
    for (const alias of aliases) {
      const option = document.createElement('option'); option.value = alias; option.textContent = alias; selector.append(option);
    }
    if (!aliases.length) {
      const option = document.createElement('option'); option.value = ''; option.textContent = '先添加模型映射'; selector.append(option);
    }
    selector.disabled = !aliases.length;
    selector.value = aliases.includes(previous) ? previous : fallback;
  }
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
  if (!modelDirty) renderModelRows(data.models);
  renderModelSelectors(data.models);
  updateTemplate();
  $('last-updated').textContent = `更新于 ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`;
  renderKeys(data.keys);
  renderQuota(data);
  renderPlanEstimate();
  renderNetwork(data.network);
  renderUsage(data);
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
$('copy-openai-base').addEventListener('click', () => copy($('openai-base-url').textContent, 'OpenAI Base URL 已复制'));
$('copy-openai-config').addEventListener('click', () => copy($('openai-config').textContent, 'OpenAI 配置已复制'));
$('copy-key').addEventListener('click', () => copy(lastKey, 'API Key 已复制'));
$('quota-key-select').addEventListener('change', updateQuotaValues);
for (const id of ['estimate-plan', 'estimate-model']) $(id).addEventListener('change', renderPlanEstimate);
$('save-proxy').addEventListener('click', () => withButton($('save-proxy'), async () => {
  await api('/admin/api/network', 'PUT', { proxyUrl: $('proxy-url').value.trim() });
  await refresh();
  toast('上游代理设置已保存并生效');
}));
for (const period of ['hour', 'day', 'week', 'month']) $('usage-' + period).addEventListener('click', () => { usagePeriod = period; if (current) renderUsage(current); });
for (const metric of ['requests', 'tokens']) $('usage-' + metric).addEventListener('click', () => { usageMetric = metric; if (current) renderUsage(current); });
$('add-model-row').addEventListener('click', () => { modelRow(); modelDirty = true; });
for (const id of ['env-key', 'env-context-tokens', 'env-main-model', 'env-haiku-model', 'env-sonnet-model', 'env-opus-model', 'env-subagent-model', 'openai-model']) {
  $(id).addEventListener('input', updateTemplate);
  $(id).addEventListener('change', updateTemplate);
}
$('format-json').addEventListener('click', () => { templateFormat = 'json'; updateTemplate(); });
$('format-ps').addEventListener('click', () => { templateFormat = 'ps'; updateTemplate(); });

$('create-key').addEventListener('click', () => withButton($('create-key'), async () => {
  const result = await api('/admin/api/keys', 'POST', {
    name: $('key-name').value.trim(),
    maxRequests: Number($('max-requests').value),
    maxTokens: Number($('max-tokens').value),
    maxConcurrent: Number($('max-concurrent').value)
  });
  lastKey = result.key;
  $('new-key').textContent = lastKey;
  $('env-key').value = lastKey;
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
  availableModels = result.models;
  const container = $('available-models');
  container.replaceChildren();
  if (!result.models.length) {
    const empty = document.createElement('span'); empty.className = 'empty-inline'; empty.textContent = '当前账号没有列出可用模型'; container.append(empty);
  }
  for (const model of result.models) {
    const chip = document.createElement('span'); chip.className = 'model-chip'; chip.textContent = `${model.name} · ${model.id}`; container.append(chip);
  }
  for (const row of $('model-rows').children) updateModelPicker(row);
  toast(`已获取 ${result.models.length} 个模型`);
}));
$('save-models').addEventListener('click', () => withButton($('save-models'), async () => {
  await api('/admin/api/models', 'PUT', collectModels());
  modelDirty = false;
  await refresh(); toast('模型映射已保存');
}));

document.querySelectorAll('.nav-link').forEach(link => link.addEventListener('click', () => {
  document.querySelectorAll('.nav-link').forEach(item => item.classList.toggle('active', item === link));
}));
if (token) refresh().catch(() => { show('login', true); show('dashboard', false); });
window.addEventListener('focus', () => { if (token && !$('dashboard').classList.contains('hidden')) refresh().catch(() => {}); });
