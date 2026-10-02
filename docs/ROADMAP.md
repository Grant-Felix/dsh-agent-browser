# 路线图

每个阶段都以「可验证」为最小单位推进（小步快跑、每步有验证命令）。

---

## ⏭ 冷启动复验（2026-10-02 第一次重启的结果 + 待办）

第一次重启的收获（都是真实冷启动才能暴露的事实）：

- ✅ **工具侧活的**：子代理实调 `agent_browser` 7 次（status/pages/open/open+newPage/close/restore/sweep）全通，
  新描述（parking + 两个空闲超时）已在线。
- ❌ **面板路由 401**：`/api/agent-browser/*` 落到连接层的 `/api` 通道。
  根因 = `apply` 时 `ctx.get('webServer')` 早于 webServer 激活，返回 undefined，路由被静默跳过。
  **已修**：改成 `ctx.inject(['webServer'], (wctx) => wctx.effect(() => registerRoutes(wctx.webServer, browser)))`。
- 顺手修掉子代理发现的两个真缺陷（已加回归断言）：
  `close` 报错页 key（报了活动页 p2 而不是被收的 p1）、`open newPage` 返回陈旧的 about:blank。
- 顺带确定实例拓扑：**3081 是昨天启动的旧实例**（插件是热加载进去的，webServer 早已就绪所以它的路由是好的），
  **3080 是今天重启的新实例**（暴露 bug）。判断当前实例：`env | grep DSH_WEB_URL`。

下次冷启动后照做：

```sh
# 1. 路由是否注册（修复的验收点）
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3080/api/agent-browser/status   # 期望 200

# 2. 生命周期命令
curl -s -X POST http://127.0.0.1:3080/api/agent-browser/command -H 'content-type: application/json' \
  -d '{"action":"open","url":"https://example.com/"}'
curl -s -X POST http://127.0.0.1:3080/api/agent-browser/command -H 'content-type: application/json' \
  -d '{"action":"close","page":"p1"}' | grep -o '"closed":{[^}]*}'   # 期望 key=p1

# 3. 面板休眠态：刷新 GUI → 点「收页」→ 应转休眠占位（记忆列表 + 恢复按钮），不留旧帧
```

回填 `README.md` 状态表两行（`冷启动时面板路由注册`、`面板休眠态`）并把本节收缩成一行结论。

---

## M1 — 打通「看得见 + 叫得动」（已完成）

目标：一个自管的 Chrome-Linux 浏览器，agent 用工具驱动它，人在右侧栏看到同一画面并能接管。

- [x] 运行时：冷启动 / CDP 会话 / 导航 / 读页 / 求值 / 截图 / 停止
- [x] 推流：`Page.startScreencast` → SSE → 面板 `<img>`，限帧与最新帧优先
- [x] 输入回传：归一化点击 / 拖动 / 滚轮 / 键盘
- [x] HTTP 面：`/status`、`/stream`、`/command`（含同源校验）
- [x] 工具：`agent_browser`（status/open/read/eval/back/forward/reload/screenshot/stop）
- [x] 面板：右侧栏 tab 类型 + guide 入口 + 地址栏/导航/状态灯 + 空闲时的启动引导
- [x] 安装到 web profile 并激活；工具有真实调用记录
- [x] 面板视觉与交互的人眼确认（刷新页面后右侧栏出现 tab，画面为 example.com 实时页）

验证命令：

```sh
HOME=$PWD/.dev/home node scripts/smoke-runtime.mjs https://example.com/
HOME=$PWD/.dev/home node scripts/smoke-routes.mjs
curl -s http://127.0.0.1:3080/api/agent-browser/status
```

## M2 — 把「用起来」的毛刺磨掉

**生命周期与惰性回收（已做，2026-10-02）**

