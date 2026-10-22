// dsh-mercury-preview —— host 半边。
//
// 浏览器那一半负责画帧；这一半只做一件事：在 127.0.0.1:8799 开一个转发，
// 把面板的请求经本机代理隧道送到 api.inceptionlabs.ai，并补上 CORS 头。
//
// 为什么需要它：官方 API 的预检（OPTIONS）会回显 access-control-allow-origin，
// 但实际响应不带这个头，浏览器因此拒绝把响应交给页面（fetch 报 Failed to fetch）。
// 同源的本机转发绕开这个限制：页面访问 127.0.0.1 没有跨域限制，转发再补 CORS 头。

import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import zlib from 'node:zlib';

export const name = 'mercury-preview';
export const inject = ['llm'];

// 给离线测试用：这两支是纯函数，不碰服务注册。
export { framesFromStream, readLatestSessionReply };

const TARGET_HOST = 'api.inceptionlabs.ai';
const UPSTREAM_PROXY = { host: '127.0.0.1', port: 7890 };
const LISTEN = { host: '127.0.0.1', port: 8799 };

const PLUGIN_REV = 4;
// host 重载插件时模块会被重新求值，但原型上那个 patch 还挂着旧闭包。
// 把状态放在 globalThis 上，新旧闭包读写同一份，重载之后 tap 才不会「静默失联」。
const TAP = globalThis[Symbol.for('dsh.mercury-preview.tap-state')]
  || (globalThis[Symbol.for('dsh.mercury-preview.tap-state')] = { rev: PLUGIN_REV, installed: false, calls: 0, frames: 0, chunks: 0, lastError: null, firstCallAt: null, last: null, injected: 0, lastInjectAt: null });
const MAX_BODY = 4 * 1024 * 1024;
const MERCURY = /mercury/i;

// agent 走 llm-pi-ai 时，请求 body 由 pi-ai 拼装，dsh 的 provider schema
// 没有透传任意顶层字段的入口（samplingParams 只来自底层 model 对象）。
// 但这条请求正好经过本机转发口，所以在这里补 diffusing:true —— 这是
// 唯一能让 agent 自己那条流也返回去噪中间帧的地方。
// 面板自己的请求带 x-mercury-panel 头，开关归用户管，不在这里改写。
function injectDiffusing(req, body) {
  if (req.method !== 'POST') return null;
  if (!req.url || req.url.indexOf('/chat/completions') < 0) return null;
  if (req.headers['x-mercury-panel']) return null;
  if (!body || body.length === 0) return null;
  let json = null;
  try {
    json = JSON.parse(body.toString('utf8'));
  } catch (error) {
    return null;
  }
  if (!json || typeof json !== 'object') return null;
  if (!MERCURY.test(String(json.model || ''))) return null;
  if (json.stream !== true) return null;
  if (json.diffusing === true) return null;
  json.diffusing = true;
  TAP.injected += 1;
  TAP.lastInjectAt = Date.now();
  logLine('inject diffusing:true model=' + json.model);
  return Buffer.from(JSON.stringify(json), 'utf8');
}

function commonPrefixLen(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i += 1;
  return i;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const LOG_FILE = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'mercury-preview.log');

function logLine(message) {
  try {
    fs.appendFileSync(LOG_FILE, new Date().toISOString() + ' ' + message + '\n');
  } catch (error) {
    /* logging must never break the host */
  }
}

class TunnelAgent extends https.Agent {
  createConnection(options, callback) {
    const port = options.port || 443;
    const authority = options.host + ':' + port;
    const req = http.request({
      host: UPSTREAM_PROXY.host,
      port: UPSTREAM_PROXY.port,
      method: 'CONNECT',
      path: authority,
      headers: { Host: authority }
    });
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        callback(new Error('proxy CONNECT ' + res.statusCode));
        return;
      }
      const secure = tls.connect({ socket: socket, servername: options.host }, () => callback(null, secure));
      secure.on('error', callback);
    });
    req.on('error', callback);
    req.end();
  }
}

// 只放行本机页面。以前这里是 '*'，等于任何网页都能调 127.0.0.1:8799 ——
// 而转发动会给请求补上 Authorization（用的是你存在 DSH 里的 Inception key），
// 顺手还能读 /local/latest（会话正文）。外部站点因此可以白嫖额度、白读记录，
// 所以改成回显 Origin，且只认 localhost / 127.0.0.1 / ::1。
const CORS_BASE = {
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'authorization,content-type,http-referer,x-title',
  'access-control-allow-private-network': 'true',
  'access-control-max-age': '600',
  'vary': 'Origin'
};

