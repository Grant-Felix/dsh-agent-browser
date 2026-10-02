/**
 * Render the panel in Node and assert what it actually says.
 *
 *   node scripts/smoke-panel.mjs
 *
 * Documentation described a "dormant placeholder" while the panel never used the
 * word, and the toolbar was five geometric icons with only tooltips — neither
 * drift was caught by any test. This runs the real `client.js` with a stub React
 * and inspects the element tree, so the labels ARE the artifact under test:
 * every visible string comes out of the component, not out of a comment.
 */
import { readFileSync } from 'node:fs';

let failures = 0;
function check(label, condition, detail = '') {
  if (condition) console.log(`PASS  ${label}${detail ? `  — ${detail}` : ''}`);
  else {
    failures += 1;
    console.log(`FAIL  ${label}${detail ? `  — ${detail}` : ''}`);
  }
}

// --- a stub React that builds a plain tree instead of a DOM ---------------
const forcedState = [];
/** Every value a component tried to store, so a click can be observed. */
const setCalls = [];
const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
  useState: (initial) => [
    forcedState.length > 0 ? forcedState.shift() : initial,
    (value) => setCalls.push(value),
  ],
  useRef: (initial) => ({ current: typeof initial === 'function' ? initial() : initial }),
  useEffect: () => {},
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
};

// --- load the real module and capture its factory -------------------------
let factory = null;
globalThis.window = {
  __ModuleLoader__: { load: ({ factory: given }) => { factory = given; } },
  // A narrow panel with the tab strip at the bottom, so menu placement is testable.
  innerWidth: 320,
  innerHeight: 800,
};
const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
// eslint-disable-next-line no-new-func
new Function('window', source)(globalThis.window);
check('client.js registers a module factory', typeof factory === 'function');

const module_ = factory((name) => (name === 'react' ? fakeReact : {}));
const { apply } = module_;

// --- a stub host: capture the panel component and its dictionary ----------
let Panel = null;
let dictionary = null;
const ctx = {
  effect: (fn) => {
    fn();
    return () => {};
  },
  locale: {
    register: (_ns, dict) => {
      dictionary = dict.zh;
      return () => {};
    },
    bind: () => (key) => (dictionary && dictionary[key]) || key,
  },
  slots: {
    // The panel registers through two calls: inject(slotName, cb) which runs the
    // callback with the slot available, then register(slot, component).
    inject: (_slotName, callback) => {
      callback();
      return () => {};
    },
    register: (_slot, component) => {
      Panel = component;
      return () => {};
    },
  },
  sidebarRightTabs: { register: () => () => {} },
  sidebarRight: { openTab: () => {} },
  get: () => undefined,
};
apply(ctx);
check('the panel component is registered', typeof Panel === 'function');

/** Collect every string in a rendered tree. */
function texts(node, out = []) {
  if (node === null || node === undefined || node === false) return out;
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) texts(child, out);
    return out;
  }
  // A <style> element's CSS is text too, but it is not UI copy: including it made
  // the assertions match stylesheet fragments.
  if (node.type === 'style' || node.type === 'script') return out;
  if (node.children) for (const child of node.children) texts(child, out);
  return out;
}

/** Render the panel with a forced status and return its visible text. */
function render(status) {
  forcedState.length = 0;
  forcedState.push(status);
  const tree = Panel();
  return texts(tree);
}

/** Every element of one type in the rendered tree, with its props. */
function find(tree, type, out = []) {
  if (!tree || typeof tree !== 'object') return out;
  if (Array.isArray(tree)) {
    for (const child of tree) find(child, type, out);
    return out;
  }
  if (tree.type === type) out.push(tree);
  if (tree.children) for (const child of tree.children) find(child, type, out);
  return out;
}

/** Render into the real tree (not just text) so props can be asserted too. */
function renderTree(status) {
  forcedState.length = 0;
  forcedState.push(status);
  return Panel();
}

