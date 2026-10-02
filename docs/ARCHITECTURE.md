# dsh-agent-browser

给 DeepSeek Harness 用的 **看得见、可接管** 的 agent 浏览器：一个由本插件自己管理的真实
Chromium（本项目自带的 `chrome-linux` 基座），通过 CDP 驱动，画面实时推进 DSH **右侧
Sidebar** 的一个原生 tab 里；agent 侧的浏览器操作则通过 `agent_browser` 工具暴露。

> 全新项目，自研运行时：**不依赖 ego-lite / ego-browser**，只把「侧边栏里看得见、随时能接管」
> 这一产品形态作为参照。

---

## 当前状态（M1，已在本机 web profile 完成实测）

| 能力 | 状态 | 证据 |
|---|---|---|
| 自管 Chrome-Linux 冷启动（headless + CDP） | ✅ 已验证 | `scripts/smoke-runtime.mjs`：Chrome/157.0.8079.0，冷启动 ~1s |
| 导航 / 读页 / 求值 / 截图 | ✅ 已验证 | 同一脚本：`example.com` 标题、正文、交互元素、PNG |
| CDP 实时画面推流（JPEG，可限帧） | ✅ 已验证 | 同一脚本抓帧 1280×800；画面落盘肉眼确认为真实渲染 |
| HTTP 面 `/status` `/stream`(SSE) `/command` | ✅ 已验证 | `scripts/smoke-routes.mjs`：含 403 同源拦截、400 未知动作、SSE 帧事件 |
| 页面生命周期（多页 / 用完即收 / 超时回收 / 上限） | ✅ 已验证 | `scripts/smoke-lifecycle.mjs`：**23 项全 PASS** |
| 磁盘页面注册表 + 按需恢复（冷启动自动还原） | ✅ 已验证 | 同一脚本：registry 落盘、冷启动还原上次活动页（整段 267 ms） |
| 内存/耗时代价量化 | ✅ 已实测 | `scripts/measure-lifecycle*.mjs`，见下文「生命周期与内存」 |
| 右侧 Sidebar 面板注册（tab 类型 + 正文席位） | ✅ 已验证 | Client 检查器：`sidebar.right.pane.tab` 的 occupants 含 `{key:"dsh-agent-browser",active:true}` |
| 面板**视觉渲染** | ✅ 已验证 | 用户确认：刷新后右侧栏出现「Agent 浏览器」tab，画面即 example.com 实时页 |
| `agent_browser` 工具（M1 动作集） | ✅ 已验证 | 子代理真实调用 4 次：status / open×2 / read（真实页面 + 30 个交互元素） |
| `agent_browser` 新增动作 `pages/close/restore/sweep` | ✅ 已验证（活宿主） | 子代理在冷启动后的实例上真实调用 7 次全通，新描述也在线 |
| 冷启动时面板路由注册（`ctx.inject(['webServer'])`） | ✅ 已验证（冷启动复验通过） | 重启后 `GET /status` = **200**；修法与根因见 [ARCHITECTURE.md](docs/ARCHITECTURE.md) §8 |
| 面板休眠态（记忆列表 + 恢复按钮） | ⏳ 待人工确认 | 路由与视口链路已通；休眠占位需点一次「收页」看 |
| 视口**实时**跟随面板（拖侧边栏/换显示器都跟） | ✅ 已验证（活宿主拖拽轨迹） | 用户在真 GUI 里拖动分隔条，`viewport` 连续变化 1127→…→903→920→…→1007，`frame` 慢一次绘制跟随；运行时 29 项断言 |
| **现代风控通过率（实测）** | ✅ 已验证 | reCAPTCHA v3 **0.9**、Turnstile **出 token**、Cloudflare 基准页 **1.0s 通过**（有头/无头皆然）；`scripts/measure-challenge.mjs` |
| **真拖拽（按住移动）与命名键** | ✅ 已验证 | 滑块 value=76/100；方向键 50→52。修掉两个真 bug：move 缺 `button:'left'`（拖拽一直是坏的）、`modifiers` 传数组而 CDP 要 int 位掩码（命名键一直被拒） |
| **输入自然化（`humanizeInput`）** | ✅ 已验证 | 曲线轨迹/按下停留/逐字打字；断言覆盖"点击仍会跳转"与"逐字输入完整" |
| **可检测性（实测 0/58）** | ✅ 已验证 | 离屏渲染用 `--ozone-platform=headless`：UA 是 `Chrome`（非 HeadlessChrome）、WebGL 是真 GPU、`webdriver:false`、**sannysoft 58 项 0 失败**（`--headless=new` 是 4 失败） |
| **人机验证：检测并交给真人** | ✅ 已验证 | 面板提示条 + 工具 `⚠`；断言覆盖 Sogou 反爬页（识别）与普通页（清除） |
| **搜索引擎：预配置 + 实测 + 自主选择** | ✅ 已验证（真实网络） | `scripts/smoke-search.mjs`：10 个预配置引擎；4 个引擎实测 2.2s 排完名次并落盘；Google/百度/Brave/Mojeek 的拦截页被正确判为不可用；`search` 只给查询词即可 |
| 面板同路径的输入回传（click/scroll/back） | ✅ 已验证 | `POST /command {action:"input"}` 点击 example.com 的链接后跳到 iana.org，`back` 返回成功 |
| 经 harness 的实时画面（SSE） | ✅ 已验证 | 从 `127.0.0.1:3080/api/agent-browser/stream` 取帧落盘，肉眼确认是真实渲染 |
| **标签条精简 + 左键菜单 + 状态配色 + forget** | ✅ 已验证（面板渲染树 + 路由） | 断言：标签无 `p1` 前缀、站点后缀已剥离、**无灯**、左键点击把该页交给菜单且**锚点=标签矩形**、菜单**向上展开并贴住标签上沿（top=694px）**、靠右不溢出（left=142px）、醒着用 `state-business-primary`／休眠用 `grayscale`；路由 `forget p4 → forgot=p4 4→3 页` |
| **逐页休眠 / 唤醒（单个）** | ✅ 已验证（路由 + 面板） | 路由断言：`close page=p2 → closed=p2, p1 仍 live, p2 parked`；`restore page=p2 → restored=p2, others untouched=true`。面板断言：每行都是独立「唤醒」按钮、每个 chip 都有独立休眠/唤醒控件 |
| **休眠时也能新建标签页** | ✅ 已验证（活宿主） | 原 Bug：按钮被 `state !== 'running'` 禁用。修法：按钮不再按状态禁用（宿主按需启动，实测 `stopped → open newPage` 返回 200 + 新页）；面板断言覆盖"休眠时启用""停止时也启用" |
| **面板可自建标签页 / 多开** | ✅ 已验证（路由 + 活宿主） | `＋ 新建标签页` 与 Alt+回车；路由断言 `空 URL + newPage → 1 页变 4 页, active=p4, url=about:blank`；活宿主实测 1→3 页 |
| **面板页面条 + 文字按钮 + 休眠态命名** | ✅ 已验证（路由/工具）+ ⏳ 视觉待你确认 | 底部常驻页面条：点一下切页（已休眠的自动唤醒，断言 `activate page=p1 → active=p1 p1:live`）；工具栏**几何图标全部换成文字**；一个概念一套词（休眠/唤醒），文案由 `scripts/print-panel-strings.mjs` 从代码生成 |
| **只有一种模式：有头（侧边栏）** | ✅ 已验证 | 侧边栏面板就是它的**头/屏幕**：没有无头模式，也没有桌面窗口模式。屏幕来自**面板实测尺寸**（实测 1147×1397 ↔ 页面 1147×1397），未上报时用 `virtualScreenWidth/Height` 兜底（0×0 会完全不渲染）。引擎离屏渲染只是实现细节，状态里不出现 `headless` 字样 |
| **侧边栏实时同步（有头/无头都一样）** | ✅ 已验证（四组合，量化） | `scripts/smoke-visibility.mjs` 走**面板真正的那条链路**（`GET /api/agent-browser/stream` SSE，过真实路由层）：四组合全部收到帧、动作→面板出新帧 **121–223 ms**；面板点击也真的落到页面上 |
| **截图回给模型（图片块）** | ✅ 已验证（工具层） | `action=screenshot` 的字节交给 attachment 服务，返回 `[{text},{image}]`；`noImage=true` 只回字节数。断言覆盖渲染与降级 |
| **SSE 自动重连 + 面板自愈** | ✅ 服务端已验证 · ⏳ 视觉待你确认 | 断线后指数退避重连并重拉一次 status；服务端 close 时清理监听（断言：重连后仍有帧 `{"status":1,"frame":4}`） |
| **下载捕获** | ✅ 已验证（Chromium） | 本地服务器发 `Content-Disposition` → 文件真落盘且内容一致；**点链接下载**同样成立 |
| 每会话隔离浏览器 | ❌ 未做（M3） | 页面级隔离已就绪，进程级共享 |
| **登录态导入（真实浏览器 → agent 浏览器）** | ✅ 已验证（Chromium 系） | Helium 527 条 0 失败；导入 GitHub 后 `meta[user-login]=Grant-Felix`；httpOnly 保留、重启存活。|

