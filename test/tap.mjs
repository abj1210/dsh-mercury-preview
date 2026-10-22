// 验证 host 侧的截流：两种流语义都要接住，且都不能弄坏下游。
import assert from 'node:assert/strict';

const fakeCtx = {
  llm: {
    streamWithRegistration(options) {
      if (options.marker === 'diffusing') return diffusing();
      if (options.marker === 'snapshot') return snapshot();
      return incremental();
    }
  },
  effect() {}
};

async function* incremental() {
  yield { type: 'block-start', index: 0, blockType: 'text' };
  yield { type: 'text-delta', index: 0, text: '你' };
  yield { type: 'text-delta', index: 0, text: '好' };
  yield { type: 'text-delta', index: 0, text: '，世界' };
  yield { type: 'finish', reason: { kind: 'stop' } };
}

async function* snapshot() {
  yield { type: 'block-start', index: 0, blockType: 'text' };
  yield { type: 'text-delta', index: 0, text: '扩散' };
  yield { type: 'text-delta', index: 0, text: '扩散语言' };
  yield { type: 'text-delta', index: 0, text: '扩散语言模型' };
  yield { type: 'text-delta', index: 0, text: '扩散语言模型很好' };
  yield { type: 'finish', reason: { kind: 'stop' } };
}

// 真 diffusing 的形状：每帧都是整篇、长度几乎不变、内容在改（去噪）。
async function* diffusing() {
  yield { type: 'block-start', index: 0, blockType: 'text' };
  yield { type: 'text-delta', index: 0, text: '扩散语言模型@#很$%' };
  yield { type: 'text-delta', index: 0, text: '扩散语言模型AB很CD' };
  yield { type: 'text-delta', index: 0, text: '扩散语言模型很好' };
  yield { type: 'finish', reason: { kind: 'stop' } };
}

const { apply } = await import('../index.js');
apply(fakeCtx);

async function drain(options) {
  const chunks = [];
  for await (const chunk of fakeCtx.llm.streamWithRegistration(options)) chunks.push(chunk);
  return chunks;
}

const inc = await drain({ provider: 'deepseek-official', model: 'deepseek-flash', marker: 'incremental' });
const incText = inc.filter((c) => c.type === 'text-delta').map((c) => c.text).join('');
assert.equal(incText, '你好，世界', 'incremental stream reaches downstream unchanged');
assert.equal(inc.filter((c) => c.type === 'finish').length, 1, 'terminal chunk preserved');

// 窗口形态：每块以前一块为前缀、终点更远。这种流可以逐段下发新增部分。
// 用非 mercury 的模型名，避开「mercury 一律缓冲」那条规则，单独验证窗口分支。
const win = await drain({ provider: 'inception', model: 'window-probe', marker: 'snapshot' });
const winDeltas = win.filter((c) => c.type === 'text-delta').map((c) => c.text);
assert.equal(winDeltas.join(''), '扩散语言模型很好', 'window stream reaches downstream in full');
assert.deepEqual(winDeltas, ['扩散', '语言', '模型', '很好'], 'each window chunk contributes only its new suffix');

// 真 diffusing 形态：帧里夹着没收敛的噪声。append-only 的装配器发出去收不回来，
// 所以整段压住，收尾再把终稿按块补发（会话窗口才看得到逐段长出来）。
const dif = await drain({ provider: 'inception', model: 'mercury-3', marker: 'diffusing' });
const difDeltas = dif.filter((c) => c.type === 'text-delta').map((c) => c.text);
assert.equal(difDeltas.join(''), '扩散语言模型很好', 'diffusing stream still yields the final text');
assert.ok(difDeltas.length >= 1, 'final text is replayed in chunks');
assert.ok(difDeltas.every((t) => t.length > 0), 'no empty chunk downstream');
assert.equal(dif.filter((c) => c.type === 'finish').length, 1, 'terminal chunk preserved after buffering');

console.log('TAP OK');
console.log('incremental downstream:', JSON.stringify(incText));
console.log('window      downstream:', JSON.stringify(winDeltas));
console.log('diffusing   downstream:', JSON.stringify(difDeltas));

let tap = null;
try {
  tap = await (await fetch('http://127.0.0.1:8799/local/tap', { signal: AbortSignal.timeout(1500) })).json();
} catch (error) {
  console.log('http: 8799 不可达（多半被运行中的 host 占用），跳过 HTTP 断言');
}
if (tap !== null) console.log('tap:', JSON.stringify(tap));
process.exit(0);
