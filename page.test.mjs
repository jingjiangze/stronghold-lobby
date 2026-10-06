// page.test.mjs — functional smoke test for the inline script inside src/page.js.
//
// The page is one self-contained document, so there is no module to import. Instead we extract its
// <script> and run it inside node:vm with a minimal DOM stub + stubbed same-origin fetch, then
// assert what actually lands in the room list: ordering, action buttons, escaping, hostile-URL
// fallback and the offline state. This is the cheapest gate that would catch a broken renderer.
//
// 提交房间 (v0.2) is covered the same way: the page exposes its pure helpers + the three board
// actions on `window.__SP_PAGE`, so the tests drive real requests through the stubbed fetch and
// then assert on the re-rendered card (badge / 改备注 / 销毁) and on the localStorage token store.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

import { PAGE_HTML } from './src/page.js';

function makeEl(id) {
  return {
    id: id,
    textContent: '', innerHTML: '', value: '', hidden: false, disabled: false, className: '',
    style: {}, _handlers: {},
    addEventListener(ev, fn) { (this._handlers[ev] = this._handlers[ev] || []).push(fn); },
    setAttribute() {}, getAttribute() { return null; },
    querySelectorAll: () => [], querySelector: () => null,
    classList: { add() {}, remove() {}, toggle() {} },
  };
}

function jsonRes(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status: status,
    json: () => Promise.resolve(body),
  };
}

/** vm-realm objects have their own Object.prototype — normalise before deepStrictEqual. */
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Run the page script against a fixed /api/rooms payload.
 * @param {object} payload      GET /api/rooms body
 * @param {object} [opts]
 * @param {boolean} [opts.failFetch]  make every fetch reject
 * @param {(url:string, options:object) => object} [opts.fetch]  custom responder (records calls)
 * @param {object} [opts.seed]  initial localStorage contents
 * @returns {Promise<{list:object, els:object, api:object, calls:object[], store:Map<string,string>}>}
 */
async function runPage(payload, { failFetch = false, fetch: fetchImpl = null, seed = {} } = {}) {
  const script = PAGE_HTML.match(/<script>([\s\S]*?)<\/script>/)[1];
  const els = {};
  const el = (id) => (els[id] = els[id] || makeEl(id));
  const store = new Map(Object.entries(seed));
  const calls = [];
  const boardResponder = () => (failFetch
    ? Promise.reject(new Error('offline'))
    : Promise.resolve(jsonRes(payload)));
  const fetchStub = (url, options) => {
    calls.push({ url: String(url), options: options || {} });
    return Promise.resolve(fetchImpl ? fetchImpl(String(url), options || {}) : boardResponder());
  };
  const ctx = {
    document: {
      getElementById: (id) => el(id),
      addEventListener: () => {},
      hidden: false,
    },
    window: { open: () => { throw new Error('window.open must only fire on a real click'); } },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { store.set(k, String(v)); },
      removeItem: (k) => { store.delete(k); },
    },
    setInterval: () => 0,
    fetch: fetchStub,
    URL, Date, Math, Number, String, Array, Object, JSON, RegExp, Error, Promise,
  };
  vm.createContext(ctx);
  vm.runInContext(script, ctx);
  await new Promise((resolve) => setTimeout(resolve, 0)); // let the fetch microtask chain settle
  return { list: el('list'), els, api: ctx.window.__SP_PAGE, calls, store };
}

// 行数据与线上同形：board 不外泄 createdAt，只给 ageSec（这里故意混用两种形态，覆盖两条时间路径）。
const NOW = 1_751_000_500_000;
const ROOM_OPEN = {
  code: 'AAAA', serverId: 's1', serverName: 'raiya服', occupied: 2, capacity: 4,
  difficulty: 'ABYSS', note: '来玩', status: 'waiting', createdAt: 1_751_000_000_000, ageSec: 500,
  url: 'https://game.example.com/play',
};
const ROOM_LIVE = {
  code: 'BBBB', serverId: 's2', serverName: 'Lunar', occupied: 4, capacity: 4,
  inMatch: true, status: 'playing', ageSec: 400,
  url: 'https://stronghold.lunar.ag/',
};
const ROOM_FULL = {
  code: 'CCCC', serverId: 's3', serverName: '梨子湖', occupied: 4, capacity: 4,
  status: 'full', ageSec: 400, url: 'https://xn--rlr.rinko.ai/',
};
const ROOM_HOSTILE = {
  code: 'DDDD', serverId: 's4', serverName: 'evil', occupied: 1, capacity: 4, ageSec: 10,
  note: '<img src=x onerror=alert(1)>',
  url: 'http://127.0.0.1:3000/steal',
};
const ROOM_NOSEAT = {
  code: 'EEEE', serverId: 's5', serverName: '老条目服', ageSec: 300, url: 'https://game.example.com/',
};

