// Offline harness: executes lib/client.js the way the browser loader would, with
// stubs for React, the DOM, and the Cordis context. It catches shape mistakes
// (bad exports, throwing apply(), missing tab fields) without a DSH restart.

import assert from 'node:assert/strict';

const log = [];
let captured = null;

globalThis.window = {
  __ModuleLoader__: {
    load(spec) {
      captured = spec;
      log.push(`load(${spec.id})`);
    },
  },
  location: { origin: 'http://127.0.0.1:63655' },
  localStorage: {
    store: new Map(),
    getItem(k) { return this.store.has(k) ? this.store.get(k) : null; },
    setItem(k, v) { this.store.set(k, String(v)); },
  },
};

let styleCount = 0;
globalThis.document = {
  querySelector() { return null; },
  createElement() {
    return { setAttribute() {}, textContent: '', parentElement: null };
  },
  head: { append() { styleCount += 1; } },
};

const React = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children };
  },
  useState(init) { return [typeof init === 'function' ? init() : init, () => {}]; },
  useRef(value) { return { current: value }; },
  useEffect() {},
  useCallback(fn) { return fn; },
};

const requireStub = (id) => {
  if (id === 'react') return React;
  throw new Error(`unexpected require(${id})`);
};

await import('../lib/client.js');

assert.ok(captured, 'client.js never called window.__ModuleLoader__.load');
assert.equal(captured.id, 'dsh-mercury-preview');
assert.equal(typeof captured.factory, 'function');

const exported = captured.factory(requireStub);
assert.equal(exported.name, 'dsh-mercury-preview');
assert.deepEqual(exported.inject, ['slots']);
assert.equal(typeof exported.apply, 'function');
assert.equal(typeof exported.TabBody, 'function');

// --- apply(): walk the exact ctx surface the plugin touches ----------------
const tabRegistrations = [];
const slotRegistrations = [];
const ctx = {
  inject(names, callback) {
    log.push(`ctx.inject(${names.join(',')})`);
    callback({
      sidebarRight: { openTab() {}, openTabIn() {} },
      sidebarRightTabs: {
        register(definition) { tabRegistrations.push(definition); return () => {}; },
      },
    });
  },
  slots: {
    inject(name, callback) {
      log.push(`slots.inject(${name})`);
      callback();
    },
    register(meta, component) {
      slotRegistrations.push({ meta, component });
      return () => {};
    },
  },
};

exported.apply(ctx);
assert.ok(styleCount >= 1, 'styles were not installed');

assert.equal(tabRegistrations.length, 1, 'expected one sidebar tab definition');
const tab = tabRegistrations[0];
assert.equal(tab.id, 'mercury');
assert.equal(tab.kind, 'mercury');
assert.equal(typeof tab.title, 'function');
assert.equal(tab.title(), 'Mercury');
assert.equal(tab.guide.length, 1);
assert.equal(typeof tab.guide[0].order, 'number');
assert.equal(tab.guide[0].title(), 'Mercury 扩散预览');
assert.equal(typeof tab.guide[0].icon, 'function');
assert.ok(tab.guide[0].icon().type === 'svg', 'guide icon is not an svg');

assert.equal(slotRegistrations.length, 1, 'expected one slot registration');
const slot = slotRegistrations[0];
assert.equal(slot.meta.name, 'sidebar.right.pane.tab');
assert.equal(slot.meta.key, tab.id, 'slot key must equal the tab id');
assert.equal(slot.component, exported.TabBody);

// --- TabBody(): render once with the props shape flowchart taught us --------
const tree = exported.TabBody({ hooks: { tabInfo: () => ({ navigation: { params: {} } }) } });
assert.equal(tree.type, 'div');
assert.ok(tree.props.className.includes('mc-wrap'));

const flat = JSON.stringify(tree, (k, v) => (typeof v === 'function' ? '[fn]' : v));
assert.ok(flat.includes('Mercury 3 扩散预览'), 'empty-state hint missing');
assert.ok(flat.includes('mercury-3'), 'default model missing');
// 端点与模型改成只读展示后，第二行应出现转发口的标签
assert.ok(flat.includes('本机转发'), 'endpoint label missing');

// --- extractText(): the message shapes providers actually return ------------
assert.equal(exported.extractText({ choices: [{ message: { content: 'hi' } }] }), 'hi');
assert.equal(exported.extractText({ choices: [{ delta: { content: 'd' } }] }), 'd');
assert.equal(exported.extractText({ choices: [{ text: 'plain' }] }), 'plain');
assert.equal(
  exported.extractText({ choices: [{ message: { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } }] }),
  'ab',
);
assert.equal(exported.extractText({ choices: [{ message: { content: null, reasoning: 'think' } }] }), 'think');
assert.equal(exported.extractText({}), '');
assert.equal(exported.extractText(null), '');

// --- changedChars(): 柱状图用的改写量 ---------------------------------------
assert.equal(exported.changedChars('abc', 'abd'), 1);
assert.equal(exported.changedChars('abc', 'abc'), 0);
assert.equal(exported.changedChars('abc', 'abcdef'), 3);
assert.equal(exported.changedChars('', 'ab'), 2);
assert.equal(exported.changedChars(null, 'x'), 1);

// --- 作用域回归：这几个 helper 被 run / 播放器 / 滑块三条路径共用，
// 必须声明在 TabBody 层（缩进 2），否则内部调用方会 ReferenceError。
{
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  for (const helper of ['paint', 'settleSpark', 'finishSeq']) {
    const line = src.split('\n').find((l) => new RegExp('^ *function ' + helper + '\\(').test(l));
    assert.ok(line !== undefined, helper + ' not found');
    assert.ok(line.indexOf('function') === 2, helper + ' must be declared at TabBody level');
  }
}

console.log('HARNESS OK');
console.log('log:', log.join(' | '));
console.log('css bytes:', (await import('node:fs')).readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8').length);