function isLocalOrigin(value) {
  if (typeof value !== 'string' || value === '') return false;
  let url = null;
  try {
    url = new URL(value);
  } catch (error) {
    return false;
  }
  const host = url.hostname;
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
}

function corsFor(req) {
  const origin = req && req.headers ? req.headers.origin : undefined;
  const out = Object.assign({}, CORS_BASE);
  if (isLocalOrigin(origin)) {
    out['access-control-allow-origin'] = origin;
    out['access-control-allow-credentials'] = 'true';
  }
  return out;
}

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

// 面板走本机转发口时不该再让用户手填密钥：DSH 已经把 Inception 的 key
// 存在凭据文件的 refs.INCEPTION_API_KEY 里，这里直接拿来替请求补 header。
// 每 5 秒最多读一次盘，避免每个请求都碰文件。
const CRED_FILE = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), '.credentials.yaml');
let KEY_CACHE = { at: 0, value: '' };
function storedKey() {
  const now = Date.now();
  if (now - KEY_CACHE.at < 5000) return KEY_CACHE.value;
  let value = '';
  try {
    const text = fs.readFileSync(CRED_FILE, 'utf8');
    const hit = text.match(/^\s*INCEPTION_API_KEY:\s*(\S+)\s*$/m);
    if (hit !== null) value = hit[1];
  } catch (error) {
    /* 没有凭据文件就当没有 key，请求会原样发出去 */
  }
  KEY_CACHE = { at: now, value: value };
  return value;
}

function findLatestSessionFile(root) {
  let best = null;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries = null;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (entry.name !== 'session.v4.jsonl.zstd') continue;
      let stat = null;
      try {
        stat = fs.statSync(full);
      } catch (error) {
        continue;
      }
      if (best === null || stat.mtimeMs > best.mtimeMs) best = { file: full, mtimeMs: stat.mtimeMs };
    }
  }
  return best;
}

// 会话文件可能几十 MB，而面板只关心最近几轮。超过这个尺寸就只读尾部，
// 免得每次 /local/latest 都把整份文件搬进内存。
const TAIL_BYTES = 8 * 1024 * 1024;

function tailFrames(file, frameCount) {
  let buf = null;
  try {
    const size = fs.statSync(file).size;
    if (size > TAIL_BYTES) {
      const fd = fs.openSync(file, 'r');
      try {
        const chunk = Buffer.alloc(TAIL_BYTES);
        const n = fs.readSync(fd, chunk, 0, TAIL_BYTES, size - TAIL_BYTES);
        buf = chunk.subarray(0, n);
      } finally {
        fs.closeSync(fd);
      }
    } else {
      buf = fs.readFileSync(file);
    }
  } catch (error) {
    return '';
  }
  const starts = [];
  let at = buf.indexOf(ZSTD_MAGIC);
  while (at !== -1) {
    starts.push(at);
    at = buf.indexOf(ZSTD_MAGIC, at + 4);
  }
  if (starts.length === 0) return '';
  const from = Math.max(0, starts.length - frameCount);
  let text = '';
  for (let i = from; i < starts.length; i++) {
    const end = i + 1 < starts.length ? starts[i + 1] : buf.length;
    try {
      text += zlib.zstdDecompressSync(buf.subarray(starts[i], end)).toString('utf8');
    } catch (error) {
      /* a false positive magic inside compressed data; skip that slice */
    }
  }
  return text;
}

