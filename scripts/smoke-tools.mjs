/**
 * Tool-layer smoke test: the definition the model actually sees.
 *
 *   HOME=<workspace>/.dev/home node scripts/smoke-tools.mjs
 *
 * The other suites exercise the runtime and the HTTP face. This one registers
 * the real `agent_browser` tool against a stub registry and invokes it the way
 * the model does, so the schema, the argument plumbing and the human-readable
 * results are all covered — including the acting actions (click/drag/type/key)
 * that let the agent do things instead of only observing.
 */
import { rmSync } from 'node:fs';
import { AgentBrowser } from '../src/browser.js';
import { resolveConfig } from '../src/config.js';
import { defaultRegistryPath } from '../src/registry.js';
import { registerTools } from '../src/tools.js';

let failures = 0;
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`PASS  ${label}${detail ? `  — ${detail}` : ''}`);
  } else {
    failures += 1;
    console.log(`FAIL  ${label}${detail ? `  — ${detail}` : ''}`);
  }
}

rmSync(defaultRegistryPath(), { force: true });
const config = resolveConfig({ sweepIntervalSec: 3600, pointerSpeedPxPerSec: 4000 });
const browser = new AgentBrowser({ config, log: () => {} });

// Capture the definition exactly as the tool registry receives it, with a stub
// attachment service so the image path is exercised without a live harness.
let definition = null;
const saved = [];
const attachments = {
  saveImage: async (input) => {
    saved.push(input);
    return { attachmentId: 'stub-attachment-1', mediaType: input.mediaType, bytes: input.data.length, width: 800, height: 600, name: input.name };
  },
};
const ctx = {
  tools: { register: (tool) => { definition = tool; return () => {}; } },
  get: (name) => (name === 'attachments' ? attachments : undefined),
};
registerTools(ctx, browser, null);

check('the tool is registered under its name', definition?.name === 'agent_browser', definition?.name);
// defineTool normalizes `parameters` into a JSON Schema object.
const properties = definition?.parameters?.properties ?? {};
const actions = properties.action?.enum ?? [];

// The agent must have no way to ask for headless: on a machine with a display the
// product refuses it, and a silent refusal would be worse than no control at all.
check(
  'the agent has no way to ask for headless',
  !actions.includes('headless') && !Object.keys(properties).some((name) => /headless/i.test(name)),
  `actions=${actions.length}, params=${Object.keys(properties).length}`,
);
check('action is the only required parameter', JSON.stringify(definition?.parameters?.required) === '["action"]', JSON.stringify(definition?.parameters?.required));
for (const action of ['click', 'move', 'drag', 'scroll', 'type', 'key']) {
  check(`the schema exposes action=${action}`, actions.includes(action));
}
for (const param of ['x', 'y', 'nx', 'ny', 'toX', 'toY', 'toNx', 'toNy', 'text', 'selector', 'submit', 'key', 'modifiers', 'deltaY', 'double']) {
  if (!properties[param]) check(`the schema documents ${param}`, false, 'missing');
}
check(
  'every acting parameter is documented',
  ['x', 'y', 'nx', 'ny', 'toX', 'toY', 'toNx', 'toNy', 'text', 'selector', 'submit', 'key', 'modifiers', 'deltaY', 'double'].every(
    (param) => Boolean(properties[param]),
  ),
  Object.keys(properties).length + ' parameters',
);

/** Invoke the tool the way the model does. */
const call = (args) => definition.execute(args);

// An interactive page built locally, so nothing depends on a third-party site.
await browser.navigate('about:blank');
await browser.evaluate(`(() => {
  document.body.style.margin = '0';
  document.body.innerHTML =
    '<input id="text" type="text" style="width:400px;height:40px;margin:20px">' +
    '<input id="slider" type="range" min="0" max="100" value="0" style="width:600px;height:40px;margin:20px">' +
    '<button id="btn" style="width:200px;height:60px;margin:20px">Press me</button>' +
    '<div id="hits" style="margin:20px">clicks: 0</div>';
  window.__clicks = 0;
  document.getElementById('btn').addEventListener('click', () => {
    window.__clicks += 1;
    document.getElementById('hits').textContent = 'clicks: ' + window.__clicks;
  });
  return true;
})()`);

