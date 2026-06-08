// SF1 Boost Tool - Electron Main Process
// Backend كامل: تخزين محلي + كل وظائف Discord (boost, nick+avatar+banner, token check, join via OAuth)

const { app, BrowserWindow, ipcMain, Menu, globalShortcut, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const os = require('os');
const crypto = require('crypto');
const { execSync } = require('child_process');
const { URL } = require('url');
let WS = null;
try { WS = require('ws'); } catch { WS = null; }

// Disable Chromium menu + DevTools shortcuts at the app level
Menu.setApplicationMenu(null);

const APP_URL = 'https://ohhh.lovable.app';
const USER_DATA = () => app.getPath('userData');
const DATA_FILE = () => path.join(USER_DATA(), 'sf1-data.json');

// ---------- Storage ----------
function loadData() {
  try {
    if (!fs.existsSync(DATA_FILE())) return { groups: [], bot: { tkn: '', secret: '', client_id: '' } };
    return JSON.parse(fs.readFileSync(DATA_FILE(), 'utf-8'));
  } catch { return { groups: [], bot: { tkn: '', secret: '', client_id: '' } }; }
}
function saveData(data) {
  fs.mkdirSync(USER_DATA(), { recursive: true });
  fs.writeFileSync(DATA_FILE(), JSON.stringify(data, null, 2));
}

// ---------- HTTP helper ----------
function httpRequest(method, urlStr, headers = {}, body = null) {
  return new Promise((resolve) => {
    try {
      const u = new URL(urlStr);
      const data = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
      const opts = {
        method,
        hostname: u.hostname,
        path: u.pathname + u.search,
        headers: { ...headers },
      };
      if (data) {
        opts.headers['Content-Length'] = Buffer.byteLength(data);
        if (!opts.headers['Content-Type']) opts.headers['Content-Type'] = 'application/json';
      }
      const req = https.request(opts, (res) => {
        let chunks = '';
        res.on('data', (c) => (chunks += c));
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(chunks); } catch {}
          resolve({ status: res.statusCode, body: chunks, json });
        });
      });
      req.on('error', (e) => resolve({ status: 0, body: String(e), json: null, error: true }));
      if (data) req.write(data);
      req.end();
    } catch (e) {
      resolve({ status: 0, body: String(e), json: null, error: true });
    }
  });
}

// ---------- Discord constants (مطابق لـ code1.py) ----------
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36';
const SUPER_PROPS = Buffer.from(JSON.stringify({
  os: 'Windows', browser: 'Chrome', device: 'PC',
  system_locale: 'en-GB', browser_user_agent: UA, browser_version: '108.0.0.0',
  os_version: '10', referrer: 'https://discord.com/channels/@me',
  referring_domain: 'discord.com', referrer_current: '', referring_domain_current: '',
  release_channel: 'stable', client_build_number: 296364, client_event_source: null,
})).toString('base64');

const userHeaders = (token) => ({
  'Authorization': token,
  'Origin': 'https://canary.discord.com',
  'Accept': '*/*',
  'X-Discord-Locale': 'en-GB',
  'X-Super-Properties': SUPER_PROPS,
  'User-Agent': UA,
  'Referer': 'https://canary.discord.com/channels/@me',
  'X-Debug-Options': 'bugReporterEnabled',
  'Content-Type': 'application/json',
});

// ---------- IPC: Storage ----------
ipcMain.handle('data:get', () => loadData());
ipcMain.handle('data:set', (_e, data) => { saveData(data); return true; });

// ---------- IPC: System info — fingerprint, all IPs, device name, OS ----------
function getLocalIPs() {
  const out = { ipv4: null, ipv6: null };
  try {
    const ifs = os.networkInterfaces();
    for (const name of Object.keys(ifs)) {
      for (const a of (ifs[name] || [])) {
        if (a.internal) continue;
        if (a.family === 'IPv4' && !out.ipv4) out.ipv4 = a.address;
        else if (a.family === 'IPv6' && !out.ipv6 && !a.address.startsWith('fe80')) out.ipv6 = a.address;
      }
    }
  } catch {}
  return out;
}

function getRealUserName() {
  // Prefer the actual interactive user folder under C:\Users (filter system folders).
  try {
    if (process.platform === 'win32') {
      const usersDir = path.join('C:\\', 'Users');
      const blacklist = new Set([
        'Public', 'Default', 'Default User', 'All Users', 'desktop.ini',
        'WDAGUtilityAccount', 'Administrator',
      ]);
      const candidates = fs.readdirSync(usersDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !blacklist.has(d.name))
        .map((d) => {
          const full = path.join(usersDir, d.name);
          let st = null;
          try { st = fs.statSync(full); } catch {}
          return { name: d.name, full, mtime: st ? st.mtimeMs : 0 };
        });
      // If current USERPROFILE matches one of them, prefer it.
      const up = process.env.USERPROFILE || '';
      const cur = candidates.find((c) => up && up.toLowerCase() === c.full.toLowerCase());
      if (cur) return cur.name;
      // Otherwise pick the most recently modified candidate.
      candidates.sort((a, b) => b.mtime - a.mtime);
      if (candidates[0]) return candidates[0].name;
    }
  } catch {}
  return os.userInfo().username || 'Unknown';
}

