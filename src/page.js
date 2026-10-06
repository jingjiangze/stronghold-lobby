// src/page.js — the lobby's public web page (served by this Worker at GET /).
//
// One self-contained document: no external assets, no third-party requests. The page polls the
// same-origin GET /api/rooms every 20 s and renders the newest rooms first; joinable rooms get a
// 加入 button, in-match rooms get a 观战 button. Outbound navigation is limited to https URLs on
// public hosts (the same scheme/deny-table spirit as the server's targetHostDenyReason), so a
// hostile card can never point the page at loopback/private space.

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
  .meta{display:flex; gap:14px; align-items:center; margin-top:10px; color:var(--mut); font-size:12.5px}
  .dot{width:7px;height:7px;border-radius:50%;background:var(--acc2);display:inline-block;margin-right:6px;box-shadow:0 0 8px var(--acc2)}
  main{flex:1; width:100%; max-width:920px; margin:0 auto; padding:8px 20px 30px}
  #list{display:grid; gap:12px; grid-template-columns:1fr; overflow-y:auto; max-height:calc(100vh - 240px); padding-right:2px}
  @media(min-width:720px){ #list{grid-template-columns:1fr 1fr} }
  .card{background:linear-gradient(180deg,var(--panel),var(--panel2)); border:1px solid var(--line); border-radius:14px; padding:14px 15px 13px; display:flex; flex-direction:column; gap:9px; transition:border-color .18s, transform .18s}
  .card:hover{border-color:var(--line2); transform:translateY(-1px)}
  .row1{display:flex; align-items:center; gap:10px}
  .code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:21px; letter-spacing:.22em; color:var(--code); font-weight:700}
  .badge{margin-left:auto; font-size:11.5px; padding:2.5px 9px; border-radius:99px; border:1px solid var(--line2); color:var(--mut)}
  .badge.open{color:var(--acc); border-color:rgba(126,224,176,.35); background:rgba(126,224,176,.07)}
  .badge.live{color:var(--warn); border-color:rgba(232,195,126,.35); background:rgba(232,195,126,.06)}
  .badge.full{color:var(--dim)}
  .row2{display:flex; flex-wrap:wrap; gap:6px; font-size:12.5px; color:var(--mut)}
  .tag{border:1px solid var(--line); border-radius:8px; padding:1.5px 8px; background:rgba(255,255,255,.015)}
  .tag.srv{color:var(--acc); border-color:rgba(126,224,176,.25)}
  .bar{height:5px; border-radius:99px; background:#18211d; overflow:hidden}
  .bar i{display:block; height:100%; background:linear-gradient(90deg,var(--acc2),var(--acc)); border-radius:99px}
  .row3{display:flex; align-items:center; gap:10px; font-size:12.5px; color:var(--mut)}
  .note{color:#9fb0a8; font-size:13px; border-left:2px solid var(--line2); padding-left:9px; white-space:pre-wrap; word-break:break-word}
  .row4{display:flex; align-items:center; gap:10px; margin-top:2px}
  .ago{margin-right:auto; color:var(--dim); font-size:12px}
  .btn{appearance:none; border:1px solid transparent; border-radius:10px; padding:8px 18px; font-size:14px; font-weight:600; cursor:pointer; font-family:inherit}
  .btn.join{background:linear-gradient(180deg,var(--acc),var(--acc2)); color:#06251a}
  .btn.join:hover{filter:brightness(1.06)}
  .btn.watch{background:transparent; color:var(--warn); border-color:rgba(232,195,126,.45)}
  .btn.watch:hover{background:rgba(232,195,126,.08)}
  .btn[disabled]{background:#151c19; color:var(--dim); border-color:var(--line); cursor:default}
  .state{border:1px dashed var(--line2); border-radius:14px; padding:34px 18px; text-align:center; color:var(--mut)}
  .state b{display:block; color:var(--fg); margin-bottom:6px; font-size:15px}
  footer{max-width:920px; width:100%; margin:0 auto; padding:14px 20px 26px; color:var(--dim); font-size:12px; border-top:1px solid var(--line)}
  footer a{margin-right:14px}
  .spin{display:inline-block; width:12px; height:12px; border:2px solid var(--line2); border-top-color:var(--acc); border-radius:50%; animation:sp 1s linear infinite; vertical-align:-2px; margin-right:8px}
  @keyframes sp{to{transform:rotate(360deg)}}
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
  </div>
</header>
<main>
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
  // 默认加入目标：官方网页入口（房间卡片未携带自己的 url 时使用）。
  var DEFAULT_CLIENT = 'https://weishu.jiangjiangze.icu/';

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }

  // 只允许 https + 公网主机：拒环回/私网/保留地址（与服务端 board.js 的 deny 表逐条对齐；
  // 防恶意卡片把「加入」导向点击者的内网地址）。
  function safeOrigin(raw) {
    if (!raw) return '';
    var u; try { u = new URL(raw); } catch (e) { return ''; }
    if (u.protocol !== 'https:') return '';
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
    return u.origin + '/';
  }

  // 与客户端面板同一张表（extras/public/js/lobby.js 的 MATCH_DIFFS）。
  var DIFF_NAMES = { FUNNY: '标准', NORMAL: '险境', HARD: '绝境', ABYSS: '终极' };
  function ago(ts) {
    if (!ts) return '';
    var s = Math.max(0, (Date.now() - ts) / 1000);
    if (s < 90) return '刚刚';
    if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
    if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
    return Math.floor(s / 86400) + ' 天前';
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

  function sortRooms(rooms) {
    function rank(r) { var s = stateOf(r); return s === 'open' ? 0 : s === 'live' ? 1 : 2; }
    return rooms.slice(0).sort(function (a, b) {
      var ra = rank(a), rb = rank(b);
      if (ra !== rb) return ra - rb;                                    // 可加入 → 可观战 → 满员
      return (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0);   // 同组内最新在前
    });
  }

  function card(r) {
    var st = stateOf(r);
    var badge = st === 'open' ? '<span class="badge open">开放</span>'
              : st === 'live' ? '<span class="badge live">对局中</span>'
              : '<span class="badge full">满员</span>';
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
    return '<div class="card">'
      + '<div class="row1"><span class="code">' + esc(r.code || '????') + '</span>' + badge + '</div>'
      + '<div class="row2">' + tags + '</div>'
      + seats
      + (r.note ? '<div class="note">' + esc(r.note) + '</div>' : '')
      + '<div class="row4"><span class="ago">' + esc(ago(Number(r.createdAt))) + '</span>' + btn + '</div>'
      + '</div>';
  }

  var list = document.getElementById('list');
  var statusEl = document.getElementById('status');
  var visitorsEl = document.getElementById('visitors');
  var cdEl = document.getElementById('countdown');
  var nextAt = 0;

  function render(data) {
    var rooms = sortRooms((data && data.rooms) || []);
    statusEl.textContent = '已连接 · ' + rooms.length + ' 个房间';
    visitorsEl.textContent = (typeof data.visitors === 'number') ? '大厅访客 ' + data.visitors + ' 人' : '';
    if (!rooms.length) {
      list.innerHTML = '<div class="state"><b>现在没有公开的房间</b>开一局，把房号分享给朋友；或去下载客户端自己开服。<br/><br/><a href="https://dl.jiangjiangze.icu" target="_blank" rel="noopener">前往下载页 →</a></div>';
      return;
    }
    list.innerHTML = rooms.map(card).join('');
    Array.prototype.forEach.call(list.querySelectorAll('.btn[data-href]'), function (b) {
      b.addEventListener('click', function () { window.open(b.getAttribute('data-href'), '_blank', 'noopener'); });
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
    fetch('/api/rooms', { headers: { 'accept': 'application/json' } })
      .then(function (res) { if (!res.ok) throw new Error('HTTP ' + res.status); return res.json(); })
      .then(render)
      .catch(fail)
      .then(function () { nextAt = Date.now() + POLL_MS; });
  }

  load();
  setInterval(load, POLL_MS);
  setInterval(tick, 500);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) load(); });
})();
</script>
</body>
</html>
`;