- [x] 页面注册表落盘（`pages.json`，原子写、容错读）
- [x] 多页模型（key/URL/序号寻址，活动页切换与推流跟随）
- [x] 用完即收的显式钩子（`close` / 面板「收页」）
- [x] 两级自动回收（页面 3h、浏览器 6h，均可配；`sweep` 可手动触发）
- [x] 存活页上限（默认 8，按最久未用收，不动活动页）
- [x] 按需恢复（冷启动自动还原上次活动页；实测整段 267 ms）
- [x] 量化脚本（每页 245 MB、关页 ~20 s 才回收、重开 32 ms）
- [ ] 面板休眠态的 GUI 确认（代码就绪，待宿主重启后看）

**视口：实时跟随，不假定屏幕尺寸（2026-10-02，用户两轮反馈）**

- [x] 第一版改竖屏 900×1600 → **被用户否掉**：不同人屏幕不同，侧边栏宽度还是随时拖出来的，
      任何写死尺寸都是错假设
- [x] 改为 **AUTO 默认**（`viewportWidth/Height = 0` 表示不覆盖，页用引擎自己的视口）
- [x] 面板**实时跟随**：`ResizeObserver` + `window.resize` + **DPR 变化**（`matchMedia`），
      150ms 合帧、首次立即上报、上报值 `rect × devicePixelRatio`
- [x] 宿主侧**最新覆盖式合帧**：拖拽来的一串尺寸不排队，N 个事件最多两次 CDP 施加
- [x] 尺寸来源链：帧元数据 → 页面自报 `innerWidth/innerHeight` → 配置固定值；都没有则**明确报错**
- [x] `status()` 三值分离：`viewport`(+`source`) / `pageViewport` / `frameViewport`
- [x] 断言 28 项全绿（含 AUTO 不覆盖、拖拽合帧、最新尺寸胜出、流随之收敛）
- [x] 端到端：面板推上来 1147×1401，`viewport == frameViewport`
- [x] **真机拖拽轨迹**（`scripts/watch-viewport.mjs`）：用户拖分隔条，`viewport` 连续变化
      1127→…→903→920→…→1007，`frame` 慢一次绘制跟随 —— 实时跟随成立
- [x] 拖拽轨迹发现的缺陷已修：`pageViewport`（页面自报尺寸）不因 resize 刷新 → 稳定后重读（第 29 项断言）
- [ ] 该修复待下次冷启动生效（不影响拖拽跟随本身，只影响 `pageViewport` 读数与指针兜底）

## M5 — Firefox 原生支持（WebDriver BiDi）· 已交付，随后**整体移除**

当时确实做完了：独立后端（`src/backends/firefox.js`）、BiDi 客户端（`src/bidi.js`）、
轮询帧、私有区码点命名键、`smoke-firefox.mjs` 18 条断言。**后来按项目决定把它整体删掉**：
两个引擎 = 两套协议 + 两套 profile 布局 + 两套坑，维护成本翻倍而能力没有翻倍。
要再做，应当作为**独立项目**——接缝（`#io`）与协议无关传输层（`src/remote.js`）都还在。

- [x] 后端接缝 `#io`：协议无关的运行时 + 人手运动模型
- [x] `src/remote.js`：协议无关的 WebSocket 传输（原 `cdp.js`）
- [x] Firefox 后端与 BiDi 客户端，18 条断言全过
- [x] 修掉的实测差异：命名键码点、轮询帧尺寸、有头新建页 resize 挂死
- [x] **移除**：`src/backends/firefox.js`、`src/bidi.js`、`smoke-firefox.mjs`、`probe-firefox-protocol.mjs`、
      `vendor-firefox.sh`、`browser: 'firefox'`、`firefoxPath`、`hideWebdriver`、Firefox cookie 导入、跨引擎互斥

## M6 — 搜索引擎预配置与自主选择（已完成，2026-10-02）