// 会话记录里 `data.stream` 保存了这一轮的完整帧序列，形状是：
//   {type:'chunk', time, chunk}                      独立 chunk（block-start 等）
//   {type:'text-chunks', time0, index, dt:[], texts:[]}   正文的逐帧文本
//   {type:'reasoning-chunks', ...}                   reasoning 的逐帧文本
//   {type:'tool-call-chunks', ...}                   工具参数的逐帧文本
// `texts` 是增量还是快照取决于端点：diffusing 时每项是全文。
// 这里还原成「每一帧的累积全文」，并且按前缀关系判定语义。
function framesFromStream(stream, finalText) {
  if (!Array.isArray(stream)) return null;
  const texts = [];
  const gaps = [];
  for (const entry of stream) {
    if (!entry || typeof entry !== 'object') continue;
    if (entry.type === 'text-chunks' && Array.isArray(entry.texts)) {
      for (let i = 0; i < entry.texts.length; i++) {
        const piece = entry.texts[i];
        if (typeof piece !== 'string' || piece === '') continue;
        texts.push(piece);
        gaps.push(entry.dt && typeof entry.dt[i] === 'number' ? entry.dt[i] : 0);
      }
    } else if (entry.type === 'chunk' && entry.chunk && entry.chunk.type === 'text-delta' && typeof entry.chunk.text === 'string' && entry.chunk.text !== '') {
      texts.push(entry.chunk.text);
      gaps.push(0);
    }
  }
  if (texts.length < 2) return null;
  // 增量流：各帧长短悬殊（从几个字一路长上去），只有末帧接近全长。
  // 扩散/快照流：每帧都是一次「近乎全文」的重绘，绝大多数帧长度都接近终稿。
  const lens = texts.map((t) => t.length);
  const maxLen = Math.max.apply(null, lens);
  const nearCount = lens.filter((n) => n >= maxLen * 0.5).length;
  let snapshot = maxLen >= 12 && nearCount >= Math.ceil(texts.length * 0.6);

  // 长度分布只是启发式：deepseek 这种「每块 4-8 token」的增量流，块与块
  // 长度相近，也会被这条规则误判成快照 —— 一旦误判，回放时每一帧都被当成
  // 全文整段替换，屏幕上就只剩最后一段是完整的。这里用最终回复原文做硬判据：
  // 末帧等于全文 → 快照；所有块拼起来等于全文 → 增量。
  if (typeof finalText === 'string' && finalText !== '') {
    const flat = (s) => String(s).replace(/\s+/g, '');
    const target = flat(finalText);
    if (target !== '') {
      if (flat(texts[texts.length - 1]) === target) snapshot = true;
      else if (flat(texts.join('')) === target) snapshot = false;
    }
  }

  let acc = texts[0];
  const frames = [{ text: acc, dt: gaps[0] }];
  for (let i = 1; i < texts.length; i++) {
    acc = snapshot ? texts[i] : acc + texts[i];
    frames.push({ text: acc, dt: gaps[i] });
  }
  return { frames: frames, snapshot: snapshot, deltas: texts.length };
}

function lastAssistantReply(text) {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.indexOf('"assistant/message"') === -1) continue;
    let record = null;
    try {
      record = JSON.parse(line);
    } catch (error) {
      continue;
    }
    const data = record && record.data;
    const content = data && data.message && data.message.content;
    const parts = [];
    if (Array.isArray(content)) {
      for (const part of content) {
        if (part && part.type === 'text' && typeof part.text === 'string' && part.text.trim() !== '') parts.push(part.text);
      }
    }
    const joined = parts.join('\n').trim();
    const frames = framesFromStream(data && data.stream, joined);
    if (joined === '' && frames === null) continue;
    const source = (data && data.message && data.message.source) || {};
    return {
      text: joined,
      time: record.time || null,
      frames: frames,
      provider: typeof source.provider === 'string' ? source.provider : '',
      model: typeof source.model === 'string' ? source.model : ''
    };
  }
  return null;
}

function readLatestSessionReply() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const root = path.join(home, 'sessions');
  if (typeof zlib.zstdDecompressSync !== 'function') {
    return { error: 'this Node build has no zstd support' };
  }
  const latest = findLatestSessionFile(root);
  if (latest === null) return { error: 'no session file under ' + root };
  const text = tailFrames(latest.file, 400);
  const found = lastAssistantReply(text);
  const sessionId = path.basename(path.dirname(latest.file));
  if (found === null) return { error: 'no assistant message in the tail of ' + sessionId };
  if (found.frames !== null) {
    const all = found.frames.frames;
    const stride = Math.max(1, Math.ceil(all.length / 200));
    const frames = [];
    for (let i = 0; i < all.length; i += stride) frames.push(all[i]);
    if (frames[frames.length - 1] !== all[all.length - 1]) frames.push(all[all.length - 1]);
    return {
      sessionId: sessionId,
      time: found.time,
      source: 'session-stream',
      snapshot: found.frames.snapshot,
      shape: found.frames.snapshot ? 'snapshot' : 'delta',
      deltas: found.frames.deltas,
      provider: found.provider,
      model: found.model,
      frames: frames,
      text: found.text.slice(0, 4000)
    };
  }
  return { sessionId: sessionId, time: found.time, text: found.text.slice(0, 4000) };
}