function getOsVersion() {
  try {
    if (process.platform === 'win32') {
      // Try registry for accurate edition (e.g., "Windows 11 Pro")
      try {
        const out = execSync(
          'reg query "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion" /v ProductName /v CurrentBuild /v DisplayVersion',
          { timeout: 2500 },
        ).toString();
        const productName = (out.match(/ProductName\s+REG_SZ\s+([^\r\n]+)/) || [])[1] || '';
        const build = parseInt(((out.match(/CurrentBuild\s+REG_SZ\s+([^\r\n]+)/) || [])[1] || '0').trim(), 10);
        const display = (out.match(/DisplayVersion\s+REG_SZ\s+([^\r\n]+)/) || [])[1] || '';
        // Windows 11 starts at build 22000+
        let name = productName.trim();
        if (build >= 22000) name = name.replace(/Windows 10/i, 'Windows 11');
        return display ? `${name} (${display.trim()})` : name;
      } catch {}
      return `Windows ${os.release()}`;
    }
    return `${os.type()} ${os.release()}`;
  } catch { return os.platform(); }
}

function computeFingerprint() {
  // Stable per machine: MAC addrs (sorted) + hostname + cpu model + platform + arch
  try {
    const macs = [];
    const ifs = os.networkInterfaces();
    for (const name of Object.keys(ifs)) {
      for (const a of (ifs[name] || [])) {
        if (a.mac && a.mac !== '00:00:00:00:00:00' && !macs.includes(a.mac)) macs.push(a.mac);
      }
    }
    macs.sort();
    const cpu = (os.cpus()[0] || {}).model || '';
    const seed = [macs.join('|'), os.hostname(), cpu, os.platform(), os.arch()].join('::');
    return crypto.createHash('sha256').update(seed).digest('hex');
  } catch { return crypto.randomBytes(16).toString('hex'); }
}

let _sysCache = null;
function getSystemInfo() {
  if (_sysCache) return _sysCache;
  const ips = getLocalIPs();
  _sysCache = {
    fingerprint: computeFingerprint(),
    local_ip: ips.ipv4,
    ipv6: ips.ipv6,
    hostname: os.hostname(),
    device_name: getRealUserName(),
    os_version: getOsVersion(),
    platform: process.platform,
  };
  return _sysCache;
}
ipcMain.handle('system:info', () => getSystemInfo());

// ---------- IPC: Webhook send (Components V2) ----------
ipcMain.handle('webhook:send', async (_e, { url, payload }) => {
  if (!url) return { ok: false, error: 'no-url' };
  const r = await httpRequest('POST', url + (url.includes('?') ? '&' : '?') + 'with_components=true', { 'Content-Type': 'application/json' }, payload);
  return { ok: r.status >= 200 && r.status < 300, status: r.status, body: r.body };
});

// ---------- IPC: Open external URL in user's default browser ----------
ipcMain.handle('shell:open', async (_e, { url }) => {
  if (!url || typeof url !== 'string') return { ok: false };
  try { await shell.openExternal(url); return { ok: true }; }
  catch (e) { return { ok: false, error: String(e) }; }
});

// ---------- IPC: Open URL inside an in-app BrowserWindow (isolated session per token) ----------
ipcMain.handle('shell:openInternal', async (_e, { url, partition, title }) => {
  if (!url || typeof url !== 'string') return { ok: false };
  try {
    const win = new BrowserWindow({
      width: 1200,
      height: 800,
      title: title || 'Discord',
      autoHideMenuBar: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        partition: partition || `persist:internal-${Date.now()}`,
      },
    });
    win.setMenu(null);
    await win.loadURL(url);
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e) }; }
});

// ---------- IPC: Boost transfer (real Discord transfer — single PUT, no cancel) ----------
// Discord re-assigns the slots from the old guild to the new guild atomically when you
// PUT all slot ids to the new guild. No DELETE → no cooldown reset.
ipcMain.handle('boost:transfer', async (event, { token, fromServerId, toServerId, nickname }) => {
  const log = (msg, type = 'info') => event.sender.send('boost:log', { token: '***', msg, type });
  const slots = await httpRequest('GET', 'https://canary.discord.com/api/v9/users/@me/guilds/premium/subscription-slots', userHeaders(token));
  if (!Array.isArray(slots.json)) { log('slots fetch failed', 'error'); return { ok: false }; }
  const mine = slots.json.filter((s) => s?.premium_guild_subscription?.guild_id === fromServerId);
  if (!mine.length) { log('no boosts here', 'warn'); return { ok: false, boosts: 0 }; }
  // Single transfer request — ALL slots at once
  const slotIds = mine.map((s) => s.id);
  const r = await httpRequest('PUT', `https://canary.discord.com/api/v9/guilds/${toServerId}/premium/subscriptions`, userHeaders(token), { user_premium_guild_subscription_slot_ids: slotIds });
  const ok = r.status >= 200 && r.status < 300;
  const moved = ok ? slotIds.length : 0;
  log(ok ? `Transferred ${moved} boost(s) in 1 request` : `Transfer failed (${r.status})`, ok ? 'success' : 'error');
  // Apply nickname on the destination server (token is now a member there via boost transfer)
  if (ok && nickname) {
    try {
      const nick = await httpRequest('PATCH', `https://canary.discord.com/api/v9/guilds/${toServerId}/members/@me`, userHeaders(token), { nick: nickname });
      log(`Nickname (${nick.status})`, nick.status < 300 ? 'success' : 'warn');
    } catch {}
  }
  return { ok, boosts: moved };
});

