/**
 * Client half: the "Agent 浏览器" tab in DSH's right Sidebar.
 *
 * The panel is a page-type tab in the host's own right-Sidebar registry, so it
 * inherits the column's docking, floating, per-session layout and theme tokens.
 * Its body streams frames from the host over SSE and sends pointer/keyboard
 * input back through the same command route the agent tool uses.
 */
window.__ModuleLoader__.load({
  id: 'dsh-agent-browser',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;

    const NS = 'agent-browser';
    const ROUTE = '/api/agent-browser';
    /** The tab type id; also the key its body registers under. */
    const TYPE_ID = 'dsh-agent-browser';
    const TYPE_KIND = 'agent-browser';

    const zh = {
      'tab.title': 'Agent 浏览器',
      'guide.title': 'Agent 浏览器',
      'guide.description': '观看 agent 正在使用的真浏览器，并可随时接管点击与输入',
      'status.running': '运行中',
      'status.starting': '启动中',
      'status.stopped': '未启动',
      'status.dormant': '已休眠',
      'mode.sidebarHeaded': '有头（侧边栏）',
      'status.runningNoPages': '运行中（没有打开的页面）',
      'hint.noPages': '浏览器在运行，但一页都没开。点下面的「新建标签页」开一个。',
      'pages.heading': '已休眠的页面（{n}）',
      'pages.more': '…以及另外 {n} 个已休眠页面',
      'chip.parked': '已休眠',
      'status.failed': '启动失败',
      'action.start': '启动浏览器',
      'action.stop': '停止浏览器',
      'action.park': '休眠此页',
      'action.newTab': '新建标签页',
      'action.newTab.hint': '开一个新标签页（先把当前页留着）；在上面地址栏输入后按 Alt+回车 也可新标签打开',
      'action.restore': '唤醒',
      'action.park.short': '休眠',
      'action.wake.one': '唤醒这一页',
      'action.park.one.hint': '单独休眠这一页：关掉它但记住网址',
      'action.wakeRecent': '唤醒最近一页',
      'menu.close': '关闭',
      'menu.close.hint': '关闭这个标签页，不保留网址（与休眠不同）',
      'action.back': '后退',
      'action.back.hint': '回到上一页',
      'action.forward.hint': '前进一页',
      'action.reload.hint': '重新加载当前页',
      'action.park.hint': '关闭当前页但记住网址，随时可以唤醒',
      'action.stop.hint': '关闭整个浏览器；页面网址留在硬盘上，下次调用自动恢复',
      'action.forward': '前进',
      'action.reload': '刷新',
      'address.placeholder': '输入网址或搜索词后回车',
      'hint.failed': '浏览器启动失败。',
      'hint.idle': '浏览器尚未启动。让 agent 调用 agent_browser，或点下面的「启动浏览器」。',
      'hint.dormant': '浏览器已休眠（回收内存）。这些页面会在下次调用或点「唤醒」时自动回来（约几十毫秒 + 一次页面加载）。',
      'foot.ready': '点击画面即可操作页面；画面获得焦点后可直接输入。',
      'foot.connecting': '正在连接画面…',
      'foot.remembered': '已休眠 · {n} 个页面',
      'foot.reconnecting': '连接断开 — 正在自动重连…',
      'human.title': '需要你完成人机验证',
      'human.body': '这个页面是验证/拦截页，不是内容。请在上方画面里完成验证（点画面即可操作），完成后 agent 可以继续。',
      'foot.pages': '{n} 个页面',
      'foot.pagesWithDormant': '{n} 个页面 · {m} 个已休眠',
      'foot.noPages': '运行中 · 没有打开的页面',
      'ball.tabs': '{n} 个标签页',
    };
    const en = {
      'tab.title': 'Agent Browser',
      'guide.title': 'Agent Browser',
      'guide.description': 'Watch — and take over — the real browser the agent is using',
      'status.running': 'running',
      'status.starting': 'starting',
      'status.stopped': 'Not running',
      'status.dormant': 'Dormant',
      'mode.sidebarHeaded': 'headed (sidebar)',
      'status.runningNoPages': 'Running — no pages open',
      'hint.noPages': 'The browser is up but has no page open — open a new tab below.',
      'pages.heading': 'Dormant pages ({n})',
      'pages.more': '…and {n} more dormant page(s)',
      'chip.parked': 'dormant',
      'status.failed': 'failed',
      'action.start': 'Start browser',
      'action.stop': 'Stop browser',
      'action.park': 'Park this page',
      'action.newTab': 'New tab',
      'action.newTab.hint': 'Open another tab, keeping this one; Alt+Enter in the address bar does the same for a typed URL',
      'action.restore': 'Wake',
      'action.park.short': 'Sleep',
      'action.wake.one': 'Wake this page',
      'action.park.one.hint': 'Sleep just this page: close it but remember its URL',
      'action.wakeRecent': 'Wake the most recent page',
      'menu.close': 'Close',
      'menu.close.hint': 'Close this tab; its URL is not kept (unlike sleeping)',
      'action.back': 'Back',
      'action.back.hint': 'Go back one page',
      'action.forward.hint': 'Go forward one page',
      'action.reload.hint': 'Reload the current page',
      'action.park.hint': 'Close this page but remember its URL — wake it any time',
      'action.stop.hint': 'Close the whole browser; page URLs stay on disk and come back on the next call',
      'action.forward': 'Forward',
      'action.reload': 'Reload',
      'address.placeholder': 'URL or search terms, then Enter',
      'hint.failed': 'The browser failed to start.',
      'hint.idle': 'The browser is not running. Ask the agent to call agent_browser, or press Start.',
      'hint.dormant': 'The browser is dormant (memory reclaimed). These pages come back on the next call or when you press Wake (~tens of ms plus one page load).',
      'foot.ready': 'Click the picture to operate the page; focus it to type.',
      'foot.connecting': 'Connecting to the live picture…',
      'foot.remembered': 'dormant · {n} page(s)',
      'foot.reconnecting': 'Connection lost — reconnecting automatically…',
      'human.title': 'Human verification needed',
      'human.body': 'This page is a verification wall, not content. Complete it in the picture above (click it to operate), then the agent can continue.',
      'foot.pages': '{n} page(s)',
      'foot.pagesWithDormant': '{n} page(s) · {m} dormant',
      'foot.noPages': 'running · no pages open',
      'ball.tabs': '{n} tab(s)',
    };

    const CSS = `
.dshab-root { display:flex; flex-direction:column; height:100%; min-height:0; background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary); font-size:13px; }
.dshab-bar { display:flex; flex-wrap:wrap; align-items:center; gap:4px; padding:6px; border-bottom:1px solid var(--dsw-alias-border-l1); flex:0 0 auto; }
.dshab-btn { display:inline-flex; align-items:center; justify-content:center; height:26px; padding:0 9px; border:1px solid var(--dsw-alias-border-l1); border-radius:6px; background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-primary); font:inherit; font-size:11px; white-space:nowrap; cursor:pointer; }
.dshab-btn:hover:not(:disabled) { background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-primary); }
.dshab-btn:disabled { opacity:.4; cursor:default; }
.dshab-btn:focus-visible { outline:2px solid var(--dsw-alias-brand-primary); outline-offset:1px; }
.dshab-btn svg { width:14px; height:14px; display:block; }
.dshab-input { flex:1 1 120px; min-width:0; height:26px; padding:0 8px; border:1px solid var(--dsw-alias-border-l1); border-radius:6px; background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-primary); font:inherit; font-size:12px; }
.dshab-input:focus { outline:none; border-color:var(--dsw-alias-brand-primary); }
.dshab-dot { width:8px; height:8px; border-radius:50%; flex:0 0 auto; margin-left:4px; background:var(--dsw-alias-state-idle-primary); }
.dshab-dot[data-state="running"] { background:var(--dsw-alias-state-success-primary); }
.dshab-dot[data-state="starting"] { background:var(--dsw-alias-state-warn-primary); }
.dshab-dot[data-state="failed"] { background:var(--dsw-alias-state-error-primary); }
.dshab-stage { position:relative; flex:1 1 auto; min-height:0; overflow:auto; background:var(--dsw-alias-bg-layer-1); display:flex; align-items:flex-start; justify-content:center; }
.dshab-shot { width:100%; height:auto; display:block; cursor:crosshair; }
.dshab-shot:focus-visible { outline:2px solid var(--dsw-alias-brand-primary); outline-offset:-2px; }
.dshab-placeholder { margin:auto; padding:24px 16px; max-width:320px; text-align:center; color:var(--dsw-alias-label-secondary); line-height:1.6; }
.dshab-state { font-size:13px; font-weight:600; color:var(--dsw-alias-label-primary); }
.dshab-hint { margin-top:4px; }
.dshab-pages { display:flex; flex-direction:column; gap:4px; margin-top:12px; text-align:left; }
.dshab-pages-head { margin-bottom:2px; color:var(--dsw-alias-label-secondary); font-size:11px; }
.dshab-tab { display:inline-flex; align-items:center; gap:3px; flex:0 0 auto; }
/* Awake tabs wear the product's blue-violet accent; dormant ones go grey.
   The accent is the DeepSeek brand alias (--dsw-static-deepseek-400/500 ==
   #7aaaff/#4176e6), NOT --dsw-alias-brand-primary, which resolves to a neutral
   bluish ink (#f9fafb light / #0f1115 dark) and would show no violet at all. */
/* Awake tabs wear the product's blue-violet accent; dormant ones go grey
   (grayscale + dimmed). The accent is the DeepSeek brand alias
   (--dsw-static-deepseek-400/500 == #7aaaff / #4176e6), NOT
   --dsw-alias-brand-primary, which resolves to a neutral bluish ink
   (#f9fafb light / #0f1115 dark) and would show no violet at all. */
.dshab-chip[data-state="parked"] { color:var(--dsw-alias-label-secondary) !important; filter:grayscale(1); opacity:.72; }
.dshab-chip[data-state="parked"]:hover:not(:disabled) { opacity:.9; }
.dshab-menu { position:fixed; z-index:20; width:172px; box-sizing:border-box; padding:4px; display:flex; flex-direction:column; border:1px solid var(--dsw-alias-border-l2); border-radius:8px; background:var(--dsw-alias-bg-overlay); box-shadow:0 6px 18px rgba(0,0,0,.28); }
.dshab-menu button { display:block; width:100%; padding:5px 8px; border:none; border-radius:5px; background:transparent; color:var(--dsw-alias-label-primary); font:inherit; font-size:11px; text-align:left; cursor:pointer; }
.dshab-menu button:hover:not(:disabled) { background:var(--dsw-alias-bg-layer-2); }
.dshab-menu button:disabled { opacity:.4; cursor:default; }
.dshab-menu-danger { color:var(--dsw-alias-state-error-primary) !important; }
.dshab-page-action { float:right; color:var(--dsw-alias-label-secondary); }
.dshab-page { padding:4px 6px; border:1px solid var(--dsw-alias-border-l1); border-radius:6px; font-size:11px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dshab-cta { margin-top:12px; display:inline-flex; align-items:center; gap:6px; height:28px; padding:0 12px; border:1px solid var(--dsw-alias-border-l2); border-radius:6px; background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-primary); font:inherit; cursor:pointer; }
.dshab-tabs { flex:0 0 auto; display:flex; align-items:center; gap:6px; padding:4px 8px; border-top:1px solid var(--dsw-alias-border-l1); min-width:0; }
.dshab-count { flex:0 0 auto; display:inline-flex; align-items:center; justify-content:center; min-width:20px; height:20px; padding:0 6px; border-radius:10px; background:var(--dsw-alias-bg-layer-2); border:1px solid var(--dsw-alias-border-l1); color:var(--dsw-alias-label-secondary); font-size:11px; font-weight:600; }
.dshab-count[data-state="running"] { color:var(--dsw-alias-state-success-primary); border-color:var(--dsw-alias-state-success-primary); }
.dshab-count[data-state="reconnecting"] { color:var(--dsw-alias-state-warn-primary); border-color:var(--dsw-alias-state-warn-primary); animation:dshab-pulse 1.2s ease-in-out infinite; }
.dshab-count[data-state="failed"] { color:var(--dsw-alias-state-error-primary); border-color:var(--dsw-alias-state-error-primary); }
.dshab-chips { flex:1 1 auto; display:flex; gap:4px; overflow-x:auto; overflow-y:hidden; scrollbar-width:thin; min-width:0; }
.dshab-chip { flex:0 1 auto; max-width:150px; height:22px; padding:0 8px; border:1px solid var(--dsw-alias-border-l1); border-radius:11px; background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-state-business-primary); font:inherit; font-size:11px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; cursor:pointer; }
.dshab-chip b { color:var(--dsw-alias-label-primary); font-weight:600; }
.dshab-chip[data-state="parked"] { border-style:dashed; }
.dshab-chip[data-active="true"] { border-color:var(--dsw-alias-state-business-primary); color:var(--dsw-alias-state-business-primary); font-weight:600; }
.dshab-chip-new { border-style:solid; border-color:var(--dsw-alias-border-l2); color:var(--dsw-alias-label-primary); font-weight:600; }
.dshab-chip:disabled { cursor:default; }
.dshab-foot { flex:0 0 auto; padding:5px 8px; border-top:1px solid var(--dsw-alias-border-l1); color:var(--dsw-alias-label-secondary); font-size:11px; line-height:1.5; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dshab-dot[data-state="reconnecting"] { background:var(--dsw-alias-state-warn-primary); animation:dshab-pulse 1.2s ease-in-out infinite; }
@keyframes dshab-pulse { 0%,100% { opacity:1 } 50% { opacity:.35 } }
.dshab-human { flex:0 0 auto; padding:7px 8px; border-bottom:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-state-warn-primary); font-size:11px; line-height:1.5; }
.dshab-human b { display:block; margin-bottom:2px; font-size:12px; }
.dshab-error { flex:0 0 auto; padding:6px 8px; background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-state-error-primary); font-size:11px; line-height:1.5; }
`;

    /** The live translator, rebound whenever the locale service re-binds. */
    let translate = (key) => key;

    /** The panel's dictionary lookup, with a readable fallback. */
    function lookup(key, fallback) {
      try {
        const value = translate(key);
        return typeof value === 'string' && value !== key ? value : fallback;
      } catch {
        return fallback;
      }
    }

    /** Dictionary lookup with `{name}` placeholders substituted. */
    function format(key, fallback, vars) {
      let text = lookup(key, fallback);
      for (const [name, value] of Object.entries(vars)) text = text.split(`{${name}}`).join(String(value));
      return text;
    }

    /**
     * Is this something to open, or something to search for?
     *
     * A scheme, a bare dotted host, localhost or an IP is a URL; anything with a
     * space, or plain words, goes to the search engines — which is what makes
     * "just type what you want" work without knowing an engine URL.
     */
    function looksLikeUrl(text) {
      const value = String(text ?? '').trim();
      if (value === '') return false;
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return true;
      if (/^(about|data|file|blob|chrome|view-source):/i.test(value)) return true;
      if (/\s/.test(value)) return false;
      if (/^localhost(:\d+)?(\/|$)/i.test(value)) return true;
      if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/|$)/.test(value)) return true;
      return /^[^\s/?#]+\.[a-z]{2,}(:\d+)?([/?#]|$)/i.test(value);
    }

    /** POST one command; a failure rejects with the host's reason. */
    async function command(body) {
      const response = await fetch(`${ROUTE}/command`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.ok === false) throw new Error(payload.error ?? `HTTP ${response.status}`);
      return payload;
    }

    /** One panel instance: live status plus the frame stream. */
    function Panel() {
      const [status, setStatus] = React.useState(null);
      const [address, setAddress] = React.useState('');
      const [error, setError] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const [connected, setConnected] = React.useState(false);
      const [reconnecting, setReconnecting] = React.useState(false);
      /** `{ x, y, page }` while a tab's right-click menu is open. */
      const [menu, setMenu] = React.useState(null);
      const imgRef = React.useRef(null);
      const stageRef = React.useRef(null);
      const editingRef = React.useRef(false);
      const draggingRef = React.useRef(false);

      React.useEffect(() => {
        if (menu === null) return undefined;
        const close = () => setMenu(null);
        const onKey = (event) => {
          if (event.key === 'Escape') setMenu(null);
        };
        window.addEventListener('click', close);
        window.addEventListener('contextmenu', close);
        window.addEventListener('keydown', onKey);
        return () => {
          window.removeEventListener('click', close);
          window.removeEventListener('contextmenu', close);
          window.removeEventListener('keydown', onKey);
        };
      }, [menu]);

      React.useEffect(() => {
        // The stream is a long-lived resource on a host that can restart under it
        // (a plugin reload drops it instantly). Without this loop the panel went
        // silently dead — the picture froze and nothing said why.
        let source = null;
        let closed = false;
        let attempt = 0;
        let retry = null;

        const merge = (event) => setStatus((previous) => ({ ...(previous ?? {}), ...JSON.parse(event.data) }));
        const onFrame = (event) => {
          const frame = JSON.parse(event.data);
          const image = imgRef.current;
          if (image) image.src = `data:image/jpeg;base64,${frame.data}`;
          setConnected(true);
        };
        /** Re-read the whole status, so a restarted host is picked up, not merged. */
        const resync = async () => {
          try {
            const response = await fetch(`${ROUTE}/status`, { cache: 'no-store' });
            if (response.ok) setStatus(await response.json());
          } catch {
            // Still unreachable; the next reconnect attempt will try again.
          }
        };

        const connect = () => {
          if (closed) return;
          source = new EventSource(`${ROUTE}/stream`);
          source.addEventListener('status', merge);
          source.addEventListener('meta', merge);
          source.addEventListener('frame', onFrame);
          source.onopen = () => {
            const reconnected = attempt > 0;
            attempt = 0;
            setConnected(true);
            setReconnecting(false);
            // A fresh status replaces a stale one (the host may have restarted and
            // forgotten everything the panel is still showing).
            void resync();
            if (reconnected) setError('');
          };
          source.onerror = () => {
            setConnected(false);
            setReconnecting(true);
            try {
              source.close();
            } catch {
              // Already gone.
            }
            const delay = Math.min(15_000, 800 * 2 ** attempt);
            attempt += 1;
            clearTimeout(retry);
            retry = setTimeout(connect, delay);
          };
        };

        connect();
        return () => {
          closed = true;
          clearTimeout(retry);
          try {
            source?.close();
          } catch {
            // Already gone.
          }
        };
      }, []);

      React.useEffect(() => {
        if (!editingRef.current && typeof status?.url === 'string' && status.url !== '') setAddress(status.url);
      }, [status?.url]);

      /**
     * The label a tab shows.
     *
     * Titles carry site furniture ("deepseek harness - 搜索") and the key prefix
     * ("p1") is noise for a human: what identifies a tab is what it is about, in a
     * couple of words. Falls back to the hostname when there is no title.
     */
    function shortLabel(page) {
      const title = String(page.title ?? '').trim();
      if (title !== '') {
        const head = title.split(/\s+[-–—|·]\s+/)[0].trim();
        const text = head.length >= 2 ? head : title;
        return text.length > 22 ? `${text.slice(0, 21)}…` : text;
      }
      try {
        return new URL(page.url).hostname.replace(/^www\./, '');
      } catch {
        return page.url || page.key;
      }
    }

    /** Menu geometry, used both to place it and to decide which way it opens. */
    const MENU_SIZE = { width: 172, height: 64 };
    const MENU_GAP = 2;

    /**
     * Place a menu so one of its corners meets the clicked element's corner.
     *
     * Anchoring to the POINTER put the menu wherever the click landed, which in a
     * wide tab is far from the tab's own corner. Anchoring to the tab's box and
     * flipping when there is no room keeps the menu visually attached to what it
     * belongs to — and since the tab strip is at the bottom of the panel, the menu
     * normally opens upwards from the tab's top edge.
     * @returns `{ left, top, placement }`.
     */
    function placeMenu(anchor, viewport) {
      const width = viewport?.width ?? 320;
      const height = viewport?.height ?? 720;
      const below = anchor.bottom + MENU_GAP;
      const opensDown = below + MENU_SIZE.height <= height - 6;
      const top = opensDown ? below : Math.max(6, anchor.top - MENU_SIZE.height - MENU_GAP);
      // Left edges line up; if that overflows, slide back so the right edges do.
      const left = Math.min(Math.max(6, anchor.left), Math.max(6, width - MENU_SIZE.width - 6));
      return { left: Math.round(left), top: Math.round(top), placement: opensDown ? 'below' : 'above' };
    }

    /** Open a tab's action menu against that tab. */
    const openMenu = (event, page) => {
      event.preventDefault();
      const rect = event.currentTarget?.getBoundingClientRect?.();
      const anchor = rect
        ? { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }
        : { left: event.clientX, top: event.clientY, right: event.clientX, bottom: event.clientY };
      setMenu({ anchor, page });
    };

    /** Normalized coordinates of a pointer event inside the picture. */
      const normalize = (event) => {
        const image = imgRef.current;
        if (!image) return null;
        const rect = image.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return null;
        const nx = (event.clientX - rect.left) / rect.width;
        const ny = (event.clientY - rect.top) / rect.height;
        if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return null;
        return { nx, ny };
      };

      const send = (input) => {
        void command({ action: 'input', input }).catch((failure) => setError(failure.message));
      };

      /** One line describing the browser, for the count ball's tooltip. */
      const statusSummary = () => {
        // One mode: headed, with this panel as the head. There is no headless mode.
        const mode = lookup('mode.sidebarHeaded', '有头（侧边栏）');
        const engine = status?.engine ? `${status.engine} ` : '';
        const title = status?.title ? ` · ${status.title}` : '';
        return `${engine}${mode} · ${lookup(`status.${status?.state ?? 'stopped'}`, status?.state ?? 'stopped')} · `;
      };

      const state = status?.state ?? 'stopped';
      const allPages = Array.isArray(status?.pages) ? status.pages : [];
      const remembered = allPages.filter((page) => page.state === 'parked');
      const liveCount = allPages.filter((page) => page.state === 'live').length;
      // The browser can be up while its page was parked (the "done with this
      // page" hook). A stale last frame must not pass for a live view.
      const showLive = state === 'running' && liveCount > 0;

      React.useEffect(() => {
        const stage = stageRef.current;
        if (!stage) return undefined;
        // React attaches wheel listeners passively; forward it to the page.
        const onWheel = (event) => {
          const point = normalize(event);
          if (!point) return;
          event.preventDefault();
          send({ action: 'scroll', ...point, deltaX: event.deltaX, deltaY: event.deltaY });
        };
        stage.addEventListener('wheel', onWheel, { passive: false });
        return () => stage.removeEventListener('wheel', onWheel);
      }, [state]);

      // Live-follow the panel's own box. No size is assumed anywhere: this
      // column's measured size IS the viewport, so dragging the Sidebar (or
      // moving the window to a display with another scale factor) re-sizes the
      // page continuously instead of only once per mount.
      React.useEffect(() => {
        const stage = stageRef.current;
        if (!stage) return undefined;
        let timer = null;
        let pushed = '';
        const push = () => {
          const rect = stage.getBoundingClientRect();
          // A collapsed or hidden stage reports a degenerate box; skipping it is
          // about "is this laid out", not about a preferred screen size.
          if (rect.width < 80 || rect.height < 80) return;
          const dpr = window.devicePixelRatio || 1;
          const width = Math.round(rect.width * dpr);
          const height = Math.round(rect.height * dpr);
          const key = `${width}x${height}`;
          if (key === pushed) return;
          pushed = key;
          void command({ action: 'viewport', width, height }).catch(() => {
            // The host may be mid-restart; the next resize retries.
          });
        };
        // A drag fires resize events continuously, so coalesce them — but a
        // settled size is never held back by more than one short window.
        const schedule = (immediate) => {
          if (timer) clearTimeout(timer);
          if (immediate) {
            push();
            return;
          }
          timer = setTimeout(push, 150);
        };
        const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => schedule(false)) : null;
        if (observer) observer.observe(stage);
        const onWindowResize = () => schedule(false);
        window.addEventListener('resize', onWindowResize);
        // A DPR change does not resize the element, so it needs its own watch:
        // the query encodes the current ratio, hence re-arming after each change.
        let dprQuery = null;
        const onDprChange = () => {
          schedule(false);
          watchDpr();
        };
        const watchDpr = () => {
          if (typeof window.matchMedia !== 'function') return;
          dprQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
          dprQuery.addEventListener?.('change', onDprChange, { once: true });
        };
        watchDpr();
        schedule(true);
        return () => {
          if (timer) clearTimeout(timer);
          observer?.disconnect();
          window.removeEventListener('resize', onWindowResize);
          dprQuery?.removeEventListener?.('change', onDprChange);
        };
      }, []);

      const run = (body) => {
        setBusy(true);
        setError('');
        return command(body)
          .then((payload) => {
            setStatus((previous) => ({ ...(previous ?? {}), ...payload }));
            return payload;
          })
          .catch((failure) => setError(failure.message))
          .finally(() => setBusy(false));
      };

      const onKeyDown = (event) => {
        if (event.key === 'F5') {
          event.preventDefault();
          void run({ action: 'reload' });
          return;
        }
        if (event.ctrlKey || event.metaKey || event.altKey) return;
        event.preventDefault();
        if (event.key.length === 1) send({ action: 'text', text: event.key });
        else send({ action: 'key', key: event.key });
      };

      /**
       * A toolbar button that says what it does.
       *
       * These were geometric SVG icons with only a tooltip. That fails exactly
       * where this panel is most useful — remote control from a phone, a
       * container-hosted session, anyone who does not already know the shapes —
       * so the label is the button.
       */
      const button = (label, title, action, disabled) =>
        h(
          'button',
          {
            type: 'button',
            className: 'dshab-btn',
            title,
            disabled: disabled || busy,
            onClick: () => void run({ action }),
          },
          label,
        );

      return h(
        'div',
        { className: 'dshab-root' },
        h('style', null, CSS),
        h(
          'div',
          { className: 'dshab-bar' },
          button(lookup('action.back', 'Back'), lookup('action.back.hint', 'Go back'), 'back', state !== 'running'),
          button(lookup('action.forward', 'Forward'), lookup('action.forward.hint', 'Go forward'), 'forward', state !== 'running'),
          button(lookup('action.reload', 'Reload'), lookup('action.reload.hint', 'Reload the page'), 'reload', state !== 'running'),
          h('input', {
            className: 'dshab-input',
            value: address,
            spellCheck: false,
            placeholder: lookup('address.placeholder', 'URL'),
            onChange: (event) => setAddress(event.target.value),
            onFocus: () => {
              editingRef.current = true;
            },
            onBlur: () => {
              editingRef.current = false;
            },
            onKeyDown: (event) => {
              if (event.key !== 'Enter') return;
              event.preventDefault();
              editingRef.current = false;
              const text = address.trim();
              if (text === '') return;
              // Browser convention: Enter navigates this tab, Alt/Ctrl/Cmd+Enter
              // opens the same thing in a NEW tab.
              const inNewTab = event.altKey || event.ctrlKey || event.metaKey;
              // Either: a URL opens, anything else is a search. Whoever typed it
              // never has to know which engine will serve the query.
              if (looksLikeUrl(text)) void run({ action: 'open', url: text, newPage: inNewTab });
              else if (inNewTab) void run({ action: 'open', url: `https://duckduckgo.com/?q=${encodeURIComponent(text)}`, newPage: true });
              else void run({ action: 'search', query: text });
            },
          }),
          state === 'running' && showLive
            ? button(lookup('action.park', 'Park this page'), lookup('action.park.hint', 'Close this page but remember its URL — wake it any time'), 'close', false)
            : null,
          state === 'running'
            ? button(lookup('action.stop', 'Stop browser'), lookup('action.stop.hint', 'Close the whole browser; pages stay remembered on disk'), 'stop', false)
            : null,
          h('span', {
            className: 'dshab-dot',
            'data-state': reconnecting ? 'reconnecting' : state,
            title: reconnecting ? lookup('foot.reconnecting', 'reconnecting') : lookup(`status.${state}`, state),
          }),
        ),
        status?.humanCheck?.detected
          ? h(
              'div',
              { className: 'dshab-human' },
              h('b', null, lookup('human.title', 'Human verification needed')),
              h('span', null, lookup('human.body', 'Complete the verification in the picture above.')),
            )
          : null,
        error !== '' ? h('div', { className: 'dshab-error' }, error) : null,
        h(
          'div',
          { className: 'dshab-stage', ref: stageRef },
          showLive
            ? h('img', {
                ref: imgRef,
                className: 'dshab-shot',
                alt: 'agent browser',
                tabIndex: 0,
                // The hint used to have a footer row of its own; the tab row is the
                // only bottom row now, so it rides the picture's tooltip.
                title: lookup('foot.ready', 'Click the picture to operate the page; focus it to type.'),
                // A real pointer sequence, not a click followed by motion: the
                // button stays held between down and up, which is what drags
                // (and slider CAPTCHAs) require.
                onMouseDown: (event) => {
                  const point = normalize(event);
                  if (point) {
                    draggingRef.current = true;
                    send({ action: 'down', ...point });
                  }
                },
                onMouseMove: (event) => {
                  if (!draggingRef.current && event.buttons !== 1) return;
                  const point = normalize(event);
                  if (point) send({ action: 'move', ...point });
                },
                onMouseUp: (event) => {
                  if (!draggingRef.current) return;
                  draggingRef.current = false;
                  const point = normalize(event);
                  if (point) send({ action: 'up', ...point });
                },
                onMouseLeave: () => {
                  // Never leave the remote button stuck down.
                  if (!draggingRef.current) return;
                  draggingRef.current = false;
                  send({ action: 'up' });
                },
                onKeyDown,
              })
            : h(
                'div',
                { className: 'dshab-placeholder' },
                // The state gets a NAME, not just a sentence: users looked for
                // "dormant" and found nothing, because the old copy never used the
                // word and the list of remembered pages had no heading at all.
                h(
                  'div',
                  { className: 'dshab-state' },
                  state === 'failed'
                    ? lookup('status.failed', 'Failed')
                    : state === 'running'
                      ? remembered.length > 0
                        ? lookup('status.dormant', 'Dormant')
                        : lookup('status.runningNoPages', 'Running — no pages open')
                      : state === 'starting'
                        ? lookup('status.starting', 'Starting')
                        : lookup('status.stopped', 'Not running'),
                ),
                h(
                  'div',
                  { className: 'dshab-hint' },
                  state === 'failed'
                    ? status?.failure || lookup('hint.failed', 'The browser failed to start.')
                    : state === 'running' && remembered.length === 0
                      ? lookup('hint.noPages', 'The browser is up but has no page open — open a new tab below.')
                      : remembered.length > 0 || state === 'running'
                        ? lookup('hint.dormant', 'The browser was reclaimed; remembered pages come back on the next call.')
                        : lookup('hint.idle', 'The browser is not running.'),
                ),
                remembered.length > 0
                  ? h(
                      'div',
                      { className: 'dshab-pages' },
                      h(
                        'div',
                        { className: 'dshab-pages-head' },
                        format('pages.heading', 'Remembered pages ({n})', { n: remembered.length }),
                      ),
                      remembered.slice(0, 8).map((page) =>
                        h(
                          // One row, one page: these used to be inert text, so the
                          // only way back was a single "Wake" that always took the
                          // most recent page. Now you wake the one you meant.
                          'button',
                          {
                            type: 'button',
                            className: 'dshab-page',
                            key: page.key,
                            title: `${page.url} — ${lookup('action.wake.one', 'Wake this page')}`,
                            disabled: busy,
                            onClick: () => void run({ action: 'restore', page: page.key }),
                          },
                          // Same rule as the tab strip: the key is for the API, not
                          // for the person reading the list.
                          shortLabel(page),
                          h('span', { className: 'dshab-page-action' }, lookup('action.restore', 'Wake')),
                        ),
                      ),
                      remembered.length > 8
                        ? h('div', { className: 'dshab-page' }, format('pages.more', '…and {n} more', { n: remembered.length - 8 }))
                        : null,
                    )
                  : null,
                state === 'starting'
                  ? null
                  : h(
                      'button',
                      {
                        type: 'button',
                        className: 'dshab-cta',
                        disabled: busy,
                        // Three different fixes for three different states: wake the
                        // dormant pages, open a tab when the browser is up but empty,
                        // or start it at all.
                        onClick: () =>
                          void run(
                            remembered.length > 0
                              ? { action: 'restore' }
                              : state === 'running'
                                ? { action: 'open', url: 'about:blank', newPage: true }
                                : { action: 'start' },
                          ),
                      },
                      remembered.length > 0
                        ? lookup('action.wakeRecent', 'Wake the most recent page')
                        : state === 'running'
                          ? lookup('action.newTab', 'New tab')
                          : lookup('action.start', 'Start browser'),
                    ),
              ),
        ),
        allPages.length > 0 || state === 'running'
          ? h(
              'div',
              { className: 'dshab-tabs' },
              // The count moved out of the footer and into this row: two stacked
              // bars for one idea ("which tabs are open, and how many") wasted the
              // narrow column this panel lives in.
              h(
                'span',
                {
                  className: 'dshab-count',
                  'data-state': reconnecting ? 'reconnecting' : state,
                  title: `${statusSummary()}${format('ball.tabs', '{n} tab(s)', { n: allPages.length })}`,
                },
                String(allPages.length),
              ),
              h(
                'div',
                { className: 'dshab-chips' },
                allPages.slice(0, 12).map((page) =>
                  h(
                    'span',
                    { className: 'dshab-tab', key: page.key, 'data-state': page.state },
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'dshab-chip',
                        'data-state': page.state,
                        'data-active': page.active ? 'true' : 'false',
                        title: `${page.url}${page.state === 'parked' ? ` — ${lookup('chip.parked', 'dormant')}` : ''}`,
                        disabled: busy,
                        // A left click both switches to the tab and opens its menu
                        // (close / sleep-wake). There is no lamp any more: the word
                        // in the menu says the state, and the colour shows it.
                        onClick: (event) => {
                          event.stopPropagation();
                          if (!page.active) void run({ action: 'activate', page: page.key });
                          openMenu(event, page);
                        },
                      },
                      shortLabel(page),
                    ),
                  ),
                ),
              ),
              // The tab strip is where tabs live, so the "open another one" control
              // belongs here. It was missing entirely: a user could only ever drive
              // the single active page.
              h(
                'button',
                {
                  type: 'button',
                  className: 'dshab-chip dshab-chip-new',
                  title: lookup('action.newTab.hint', 'Open a new tab (about:blank); type a URL above to load it'),
                  // NOT gated on state: opening a tab while the browser is dormant
                  // is exactly when a user wants it, and the host starts the
                  // browser on demand (`#requireRunning` ensures a start first).
                  disabled: busy || state === 'starting',
                  onClick: () => void run({ action: 'open', url: 'about:blank', newPage: true }),
                },
                `＋ ${lookup('action.newTab', 'New tab')}`,
              ),
            )
          : null,
        // The footer is now only for things the tab row cannot express: a lost
        // connection. The count, the state and the title all live in the ball's
        // tooltip, so an ordinary session shows a single bottom row.
        reconnecting
          ? h('div', { className: 'dshab-foot' }, lookup('foot.reconnecting', 'Connection lost — reconnecting automatically…'))
          : null,
        menu === null
          ? null
          : h(
              'div',
              // Two items, as asked: close, and one toggle whose word follows the
              // page's state. Switching tabs is a left click, so it needs no entry.
              {
                className: 'dshab-menu',
                'data-placement': placeMenu(menu.anchor, { width: window.innerWidth, height: window.innerHeight }).placement,
                style: (() => {
                  const placed = placeMenu(menu.anchor, { width: window.innerWidth, height: window.innerHeight });
                  return { left: `${placed.left}px`, top: `${placed.top}px` };
                })(),
              },
              h(
                'button',
                {
                  type: 'button',
                  className: 'dshab-menu-danger',
                  title: lookup('menu.close.hint', 'Close this tab; its URL is not kept (unlike sleeping)'),
                  onClick: () => {
                    setMenu(null);
                    void run({ action: 'forget', page: menu.page.key });
                  },
                },
                lookup('menu.close', 'Close'),
              ),
              h(
                'button',
                {
                  type: 'button',
                  title:
                    menu.page.state === 'live'
                      ? lookup('action.park.one.hint', 'Sleep this page: close it but remember its URL')
                      : lookup('action.wake.one', 'Wake this page'),
                  onClick: () => {
                    setMenu(null);
                    void run(
                      menu.page.state === 'live'
                        ? { action: 'close', page: menu.page.key }
                        : { action: 'restore', page: menu.page.key },
                    );
                  },
                },
                menu.page.state === 'live' ? lookup('action.park.short', '休眠') : lookup('action.restore', '唤醒'),
              ),
            ),
      );
    }

    const inject = ['slots', 'locale', 'sidebarRightTabs', 'sidebarRight'];

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-agent-browser: dictionaries');

      ctx.effect(() => {
        translate = ctx.locale.bind(NS);
        return () => {
          translate = (key) => key;
        };
      }, 'dsh-agent-browser: translator');

      ctx.effect(
        () =>
          ctx.sidebarRightTabs.register({
            id: TYPE_ID,
            kind: TYPE_KIND,
            multiple: false,
            title: () => lookup('tab.title', 'Agent Browser'),
            guide: [
              {
                id: `${TYPE_ID}:page`,
                order: 40,
                title: () => lookup('guide.title', 'Agent Browser'),
                description: () => lookup('guide.description', 'Watch and take over the agent browser'),
              },
            ],
          }),
        'dsh-agent-browser: tab type',
      );

      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.right.pane.tab', () =>
            ctx.slots.register({ name: 'sidebar.right.pane.tab', key: TYPE_ID }, Panel),
          ),
        'dsh-agent-browser: panel body',
      );

      // Follow the agent: the first time the runtime reports a live browser,
      // reveal the panel. A failed open (no Session on screen) is retried on
      // the next tick rather than being marked done.
      ctx.effect(() => {
        let opened = false;
        let disposed = false;
        const poll = async () => {
          if (disposed || opened) return;
          try {
            const response = await fetch(`${ROUTE}/status`, { cache: 'no-store' });
            if (!response.ok) return;
            const status = await response.json();
            if (status?.state !== 'running') return;
            ctx.sidebarRight.openTab(TYPE_KIND);
            opened = true;
          } catch {
            // Nothing to reveal yet, or no Session on screen.
          }
        };
        const timer = setInterval(() => void poll(), 5000);
        timer.unref?.();
        void poll();
        return () => {
          disposed = true;
          clearInterval(timer);
        };
      }, 'dsh-agent-browser: reveal on activity');
    }

    return { inject, apply };
  },
});
