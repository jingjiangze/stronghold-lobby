// src/index.js — sp-lobby-board thin Cloudflare adapter: Module Worker + ONE Durable Object.
//
// EGRESS: board routes have none; the ONLY outbound requests are the community relay below, whose
// upstreams are FROZEN CONSTANTS (the client sends a source KEY, never a URL) — no SSRF surface.
// Every relay request still re-validates scheme + host (see targetHostDenyReason) per the standing
// constraint: http/https only, no loopback/private/reserved targets.
//
// ROUTES
//   OPTIONS *              CORS preflight (204)
//   GET  /                 the public lobby page (src/page.js) — live room board, join/spectate
//   GET  /api/rooms        rainya-shaped board: { ok, now, ttlSec:600, rooms:[...] }
//                          (GET also prepends the pinned NOTICE row — see noticeRow())
//   POST /api/rooms        JSON { code, serverId, serverName, note?, url?, difficulty? } -> 201 { ok, added, token }
//   PATCH /api/rooms       JSON { code, serverId, note }  header X-Token      -> 200 { ok, updated }
//                          (only the note changes; createdAt/TTL/url are NOT refreshed)
//   DELETE /api/rooms?code=&serverId=      header X-Token: <token>          -> 200 { ok, removed }
//   GET  /api/community?src=rainya|lunar|rinko   relayed { ok, src, fetchedAt, rooms:[...] }
//        v6: `src` also accepts a comma list (1..3 whitelist keys, order preserved, deduped):
//        `?src=rainya,lunar,rinko` answers once for all of them — rows get a per-row `src`, a source
//        that fails lands in `errors:{<key>:'UPSTREAM'}` instead of failing the whole call (all three
//        failing is still a 502). The lobby page uses the combined form: one request per cycle
//        instead of three (96 → 72 requests/hour per visible tab).
//   GET  /api/match?id=<handle>            queue/match status for one searcher
//   POST /api/match {difficulty, venue:{kind, serverId?}}    join the cross-server match queue
//   POST /api/match/room {id, code, serverId, url?}          header X-Token — the HOST posts the room
//   DELETE /api/match?id=<handle>          header X-Token — leave the queue / drop out of a match
//   GET  /api/health       { ok:true, now } — stateless liveness probe for deploy self-check
// Board responses carry `cache-control: no-store`; the community relay's 200 uses
// `public, max-age=10, s-maxage=60` (partial answers 10) so a zone Cache Rule can serve repeat
// polls from the edge without invoking this Worker, while every error path stays `no-store`
// (never let a 4xx/5xx poison the CDN — the negative-cache lesson).
// Error codes -> HTTP status: BAD_JSON/BAD_CODE/BAD_SERVER/BAD_URL/BAD_SRC/BAD_DIFFICULTY/BAD_VENUE/
// BAD_ID 400, FORBIDDEN 403, NOT_FOUND 404, METHOD_NOT_ALLOWED 405, RATE_LIMITED/DEBOUNCED/
// LIMIT_REACHED 429, INTERNAL 500.

import { createBoard, targetHostDenyReason, CODE_RE, TTL_SEC } from './board.js';
import { createMatch } from './match.js';
import { PAGE_HTML } from './page.js';

/** The single DO instance name — one board for every caller (singleton semantics). */
const BOARD_OBJECT_NAME = 'board';
/** The match queue lives in its OWN Durable Object (idFromName('match')) — queue and board never
 *  share storage, so neither can evict or corrupt the other's entries. */
const MATCH_OBJECT_NAME = 'match';
/** Max accepted JSON body size for POST/PATCH (bytes of the raw request text). */
const BODY_MAX = 8 * 1024;

/**
 * Community relay upstreams — FROZEN constants. The three community sources send no CORS headers
 * (rainya portal OPTIONS 403; lunar/rinko OPTIONS 405), so a browser/WebView page cannot read them
 * cross-origin; this relay is the door. The client only ever sends the KEY (`src`).
 */