// ---------- IPC: Token check (يجلب user info + boost slots) ----------
ipcMain.handle('token:check', async (_e, token) => {
  const me = await httpRequest('GET', 'https://canary.discord.com/api/v9/users/@me', userHeaders(token));
  if (me.status !== 200 || !me.json) return { valid: false, status: me.status };
  const slots = await httpRequest('GET', 'https://canary.discord.com/api/v9/users/@me/guilds/premium/subscription-slots', userHeaders(token));
  const available = Array.isArray(slots.json) ? slots.json.filter(s => !s.cooldown_ends_at || new Date(s.cooldown_ends_at) < new Date()).length : 0;
  const total = Array.isArray(slots.json) ? slots.json.length : 0;
  const u = me.json;
  const avatar = u.avatar
    ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.${u.avatar.startsWith('a_') ? 'gif' : 'png'}?size=128`
    : `https://cdn.discordapp.com/embed/avatars/${(parseInt(u.discriminator || '0') % 5)}.png`;

  // جلب تاريخ انتهاء النيترو من اشتراكات الفوترة
  let nitro_ends_at = null;
  if ((u.premium_type || 0) > 0) {
    try {
      const subs = await httpRequest('GET', 'https://canary.discord.com/api/v9/users/@me/billing/subscriptions', userHeaders(token));
      if (subs.status === 200 && Array.isArray(subs.json)) {
        // نختار اشتراك النيترو النشط (type 1 = premium subscription) ونأخذ current_period_end
        const nitroSub = subs.json
          .filter(s => s && (s.type === 1 || s.type === 2) && s.status !== 3 && s.current_period_end)
          .sort((a, b) => new Date(b.current_period_end) - new Date(a.current_period_end))[0];
        if (nitroSub) nitro_ends_at = nitroSub.current_period_end;
      }
      // fallback: premium_guild_since أو premium_since عبر settings
      if (!nitro_ends_at) {
        const settings = await httpRequest('GET', 'https://canary.discord.com/api/v9/users/@me/billing/subscriptions?include_inactive=true', userHeaders(token));
        if (settings.status === 200 && Array.isArray(settings.json)) {
          const any = settings.json.filter(s => s && s.current_period_end).sort((a, b) => new Date(b.current_period_end) - new Date(a.current_period_end))[0];
          if (any) nitro_ends_at = any.current_period_end;
        }
      }
    } catch {}
  }

  return {
    valid: true,
    id: u.id,
    username: u.username,
    global_name: u.global_name || u.username,
    discriminator: u.discriminator,
    avatar,
    email: u.email,
    phone: u.phone,
    mfa_enabled: u.mfa_enabled,
    nitro: u.premium_type || 0,
    nitro_ends_at,
    boosts_total: total,
    boosts_available: available,
  };
});

// ---------- IPC: Server info ----------
// نستخدم 3 endpoints بالتسلسل لضمان الحصول على premium_subscription_count الصحيح:
// 1) GET /guilds/{id}?with_counts=true  (يحتاج المستخدم يكون عضو) — يرجع كل البيانات
// 2) GET /guilds/{id}/premium/subscriptions  (عدد الـ subscription objects = عدد البوستات)
// 3) GET /guilds/{id}/preview  (fallback — يعمل حتى لو المستخدم مو عضو لكن ما يرجع البوست دائماً)
ipcMain.handle('server:info', async (_e, { token, serverId, asBot }) => {
  let name, icon, banner, splash, description, premium = 0, members, premium_tier;
  const authToken = asBot ? `Bot ${token}` : token;
  const headers = asBot
    ? { 'Authorization': authToken, 'User-Agent': 'DiscordBot (https://sf1.local, 1.0)', 'Content-Type': 'application/json' }
    : userHeaders(token);

  const full = await httpRequest('GET', `https://canary.discord.com/api/v9/guilds/${serverId}?with_counts=true`, headers);
  if (full.status === 200 && full.json) {
    name = full.json.name;
    icon = full.json.icon ? `https://cdn.discordapp.com/icons/${full.json.id}/${full.json.icon}.png?size=256` : null;
    banner = full.json.banner ? `https://cdn.discordapp.com/banners/${full.json.id}/${full.json.banner}.${full.json.banner.startsWith('a_') ? 'gif' : 'png'}?size=1024` : null;
    splash = full.json.splash ? `https://cdn.discordapp.com/splashes/${full.json.id}/${full.json.splash}.png?size=1024` : null;
    description = full.json.description || '';
    premium = full.json.premium_subscription_count || 0;
    members = full.json.approximate_member_count;
    premium_tier = full.json.premium_tier;
  }

  const subs = await httpRequest('GET', `https://canary.discord.com/api/v9/guilds/${serverId}/premium/subscriptions`, headers);
  if (subs.status === 200 && Array.isArray(subs.json)) premium = subs.json.length;

  if (!name) {
    const prev = await httpRequest('GET', `https://canary.discord.com/api/v9/guilds/${serverId}/preview`, headers);
    if (prev.status === 200 && prev.json) {
      name = prev.json.name;
      icon = prev.json.icon ? `https://cdn.discordapp.com/icons/${prev.json.id}/${prev.json.icon}.png?size=256` : null;
      banner = prev.json.banner ? `https://cdn.discordapp.com/banners/${prev.json.id}/${prev.json.banner}.png?size=1024` : null;
      splash = prev.json.splash ? `https://cdn.discordapp.com/splashes/${prev.json.id}/${prev.json.splash}.png?size=1024` : null;
      description = prev.json.description || '';
      members = prev.json.approximate_member_count;
      if (!premium) premium = prev.json.premium_subscription_count || 0;
    } else {
      return { ok: false, status: prev.status };
    }
  }

  return {
    ok: true, id: serverId, name, icon, banner, splash, description,
    premium_subscription_count: premium, premium_tier, member_count: members,
  };
});

