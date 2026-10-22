// 验证「从会话记录还原真帧」：不依赖截流，直接读 session.v4.jsonl.zstd。
import assert from 'node:assert/strict';

const { framesFromStream, readLatestSessionReply } = await import('../index.js');

// 1) 形状：text-chunks 的 texts 是增量，累积成每帧全文
const incremental = framesFromStream([
  { type: 'chunk', time: 1, chunk: { type: 'block-start', index: 0, blockType: 'text' } },
  { type: 'text-chunks', time0: 2, index: 0, dt: [10, 20, 30], texts: ['你', '好', '，世界'] },
  { type: 'chunk', time: 3, chunk: { type: 'finish', reason: { kind: 'stop' } } }
]);
assert.equal(incremental.snapshot, false, 'incremental stream is not a snapshot');
assert.deepEqual(incremental.frames.map((f) => f.text), ['你', '你好', '你好，世界']);
assert.deepEqual(incremental.frames.map((f) => f.dt), [10, 20, 30]);

// 2) 形状：diffusing 时每项是全文，不能累积（真实采集：4 帧、长度都接近终稿）
const snap = framesFromStream([
  { type: 'text-chunks', time0: 2, index: 0, dt: [0, 0, 3], texts: [
    'A di\\?4 ion language modV9 8s a type of generat1V AI that c',
    'A diffusion language modV9 8s a type of generat1V AI that clea',
    'A diffusion language model is a type of generative AI that cleans text',
    'A diffusion language model is a type of generative AI that cleans text by denoising it.'
  ] }
]);
assert.equal(snap.snapshot, true, 'snapshot stream detected by length distribution');
assert.equal(snap.frames.map((f) => f.text)[3], 'A diffusion language model is a type of generative AI that cleans text by denoising it.', 'no duplication for snapshots');

// 3) 太少或没有正文时返回 null
assert.equal(framesFromStream([{ type: 'text-chunks', texts: ['单帧'] }]), null);
assert.equal(framesFromStream(null), null);

// 4) 真机：读本机会话文件的最后一条 assistant 消息
const live = readLatestSessionReply();
if (live && live.error) {
  console.log('live: 跳过（' + live.error + '）');
} else {
  console.log('live session:', live.sessionId, 'source:', live.source || 'text-only');
  if (live.frames) {
    assert.ok(live.frames.length >= 2, 'live session yields frames');
    console.log('live frames:', live.frames.length, 'snapshot:', live.snapshot, 'deltas:', live.deltas);
    console.log('live first frame:', JSON.stringify(live.frames[0].text.slice(0, 40)));
    console.log('live last  frame:', JSON.stringify(live.frames[live.frames.length - 1].text.slice(-60)));
  }
}
console.log('SESSION OK');