const STREAM_RING = [];
const STREAM_LIMIT = 4;
const FRAME_LIMIT = 240;
const TEXT_LIMIT = 12000;

function pushFrame(record, text) {
  record.frames.push({ t: Date.now() - record.startedAt, text: text.slice(0, TEXT_LIMIT) });
  if (record.frames.length > FRAME_LIMIT) record.frames.shift();
}

function commitStream(record) {
  record.ended = true;
  record.shape = record.snapshot ? 'snapshot' : (record.window ? 'window' : 'delta');
  // 无论有没有帧都留一份摘要：frames=0 的时候正是最需要现场证据的时候。
  TAP.last = {
    provider: record.provider,
    model: record.model,
    frames: record.frames.length,
    chunks: record.chunks,
    seen: record.seen,
    types: record.types,
    first: record.first,
    startedAt: record.startedAt
  };
  if (record.frames.length === 0) return;
  record.target = record.frames[record.frames.length - 1].text;
  record.endedAt = Date.now();
  STREAM_RING.push(record);
  if (STREAM_RING.length > STREAM_LIMIT) STREAM_RING.shift();
}

// 判断两个文本「是不是同一段内容的两次改写」。
// 采样若干片段，看它们是否原样出现在旧文本里：去噪重绘几乎全命中，
// 增量流的新内容基本不命中。比逐字比对便宜得多。
function similarity(t, prev) {
  if (!t || !prev) return 0;
  const width = 10;
  const probes = 6;
  const maxAt = Math.max(0, t.length - width);
  let hit = 0;
  let total = 0;
  for (let i = 0; i < probes; i += 1) {
    const at = Math.round((maxAt * i) / (probes - 1));
    total += 1;
    if (prev.indexOf(t.slice(at, at + width)) >= 0) hit += 1;
  }
  return total === 0 ? 0 : hit / total;
}