// ---------- IPC: Per-group persistent logs ----------
const LOGS_FILE = (gid) => path.join(USER_DATA(), `sf1-logs-${gid}.json`);
ipcMain.handle('logs:get', (_e, gid) => {
  try {
    if (!fs.existsSync(LOGS_FILE(gid))) return [];
    return JSON.parse(fs.readFileSync(LOGS_FILE(gid), 'utf-8'));
  } catch { return []; }
});
ipcMain.handle('logs:append', (_e, { gid, entries }) => {
  try {
    const cur = fs.existsSync(LOGS_FILE(gid)) ? JSON.parse(fs.readFileSync(LOGS_FILE(gid), 'utf-8')) : [];
    const next = [...entries, ...cur].slice(0, 2000);
    fs.mkdirSync(USER_DATA(), { recursive: true });
    fs.writeFileSync(LOGS_FILE(gid), JSON.stringify(next));
    return true;
  } catch { return false; }
});
ipcMain.handle('logs:clear', (_e, gid) => {
  try { fs.existsSync(LOGS_FILE(gid)) && fs.unlinkSync(LOGS_FILE(gid)); return true; } catch { return false; }
});

// ---------- IPC: Channels list ----------
ipcMain.handle('channels:list', async (_e, { token, serverId }) => {
  const r = await httpRequest('GET', `https://discord.com/api/v9/guilds/${serverId}/channels`, userHeaders(token));
  if (r.status !== 200 || !Array.isArray(r.json)) return { ok: false, status: r.status };
  return { ok: true, channels: r.json };
});

// ---------- IPC: Get user permissions in a channel (computes overwrites) ----------
async function getMyMember(token, serverId) {
  const r = await httpRequest('GET', `https://discord.com/api/v9/users/@me/guilds/${serverId}/member`, userHeaders(token));
  return r.status === 200 ? r.json : null;
}

// ---------- IPC: Channel messages (last N) ----------
ipcMain.handle('channel:messages', async (_e, { token, channelId, limit = 20 }) => {
  const r = await httpRequest('GET', `https://discord.com/api/v9/channels/${channelId}/messages?limit=${limit}`, userHeaders(token));
  return { ok: r.status === 200, status: r.status, messages: Array.isArray(r.json) ? r.json : [] };
});

// ---------- IPC: Send message ----------
ipcMain.handle('channel:send', async (_e, { token, channelId, content, replyTo }) => {
  const body = { content };
  if (replyTo) body.message_reference = { message_id: replyTo };
  const r = await httpRequest('POST', `https://discord.com/api/v9/channels/${channelId}/messages`, userHeaders(token), body);
  return { ok: r.status >= 200 && r.status < 300, status: r.status, message: r.json };
});

// ---------- IPC: Reactions (add / remove) ----------
// emoji: for unicode pass the raw char (e.g. "🔥"); for custom pass "name:id"
ipcMain.handle('reaction:add', async (_e, { token, channelId, messageId, emoji }) => {
  const enc = encodeURIComponent(emoji);
  const r = await httpRequest('PUT', `https://discord.com/api/v9/channels/${channelId}/messages/${messageId}/reactions/${enc}/%40me`, userHeaders(token));
  return { ok: r.status >= 200 && r.status < 300, status: r.status };
});
ipcMain.handle('reaction:remove', async (_e, { token, channelId, messageId, emoji }) => {
  const enc = encodeURIComponent(emoji);
  const r = await httpRequest('DELETE', `https://discord.com/api/v9/channels/${channelId}/messages/${messageId}/reactions/${enc}/%40me`, userHeaders(token));
  return { ok: r.status >= 200 && r.status < 300, status: r.status };
});

// ---------- IPC: User profile (full Discord profile) ----------
ipcMain.handle('user:profile', async (_e, { token, userId, serverId }) => {
  const url = `https://discord.com/api/v9/users/${userId}/profile?with_mutual_guilds=false${serverId ? `&guild_id=${serverId}` : ''}`;
  const r = await httpRequest('GET', url, userHeaders(token));
  if (r.status !== 200 || !r.json) return { ok: false, status: r.status };
  const u = r.json.user || {};
  const gm = r.json.guild_member || null;
  const avatar = u.avatar
    ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.${u.avatar.startsWith('a_') ? 'gif' : 'png'}?size=256`
    : `https://cdn.discordapp.com/embed/avatars/${(parseInt(u.discriminator || '0') % 5)}.png`;
  const banner = u.banner
    ? `https://cdn.discordapp.com/banners/${u.id}/${u.banner}.${u.banner.startsWith('a_') ? 'gif' : 'png'}?size=600`
    : null;

  // Resolve guild roles → name+color
  let resolvedRoles = [];
  if (serverId && gm?.roles?.length) {
    const rolesRes = await httpRequest('GET', `https://discord.com/api/v9/guilds/${serverId}/roles`, userHeaders(token));
    if (rolesRes.status === 200 && Array.isArray(rolesRes.json)) {
      const map = new Map(rolesRes.json.map((rr) => [rr.id, rr]));
      resolvedRoles = gm.roles
        .map((rid) => map.get(rid))
        .filter((rr) => rr && rr.name !== '@everyone')
        .sort((a, b) => (b.position || 0) - (a.position || 0))
        .map((rr) => ({ id: rr.id, name: rr.name, color: rr.color || 0 }));
    }
  }

  return {
    ok: true,
    id: u.id,
    username: u.username,
    global_name: u.global_name,
    discriminator: u.discriminator,
    avatar,
    banner,
    accent_color: u.accent_color,
    bio: r.json.user_profile?.bio || gm?.bio || '',
    pronouns: r.json.user_profile?.pronouns || '',
    badges: u.public_flags || 0,
    premium_type: u.premium_type || 0,
    nick: gm?.nick || null,
    roles: resolvedRoles,
    member_since: u.id ? new Date(Number((BigInt(u.id) >> 22n) + 1420070400000n)).toISOString() : null,
    joined_at: gm?.joined_at || null,
    premium_since: gm?.premium_since || null,
  };
});