const boxes = await browser.evaluate(`(() => {
  const rect = (id) => { const r = document.getElementById(id).getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), left: r.left, width: r.width, mid: r.top + r.height / 2 }; };
  return { text: rect('text'), slider: rect('slider'), button: rect('btn') };
})()`);

// 1. type into a selector
const typed = await call({ action: 'type', selector: '#text', text: 'hello world' });
check('type focuses the selector and lands the text', typed.ok === true && typed.value === 'hello world', JSON.stringify(typed.value));

// The mode the agent gets is stated, and explained when it is not what was asked.
const firstStatus = await call({ action: 'status' });
check(
  'status reports the display mode',
  typeof firstStatus.text === 'string' && /headed|headless/.test(firstStatus.text),
  String(firstStatus.text).slice(0, 100),
);

// 2. key
const keyed = await call({ action: 'key', key: 'ArrowRight' });
check('key reports success with a status line', keyed.ok === true && /pressed ArrowRight/.test(keyed.text ?? ''), keyed.text?.slice(0, 70));

// 3. click by pixel coordinates
const clicked = await call({ action: 'click', x: boxes.button.x, y: boxes.button.y });
const hitCount = await browser.evaluate('window.__clicks');
check('click lands on the element', clicked.ok === true && hitCount === 1, `__clicks=${hitCount}`);

// 4. click by viewport ratio
const ratioClicked = await call({ action: 'click', nx: boxes.button.x / (await browser.evaluate('window.innerWidth')), ny: boxes.button.y / (await browser.evaluate('window.innerHeight')) });
const hitCount2 = await browser.evaluate('window.__clicks');
check('click also accepts viewport ratios', ratioClicked.ok === true && hitCount2 === 2, `__clicks=${hitCount2}`);

// 5. drag a slider (the motion a slider CAPTCHA asks for)
const dragged = await call({
  action: 'drag',
  x: Math.round(boxes.slider.left + 8),
  y: Math.round(boxes.slider.mid),
  toX: Math.round(boxes.slider.left + boxes.slider.width * 0.8),
  toY: Math.round(boxes.slider.mid),
});
const sliderValue = Number(await browser.evaluate(`document.getElementById('slider').value`));
check('drag moves a slider through the tool', dragged.ok === true && sliderValue > 40, `value=${sliderValue}`);

// 6. scroll
const scrolled = await call({ action: 'scroll', deltaY: 500 });
check('scroll reports success', scrolled.ok === true && /scrolled/.test(scrolled.text ?? ''), scrolled.text?.slice(0, 60));

// 6b. a screenshot hands the model an image, not a byte count
const shot = await call({ action: 'screenshot' });
check('the screenshot commits bytes to the attachment service', saved.length === 1 && saved[0].mediaType === 'image/png', `${saved[0]?.data?.length ?? 0} bytes`);
check('the result carries the attachment reference', shot.ok === true && shot.image?.attachmentId === 'stub-attachment-1', JSON.stringify(shot.image));
const blocks = definition.output.render({ action: 'screenshot' }, shot);
check('the renderer emits a text block and an image block', blocks.length === 2 && blocks[1].type === 'image', JSON.stringify(blocks.map((b) => b.type)));
check('the image block references the attachment', blocks[1].attachment?.mediaType === 'image/png', JSON.stringify(blocks[1].attachment).slice(0, 80));
const plain = definition.output.render({ action: 'status' }, { ok: true, text: 'hello' });
check('a plain result still renders as one text block', plain.length === 1 && plain[0].type === 'text', JSON.stringify(plain.map((b) => b.type)));
const optedOut = await call({ action: 'screenshot', noImage: true });
check('noImage=true skips the attachment', optedOut.ok === true && optedOut.image === undefined, `bytes=${optedOut.bytes}`);

// 7. a bad drag is refused with a usable message
const badDrag = await call({ action: 'drag', x: 10, y: 10 });
check('drag without a drop point is refused clearly', badDrag.ok === false && /toX\/toY/.test(badDrag.text ?? ''), badDrag.text?.slice(0, 70));

// 8. a missing selector is reported, not silently ignored
const badType = await call({ action: 'type', selector: '#nope', text: 'x' });
check('type with an unknown selector fails loudly', badType.ok === false && /no element matched/.test(badType.text ?? ''), badType.text?.slice(0, 70));

await browser.dispose();
console.log(`\n${failures === 0 ? 'TOOLS_OK' : `TOOLS_FAILED (${failures})`}`);
