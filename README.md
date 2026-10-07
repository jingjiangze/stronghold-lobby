# stronghold-lobby

> **本仓 = 联机大厅系统的唯一真源**（2026-10-06 从主仓
> [`jingjiangze/Stronghold-Protocol`](https://github.com/jingjiangze/Stronghold-Protocol) 的
> `tools/apk/lobby-worker/` 抽离，基线 apk@`83ae5d77`；完整历史仍在主仓 git history 里）。
> 主仓不再保留此目录的源码（仅留指路 README）。
>
> **部署**：push master 或手动 dispatch `deploy` workflow（自动跑测试 → `wrangler deploy` →
> 线上 `/api/health` 验收）。需要两个仓库 secret：`CLOUDFLARE_API_TOKEN`（Edit Cloudflare
> Workers 模板）、`CLOUDFLARE_ACCOUNT_ID`；未配置时 workflow 自动跳過部署。本地手工部署：
> `npm run deploy`（需环境变量同两名）。
>
> **线上身份（勿改）**：Worker 名 `sp-lobby-board`、自定义域 `sp-lobby.jiangjiangze.icu`、
> workers.dev 兜底、DO 迁移 v1(Board)+v2(MatchQueue) —— 原地更新，DO 数据与路由不受影响。
>
> 下文中的 `tools/apk/lobby-worker/` 为历史路径，现等价于本仓根目录。

---

# sp-lobby-board — 联机大厅「房间牌」后端 + 跨服匹配队列

单例 Cloudflare Worker + **两个独立 Durable Object**（`idFromName('board')` 房间牌 / `idFromName('match')` 匹配队列，存储互不相通），为大厅页提供房间牌与跨服同盟匹配：

- 房间牌契约**照抄 rainya**（`https://game.rainya.me/api/rooms`）：`{ ok, now, ttlSec: 600, rooms: [...] }`，CORS `*`；
- 字段只做**加法扩展**（`serverId` / `serverName`），客户端 `lobby.js` 的 rainya 兼容解析不变；
- 匹配队列：同难度凑 4 人成队 → **队内公开服成员当房主**（公开服优先）→ 房主把建好的房间挂回队列 → 客人读走 `{code, serverId}` 自动进场；不要求同 app 版本（2026-10-05 决策）；
- **出站只有一处**：房间牌/队列路由零出站（`src/board.js`、`src/match.js` 的校验都是纯语法校验，绝不回连用户提交的地址——测试给 `globalThis.fetch` 打桩，board 用例跑完计数必须为 0）；`GET /api/community` 是**唯一的社区源中转**，上游是代码内冻结的三个 https 常量（rainya 门户 / Lunar / 梨子湖），客户端只提交 `src` 白名单键、永远提交不了 URL，且发请求前仍按 deny 表校验 scheme+host（见 `relayCommunity()`）。

```
tools/apk/lobby-worker/
├── src/board.js            # 房间牌纯核心：校验 / 限流 / TTL / token（零依赖，node --test 直测）
├── src/match.js            # 跨服匹配队列纯核心：入队 / 成队 / 房号交接 / 取消（同风格零依赖）
├── src/index.js            # Worker 路由 + 两个 DO 类 Board / MatchQueue（薄适配层 + 粗粒度 alarm）
├── src/page.js             # 前台网页（GET / 的整页 HTML/CSS/JS：四源聚合房间牌 + 加入/观战 + 提交房间，单文件零外链）
├── tools/embed-fonts.mjs   # 把 Bender / Novecento Wide 以 base64 内嵌进 src/page.js（改字体时才跑）
├── wrangler.toml           # name / DO 绑定 ×2 / migrations v1+v2（部署命令见文件注释）
├── lobby-board.test.mjs    # node --test（内存适配器直测核心 + 适配层往返 + GET / 静态页）
├── lobby-relay.test.mjs    # node --test（社区源中转：白名单/映射/超时/缓存头，脚本化上游）
├── match-queue.test.mjs    # node --test（队列：成队/房主选举/房号交接/取消/TTL/限流/上限）
├── page.test.mjs           # node --test（前台网页内联脚本：四源合并/来源标签 + 渲染/排序/转义 + 提交房间表单与三个房间牌动作）
└── README.md               # 本文件
```

## HTTP 契约

所有响应带 `access-control-allow-origin: *`、`access-control-allow-methods: GET,POST,PATCH,DELETE,OPTIONS`、`access-control-allow-headers: Content-Type,X-Token,X-Device`、`cache-control: no-store`。

| 方法 | 路径 | 请求 | 成功 | 说明 |
| --- | --- | --- | --- | --- |
| GET | `/` `/index.html` | — | `200 text/html` | **前台网页**（见下节）；`cache-control: public, max-age=60`；非 GET/HEAD → 405；纯静态，不碰 DO |
| GET | `/api/rooms` | 可选头 `X-Device`（设备号） | `200 {ok,now,ttlSec,visitors,rooms[]}` | `now` 为 epoch 毫秒；只含未过期条目，最新在前。**v5.2**：同一次请求顺带记一个大厅访客（`X-Device` 优先、IP 兜底），`visitors` = 120s 窗口内去重访客数——零额外请求。**v5.6**：访客心跳写节流（`VISIT_WRITE_MIN_MS` 60s，同 key 60s 内只落一行；DO 行写免费额度 10 万/天） |
| POST | `/api/rooms` | JSON `{code, serverId, serverName, note?, url?, difficulty?, mode?, status?, occupied?, capacity?}` | `201 {ok:true, added, token}` | `token` = 128bit hex（32 字符），请客户端保存；**v5.2 直播字段**白名单化（非法值忽略，绝不因此拒绝提交） |
| PATCH | `/api/rooms` | JSON `{code, serverId, note, mode?, status?, occupied?, capacity?}`，头 `X-Token: <token>` | `200 {ok:true, updated:{code,serverId,note,+直播字段}}` | 仅 token+serverId **完全匹配**才可编辑；**`note` 键缺席 = 不动**（2026-10-07 修订；带键则照旧，`''`/`null` = 清空——旧客户端永远带键，行为零变化，新客户端拿不到自己那一行时省略 note 即可保住别人写的备注）；**v5.2** 起可同时刷新直播字段（只覆盖本次带上者），`createdAt`/`url`/`token` 不动，**不刷新 TTL**、不新增限流桶 |
| DELETE | `/api/rooms?code=&serverId=` | 头 `X-Token: <token>` | `200 {ok:true, removed:{code,serverId}}` | 仅凭 token+serverId 匹配才可销毁 |
| GET | `/api/community?src=rainya\|lunar\|rinko`（**v6：逗号列表 1..3 个**，如 `?src=rainya,lunar,rinko`） | — | `200 {ok,src,fetchedAt,rooms[]}`；合并形态逐行带 `src`，某源失败进 `errors:{key:'UPSTREAM'}`、只有全失败才 502 | **社区源中转**（三家上游都不发 CORS 头）。`src` 只认这三个白名单值、不接受任何多余参数；逗号列表必须**规范拼写**（白名单顺序、无重复、无空条目、无空白，≤3 个）——同一组源只有一种 URL，缓存键唯一；完整成功的 200 带 `public, max-age=10, s-maxage=60`（部分失败退回 10），错误一律 `no-store`（防 CF 负缓存） |
| GET | `/api/match?id=<handle>` | 可选头 `X-Token` | `200 {ok,state:'waiting',waiting,need,queuedSec}` 或 `{ok,state:'matched',role,matchId,room}` 或 `{ok,state:'expired'}` | 队列/对局状态轮询；`token` 不匹配 → 403 |
| POST | `/api/match` | JSON `{difficulty, venue:{kind:'public'\|'local'\|'custom', serverId?}, app?}` | `201 {ok,state,token,id,…}` | 入队；同难度第 4 人立即 `state:'matched'`（响应同时带 `token` 与同一 `id`，客户端只存这一对句柄） |
| POST | `/api/match/room` | JSON `{id, code, serverId, url?}`，头 `X-Token` | `200 {ok,room}` | **仅房主可发**；`url` 走与房间牌同一张公网 deny 表 |
| DELETE | `/api/match?id=<handle>` | 头 `X-Token` | `200 {ok,removed:'queue'\|'member'\|'match'}` | 退出队列 / 离开对局（房主离开则席位顺延；最后一人离开记录销毁） |
| OPTIONS | `*` | — | `204` | CORS 预检 |
| GET | `/api/health` | — | `200 {ok:true, now}` | 无状态上线自检 |

## 前台网页（`GET /`）

`https://sp-lobby.jiangjiangze.icu/` 直接打开的公开页面（`src/page.js`：单文件 HTML/CSS/JS、零外链、自带 CSP）：**最新的可加入房间排在最前，点一下就进场**；自己开了房也能在页面上直接**提交房间**。

- 外观与下载站（`dl.jiangjiangze.icu`）同一套视觉语言：同一色板 / Novecento Wide + Bender（`tools/embed-fonts.mjs` 以 base64 内嵌，零外链）、标题屏的辉光-雷达-山脊背景与四角状态栏、方角面板与悬停四角括号的按钮；窄屏/竖屏单独抬根字号。
- **数据来源 = 四源聚合，逐行标注来源**：本站房间牌（同源 `GET /api/rooms`，**60 s** 轮询）+ 三个社区站（**一次合并调用** `GET /api/community?src=rainya,lunar,rinko`，**300 s** 拉一次）—— **与 APK 面板同一档**（BOARD_REFRESH_MS/COMMUNITY_REFRESH_MS），这也是免费额度的纪律：一个**可见**标签页 **72 请求/小时**（60 房间牌 + 12 合并中转），后台标签页 0（两个定时器都不发请求，`visibilitychange` 回前台立刻全量刷新），服务端另有 60s 访客心跳写节流。`page.test.mjs` 有闸门锁住两个节奏下限（不许偷偷调快）。**Workers Cache**（wrangler.toml 的 `[cache] enabled`）让本页 HTML（`max-age=60`）与合并中转（`s-maxage=60`）命中边缘缓存时**不触发 Worker** —— 并发访客共享同一次调用；`/api/rooms` 是 `no-store`，永远 `BYPASS`（房间牌与访客计数都必须实时进 DO）。每间房的行上带「来源」标签：本站写「本站」，社区行直接写网站域名并链接到对应站点（`game.rainya.me` / `stronghold.lunar.ag` / `卫.rinko.ai`）；页脚另有「数据来源」标注写全四家（网站域名），某个源拉不通就地标「暂不可达」，绝不影响其它源。
- 合并 / 去重规则与 APK 面板一致：本站优先，其次 rainya → lunar → rinko；去重键 = 主机（或 serverId / 服务器名）+ 房号（不同站的同号房间是两间房）。
- 排序：**可加入（开放）永远在最前**，组内最新在前、无时间戳的常驻行排其后；`status=playing` 的行给「观战」按钮（目标带 `?spectate=1`），满员行置灰仍展示；
- 「加入」目标 = 房间行自己的 `url`（https + 公网主机校验，与服务端 `board.js` deny 表逐条对齐；不合法回落官方网页入口 `https://weishu.jiangjiangze.icu/`），拼 `?room=CODE`——与客户端深链同一约定；
- 难度中文名 `标准/险境/绝境/终极`（与 APK 面板 `MATCH_DIFFS` 同表）；服务器名原样展示（不隐藏）；
- **提交房间**（默认折叠，页头「＋ 提交房间」展开）：**房间链接必填（要带邀请码）、其余全选填** → 同源 `POST /api/rooms`；
  - **审核**：服务器名 / 服务器 id / 备注入库前过一道违规词表（同形字、全角、`f.u.c.k` 分隔符、`f4ck` leet、组合记号都能拦；`class`/`assassin` 这类正常词不误伤）；命中整条拒绝并回 `BLOCKED_TEXT`，页面提示「内容含违规词，换一个吧」。审核是过滤器不是保证，词表见 `src/names-words.js`（扩充只改这个文件）。
  - **链接是唯一必填项**：形如 `https://服务器/?room=ABCD`（生态里 weishu / rainya / lunar 的房间链接都是这个形状）；
  - **房号从链接里读**（`codeFromLink`：只认 `?room=` 参数、必须本身就是干净的 4 位 `[A-HJ-NP-Z]`，不猜不截断），输入时实时回显在「房号（从链接识别）」框里；把房号本身粘进链接框会明确提示「这是房号、不是链接」；
  - 链接必须 https + 公网主机（与「加入」同一张 deny 表；只做静态校验、**不发任何请求**），长度 ≤512；
  - 服务器名选填：留空时**按链接主机在大厅房间里找同一台服务器**（命中就用它的 `serverId` + 展示名），再不行用主机名兜底——服务端 `serverId/serverName` 是必填，所以载荷里永远非空；
  - 难度（白名单）/ 备注（≤40 字）选填；
  - 提交成功后 token 只存本源 `localStorage['sp.lobby.mine']`（`code → {token, serverId, serverName, expiresAt}`）；此后这间房的行带「我的」徽标、剩余时间，以及「改备注」（PATCH）与「销毁」（DELETE）按钮——APK 面板同一套房间牌动作，页面侧**零服务端改动**（三条路由与 CORS 早已就绪）；
  - 服务端约束照旧生效：同 IP ≤5 条未过期、10 次/60 s、同房号 30 s 防抖、TTL 600 s、保留字（`sp-phone-host`/`local`/`auto`）与私网地址拒绝；错误码在页面本地翻译成中文提示（`DEBOUNCED` → 「30 秒后再试」等）；
  - token 是唯一凭据（服务端 PATCH/DELETE 要求 token + serverId 双匹配）；显示层从不把它发给第三方，只交回房间牌。
- 页面只请求同源端点（`/api/rooms` 的 GET/POST/PATCH/DELETE 与 `/api/community`），不加载任何**外部资源**；CSP `default-src 'none'` + `connect-src 'self' https:`（字体/图标为内嵌 `data:` URI，故另开 `font-src data:` / `img-src data:`）。
  `https:` 这一项只服务于「服务器级兜底数字」：行上缺房间人数时直连那个服的 `/healthz` 读一次公开只读聚合数字（按 origin 60s 缓存、失败指数退避且静默、绝不显示 0、文案标「服务器级」；origin 先过 `safeHref` 的同一张拒绝表，非 https / 私网 / 保留地址一律不探）。

房间条目（`rooms[i]` / `added`）：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `code` | string | 大写 `^[A-HJ-NP-Z]{4}$`（归一后强校验，无 I/O） |
| `server` | string | rainya 兼容别名 = `serverName` |
| `serverId` | string | 提交方服务器 id（加法扩展，≤64 字） |
| `serverName` | string | 服务器展示名（≤64 字） |
| `note` | string | 备注，剔除控制字符、trim、截断 ≤40 个码点（emoji 安全）；房间牌条目里可用 PATCH 编辑 |
| `mode` | string? | **v5.2** `coop` \| `solo` —— 房主自报，展示与筛选用（非法忽略） |
| `status` | string? | **v5.2** `waiting` \| `full` \| `playing` \| `closed` |
| `occupied` / `capacity` | number? | **v5.2** 席位 0..8 / 1..8（整数，越界忽略） |
| `difficulty` | string? | **可选加法字段**（rainya 兼容）：仅 `FUNNY\|NORMAL\|HARD\|ABYSS`（trim + 大写归一）原样输出；非法值**静默忽略**（不报错、不输出该键）；仅供参考展示/筛选，不影响可见性、限流与防抖 |
| `ageSec` / `leftSec` | number | 已存在秒数 / 剩余秒数（TTL 600s） |
| `url` | string? | **仅当提交时通过校验才带**；规范化为 `URL.href`，不合法则**拒绝整个提交** |

错误响应统一 `{ok:false, error, message?}`。错误码 → 状态码：

| error | HTTP | 触发 |
| --- | --- | --- |
| `BAD_JSON` | 400 | body 非 JSON 对象或超 8KB |
| `BAD_CODE` | 400 | code 缺失/不符合 `^[A-HJ-NP-Z]{4}$` |
| `BAD_SERVER` | 400 | serverId / serverName 缺失、纯控制字符、超长，或命中保留字（`sp-phone-host` / `local` / `auto`，trim + 大小写不敏感） |
| `BAD_URL` | 400 | url 非字符串 / 非 http(s) / 带 userinfo / >512 字符 / host 命中拒绝表（队列的房号 url 同表） |
| `BLOCKED_TEXT` | 400 | **v7.1 审核**：serverId / serverName / note 命中违规词表（策略 `src/names.js`，词表 `src/names-words.js`）——提交与改备注两条路同判 |
| `BAD_DIFFICULTY` | 400 | 队列 difficulty 不在 `FUNNY/NORMAL/HARD/ABYSS` |
| `BAD_VENUE` | 400 | 队列 `venue.kind` 非法，或 public 场地缺 `serverId` |
| `BAD_ID` | 400 | 队列句柄 `id`（或 token）缺失 |
| `FORBIDDEN` | 403 | token 或 serverId 与条目不匹配（PATCH 编辑 / DELETE 同一判据；队列侧：token 与句柄不匹配 / 非房主发房号） |
| `NOT_FOUND` | 404 | code 不存在或已过期；队列句柄不存在（客户端按 `state:'expired'` 处理更常见） |
| `METHOD_NOT_ALLOWED` | 405 | 非 GET/POST/PATCH/DELETE |
| `RATE_LIMITED` | 429 | 同 IP 60s 滑动窗口内已成功提交 10 次 |
| `DEBOUNCED` | 429 | 同 code 距上次成功提交 <30s |
| `LIMIT_REACHED` | 429 | 同 IP 未过期条目已达 5 条 |
| `INTERNAL` | 500 | 未预期异常 |

## 限流与校验参数

| 参数 | 值 | 位置 |
| --- | --- | --- |
| TTL | 600s（过期条目 list 不出现且被清理） | `src/board.js` `TTL_SEC` |
| 同 IP 提交频率 | 10 次 / 60s（滑动窗口，只计成功提交） | `IP_RATE_MAX` / `IP_RATE_WINDOW_MS` |
| 同 code 防抖 | 30s（30s 后重提会**替换**旧条目并轮换 token） | `CODE_DEBOUNCE_MS` |
| 同 IP 未过期条目 | ≤5 | `IP_ROOMS_MAX` |
| code | 大写后 `^[A-HJ-NP-Z]{4}$` | `CODE_RE` |
| note | 控制字符剔除、trim、≤40 码点 | `NOTE_MAX` |
| serverId / serverName | 必填、控制字符剔除、≤64 码点 | `SERVER_ID_MAX` / `SERVER_NAME_MAX` |
| serverId / serverName 保留字 | `sp-phone-host` / `local` / `auto`（trim + 大小写不敏感精确匹配）→ `BAD_SERVER`（防「全服可见但无人能进」的幽灵房） | `RESERVED_SERVER_IDS` |
| url | 可选；http/https、≤512 字符、无 userinfo、port≠0、host 必须为公网地址 | `URL_MAX` |
| difficulty | 可选；`FUNNY` / `NORMAL` / `HARD` / `ABYSS`（trim + 大写归一），其余静默忽略 | `DIFFICULTIES` |

编辑备注（`PATCH /api/rooms`）**不新增限流桶**：token+serverId 双匹配本身就是所有权证明，与 DELETE 同判据；失败的编辑尝试不落盘、不计数。

url 的 host 拒绝表与 `tools/apk/overlay/sp-connect.mjs`（shell 出站守卫）**同一张表**（在该文件内逐条复制，避免 Worker 打包引入 `node:*` 依赖）：环回 / 私有 / link-local / CGNAT / 保留 / 组播 / 文档地址 / `localhost` / `*.localhost` / `*.local` / `*.internal` / IPv6 ULA、link-local、`::ffff:` 映射与 NAT64 等。WHATWG URL 解析在前，八进制（`0177.0.0.1`）、十六进制（`0x7f000001`）、短写（`127.1`）、十进制整数（`2130706433`）都已规范化为点分四段后再查表。

## 存储

- 仅用 **Durable Object storage**（`state.storage.get/put/delete/list`），不用 Workers KV；单例经 `idFromName('board')`。DO 输入门自带串行化，读-改-写无需额外锁。
- 键：`room:<CODE>`（条目，含 `token`/`ip`/`createdAt`，对外输出永不带出）与 `rate:<ip>`（近期成功提交时间戳），过期/陈旧键在读取路径顺手清理。
- PATCH 编辑备注只替换 `note` 字段（**键缺席则连 `note` 都不动**），`createdAt`（以及 `url`/`token`/`ip`/`difficulty`）保持不动，故**不刷新 TTL**：剩余时间仍从首次提交算起。
- 规模上限：单 IP ≤5 条、TTL 600s，DO storage 体量很小。

### 跨服匹配队列（`idFromName('match')` 独立 DO）

- 键：`q:<id>`（等待条目）、`m:<matchId>`（成队）、`i:<memberId>→matchId`（句柄索引）、`ops:<ip>`（POST/DELETE 滑动窗口）。
- TTL：等待条目 90s；成队未开房 180s 后解散；房号挂上后记录保留 600s（客人进场窗口）。DO alarm（每次变更后 30s 重臂）与每个请求的惰性 sweep 双保险，放弃的队列不会滞留。
- 房主：队内**最早的 public 场地成员**，否则最早入队者；房主离开（未开房）时席位顺延给下一位，最后一人离开才销毁记录。
- 上限：队列 ≤60 条；POST/DELETE ≤30 次/60s/IP（GET 轮询不限流——客户端 2.5s 轮询是设计内的）。

## 测试与自检

```bash
node --check src/board.js
node --check src/index.js
node --check src/page.js
node --test        # 全仓（board / relay / match / page）
```

测试用内存适配器直测核心，并断言**全局 fetch 调用数为 0**（房间牌路由零出站；社区源中转走 lobby-relay.test.mjs 单独验证，仅允许三个常量上游）。覆盖：契约形状与 rainya 兼容字段、TTL/leftSec/过期清理、限流三条（IP 频次 / code 防抖 / IP 条目上限）、token 销毁（成功 / 错误 token / 不存在）、note 清洗与长度、备注编辑 PATCH（成功改备注 / 错误 token / 错误 serverId / 不存在或过期 / 不刷新 TTL / 其它字段不动）、保留字拦截（`sp-phone-host` / `local` / `auto`，含大小写与 trim 变体；相似 id 回归）、difficulty 白名单（`hard` → `HARD`；非法值静默忽略且提交成功）、url 校验（含 `127.0.0.1`、`10.0.0.1`、`[::1]`、`0x7f000001`、userinfo、超长 → 拒绝且不落盘）、适配层 CORS/状态码/DO 往返（含 PATCH 走 X-Token、PUT 405）。

前台网页（`page.test.mjs`）把内联脚本放进 `node:vm` + DOM 桩里实跑，断言**四源聚合**（`/api/rooms` + **一条合并的** `/api/community?src=rainya,lunar,rinko`；200 响应里的 `errors` 只把失败的那个源标灰、不挡别的源；归属不明（缺 `src`）的行直接丢弃；同主机同房号去重且本站优先）与渲染（排序 / 来源标签 / 按钮 / 转义 / 恶意 URL 回落 / 断网态 / 空态引导），以及**提交房间**全链：房号归一、载荷校验（保留字 / 长度 / 私网地址 / 难度白名单 / 备注截断）、错误码→中文、`POST /api/rooms` 的请求形状与 token 落盘、刷新后行上带「我的」/改备注/销毁、`DELETE` 带 `X-Token`（含 `NOT_FOUND` 清凭据 / 过期凭据被剪枝）、`PATCH` 只动 note、已知服务器从房间牌推导。

## 第三方组件

- **LDNOOBW**（List of Dirty, Naughty, Obscene, and Otherwise Bad Words）—— `src/names-words.js` 的英文词表，许可 [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/)（中文词表为本仓自建）。

## 部署

```bash
cd tools/apk/lobby-worker
export CLOUDFLARE_API_TOKEN=...     # 凭据只从环境变量读取，禁止写入仓库
export CLOUDFLARE_ACCOUNT_ID=...    # 或先 npx wrangler login
npx wrangler deploy
```

首次部署得到 `https://sp-lobby-board.<subdomain>.workers.dev`（workers_dev 默认开启）。上线自检：

```bash
curl -s https://sp-lobby-board.<subdomain>.workers.dev/api/health   # => {"ok":true,"now":...}
```

自定义域可后配（`wrangler.toml` 注释里有 `[routes]` / `custom_domain` 建议）。DO migration 用 `new_sqlite_classes = ["Board"]`（SQLite 后端，免费版可用）；若账号/版本不支持则改 `new_classes`（KV 后端，付费版），代码不变。

## 客户端接入点

- 大厅页 `tools/apk/extras/public/js/lobby.js` 顶部常量 `var BOARD = '';` —— 部署后填入 `'https://sp-lobby-board.<subdomain>.workers.dev'`（不带尾斜杠）。
- `BOARD` 非空时其 host 自动加入该页 `ALLOWED_HOSTS`，页面以 `GET <BOARD>/api/rooms` 每 15s 拉取（仅面板打开且页面可见时），解析逻辑与 rainya 源共用（`{ok,now,ttlSec,rooms}` / 条目 `{code,server,note,ageSec,leftSec,url}`）。
- 注意客户端 `sanitizeRoom` 只把 **https** 且非私有 host 的 url 渲染为可加入链接；http 房间会展示但无跳转（服务端仍接受 http 提交，见上表）。
- 提交/销毁/改备注 UI 尚未上线（页面第 4 区当前禁用）；将来用 POST + PATCH + DELETE（`X-Token`）即可，无需再改本服务。

## 假设与不确定点

- **DO 存储 API**：按 `state.storage.get/put/delete/list`（KV 风格，`list()` 返回 `Map<key, value>`，值为结构化克隆）实现；SQLite 后端的 DO 提供同一套 API。若目标运行时对 `list()` 有分页上限（默认整套返回），当前规模（单 IP ≤5、TTL 600s）不会触顶。
- `now` 使用 DO 所在机器的 `Date.now()`；未做客户端时钟校验，`ageSec`/`leftSec` 以服务端为准（rainya 同样如此）。
- 同 IP 计数以 `CF-Connecting-IP` 头为准（Worker 注入，客户端不可伪造）；头缺失时归入 `unknown` 桶。
- 30s 防抖到期后的重提**替换**旧条目并令旧 token 失效（避免同一 code 出现两条）；不同 serverId 也不能抢注，需等 30s。
- 本目录不参与 APK/webroot 构建：只有 `tools/apk/lobby-worker/**` 新增文件，未触碰其它路径。