// ---------- IPC: Guild roles (for profile role chips) ----------
ipcMain.handle('guild:roles', async (_e, { token, serverId }) => {
  const r = await httpRequest('GET', `https://discord.com/api/v9/guilds/${serverId}/roles`, userHeaders(token));
  return { ok: r.status === 200, roles: Array.isArray(r.json) ? r.json : [] };
});

// Detect image mime from base64 magic bytes (Discord rejects wrong mime silently)
function detectImageMime(b64) {
  try {
    const buf = Buffer.from(b64.slice(0, 32), 'base64');
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif';
    if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[8] === 0x57 && buf[9] === 0x45) return 'image/webp';
  } catch {}
  return 'image/png';
}

// ---------- IPC: Per-token decorate (with options for which fields to apply) ----------
ipcMain.handle('decorate:one', async (_e, { token, serverId, nickname, avatarB64, bannerB64, bio, applyGlobalAvatar, applyGlobalBanner, applyGlobalName, applyBio }) => {
  const h = { Authorization: token, 'Content-Type': 'application/json' };
  const out = {};
  const fails = [];
  const wantNick = nickname !== undefined && nickname !== null && nickname !== '';

  if (wantNick) {
    const r = await httpRequest('PATCH', `https://discord.com/api/v9/guilds/${serverId}/members/@me`, h, { nick: nickname });
    out.nick = r.status >= 200 && r.status < 300;
    out.nickStatus = r.status;
    if (!out.nick) fails.push(`nick(${r.status}): ${typeof r.body === 'string' ? r.body.slice(0, 200) : ''}`);
  }
  if (avatarB64) {
    const mime = detectImageMime(avatarB64);
    const ep = applyGlobalAvatar ? 'https://discord.com/api/v9/users/@me' : `https://discord.com/api/v9/guilds/${serverId}/members/@me`;
    const r = await httpRequest('PATCH', ep, h, { avatar: `data:${mime};base64,${avatarB64}` });
    out.avatar = r.status >= 200 && r.status < 300;
    out.avatarStatus = r.status;
    if (!out.avatar) fails.push(`avatar(${r.status}): ${typeof r.body === 'string' ? r.body.slice(0, 200) : ''}`);
  }
  if (bannerB64) {
    const mime = detectImageMime(bannerB64);
    const ep = applyGlobalBanner ? 'https://discord.com/api/v9/users/@me' : `https://discord.com/api/v9/guilds/${serverId}/members/@me`;
    const r = await httpRequest('PATCH', ep, h, { banner: `data:${mime};base64,${bannerB64}` });
    out.banner = r.status >= 200 && r.status < 300;
    out.bannerStatus = r.status;
    if (!out.banner) fails.push(`banner(${r.status}): ${typeof r.body === 'string' ? r.body.slice(0, 200) : ''}`);
  }
  if (applyGlobalName && wantNick) {
    const r = await httpRequest('PATCH', 'https://discord.com/api/v9/users/@me', h, { global_name: nickname });
    out.globalName = r.status >= 200 && r.status < 300;
    out.globalNameStatus = r.status;
    if (!out.globalName) fails.push(`global_name(${r.status})`);
  }
  if (applyBio && bio !== undefined) {
    const r = await httpRequest('PATCH', 'https://discord.com/api/v9/users/@me/profile', h, { bio });
    out.bio = r.status >= 200 && r.status < 300;
    out.bioStatus = r.status;
    if (!out.bio) fails.push(`bio(${r.status})`);
  }
  // ok = at least one field was requested AND all requested fields succeeded
  const requested = [wantNick, !!avatarB64, !!bannerB64, !!(applyGlobalName && wantNick), !!(applyBio && bio !== undefined)].filter(Boolean).length;
  const ok = requested > 0 && fails.length === 0;
  return { ok, requested, ...out, error: fails.length ? fails.join(' | ') : undefined };
});

// ============================================================
// ---------- Discord Gateway Presence (Self-bot keep-alive) ----------
// Maintains live WebSocket connections so each token shows ONLINE/DND/IDLE
// status in Discord while the app is running. Auto-reconnects on close.
// State is persisted to disk and resumed on next app launch.
// ============================================================
const PRESENCE_FILE = () => path.join(USER_DATA(), 'sf1-presence.json');
const presenceMap = new Map(); // token -> { ws, status, hb, alive, retries }
let presenceWindow = null;

function loadPresenceState() {
  try {
    if (!fs.existsSync(PRESENCE_FILE())) return {};
    return JSON.parse(fs.readFileSync(PRESENCE_FILE(), 'utf-8')) || {};
  } catch { return {}; }
}
function savePresenceState() {
  try {
    const obj = {};
    for (const [tk, ent] of presenceMap.entries()) obj[tk] = ent.status;
    fs.mkdirSync(USER_DATA(), { recursive: true });
    fs.writeFileSync(PRESENCE_FILE(), JSON.stringify(obj));
  } catch {}
}
function emitPresence(token, state) {
  if (presenceWindow && !presenceWindow.isDestroyed()) {
    presenceWindow.webContents.send('presence:update', { token, state });
  }
}