// 把一条 adapter 流原样转发给下游，同时把每一帧的「累积文本」记下来。
//
// 两种语义都要接住：
//   - 增量流（deepseek 等）：chunk.text 是新的几个字，累积自己拼。
//   - 快照流（mercury + diffusing:true）：chunk.text 是整段完整文本。
//     这种流如果原样交给累加式装配器，转录会被拼成重复的一坨，
//     所以这里识别出来只把「新增部分」往下游发，既修好转录，又留住完整帧。
function teeStream(inner, options) {
  const record = {
    provider: (options && options.provider) || '',
    model: (options && options.model) || '',
    startedAt: Date.now(),
    frames: [],
    snapshot: false,
    window: false,
    shape: 'delta',
    chunks: 0,
    seen: 0,
    emitted: 0,
    types: {},
    first: ''
  };
  TAP.calls += 1;
  if (TAP.firstCallAt === null) TAP.firstCallAt = record.startedAt;
  // 登记「正在生成」，让侧边栏能在流还没结束时就一边收帧一边播，
  // 而不是等整轮落盘之后才开始回放。
  TAP.live = { provider: record.provider, model: record.model, record: record };
  logLine('tap call #' + TAP.calls + ' ' + record.provider + '/' + record.model);
  async function* tap() {
    // 三种流形态要同时接住：
    //   · 增量流（deepseek）：每个 chunk 是接下来的几个字
    //   · 全文快照（mercury diffusing）：每个 chunk 是整篇的重绘
    //   · 滑动窗口（mercury 走 agent 时的实际形态）：chunk 起点会后退，
    //     新 chunk 以「上一块」为前缀但丢了更早的开头。这时不能直接替换，
    //     否则最早那段就没了 —— base 存着上一块之前的全部内容。
    let shown = '';
    let base = '';
    let lastT = '';
    let sent = 0;
    let prevSnapshot = '';
    let lastIndex = 0;
    let lastChunk = null;
    // mercury 的流我们总在转发口补了 diffusing:true，帧里必然夹着还没收敛的
    // 噪声字符；靠相似度猜它是不是快照流并不总是稳妥，所以对 mercury 一律缓冲，
    // 只把终稿交给下游。其它模型照旧逐段透传。
    const forceBuffer = /mercury/i.test(String(record.model));
    // mercury 单独走一条路：中间帧只记录、绝不外发，整轮只 yield 一个大块终稿。
    // 之前是在下面那个通用循环里用 continue 拦中间帧，但「接续/快照」判定和
    // sent 推进缠在同一个循环里，只要有一帧被判定成接续就会漏进转录 ——
    // 会话里那条 3610 字就是这么叠出来的。这里做物理隔离：这条分支除了最后
    // 那个 yield，没有任何别的出口。
    if (forceBuffer) {
      let frameText = '';
      let longestFrame = '';
      try {
        for await (const chunk of inner) {
          record.seen += 1;
          const ty = chunk && chunk.type ? String(chunk.type) : '(none)';
          record.types[ty] = (record.types[ty] || 0) + 1;
          if (record.first === '') {
            try { record.first = JSON.stringify(chunk).slice(0, 220); } catch (_) { record.first = '(unserializable)'; }
          }
          if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text !== '') {
            record.chunks += 1;
            record.snapshot = true;
            frameText = chunk.text;
            if (frameText.length > longestFrame.length) longestFrame = frameText;
            lastChunk = chunk;
            if (typeof chunk.index === 'number') lastIndex = chunk.index;
            pushFrame(record, frameText);
          } else if (chunk && chunk.type !== 'text-delta') {
            // block-start / block-end / usage / finish 这些要照常透传，
            // 否则转录这一块永远关不上，下游也等不到收尾信号。
            // 但 block-end 自带一个 block 对象，里面装的是 pi-ai 适配器
            // **自己攒的**文本 —— 它把每帧全文当增量拼了一遍，17 帧就是
            // 一万三千多字。装配器最后用的正是这个 block，所以只压住
            // text-delta 没用，必须在这里把它换回终稿。
            if (chunk.type === 'block-end' && chunk.block && chunk.block.type === 'text'
              && typeof chunk.block.text === 'string') {
              const resolved = frameText.length < longestFrame.length * 0.6 ? longestFrame : frameText;
              if (resolved) {
                record.emitted = resolved.length;
                yield Object.assign({}, chunk, { block: Object.assign({}, chunk.block, { text: resolved }) });
                continue;
              }
            }
            yield chunk;
          }
        }
        // 正常情况下 block-end 已经把终稿带下去了；只有上游没发 block-end
        // （或 block 不是文本块）时才走这里兜底。
        if (record.emitted === 0) {
          const finalText = frameText.length < longestFrame.length * 0.6 ? longestFrame : frameText;
          if (finalText.length > 0) {
            record.emitted = finalText.length;
            const template = lastChunk || { type: 'text-delta', index: lastIndex, text: '' };
            yield Object.assign({}, template, { text: finalText });
          }
        }
      } finally {
        commitStream(record);
        logLine('tap done #' + TAP.calls + ' rev=' + PLUGIN_REV + ' frames=' + record.frames.length + ' chunks=' + record.chunks
          + ' seen=' + record.seen + ' snapshot=' + record.snapshot
          + ' force=' + forceBuffer
          + ' emit=' + record.emitted
          + ' types=' + JSON.stringify(record.types) + ' first=' + record.first);
      }
      return;
    }
    try {
      for await (const chunk of inner) {
        record.seen += 1;
        const ty = chunk && chunk.type ? String(chunk.type) : '(none)';
        record.types[ty] = (record.types[ty] || 0) + 1;
        if (record.first === '') {
          try { record.first = JSON.stringify(chunk).slice(0, 220); } catch (_) { record.first = '(unserializable)'; }
        }
        if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') {
          const t = chunk.text;
          record.chunks += 1;
          if (typeof chunk.index === 'number') lastIndex = chunk.index;
          lastChunk = chunk;
          const same = t === lastT;
          if (!same) {
            if (forceBuffer) {
              // mercury：转发口已经补了 diffusing:true，每一帧都是整篇全文，
              // 只是还夹着没收敛的噪声字符 —— 所以既不是前缀、相似度也不高。
              // 这种流只能整段替换。之前靠「长度相近」去猜，猜错一帧就会落进
              // 下面的接续分支，把好几份全文首尾拼起来，转录和面板都会重影。
              record.snapshot = true;
              shown = t;
              base = '';
            } else if (lastT !== '' && t.startsWith(lastT)) {
              // 窗口推进：同起点、终点更远
              record.window = true;
              shown = base + t;
            } else if (lastT !== '' && similarity(t, lastT) >= 0.6
              && Math.abs(t.length - lastT.length) < lastT.length * 0.6) {
              // 去噪重绘：整篇被改写，不是前缀
              record.snapshot = true;
              shown = t;
              base = '';
            } else {
              // 接续：新内容接在已显示文本之后
              base = shown;
              shown = shown + t;
            }
            prevSnapshot = lastT;
            lastT = t;
          }
          if (same) {
            // 去噪收敛后服务端会连着推同一份全文；缓冲模式下这些也必须压住，
            // 否则每来一条重复帧就把整篇往转录里再追加一遍 —— 会话里那 19505 字
            // 就是 17 帧各自追加一次叠出来的。
            if (forceBuffer) continue;
            yield chunk;
            continue;
          }
          pushFrame(record, shown);

          let segment = '';
          if (record.snapshot && !record.window) {
            // 快照帧里混着还没收敛的噪声字符，而且后面几帧会把这些字符改掉。
            // 下游（装配器）是 append-only 的：发出去就收不回来。宁可整段压住，
            // 等流结束把终稿一次性发下去，也不让噪声漏进转录。
            segment = '';
          } else {
            segment = shown.length > sent ? shown.slice(sent) : '';
            sent = shown.length;
          }
          if (segment === '') continue;
          yield segment === t ? chunk : Object.assign({}, chunk, { text: segment });
          continue;
        }
        yield chunk;
      }
      // 缓冲模式下终稿本来就是一次到齐的，但一次性丢给装配器的话，
      // 会话里就是「干等几秒 → 整段忽然出现」。这里把终稿按块补发，
      // 让会话窗口也能逐段长出来，和侧边栏的动画基本同时进行。
      // 终稿取最长的那一帧：收尾偶尔会来一条比正文短的尾巴，
      // 直接拿最后一帧发下去会把正文截掉一截。
      let finalText = lastT;
      let longest = lastT;
      for (let i = 0; i < record.frames.length; i += 1) {
        if (record.frames[i].text.length > longest.length) longest = record.frames[i].text;
      }
      // 末帧短得离谱（收尾帧 / 截断）才退回最长帧；否则末帧就是收干净的终稿。
      if (finalText.length < longest.length * 0.6) finalText = longest;
      // 只发一块，就是最后一帧本身。之前这里把终稿切成 160 块慢慢补发，
      // 好让会话窗口也能逐段长出来；可只要下游有任何一次重发或重复消费，
      // 切出来的每一块都会再拼一遍，会话就成了十几份首尾相接。
      // 堵死这条路：整轮只 yield 一个 text-delta。
      if (record.snapshot && finalText.length > sent) {
        const tail = finalText.slice(sent);
        sent = finalText.length;
        record.emitted += tail.length;
        const template = lastChunk || { type: 'text-delta', index: lastIndex, text: '' };
        yield Object.assign({}, template, { text: tail });
      }
    } finally {
      commitStream(record);
      logLine('tap done #' + TAP.calls + ' rev=' + PLUGIN_REV + ' frames=' + record.frames.length + ' chunks=' + record.chunks
        + ' seen=' + record.seen + ' snapshot=' + record.snapshot
        + ' force=' + /mercury/i.test(String(record.model))
        + ' emit=' + record.emitted
        + ' types=' + JSON.stringify(record.types) + ' first=' + record.first);
    }
  }
  return tap();
}

