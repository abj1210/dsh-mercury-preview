window.__ModuleLoader__.load({ id: "dsh-mercury-preview", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

var React = __toESM(require("react"), 1);
var h = React.createElement;

var CLIENT_ID = "dsh-mercury-preview";
var TAB_KIND = "mercury";
var LS_KEY = "dsh.mercury.key";
var LS_ENDPOINT = "dsh.mercury.endpoint";
var LS_MODEL = "dsh.mercury.model";

var ENDPOINTS = [
  { id: "openrouter", label: "OpenRouter", base: "https://openrouter.ai/api/v1", model: "inception/mercury-3" },
  { id: "official", label: "Inception 官方", base: "https://api.inceptionlabs.ai/v1", model: "mercury-3" },
  { id: "local", label: "本机转发 8799", base: "http://127.0.0.1:8799/v1", model: "mercury-3" }
];

var DEFAULT_PROMPT = "用三句话解释扩散语言模型如何在一次前向里把噪声去成一句话。";
var LS_SIM = "dsh.mercury.simulate";
var LS_FOLLOW = "dsh.mercury.follow";
var LS_INTERP = "dsh.mercury.interpolate";
var LS_SPEED = "dsh.mercury.speed";
var MAX_SEQ_FRAMES = 4000;
// /local/* 一律带这个头。它不是鉴权（谁都能加），作用是让浏览器发一次预检：
// 预检里才有 Origin，host 才能按 Origin 回不回 ACAO。没有它，请求是简单请求，
// 外部网页只要猜到端口就能把会话文本读走。
var PANEL_HEADERS = { "x-mercury-panel": "1" };

// 两段文本按位置比较，返回相同字符的数量。用来衡量一帧「离终稿还差多少」。
function sameChars(a, b) {
  var n = Math.min(a.length, b.length);
  var c = 0;
  for (var i = 0; i < n; i += 1) {
    if (a.charCodeAt(i) === b.charCodeAt(i)) c += 1;
  }
  return c;
}

// 两帧之间改动了多少字 = 位置不同的字符 + 长度差。
// 扩散流的「收敛」就体现在这个数上：早期整段改写，收尾只动几个字。
// 它比「已收敛字数」好用，后者对快照流从第一帧起就顶格，画出来是平的。
function changedChars(a, b) {
  var prev = a === undefined || a === null ? "" : String(a);
  var next = b === undefined || b === null ? "" : String(b);
  var same = sameChars(prev, next);
  return Math.max(prev.length, next.length) - same;
}
var NOISE = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#$%&*+=-_/\\|<>~^";

// 在相邻两个真帧之间补中间态：把「A 里还没收敛的字符位」按确定性顺序逐个换成 B 的字符，
// 看起来就是噪声位一点点收敛。起点与终点都是服务端真帧，中间态是沿收敛轨迹推演出来的。
function interpolateFrames(list, steps) {
  var out = [];
  for (var i = 0; i < list.length; i += 1) {
    out.push(list[i]);
    if (i + 1 >= list.length) break;
    var a = list[i];
    var b = list[i + 1];
    var len = Math.max(a.length, b.length);
    if (len === 0) continue;
    var base = a;
    if (a.length < len) {
      // 补齐必须用 b 自己的字符。早先这里拿 NOISE 随机凑长度，结果插值帧里
      // 会凭空冒出 `mk]2n`、`z__?` 这种不存在的片段 —— 会话窗口看到的是终稿
      // 所以没事，只有侧边栏的动画会露馅。
      base = a + b.slice(a.length);
    }
    var diffs = [];
    for (var k = 0; k < len; k += 1) {
      if (base.charAt(k) !== b.charAt(k)) diffs.push(k);
    }
    if (diffs.length === 0) continue;
    // 固定种子的 xorshift 洗牌：同一段文本每次重播的收敛顺序一致，不会每帧乱跳。
    var seed = (0x2545f491 + i * 7919) >>> 0;
    for (var q = diffs.length - 1; q > 0; q -= 1) {
      seed = (seed ^ (seed << 13)) >>> 0;
      seed = (seed ^ (seed >>> 17)) >>> 0;
      seed = (seed ^ (seed << 5)) >>> 0;
      var r = seed % (q + 1);
      var tmp = diffs[q];
      diffs[q] = diffs[r];
      diffs[r] = tmp;
    }
    for (var s = 1; s <= steps; s += 1) {
      var take = Math.ceil((s / steps) * diffs.length);
      var arr = base.split("");
      for (var m = 0; m < take; m += 1) arr[diffs[m]] = b.charAt(diffs[m]);
      out.push(arr.join(""));
    }
  }
  return out;
}

// 把滚动容器钉到底部。直接写 scrollTop 有时早于浏览器完成重排，
// 最后一行会停在可视区外；补一帧，等布局稳定后再钉一次。
function stickToBottom(box) {
  if (!box) return;
  box.scrollTop = box.scrollHeight;
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(function () {
      box.scrollTop = box.scrollHeight;
    });
  }
}

var CSS = [
  ".mc-wrap{display:flex;flex-direction:column;height:100%;min-height:0;font-size:13px;color:var(--dsw-alias-text-primary,#e6e9ef);background:var(--dsw-alias-bg-base,#0d1017)}",
  ".mc-form{flex:none;display:flex;flex-direction:column;gap:6px;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-subtle,rgba(255,255,255,.08))}",
  ".mc-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap}",
  ".mc-static{display:flex;align-items:center;gap:7px;padding:5px 9px;border:1px solid #1e2836;border-radius:7px;background:#0a0e14;font-size:11.5px}",
  ".mc-dot{width:6px;height:6px;border-radius:50%;background:#3fbf7f;box-shadow:0 0 5px rgba(63,191,127,.8);flex:none}",
  ".mc-static-key{color:#c9d6e8;font-weight:600;letter-spacing:.02em}",
  ".mc-static-sep{color:#48536a}",
  ".mc-static-val{color:#9fb0c8;font-family:ui-monospace,Consolas,monospace}",
  ".mc-chip{font-family:ui-monospace,Consolas,monospace;font-size:10.5px;color:#dbe7ff;background:#161f2c;border:1px solid #2b394d;border-radius:5px;padding:1px 6px}",
  ".mc-row-menus{display:flex;gap:8px;flex-wrap:wrap;align-items:flex-start}",
  ".mc-in,.mc-sel{font:inherit;font-size:12px;color:var(--dsw-alias-text-primary,#e6e9ef);background:var(--dsw-alias-bg-sunken,rgba(0,0,0,.25));border:1px solid var(--dsw-alias-border-subtle,rgba(255,255,255,.12));border-radius:6px;padding:4px 7px;outline:none}",
  ".mc-in:focus,.mc-sel:focus{border-color:var(--dsw-alias-border-strong,rgba(120,170,255,.6))}",
  ".mc-in{flex:1;min-width:120px}",
  ".mc-key{flex:1;min-width:150px;font-family:ui-monospace,Consolas,monospace}",
  ".mc-model{flex:1;min-width:150px;font-family:ui-monospace,Consolas,monospace}",
  ".mc-textarea{width:100%;box-sizing:border-box;resize:vertical;font:inherit;font-size:12.5px;line-height:1.5;color:var(--dsw-alias-text-primary,#e6e9ef);background:var(--dsw-alias-bg-sunken,rgba(0,0,0,.25));border:1px solid var(--dsw-alias-border-subtle,rgba(255,255,255,.12));border-radius:6px;padding:6px 8px;outline:none}",
  ".mc-check{display:inline-flex;align-items:center;gap:4px;font-size:12px;color:var(--dsw-alias-text-secondary,#c7ced9);cursor:pointer;user-select:none}",
  ".mc-btn{font:inherit;font-size:12px;font-weight:600;color:var(--dsw-alias-text-on-accent,#fff);background:var(--dsw-alias-accent,#3b7ddd);border:0;border-radius:6px;padding:5px 14px;cursor:pointer}",
  ".mc-btn:hover{filter:brightness(1.1)}",
  ".mc-btn:disabled{opacity:.5;cursor:default}",
  ".mc-btn-stop{background:var(--dsw-alias-danger,#c8443c)}",
  ".mc-btn-ghost{background:transparent;color:#c8d3e4;border:1px solid #33405a}",
  ".mc-note{font-size:11px;color:#7d8aa0}",
  ".mc-diag{margin:0;padding:6px 10px;font:500 11.5px/1.55 ui-monospace,Consolas,monospace;color:#9fb0c8;white-space:pre-wrap}",
  ".mc-diag.ok{color:#7fd4a3}",
  ".mc-diag.bad{color:#ff9a8f}",
  ".mc-stage{position:relative;flex:1;min-height:180px;overflow:auto;overscroll-behavior:contain;padding:14px 16px 30px;background:#080b11}",
  ".mc-text{margin:0;padding-bottom:4px;white-space:pre-wrap;word-break:break-word;color:#f6f9ff;font:500 13.5px/1.78 -apple-system,'Segoe UI',system-ui,sans-serif}",
  ".mc-hint{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:24px;text-align:center;color:#a9b4c6}",
  ".mc-hint strong{color:#eef3fb;font-weight:600;font-size:13px}",
  ".mc-foot{flex:none;display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:6px 12px;border-top:1px solid var(--dsw-alias-border-subtle,rgba(255,255,255,.08));font-size:11.5px;color:var(--dsw-alias-text-tertiary,#98a2b3)}",
  ".mc-badge{display:inline-flex;align-items:center;gap:4px;padding:1px 7px;border-radius:999px;border:1px solid var(--dsw-alias-border-subtle,rgba(255,255,255,.14));font-size:11px}",
  ".mc-badge b{font-weight:600;color:var(--dsw-alias-text-secondary,#c7ced9)}",
  ".mc-snap{color:#79c0ff}",
  ".mc-incr{color:#d2a8ff}",
  ".mc-spark{display:flex;align-items:flex-end;gap:1px;height:16px;margin-left:auto}",
  ".mc-spark i{display:block;width:3px;min-height:2px;background:var(--dsw-alias-accent,#3b7ddd);opacity:.75;border-radius:1px}",
  ".mc-spark i.syn{background:#8b96a8;opacity:.4}",
  ".mc-error{flex:none;margin:0;padding:8px 12px;font:11.5px/1.5 ui-monospace,Consolas,monospace;white-space:pre-wrap;color:#ffb4ab;background:rgba(200,68,60,.12);border-top:1px solid rgba(200,68,60,.35)}",

  // ── 对比度整体提亮 + 固定深色底：主题变量在浅色主题下会给浅灰底，
  //    配浅色字就看不清，所以这几处不再跟随主题。──
  ".mc-wrap{color:#f3f6fc;background:#0b0f16}",
  ".mc-form{background:#0f141d;border-bottom-color:#1e2735}",
  ".mc-in,.mc-sel,.mc-textarea{color:#f3f6fc;background:#070b11;border-color:#2b3444}",
  ".mc-in::placeholder,.mc-textarea::placeholder{color:#93a0b6}",
  ".mc-in:focus,.mc-sel:focus,.mc-textarea:focus{border-color:#4f7fd6;outline:none}",
  ".mc-check{color:#dde5f2}",
  ".mc-btn-ghost{color:#e4ebf7;border-color:#46556f;background:#161d28}",
  ".mc-mini{padding:2px 8px;font-size:11px;min-width:34px}",
  ".mc-mini[disabled]{opacity:.4;cursor:default}",
  ".mc-scrub{display:flex;align-items:center;gap:6px;padding:6px 10px;background:#0f141d;border-top:1px solid #1e2735;flex-wrap:wrap}",
  ".mc-mini-replay{margin-right:2px;border-color:#2f4a3c;color:#8ee0b4}",
  ".mc-mini-replay:hover{border-color:#3fbf7f;color:#c6f7da}",
  ".mc-btn[disabled],.mc-btn[disabled]:hover{opacity:.38;cursor:not-allowed;border-color:#232c3a;color:#7d8798}",
  ".mc-range[disabled]{opacity:.4}",
  ".mc-range{flex:1;min-width:50px;height:14px;accent-color:#4f7fd6;background:transparent}",
  ".mc-seek{white-space:nowrap;font-variant-numeric:tabular-nums;color:#aab7cc}",
  ".mc-speed{display:flex;align-items:center;gap:8px;margin:2px 0 6px}",
  ".mc-speed-label{font-size:11px;color:#aab7cc}",
  ".mc-sel-mini{padding:2px 6px;font-size:11px;width:auto;flex:0 0 auto}",
  ".mc-note{color:#aab7cc}",
  ".mc-diag{color:#c4d0e1}",
  ".mc-hint{color:#c8d3e3}",
  ".mc-hint strong{color:#f5f8ff}",
  ".mc-foot{color:#c4d0e1;border-top-color:#1e2735}",
  ".mc-badge{color:#d9e2f0;border-color:#2b3444}",
  ".mc-badge b{color:#e9eff9}",
  ".mc-snap{color:#8ecbff}",
  ".mc-incr{color:#dcb6ff}",
  ".mc-stat{color:#c4d0e1}",

  // ── 选项下拉：summary 做成小按钮，展开体在表单内向下铺开 ──
  ".mc-menu{position:relative;display:inline-block}",
  ".mc-menu-grow{flex:1 1 190px;min-width:0}",
  ".mc-row-menus>.mc-menu{flex:1 1 0;min-width:0}",
  ".mc-menu>summary{list-style:none;cursor:pointer;user-select:none;display:inline-flex;align-items:center;gap:5px;padding:4px 10px;border-radius:6px;font-size:12px;font-weight:500;color:#e4ebf7;background:#1b2230;border:1px solid #46556f}",
  ".mc-menu>summary::-webkit-details-marker{display:none}",
  ".mc-menu>summary::after{content:'▾';font-size:10px;color:#9fb0c8}",
  ".mc-menu[open]>summary{border-color:#5b6f92;background:#202839}",
  ".mc-menu-count{font-size:11px;color:#9fb0c8}",
  ".mc-menu-body{margin-top:6px;display:flex;flex-direction:column;gap:7px;min-width:210px;max-width:100%;box-sizing:border-box;padding:9px 11px;border-radius:8px;background:#141a24;border:1px solid #38455c;box-shadow:0 6px 18px rgba(0,0,0,.45)}",
  ".mc-menu-body .mc-check{font-size:12px;color:#dde5f2}"
].join("\n");

function icon() {
  return h("svg", { viewBox: "0 0 20 20", width: 15, height: 15, fill: "none", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round" },
    h("circle", { cx: 10, cy: 10, r: 7.2 }),
    h("path", { d: "M10 2.8v14.4M2.8 10h14.4" }),
    h("circle", { cx: 10, cy: 10, r: 2.4, fill: "currentColor", stroke: "none" })
  );
}

function readLS(key, fallback) {
  try {
    var value = window.localStorage.getItem(key);
    return value === null || value === "" ? fallback : value;
  } catch (e) {
    return fallback;
  }
}

function writeLS(key, value) {
  try {
    window.localStorage.setItem(key, value);
  } catch (e) {
    /* storage may be blocked; the field still works for this session */
  }
}

function endpointOf(id) {
  for (var i = 0; i < ENDPOINTS.length; i++) if (ENDPOINTS[i].id === id) return ENDPOINTS[i];
  return ENDPOINTS[0];
}

function extractText(json) {
  var choice = json && json.choices && json.choices[0];
  if (!choice) return "";
  var raw = null;
  if (choice.message && choice.message.content !== undefined) raw = choice.message.content;
  else if (choice.delta && choice.delta.content !== undefined) raw = choice.delta.content;
  else if (choice.text !== undefined) raw = choice.text;
  if (typeof raw === "string") return raw;
  if (raw && typeof raw.length === "number") {
    var acc = "";
    for (var i = 0; i < raw.length; i++) {
      var part = raw[i];
      if (part && typeof part.text === "string") acc += part.text;
    }
    return acc;
  }
  if (choice.message && typeof choice.message.reasoning === "string") return choice.message.reasoning;
  return "";
}

function TabBody(props) {
  var info = props && props.hooks && typeof props.hooks.tabInfo === "function" ? props.hooks.tabInfo() : (props && props.tab) || props;
  var navigation = info && info.navigation ? info.navigation : props && props.navigation;

  var keyState = React.useState(function () { return readLS(LS_KEY, ""); });
  var apiKey = keyState[0], setApiKey = keyState[1];
  // 端点和模型都固定：只有本机转发口能拿到 diffusing 真帧，模型只有 mercury-3 支持。
  // 早先把选择权留给用户，结果 localStorage 里留着的 openrouter 会让面板跑到一条
  // 永远拿不到真帧、还得手填密钥的路上。这里直接钉死。
  var endpointState = React.useState("local");
  var endpointId = endpointState[0], setEndpointId = endpointState[1];
  var modelState = React.useState("mercury-3");
  var model = modelState[0], setModel = modelState[1];
  var promptState = React.useState(DEFAULT_PROMPT);
  var prompt = promptState[0], setPrompt = promptState[1];
  var diffusingState = React.useState(true);
  var diffusing = diffusingState[0], setDiffusing = diffusingState[1];
  var simState = React.useState(function () { return readLS(LS_SIM, "1") !== "0"; });
  var simulate = simState[0], setSimulate = simState[1];
  var runningState = React.useState(false);
  var running = runningState[0], setRunning = runningState[1];
  var errorState = React.useState(null);
  var error = errorState[0], setError = errorState[1];
  var statsState = React.useState(null);
  var stats = statsState[0], setStats = statsState[1];
  var modeState = React.useState("unknown");
  var mode = modeState[0], setMode = modeState[1];
  var sparkState = React.useState([]);
  var spark = sparkState[0], setSpark = sparkState[1];
  var phaseState = React.useState("idle");
  var phase = phaseState[0], setPhase = phaseState[1];
  var diagState = React.useState(null);
  var diag = diagState[0], setDiag = diagState[1];
  var followState = React.useState(function () { return readLS(LS_FOLLOW, "1") !== "0"; });
  var follow = followState[0], setFollow = followState[1];
  var interpState = React.useState(function () { return readLS(LS_INTERP, "1") !== "0"; });
  var interp = interpState[0], setInterp = interpState[1];
  var speedState = React.useState(function () { return readLS(LS_SPEED, "1"); });
  var speed = speedState[0], setSpeed = speedState[1];
  var seekState = React.useState(null);
  var seekInfo = seekState[0], setSeekInfo = seekState[1];

  var textRef = React.useRef(null);
  var abortRef = React.useRef(null);
  var runningRef = React.useRef(false);
  var simRef = React.useRef(null);
  var followSigRef = React.useRef("");
  var liveActiveRef = React.useRef(false);
  var livePlayedAtRef = React.useRef(0);
  var pageAtRef = React.useRef(Date.now());
  var liveRoundRef = React.useRef(0);
  var histRef = React.useRef([]);
  // 播放中「上一帧已经上屏的文本」。柱状图在播放时和播放结束后必须用同一套口径，
  // 否则播放时画的是「这一帧多少字」、结束时 settleSpark 重算成「改了多少字」，
  // 播完那一瞬间整排柱子会突然变一次形。
  var markRef = React.useRef(null);
  var interpRef = React.useRef(interp);
  interpRef.current = interp;
  var lastFramesRef = React.useRef(null);
  var lastMetaRef = React.useRef(null);
  // 回放用的「帧序列 + 当前第几帧 + 基础节奏」，帧浏览和变速都靠这三个。
  var seqRef = React.useRef(null);
  // 流式播放器：收到的帧排队，按节奏逐帧画。跨 run 保存以便清理旧定时器。
  var playRef = React.useRef(null);
  var seekRef = React.useRef(0);
  var paceRef = React.useRef(60);
  var t0Ref = React.useRef(0);
  var speedRef = React.useRef(1);
  var parsed = parseFloat(speed);
  speedRef.current = isNaN(parsed) ? 1 : Math.max(0.25, Math.min(8, parsed));

  React.useEffect(function () { writeLS(LS_KEY, apiKey); }, [apiKey]);
  React.useEffect(function () { writeLS(LS_ENDPOINT, endpointId); }, [endpointId]);
  React.useEffect(function () { writeLS(LS_MODEL, model); }, [model]);
  React.useEffect(function () { writeLS(LS_SIM, simulate ? "1" : "0"); }, [simulate]);
  React.useEffect(function () { writeLS(LS_FOLLOW, follow ? "1" : "0"); }, [follow]);
  React.useEffect(function () { writeLS(LS_INTERP, interp ? "1" : "0"); }, [interp]);
  React.useEffect(function () { writeLS(LS_SPEED, speed); }, [speed]);

  React.useEffect(function () {
    return function () {
      if (abortRef.current) abortRef.current.abort();
      if (simRef.current !== null) {
        clearInterval(simRef.current);
        simRef.current = null;
      }
    };
  }, []);

  var run = React.useCallback(function () {
    if (runningRef.current) return;
    var player = null;
    var key = apiKey.trim();
    if (key === "") {
      setError("先填写 API Key。它只保存在本机 localStorage，不会随请求以外的方式外发。");
      return;
    }
    var base = endpointOf(endpointId).base;
    var chosenModel = model.trim() === "" ? endpointOf(endpointId).model : model.trim();

    setError(null);
    setRunning(true);
    setPhase("waiting");
    setStats(null);
    setMode("unknown");
    setSpark([]);
    histRef.current = [];
    runningRef.current = true;
    if (textRef.current) textRef.current.textContent = "";
    // 运行也留一份帧序列：跑完就能用同一套滑块/播放/变速翻帧，
    // 不用先"回放上一轮生成"才能拖动。
    seqRef.current = [];
    seekRef.current = 0;
    paceRef.current = 55;
    setSeekInfo(null);
    var stale = playRef.current;
    if (stale && stale.timer !== null) clearTimeout(stale.timer);
    player = { queue: [], timer: null, lastText: "", lastAt: 0, history: [], ended: false };
    playRef.current = player;
    var t0 = performance.now();
    var first = null;
    var frames = 0;
    var synFrames = 0;
    var acc = "";
    var prev = "";
    var detected = "unknown";
    var lengths = [];
    // 上一帧上屏的文本。柱状图统一画「这一帧相对上一帧改了多少字」，
    // 所以首帧不出柱子（没有可比的对象）。
    var lastShown = null;
    var controller = new AbortController();
    abortRef.current = controller;

    var target = "";
    var thr = [];
    var pMax = 0;

    var headers = { "Content-Type": "application/json", Authorization: "Bearer " + key };
    // 标出这是面板自己发的请求：本机转发会给 agent 那条 mercury 请求补
    // diffusing:true，但面板这里开关在用户手上，不能被转发口改写。
    if (endpointId !== "openrouter") {
      headers["x-mercury-panel"] = "1";
    }
    if (endpointId === "openrouter") {
      headers["HTTP-Referer"] = window.location.origin;
      headers["X-Title"] = "DSH Mercury Preview";
    }
    var body = {
      model: chosenModel,
      stream: true,
      max_tokens: 1600,
      messages: [{ role: "user", content: prompt }],
      stream_options: { include_usage: true }
    };
    if (diffusing) body.diffusing = true;

    function pumpSimulated() {
      var sbody = {
        model: chosenModel,
        max_tokens: 1600,
        messages: [{ role: "user", content: prompt }]
      };
      return fetch(base + "/chat/completions", {
        method: "POST",
        headers: headers,
        body: JSON.stringify(sbody),
        signal: controller.signal
      }).then(function (res) {
        if (!res.ok) {
          return res.text().then(function (text) {
            throw new Error("HTTP " + res.status + " — " + String(text).slice(0, 400));
          });
        }
        return res.json();
      }).then(function (json) {
        var text = extractText(json);
        target = String(text === null || text === undefined ? "" : text).trim();
        if (target === "") {
          throw new Error("响应里没有文本内容。原始返回：" + JSON.stringify(json).slice(0, 600));
        }
        first = performance.now() - t0;
        detected = "simulated";
        setPhase("streaming");
        var total = 28;
        var step = 0;
        thr = new Array(target.length);
        for (var i = 0; i < target.length; i++) thr[i] = Math.pow(Math.random(), 0.7);
        simRef.current = setInterval(function () {
          step += 1;
          pMax = step / total;
          var out = "";
          var right = 0;
          for (var j = 0; j < target.length; j++) {
            if (pMax >= thr[j]) {
              out += target.charAt(j);
              right += 1;
            } else {
              out += NOISE.charAt((Math.random() * NOISE.length) | 0);
            }
          }
          paint(out);
          if (seqRef.current.length < MAX_SEQ_FRAMES) seqRef.current.push(out);
          frames = step;
          lengths.push(right);
          if (lengths.length > 96) lengths.shift();
          publish(step >= total);
          if (step >= total) {
            clearInterval(simRef.current);
            simRef.current = null;
            paint(target);
            setPhase("done");
            setRunning(false);
            runningRef.current = false;
            abortRef.current = null;
            finishSeq();
          }
        }, 55);
      });
    }

    if (simulate) {
      pumpSimulated().catch(function (e) {
        if (simRef.current !== null) {
          clearInterval(simRef.current);
          simRef.current = null;
        }
        if (e && e.name === "AbortError") {
          setPhase("idle");
        } else {
          setError(e && e.message ? e.message : String(e));
          setPhase("error");
        }
        setRunning(false);
        runningRef.current = false;
        abortRef.current = null;
      });
      return;
    }

    // 柱状图收尾：改画「这一帧已经和终稿一致的字数」。
    // 快照帧长度几乎不变（82 / 82 / 85），画字数就是一排等高柱子；
    // 画收敛字数才是从低到高爬上去的。
    // 终稿取最长的那一帧：流末尾偶尔还会补一帧和前一帧相同的收尾帧，
    // 或者插值帧没走完，直接拿最后一帧会把基准钉在短文本上，
    // 于是最后两根柱子被压得过低。

    // diffusing 的帧是服务端算完才一起吐出来的（实测三帧间隔 979ms / 1ms / 3ms），
    // 到一帧就画一帧的话画面会直接跳到终稿，什么动画都看不见。
    // 所以收到的帧先排队，再由一个固定节奏的播放器逐帧取出来画：
    // 迟到多少帧都不会丢，画面按节奏一点点收敛。
    // 注：player 在本次 run 开头赋值，跨 run 用 playRef 记住以便清理旧定时器。

    function playMs() {
      var s = speedRef.current || 1;
      // 队列积压说明帧到得比播得快，加快节奏追上去，别让画面越拖越远。
      if (player.queue.length > 80) return 12;
      if (player.queue.length > 24) return 24;
      return Math.max(12, Math.round(55 / s));
    }

    function kickPlayer() {
      if (player.timer !== null) return;
      // 用 setTimeout 递归而不是 setInterval：每次取帧前重新算节奏，
      // 队列积压时能立刻提速。
      player.timer = setTimeout(function () {
        player.timer = null;
        if (player.queue.length === 0) {
          if (player.ended) finishSeq();
          return;
        }
        var item = player.queue.shift();
        if (item.text !== player.lastText) {
          player.lastText = item.text;
          paint(item.text);
          if (item.synthetic) synFrames += 1;
          else frames += 1;
          if (player.history.length > 0) {
            lengths.push(changedChars(player.history[player.history.length - 1].v, item.text));
            if (lengths.length > 96) lengths.shift();
          }
          player.history.push({ v: item.text, s: item.synthetic });
          if (player.history.length > 512) player.history.shift();
          publish(player.ended && player.queue.length === 0);
        }
        kickPlayer();
      }, playMs());
    }

    // 插值补在真帧之间；补几帧按「这两个真帧真实间隔了多久」来定，
    // 真帧隔得久就多补几帧，隔得极近（快照帧常在 1–3ms 内连发）就退回固定步数，
    // 否则动画连一帧都来不及显示。
    function pushPlay(text) {
      if (typeof text !== "string" || text === "") return;
      var atNow = Date.now();
      if (text === player.lastText && player.queue.length === 0) return;
      if (interpRef.current && player.lastText !== "" && text !== player.lastText) {
        var gap = player.lastAt === 0 ? 0 : Math.max(0, atNow - player.lastAt);
        var steps = gap > 60 ? Math.max(1, Math.min(24, Math.round(gap / 45))) : 6;
        var mids = interpolateFrames([player.lastText, text], steps);
        for (var i = 1; i < mids.length - 1; i += 1) player.queue.push({ text: mids[i], synthetic: true });
      }
      player.queue.push({ text: text, synthetic: false });
      player.lastText = text;
      player.lastAt = atNow;
      if (player.queue.length > 8000) player.queue.splice(0, player.queue.length - 8000);
      kickPlayer();
    }

    function publish(done) {
      setStats({
        frames: frames,
        interp: synFrames,
        first: first,
        elapsed: performance.now() - t0,
        chars: target.length > 0 ? target.length : prev.length,
        done: done === true
      });
      setMode(detected);
      setSpark(lengths.slice(-48));
    }

    fetch(base + "/chat/completions", {
      method: "POST",
      headers: headers,
      body: JSON.stringify(body),
      signal: controller.signal
    }).then(function (res) {
      if (!res.ok) {
        return res.text().then(function (text) {
          throw new Error("HTTP " + res.status + " — " + String(text).slice(0, 400));
        });
      }
      if (!res.body) throw new Error("响应没有可读的 body，无法流式读取。");
      setPhase("streaming");
      var reader = res.body.getReader();
      var decoder = new TextDecoder();
      var buffer = "";

      function consume(chunkText) {
        buffer += chunkText;
        var cut;
        while ((cut = buffer.indexOf("\n\n")) >= 0) {
          var raw = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          var lines = raw.split("\n");
          for (var i = 0; i < lines.length; i++) {
            var line = lines[i];
            if (line.charCodeAt(0) === 58) continue;
            if (line.indexOf("data:") !== 0) continue;
            var payload = line.slice(5).trim();
            if (payload === "" || payload === "[DONE]") continue;
            var json = null;
            try { json = JSON.parse(payload); } catch (e) { continue; }
            var choice = json && json.choices && json.choices[0];
            var delta = choice && choice.delta ? choice.delta.content : null;
            if (typeof delta !== "string" || delta.length === 0) continue;
            frames += 1;
            if (first === null) first = performance.now() - t0;
            acc += delta;
            // mercury 的 diffusing 帧每帧都是整篇全文，直接按快照处理。
            // 原来靠「这帧是不是比上帧长」来猜：去噪会把噪声字符收敛掉，
            // 正文常常比上一帧短，一猜错就落到增量分支，把十几份全文首尾拼起来。
            var isMercury = /mercury/i.test(String(model || ""));
            if (isMercury) detected = "snapshot";
            else if (detected === "unknown" && prev.length > 0) {
              if (delta === acc) detected = "snapshot";
              else if (delta.indexOf(prev) === 0) detected = "incremental";
              else detected = delta.length >= prev.length ? "snapshot" : "incremental";
            }
            prev = delta;
            target = isMercury ? delta : acc;
            var shown = isMercury ? delta : (detected === "incremental" ? acc : delta);
            if (!simulate || detected === "snapshot") pushPlay(shown);
            if (seqRef.current.length < MAX_SEQ_FRAMES) seqRef.current.push(shown);
            if (lastShown !== null) {
              lengths.push(changedChars(lastShown, shown));
              if (lengths.length > 96) lengths.shift();
            }
            lastShown = shown;
            if (frames === 1 || frames % 2 === 0) publish(false);
          }
        }
      }

      function pump() {
        return reader.read().then(function (step) {
          if (step.done) {
            if (simRef.current !== null) {
              clearInterval(simRef.current);
              simRef.current = null;
            }
            if (simulate && target.length > 0) paint(target);
            publish(true);
            setPhase("done");
            setRunning(false);
            runningRef.current = false;
            abortRef.current = null;
            // 帧还在队列里没播完，滑块等播放器排空后再交出去。
            player.ended = true;
            kickPlayer();
            return;
          }
          consume(decoder.decode(step.value, { stream: true }));
          return pump();
        });
      }
      return pump();
    }).catch(function (e) {
      if (simRef.current !== null) {
        clearInterval(simRef.current);
        simRef.current = null;
      }
      if (e && e.name === "AbortError") {
        setPhase("idle");
      } else {
        setError(e && e.message ? e.message : String(e));
        setPhase("error");
      }
      // 出错/中止时也把已经收到的帧交给回放控件，别让它们白丢。
      if (player !== null) {
        player.ended = true;
        if (player.timer !== null) {
          clearTimeout(player.timer);
          player.timer = null;
        }
      }
      finishSeq();
    }).then(function () {
      if (runningRef.current) {
        setRunning(false);
        runningRef.current = false;
        abortRef.current = null;
      }
    });
  }, [apiKey, endpointId, model, prompt, diffusing, simulate]);

  var stop = React.useCallback(function () {
    if (abortRef.current) abortRef.current.abort();
  }, []);

  var probe = React.useCallback(function () {
    var ep = endpointOf(endpointId);
    var key = apiKey.trim();
    var headers = {};
    if (key !== "") headers.Authorization = "Bearer " + key;
    var lines = [];
    var results = {};
    setDiag({ ok: false, text: "探测中…" });
    function publish() {
      setDiag({ ok: results.official && results.official.ok, text: lines.join("\n") });
    }
    function mark(name, ok, text) {
      results[name] = { ok: ok, text: text };
      lines.push(text);
      if (Object.keys(results).length === 3) {
        if (results.official.ok) lines.push("→ 官方端点在浏览器里可直连，CORS 放行。");
        else if (results.nocors.ok) lines.push("→ 网络可达但被 CORS 拦：需要 host 侧转发。");
        else lines.push("→ 网络不可达：浏览器没走代理（或代理不通）。");
      }
      publish();
    }
    fetch(ep.base + "/models", { method: "GET", headers: headers })
      .then(function (res) { mark("official", res.ok, "官方 CORS 模式：HTTP " + res.status); })
      .catch(function (e) { mark("official", false, "官方 CORS 模式：失败（" + (e && e.message ? e.message : e) + "）"); });
    fetch(ep.base + "/models", { method: "GET", mode: "no-cors" })
      .then(function (res) { mark("nocors", true, "官方 no-cors 模式：通（type=" + res.type + "）"); })
      .catch(function (e) { mark("nocors", false, "官方 no-cors 模式：失败（" + (e && e.message ? e.message : e) + "）"); });
    fetch("https://openrouter.ai/api/v1/models", { method: "GET" })
      .then(function (res) { mark("control", res.ok, "对照 OpenRouter：HTTP " + res.status); })
      .catch(function () { mark("control", false, "对照 OpenRouter：失败"); });
  }, [apiKey, endpointId]);

  // ── 回放控制：帧序列 / 当前帧 / 变速 ───────────────────────────────
  // 帧浏览和播放共用一个定时器（simRef），所以「拖动滑块 = 暂停并定位」，
  // 「点播放 = 从当前帧接着走」。

  // 单帧上屏。放在这里而不是某个 useCallback 里面，因为播放、回放、
  // 拖动滑块三条路径都要用它——之前它定义在 run 的闭包里，另两条路径
  // 一调用就是 ReferenceError: paint is not defined。
  // 纯文本整段替换。markdown 渲染试过一轮：逐帧重排时 `#`、`**`、``` 这些
  // 语法字符会在收敛过程中反复跳变（先是普通段落，补个空格就变成标题），
  // 观感比原文更乱，所以撤掉，只留这个纯文本版本。
  function paint(shown) {
    if (!textRef.current) return;
    textRef.current.classList.remove("md");
    textRef.current.textContent = shown === undefined || shown === null ? "" : String(shown);
    stickToBottom(textRef.current.parentElement);
  }

  // 柱状图改成画「每一帧相对上一帧改动了多少字」。
  // 原先是画「已收敛字数」，但快照流每帧都是整篇全文，从第一帧起
  // 就和终稿一样长 —— 整排柱子一样高，什么也看不出来。
  // 改画改写量之后，去噪早期的改写多、收尾的改写少，形状才有意义。
  // 同样提到 TabBody 层：播放结束（startTimer）与 run 都要调它。
  function settleSpark() {
    var hist = histRef.current;
    if (!hist || hist.length < 2) return;
    var values = [];
    for (var i = 1; i < hist.length; i += 1) {
      values.push({ v: changedChars(hist[i - 1].v, hist[i].v), s: hist[i].s });
    }
    // 整排一样高（比如每帧都是同一份全文）就别画了，画出来是误导。
    var flat = true;
    for (var j = 1; j < values.length; j += 1) {
      if (values[j].v !== values[0].v) { flat = false; break; }
    }
    if (flat) {
      setSpark([]);
      return;
    }
    setSpark(values.slice(-48));
  }

  // 跑完后把这一轮的帧序列交给回放控件，滑块/播放/变速都复用同一套。
  function finishSeq() {
    var seq = seqRef.current;
    if (!seq || seq.length === 0) return;
    seekRef.current = seq.length;
    setSeekInfo({ index: seq.length, total: seq.length, chars: seq[seq.length - 1].length });
    settleSpark();
  }

  function showFrame(i) {
    var seq = seqRef.current;
    if (!seq || seq.length === 0) return undefined;
    var k = Math.min(Math.max(1, i), seq.length);
    seekRef.current = k;
    var text = seq[k - 1];
    paint(text);
    markRef.current = text;
    setSeekInfo({ index: k, total: seq.length, chars: text.length });
    return text;
  }

  function stopPlayback() {
    if (simRef.current !== null) {
      clearInterval(simRef.current);
      simRef.current = null;
    }
    runningRef.current = false;
    setRunning(false);
  }

  function startTimer() {
    if (simRef.current !== null) {
      clearInterval(simRef.current);
      simRef.current = null;
    }
    var seq = seqRef.current;
    if (!seq || seq.length === 0) return;
    var ms = Math.max(8, Math.round(paceRef.current / speedRef.current));
    simRef.current = setInterval(function () {
      var current = seqRef.current;
      if (!current) return;
      var next = seekRef.current + 1;
      if (next > current.length) {
        // 流还没结束：停在最后一帧等下一批，别急着收摊。
        if (liveActiveRef.current) return;
        stopPlayback();
        setPhase("done");
        return;
      }
      // 和 settleSpark 同一口径：这一帧相对「上一帧已上屏的文本」改了多少字。
      // 第一帧没有前一帧，就不出柱子——settleSpark 也是从 hist[1] 开始算的。
      var before = markRef.current;
      var text = showFrame(next);
      if (text === undefined) return;
      histRef.current.push({ v: text, s: false });
      if (histRef.current.length > 512) histRef.current.shift();
      var done = next >= current.length && !liveActiveRef.current;
      setStats({ frames: next, first: null, elapsed: performance.now() - t0Ref.current, chars: text.length, done: done });
      if (before !== null && before !== text) {
        var bar = { v: changedChars(before, text), s: false };
        setSpark(function (prev) {
          var out = prev.concat([bar]);
          return out.length > 48 ? out.slice(out.length - 48) : out;
        });
      }
      if (done) {
        settleSpark();
        stopPlayback();
        setPhase("done");
      }
    }, ms);
  }

  function beginPlayback(seq, pace, mode) {
    if (abortRef.current) abortRef.current.abort();
    if (simRef.current !== null) {
      clearInterval(simRef.current);
      simRef.current = null;
    }
    setError(null);
    setRunning(true);
    runningRef.current = true;
    setPhase("streaming");
    setMode(mode);
    setSpark([]);
    histRef.current = [];
    markRef.current = null;
    seqRef.current = seq;
    paceRef.current = pace;
    t0Ref.current = performance.now();
    setStats({ frames: 0, first: null, elapsed: 0, chars: seq[0].length, done: false });
    showFrame(1);
    startTimer();
  }

  function seekTo(i) {
    if (!seqRef.current) return;
    stopPlayback();
    setPhase("done");
    showFrame(i);
  }

  function stepBy(delta) {
    if (!seqRef.current) return;
    seekTo(seekRef.current + delta);
  }

  function togglePlay() {
    var seq = seqRef.current;
    if (!seq) return;
    if (runningRef.current) {
      stopPlayback();
      setPhase("done");
      return;
    }
    if (seekRef.current >= seq.length) showFrame(1);
    setRunning(true);
    runningRef.current = true;
    setPhase("streaming");
    t0Ref.current = performance.now();
    startTimer();
  }

  // 改速度时，如果正在播就按新节奏接着播（不用从头开始）。
  function applySpeed(value) {
    setSpeed(value);
    var parsed = parseFloat(value);
    speedRef.current = isNaN(parsed) ? 1 : Math.max(0.25, Math.min(8, parsed));
    if (runningRef.current && seqRef.current) startTimer();
  }

  var replayText = React.useCallback(function (raw) {
    var target = String(raw === null || raw === undefined ? "" : raw).trim();
    if (target === "") {
      setError("没有取到可回放的文本。");
      return;
    }
    if (target.length > 1200) target = target.slice(0, 1200) + "…";
    if (abortRef.current) abortRef.current.abort();
    if (simRef.current !== null) {
      clearInterval(simRef.current);
      simRef.current = null;
    }
    setError(null);
    setRunning(true);
    runningRef.current = true;
    setPhase("streaming");
    setMode("simulated");
    setSpark([]);
    histRef.current = [];
    seqRef.current = null;
    setSeekInfo(null);
    if (textRef.current) textRef.current.textContent = "";
    var t0 = performance.now();
    var total = 30;
    var step = 0;
    var thr = new Array(target.length);
    for (var i = 0; i < target.length; i++) thr[i] = Math.pow(Math.random(), 0.7);
    setStats({ frames: 0, first: null, elapsed: 0, chars: target.length, done: false });
    simRef.current = setInterval(function () {
      step += 1;
      var pMax = step / total;
      var out = "";
      var right = 0;
      for (var j = 0; j < target.length; j++) {
        if (pMax >= thr[j]) {
          out += target.charAt(j);
          right += 1;
        } else {
          out += NOISE.charAt((Math.random() * NOISE.length) | 0);
        }
      }
      if (textRef.current) {
        textRef.current.textContent = out;
        var box = textRef.current.parentElement;
        stickToBottom(box);
      }
      setStats({ frames: step, first: null, elapsed: performance.now() - t0, chars: target.length, done: step >= total });
      setSpark(function (prev) {
        var next = prev.concat([right]);
        return next.length > 48 ? next.slice(next.length - 48) : next;
      });
      if (step >= total) {
        clearInterval(simRef.current);
        simRef.current = null;
        paint(target);
        setPhase("done");
        setRunning(false);
        runningRef.current = false;
      }
    }, Math.max(10, Math.round(55 / speedRef.current)));
  }, []);

  var replayFrames = React.useCallback(function (frames, meta) {
    var list = [];
    var span = 0;
    for (var i = 0; i < frames.length; i++) {
      var frame = frames[i];
      if (frame && typeof frame.text === "string" && frame.text !== "") {
        list.push(frame.text);
        span += typeof frame.dt === "number" && frame.dt > 0 ? frame.dt : 0;
      }
    }
    if (list.length === 0) {
      setError("没有可回放的帧。");
      return;
    }
    if (list.length === 1) {
      replayText(list[0]);
      return;
    }
    var didInterp = false;
    if (interpRef.current && meta && meta.snapshot) {
      var expanded = interpolateFrames(list, 8);
      if (expanded.length > list.length) {
        list = expanded;
        didInterp = true;
      }
    }
    var stride = didInterp ? 1 : Math.ceil(list.length / 120);
    var seq = [];
    for (var j = 0; j < list.length; j += stride) seq.push(list[j]);
    if (seq[seq.length - 1] !== list[list.length - 1]) seq.push(list[list.length - 1]);
    // 有真实帧间隔就按原节奏播（太快或太慢时收进 [10, 90] ms），
    // 没有就按帧数把整段压到三秒左右。速度倍率在 startTimer 里再除。
    var pace = didInterp
      ? 55
      : (span > 0
        ? Math.max(10, Math.min(90, Math.round(span / seq.length)))
        : Math.max(14, Math.min(70, Math.round(3200 / seq.length))));
    beginPlayback(seq, pace, didInterp
      ? "interp"
      : (meta && meta.shape === "window"
        ? "window"
        : (meta && meta.snapshot ? "snapshot" : "replay")));
  }, []);

  var loadLatest = React.useCallback(function (auto) {
    if (!auto) setDiag({ ok: false, text: "正在读取…" });
    fetch("http://127.0.0.1:8799/local/latest", { method: "GET", headers: PANEL_HEADERS })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function (json) {
        if (!json || json.error) throw new Error(json && json.error ? json.error : "没有返回");
        var sig = String(json.sessionId || "") + ":" + String(json.time || "") + ":" + (json.frames ? json.frames.length : 0);
        if (auto && sig === followSigRef.current) return;
        // 刚刚走实时截流播过这一轮，就别再用落盘的会话记录重播一遍。
        if (auto && Date.now() - livePlayedAtRef.current < 12000) {
          followSigRef.current = sig;
          return;
        }
        // 自动跟随只跟 mercury 系模型的轮次：否则面板会把 agent 自己（deepseek-flash）
        // 刚说完的回复再放一遍，看起来就像「输出了上一轮答案」。
        if (auto && String(json.model || "").toLowerCase().indexOf("mercury") < 0) {
          followSigRef.current = sig;
          return;
        }
        if (auto && runningRef.current) return;
        if (json.frames && json.frames.length >= 2) {
          followSigRef.current = sig;
          lastFramesRef.current = json.frames;
          lastMetaRef.current = json;
          var who = json.provider ? " · " + json.provider + (json.model ? " / " + json.model : "") : "";
          setDiag({
            ok: true,
            text: (json.shape === "window" ? "窗口帧 " : (json.snapshot ? "真快照帧 " : "增量帧 ")) + json.frames.length + who + (json.source === "session-stream" ? " · 会话记录" : "") + (auto ? " · 自动跟随" : "")
          });
          replayFrames(json.frames, json);
          return;
        }
        if (!json.text) throw new Error("没有可回放的内容");
        followSigRef.current = sig;
        setDiag({ ok: true, text: "会话记录 · " + json.text.length + " 字" });
        replayText(json.text);
      })
      .catch(function (e) {
        if (auto) return;
        var why = e && e.message ? String(e.message) : String(e);
        // 浏览器对「连不上」只给一句 Failed to fetch，看不出是端口没起还是被 CORS 拦，
        // 这里补一句能指向动作的话。
        if (!e || /failed to fetch/i.test(why)) {
          why = "连不上本机转发 127.0.0.1:8799 · 重启 DSH 后重试";
        }
        setDiag({ ok: false, text: "读取失败 · " + why });
      });
  }, [replayFrames, replayText]);

  var grabSession = React.useCallback(function () { loadLatest(false); }, [loadLatest]);

  // 实时跟随：直接读 host 正在生成的那条流。
  // 会话文件得等整轮结束才落盘，走那条路只能事后回放；
  // 这条走 /local/live，帧一到就能播，会话窗口和侧边栏并排着长。
  var followLive = React.useCallback(function () {
    fetch("http://127.0.0.1:8799/local/live", { method: "GET", cache: "no-store", headers: PANEL_HEADERS })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (json) {
        if (!json || typeof json !== "object") return;
        liveActiveRef.current = json.active === true;
        if (!json.frames || json.frames.length === 0) return;
        if (!/mercury/i.test(String(json.model || ""))) return;
        var round = Number(json.startedAt || 0);
        // 切会话 / 刚打开面板时，/local/live 返回的是上一轮已经结束的流。
        // 那种「历史」不该自动播 —— 只播本页打开之后才开始的轮次。
        if (round > 0 && round < pageAtRef.current - 1500) {
          liveRoundRef.current = round;
          return;
        }
        if (round !== liveRoundRef.current) {
          liveRoundRef.current = round;
          seqRef.current = [];
          // 新一轮：把上一轮还在播的帧和柱子都清掉，否则柱子会接在旧的后面。
          if (runningRef.current) stopPlayback();
          histRef.current = [];
          setSpark([]);
        }
        var texts = [];
        for (var i = 0; i < json.frames.length; i += 1) {
          var item = json.frames[i];
          if (item && typeof item.text === "string" && item.text !== "" && texts[texts.length - 1] !== item.text) {
            texts.push(item.text);
          }
        }
        if (texts.length === 0) return;
        var known = seqRef.current ? seqRef.current.length : 0;
        if (texts.length < known) { seqRef.current = []; known = 0; }
        if (texts.length <= known) return;
        var shape = json.shape === "snapshot" ? "snapshot" : "replay";
        if (runningRef.current) {
          // 正在播：续上新帧，定时器下一次取帧自然接得上。
          seqRef.current = seqRef.current.concat(texts.slice(known));
          if (shape === "snapshot") setMode("snapshot");
          return;
        }
        livePlayedAtRef.current = Date.now();
        var who = (json.provider || "") + (json.model ? " / " + json.model : "");
        setDiag({
          ok: true,
          text: (json.shape === "snapshot" ? "真快照帧 " : "实时截流 ") + texts.length
            + (who ? " · " + who : "") + " · 自动跟随"
        });
        beginPlayback(texts, 60, shape);
      })
      .catch(function () { liveActiveRef.current = false; });
  }, []);

  // 切换「帧间插值」时，用同一批原始帧立刻重播一遍 —— 原始帧一直留着，
  // 所以随时能在「真帧原样」和「插值演出」之间来回对比。
  React.useEffect(function () {
    var frames = lastFramesRef.current;
    if (!frames || frames.length < 2) return;
    replayFrames(frames, lastMetaRef.current);
  }, [interp, replayFrames]);

  // 自动跟随：只跟 host 正在生成的那条流。/local/live 取不到就什么都不播，
  // 不再退回去读会话文件 —— 那样会在切会话、刷新页面时把上一轮重播一遍。
  React.useEffect(function () {
    if (!follow) return undefined;
    followLive();
    var live = setInterval(function () { followLive(); }, 380);
    return function () {
      clearInterval(live);
    };
  }, [follow, followLive]);

  var modeBadge = mode === "snapshot"
    ? h("span", { className: "mc-badge mc-snap" }, h("b", null, "扩散快照"), " 每帧整段替换")
    : mode === "interp"
      ? h("span", { className: "mc-badge mc-snap" }, h("b", null, "扩散插值"), " 真帧为起终点 · 中间态为推演")
      : mode === "window"
        ? h("span", { className: "mc-badge mc-snap" }, h("b", null, "服务端窗口帧"), " 每帧从固定起点扩展 · 开头已补齐")
        : mode === "replay"
          ? h("span", { className: "mc-badge mc-snap" }, h("b", null, "增量重放"), " 服务端真帧 · 逐块累积")
          : mode === "simulated"
            ? h("span", { className: "mc-badge mc-incr" }, h("b", null, "模拟去噪"), " 本地演出 · 非服务端帧")
            : mode === "incremental"
              ? h("span", { className: "mc-badge mc-incr" }, h("b", null, "增量流"), " 服务端逐块返回")
              : h("span", { className: "mc-badge" }, h("b", null, phase === "waiting" && simulate ? "生成全文" : "等待首帧"));

  // 柱子高度要按最大值归一化。spark 里的元素既可能是裸数字，也可能是
  // { v, s }（s 标记这一根是插值帧），所以这里必须把两种情况都取出来——
  // 早先只比较 spark[i] 本身，对象永远比不过数字，maxLen 恒为 1，
  // 于是每根柱子都算成 100% 以上、被容器裁成一模一样高。
  var maxLen = 1;
  for (var i = 0; i < spark.length; i++) {
    var barValue = typeof spark[i] === 'number' ? spark[i] : spark[i].v;
    if (barValue > maxLen) maxLen = barValue;
  }

  var stage = h("div", { className: "mc-stage" },
    h("div", { className: "mc-text", ref: textRef }),
    phase === "idle" && stats === null
      ? h("div", { className: "mc-hint" },
        h("strong", null, "Mercury 3 扩散预览"),
        h("span", null, "这个面板自己直连接口，把每一帧当成全文重画 —— 聊天转录做不到这一点，它只会把 delta 往后追加。"),
        h("span", null, "「去噪演出」会先取回全文，再让整段文字从噪声同步收敛到原文 —— 这是本地效果，不是服务端的去噪帧。想要真帧，需要支持 diffusing 的端点。"))
      : null
  );

  return h("div", { className: "mc-wrap" },
    h("div", { className: "mc-form" },
      // 端点与模型都固定了：只有本机转发口能拿到 diffusing 真帧
      // （OpenRouter 丢弃该参数，官方直连在浏览器里过不了 CORS），
      // 模型也只有 mercury-3 支持。这里做成一条状态栏，不再占输入控件。
      h("div", { className: "mc-static", title: "端点和模型都已固定；要换请在代码里改 ENDPOINTS" },
        h("span", { className: "mc-dot" }),
        h("span", { className: "mc-static-key" }, endpointOf(endpointId).label),
        h("span", { className: "mc-static-sep" }, "·"),
        h("span", { className: "mc-chip" }, model)
      ),
      h("div", { className: "mc-row mc-row-menus" },
        h("details", { className: "mc-menu" },
          h("summary", null,
            "选项",
            h("span", { className: "mc-menu-count" }, String([simulate, follow, interp].filter(Boolean).length) + "/3")
          ),
          h("div", { className: "mc-menu-body" },
            h("div", { className: "mc-speed" },
              h("span", { className: "mc-speed-label" }, "回放速度"),
              h("select", {
                className: "mc-sel mc-sel-mini",
                value: speed,
                onChange: function (e) { applySpeed(e.target.value); }
              },
                [["0.25", "0.25× 慢放"], ["0.5", "0.5×"], ["1", "1× 原速"], ["2", "2×"], ["4", "4× 快进"]].map(function (pair) {
                  return h("option", { key: pair[0], value: pair[0] }, pair[1]);
                })
              )
            ),
            h("label", { className: "mc-check", title: "不请求流式，先取回全文，再用随机噪声把整段演一遍" },
              h("input", { type: "checkbox", checked: simulate, onChange: function (e) { setSimulate(e.target.checked); } }),
              "本地去噪演出"
            ),
            h("label", { className: "mc-check", title: "只跟随 mercury 系模型：每完成一轮就把它的真帧自动播一遍" },
              h("input", { type: "checkbox", checked: follow, onChange: function (e) { setFollow(e.target.checked); } }),
              "自动跟随本会话"
            ),
            h("label", { className: "mc-check", title: "在相邻真帧之间补字符级中间态（起点终点仍是服务端真帧）" },
              h("input", { type: "checkbox", checked: interp, onChange: function (e) { setInterp(e.target.checked); } }),
              "帧间插值"
            )
          )
        ),
        // 提示词、测试/运行、回放都收进这个下拉：面板默认只留两行摘要，
        // 展开哪一格就改哪一格，不用天天面对一整排控件。
        h("details", { className: "mc-menu mc-menu-grow" },
          h("summary", null,
            "输入",
            h("span", { className: "mc-menu-count" },
              prompt.length > 0 ? String(prompt.length) + " 字" : "空")
          ),
          h("div", { className: "mc-menu-body" },
            h("textarea", {
              className: "mc-textarea",
              rows: 2,
              value: prompt,
              spellCheck: false,
              onChange: function (e) { setPrompt(e.target.value); }
            }),
            h("div", { className: "mc-row" },
              endpointId === "local" ? null : h("input", {
                className: "mc-in mc-key",
                type: "password",
                value: apiKey,
                spellCheck: false,
                autoComplete: "off",
                onChange: function (e) { setApiKey(e.target.value); },
                placeholder: "API Key（sk-… / sk-or-v1-…）"
              }),
              h("button", {
                type: "button",
                className: "mc-btn mc-btn-ghost",
                onClick: probe
              }, "测试"),
              h("button", {
                type: "button",
                className: running ? "mc-btn mc-btn-stop" : "mc-btn",
                onClick: running ? stop : run,
                disabled: false
              }, running ? "停止" : "运行")
            )
          )
        )
      )
    ),
    stage,
    // 播放条常驻：还没跑过任何东西时按钮置灰，但位置不跳。
    // 「回放上一轮生成」也挪进来了——它本身就是一种播放，放在播放条上更顺。
    h("div", { className: "mc-scrub" },
      h("button", {
        type: "button",
        className: "mc-btn mc-btn-ghost mc-mini mc-mini-replay",
        title: "回放上一轮生成：截流自 llm/stream，服务端真帧优先，没有就用会话记录",
        onClick: grabSession
      }, "⏮ 回放"),
      h("button", {
        type: "button",
        className: "mc-btn mc-btn-ghost mc-mini",
        title: "上一帧",
        disabled: seekInfo === null || seekInfo.index <= 1,
        onClick: function () { stepBy(-1); }
      }, "◀"),
      h("button", {
        type: "button",
        className: "mc-btn mc-btn-ghost mc-mini",
        title: running ? "暂停在当前帧" : "从当前帧继续",
        disabled: seekInfo === null,
        onClick: togglePlay
      }, running ? "暂停" : "播放"),
      h("button", {
        type: "button",
        className: "mc-btn mc-btn-ghost mc-mini",
        title: "下一帧",
        disabled: seekInfo === null || seekInfo.index >= seekInfo.total,
        onClick: function () { stepBy(1); }
      }, "▶"),
      h("input", {
        type: "range",
        className: "mc-range",
        min: 1,
        max: seekInfo === null ? 1 : seekInfo.total,
        step: 1,
        value: seekInfo === null ? 1 : seekInfo.index,
        disabled: seekInfo === null,
        onChange: function (e) { seekTo(parseInt(e.target.value, 10)); }
      }),
      h("span", { className: "mc-note mc-seek" },
        seekInfo === null
          ? "暂无帧"
          : "第 " + seekInfo.index + " / " + seekInfo.total + " 帧 · " + seekInfo.chars + " 字")
    ),
    diag === null ? null : h("pre", { className: "mc-diag" + (diag.ok ? " ok" : " bad") }, diag.text),
    error === null ? null : h("pre", { className: "mc-error" }, error),
    h("div", { className: "mc-foot" },
      modeBadge,
      stats === null ? null : h("span", null, "真帧 " + stats.frames
        + (stats.interp > 0 ? " · 插值 " + stats.interp : "")),
      stats === null || stats.first === null ? null : h("span", null, "首帧 " + Math.round(stats.first) + " ms"),
      stats === null ? null : h("span", null, "字符 " + stats.chars),
      stats === null ? null : h("span", null, (stats.elapsed / 1000).toFixed(1) + " s" + (stats.done ? " · 完成" : "")),
      spark.length === 0
        ? (stats === null ? null : h("span", { className: "mc-note" }, "帧间无变化"))
        : h("div", { className: "mc-spark", title: "每一根 = 这一帧相对上一帧的改动量（灰柱是插值帧；本地演出时是已收敛字数）" }, spark.map(function (item, index) {
          var value = typeof item === "number" ? item : item.v;
          var synthetic = typeof item === "object" && item !== null && item.s === true;
          return h("i", {
            key: index,
            className: synthetic ? "syn" : undefined,
            style: { height: Math.max(2, Math.min(100, Math.round((value / maxLen) * 100))) + "%" }
          });
        }))
    )
  );
}