---

## 它解决什么问题

通用浏览器不是为 agent 设计的。agent 在网页上干活时，人 **看不见** 也 **插不上手**：卡在
验证码、走岔了路、需要人工点一下，都只能等它跑完再看结果。

本项目把这三件事做成一条链路：

1. **看得见**：右侧 Sidebar 里一个常驻 tab，实时直播 agent 正在看的那一页。
2. **接得住**：在画面上直接点、滚、打字——走的是同一个浏览器、同一个页面，不需要打断 agent 重来。
3. **叫得动**：模型侧用 `agent_browser` 工具打开页面、读页面、执行脚本。

## 它不是什么

- 不是 iframe 沙盒浏览器。DSH 自带 `ui-sidebar-browser` 用 iframe 承载网页，受站点
  `X-Frame-Options` / CSP 限制，且在 **Web profile 里默认禁用**。本项目跑的是真 Chromium，
  没有这些限制。
- 不做内核级改动。基座是现成的 Chrome-Linux 二进制，所有能力都在应用层：进程生命周期管理 +
  CDP 协议层 + Sidebar 面板。**架构上为日后源码级补丁留了位置**（`src/browser.js` 只依赖
  `webSocketDebuggerUrl` 与标准 CDP 域，换一个打过补丁的 Chromium 不需要改面板与工具）。

---

## 架构一眼

```
        ┌──────────────── DSH Web (127.0.0.1:3080) ────────────────┐
        │  右侧 Sidebar                                              │
        │   └─ tab 类型 "agent-browser" ← client.js 注册到             │
        │      ctx.sidebarRightTabs + sidebar.right.pane.tab         │
        │      面板：SSE 取帧 → <img>；点击/滚轮/键盘 → POST /command  │
        └───────────────┬───────────────────────────────────────────┘
                        │  /api/agent-browser/{status,stream,command}
        ┌───────────────▼──────────── DSH Host 进程 ────────────────┐
        │  index.js  装配：工具 + 路由 + 运行时生命周期                │
        │  src/routes.js   HTTP 面（同源校验）                        │
        │  src/tools.js    agent_browser 工具                        │
        │  src/browser.js  进程生命周期 + CDP 会话 + 推流/输入         │
        │  src/cdp.js      最小 CDP 客户端（Node 内置 WebSocket）      │
        └───────────────┬───────────────────────────────────────────┘
                        │  CDP over ws://127.0.0.1:<随机端口>
        ┌───────────────▼───────────────────────────────────────────┐
        │  vendor/chrome-linux/chrome （Chromium 157，本项目基座）     │
        └───────────────────────────────────────────────────────────┘
```

细节、扩展点出处与设计取舍见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)；下一步计划见
[`docs/ROADMAP.md`](docs/ROADMAP.md)。

---

## 安装

本项目是一个 DSH bundle（`package.json` 的 `dsh.bundle.patch` + `dsh.client`）。
用 Plugin Manager 的 `install_bundle` 指向本目录即可；不要手写 profile 的
`package.json` / `cordis.patch.yml`。

第一次在新机器上使用前，先备好浏览器基座：

```sh
scripts/vendor-chrome.sh /path/to/chrome-linux.zip          # 解到 <repo>/vendor/
scripts/vendor-chrome.sh /path/to/chrome-linux.zip --into-data-dir   # 或解到 ~/.local/share/dsh-agent-browser/
```

## 配置