const TAP_MARK = Symbol.for('dsh.mercury-preview.tap');

function installTap(ctx) {
  const llm = ctx && ctx.llm;
  if (!llm || typeof llm.streamWithRegistration !== 'function') {
    TAP.lastError = 'llm.streamWithRegistration unavailable';
    logLine('tap NOT installed: ' + TAP.lastError);
    return;
  }
  const proto = Object.getPrototypeOf(llm);
  const target = proto && typeof proto.streamWithRegistration === 'function' ? proto : llm;
  const where = target === proto ? 'prototype' : 'instance';
  if (target[TAP_MARK]) {
    TAP.installed = true;
    logLine('tap already installed on ' + where);
    return;
  }
  const original = target.streamWithRegistration;
  try {
    Object.defineProperty(target, 'streamWithRegistration', {
      configurable: true,
      writable: true,
      value: function (options, prepared) {
        const inner = original.call(this, options, prepared);
        if (inner === null || inner === undefined || typeof inner[Symbol.asyncIterator] !== 'function') return inner;
        return teeStream(inner, options);
      }
    });
    target[TAP_MARK] = original;
    TAP.installed = true;
    logLine('tap installed on ' + where + ' streamWithRegistration');
  } catch (error) {
    TAP.lastError = 'patch failed: ' + (error && error.message ? error.message : String(error));
    logLine('tap NOT installed: ' + TAP.lastError);
  }
}