const COMMUNITY_SOURCES = Object.freeze({
  rainya: Object.freeze({ url: 'https://game.rainya.me/api/rooms' }),
  lunar: Object.freeze({
    url: 'https://stronghold.lunar.ag/api/rooms',
    host: 'stronghold.lunar.ag',
    serverId: 'lunar',
    serverName: 'Lunar',
  }),
  rinko: Object.freeze({
    url: 'https://xn--rlr.rinko.ai/api/rooms',
    host: 'xn--rlr.rinko.ai',
    serverId: 'rinko',
    serverName: '梨子湖',
  }),
});
/** Relay fetch timeout (tests override via env.RELAY_TIMEOUT_MS). */
const RELAY_TIMEOUT_MS = 4000;
/** Accepted upstream body size ceiling; larger responses are treated as upstream failure. */
const RELAY_MAX_TEXT = 256 * 1024;

/**
 * Map a lunar/rinko live-lobby row into the rainya-shaped row the client already understands.
 * `hostName` is the HOST PLAYER's name, not a server name — it becomes the note, and the fixed
 * station name goes into `server`/`serverName`. `leftSec` is synthetic (live rows have no TTL) so
 * the client's `left > 0` gate keeps working; `live: true` tells the UI to show 「在线」 instead.
 */
function mapLiveRoom(source, row) {
  if (!row || typeof row !== 'object') return null;
  const code = String(row.roomId || '').toUpperCase();
  if (!CODE_RE.test(code)) return null;
  const occupied = Number.isInteger(row.occupied) ? row.occupied : null;
  const capacity = Number.isInteger(row.capacity) ? row.capacity : null;
  const full = occupied !== null && capacity !== null && capacity > 0 && occupied >= capacity;
  const out = {
    code,
    server: source.serverName,
    serverName: source.serverName,
    serverId: source.serverId,
    url: `https://${source.host}/?room=${code}`,
    leftSec: TTL_SEC,
    live: true,
    status: row.inMatch === true ? 'playing' : (full ? 'full' : 'waiting'),
  };
  if (typeof row.hostName === 'string' && row.hostName) out.note = `房主：${row.hostName}`.slice(0, 40);
  if (occupied !== null) out.occupied = occupied;
  if (capacity !== null) out.capacity = capacity;
  if (Number.isInteger(row.connectedHumans)) out.humans = row.connectedHumans;
  if (Number.isInteger(row.spectatorCount)) out.spectators = row.spectatorCount;
  if (typeof row.difficulty === 'string' && row.difficulty) out.difficulty = row.difficulty;
  return out;
}

/** Relay ONE community source. Returns { ok:true, rooms } | { ok:false } — no HTTP shape here,
 *  so the single-source and the combined (comma-list) paths share one implementation. */