function installStyles() {
  if (typeof document === "undefined") return;
  if (document.querySelector("style[data-dsh-mercury-preview]") !== null) return;
  var style = document.createElement("style");
  style.setAttribute("data-dsh-mercury-preview", "");
  style.textContent = CSS;
  document.head.append(style);
}

var name = CLIENT_ID;
var inject = ["slots"];

function apply(ctx) {
  installStyles();
  ctx.inject(["sidebarRight", "sidebarRightTabs"], function (scope) {
    scope.sidebarRightTabs.register({
      id: TAB_KIND,
      kind: TAB_KIND,
      title: function () { return "Mercury"; },
      guide: [{
        id: TAB_KIND + "-guide",
        order: 44,
        title: function () { return "Mercury 扩散预览"; },
        description: function () { return "直连 Mercury 3，逐帧看它把噪声收敛成句子"; },
        icon: function () { return icon(); }
      }]
    });
  });
  ctx.slots.inject("sidebar.right.pane.tab", function () {
    return ctx.slots.register({ name: "sidebar.right.pane.tab", key: TAB_KIND, locale: CLIENT_ID }, TabBody);
  });
}

var client_default = { name: name, inject: inject, apply: apply, TabBody: TabBody, extractText: extractText, changedChars: changedChars };
module.exports = client_default;

return module.exports; } });