// 最近一条「有帧」的流；优先 mercury —— 面板就是为它做的，
// 而且 agent 自己（deepseek-flash）每轮也会留下普通增量帧，
// 不分优先级的话，切个窗口回来就变成在放 agent 的增量流了。
function recentRecord() {
  for (let i = STREAM_RING.length - 1; i >= 0; i--) {
    if (/mercury/i.test(String(STREAM_RING[i].model)) && STREAM_RING[i].frames.length >= 2) {
      return STREAM_RING[i];
    }
  }
  for (let i = STREAM_RING.length - 1; i >= 0; i--) {
    if (STREAM_RING[i].frames.length >= 2) return STREAM_RING[i];
  }
  return null;
}

function latestPayload() {
  const record = recentRecord();
  if (record !== null) {
    return {
      source: 'frames',
      provider: record.provider,
      model: record.model,
      snapshot: record.snapshot,
      shape: record.shape,
      chunks: record.chunks,
      startedAt: record.startedAt,
      endedAt: record.endedAt,
      frames: record.frames,
      target: record.target
    };
  }
  return readLatestSessionReply();
}

function handleLocal(req, res) {
  const pathname = String(req.url || '').split('?')[0];
  if (pathname === '/local/live') {
    // 正在生成的那条流：帧数组直接引用 record.frames，边收边能读到。
    // 上一轮已经收工、而且期间 agent 又跑过几轮时，TAP.live 会指向那些
    // 普通增量流；这时回退到最近一条 mercury 记录，切窗口回来才能继续看到快照帧。
    let record = TAP.live && TAP.live.record ? TAP.live.record : null;
    if (record === null || !/mercury/i.test(String(record.model))) {
      const fallback = recentRecord();
      if (fallback !== null) record = fallback;
    }
    const body = JSON.stringify(record === null ? { active: false, count: 0, frames: [] } : {
      active: record.ended !== true,
      provider: record.provider,
      model: record.model,
      startedAt: record.startedAt,
      shape: record.snapshot ? 'snapshot' : (record.window ? 'window' : 'delta'),
      count: record.frames.length,
      frames: record.frames
    });
    res.writeHead(200, Object.assign({ 'content-type': 'application/json; charset=utf-8' }, corsFor(req)));
    res.end(body);
    return;
  }
  if (pathname === '/local/tap') {
    // live.record 里挂着完整的帧数组，直接序列化会把响应撑到几 MB；
    // 这里把帧数组换成长度，其余字段原样。
    const body = JSON.stringify(TAP, (key, value) => (
      key === 'frames' && Array.isArray(value) ? value.length : value
    ));
    res.writeHead(200, Object.assign({ 'content-type': 'application/json; charset=utf-8' }, corsFor(req)));
    res.end(body);
    return;
  }
  if (pathname === '/local/streams') {
    const body = JSON.stringify(
      STREAM_RING.map((record) => ({
        provider: record.provider,
        model: record.model,
        frames: record.frames.length,
        chunks: record.chunks,
        snapshot: record.snapshot,
        shape: record.shape,
        startedAt: record.startedAt
      }))
    );
    res.writeHead(200, Object.assign({ 'content-type': 'application/json; charset=utf-8' }, corsFor(req)));
    res.end(body);
    return;
  }
  if (pathname !== '/local/latest') {
    res.writeHead(404, Object.assign({ 'content-type': 'application/json; charset=utf-8' }, corsFor(req)));
    res.end(JSON.stringify({ error: 'unknown local route' }));
    return;
  }
  let payload = null;
  try {
    payload = latestPayload();
  } catch (error) {
    payload = { error: error && error.message ? error.message : String(error) };
  }
  const body = JSON.stringify(payload);
  res.writeHead(200, Object.assign({ 'content-type': 'application/json; charset=utf-8' }, corsFor(req)));
  res.end(body);
}