async function relayOne(key, env) {
  const source = Object.prototype.hasOwnProperty.call(COMMUNITY_SOURCES, key) ? COMMUNITY_SOURCES[key] : null;
  if (!source) return { ok: false };

  // Defensive validation even though every upstream is a frozen constant: scheme must be https and
  // the host must not be loopback/private/reserved (same deny table the board uses for submitted URLs).
  let target = null;
  try { target = new URL(source.url); } catch { target = null; }
  if (!target || target.protocol !== 'https:' || targetHostDenyReason(target.hostname)) return { ok: false };

  const timeoutMs = Number(env && env.RELAY_TIMEOUT_MS) > 0 ? Number(env.RELAY_TIMEOUT_MS) : RELAY_TIMEOUT_MS;
  let res;
  try {
    res = await fetch(target.toString(), {
      method: 'GET',
      redirect: 'manual', // a 3xx is an upstream failure: never follow to another host
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { ok: false };
  }
  if (!res.ok) return { ok: false };

  let text;
  try { text = await res.text(); } catch { return { ok: false }; }
  if (text.length > RELAY_MAX_TEXT) return { ok: false };
  let data;
  try { data = JSON.parse(text); } catch { return { ok: false }; }

  let rooms;
  if (key === 'rainya') {
    rooms = data && Array.isArray(data.rooms) ? data.rooms : null;
  } else {
    const items = data && Array.isArray(data.items) ? data.items : null;
    rooms = items ? items.map((row) => mapLiveRoom(source, row)).filter(Boolean) : null;
  }
  if (!rooms) return { ok: false };
  return { ok: true, rooms };
}

/** Full success is edge-cacheable for 60s (a zone Cache Rule may serve repeat polls without running
 *  this Worker); a partial answer keeps the old 10s so a recovered source is picked up quickly. */
const RELAY_CACHE_FULL = 'public, max-age=10, s-maxage=60';
const RELAY_CACHE_PARTIAL = 'public, max-age=10, s-maxage=10';
/** Max sources in one combined call (there are only three; the cap keeps the URL grammar tight). */
const RELAY_SRC_MAX = 3;
/** The whitelist order — the ONLY order a combined `src` list may use (canonical form). */
const SOURCE_ORDER = Object.keys(COMMUNITY_SOURCES);

/**
 * Relay the community sources named by `srcParam` (one key, or a comma list of 1..3 whitelist keys).
 *   ?src=lunar          → the historic single-source envelope（形状不变）
 *   ?src=rainya,lunar   → { ok, src:'rainya,lunar', fetchedAt, rooms:[{...,src:'rainya'|'lunar'}],
 *                           errors?: { <key>: 'UPSTREAM' } } — 一个源挂了不拖垮整次调用；三个全挂才 502。
 * 列表必须是**规范拼写**：白名单顺序、无重复、无空条目、无空白 —— 同一组源只有一种 URL，
 * 缓存键唯一（否则等价拼写可以绕开边缘缓存、把上游请求放大 N 倍）。
 * Returns { status, body, cache } — the caller attaches CORS.
 */
async function relayCommunity(srcParam, env) {
  const raw = String(srcParam == null ? '' : srcParam);
  const keys = raw === '' ? [] : raw.split(',');
  if (keys.length === 0 || keys.length > RELAY_SRC_MAX) {
    return { status: 400, body: { ok: false, error: 'BAD_SRC' }, cache: 'no-store' };
  }
  if (keys.some((key) => key === '')) {
    return { status: 400, body: { ok: false, error: 'BAD_SRC' }, cache: 'no-store' };   // "a,,b" / 尾随逗号
  }
  if (new Set(keys).size !== keys.length) {
    return { status: 400, body: { ok: false, error: 'BAD_SRC' }, cache: 'no-store' };   // 重复键
  }
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(COMMUNITY_SOURCES, key)) {
      return { status: 400, body: { ok: false, error: 'BAD_SRC' }, cache: 'no-store' };
    }
  }
  // 规范顺序（同时挡掉空白变体：'rainya, lunar' 的第二个键不在白名单里，先被上面拒绝）
  if (SOURCE_ORDER.filter((key) => keys.includes(key)).join(',') !== keys.join(',')) {
    return { status: 400, body: { ok: false, error: 'BAD_SRC' }, cache: 'no-store' };
  }
  const unique = keys;

  const results = await Promise.all(unique.map((key) => relayOne(key, env)));
  const failed = unique.filter((key, i) => !results[i].ok);
  if (failed.length === unique.length) {
    return { status: 502, body: { ok: false, error: 'UPSTREAM' }, cache: 'no-store' };
  }

  const body = { ok: true, src: unique.join(','), fetchedAt: Date.now(), rooms: [] };
  unique.forEach((key, i) => {
    if (!results[i].ok) return;
    if (unique.length === 1) {
      // single-source envelope stays byte-identical to the historic one (rainya 原样透传)
      for (const row of results[i].rooms) body.rooms.push(row);
      return;
    }
    // v6: in a combined answer every row must stay attributable → per-row `src`
    for (const row of results[i].rooms) body.rooms.push({ ...row, src: key });
  });
  if (failed.length) body.errors = Object.fromEntries(failed.map((key) => [key, 'UPSTREAM']));
  return { status: 200, body, cache: failed.length ? RELAY_CACHE_PARTIAL : RELAY_CACHE_FULL };
}


const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
  'access-control-allow-headers': 'Content-Type,X-Token,X-Device',
};