test('page: renders joinable first, 观战 for in-match, disabled 满员, escaped notes', async () => {
  const { list, els } = await runPage({ ok: true, now: NOW, ttlSec: 600, visitors: 7, rooms: [ROOM_FULL, ROOM_LIVE, ROOM_OPEN, ROOM_HOSTILE, ROOM_NOSEAT] });

  const html = list.innerHTML;
  // Ordering: joinable rooms first, newest (smallest ageSec) first, then playing, then full.
  assert.ok(html.indexOf('DDDD') < html.indexOf('AAAA'), 'freshest open room leads');
  assert.ok(html.indexOf('AAAA') < html.indexOf('BBBB'), 'open rooms sort before the in-match room');
  assert.ok(html.indexOf('BBBB') < html.indexOf('CCCC'), 'in-match sorts before full');

  // Freshness labels: ageSec drives them (createdAt never leaves the board).
  assert.match(html, /刚刚/);      // DDDD, ageSec 10
  assert.match(html, /5 分钟前/);   // EEEE, ageSec 300

  // Actions: 加入 for open rooms, 观战 for the in-match room, disabled 满员 for the full one.
  assert.match(html, /class="btn join" data-href="https:\/\/game\.example\.com\/\?room=AAAA"/);
  assert.match(html, /class="btn watch" data-href="https:\/\/stronghold\.lunar\.ag\/\?room=BBBB&amp;spectate=1"/);
  assert.match(html, /<button class="btn" disabled>满员<\/button>/);

  // Server names are shown verbatim (never hidden); difficulty uses the panel's label table.
  assert.match(html, /raiya服/);
  assert.match(html, />终极</);

  // Notes are escaped: hostile markup must arrive inert.
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.ok(!html.includes('<img'), 'no raw <img> from a note');

  // Seat row only appears when capacity was reported — never a misleading "0/0 人".
  assert.ok(!html.includes('0/0 人'), 'capacity-less room must not render a 0/0 seat row');
  assert.match(html, /2\/4 人/, 'reported seats still render');

  // Hostile URL falls back to the official web entry — never the loopback link.
  assert.ok(!html.includes('127.0.0.1'), 'loopback URL must not survive');
  assert.match(html, /data-href="https:\/\/weishu\.jiangjiangze\.icu\/\?room=DDDD"/);

  assert.match(els.status.textContent, /5 个房间/);
  assert.match(els.visitors.textContent, /大厅访客 7 人/);

  // A room without a local token renders no 我的 affordances.
  assert.ok(!html.includes('data-act="destroy"'), 'no destroy button without an owned token');
});

test('page: empty board and offline state render explicit guidance', async () => {
  const empty = await runPage({ ok: true, now: 0, ttlSec: 600, visitors: 0, rooms: [] });
  assert.match(empty.list.innerHTML, /现在没有公开的房间/);
  assert.match(empty.list.innerHTML, /提交房间/, 'empty state points at the submit entry');

  const down = await runPage(null, { failFetch: true });
  assert.match(down.list.innerHTML, /暂时连不上大厅服务/);
  assert.match(down.els.status.textContent, /连接大厅失败/);
});