全部字段可选，空 config 就是可用默认值。在 profile 的 patch 层覆盖（**同名覆盖会替换整个
config，要连同想保留的字段一起写**）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `browser` | `'chromium'` | 本构建只有一个引擎：Chromium（CDP） |
| `chromePath` | `''` | 浏览器二进制。空 = 依次找 `vendor/chrome-linux/chrome` → 数据目录 → PATH |
| `headless` | `'auto'` | **有显示器就有头，没有才无头**。实测：无头在检测页 58 项里失败 4 项（UA 里的 `HeadlessChrome`、SwiftShader 软件 WebGL、800×600 假屏幕），同一构建有头 **0 失败**。`true`/`false` 可强制 |
| `downloadDir` | `''` | 下载落盘目录；空 = `<状态目录>/downloads` |
| `virtualScreenWidth` / `virtualScreenHeight` | `1280` / `900` | **面板尚未上报尺寸时**使用的虚拟屏幕。离屏渲染的浏览器没有自己的屏幕，0×0 会完全不渲染（实测：帧 0、点击落空）。面板一连上就用它的实测尺寸覆盖 |
| `userDataDir` | `''` | 空 = `~/.local/share/dsh-agent-browser/profile`（登录态落盘，跨重启保留） |
| `startUrl` | `about:blank` | 冷启动后打开的第一页 |
| `viewportWidth` / `viewportHeight` | `0` / `0` | **0 = 自动**：不覆盖，页用引擎自己的视口。本项目**不假定任何屏幕尺寸**（用户屏幕不同、侧边栏宽度还会被随时拖拽）；想钉死尺寸时才填数字 |
| `viewportFollowsPanel` | `true` | **实时跟随**面板实测尺寸：`ResizeObserver` + 窗口 resize + **DPR 变化**（拖到另一块缩放比的显示器）都会触发，150ms 合帧、首次立即上报；画面与侧边栏 **1:1**，不缩放不留白 |
| `viewportMinWidth` / `viewportMinHeight` | `320` / `240` | **保险丝，不是偏好**：只用来拒绝荒谬尺寸（40px 或 40000px 的视口任何页面都活不了） |
| `viewportMaxWidth` / `viewportMaxHeight` | `10000` / `10000` | 同上，上限保险丝 |
| `pointerModel` | `'human'` | 指针运动模型：`human` 走人手轨迹，`linear` 瞬移（保留用于对照实验） |
| `pointerSpeedPxPerSec` | `900` | 巡航速度；路径时长由距离/速度决定 |
| `pointerJitter` | `1` | **抖动振幅**（0=不抖，1=默认，可到 5；实测 1→RMS 2.51px、3→7.01px） |
| `typingIntervalMs` / `typingJitterMs` | `90` / `70` | 逐字输入的基准间隔与波动，空格处偶发更长停顿 |
| `pressDwellMs` | `60` | 按下到抬起之间按住多久 |
| `humanizeInput` | `true` | 输入自然化：曲线+抖动的指针轨迹、按下停留、逐字打字节奏、滚轮分档。行为评分系统在**交互**时判分，瞬移点击是最廉价的机器特征 |
| `fps` | `12` | 推给面板的帧率上限（超出的帧按最新帧丢弃） |
| `jpegQuality` | `60` | screencast JPEG 质量 |
| `maxWidth` | `1600` | 单帧最长边 |
| `extraArgs` | `[]` | 追加给 Chrome 的 argv；控制面参数（`--remote-debugging-port`、`--user-data-dir`、`--headless` 等）会被丢弃 |
| `pageIdleTimeoutMin` | `180` | 一个页面空闲 N 分钟后**收页**（关掉 target、网址留在硬盘）；0 = 不收 |
| `browserIdleTimeoutMin` | `360` | 整个浏览器空闲 N 分钟后**停进程**（这一档立刻释放 1.4–2 GB）；0 = 不停 |
| `restoreOnDemand` | `true` | 冷启动时自动重开上次活动页（约 32 ms + 一次页面加载），调用方无感 |
| `maxLivePages` | `8` | 同时存活的页面上限，超出按最久未用收页（不会收当前活动页）；0 = 不限 |
| `sweepIntervalSec` | `60` | 回收巡检周期 |
| `searchEngine` | `''` | 钉死一个引擎 id（如 `bing`）。**空 = 交给实测**：不动手选，插件自己测完再挑 |
| `searchEngines` | `[]` | 追加自定义引擎：`[{ id, name, url }]`，`url` 里要有 `{q}` |
| `searchProbeQuery` | `wikipedia` | 探测用的查询词（任何常见词都行） |
| `searchProbeTimeoutMs` | `8000` | 探测时单个引擎的导航预算 |
| `searchSelectionTtlHours` | `24` | 实测选中的选择保持多久；过期后下次搜索会重测 |
| `searchMaxAttempts` | `3` | 一次搜索最多尝试几个可用引擎（被拦就换下一个）；设 1 = 不换 |

> M1 的 `idleTimeoutMin` 已改名为 `browserIdleTimeoutMin`（语义未变，只在文档与代码里更明确）。

## 工具：`agent_browser`

| action | 作用 |
|---|---|
| `status` | 浏览器是否在跑、有哪些页面（含各自的空闲时长） |
| `open` | 导航当前页；**`newPage: true` 新开一页**（`url` 留空即 `about:blank` 空白页）；多标签就是这么开的 |
| `read` | 页面 URL/标题/正文，以及最多 200 个可交互元素及其视口坐标 |
| `eval` | 在页面里执行 `expression`，返回 JSON 值 |
| `back` / `forward` / `reload` | 历史与刷新 |
| `screenshot` | 截当前视口（返回 base64 PNG 长度与 URL） |
| `pages` | 列出所有页面（存活/已收）与当前回收策略 |
| `close` | **用完这一页**：收页，网址留在硬盘，随时可恢复 |
| `restore` | 把收回来的页面重新打开 |
| `activate` | 按 key/URL 聚焦某页；**已休眠的会被自动唤醒**（面板标签条点一下就是这个动作） |
| `forget` | **关闭并忘记**：连记录一起删掉（与 `close` 的区别就在这里——`close` 是休眠、可唤醒） |
| `sweep` | 立刻跑一次回收策略（不等巡检周期） |
| `viewport` | 改视口（`width`/`height`）；面板开着时视口本来就跟着面板走 |
| `click` | 点击：`x`,`y`（CSS 像素，直接用 `read` 给出的坐标）或 `nx`,`ny`（视口 0..1）；`double: true` 双击 |
| `move` | 只移动指针到目标点 |
| `drag` | **`x`,`y` → `toX`,`toY`**：按下 → 走人手轨迹 → 抬起。**滑块验证码要的就是这个动作** |
| `scroll` | 滚轮：`deltaX`,`deltaY`，可给 `x`,`y`，省略则在视口中心 |
| `type` | 输入 `text`；可给 `selector` 先聚焦（并全选）；`submit: true` 补一个回车 |
| `key` | 按命名键（`Enter`/`Tab`/`ArrowDown`/`Space`…），可带 `modifiers` |
| `downloads` | 列出本次运行捕获到的下载（状态、文件名、**落盘路径**、字节数）；Chromium 有效 |
| `import_logins` | **把真实浏览器的登录态导入本浏览器**：默认 `dryRun: true` 只列出来源；`dryRun: false` 才真的复制，可 `source`（如 `helium`）与 `domains`（如 `["github.com"]`）限定范围 |
| `cookies` | 列出本浏览器现有的 cookie（域名/名称/是否 httpOnly/值长度），用于核对导入结果 |
| `search` | **只给搜索词**：引擎由插件替你选（钉死的 / 上次实测选中的 / 现测现选），不用输引擎网址 |
| `engines` | 列出预配置引擎表、当前选择、以及每个引擎上次实测结果 |
| `probe` | 真实逐个测速与可用性（可达性 + 加载耗时 + 结果密度），排出名次并选定最合适的 |
| `stop` | 关掉整个浏览器进程 |