- [x] 预配置 10 个引擎模板 + `searchEngines` 自定义 + `searchEngine` 可钉死
- [x] 真实探测：专用页面顺序导航，读 Performance API + 出站链接数，排速度与内容质量
- [x] 拦截识别三重视角：正文 + **标题**（Brave 标题即 Captcha）+ URL（Google `/sorry/`、百度 `wappass`）
- [x] 探测页直播给面板看，结束后自动关掉并把活动页还给原页
- [x] 选择落盘 `search.json`（选择 + 上次探测 + 最近搜索 + TTL）
- [x] 工具 `search` / `engines` / `probe`；面板地址栏：网址走 open、其余走 search
- [x] 搜索后再验证结果，被拦自动换下一个引擎，全被拦如实报告
- [x] `scripts/smoke-search.mjs` 对真实网络验证：4 引擎 2.2s 排完、拦截全部识别、选择落盘
- [x] 顺带修掉三个真 bug（load 监听竞态、新建页 readyState 假"已加载"、`searchEngine` 配置字段丢失）
- [ ] 冷启动后在真宿主里用一次 `search`（需下次重启加载新代码）

## M7 — 控制面与"类人"（2026-10-02，按用户设计指令）

用户指令：不要用 CDP / WebDriver BiDi 作为控制通道，改用扩展 API（`chrome.scripting` 派发事件 +
`tabs.captureVisibleTab` 取画面）实现类人控制。**先量后改**的结果见 [ARCHITECTURE.md](ARCHITECTURE.md) §13。

**已完成（零成本、可测收益最大的一层）**

- [x] 对照实验脚本 `scripts/measure-detectability.mjs`（环境信号 + 检测页逐行判读）
- [x] 实测结论：无头 4/58 失败、有头 **0/58**，且失败项全是无头痕迹；CDP 相关行两种模式都通过
- [x] `headless: 'auto'`：有 `DISPLAY`/`WAYLAND_DISPLAY` 就有头，否则无头（默认生效）
- [x] **人机验证兜底**：`status().humanCheck` + 面板提示条 + 工具 `⚠` 文案；断言覆盖识别与清除
- [x] 后端接缝（`#io`）抽出：Chromium/CDP 是第一个实现，扩展控制是预留的第三个实现（M5 的 BiDi 是第二个）

**决策（2026-10-02，基于实测）**：现代风控（reCAPTCHA v3 = 0.9、Turnstile 出 token、Cloudflare 基准页 1s 过）
在**当前 CDP 控制下已经通过**，有无头/有头都一样；且 CDP 输入是可信事件而扩展派发的是不可信事件。
所以**默认保留 CDP**，扩展通道降级为"遇到专门探测 CDP 的站点再启用"的备选，不投入默认路径。

**已完成的增益**：`headless: 'auto'`（有显示器即有头）、`humanizeInput`（曲线轨迹/按下停留/逐字打字/滚轮分档）、
人工兜底（`humanCheck` + 面板提示条 + 工具 `⚠`）。

**已完成（2026-10-02 第二批）**

- [x] **agent 工具获得"动手"能力**：`click`/`move`/`drag`/`scroll`/`type`/`key`，schema 28 个参数，
      `scripts/smoke-tools.mjs` 18 条断言（含"通过工具拖动滑块 → value=81"）
- [x] **人手运动模型**：最小抖动速度剖面 + Fitts 时长 + 侧向弧线 + 可控抖动 + 过冲回补
- [x] 实测报告：路径效率 1.032、曲率 29px、22 次方向反转、抖动 2.51→7.01px（`scripts/measure-pointer.mjs`）
- [x] 原子 `drag` 动作（运行时 + 工具），`down`/`up` 供面板使用

**OS 级"屏幕操控"的实测结论（2026-10-02）**

- `xdotool` / `ydotool` 本机都已安装，但：
  - Chrome 跑的是**原生 Wayland 客户端**（X 里只有 mutter 守卫窗口，`xdotool search` 找不到它），
    所以 XTEST 的指针够不着它（试了 `--ozone-platform=x11`，仍未生成 X 窗口）；
  - `ydotool` 需要 `ydotoold` 守护进程（`/run/user/1000/.ydotool_socket` 不存在），它走 uinput，
    能驱动任何应用（包括原生 Wayland）。要在本机启用需要你执行一次系统级操作。
- 因此：**agent 的"模拟屏幕操控"目前走 CDP 输入**（可信事件，实测通过率已达标）；
  OS 级通道作为可选实现，一旦 `ydotoold` 起来即可接入（探测脚本 `scripts/probe-os-input.mjs` 已就绪）。