const parked = [
  { key: 'p1', state: 'parked', url: 'https://example.com/', title: 'Example Domain', active: false },
  { key: 'p2', state: 'parked', url: 'https://example.org/', title: 'Other', active: true },
];
const live = [{ key: 'p1', state: 'live', url: 'https://example.com/', title: 'Example Domain', active: true }];

// --- 1. the toolbar is words, not shapes ----------------------------------
const running = render({ state: 'running', engine: 'chromium', pages: live, activeKey: 'p1', viewport: { width: 0, height: 0 }, url: 'https://example.com/', title: 'Example Domain' });
for (const label of ['后退', '前进', '刷新', '休眠此页', '停止浏览器']) {
  check(`the toolbar says "${label}"`, running.includes(label));
}
const toolbarButtons = [];
const walk = (node) => {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) return node.forEach(walk);
  if (node.type === 'button') toolbarButtons.push(texts(node).join(''));
  if (node.children) node.children.forEach(walk);
};
walk(Panel === null ? null : (() => { forcedState.length = 0; forcedState.push({ state: 'running', engine: 'chromium', pages: live, activeKey: 'p1', viewport: { width: 0, height: 0 } }); return Panel(); })());
check('no button is an icon-only svg', !toolbarButtons.some((label) => label.trim() === ''), toolbarButtons.join(' | ').slice(0, 120));

// --- 2. the dormant state is named and its list is labelled ---------------
const dormant = render({ state: 'running', engine: 'chromium', pages: parked, activeKey: null, viewport: { width: 0, height: 0 } });
check('the dormant state names itself', dormant.includes('已休眠'), dormant.slice(0, 60).join(' / '));
check('the dormant list has a heading', dormant.some((text) => text.includes('已休眠的页面')), dormant.find((t) => t.includes('页面')) ?? '');
check('the restore call to action is "唤醒"', dormant.includes('唤醒'));
// Keys are for the API, not for the reader: what must survive is that each page is
// listed once and its URL is still reachable from the row's tooltip.
const dormantList = renderTree({ state: 'running', engine: 'chromium', pages: parked, activeKey: null, viewport: { width: 0, height: 0 } });
const dormantRows = find(dormantList, 'button').filter((node) => String(node.props.className ?? '').includes('dshab-page'));
check('both parked pages are listed', dormantRows.length === 2, `${dormantRows.length} row(s)`);
check('each row still carries its URL', dormantRows.every((node) => String(node.props.title ?? '').startsWith('https://')), dormantRows.map((n) => n.props.title).join(' | '));
check('the old wording is gone from the dormant state', !dormant.some((text) => /记住的页面|已收页|恢复页面/.test(text)));

// --- 3. stopped / failed states say their name too ------------------------
const stopped = render({ state: 'stopped', engine: 'chromium', pages: [] });
check('a stopped browser says "未启动"', stopped.includes('未启动'));
check('and offers "启动浏览器"', stopped.includes('启动浏览器'));
const failed = render({ state: 'failed', failure: 'no Chromium binary found', pages: [] });
check('a failure shows the reason', failed.some((text) => text.includes('no Chromium binary')), failed.find((t) => t.includes('no Chromium')) ?? '');

// --- 3b. the new tab is clickable while the pages are dormant -------------
// The bug: the button was gated on `state === 'running'`, so parking the last
// page (or an idle stop) left the user with no way to open another tab.
const dormantTree = renderTree({ state: 'running', engine: 'chromium', pages: parked, activeKey: null, viewport: { width: 0, height: 0 } });
const dormantNewTab = find(dormantTree, 'button').find((node) => texts(node).join('').includes('新建标签页'));
check('the new tab button exists while dormant', Boolean(dormantNewTab));
check('and it is enabled while dormant', dormantNewTab?.props.disabled === false, `disabled=${dormantNewTab?.props.disabled}`);