多数动作可用 `page` 指定目标页（页面 key `p1`/URL 片段/序号），省略则操作当前活动页。

## 搜索引擎：预配置 + 实测 + 自主选择

**为什么不是写死一个默认引擎**：可达性随网络与地区差别极大，而且**会随时间变化**。本机实测（2026-10-02，同一台机器、相隔几分钟）：

| 引擎 | 实测 | 判定 |
|---|---|---|
| Bing | 533 ms / 28 链接 | ✅ 可用（被选中） |
| 百度 | 606 ms / 31 链接 → 后来 `百度安全验证` | ⚠️ 时好时坏 |
| DuckDuckGo | 1129 ms / 7 链接 | ✅ 可用 |
| Brave Search | 页面标题直接是 `Captcha - Brave Search` | ❌ 人机验证 |
| Mojeek | `403 - Forbidden ... automated queries` | ❌ 拒绝自动化 |
| Google | 跳到 `google.com/sorry/index` | ❌ 异常流量 |
| 搜狗 | 探测时正常，真搜索时跳 `/antispider/`（正文"此验证码用于确认…"） | ❌ 反爬墙，**且它有很多出站链接** |

机制（`src/search.js`）：

1. **预配置表**：内置 10 个引擎（DuckDuckGo / Bing / Google / Brave / Startpage / Mojeek / Ecosia / 百度 / 搜狗 / Yandex），
   每个是 `https://…?q={q}` 模板；可用 `searchEngines` 追加自定义。
2. **探测是真的逐个导航**：一个专用页面里顺序跑完（顺序而非并发——同一浏览器里并发会互相污染计时），
   读页面自己的 Performance API（`ttfb` / `loadEventEnd`）拿可比数字。
3. **"可用"由三个独立信号判定**（每个单独都被骗过）：
   - **正文/标题**：拦截页会自报（Brave 标题即 `Captcha`、搜狗"此验证码"、Mojeek "automated queries"）；
   - **URL**：引擎会跳到专门的墙（Google `/sorry`、百度 `wappass`、搜狗 `antispider`）；
   - **页面是否真的提到查询词**：拦截页通常不提。这条是必需的——**"出站链接够多"作为判据太弱**：
     搜狗反爬页有 5 个链接、旧规则（`未拦截 && 链接≥3`）把它判成了"可用"，实测里就是这么漏的。
4. **搜索时还要再验证一次结果**：实测发现百度对 `wikipedia` 放行、对 `deepseek harness` 弹验证码；搜狗探测正常、
   真搜索跳反爬页——所以 `search` 打开后立刻判定，被拦就**自动换下一个可用引擎**（最多试 `searchMaxAttempts` 次），
   全都被拦时**如实报告**"这是拦截页不是结果页"，而不是把验证码页当结果交出去。
5. **选择落盘**：`~/.local/share/dsh-agent-browser/search.json` 记住选择、上次探测结果与最近搜索历史；
   `searchEngine` 显式钉死时以配置为准（钉死仍保留 fallback，把 `searchMaxAttempts` 设为 1 即可强制独占）。
6. **首次搜索要等一次探测**：全新状态下第一次 `search` 会先把 10 个引擎测一遍（**实测 17 秒**），之后 24h 内
   直接命中；想零成本就 `searchEngine` 钉死一个，或先手动跑一次 `probe` 只测常用几个。
6. **面板地址栏**同样支持：输入带空格或不是网址的内容 → 走 `search`；是网址 → 走 `open`。

## 可检测性：先量，再决定投哪里

用一个公开检测页（bot.sannysoft.com，58 项）对同一份 Chromium 157 做对照实验：

| 信号 | 无头 | 有头 |
|---|---|---|
| `navigator.webdriver` | false | false |
| User-Agent | `…HeadlessChrome/157…` ❌ | `…Chrome/157…` ✅ |
| WebGL Renderer | `SwiftShader`（软件渲染）❌ | `ANGLE (Intel, Mesa Intel Graphics, OpenGL ES 3.2)` ✅ |
| screen | `800x600` ❌ | `1920x1200` ✅ |
| **失败数** | **4 / 58** | **0 / 58** |

CDP 相关的行（`CHR_DEBUG_TOOLS`、`WebDriver`、`Selenium`）在两种模式下**都通过**；我们从不加 `--enable-automation`，因此连"正在被自动化控制"的横幅都不会出现。

**结论（会改变优化顺序，所以写在这里）**：本机这份实测里，**被标记的原因是无头模式，而不是控制协议**。所以默认改成 `headless: 'auto'`——有显示器就用真窗口（真 UA、真 GPU、真分辨率），这比任何伪装都更"真实"，而且是零成本。无显示器（服务器/CI）自动退回无头。

诚实声明：sannysoft 是较老的检测页，它**测不到**现代风控（reCAPTCHA v3 / Turnstile）可能关注的行为层、TLS 与 IP 信誉，也测不到打开调试端口这件事本身。所以这不能证明"CDP 无害"，只能证明**当前最大的一处泄漏是无头**。若日后要彻底移除协议层痕迹，扩展控制通道是预留的下一步（见 [ROADMAP](docs/ROADMAP.md) M7）。

## 只有一种模式：有头（侧边栏）

**这条是契约，不是偏好**：本插件的浏览器**没有无头模式，也没有桌面窗口模式**，只有**一种**——

> **有头模式，而它的"头"就是 DSH 侧边栏面板。** 面板提供屏幕，也接收输入。

- 用户看的、点的，是 **DSH 右侧栏面板**；数据路径是 **`GET /api/agent-browser/stream`（SSE）→ 面板渲染**，
  面板的点击/滚轮/按键经 `POST /command {action:'input'}` 回到运行时。
- **桌面上不会出现任何浏览器窗口**。引擎在**离屏平台**上渲染（Chromium 的 `--ozone-platform=headless`）
  ——**那是引擎的实现细节，不是本插件的模式名**：浏览器本身仍是**有头**的（普通 `Chrome` UA、真 GPU）。
- **"不显示"等同于无头，所以面板在浏览器就必须在**（两条硬规则，都已断言）：
  1. **面板一连上就自动启动浏览器**（不需要工具调用、不需要点按钮），面板永不显示空占位；
  2. **只要面板在看，浏览器就不算空闲**——空闲回收既不停浏览器、也不回收**正在显示的那一页**。
     面板断开后才恢复回收。实测：`panel opened -> was stopped, now running, viewers=1`、
     `sweep while watched -> stopped:false, parked:[]`、`sweep with no panel -> stopped:true`。