function startPresence(token, status = 'online') {
  if (!WS) return false;
  stopPresence(token, /*persist*/ false);
  let seq = null;
  let hb = null;
  let closedByUs = false;
  const ent = { ws: null, status, hb: null, alive: false, retries: 0, closedByUs: false };
  presenceMap.set(token, ent);

  const connect = () => {
    let ws;
    try {
      ws = new WS('wss://gateway.discord.gg/?v=9&encoding=json');
    } catch { return scheduleRetry(); }
    ent.ws = ws;
    ws.on('open', () => { ent.retries = 0; });
    ws.on('message', (raw) => {
      let p; try { p = JSON.parse(raw.toString()); } catch { return; }
      if (p.s != null) seq = p.s;
      if (p.op === 10) {
        const interval = p.d.heartbeat_interval || 41250;
        if (hb) clearInterval(hb);
        hb = setInterval(() => { try { ws.send(JSON.stringify({ op: 1, d: seq })); } catch {} }, interval);
        ent.hb = hb;
        // IDENTIFY
        try {
          ws.send(JSON.stringify({
            op: 2,
            d: {
              token,
              capabilities: 16381,
              properties: { os: 'Windows', browser: 'Chrome', device: 'PC', browser_user_agent: UA, browser_version: '108.0.0.0', os_version: '10', client_build_number: 296364 },
              presence: { status: ent.status, since: ent.status === 'idle' ? Date.now() : 0, activities: [], afk: ent.status === 'idle' },
              intents: 0,
            },
          }));
        } catch {}
      } else if (p.op === 0 && p.t === 'READY') {
        ent.alive = true;
        emitPresence(token, { status: ent.status, alive: true });
      } else if (p.op === 9) {
        // invalid session
        try { ws.close(); } catch {}
      }
    });
    const cleanup = () => {
      if (hb) { clearInterval(hb); hb = null; }
      ent.alive = false;
      ent.ws = null;
      emitPresence(token, { status: ent.status, alive: false });
      if (!ent.closedByUs && presenceMap.get(token) === ent) {
        scheduleRetry();
      }
    };
    ws.on('close', cleanup);
    ws.on('error', () => { try { ws.terminate(); } catch {} });
  };
  const scheduleRetry = () => {
    ent.retries = Math.min(ent.retries + 1, 8);
    const delay = Math.min(60000, 2000 * Math.pow(2, ent.retries));
    setTimeout(() => { if (presenceMap.get(token) === ent && !ent.closedByUs) connect(); }, delay);
  };
  connect();
  return true;
}

function stopPresence(token, persist = true) {
  const ent = presenceMap.get(token);
  if (ent) {
    ent.closedByUs = true;
    if (ent.hb) clearInterval(ent.hb);
    try { ent.ws && ent.ws.close(); } catch {}
    presenceMap.delete(token);
    emitPresence(token, { status: 'offline', alive: false });
  }
  if (persist) savePresenceState();
}

function setPresenceStatus(token, status) {
  const ent = presenceMap.get(token);
  if (!ent) { startPresence(token, status); savePresenceState(); return true; }
  ent.status = status;
  if (ent.ws && ent.alive) {
    try {
      ent.ws.send(JSON.stringify({
        op: 3,
        d: { status, since: status === 'idle' ? Date.now() : 0, activities: [], afk: status === 'idle' },
      }));
    } catch {}
  }
  savePresenceState();
  emitPresence(token, { status, alive: ent.alive });
  return true;
}

ipcMain.handle('presence:set', (_e, { token, status }) => {
  if (!WS) return { ok: false, error: 'ws-missing' };
  if (status === 'offline') { stopPresence(token); return { ok: true }; }
  setPresenceStatus(token, status);
  return { ok: true };
});
ipcMain.handle('presence:setMany', (_e, { tokens, status }) => {
  if (!WS) return { ok: false, error: 'ws-missing' };
  let n = 0;
  for (const t of (tokens || [])) {
    if (status === 'offline') stopPresence(t); else setPresenceStatus(t, status);
    n++;
  }
  return { ok: true, n };
});
ipcMain.handle('presence:stop', (_e, { token }) => { stopPresence(token); return { ok: true }; });
ipcMain.handle('presence:state', () => {
  const out = {};
  for (const [tk, ent] of presenceMap.entries()) out[tk] = { status: ent.status, alive: ent.alive };
  return out;
});

// Restore presence on startup
function restorePresenceOnStartup() {
  if (!WS) return;
  const state = loadPresenceState();
  for (const tk of Object.keys(state)) {
    const st = state[tk];
    if (st && st !== 'offline') startPresence(tk, st);
  }
}

// ---------- IPC: Boost (مطابق لـ code1.py) ----------
async function exchangeCode(code, botCfg) {
  const data = `client_id=${encodeURIComponent(botCfg.client_id)}&client_secret=${encodeURIComponent(botCfg.secret)}&grant_type=authorization_code&code=${encodeURIComponent(code)}&redirect_uri=${encodeURIComponent('http://localhost:8080')}`;
  const r = await httpRequest('POST', 'https://canary.discord.com/api/v9/oauth2/token', { 'Content-Type': 'application/x-www-form-urlencoded' }, data);
  return r.status >= 200 && r.status < 300 ? r.json : null;
}

async function addToGuild(accessToken, userId, serverId, botToken) {
  return await httpRequest('PUT', `https://canary.discord.com/api/v9/guilds/${serverId}/members/${userId}`,
    { 'Authorization': `Bot ${botToken}`, 'Content-Type': 'application/json' },
    { access_token: accessToken });
}

