// page.test.mjs — functional smoke test for the inline script inside src/page.js.
//
// The page is one self-contained document, so there is no module to import. Instead we extract its
// <script> and run it inside node:vm with a minimal DOM stub + stubbed same-origin fetch, then
// assert what actually lands in the room list: ordering, action buttons, escaping, hostile-URL
// fallback and the offline state. This is the cheapest gate that would catch a broken renderer.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

import { PAGE_HTML } from './src/page.js';

function stubEl() {
  return { textContent: '', innerHTML: '' };
}

/** Run the page script against a fixed /api/rooms payload; returns the mounted list after a tick. */
async function runPage(payload, { failFetch = false } = {}) {
  const script = PAGE_HTML.match(/<script>([\s\S]*?)<\/script>/)[1];
  const list = stubEl();
  list.querySelectorAll = () => [];
  list.querySelector = () => null;
  const els = { list, status: stubEl(), visitors: stubEl(), countdown: stubEl(), live: stubEl() };
  const ctx = {
    document: {
      getElementById: (id) => els[id] || null,
      addEventListener: () => {},
      hidden: false,
    },
    window: { open: () => { throw new Error('window.open must only fire on a real click'); } },
    setInterval: () => 0,
    fetch: () => (failFetch
      ? Promise.reject(new Error('offline'))
      : Promise.resolve({ ok: true, json: () => Promise.resolve(payload) })),
    URL, Date, Math, Number, String, Array, Object, JSON, RegExp, Error, Promise,
  };
  vm.createContext(ctx);
  vm.runInContext(script, ctx);
  await new Promise((resolve) => setTimeout(resolve, 0)); // let the fetch microtask chain settle
  return { list, els };
}

const ROOM_OPEN = {
  code: 'AAAA', serverId: 's1', serverName: 'raiya服', occupied: 2, capacity: 4,
  difficulty: 'ABYSS', note: '来玩', status: 'waiting', createdAt: 1_751_000_000_000,
  url: 'https://game.example.com/play',
};
const ROOM_LIVE = {
  code: 'BBBB', serverId: 's2', serverName: 'Lunar', occupied: 4, capacity: 4,
  inMatch: true, status: 'playing', createdAt: 1_751_000_100_000,
  url: 'https://stronghold.lunar.ag/',
};
const ROOM_FULL = {
  code: 'CCCC', serverId: 's3', serverName: '梨子湖', occupied: 4, capacity: 4,
  status: 'full', createdAt: 1_751_000_200_000, url: 'https://xn--rlr.rinko.ai/',
};
const ROOM_HOSTILE = {
  code: 'DDDD', serverId: 's4', serverName: 'evil', occupied: 1, capacity: 4,
  note: '<img src=x onerror=alert(1)>', createdAt: 1_751_000_300_000,
  url: 'http://127.0.0.1:3000/steal',
};
const ROOM_NOSEAT = {
  code: 'EEEE', serverId: 's5', serverName: '老条目服',
  createdAt: 1_750_999_000_000, url: 'https://game.example.com/',
};

test('page: renders joinable first, 观战 for in-match, disabled 满员, escaped notes', async () => {
  const { list, els } = await runPage({ ok: true, now: 0, ttlSec: 600, visitors: 7, rooms: [ROOM_FULL, ROOM_LIVE, ROOM_OPEN, ROOM_HOSTILE, ROOM_NOSEAT] });

  const html = list.innerHTML;
  // Ordering: joinable rooms first (newest first inside the group), then the playing room, then full.
  assert.ok(html.indexOf('DDDD') < html.indexOf('AAAA'), 'newest open room leads');
  assert.ok(html.indexOf('AAAA') < html.indexOf('BBBB'), 'open rooms sort before the in-match room');
  assert.ok(html.indexOf('BBBB') < html.indexOf('CCCC'), 'in-match sorts before full');

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
});

test('page: empty board and offline state render explicit guidance', async () => {
  const empty = await runPage({ ok: true, now: 0, ttlSec: 600, visitors: 0, rooms: [] });
  assert.match(empty.list.innerHTML, /现在没有公开的房间/);

  const down = await runPage(null, { failFetch: true });
  assert.match(down.list.innerHTML, /暂时连不上大厅服务/);
  assert.match(down.els.status.textContent, /连接大厅失败/);
});