- 屏幕尺寸来自**面板自己的实测盒子**（实测：面板 1147×1397 → 页面 1147×1397）。面板尚未上报时用
  `virtualScreenWidth/Height` 兜底，因为 0×0 会完全不渲染（实测帧 0、点击落空）。
- 实测（`scripts/smoke-visibility.mjs`，走上面的真实链路）：**动作 → 面板出现新帧 214–223 ms**。


**帧是按需产生的，这点要说清**：Chromium 用事件推送（`Page.startScreencast`，画面**变了才发**），
所以静止页面 2.5 秒只有 2 帧是正常的——面板显示的是"最后一帧"，画面变化时立刻跟上；
这不影响"实时同步"：延迟测的是**动作到画面变化**；面板连接时还会重放最后一帧，静止页也不会空白。

## 改了客户端代码要怎样才生效（实测，别踩这个坑）

**必须重启 DSH（或让 `pnpm run dev:web` 的 watcher 在跑），单按 F5 不够。** 这不是猜测：

- client 模块由宿主按 **revision 组合**后提供，源码里 `rebuilt()` 的注释是
  *"the HMR watch's registration hook — the only entry point through which build changes reach the graph"*；
  没有 watcher 时，**磁盘上的改动进不了模块图**。
- 实测取证：`client.js` 最后修改 **19:22**，而活宿主 `dsh web` 启动于 **19:12**，且当时**没有** `dev:web`/vite 进程
  → 浏览器拿到的仍是 19:12 组合出的旧 bundle。**"侧边栏纹丝未动"就是这么来的**。
- 因此：改 `client.js` 之后要**重启 DSH + 刷新页面**；宿主侧改动本来就一直需要重启（模块缓存）。

## 面板长什么样：文案就是代码里的那份

**这一节的内容由 `node scripts/print-panel-strings.mjs` 从 `client.js` 直接生成**——之前文档写"休眠占位"、
面板上却没有"休眠"二字，就是靠手写文档造成的。以后以这个命令的输出为准。

**一个概念一套词**（曾经有四套：休眠 / 记住 / 收页 / 关闭+恢复，已统一为 **休眠 / 唤醒**）：

- **状态名**：`已休眠`（浏览器回收内存后）、`未启动`、`启动中`、`启动失败`、`运行中`
- **动作**：`休眠此页`（关闭当前页但记住网址）· `唤醒` · `停止浏览器` · `启动浏览器`
- **列表**：`已休眠的页面（N）`，超出写 `…以及另外 N 个已休眠页面`
- **新建标签页**：标签条末尾的 `＋ 新建标签页`（点一下开一个 `about:blank` 新页，原页面留着）；**页面休眠或浏览器已停止时也能点**——
  宿主会按需把浏览器拉起来再开页（实测：`stopped` 状态下该动作返回 200 并新建 `p6 live about:blank`）；地址栏里
  输入后按 **Alt/⌘+回车** 也会在新标签页打开——这两条与浏览器惯例一致，也是面板不再"只有单页可用"的原因
- **标签只显示"这一页是什么"**：不再有 `p1/p2` 前缀，也不带站点后缀（`deepseek harness - 搜索` → `deepseek harness`）；
  没有标题时退回域名。宽度上限 150px，超出省略
- **没有灯、没有额外按钮**：标签上只有一个词；**左键单击标签**即弹出该页的菜单，同时切到那一页。
  菜单只有**两项**：`关闭` 与 `休眠`/`唤醒`——第二项文字随状态变化（醒着 `休眠`，已休眠 `唤醒`）。
  `Esc` 或点别处自动关闭
- **菜单贴着被点的标签**：定位用**该标签的矩形**（不是鼠标落点——按落点会让菜单飘到标签中间之外），
  菜单**左下角与标签左上角对角相接**（间隔 2px）；下方放不下就翻到标签上方，靠右边缘时自动左移不溢出。
  标签条在面板底部，所以正常情况菜单都是"从标签上边缘向上展开"
- **颜色就是状态**：醒着（含当前活动页）用主题的**蓝紫品牌色**，已休眠用**灰色 + `grayscale(1)` + 降透明度**。
  这里有个实测结论值得记下：`--dsw-alias-brand-primary` **不是**蓝紫——它解析到 `--dsw-static-neutral-bluish-*`
  （`#f9fafb` / `#0f1115`，中性墨色）。蓝紫要用 DeepSeek 品牌别名
  `--dsw-alias-state-business-primary`（=`--dsw-static-deepseek-400/500` = `#7aaaff` / `#4176e6`）
  `关闭` 对应新增的 `forget`：**连记录一起删掉、不保留网址**（菜单里有说明，且标红）；
  `休眠` 则关掉但记住网址
- **休眠列表也不再带 key 前缀**（同样只显示内容），**每一行本身就是一个「唤醒」按钮**，点哪行醒哪页；
  占位里的总按钮叫 `唤醒最近一页`（不暗示"全部"）
- **底部只有一行**：`〔N〕` **数量球** + **可左右滑动的标签选择条** + `＋ 新建标签页`。
  chip 里 `已休眠` 的虚线半透明、当前活动页实心高亮，**点一下即切换（已休眠的自动唤醒）**；
  数量球按状态着色（运行中=绿 / 重连中=橙并脉冲 / 失败=红），**鼠标悬停显示引擎、有头无头、状态、标题与标签数**
  （原来"标签条"和"标签数"占两行，现在合成一行）
- **工具栏按钮全部是文字**，不再是几何图标（远程/移动/容器场景下没人能猜出图标含义）
- **每页工具提示**：`休眠此页` → "关闭当前页但记住网址，随时可以唤醒"；`停止浏览器` → "关闭整个浏览器；页面网址留在硬盘上，下次调用自动恢复"

术语对照（面板给人看 / 工具给 agent 看）：面板 `休眠此页` = 工具 `action=close`；面板 `唤醒` = 工具 `action=restore` / `activate`；
面板 `停止浏览器` = 工具 `action=stop`。