/**
 * Pinned lobby notice — ONE synthetic row prepended to every GET /api/rooms.
 *
 * Why a row and not a `notice` field: the APK's lobby panel renders board rows (code + difficulty
 * + note + state) and has no generic message surface, so a notice has to travel room-shaped. The
 * `status: 'closed'` makes it non-joinable, so the panel shows a disabled button and our page
 * renders it as an inert banner instead of a card.
 *
 * The text lives in env (wrangler [vars] NOTICE_TEXT): edit it there and redeploy to change the
 * wording, or set it to "" to switch the notice off — no code change either way.
 */
const NOTICE_CODE = 'NEWS';
const NOTICE_DEFAULT_TEXT = '官方 0.2.0 已发布：本 App 仍是 0.1.4 内容，适配完成前不建议使用，请等适配版。';

/** @returns {object|null} the notice row, or null when the notice is switched off. */
function noticeRow(env) {
  const text = String((env && env.NOTICE_TEXT) ?? NOTICE_DEFAULT_TEXT).trim();
  if (!text) return null;
  return {
    code: NOTICE_CODE,
    server: '官方公告',
    serverId: 'sp-notice',
    serverName: '官方公告',
    note: '官方已发 0.2.0',        // the panel's note cell is ~14 chars wide
    difficultyName: '⚠0.2.0适配中', // its own 16-char span in the panel row
    status: 'closed',              // never joinable — the panel disables the action
    ageSec: 0,
    leftSec: TTL_SEC,
    pinned: true,
    notice: text,                  // full text: our web page renders it as a banner
  };
}

/** Prepend the notice to a board GET response, preserving status and headers. */
async function withNotice(response, env) {
  const row = noticeRow(env);
  if (!row || response.status !== 200) return response;
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { return new Response(text, { status: response.status, headers: response.headers }); }
  if (body && Array.isArray(body.rooms)) {
    body.rooms = [row, ...body.rooms.filter((r) => !(r && r.code === NOTICE_CODE))];
    return new Response(JSON.stringify(body), { status: response.status, headers: response.headers });
  }
  return new Response(text, { status: response.status, headers: response.headers });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

/** Attach the CORS headers every response must carry (incl. error responses) + a cache policy. */
function withCors(response, cacheControl = 'no-store') {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(CORS_HEADERS)) headers.set(name, value);
  headers.set('cache-control', cacheControl);
  return new Response(response.body, { status: response.status, headers });
}

function statusFor(error) {
  switch (error) {
    case 'BAD_JSON':
    case 'BAD_CODE':
    case 'BAD_SERVER':
    case 'BAD_URL':
    case 'BAD_DIFFICULTY':
    case 'BAD_VENUE':
    case 'BAD_ID':
      return 400;
    case 'FORBIDDEN':
      return 403;
    case 'NOT_FOUND':
      return 404;
    case 'METHOD_NOT_ALLOWED':
      return 405;
    case 'RATE_LIMITED':
    case 'DEBOUNCED':
    case 'LIMIT_REACHED':
      return 429;
    default:
      return 500;
  }
}

async function readJsonBody(request) {
  let text;
  try {
    text = await request.text();
  } catch {
    return { ok: false };
  }
  if (text.length > BODY_MAX) return { ok: false };
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false };
    return { ok: true, value };
  } catch {
    return { ok: false };
  }
}

/**
 * The Durable Object class: a thin shell holding board state in DO storage (single instance).
 * `state.storage` is the Durable Object storage API (KV-style get/put/delete/list) — NOT the
 * Workers KV product — and the DO input gate serializes requests, so read-modify-write is safe.
 */