ipcMain.handle('boost:run', async (event, { token, serverId, nickname, botCfg }) => {
  const log = (msg, type = 'info') => event.sender.send('boost:log', { token: '***', msg, type });

  // 1) Authorize
  const authUrl = `https://canary.discord.com/api/v9/oauth2/authorize?client_id=${botCfg.client_id}&redirect_uri=${encodeURIComponent('http://localhost:8080')}&response_type=code&scope=identify%20guilds.join`;
  const auth = await httpRequest('POST', authUrl, userHeaders(token), { authorize: true });
  if (auth.status !== 200 || !auth.json?.location) {
    log(`Authorize failed (${auth.status})`, 'error');
    return { ok: false };
  }
  const code = auth.json.location.replace(/.*\?code=/, '');
  const exch = await exchangeCode(code, botCfg);
  if (!exch?.access_token) { log('Token exchange failed', 'error'); return { ok: false }; }

  // 2) Get user id
  const me = await httpRequest('GET', 'https://canary.discord.com/api/v9/users/@me', { Authorization: `Bearer ${exch.access_token}` });
  const userId = me.json?.id;
  if (!userId) { log('Get user failed', 'error'); return { ok: false }; }

  // 3) Join guild via bot
  const join = await addToGuild(exch.access_token, userId, serverId, botCfg.tkn);
  log(`Joined server (${join.status})`, 'success');

  // 4) Nickname
  if (nickname) {
    const nick = await httpRequest('PATCH', `https://canary.discord.com/api/v9/guilds/${serverId}/members/@me`, userHeaders(token), { nick: nickname });
    log(`Nickname (${nick.status})`, nick.status < 300 ? 'success' : 'warn');
  }

  // 5) Boost slots — send ALL usable slots in a SINGLE request
  const slots = await httpRequest('GET', 'https://canary.discord.com/api/v9/users/@me/guilds/premium/subscription-slots', userHeaders(token));
  if (!Array.isArray(slots.json) || slots.json.length === 0) { log('No slots', 'warn'); return { ok: true, boosts: 0 }; }

  const now = Date.now();
  const usable = slots.json.filter((s) => {
    if (!s) return false;
    if (s.canceled) return true;
    if (!s.premium_guild_subscription) return true;
    if (s.cooldown_ends_at && new Date(s.cooldown_ends_at).getTime() < now) return true;
    return false;
  });

  if (usable.length === 0) {
    const already = slots.json.filter((s) => s.premium_guild_subscription?.guild_id === serverId).length;
    if (already > 0) { log(`Already boosting with ${already} slot(s)`, 'success'); return { ok: true, boosts: already }; }
    log('No available slots', 'warn');
    return { ok: true, boosts: 0 };
  }

  const slotIds = usable.map((s) => s.id);
  const r = await httpRequest('PUT', `https://canary.discord.com/api/v9/guilds/${serverId}/premium/subscriptions`, userHeaders(token), { user_premium_guild_subscription_slot_ids: slotIds });
  const ok = r.status >= 200 && r.status < 300;
  log(ok ? `Boost applied x${slotIds.length}` : `Boost failed (${r.status})`, ok ? 'success' : 'error');
  return { ok, boosts: ok ? slotIds.length : 0 };
});

// ---------- IPC: Nick + Avatar + Banner (code2.py) ----------
ipcMain.handle('decorate:run', async (event, { token, serverId, nickname, avatarB64, bannerB64 }) => {
  const log = (msg, type = 'info') => event.sender.send('decorate:log', { token: '***', msg, type });
  const h = { Authorization: token, 'Content-Type': 'application/json' };
  let okN = true, okA = true, okB = true;
  if (nickname) {
    const r = await httpRequest('PATCH', `https://discord.com/api/v9/guilds/${serverId}/members/@me/nick`, h, { nick: nickname });
    okN = r.status === 200;
  }
  if (avatarB64) {
    const r = await httpRequest('PATCH', `https://discord.com/api/v9/guilds/${serverId}/members/@me`, h, { avatar: `data:image/png;base64,${avatarB64}` });
    okA = r.status === 200;
  }
  if (bannerB64) {
    const r = await httpRequest('PATCH', `https://discord.com/api/v9/guilds/${serverId}/members/@me`, h, { banner: `data:image/png;base64,${bannerB64}` });
    okB = r.status === 200;
  }
  log(`nick:${okN} avatar:${okA} banner:${okB}`, (okN && okA && okB) ? 'success' : 'warn');
  return { ok: okN && okA && okB, nickname: okN, avatar: okA, banner: okB };
});

// ---------- IPC: Joiner — OAuth-join the server WITHOUT boosting ----------
// Same flow as boost (authorize → exchange → addToGuild → optional nick)
// but skips the boost step. Used to populate the server with members.
ipcMain.handle('joiner:join', async (event, { token, serverId, nickname, botCfg }) => {
  const log = (msg, type = 'info') => event.sender.send('boost:log', { token: '***', msg, type });
  const authUrl = `https://canary.discord.com/api/v9/oauth2/authorize?client_id=${botCfg.client_id}&redirect_uri=${encodeURIComponent('http://localhost:8080')}&response_type=code&scope=identify%20guilds.join`;
  const auth = await httpRequest('POST', authUrl, userHeaders(token), { authorize: true });
  if (auth.status !== 200 || !auth.json?.location) { log(`Authorize failed (${auth.status})`, 'error'); return { ok: false }; }
  const code = auth.json.location.replace(/.*\?code=/, '');
  const exch = await exchangeCode(code, botCfg);
  if (!exch?.access_token) { log('Token exchange failed', 'error'); return { ok: false }; }
  const me = await httpRequest('GET', 'https://canary.discord.com/api/v9/users/@me', { Authorization: `Bearer ${exch.access_token}` });
  const userId = me.json?.id;
  if (!userId) { log('Get user failed', 'error'); return { ok: false }; }
  const join = await addToGuild(exch.access_token, userId, serverId, botCfg.tkn);
  const okJoin = join.status >= 200 && join.status < 300;
  log(`Joined (${join.status})`, okJoin ? 'success' : 'warn');
  if (nickname) {
    const nick = await httpRequest('PATCH', `https://canary.discord.com/api/v9/guilds/${serverId}/members/@me`, userHeaders(token), { nick: nickname });
    log(`Nickname (${nick.status})`, nick.status < 300 ? 'success' : 'warn');
  }
  return { ok: okJoin, status: join.status };
});