const stoppedTree = renderTree({ state: 'stopped', engine: 'chromium', pages: parked, activeKey: null });
const stoppedNewTab = find(stoppedTree, 'button').find((node) => texts(node).join('').includes('新建标签页'));
check('and still enabled when the browser is stopped (the host starts on demand)', stoppedNewTab?.props.disabled === false, `disabled=${stoppedNewTab?.props.disabled}`);

// --- 3c. one bottom row: a count ball instead of a separate count line ----
const ball = find(dormantTree, 'span').find((node) => String(node.props.className ?? '').includes('dshab-count'));
check('the tab row shows a count ball', ball !== undefined && texts(ball).join('') === '2', `ball=${texts(ball ?? { children: [] }).join('')}`);
check('the count is no longer repeated in a footer', !dormant.some((text) => /已休眠 · 2 个页面/.test(text)), dormant.at(-1) ?? '');
const tabRow = find(dormantTree, 'div').find((node) => node.props.className === 'dshab-tabs');
const strip = tabRow ? find(tabRow, 'div').find((node) => node.props.className === 'dshab-chips') : null;
check('the tab strip scrolls sideways', strip !== null);

// --- 3d. sleep and wake are per page, not all-or-nothing ----------------
// Dormant rows were inert text, and the only sleep control acted on the active
// page: waking a chosen page or sleeping a background one was impossible.
const rowButtons = find(dormantTree, 'button').filter((node) => String(node.props.className ?? '').includes('dshab-page'));
check('every dormant page is its own wake button', rowButtons.length === 2, `${rowButtons.length} row button(s)`);
check('each row names its own page', rowButtons.map((n) => texts(n).join('')).join('|').includes('Example Domain') && rowButtons.map((n) => texts(n).join('')).join('|').includes('Other'), rowButtons.map((n) => texts(n).join('')).join(' | '));
check('the rows carry no key prefix either', rowButtons.every((node) => !/^p\d/.test(texts(node).join(''))), rowButtons.map((n) => texts(n).join('')).join(' | '));
const rowLabels = rowButtons.map((node) => texts(node).join(''));
check('the rows are labelled "唤醒"', rowLabels.every((label) => label.includes('唤醒')), rowLabels.join(' | '));
check('the single call to action no longer claims to wake everything', dormant.some((text) => text.includes('唤醒最近一页')), dormant.find((t) => t.includes('唤醒最近')) ?? '');

// each live chip carries its own sleep control, and parked ones their own wake
const liveTree = renderTree({ state: 'running', engine: 'chromium', pages: [...live, parked[1]], activeKey: 'p1', viewport: { width: 0, height: 0 } });
check('no lamp is rendered on the tabs', !find(liveTree, 'span').some((node) => String(node.props.className ?? '').includes('dshab-lamp')));
// Exact class: 'dshab-chip-new' (the new-tab control) is not a tab.
const chips = find(liveTree, 'button').filter((node) => node.props.className === 'dshab-chip');
check('a tab shows a short label, not a key and a site suffix', chips.every((node) => !/^p\d/.test(texts(node).join(''))), chips.map((n) => texts(n).join('')).join(' | '));
check('the site suffix is stripped', chips.some((node) => texts(node).join('') === 'Example Domain'), chips.map((n) => texts(n).join('')).join(' | '));
// A left click is what opens the menu now (and switches to that tab).
check('clicking a tab carries a handler', chips.every((node) => typeof node.props.onClick === 'function'));
check('no tab still listens for right-click', chips.every((node) => node.props.onContextMenu === undefined));
// texts() deliberately skips <style>, so read the stylesheet directly.
const styleNode = find(liveTree, 'style')[0];
const colourCss = styleNode ? styleNode.children.map(String).join('\n') : '';
check('an awake tab uses the blue-violet accent', /\.dshab-chip \{[^}]*--dsw-alias-state-business-primary/.test(colourCss), 'dshab-chip base rule');
check('a dormant tab is greyed out', /\.dshab-chip\[data-state="parked"\][^}]*grayscale/.test(colourCss), 'parked rule');
check(
  'the active tab keeps the accent rather than the neutral ink',
  /\.dshab-chip\[data-active="true"\][^}]*--dsw-alias-state-business-primary/.test(colourCss),
  'active rule',
);