```
panel strings (47 keys, from client.js)

key                    zh / en
---------------------  ------------------------------------------------------------
tab.title              Agent 浏览器
                       Agent Browser
guide.title            Agent 浏览器
                       Agent Browser
guide.description      观看 agent 正在使用的真浏览器，并可随时接管点击与输入
                       Watch — and take over — the real browser the agent is using
status.running         运行中
                       running
status.starting        启动中
                       starting
status.stopped         未启动
                       Not running
status.dormant         已休眠
                       Dormant
status.runningNoPages  运行中（没有打开的页面）
                       Running — no pages open
hint.noPages           浏览器在运行，但一页都没开。点下面的「新建标签页」开一个。
                       The browser is up but has no page open — open a new tab below.
pages.heading          已休眠的页面（{n}）
                       Dormant pages ({n})
pages.more             …以及另外 {n} 个已休眠页面
                       …and {n} more dormant page(s)
chip.parked            已休眠
                       dormant
status.failed          启动失败
                       failed
action.start           启动浏览器
                       Start browser
action.stop            停止浏览器
                       Stop browser
action.park            休眠此页
                       Park this page
action.newTab          新建标签页
                       New tab
action.newTab.hint     开一个新标签页（先把当前页留着）；在上面地址栏输入后按 Alt+回车 也可新标签打开
                       Open another tab, keeping this one; Alt+Enter in the address bar does the same for a typed URL
action.restore         唤醒
                       Wake
action.park.short      休眠
                       Sleep
action.wake.one        唤醒这一页
                       Wake this page
action.park.one.hint   单独休眠这一页：关掉它但记住网址
                       Sleep just this page: close it but remember its URL
action.wakeRecent      唤醒最近一页
                       Wake the most recent page
menu.close             关闭
                       Close
menu.close.hint        关闭这个标签页，不保留网址（与休眠不同）
                       Close this tab; its URL is not kept (unlike sleeping)
action.back            后退
                       Back
action.back.hint       回到上一页
                       Go back one page
action.forward.hint    前进一页
                       Go forward one page
action.reload.hint     重新加载当前页
                       Reload the current page
action.park.hint       关闭当前页但记住网址，随时可以唤醒
                       Close this page but remember its URL — wake it any time
action.stop.hint       关闭整个浏览器；页面网址留在硬盘上，下次调用自动恢复
                       Close the whole browser; page URLs stay on disk and come back on the next call
action.forward         前进
                       Forward
action.reload          刷新
                       Reload
address.placeholder    输入网址或搜索词后回车
                       URL or search terms, then Enter
hint.failed            浏览器启动失败。
                       The browser failed to start.
hint.idle              浏览器尚未启动。让 agent 调用 agent_browser，或点下面的「启动浏览器」。
                       The browser is not running. Ask the agent to call agent_browser, or press Start.
hint.dormant           浏览器已休眠（回收内存）。这些页面会在下次调用或点「唤醒」时自动回来（约几十毫秒 + 一次页面加载）。
                       The browser is dormant (memory reclaimed). These pages come back on the next call or when you press Wake (~tens of ms plus one page load).
foot.ready             点击画面即可操作页面；画面获得焦点后可直接输入。
                       Click the picture to operate the page; focus it to type.
foot.connecting        正在连接画面…
                       Connecting to the live picture…
foot.remembered        已休眠 · {n} 个页面
                       dormant · {n} page(s)
foot.reconnecting      连接断开 — 正在自动重连…
                       Connection lost — reconnecting automatically…
human.title            需要你完成人机验证
                       Human verification needed
human.body             这个页面是验证/拦截页，不是内容。请在上方画面里完成验证（点画面即可操作），完成后 agent 可以继续。
                       This page is a verification wall, not content. Complete it in the picture above (click it to operate), then the agent can continue.
foot.pages             {n} 个页面
                       {n} page(s)
foot.pagesWithDormant  {n} 个页面 · {m} 个已休眠
                       {n} page(s) · {m} dormant
foot.noPages           运行中 · 没有打开的页面
                       running · no pages open
ball.tabs              {n} 个标签页
                       {n} tab(s)
```

## 登录态导入（实测可用）

**为什么要它**：有信任 cookie 的会话本身就少触发风控；不用手打密码也能直接用已有登录态。

`scripts/smoke-login-import.mjs` 实测（本机）：

| 步骤 | 实测值 |
|---|---|
| 发现 cookie 库 | Helium **527 条/167 域名**、ego-lite profile 37 条、本插件自己的 profile 40 条 |
| 读取 Helium | 解密 **527 成功 / 0 失败**，方案 `v11` |
| 导入 `github.com` | 读 15 条 → **写入 15 条、失败 0**，其中 **7 条 httpOnly 保留** |
| 核对 | `user_session` / `logged_in` / `_gh_sess` / `_octo` … 均在 |
| **端到端** | 打开 github.com → **`meta[name=user-login] = Grant-Felix`（已登录）** |
| 重启 | 停止后重启，导入的 cookie 仍在（profile 落盘） |

实现要点（`src/login-import.js`，零依赖）：

- cookie 是**加密**的（Linux 上是 `v11`）：AES-128-CBC，密钥由钥匙环口令经
  PBKDF2-HMAC-SHA1（salt `saltysalt`、1 轮、16 字节）派生，IV 为 16 个空格，明文是
  `SHA256(host_key) ‖ 值`。**域名哈希就是解密正确性的证明**（本机 6/6 匹配），不是"看起来像"。
- 用 `node:sqlite` 只读打开、`node:crypto` 解密；**报告里永远不含 cookie 值**，只有名称、数量与哈希长度。
- 安全默认：工具侧 `dryRun` 默认 **true**，必须显式关掉才会复制。


## 只有一个引擎：Chromium（CDP）

本项目**只支持 Chromium**。曾经同时支持 Firefox（WebDriver BiDi）：Firefox 157 的调试端口上
`/json/version`、`/json/list` 一律 404，官方接口只有 BiDi（`ws://127.0.0.1:PORT/session`），
于是为它单写了一个后端（BiDi 客户端、RemoteValue 反序列化、轮询帧、私有区码点键…）。
**已整体移除**：两个引擎意味着两套协议、两套 profile 布局、两套各自的坑，维护成本翻倍而能力没有翻倍。
**要再支持 Firefox，应当作为独立项目**——`#io` 接缝（`src/backends/`）与协议无关的传输层
（`src/remote.js`）都还在，接回来的成本主要是重写那一个后端。

删掉的东西（避免后来者以为它们还在）：`src/backends/firefox.js`、`src/bidi.js`、
`scripts/smoke-firefox.mjs`、`scripts/probe-firefox-protocol.mjs`、`scripts/vendor-firefox.sh`、
`browser: 'auto'|'firefox'` 与 `firefoxPath`、`hideWebdriver`（那是 Firefox 专用的 `navigator.webdriver` 覆盖）、
以及 Firefox 的 `cookies.sqlite` 导入路径与跨引擎互斥。


## 通过率实测矩阵（历史四象限表已删除）

早期版本同时支持 Chromium 与 Firefox、并有"有头/无头"两档，所以有一张 2×2 象限表。**两个前提现在都不成立**
（Firefox 已整体移除；显示模式只有一种），那张表既会误导，又会与"人机验证现状"一节产生两个互相矛盾的真相，
因此删除。命令也不再需要引擎/模式参数：

