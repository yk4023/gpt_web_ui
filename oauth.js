import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const AUTH_BASE = 'https://auth.openai.com';
const RESOURCE = 'https://api.openai.com/v1';
const SCOPE = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const random = () => crypto.randomBytes(32).toString('base64url');

async function tokenFailure(response, action) {
  let code = '';
  try {
    const body = await response.json();
    const value = body?.error?.code || body?.error?.type || body?.error;
    if (typeof value === 'string' && /^[a-z0-9_\-]{1,80}$/i.test(value)) code = value;
  } catch { /* Some token failures have no JSON body. */ }
  const requestId = response.headers.get('x-request-id');
  const reason = code === 'unsupported_country_region_territory'
    ? '当前网络出口所在地区不受 OpenAI 服务支持。'
    : '';
  return new Error(`${action}: HTTP ${response.status}${code ? ` (${code})` : ''}${requestId ? `; request ID ${requestId}` : ''}${reason ? `。${reason}` : ''}`);
}

export function verifyIdToken(token, jwks, { issuer, clientId, nonce, now = Date.now() }) {
  const parts = token.split('.');
  if (parts.length !== 3) throw Error('Invalid ID token');
  const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
  const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw Error('Unsupported ID token signature');
  const jwk = jwks.keys.find(k => k.kid === header.kid && k.kty === 'RSA' && (!k.use || k.use === 'sig'));
  if (!jwk) throw Error('ID token signing key not found');
  const valid = crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), crypto.createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(parts[2], 'base64url'));
  if (!valid || claims.iss !== issuer || !(Array.isArray(claims.aud) ? claims.aud.includes(clientId) : claims.aud === clientId) ||
      claims.nonce !== nonce || !claims.sub || !Number.isFinite(claims.exp) || claims.exp * 1000 <= now ||
      (claims.iat && claims.iat * 1000 > now + 300000)) throw Error('ID token verification failed');
  return claims;
}