function forward(agent, req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsFor(req));
    res.end();
    return;
  }

  const headers = Object.assign({}, req.headers);
  delete headers.host;
  delete headers.connection;
  delete headers.origin;
  delete headers.referer;
  delete headers['accept-encoding'];

  // 请求体要先整段收下来：agent 自己发的那条 mercury 请求不带 diffusing，
  // 只有这里能替它补上（pi-ai 的请求构造没有透传任意 body 字段的通道）。
  const parts = [];
  let size = 0;
  let aborted = false;

  req.on('data', (part) => {
    size += part.length;
    if (size > MAX_BODY) {
      aborted = true;
      req.destroy();
      return;
    }
    parts.push(part);
  });

  req.on('error', () => { aborted = true; });

  req.on('end', () => {
    if (aborted) return;
    let body = Buffer.concat(parts);
    const injected = injectDiffusing(req, body);
    if (injected !== null) body = injected;

    const outHeaders = Object.assign({}, headers);
    outHeaders['content-length'] = String(body.length);
    if (outHeaders.authorization === undefined && outHeaders.Authorization === undefined) {
      const stored = storedKey();
      if (stored !== '') outHeaders.authorization = 'Bearer ' + stored;
      else logLine('forward: no stored credential, request goes out keyless');
    }

    const up = https.request(
      { host: TARGET_HOST, port: 443, method: req.method, path: req.url, headers: outHeaders, agent: agent },
      (upRes) => {
        const upHeaders = Object.assign({}, upRes.headers);
        delete upHeaders['access-control-allow-origin'];
        delete upHeaders['access-control-allow-credentials'];
        delete upHeaders['access-control-allow-methods'];
        delete upHeaders['access-control-allow-headers'];
        res.writeHead(upRes.statusCode, Object.assign(upHeaders, corsFor(req)));
        res.flushHeaders();
        upRes.pipe(res);
      }
    );

    up.on('error', (error) => {
      const message = error && error.message ? error.message : String(error);
      if (!res.headersSent) {
        res.writeHead(502, Object.assign({ 'content-type': 'application/json; charset=utf-8' }, corsFor(req)));
      }
      res.end(JSON.stringify({ error: 'upstream: ' + message }));
    });

    up.end(body);
  });
}

export function apply(ctx) {
  let server = null;
  try {
    const agent = new TunnelAgent({ keepAlive: true, maxSockets: 4 });
    server = http.createServer((req, res) => {
      if (req.url && req.url.indexOf('/local/') === 0) {
        handleLocal(req, res);
        return;
      }
      forward(agent, req, res);
    });
    server.on('error', (error) => {
      console.warn('[mercury-preview] forwarder unavailable on ' + LISTEN.host + ':' + LISTEN.port + ': ' + (error && error.message ? error.message : error));
    });
    server.listen(LISTEN.port, LISTEN.host, () => {
      console.log('[mercury-preview] forwarding http://' + LISTEN.host + ':' + LISTEN.port + ' -> ' + TARGET_HOST + ' via ' + UPSTREAM_PROXY.host + ':' + UPSTREAM_PROXY.port);
    });
  } catch (error) {
    console.warn('[mercury-preview] forwarder setup failed: ' + (error && error.message ? error.message : error));
  }

  if (server !== null && ctx && typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      try { server.close(); } catch (error) { /* ignore */ }
    });
  }

  // 截流：`llm.streamWithRegistration()` 是所有模型调用的唯一出口
  // （`stream()` 与 `prepareCall().stream()` 都汇到它）。
  //
  // 这里要包**原型**而不是实例：cordis 的 `ctx.llm` 是隔离副本，agent
  // 实际调用的是同原型的另一个实例，只改自己那只手收不到调用
  // （日志里 `tap call` 有记录、`chunks=0` 就是这个症状）。
  // 原型上的替换对全部实例生效；`Symbol.for` 做标记，插件重载不会反复套娃。
  installTap(ctx);
}

// 给离线测试用（`test/tap.mjs` 直接拿真实帧序列跑归一化）：
// 这两个导出对 host 运行时没有任何影响。
export { teeStream, similarity };