**待做（备选，非默认）**

- [ ] 扩展控制通道 `src/backends/extension.js`：
      MV3 扩展 + 本地回环桥（复用 `ctx.webServer`，不带 WebSocket 服务端依赖）、
      token 写入扩展目录完成信任边界、`chrome.tabs`/`chrome.scripting`/`captureVisibleTab` 三件套
- [ ] 启动不再传 `--remote-debugging-port`（去掉端口与协议痕迹），改为 `--load-extension=<dir>`
- [ ] 指纹一致性（UA 与 platform、screen 与 window、WebGL 真实性）与行为自然化（贝塞尔鼠标轨迹、打字节奏）
- [ ] 对照复测：扩展通道 vs 有头 CDP，在现代风控页（Turnstile / reCAPTCHA v3）上比得分
- [ ] Firefox 侧扩展安装：profile 预置 + `xpinstall.signatures.required=false`

**已明确不做的**：不解验证码、不接第三方打码服务（合规灰色地带；且本项目已选择"交给人"这条确定有效的路径）。

## M8 — 1 级「基本好用」（2026-10-02 · 已完成）

判定标准：**不做就没法真正拿去干活**（核心能力缺失或可靠性有洞）。四项全部完成并验证：

- [x] **截图回给模型（图片块）**：`action=screenshot` 的字节交给 attachment 服务，返回 `[{text},{image}]`，
      `noImage=true` 只回字节数；无 attachment 服务时如实降级。`smoke-tools` 断言渲染出 image 块
- [x] **SSE 自动重连 + 面板自愈**：指数退避重连、重连后重拉 status、断线时状态点脉冲提示；
      服务端 close 时清理监听。`smoke-routes` 断言重连后仍收到帧（`{"status":1,"frame":4}`）——
      **面板上的观感仍需你重启后过目**
- [x] **下载捕获（Chromium）**：`Browser.setDownloadBehavior` + 下载事件，文件真落盘、路径回传；
      `smoke-downloads` 用本地服务器断言**内容一致**且**点链接下载**同样成立；Firefox 无此命令，如实报 `null`
- [x] **Firefox `navigator.webdriver` 覆盖**：实测 4 种 pref 全无效（ARCHITECTURE §16），改用 BiDi
      `script.addPreloadScript` 重定义 getter；差分断言证明是覆盖在起作用（关掉即回 `true`）
- [ ] **收尾验证（需一次冷启动）**：面板休眠态、`search` 真宿主一用、重连观感、图片块在会话里的实际呈现

## M3 — 隔离与真实工作流

- [ ] 每会话 / 每任务空间一个浏览器实例（现在全局单例），面板按会话绑定自己的实例
- [x] **登录态导入（Chromium 系）已完成 2026-10-02**：从真实 profile（本机 Helium 527 条）按域导入，
      零依赖（`node:sqlite` + `node:crypto`），`v11` 解密用域名哈希自证（6/6），工具默认 `dryRun`，
      端到端验证到 `meta[user-login]=Grant-Felix` 且重启存活。见 [ARCHITECTURE.md](ARCHITECTURE.md) §15
- [ ] Firefox 侧导入：BiDi `storage.setCookies` 在该构建**未实现**（实测），需在 Firefox 关闭时写 `cookies.sqlite`
- [ ] 历史轨迹抽屉（按时间回看访问过的页面）
- [ ] 有头模式回退与验证（Wayland 下开真窗口给用户直接操作）
- [ ] 任务空间沙盒（内存 profile 与磁盘 profile 双模）

## M4 — 基座升级路径（为源码级补丁留的位置）

- [ ] `chromePath` 之外的「基座描述」配置：把某个打过补丁的 Chromium 构建连同其能力声明一起描述
- [ ] 能力协商：面板/工具按基座能力降级（例如缺 screencast 时退回轮询截图）
- [ ] 基座构建脚本与产物校验（版本、sha256、来源记录）
- [ ] 与上游 DSH 右侧栏契约的版本适配层（`sidebar.right.pane.tab` 契约变化时的兼容策略）
