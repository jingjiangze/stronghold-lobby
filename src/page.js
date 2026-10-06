// src/page.js — the lobby's public web page (served by this Worker at GET /).
//
// One self-contained document: no external assets, no third-party requests. The page polls the
// same-origin GET /api/rooms every 20 s and renders the newest rooms first; joinable rooms get a
// 加入 button, in-match rooms get a 观战 button. Outbound navigation is limited to https URLs on
// public hosts (the same scheme/deny-table spirit as the server's targetHostDenyReason), so a
// hostile card can never point the page at loopback/private space.
//
// 提交房间 (v0.2): the page is no longer read-only — a visitor can publish their own room to the
// board (POST /api/rooms, the same endpoint the app's panel uses) and, while its 10-minute TTL
// lasts, edit the note (PATCH) or destroy it (DELETE) from the room card. Nothing about that is
// web-only: the server already ships those routes with CORS, so the whole feature lives in this
// file. Ownership is the token the POST returns; it is kept per room code in localStorage (this
// origin's own store — the page never sends the token anywhere but back to the board).

export const PAGE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="color-scheme" content="dark" />
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'" />
<title>卫戍协议 · 联机大厅</title>
<style>
  :root{
    --bg:#0c0f0e; --panel:#111715; --panel2:#0e1311; --line:#1d2823; --line2:#243530;
    --fg:#c9d2cd; --mut:#77857e; --dim:#5a6a63; --acc:#7ee0b0; --acc2:#4fbf8f;
    --warn:#e8c37e; --danger:#e08d7e; --code:#eaf3ee;
  }
  *{box-sizing:border-box}
  html,body{height:100%}
  body{
    margin:0; background:var(--bg); color:var(--fg);
    font:15px/1.6 "Noto Sans SC",-apple-system,"PingFang SC","Microsoft YaHei",system-ui,sans-serif;
    -webkit-font-smoothing:antialiased; display:flex; flex-direction:column; min-height:100%;
  }
  a{color:var(--acc); text-decoration:none}
  header{padding:26px 20px 14px; max-width:920px; width:100%; margin:0 auto}
  .kicker{color:var(--dim); font-size:12px; letter-spacing:.28em; text-transform:uppercase}
  h1{margin:6px 0 2px; font-size:26px; letter-spacing:.06em}
  .sub{color:var(--mut); font-size:13px}
  .meta{display:flex; gap:14px; align-items:center; margin-top:10px; color:var(--mut); font-size:12.5px; flex-wrap:wrap}
  .dot{width:7px;height:7px;border-radius:50%;background:var(--acc2);display:inline-block;margin-right:6px;box-shadow:0 0 8px var(--acc2)}
  main{flex:1; width:100%; max-width:920px; margin:0 auto; padding:8px 20px 30px}
  #list{display:grid; gap:12px; grid-template-columns:1fr; overflow-y:auto; max-height:calc(100vh - 240px); padding-right:2px}
  @media(min-width:720px){ #list{grid-template-columns:1fr 1fr} }
  .card{background:linear-gradient(180deg,var(--panel),var(--panel2)); border:1px solid var(--line); border-radius:14px; padding:14px 15px 13px; display:flex; flex-direction:column; gap:9px; transition:border-color .18s, transform .18s}
  .card:hover{border-color:var(--line2); transform:translateY(-1px)}
  .card.mine{border-color:rgba(126,224,176,.38)}
  .row1{display:flex; align-items:center; gap:10px}
  .code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:21px; letter-spacing:.22em; color:var(--code); font-weight:700}
  .badge{margin-left:auto; font-size:11.5px; padding:2.5px 9px; border-radius:99px; border:1px solid var(--line2); color:var(--mut)}
  .badge.open{color:var(--acc); border-color:rgba(126,224,176,.35); background:rgba(126,224,176,.07)}
  .badge.live{color:var(--warn); border-color:rgba(232,195,126,.35); background:rgba(232,195,126,.06)}
  .badge.full{color:var(--dim)}
  .badge.mine{color:var(--acc); border-color:rgba(126,224,176,.45); background:rgba(126,224,176,.12)}
  .row2{display:flex; flex-wrap:wrap; gap:6px; font-size:12.5px; color:var(--mut)}
  .tag{border:1px solid var(--line); border-radius:8px; padding:1.5px 8px; background:rgba(255,255,255,.015)}
  .tag.srv{color:var(--acc); border-color:rgba(126,224,176,.25)}
  .bar{height:5px; border-radius:99px; background:#18211d; overflow:hidden}
  .bar i{display:block; height:100%; background:linear-gradient(90deg,var(--acc2),var(--acc)); border-radius:99px}
  .row3{display:flex; align-items:center; gap:10px; font-size:12.5px; color:var(--mut)}
  .note{color:#9fb0a8; font-size:13px; border-left:2px solid var(--line2); padding-left:9px; white-space:pre-wrap; word-break:break-word}
  .row4{display:flex; align-items:center; gap:8px; margin-top:2px; flex-wrap:wrap}
  .ago{margin-right:auto; color:var(--dim); font-size:12px}
  .btn{appearance:none; border:1px solid transparent; border-radius:10px; padding:8px 18px; font-size:14px; font-weight:600; cursor:pointer; font-family:inherit}
  .btn.join{background:linear-gradient(180deg,var(--acc),var(--acc2)); color:#06251a}
  .btn.join:hover{filter:brightness(1.06)}
  .btn.watch{background:transparent; color:var(--warn); border-color:rgba(232,195,126,.45)}
  .btn.watch:hover{background:rgba(232,195,126,.08)}
  .btn.ghost{background:transparent; color:var(--acc); border-color:rgba(126,224,176,.4)}
  .btn.ghost:hover{background:rgba(126,224,176,.08)}
  .btn.small{padding:4px 11px; font-size:12.5px; border-radius:8px; font-weight:500}
  .btn.note-edit{background:transparent; color:var(--acc); border-color:rgba(126,224,176,.45)}
  .btn.danger{background:transparent; color:var(--danger); border-color:rgba(224,141,126,.45)}
  .btn.danger:hover{background:rgba(224,141,126,.08)}
  .btn[disabled]{background:#151c19; color:var(--dim); border-color:var(--line); cursor:default}
  .state{border:1px dashed var(--line2); border-radius:14px; padding:34px 18px; text-align:center; color:var(--mut)}
  .state b{display:block; color:var(--fg); margin-bottom:6px; font-size:15px}
  footer{max-width:920px; width:100%; margin:0 auto; padding:14px 20px 26px; color:var(--dim); font-size:12px; border-top:1px solid var(--line)}
  footer a{margin-right:14px}
  .spin{display:inline-block; width:12px; height:12px; border:2px solid var(--line2); border-top-color:var(--acc); border-radius:50%; animation:sp 1s linear infinite; vertical-align:-2px; margin-right:8px}
  @keyframes sp{to{transform:rotate(360deg)}}
  /* ---- 提交房间面板（默认折叠，一行按钮展开） ---- */
  .submit{background:linear-gradient(180deg,var(--panel),var(--panel2)); border:1px solid var(--line2); border-radius:14px; padding:13px 14px 12px; margin-bottom:12px}
  .sgrid{display:grid; gap:8px; grid-template-columns:1fr}
  @media(min-width:720px){ .sgrid{grid-template-columns:1fr 1fr} .sf--wide{grid-column:1 / -1} }
  .sf{display:flex; flex-direction:column; gap:4px; min-width:0}
  .slab{color:var(--dim); font-size:11.5px; letter-spacing:.06em}
  .sinput,.sselect{appearance:none; background:#0b100e; color:var(--fg); border:1px solid var(--line2); border-radius:10px; padding:8px 11px; font:inherit; font-size:14px; min-width:0; width:100%}
  .sinput::placeholder{color:#4b5a54}
  .sinput:focus,.sselect:focus{outline:none; border-color:rgba(126,224,176,.5)}
  .sact{display:flex; align-items:center; gap:10px; margin-top:10px; flex-wrap:wrap}
  .sstate{font-size:12.5px; color:var(--mut)}
  .sstate.ok{color:var(--acc)}
  .sstate.err{color:var(--danger)}
  .shint{color:var(--dim); font-size:12px; margin-top:8px; line-height:1.5}
  .noteedit{display:flex; gap:6px; align-items:center; margin-top:6px}
</style>
</head>
<body>
<header>
  <div class="kicker">Stronghold Protocol · Alliance</div>
  <h1>联机大厅</h1>
  <div class="sub">实时房间牌：最新的可加入房间自动置顶 —— 点「加入」直接进场，对局中的房间可「观战」。</div>
  <div class="meta">
    <span><span class="dot" id="live"></span><span id="status">连接中…</span></span>
    <span id="visitors"></span>
    <span id="countdown"></span>
    <button type="button" class="btn ghost small" id="open-submit" aria-expanded="false" aria-controls="submit">＋ 提交房间</button>
  </div>
</header>
<main>
  <section class="submit" id="submit" hidden>
    <div class="sgrid">
      <label class="sf"><span class="slab">房号</span>
        <input class="sinput" id="s-code" maxlength="4" inputmode="latin" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="ABCD" /></label>
      <label class="sf"><span class="slab">服务器</span>
        <input class="sinput" id="s-server" list="s-servers" maxlength="64" autocomplete="off" spellcheck="false" placeholder="站长服务" /></label>
      <label class="sf"><span class="slab">难度（选填）</span>
        <select class="sselect" id="s-diff">
          <option value="">不填</option>
          <option value="FUNNY">标准</option>
          <option value="NORMAL">险境</option>
          <option value="HARD">绝境</option>
          <option value="ABYSS">终极</option>
        </select></label>
      <label class="sf"><span class="slab">备注（选填）</span>
        <input class="sinput" id="s-note" maxlength="40" autocomplete="off" placeholder="≤40 字，所有人可见" /></label>
      <label class="sf sf--wide"><span class="slab">房间地址（选填）</span>
        <input class="sinput" id="s-url" maxlength="512" autocomplete="off" spellcheck="false" placeholder="https://…/  留空则「加入」跳官方网页入口" /></label>
    </div>
    <datalist id="s-servers"></datalist>
    <div class="sact">
      <button type="button" class="btn join" id="s-go">提交到大厅</button>
      <span class="sstate" id="s-state"></span>
    </div>
    <div class="shint">
      提交后 <b>10 分钟</b>内有效，期间可在自己的房间卡片上改备注 / 销毁。请确认房号真实可加入 ——
      服务器名从列表里选（打开着的房间会自动出现在候选里），填了房间地址「加入」按钮才会跳到那台服务器，
      留空则跳官方网页入口。
    </div>
  </section>
  <div id="list"><div class="state"><span class="spin"></span>正在拉取房间牌…</div></div>
</main>
<footer>
  <a href="https://dl.jiangjiangze.icu" target="_blank" rel="noopener">下载客户端</a>
  <a href="https://github.com/jingjiangze/Stronghold-Protocol" target="_blank" rel="noopener">开源仓库</a>
  <span>非官方同人作品 · 房间由各服务器玩家自行上报</span>
</footer>
<script>
(function () {
  'use strict';
  var POLL_MS = 20000;
  // 默认加入目标：官方网页入口（房间卡片未携带自己的 url、或提交时未填房间地址时使用）。
  var DEFAULT_CLIENT = 'https://weishu.jiangjiangze.icu/';
  // 本机凭据（提交房间返回的 token）：只在本源 localStorage 里，除了交回房间牌不作他用。
  var MINE_KEY = 'sp.lobby.mine';
  var NOTE_MAX = 40;
  var DIFF_ORDER = ['FUNNY', 'NORMAL', 'HARD', 'ABYSS'];
  // 保留字（与 board.js RESERVED_SERVER_IDS 同表）：这些 id 是客户端内部占位，公开上传会造出
  // 「全服可见但谁也进不去」的幽灵房，服务端会 400，这里先拦一道给出中文提示。
  var RESERVED_SERVERS = { 'sp-phone-host': 1, local: 1, auto: 1 };

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }

  // 只允许 https + 公网主机：拒环回/私网/保留地址（与服务端 board.js 的 deny 表逐条对齐；
  // 防恶意卡片把「加入」导向点击者的内网地址）。返回规范化 href（保留路径），不合法返回 ''。
  function safeHref(raw) {
    if (!raw) return '';
    var u; try { u = new URL(raw); } catch (e) { return ''; }
    if (u.protocol !== 'https:') return '';
    if (u.username || u.password) return '';
    var h = u.hostname.toLowerCase();
    if (h === 'localhost' || h === 'ip6-localhost' || h === 'ip6-loopback') return '';
    if (h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return '';
    if (h.indexOf(':') >= 0) return '';                                  // IPv6 一律不收
    var m = h.match(/^(\\d+)\\.(\\d+)\\.(\\d+)\\.(\\d+)$/);
    if (m) {
      var a = +m[1], b = +m[2], c = +m[3];
      if (a === 0 || a === 10 || a === 127) return '';
      if (a === 169 && b === 254) return '';
      if (a === 172 && b >= 16 && b <= 31) return '';
      if (a === 192 && b === 168) return '';
      if (a === 100 && b >= 64 && b <= 127) return '';
      if (a >= 224) return '';
      if (a === 192 && b === 0 && (c === 0 || c === 2)) return '';
      if (a === 192 && b === 88 && c === 99) return '';
      if (a === 198 && (b === 18 || b === 19)) return '';
      if (a === 198 && b === 51 && c === 100) return '';
      if (a === 203 && b === 0 && c === 113) return '';
    }
    return u.href;
  }

  function safeOrigin(raw) {
    var href = safeHref(raw);
    if (!href) return '';
    try { return new URL(href).origin + '/'; } catch (e) { return ''; }
  }

  // 与客户端面板同一张表（extras/public/js/lobby.js 的 MATCH_DIFFS）。
  var DIFF_NAMES = { FUNNY: '标准', NORMAL: '险境', HARD: '绝境', ABYSS: '终极' };

  // board 有意不外泄 createdAt（它只发 ageSec），社区源行两者都可能缺 —— 统一折算成「已存在秒数」。
  function ageSecOf(r, now) {
    var ts = Number(r.createdAt);
    if (Number.isFinite(ts) && ts > 0) return Math.max(0, (now - ts) / 1000);
    var age = Number(r.ageSec);
    if (Number.isFinite(age) && age >= 0) return age;
    return -1;
  }

  function ago(sec) {
    if (sec < 0) return '';
    if (sec < 90) return '刚刚';
    if (sec < 3600) return Math.floor(sec / 60) + ' 分钟前';
    if (sec < 86400) return Math.floor(sec / 3600) + ' 小时前';
    return Math.floor(sec / 86400) + ' 天前';
  }

  // 可加入 = 未对局且未满员；对局中 = 观战；满员 = 置灰（仍展示，便于换房时心里有数）。
  function stateOf(r) {
    if (r.inMatch === true || String(r.status) === 'playing') return 'live';
    var occ = Number(r.occupied) || 0, cap = Number(r.capacity) || 0;
    if (cap > 0 && occ >= cap) return 'full';
    return 'open';
  }

  function targetFor(r, spectate) {
    var base = safeOrigin(r.url) || DEFAULT_CLIENT;
    var u = new URL(base);
    u.searchParams.set('room', String(r.code || ''));
    if (spectate) u.searchParams.set('spectate', '1');
    return u.toString();
  }

  function sortRooms(rooms, now) {
    function rank(r) { var s = stateOf(r); return s === 'open' ? 0 : s === 'live' ? 1 : 2; }
    return rooms.slice(0).sort(function (a, b) {
      var ra = rank(a), rb = rank(b);
      if (ra !== rb) return ra - rb;                                         // 可加入 → 可观战 → 满员
      return ageSecOf(a, now) - ageSecOf(b, now);                            // 同组内最新在前（ageSec 小的在前）
    });
  }

  // ---- 我的房间（本机凭据） -------------------------------------------------------------
  // { <CODE>: { token, serverId, serverName, expiresAt } } —— 服务端 PATCH/DELETE 要求 token +
  // serverId 双匹配，所以两者都存；expiresAt 只用于本地清理（房间牌 TTL 600s）。
  function readMine() {
    var out = {};
    var raw;
    try { raw = localStorage.getItem(MINE_KEY); } catch (e) { return out; }
    if (!raw) return out;
    var obj;
    try { obj = JSON.parse(raw); } catch (e) { return out; }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return out;
    Object.keys(obj).forEach(function (code) {
      var e = obj[code];
      if (!e || typeof e !== 'object') return;
      if (typeof e.token !== 'string' || !e.token) return;
      if (typeof e.serverId !== 'string' || !e.serverId) return;           // 消费端要它做双匹配
      out[code] = {
        token: e.token,
        serverId: e.serverId,
        serverName: typeof e.serverName === 'string' ? e.serverName : '',
        expiresAt: Number(e.expiresAt) > 0 ? Number(e.expiresAt) : 0,
      };
    });
    return out;
  }

  function writeMine(map) {
    try { localStorage.setItem(MINE_KEY, JSON.stringify(map)); } catch (e) { /* 无痕模式：忽略 */ }
  }

  function dropMine(code) {
    var mine = readMine();
    if (!Object.prototype.hasOwnProperty.call(mine, code)) return;
    delete mine[code];
    writeMine(mine);
  }

  /** 过期凭据顺手清掉（返回仍然有效的表）。用本机时钟：expiresAt 就是提交时按本机时钟算出来的。 */
  function liveMine() {
    var t = Date.now();
    var mine = readMine(), changed = false;
    Object.keys(mine).forEach(function (code) {
      if (mine[code].expiresAt > 0 && mine[code].expiresAt <= t) { delete mine[code]; changed = true; }
    });
    if (changed) writeMine(mine);
    return mine;
  }

  // ---- 提交房间：表单 → 请求载荷（纯函数，便于直测） -------------------------------------

  /** 房号输入：大写 + 只留合法字母（A-HJ-NP-Z），最多 4 位。 */
  function normalizeCodeInput(raw) {
    return String(raw || '').toUpperCase().replace(/[^A-HJ-NP-Z]/g, '').slice(0, 4);
  }

  /**
   * 服务端错误码 → 中文提示（服务端 message 是英文调试文案，展示层不用它）。
   */
  function errorText(code, fallback, status) {
    switch (code) {
      case 'BAD_CODE': return '房号必须是 4 位字母（不含 I / O）';
      case 'BAD_SERVER': return '服务器名不可用（本机服务 / 自动 这类占位名不能提交）';
      case 'BAD_URL': return '房间地址不可用：需为 https 公网地址，可留空';
      case 'BAD_JSON': return '提交内容过大或格式有误';
      case 'DEBOUNCED': return '这个房号刚刚提交过，30 秒后再试';
      case 'RATE_LIMITED': return '提交太频繁了，请过一会儿再试';
      case 'LIMIT_REACHED': return '你名下未过期的房间已达上限（5 条），先销毁几条再提交';
      case 'FORBIDDEN': return '本机凭据已失效（房间被重新提交过），已清除';
      case 'NOT_FOUND': return '该房间已过期或不存在';
      default: return fallback || code || ('提交失败（HTTP ' + status + '）');
    }
  }

  /**
   * 表单值 → POST /api/rooms 载荷，字段校验与服务端同一套规则（本地先拦一道给中文提示）。
   * @returns {{ok:true, payload:object} | {ok:false, message:string}}
   */
  function buildPayload(values) {
    var v = values || {};
    var code = normalizeCodeInput(v.code);
    if (code.length !== 4) return { ok: false, message: '房号必须是 4 位字母（不含 I / O）' };

    var server = String(v.server || '').trim();
    if (!server) return { ok: false, message: '请填写房间所在的服务器名' };
    if (Array.from(server).length > 64) return { ok: false, message: '服务器名过长（≤64 字）' };
    var serverId = String(v.serverId || server).trim() || server;
    if (RESERVED_SERVERS[server.toLowerCase()] || RESERVED_SERVERS[serverId.toLowerCase()]) {
      return { ok: false, message: '本机服务 / 自动 不是公开服务器，无法提交' };
    }

    var payload = { code: code, serverId: serverId, serverName: server };

    var note = String(v.note || '').trim();
    if (note) payload.note = Array.from(note).slice(0, NOTE_MAX).join('');

    var diff = String(v.difficulty || '').trim().toUpperCase();
    if (DIFF_ORDER.indexOf(diff) >= 0) payload.difficulty = diff;

    var raw = String(v.url || '').trim();
    if (raw) {
      var href = safeHref(raw);
      // 服务端也接受 http，但网页「加入」只跳 https（safeOrigin 拒绝 http）—— 提交 http 会让
      // 别人点了回落到官方入口，所以这里直接拦掉并说明。
      if (!href) return { ok: false, message: '房间地址需为 https 公网地址（可留空）' };
      if (href.length > 512) return { ok: false, message: '房间地址过长（≤512 字）' };
      payload.url = href;
    }
    return { ok: true, payload: payload };
  }

  /** 同源 JSON 调用（房间牌的 POST / PATCH / DELETE 共用）；错误一律落到 {ok:false,text}。 */
  function boardCall(path, options) {
    var opts = options || {};
    return fetch(path, opts).then(function (res) {
      return res.json().then(function (j) { return { status: res.status, j: j }; },
        function () { return { status: res.status, j: null }; });
    }).catch(function () { return { status: 0, j: null }; });
  }

  /**
   * 提交（或 30 秒后重提）一局房间 → 201 { ok, added, token }；token 存本机凭据表。
   * @returns {Promise<{ok:boolean, text:string, code?:string}>}
   */
  function submitRoom(values) {
    var built = buildPayload(values);
    if (!built.ok) return Promise.resolve({ ok: false, text: built.message });
    var code = built.payload.code;
    return boardCall('/api/rooms', {
      method: 'POST', cache: 'no-store',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(built.payload),
    }).then(function (r) {
      var j = r.j || {};
      if (j.ok === true && typeof j.token === 'string' && j.token) {
        var leftSec = Number(j.added && j.added.leftSec);
        var mine = readMine();
        mine[code] = {
          token: j.token,
          serverId: built.payload.serverId,
          serverName: built.payload.serverName,
          expiresAt: Date.now() + (leftSec > 0 ? leftSec : 600) * 1000,
        };
        writeMine(mine);
        return { ok: true, text: '已提交，' + Math.round((leftSec > 0 ? leftSec : 600) / 60) + ' 分钟内有效', code: code };
      }
      return { ok: false, text: errorText(j.error, j.message, r.status) };
    });
  }

  /** 销毁自己提交的房间（DELETE，token + serverId 双匹配）。 */
  function destroyRoom(code) {
    var mine = readMine();
    var entry = mine[code];
    if (!entry) return Promise.resolve({ ok: false, text: '本机没有这条房间的凭据' });
    var q = '?code=' + encodeURIComponent(code) + '&serverId=' + encodeURIComponent(entry.serverId);
    return boardCall('/api/rooms' + q, {
      method: 'DELETE', cache: 'no-store', headers: { 'X-Token': entry.token },
    }).then(function (r) {
      var j = r.j || {};
      if (j.ok === true) { dropMine(code); return { ok: true, text: '已销毁' }; }
      // 已过期 / 被别人重提（凭据轮换）——两种都把本机凭据清掉，避免留着一条永远失败的记录。
      if (j.error === 'NOT_FOUND' || j.error === 'FORBIDDEN') {
        dropMine(code);
        return { ok: true, text: j.error === 'NOT_FOUND' ? '该房间已过期或不存在' : '房间已被重新提交，本机凭据已清除' };
      }
      return { ok: false, text: errorText(j.error, j.message, r.status) };
    });
  }

  /** 改自己房间的备注（PATCH，只动 note，不刷新 TTL）。 */
  function saveNote(code, note) {
    var mine = readMine();
    var entry = mine[code];
    if (!entry) return Promise.resolve({ ok: false, text: '本机没有这条房间的凭据' });
    return boardCall('/api/rooms', {
      method: 'PATCH', cache: 'no-store',
      headers: { 'content-type': 'application/json', 'X-Token': entry.token },
      body: JSON.stringify({ code: code, serverId: entry.serverId, note: String(note || '').trim().slice(0, NOTE_MAX) }),
    }).then(function (r) {
      var j = r.j || {};
      if (j.ok === true) return { ok: true, text: '备注已更新' };
      if (j.error === 'NOT_FOUND') { dropMine(code); return { ok: false, text: '该房间已过期或不存在' }; }
      if (j.error === 'FORBIDDEN') { dropMine(code); return { ok: false, text: '本机凭据已失效（房间被重新提交过），已清除' }; }
      return { ok: false, text: errorText(j.error, j.message, r.status) };
    });
  }

  // ---- 渲染 ---------------------------------------------------------------------------

  var noteEdit = null;     // 正在改备注的房号
  var actText = '';        // 房间行动作的就地提示（销毁 / 改备注）
  var known = [];          // 已知服务器（从房间牌推导：名称 → id / 主机）
  var urlAuto = '';        // 地址栏是否由「选服务器」自动填的（用户手改过就不再覆盖）
  var last = null;         // 最近一次房间牌数据（备注编辑器就地重绘用）

  function card(r, now, mine) {
    var st = stateOf(r);
    var mineEntry = mine[r.code] || null;
    var badge = st === 'open' ? '<span class="badge open">开放</span>'
              : st === 'live' ? '<span class="badge live">对局中</span>'
              : '<span class="badge full">满员</span>';
    if (mineEntry) badge = '<span class="badge mine">我的</span>' + badge;
    var occ = Number(r.occupied) || 0, cap = Number(r.capacity) || 0;
    var pct = cap > 0 ? Math.min(100, Math.round(occ / cap * 100)) : 0;
    var tags = '<span class="tag srv">' + esc(r.serverName || r.serverId || '未知服务器') + '</span>';
    if (r.difficulty || r.difficultyName) tags += '<span class="tag">' + esc(r.difficultyName || DIFF_NAMES[r.difficulty] || r.difficulty) + '</span>';
    if (r.mode) tags += '<span class="tag">' + esc(r.mode) + '</span>';
    // 人数行只在房主上报过容量时出现（未上报的旧条目显示 0/0 只会误导）。
    var seats = cap > 0
      ? '<div class="row3"><span>' + occ + '/' + cap + ' 人</span><span class="bar" style="flex:1"><i style="width:' + pct + '%"></i></span></div>'
      : '';
    var btn = st === 'open'
      ? '<button class="btn join" data-href="' + esc(targetFor(r, false)) + '">加入</button>'
      : st === 'live'
        ? '<button class="btn watch" data-href="' + esc(targetFor(r, true)) + '">观战</button>'
        : '<button class="btn" disabled>满员</button>';
    // 我的房间：剩余时间代替「X 分钟前」，并在行内给出改备注 / 销毁（与面板同一套动作）。
    var left = Number(r.leftSec);
    var ageLabel = mineEntry
      ? (Number.isFinite(left) && left > 0 ? '剩 ' + Math.max(1, Math.ceil(left / 60)) + ' 分钟' : '即将过期')
      : ago(ageSecOf(r, now));
    var mineBtns = mineEntry
      ? '<button class="btn small note-edit" data-act="note" data-code="' + esc(r.code) + '">改备注</button>'
        + '<button class="btn small danger" data-act="destroy" data-code="' + esc(r.code) + '">销毁</button>'
      : '';
    var editor = mineEntry && noteEdit === r.code
      ? '<div class="noteedit"><input class="sinput" id="s-note-' + esc(r.code) + '" maxlength="40" autocomplete="off" '
        + 'value="' + esc(r.note || '') + '" placeholder="备注（≤40 字，所有人可见）" />'
        + '<button class="btn small note-edit" data-act="note-save" data-code="' + esc(r.code) + '">保存</button>'
        + '<button class="btn small ghost" data-act="note-cancel" data-code="' + esc(r.code) + '">取消</button></div>'
      : '';
    return '<div class="card' + (mineEntry ? ' mine' : '') + '">'
      + '<div class="row1"><span class="code">' + esc(r.code || '????') + '</span>' + badge + '</div>'
      + '<div class="row2">' + tags + '</div>'
      + seats
      + (r.note ? '<div class="note">' + esc(r.note) + '</div>' : '')
      + '<div class="row4"><span class="ago">' + esc(ageLabel) + '</span>' + mineBtns + btn + '</div>'
      + editor
      + '</div>';
  }

  var list = document.getElementById('list');
  var statusEl = document.getElementById('status');
  var visitorsEl = document.getElementById('visitors');
  var cdEl = document.getElementById('countdown');
  var stateEl = document.getElementById('s-state');
  var panel = document.getElementById('submit');
  var panelBtn = document.getElementById('open-submit');
  var serversEl = document.getElementById('s-servers');
  var codeEl = document.getElementById('s-code');
  var serverEl = document.getElementById('s-server');
  var urlEl = document.getElementById('s-url');
  var noteEl = document.getElementById('s-note');
  var diffEl = document.getElementById('s-diff');
  var goEl = document.getElementById('s-go');
  var nextAt = 0;

  /** 从房间牌推导已知服务器（同一台服务器的房间共享主机）。 */
  function knownFrom(rooms) {
    var out = [], seen = {};
    (rooms || []).forEach(function (r) {
      var name = String(r.serverName || r.server || '').trim();
      var key = name.toLowerCase();
      if (!name || seen[key]) return;
      seen[key] = 1;
      out.push({ name: name, id: String(r.serverId || '').trim(), origin: safeOrigin(r.url) });
    });
    return out;
  }

  function knownFor(name) {
    var key = String(name || '').trim().toLowerCase();
    for (var i = 0; i < known.length; i++) if (known[i].name.toLowerCase() === key) return known[i];
    return null;
  }

  function render(data) {
    var now = Number(data && data.now) || Date.now();
    var rooms = sortRooms((data && data.rooms) || [], now);
    var mine = liveMine();
    statusEl.textContent = '已连接 · ' + rooms.length + ' 个房间';
    visitorsEl.textContent = (typeof data.visitors === 'number') ? '大厅访客 ' + data.visitors + ' 人' : '';
    known = knownFrom(rooms);
    if (serversEl) serversEl.innerHTML = known.map(function (s) { return '<option value="' + esc(s.name) + '"></option>'; }).join('');
    if (!rooms.length) {
      list.innerHTML = '<div class="state"><b>现在没有公开的房间</b>刚开好一局？点上方「＋ 提交房间」把房号发布到大厅；'
        + '或去下载客户端自己开服。<br/><br/><a href="https://dl.jiangjiangze.icu" target="_blank" rel="noopener">前往下载页 →</a></div>';
      return;
    }
    list.innerHTML = rooms.map(function (r) { return card(r, now, mine); }).join('')
      + (actText ? '<div class="shint">' + esc(actText) + '</div>' : '');
    Array.prototype.forEach.call(list.querySelectorAll('.btn[data-href]'), function (b) {
      b.addEventListener('click', function () { window.open(b.getAttribute('data-href'), '_blank', 'noopener'); });
    });
    Array.prototype.forEach.call(list.querySelectorAll('[data-act]'), function (b) {
      b.addEventListener('click', function () {
        var code = b.getAttribute('data-code') || '';
        var act = b.getAttribute('data-act');
        if (act === 'note') { noteEdit = code; actText = ''; if (last) render(last); return; }
        if (act === 'note-cancel') { noteEdit = null; actText = ''; if (last) render(last); return; }
        if (act === 'note-save') {
          var input = document.getElementById('s-note-' + code);
          var value = input ? input.value : '';
          actText = '保存中…';
          saveNote(code, value).then(function (r) {
            noteEdit = null; actText = r.text; load();
          });
          return;
        }
        if (act === 'destroy') {
          actText = '销毁中…';
          destroyRoom(code).then(function (r) { actText = r.text; load(); });
        }
      });
    });
  }

  function tick() {
    var left = Math.max(0, Math.ceil((nextAt - Date.now()) / 1000));
    cdEl.textContent = left > 0 ? left + 's 后刷新' : '';
  }

  function fail(err) {
    statusEl.textContent = '连接大厅失败';
    if (!list.querySelector('.card')) {
      list.innerHTML = '<div class="state"><b>暂时连不上大厅服务</b>' + esc(String((err && err.message) || err)) + '<br/><br/>将在 20 秒后自动重试。</div>';
    }
  }

  function load() {
    return fetch('/api/rooms', { headers: { 'accept': 'application/json' } })
      .then(function (res) { if (!res.ok) throw new Error('HTTP ' + res.status); return res.json(); })
      .then(function (data) { last = data; render(data); })
      .catch(fail)
      .then(function () { nextAt = Date.now() + POLL_MS; });
  }

  // ---- 提交房间面板（默认折叠；提交成功即刷新房间牌） -------------------------------------
  function setState(text, kind) {
    if (!stateEl) return;
    stateEl.textContent = text || '';
    stateEl.className = 'sstate' + (kind ? ' ' + kind : '');
  }

  function submitFromForm() {
    var values = {
      code: codeEl ? codeEl.value : '',
      server: serverEl ? serverEl.value : '',
      serverId: '',
      note: noteEl ? noteEl.value : '',
      difficulty: diffEl ? diffEl.value : '',
      url: urlEl ? urlEl.value : '',
    };
    var hit = knownFor(values.server);
    if (hit && hit.id) values.serverId = hit.id; // 选自动推导的服务器 → 用它的正式 id
    if (goEl) goEl.disabled = true;
    setState('提交中…', '');
    submitRoom(values).then(function (r) {
      if (goEl) goEl.disabled = false;
      setState(r.text, r.ok ? 'ok' : 'err');
      if (r.ok) {
        if (codeEl) codeEl.value = '';
        if (noteEl) noteEl.value = '';
        if (urlEl) urlEl.value = '';
        urlAuto = '';
        load();
      }
    });
  }

  if (panelBtn && panel) {
    panelBtn.addEventListener('click', function () {
      var open = panel.hidden;
      panel.hidden = !open;
      panelBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
      panelBtn.textContent = open ? '收起提交' : '＋ 提交房间';
      if (open) setState('', '');
    });
  }
  if (codeEl) {
    codeEl.addEventListener('input', function () { codeEl.value = normalizeCodeInput(codeEl.value); });
    codeEl.addEventListener('keydown', function (e) { if (e.key === 'Enter') submitFromForm(); });
  }
  if (serverEl) {
    var onServer = function () {
      var hit = knownFor(serverEl.value);
      if (hit && hit.origin && urlEl && (!urlEl.value || urlEl.value === urlAuto)) {
        urlEl.value = hit.origin;
        urlAuto = hit.origin;
      }
    };
    serverEl.addEventListener('input', onServer);
    serverEl.addEventListener('change', onServer);
  }
  if (urlEl) urlEl.addEventListener('input', function () { urlAuto = ''; });
  if (noteEl) noteEl.addEventListener('keydown', function (e) { if (e.key === 'Enter') submitFromForm(); });
  if (goEl) goEl.addEventListener('click', submitFromForm);

  load();
  setInterval(load, POLL_MS);
  setInterval(tick, 500);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) load(); });

  // 测试面：纯函数与三个房间牌动作（页面本身只用 DOM 事件驱动它们）。
  window.__SP_PAGE = {
    safeHref: safeHref, safeOrigin: safeOrigin, normalizeCodeInput: normalizeCodeInput,
    buildPayload: buildPayload, errorText: errorText, knownFrom: knownFrom,
    submitRoom: submitRoom, destroyRoom: destroyRoom, saveNote: saveNote,
    readMine: readMine, load: load,
  };
})();
</script>
</body>
</html>
`;