// ---------- IPC: Profile backup (snapshot global avatar/banner/name BEFORE account-wide change) ----------
ipcMain.handle('profile:snapshot', async (_e, { token }) => {
  const r = await httpRequest('GET', 'https://discord.com/api/v9/users/@me', userHeaders(token));
  if (r.status !== 200 || !r.json) return { ok: false };
  const u = r.json;
  // Try to fetch raw banner color & banner via profile endpoint too (richer)
  const p = await httpRequest('GET', `https://discord.com/api/v9/users/${u.id}/profile?with_mutual_guilds=false`, userHeaders(token));
  const pj = p.status === 200 ? (p.json?.user || {}) : {};
  return {
    ok: true,
    id: u.id,
    avatar_hash: u.avatar || null,
    banner_hash: u.banner || pj.banner || null,
    accent_color: u.accent_color || pj.accent_color || null,
    global_name: u.global_name || null,
    bio: p.json?.user_profile?.bio || '',
    avatar_url: u.avatar ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.${u.avatar.startsWith('a_') ? 'gif' : 'png'}?size=512` : null,
    banner_url: (u.banner || pj.banner) ? `https://cdn.discordapp.com/banners/${u.id}/${u.banner || pj.banner}.${(u.banner || pj.banner).startsWith('a_') ? 'gif' : 'png'}?size=1024` : null,
  };
});

// ---------- IPC: Profile restore — revert account-wide changes using snapshot,
// and clear the server-member overrides so only the original remains. ----------
async function urlToB64(url) {
  return new Promise((resolve) => {
    try {
      https.get(url, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('base64')));
        res.on('error', () => resolve(null));
      }).on('error', () => resolve(null));
    } catch { resolve(null); }
  });
}
ipcMain.handle('profile:restore', async (_e, { token, serverId, snapshot }) => {
  const h = { Authorization: token, 'Content-Type': 'application/json' };
  const out = {};
  if (snapshot) {
    const body = {};
    if (snapshot.avatar_url) {
      const b64 = await urlToB64(snapshot.avatar_url);
      if (b64) body.avatar = `data:image/png;base64,${b64}`;
    } else if (snapshot.avatar_hash === null) body.avatar = null;
    if (snapshot.banner_url) {
      const b64 = await urlToB64(snapshot.banner_url);
      if (b64) body.banner = `data:image/png;base64,${b64}`;
    } else if (snapshot.banner_hash === null) body.banner = null;
    if (snapshot.global_name !== undefined) body.global_name = snapshot.global_name;
    if (Object.keys(body).length) {
      const r = await httpRequest('PATCH', 'https://discord.com/api/v9/users/@me', h, body);
      out.global = r.status === 200;
    }
    if (snapshot.bio !== undefined) {
      const r = await httpRequest('PATCH', 'https://discord.com/api/v9/users/@me/profile', h, { bio: snapshot.bio });
      out.bio = r.status === 200;
    }
  }
  // Clear server-member overrides
  if (serverId) {
    const r1 = await httpRequest('PATCH', `https://discord.com/api/v9/guilds/${serverId}/members/@me`, h, { avatar: null, banner: null });
    const r2 = await httpRequest('PATCH', `https://discord.com/api/v9/guilds/${serverId}/members/@me/nick`, h, { nick: null });
    out.serverClear = r1.status === 200 && r2.status === 200;
  }
  return { ok: true, ...out };
});

// ---------- IPC: Leave server (per token) ----------
ipcMain.handle('member:leave', async (_e, { token, serverId }) => {
  const r = await httpRequest('DELETE', `https://discord.com/api/v9/users/@me/guilds/${serverId}`, userHeaders(token));
  return { ok: r.status >= 200 && r.status < 300, status: r.status };
});

// ---------- IPC: Create invite (uses first valid token) ----------
ipcMain.handle('invite:create', async (_e, { token, channelId }) => {
  const r = await httpRequest('POST', `https://discord.com/api/v9/channels/${channelId}/invites`, userHeaders(token), { max_age: 0, max_uses: 0, unique: false });
  return r.status >= 200 && r.status < 300 ? { ok: true, code: r.json?.code, url: `https://discord.gg/${r.json?.code}` } : { ok: false, status: r.status };
});
function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 720,
    backgroundColor: '#0a0118',
    autoHideMenuBar: true,
    title: 'SF1 Boost Tool',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      devTools: false,
      spellcheck: false,
    },
  });

  win.setMenuBarVisibility(false);
  win.removeMenu();

  // Block opening DevTools at any time
  win.webContents.on('devtools-opened', () => win.webContents.closeDevTools());
  win.webContents.on('before-input-event', (event, input) => {
    const k = (input.key || '').toLowerCase();
    if (
      k === 'f12' ||
      (input.control && input.shift && (k === 'i' || k === 'j' || k === 'c')) ||
      (input.meta && input.alt && (k === 'i' || k === 'j' || k === 'c')) ||
      (input.control && k === 'u')
    ) {
      event.preventDefault();
    }
  });

  // Identifier header so the website knows it's Electron
  win.webContents.session.webRequest.onBeforeSendHeaders((details, cb) => {
    details.requestHeaders['X-SF1-Client'] = 'electron';
    details.requestHeaders['User-Agent'] = (details.requestHeaders['User-Agent'] || '') + ' SF1Electron/1.0';
    cb({ requestHeaders: details.requestHeaders });
  });

  win.loadURL(APP_URL);
  presenceWindow = win;
}

app.whenReady().then(() => {
  createWindow();
  ['CommandOrControl+Shift+I', 'CommandOrControl+Shift+J', 'CommandOrControl+Shift+C', 'F12', 'CommandOrControl+U']
    .forEach((acc) => globalShortcut.register(acc, () => {}));
  setTimeout(restorePresenceOnStartup, 1500);
});
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  for (const [tk] of presenceMap.entries()) stopPresence(tk, false);
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