export class ChatGPTAuth {
  constructor(dataDir, port, fetcher = fetch) {
    this.file = path.join(dataDir, 'chatgpt-credentials.json');
    this.port = port;
    this.fetch = fetcher;
    this.pending = new Map();
    this.refreshing = new Map();
    this.data = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : { hostId: `urn:uuid:${crypto.randomUUID()}`, selected: null, profiles: [] };
    if (!fs.existsSync(this.file)) this.save();
  }
  save() {
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
  status() {
    return { selected: this.data.selected, profiles: this.data.profiles.map(p => ({ clientId: p.clientId, email: p.email, subject: p.subject, connected: !!p.refreshToken, expiresAt: p.expiresAt })) };
  }
  async start(profileId = null) {
    const profile = profileId ? this.data.profiles.find(p => p.clientId === profileId) : null;
    if (profileId && !profile) throw Error('ChatGPT profile not found');
    const state = random(), nonce = random(), verifier = random();
    const redirectUri = `http://127.0.0.1:${this.port}/auth/callback`;
    this.pending.set(state, { nonce, verifier, redirectUri, profileId, expiresAt: Date.now() + 10 * 60_000 });
    const url = new URL(`${AUTH_BASE}/api/accounts/authorize`);
    const params = { client_id: profile?.clientId || 'dynamic_agent_client', response_type: 'code', redirect_uri: redirectUri, scope: SCOPE,
      resource: RESOURCE, state, nonce, code_challenge_method: 'S256', code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), ext_agent_host_id: this.data.hostId };
    if (profile) { if (profile.idToken) params.id_token_hint = profile.idToken; if (profile.email) params.login_hint = profile.email; }
    else params.agent_name_hint = 'Codex Claude Gateway';
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return url.toString();
  }
  async complete(callbackUrl) {
    const url = new URL(callbackUrl, `http://127.0.0.1:${this.port}`);
    const state = url.searchParams.get('state');
    const pending = this.pending.get(state);
    this.pending.delete(state);
    if (!pending || Date.now() > pending.expiresAt) throw Error('Authorization attempt expired or state mismatch');
    if (url.searchParams.has('error')) throw Error(`Authorization denied: ${url.searchParams.get('error')}`);
    const code = url.searchParams.get('code');
    const clientId = url.searchParams.get('client_id') || pending.profileId;
    if (!code || !clientId || clientId === 'dynamic_agent_client' || (pending.profileId && clientId !== pending.profileId)) throw Error('Invalid authorization callback');
    const form = new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: pending.verifier, redirect_uri: pending.redirectUri, resource: RESOURCE });
    const response = await this.fetch(`${AUTH_BASE}/api/accounts/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form });
    if (!response.ok) throw await tokenFailure(response, 'ChatGPT 授权令牌交换失败');
    const tokens = await response.json();
    if (!tokens.id_token || !tokens.access_token || !tokens.refresh_token) throw Error('Incomplete token response');
    const scopes = String(tokens.scope || '').split(/\s+/);
    if (!scopes.includes('chatgpt.tokens.use.direct')) throw Error('ChatGPT plan usage permission was not granted');
    const discovery = await this.fetch(`${AUTH_BASE}/.well-known/openid-configuration`);
    if (!discovery.ok) throw Error('OpenID discovery failed');
    const configuration = await discovery.json();
    if (configuration.issuer !== AUTH_BASE || !configuration.jwks_uri?.startsWith(`${AUTH_BASE}/`)) throw Error('Unexpected OpenID provider');
    const jwksResponse = await this.fetch(configuration.jwks_uri);
    if (!jwksResponse.ok) throw Error('Signing key lookup failed');
    const claims = verifyIdToken(tokens.id_token, await jwksResponse.json(), { issuer: configuration.issuer, clientId, nonce: pending.nonce });
    const old = this.data.profiles.find(p => p.clientId === clientId);
    if (old && old.subject !== claims.sub) throw Error('Account identity changed for this registration');
    const profile = { clientId, subject: claims.sub, email: claims.email || old?.email || '', idToken: tokens.id_token, accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token, expiresAt: Date.now() + Number(tokens.expires_in || 3600) * 1000, scopes };
    this.data.profiles = this.data.profiles.filter(p => p.clientId !== clientId);
    this.data.profiles.push(profile); this.data.selected = clientId; this.save();
    return { email: profile.email, clientId };
  }
  select(clientId) {
    if (!this.data.profiles.find(p => p.clientId === clientId)) throw Error('ChatGPT profile not found');
    this.data.selected = clientId; this.save();
  }
  async token() {
    const profile = this.data.profiles.find(p => p.clientId === this.data.selected);
    if (!profile?.refreshToken) return null;
    if (profile.expiresAt > Date.now() + 60_000) return profile.accessToken;
    if (this.refreshing.has(profile.clientId)) return this.refreshing.get(profile.clientId);
    const promise = this.refresh(profile).finally(() => this.refreshing.delete(profile.clientId));
    this.refreshing.set(profile.clientId, promise);
    return promise;
  }
  async refresh(profile) {
    const form = new URLSearchParams({ grant_type: 'refresh_token', client_id: profile.clientId, refresh_token: profile.refreshToken, resource: RESOURCE });
    const response = await this.fetch(`${AUTH_BASE}/api/accounts/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form });
    if (!response.ok) throw await tokenFailure(response, 'ChatGPT 令牌刷新失败');
    const tokens = await response.json();
    if (!tokens.access_token || !tokens.refresh_token) throw Error('Incomplete token refresh response');
    profile.accessToken = tokens.access_token; profile.refreshToken = tokens.refresh_token;
    profile.expiresAt = Date.now() + Number(tokens.expires_in || 3600) * 1000;
    if (tokens.scope) profile.scopes = String(tokens.scope).split(/\s+/);
    this.save(); return profile.accessToken;
  }
}