// the menu has exactly the two entries asked for, and the second one is a toggle
// Clicking a tab must store that tab for the menu: the click IS the opening.
setCalls.length = 0;
const clickTree = renderTree({ state: 'running', engine: 'chromium', pages: [...live, parked[1]], activeKey: 'p1', viewport: { width: 0, height: 0 } });
const parkedChip = find(clickTree, 'button').find((node) => node.props.className === 'dshab-chip' && texts(node).join('') === 'Other');
parkedChip?.props.onClick({
  stopPropagation: () => {},
  preventDefault: () => {},
  clientX: 40,
  clientY: 50,
  // The tab's own box: the menu must anchor to THIS, not to the pointer.
  currentTarget: { getBoundingClientRect: () => ({ left: 20, top: 760, right: 120, bottom: 782 }) },
});
const opened = setCalls.find((value) => value && typeof value === 'object' && value.page);
check('a left click opens that tab\'s menu', Boolean(opened) && opened.page.key === 'p2', JSON.stringify(opened));
check('the menu anchors to the tab, not to the pointer', opened?.anchor?.left === 20 && opened.anchor.top === 760, JSON.stringify(opened?.anchor));

const menuTree = (() => {
  forcedState.length = 0;
  forcedState.push({ state: 'running', engine: 'chromium', pages: [...live, parked[1]], activeKey: 'p1', viewport: { width: 0, height: 0 } });
  forcedState.push(undefined, '', false, false, false);
  forcedState.push({ anchor: { left: 20, top: 760, right: 120, bottom: 782 }, page: parked[1] });
  return Panel();
})();
const menuNode = find(menuTree, 'div').find((node) => node.props.className === 'dshab-menu');
// The strip sits at the bottom, so the menu must flip above the tab and line up
// with its left edge — "diagonally touching", not floating at the pointer.
const nearBottom = (() => {
  forcedState.length = 0;
  forcedState.push({ state: 'running', engine: 'chromium', pages: [...live, parked[1]], activeKey: 'p1', viewport: { width: 0, height: 0 } });
  forcedState.push(undefined, '', false, false, false);
  forcedState.push({ anchor: { left: 20, top: 760, right: 120, bottom: 782 }, page: parked[1] });
  return Panel();
})();
const placedMenu = find(nearBottom, 'div').find((node) => node.props.className === 'dshab-menu');
check('the menu opens upward from a bottom tab', placedMenu?.props['data-placement'] === 'above', String(placedMenu?.props['data-placement']));
check('and touches that tab\'s top edge', placedMenu?.props.style?.top === '694px', String(placedMenu?.props.style?.top));
check('and lines up with its left edge', placedMenu?.props.style?.left === '20px', String(placedMenu?.props.style?.left));
const nearRight = (() => {
  forcedState.length = 0;
  forcedState.push({ state: 'running', engine: 'chromium', pages: [...live], activeKey: 'p1', viewport: { width: 0, height: 0 } });
  forcedState.push(undefined, '', false, false, false);
  forcedState.push({ anchor: { left: 300, top: 760, right: 316, bottom: 782 }, page: live[0] });
  return Panel();
})();
const clampedMenu = find(nearRight, 'div').find((node) => node.props.className === 'dshab-menu');
check('a tab near the right edge is not overflowed', clampedMenu?.props.style?.left === '142px', String(clampedMenu?.props.style?.left));
const menuButtons = menuNode ? find(menuNode, 'button') : [];
check('the tab menu has exactly two entries', menuButtons.length === 2, menuButtons.map((n) => texts(n).join('')).join(' | '));
check('the first entry is "关闭"', texts(menuButtons[0] ?? { children: [] }).join('') === '关闭', texts(menuButtons[0] ?? { children: [] }).join(''));
check('closing does not keep the URL (it forgets)', String(menuButtons[0]?.props.title ?? '').includes('不保留') || String(menuButtons[0]?.props.title ?? '').length > 4, menuButtons[0]?.props.title);