export class Board {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    const storage = state.storage;
    this.core = createBoard({
      state: {
        get: (key) => storage.get(key),
        put: (key, value) => storage.put(key, value),
        delete: (key) => storage.delete(key),
        list: () => storage.list(),
      },
    });
  }

  async fetch(request) {
    const url = new URL(request.url);
    const method = (request.method || 'GET').toUpperCase();
    try {
      if (url.pathname === '/api/rooms' && method === 'GET') {
        // v5.2：访客搭车计数 —— 设备号（X-Device，页面 60s 轮询带上）优先，IP 兜底
        return json(await this.core.list(undefined, {
          visitorKey: request.headers.get('x-device') || '',
          ip: request.headers.get('x-client-ip') || '',
        }));
      }
      if (url.pathname === '/api/rooms' && method === 'POST') {
        const body = await readJsonBody(request);
        if (!body.ok) return json({ ok: false, error: 'BAD_JSON' }, 400);
        const ip = request.headers.get('x-client-ip') || '';
        const result = await this.core.add({ ...body.value, ip }); // header IP wins over any body field
        return json(result, result.ok ? 201 : statusFor(result.error));
      }
      if (url.pathname === '/api/rooms' && method === 'PATCH') {
        const body = await readJsonBody(request);
        if (!body.ok) return json({ ok: false, error: 'BAD_JSON' }, 400);
        // token comes from the header ONLY (body token, if any, is discarded)
        const result = await this.core.update({
          ...body.value,
          token: request.headers.get('x-token') || '',
        });
        return json(result, result.ok ? 200 : statusFor(result.error));
      }
      if (url.pathname === '/api/rooms' && method === 'DELETE') {
        const result = await this.core.remove({
          code: url.searchParams.get('code') || '',
          serverId: url.searchParams.get('serverId') || '',
          token: request.headers.get('x-token') || '',
        });
        return json(result, result.ok ? 200 : statusFor(result.error));
      }
      return json({ ok: false, error: 'NOT_FOUND' }, 404);
    } catch (error) {
      return json({ ok: false, error: 'INTERNAL', message: String((error && error.message) || error) }, 500);
    }
  }
}

/**
 * The cross-server match queue Durable Object — a separate singleton (idFromName('match')) running
 * the pure core in src/match.js. A coarse alarm (re-armed on every accepted mutation) sweeps expired
 * queue entries and matches so an abandoned queue does not linger between requests; a failure to arm
 * is never fatal (every request sweeps lazily anyway).
 */