```bash
HOME=$PWD/.dev/home node scripts/probe-challenges.mjs
HOME=$PWD/.dev/home node scripts/measure-matrix.mjs
node scripts/aggregate-matrix.mjs
```

## 通过率：在现代风控上实测

用四个系统量（`scripts/measure-challenge.mjs`，有头 vs 无头，同一份 Chromium + 未改动的 CDP 控制）：

| 系统 | 有头 | 无头 |
|---|---|---|
| **reCAPTCHA v3**（唯一给分数的） | **0.9** | **0.9** |
| **Cloudflare Turnstile** | **拿到 response token** | **拿到 response token** |
| **Cloudflare**（nowsecure.nl 基准页） | **1.0s 通过** | **1.0s 通过** |
| sannysoft（老检测页） | 0 失败 | 4 失败 |

**这张表决定了投入方向**：真正决定放行的三个现代系统**在有头和无头下都通过**（v3 得分 0.9、Turnstile 出 token、Cloudflare 基准页 1 秒过），唯一标记我们的是**只测无头痕迹的老检测页**。

所以本项目的决策是：**保留 CDP 作为输入通道**，理由不只是"实测没差别"，还在于 **CDP 的输入是可信事件（`isTrusted: true`）**，而扩展 `chrome.scripting` 派发的是 `isTrusted: false`——现代行为评分会看这个，换过去可能**降低**通过率。扩展通道作为备选保留（[ROADMAP](docs/ROADMAP.md) M7），只在遇到"专门探测 CDP"的目标站点时才值得启用。

**已经做的两件真正提升通过率的事**：
1. **默认有头**（`headless: 'auto'`）：把老检测页的 4 项失败清零，且不需要任何伪装。
2. **输入自然化**（`humanizeInput`，默认开）：曲线指针轨迹、按下停留、逐字打字节奏、滚轮分档。诚实说明：**在这四个系统上量不出差别**（它们的演示端点会自动放行），所以这是"去掉一个明显特征"的保险，而不是已证实的增益。
3. **人工兜底 + 信任留存**：人过一次验证，cookie 落在持久 profile 里，后续静默通过——这是通过率最高的一层，也是唯一确定有效的。
4. **真拖拽与命名键**（顺着上面这条线修出来的两个真 bug）：现在 `down → move(按住) → up` 是真实的按住拖动
   （滑块验证码的前提），命名键（Enter/方向键/Tab…）也真的能到达页面。断言：拖动滑块 value=76/100、方向键 50→52。

## 人手运动模型（实测）

指针不是"瞬移"，而是按人类指向运动学规划出来的路径（`src/backends/chromium.js` 的 `#planPath`）：

- **最小抖动速度剖面** `10t³-15t⁴+6t⁵`：起步慢、中间快、收尾慢——匀速是脚本最廉价的特征；
- **时长随距离次线性增长**（Fitts 律），短距离不会拖成固定时间；
- **侧向弧线**：真实路径是弧不是直线；
- **抖动（tremor）**：低频振荡 + 白噪声，振幅由 `pointerJitter` 控制，接近目标时自动减弱（手会稳下来）；
- **过冲与回补**：距离越大概率越高，手会越过目标再拉回来。

一次约 900px 的拖动实测（`scripts/measure-pointer.mjs`）：

| 模型 | 采样点 | 耗时 | 路径效率 | 曲率 | 最大/均速 | 抖动 RMS | 方向反转 |
|---|---|---|---|---|---|---|---|
| 线性瞬移 | 4 | 150ms | 1.000 | 0 | 3.00 | — | 0 |
| **人手 抖动=1** | **56** | 1150ms | **1.032** | **29px** | **2.39** | **2.51** | **22** |
| **人手 抖动=3** | **56** | 1367ms | **1.138** | **51px** | **2.37** | **7.01** | **26** |

路径效率 1.03（人类跨屏移动常见 1.02–1.15）、速度呈加速-巡航-减速、有 22 次微修正；**抖动是可控的**：`pointerJitter` 从 1 调到 3，RMS 从 2.51px 到 7.01px。（线性那行的"抖动 RMS"只有 4 个采样点，数值没有比较意义，已如实标注。）

## 人机验证：交给真人，而不是假装能过

无论用哪条控制通道，**没有任何自动化通道能证明"我是人"**。所以本项目对验证墙的处理是"**发现 → 上报 → 交给人 → 继续**"：

- 页面元信息刷新时同时做一次验证墙检测（正文/标题/URL 三重标记，与搜索引擎判定同一套依据），
  结果进 `status().humanCheck` 并通过 SSE 推给面板；
- **面板显示醒目提示条**：「需要你完成人机验证 —— 请在上方画面里完成（点画面即可操作），完成后 agent 可以继续」；
- 工具结果里同样带 `⚠ HUMAN VERIFICATION DETECTED`，让 agent 主动请求用户接管，而不是把验证码页当内容读下去。

实测锚点：Sogou 反爬页（`/antispider/`）、Google `/sorry/`、百度 `wappass`、Brave 标题 `Captcha - …`、Mojeek `automated queries`。

## 生命周期与内存（实测数字）

本机实测（headless `--headless=new`，4 页最重时 15 个进程）：

| 观测 | 数字 |
|---|---|
| 1 个页面 | 1263 MB / 10 进程 |
| 4 个页面 | 1996 MB / 15 进程 → **每多一页约 +245 MB** |
| 关掉页面的瞬间 | 只回收 ~0；**~20 s 后**才降到 1424 MB（渲染进程懒回收） |
| 重新打开一个页面 | `createTarget+attach+enable` **32 ms**，`navigate→load` **21 ms**（缓存命中） |
| 停掉整个浏览器 | 立刻释放 **~1.4–2 GB** |

所以策略是两档、且**以整进程为主**：

1. **用完即收（显式钩子）**：agent 调 `close`，或人在面板上点「关闭当前页」——收掉这一页，网址进硬盘。适合"这页看完了"的确定性判断。
2. **空闲回收（自动钩子）**：巡检每 60 s 跑一次
   - 页面空闲超过 `pageIdleTimeoutMin`（默认 3h）→ 收页；
   - 存活页面超过 `maxLivePages`（默认 8）→ 收最久未用的；
   - 整个浏览器空闲超过 `browserIdleTimeoutMin`（默认 6h）→ 停进程。
3. **按需恢复**：`pages.json` 记住每个页面的网址与最近使用时间；下次任何调用会自动把上次活动页重开，
   所以"收了"对调用方几乎无感。**注意**：恢复的是网址，不是页面内存态——POST 结果、未提交表单、
   页内滚动位置不会回来（`localStorage`/cookie 在磁盘 profile 里，会回来）。