// the same entry toggles: a dormant tab offers 唤醒, a live one 休眠
const liveMenuTree = (() => {
  forcedState.length = 0;
  forcedState.push({ state: 'running', engine: 'chromium', pages: [...live], activeKey: 'p1', viewport: { width: 0, height: 0 } });
  forcedState.push(undefined, '', false, false, false);
  forcedState.push({ anchor: { left: 20, top: 760, right: 120, bottom: 782 }, page: live[0] });
  return Panel();
})();
const liveMenu = find(liveMenuTree, 'div').find((node) => node.props.className === 'dshab-menu');
const liveMenuButtons = liveMenu ? find(liveMenu, 'button') : [];
check('a dormant tab offers 唤醒', texts(menuButtons[1] ?? { children: [] }).join('') === '唤醒', texts(menuButtons[1] ?? { children: [] }).join(''));
check('a live tab offers 休眠 from the same entry', texts(liveMenuButtons[1] ?? { children: [] }).join('') === '休眠', texts(liveMenuButtons[1] ?? { children: [] }).join(''));

// --- 4. the page strip exists even while a page is live -------------------
const withParked = render({ state: 'running', engine: 'chromium', pages: [...live, parked[1]], activeKey: 'p1', viewport: { width: 0, height: 0 } });
check('the tab strip offers a new tab', withParked.some((text) => text.includes('新建标签页')), withParked.find((t) => t.includes('标签页')) ?? '');
// A running browser with no pages must still offer the control, or the user is
// stuck with whatever single page happens to exist.
const emptyRunning = render({ state: 'running', engine: 'chromium', pages: [], activeKey: null, viewport: { width: 0, height: 0 } });
check('a new tab is offered even with no pages open', emptyRunning.some((text) => text.includes('新建标签页')), emptyRunning.join(' ').slice(0, 90));
check('a running browser with no pages does not claim to be dormant', !emptyRunning.includes('已休眠'), emptyRunning.slice(0, 3).join(' / '));
check('and it does not offer to start again', !emptyRunning.includes('启动浏览器'), emptyRunning.find((t) => t.includes('运行中')) ?? '');
check('the no-pages state never claims to be dormant', emptyRunning.some((text) => text.includes('没有打开的页面')) && !emptyRunning.some((text) => /已休眠/.test(text)), emptyRunning.slice(0, 3).join(' / '));
check('parked pages stay reachable while one is live', withParked.includes('Other'), withParked.join(' ').slice(0, 90));
const withParkedBall = find(renderTree({ state: 'running', engine: 'chromium', pages: [...live, parked[1]], activeKey: 'p1', viewport: { width: 0, height: 0 } }), 'span').find((node) => String(node.props.className ?? '').includes('dshab-count'));
check('the count ball totals live plus dormant tabs', texts(withParkedBall ?? { children: [] }).join('') === '2', `ball=${texts(withParkedBall ?? { children: [] }).join('')}`);
const withParkedTree = renderTree({ state: 'running', engine: 'chromium', pages: [...live, parked[1]], activeKey: 'p1', viewport: { width: 0, height: 0 } });
check(
  'an ordinary running session has no extra footer row',
  !find(withParkedTree, 'div').some((node) => node.props.className === 'dshab-foot'),
  find(withParkedTree, 'div').map((n) => n.props.className).filter(Boolean).join(' '),
);

console.log(`\n${failures === 0 ? 'PANEL_OK' : `PANEL_FAILED (${failures})`}`);