export class MatchQueue {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    const storage = state.storage;
    this.core = createMatch({
      state: {
        get: (key) => storage.get(key),
        put: (key, value) => storage.put(key, value),
        delete: (key) => storage.delete(key),
        list: () => storage.list(),
      },
    });
  }

  async fetch(request) {
    const url = new URL(request.url);
    const method = (request.method || 'GET').toUpperCase();
    try {
      if (url.pathname === '/api/match' && method === 'GET') {
        return json(await this.core.status({
          id: url.searchParams.get('id') || '',
          token: request.headers.get('x-token') || '',
        }));
      }
      if (url.pathname === '/api/match' && method === 'POST') {
        const body = await readJsonBody(request);
        if (!body.ok) return json({ ok: false, error: 'BAD_JSON' }, 400);
        const ip = request.headers.get('x-client-ip') || '';
        const result = await this.core.enqueue({ ...body.value, ip });
        if (result.ok) await this.arm();
        return json(result, result.ok ? 201 : statusFor(result.error));
      }
      if (url.pathname === '/api/match/room' && method === 'POST') {
        const body = await readJsonBody(request);
        if (!body.ok) return json({ ok: false, error: 'BAD_JSON' }, 400);
        const result = await this.core.setRoom({
          ...body.value,
          token: request.headers.get('x-token') || body.value.token || '',
        });
        return json(result, result.ok ? 200 : statusFor(result.error));
      }
      if (url.pathname === '/api/match' && method === 'DELETE') {
        const result = await this.core.cancel({
          id: url.searchParams.get('id') || '',
          token: request.headers.get('x-token') || '',
        });
        return json(result, result.ok ? 200 : statusFor(result.error));
      }
      return json({ ok: false, error: 'NOT_FOUND' }, 404);
    } catch (error) {
      return json({ ok: false, error: 'INTERNAL', message: String((error && error.message) || error) }, 500);
    }
  }

  async alarm() {
    try {
      const swept = await this.core.sweep();
      if (swept.pending) await this.arm();
    } catch { /* an alarm failure must never wedge the queue — requests sweep lazily */ }
  }

  async arm() {
    try {
      await this.state.storage.setAlarm(Date.now() + 30_000);
    } catch { /* alarms unavailable (older runtime): lazy sweeps still cover every request */ }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const method = (request.method || 'GET').toUpperCase();
    try {
      if (method === 'OPTIONS') return withCors(new Response(null, { status: 204 }));

      if (url.pathname === '/' || url.pathname === '/index.html') {
        if (method !== 'GET' && method !== 'HEAD') return withCors(json({ ok: false, error: 'METHOD_NOT_ALLOWED' }, 405));
        // Static page: no env, no DO hop — live data arrives via the same-origin /api/rooms poll.
        return new Response(PAGE_HTML, {
          status: 200,
          headers: {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'public, max-age=60',
            'x-content-type-options': 'nosniff',
          },
        });
      }

      if (url.pathname === '/api/health') {
        if (method !== 'GET') return withCors(json({ ok: false, error: 'METHOD_NOT_ALLOWED' }, 405));
        return withCors(json({ ok: true, now: Date.now() })); // stateless — no DO hop
      }

      if (url.pathname === '/api/community') {
        if (method !== 'GET') return withCors(json({ ok: false, error: 'METHOD_NOT_ALLOWED' }, 405));
        // Strict source whitelist: exactly one `src` key, no extra parameters. Rejecting extras also
        // stops cache-busting query strings from punching holes in the edge cache.
        const keys = [...url.searchParams.keys()];
        const src = keys.length === 1 && keys[0] === 'src' ? url.searchParams.get('src') : '';
        const relayed = await relayCommunity(src, env);
        return withCors(json(relayed.body, relayed.status), relayed.cache);
      }

      if (url.pathname === '/api/match' || url.pathname === '/api/match/room') {
        if (method !== 'GET' && method !== 'POST' && method !== 'DELETE') {
          return withCors(json({ ok: false, error: 'METHOD_NOT_ALLOWED' }, 405));
        }
        // Forward to the MATCH queue DO (its own storage); the DO returns the final payload.
        const headers = new Headers();
        headers.set('x-client-ip', request.headers.get('CF-Connecting-IP') || '');
        const token = request.headers.get('X-Token');
        if (token) headers.set('x-token', token);
        let body;
        if (method === 'POST') {
          headers.set('content-type', 'application/json');
          body = await request.text();
        }
        const stub = env.MATCH.get(env.MATCH.idFromName(MATCH_OBJECT_NAME));
        const internal = new Request(`https://match.internal${url.pathname}${url.search}`, { method, headers, body });
        return withCors(await stub.fetch(internal));
      }

      if (url.pathname !== '/api/rooms') {
        return withCors(json({ ok: false, error: 'NOT_FOUND' }, 404));
      }
      if (method !== 'GET' && method !== 'POST' && method !== 'PATCH' && method !== 'DELETE') {
        return withCors(json({ ok: false, error: 'METHOD_NOT_ALLOWED' }, 405));
      }

      // Forward to the singleton DO; the DO returns the final payload, we add the shared headers.
      const headers = new Headers();
      headers.set('x-client-ip', request.headers.get('CF-Connecting-IP') || '');
      const dev = request.headers.get('X-Device');
      if (dev) headers.set('x-device', dev);
      const token = request.headers.get('X-Token');
      if (token) headers.set('x-token', token);
      let body;
      if (method === 'POST' || method === 'PATCH') {
        headers.set('content-type', 'application/json');
        body = await request.text();
      }
      const stub = env.BOARD.get(env.BOARD.idFromName(BOARD_OBJECT_NAME));
      const internal = new Request(`https://board.internal${url.pathname}${url.search}`, { method, headers, body });
      const forwarded = await stub.fetch(internal);
      // GET carries the pinned notice (a room-shaped row the APK panel can render); writes do not.
      return withCors(method === 'GET' ? await withNotice(forwarded, env) : forwarded);
    } catch (error) {
      return withCors(json({ ok: false, error: 'INTERNAL', message: String((error && error.message) || error) }, 500));
    }
  },
};