test('page: 提交房间面板默认折叠，且新增能力不需要放开 CSP', () => {
  assert.match(PAGE_HTML, /<section class="submit" id="submit" hidden>/);
  assert.match(PAGE_HTML, /id="open-submit"/);
  // The submit/去重 flow is same-origin only: connect-src stays 'self', no new origins.
  assert.match(PAGE_HTML, /connect-src 'self'/);
  assert.ok(!/connect-src[^"]*https:/.test(PAGE_HTML), 'no third-party connect-src');
});

test('page: 房号输入归一 + 提交载荷校验（与服务端同一套规则，先给中文提示）', async () => {
  const { api } = await runPage({ ok: true, now: NOW, rooms: [] });

  // 房号：大写、剔除非法字母（I/O）、最多 4 位。
  assert.equal(api.normalizeCodeInput(' abi1q! '), 'ABQ');
  assert.equal(api.normalizeCodeInput('abcd'), 'ABCD');

  // 缺服务器 / 保留字 / 非法地址 —— 本地先拦，服务端 BAD_* 也有对应中文文案。
  assert.match(api.buildPayload({ code: 'ABCD' }).message, /服务器名/);
  assert.match(api.buildPayload({ code: 'ABC', server: '站长服务' }).message, /4 位字母/);
  assert.match(api.buildPayload({ code: 'ABCD', server: 'local' }).message, /本机服务/);
  assert.match(api.buildPayload({ code: 'ABCD', server: '站长服务', serverId: 'AUTO' }).message, /本机服务/);
  assert.match(api.buildPayload({ code: 'ABCD', server: '站长服务', url: 'http://game.example.com/' }).message, /https/);
  assert.match(api.buildPayload({ code: 'ABCD', server: '站长服务', url: 'https://127.0.0.1:3000/' }).message, /https/);
  assert.match(api.buildPayload({ code: 'ABCD', server: 'x'.repeat(65) }).message, /过长/);

  // 正常载荷：字段 trim、难度白名单大写、地址保留路径、备注截断到 40 码点。
  const ok = api.buildPayload({
    code: 'abcd', server: ' 站长服务 ', serverId: 'weishu', note: '  来玩  ',
    difficulty: 'hard', url: 'https://weishu.jiangjiangze.icu/play',
  });
  assert.equal(ok.ok, true);
  assert.deepEqual(plain(ok.payload), {
    code: 'ABCD', serverId: 'weishu', serverName: '站长服务', note: '来玩',
    difficulty: 'HARD', url: 'https://weishu.jiangjiangze.icu/play',
  });

  // serverId 缺省 = serverName（自有服务器 / 手填服务器名时）；难度白名单外的值静默丢弃。
  assert.deepEqual(plain(api.buildPayload({ code: 'ABCD', server: '小鹿宝', difficulty: 'nope' }).payload),
    { code: 'ABCD', serverId: '小鹿宝', serverName: '小鹿宝' });
  assert.equal(api.buildPayload({ code: 'ABCD', server: '小鹿宝', note: '字'.repeat(60) }).payload.note.length, 40);

  // 错误码 → 中文（服务端 message 是英文调试文案，展示层不用它）。
  assert.match(api.errorText('DEBOUNCED', 'code ABCD was submitted 3s ago; wait 30s'), /30 秒后再试/);
  assert.match(api.errorText('RATE_LIMITED'), /频繁/);
  assert.match(api.errorText('LIMIT_REACHED'), /上限/);
  assert.match(api.errorText('BAD_URL'), /https/);
  assert.equal(api.errorText(undefined, 'boom', 500), 'boom');
  assert.match(api.errorText(undefined, '', 502), /HTTP 502/);
});

test('page: 提交房间 → POST /api/rooms + 存 token，刷新后卡片带「我的」/改备注/销毁', async () => {
  const roomsAfter = {
    ok: true, now: NOW, ttlSec: 600, visitors: 1,
    rooms: [{ code: 'ABCD', serverId: 'weishu', serverName: '站长服务', leftSec: 597, url: 'https://weishu.jiangjiangze.icu/' }],
  };
  const { api, list, calls, store } = await runPage(roomsAfter, {
    fetch: (url, options) => (options.method === 'POST'
      ? jsonRes({ ok: true, added: { code: 'ABCD', serverId: 'weishu', serverName: '站长服务', leftSec: 600 }, token: 'a'.repeat(32) }, 201)
      : jsonRes(roomsAfter)),
  });

  const res = await api.submitRoom({ code: 'abcd', server: '站长服务', serverId: 'weishu' });
  assert.equal(res.ok, true);
  assert.match(res.text, /10 分钟内有效/);

  const post = calls.find((c) => c.options.method === 'POST');
  assert.equal(post.url, '/api/rooms');
  assert.equal(post.options.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(post.options.body), { code: 'ABCD', serverId: 'weishu', serverName: '站长服务' });

  // 凭据落到本源 localStorage（token + serverId 双匹配所需），并带 10 分钟到期时间。
  const saved = JSON.parse(store.get('sp.lobby.mine'));
  assert.equal(saved.ABCD.token, 'a'.repeat(32));
  assert.equal(saved.ABCD.serverId, 'weishu');
  assert.ok(saved.ABCD.expiresAt > Date.now(), 'expiry in the future');

  await api.load();
  const html = list.innerHTML;
  assert.match(html, /class="card mine"/);
  assert.match(html, /badge mine">我的</);
  assert.match(html, /data-act="note" data-code="ABCD"/);
  assert.match(html, /data-act="destroy" data-code="ABCD"/);
  assert.match(html, /剩 10 分钟/, 'owned rooms show the remaining TTL, not "x 分钟前"');

  // 校验失败不发请求（本地拦截）。
  const before = calls.length;
  const bad = await api.submitRoom({ code: 'AB', server: '站长服务' });
  assert.equal(bad.ok, false);
  assert.equal(calls.length, before, 'invalid input never reaches the board');
});

test('page: 销毁自己的房间 → DELETE 带 X-Token；已过期/被重提则清掉本机凭据', async () => {
  const seed = {
    'sp.lobby.mine': JSON.stringify({
      ABCD: { token: 't1', serverId: 'weishu', serverName: '站长服务', expiresAt: Date.now() + 600_000 },
      EEEE: { token: 't2', serverId: 'weishu', serverName: '站长服务', expiresAt: Date.now() + 600_000 },
      FFFF: { token: 't3', serverId: 'weishu', serverName: '站长服务', expiresAt: Date.now() - 1000 },
    }),
  };
  const board = { ok: true, now: NOW, ttlSec: 600, visitors: 1, rooms: [ROOM_NOSEAT] };
  const { api, calls, store } = await runPage(board, {
    seed,
    fetch: (url, options) => {
      if (options.method === 'DELETE') {
        if (url.includes('EEEE')) return jsonRes({ ok: false, error: 'NOT_FOUND', message: 'no live room for this code' }, 404);
        return jsonRes({ ok: true, removed: { code: 'ABCD', serverId: 'weishu' } });
      }
      return jsonRes(board);
    },
  });

  const ok = await api.destroyRoom('ABCD');
  assert.equal(ok.ok, true);
  assert.match(ok.text, /已销毁/);
  const del = calls.find((c) => c.options.method === 'DELETE');
  assert.equal(del.url, '/api/rooms?code=ABCD&serverId=weishu');
  assert.equal(del.options.headers['X-Token'], 't1');

  // 过期（NOT_FOUND）也把本机凭据清掉，免得留一条永远失败的记录。
  const gone = await api.destroyRoom('EEEE');
  assert.equal(gone.ok, true);
  assert.match(gone.text, /已过期/);

  const mine = api.readMine();
  assert.equal(mine.ABCD, undefined);
  assert.equal(mine.EEEE, undefined);
  assert.equal(mine.FFFF, undefined, 'expired credentials are pruned');
  assert.deepEqual(JSON.parse(store.get('sp.lobby.mine')), {}, 'nothing left behind');
});

test('page: 改备注 → PATCH /api/rooms（token 头 + serverId 双匹配，只动 note）', async () => {
  const seed = { 'sp.lobby.mine': JSON.stringify({ ABCD: { token: 't1', serverId: 'weishu', expiresAt: Date.now() + 600_000 } }) };
  const board = { ok: true, now: NOW, ttlSec: 600, visitors: 1, rooms: [] };
  const { api, calls } = await runPage(board, {
    seed,
    fetch: (url, options) => (options.method === 'PATCH'
      ? jsonRes({ ok: true, updated: { code: 'ABCD', serverId: 'weishu', note: '新备注' } })
      : jsonRes(board)),
  });

  const res = await api.saveNote('ABCD', '  新备注  ');
  assert.equal(res.ok, true);

  const patch = calls.find((c) => c.options.method === 'PATCH');
  assert.equal(patch.url, '/api/rooms');
  assert.equal(patch.options.headers['X-Token'], 't1');
  assert.deepEqual(JSON.parse(patch.options.body), { code: 'ABCD', serverId: 'weishu', note: '新备注' });

  // 无本机凭据 → 直接拒绝，不发请求。
  const before = calls.length;
  const r2 = await api.saveNote('ZZZZ', 'x');
  assert.equal(r2.ok, false);
  assert.equal(calls.length, before);
});

test('page: 已知服务器从房间牌推导（供提交表单选，并自动补房间地址）', async () => {
  const { api } = await runPage({ ok: true, now: NOW, rooms: [] });
  const known = api.knownFrom([ROOM_OPEN, ROOM_FULL, { ...ROOM_OPEN, code: 'FFFF' }, { code: 'GGGG', serverName: '', serverId: 's9' }]);
  assert.deepEqual(plain(known), [
    { name: 'raiya服', id: 's1', origin: 'https://game.example.com/' },
    { name: '梨子湖', id: 's3', origin: 'https://xn--rlr.rinko.ai/' },
  ]);
});