只有**真实的工具/面板命令**算活动；仅仅盯着画面看不算（否则一个忘记关闭的面板会长期占住 1.4 GB）。

## 侧边栏面板怎么用

1. agent 第一次调用 `agent_browser` 后，面板会自动出现在右侧 Sidebar（也可在右侧栏的
   起始页里点「Agent 浏览器」）。
2. 顶部一排文字按钮：后退 / 前进 / 刷新 / 地址栏（回车导航；**Alt+回车** 在新标签页打开）；
   标签条在底部，**左键点标签**弹出该页菜单（关闭 / 休眠·唤醒）。
3. 画面上：**单击** = 点击页面，**按住拖动** = 移动/拖拽，**滚轮** = 滚动页面；
   点击画面让它获得焦点后可直接**键盘输入**。
4. 页面被回收或浏览器被停掉后，面板转为**已休眠**：占位第一行就是状态名，下面列出「已休眠的页面（N）」，一个「唤醒」按钮即可恢复
   （也可以什么都不做，下次工具调用会自动恢复）。

## 开发与自测

```sh
# 运行时：冷启动 → 导航 → 读页 → 截图 → 抓帧 → 停止
HOME=$PWD/.dev/home node scripts/smoke-runtime.mjs https://example.com/

# HTTP 面：状态、同源拦截、命令、生命周期命令、搜索命令、SSE 帧流
HOME=$PWD/.dev/home node scripts/smoke-routes.mjs

# 生命周期验收：收页 / 超时回收 / 上限 / 磁盘记忆 / 冷启动还原（29 项断言）
HOME=$PWD/.dev/home node scripts/smoke-lifecycle.mjs

# 可见且可操作：走面板真正的那条 SSE 链路
HOME=$PWD/.dev/home node scripts/smoke-visibility.mjs

# 下载捕获：本地服务器发附件 → 断言文件真落盘、内容一致
HOME=$PWD/.dev/home node scripts/smoke-downloads.mjs

# 登录态导入：真机 profile → agent 浏览器，并验证 GitHub 认为已登录
node scripts/smoke-login-import.mjs

# 通过率矩阵：先普查可达性，再逐引擎 × 逐显示模式量
HOME=$PWD/.dev/home node scripts/probe-challenges.mjs          # 23 个挑战面的可达性普查
HOME=$PWD/.dev/home node scripts/measure-matrix.mjs
node scripts/aggregate-matrix.mjs                              # 汇总成对比表

# 搜索引擎：真实网络探测、拦截识别、自主选择与落盘
HOME=$PWD/.dev/home node scripts/smoke-search.mjs                    # 默认测 4 个引擎
HOME=$PWD/.dev/home node scripts/smoke-search.mjs bing,baidu,mojeek  # 或指定子集

# 视口实时跟随的观测（拖侧边栏时看数值变化）
node scripts/watch-viewport.mjs 120

# 量化：每页内存、关页回收延迟、重开耗时
HOME=$PWD/.dev/home node scripts/measure-lifecycle.mjs
HOME=$PWD/.dev/home node scripts/measure-lifecycle2.mjs
```

`HOME` 被指到工作区内，是为了让 profile 与页面注册表都落在工作区里（受限文件沙箱下可写），
不污染你自己的 `~/.local/share`。

### 开发注意：宿主侧改动需要重启宿主

DSH 的插件装载器是**无缓存破坏的 `await import(name)`**（`cordis-plugin-loader/lib/index.js:211-227`），
所以改完 `index.js` / `src/*.js` 之后，本进程内永远命中旧模块——**切换 bundle 开关也不顶用**，
必须重启一次 DSH 宿主才会加载新的模块代。纯前端改动（`client.js`）不受此限。

自检顺序：先跑上面四个脚本（在宿主进程之外，永远是最新代码），再重启宿主确认 DSH 侧的工具 schema 与面板。

## 已知限制（诚实说明）

- **进程级共享**：全 profile 共用一个浏览器进程；页面级已经隔离（多页、各自收、各自恢复），
  每会话独立进程见 M3。
- **恢复的是网址不是内存态**：回收后重开只还原 URL；POST 结果、未提交表单、页内滚动位置会丢
  （cookie/`localStorage` 在磁盘 profile 里，会保留）。
- **只把真实命令算作活动**：盯着画面看不算活动，所以一个忘了关的面板最终也会被回收成休眠态。
- **宿主侧改动需重启宿主**：见「开发注意」——这是 DSH 装载器的模块代机制，不是本项目的问题。
- **无 headful 回退**：`headless: false` 会开真窗口，但本机是 Wayland 会话，需要自行验证。
- **键盘覆盖有限**：普通可打印字符走 `Input.insertText`，命名键走 `Input.dispatchKeyEvent`；
  组合键（Ctrl/Cmd 系）暂未转发。中文 IME 需 M2 处理。
- **截图不是图片块**：`screenshot` 目前只回文字与 base64 长度，模型看不到图。
- **面板断线不自愈重连**：SSE 断了要重新打开 tab（M2 加自动重连与退避）。
- **共享 profile 的语义**：与 ego-browser 一样，Chrome 运行期 cookie 只在优雅退出时落盘，
  强杀重启需要重新登录。

## 许可与来源

- 本项目自身代码：MIT。
- `vendor/chrome-linux/`：来自用户提供的 `chrome-linux.zip`（Chromium 157.0.8079.0 Linux
  构建），仅作为**运行时基座**随项目分发，不随本仓库版本管理（见 `.gitignore`）。再分发前请
  自行核对该构建的许可与源码获取信息。

## 19. 子框架导航不得改写页面 URL（实测于 Bing）

`Page.frameNavigated` 与两个 loading 事件**对每个 frame 都触发**。最初的实现直接采信了事件里的 URL：

```js
return this.#client.on('Page.frameNavigated', (params) => {
  if (params?.frame?.url) listener(params.frame.url);   // 任何 frame
}, sessionId);
```

Bing 搜索结果页内嵌一个身份 iframe，它会跳到 `https://www.bing.com/identity/idtokenv2`。
于是 **`status.url`、面板地址栏、工具状态行全部显示成那个 token 端点**，而屏幕上明明是搜索结果页——
用户看到的就是"这个网站打不开"。

修法（Chromium 后端）：以 `frame.parentId === undefined` 判定主框架并记住其 id（`Page.getFrameTree` 初始化），
loading 事件也按该 id 过滤，避免子框架让加载状态抖动。
（BiDi 之所以没这个病，是因为它的 `navigationStarted` / `load` 按 context 投递，只订阅顶层就天然隔离——
那是被移除的第二个后端留下的一条经验，记在这里以免将来重蹈。）

回归测试：`scripts/smoke-url.mjs`（本地自建同形状页面，两引擎都要过，不依赖第三方站点）。
