# dsh-mercury-preview

DSH（DeepSeek Harness）右侧栏里的 **Mercury 3 扩散预览面板**：直连 Inception 的 `mercury-3`，把流式返回的每一帧整段重绘出来，看它怎么把噪声收敛成一句话。

![panel](https://img.shields.io/badge/dsh-client--plugin-sidebar--right-blue) ![license](https://img.shields.io/badge/license-MIT-green)

---

## 为什么需要这个插件

DSH 的转录协议是 **append-only** 的：`dsh-llm/lib/types/assembler.js` 里文本块走的是

```js
partial.text += chunk.text;
```

它只认 `text-delta` 这种「往后接一段」的语义，没有「整段替换」的通道。而扩散模型的每一帧是**全篇重绘**，中间态里还带着正在被擦掉的噪声字符。把这类帧喂给转录，只会看到文字一段段变长、并夹着假字符。

所以这个插件不复用转录：它在侧边栏开一个独立面板，自己取帧、自己整段替换，与主对话互不干扰。

## 它做什么

| 能力 | 说明 |
|---|---|
| 真帧播放 | 按服务端原始帧整段替换，帧间按真实间隔播（收进 10–90 ms） |
| 帧浏览 | 拖动进度条定位、`◀ ▶` 单帧步进、`⏮` 重播 |
| 变速 | 0.25× / 0.5× / 1× / 2× / 4× |
| 自动跟随 | 每完成一轮就把这一轮的帧播一遍 |
| 帧间插值 | 相邻真帧之间推演字符级中间态（起点终点仍是真帧） |
| 本地去噪演出 | 拿不到真帧时，用噪声收敛出一段**本地演出**（明确标为「非服务端帧」） |
| 会话回放 | 从 `session.v4.jsonl.zstd` 的 `data.stream` 里读回真帧 |

## 原理

```
浏览器面板  ──►  127.0.0.1:8799（插件 host 半边）  ──►  CONNECT 127.0.0.1:7890  ──►  api.inceptionlabs.ai
             CORS 回显本机   补 Authorization / diffusing:true            系统代理
```

三件事只有 host 能做：

1. **补 `diffusing: true`**。agent 自己那条请求不带这个参数，而 pi-ai 的请求构造没有透传任意顶层字段的入口；转发口在 body 里补上，agent 的流才会带中间帧。
2. **补 `Authorization`**。密钥存在 DSH 凭据文件的 `refs.INCEPTION_API_KEY`，面板不需要知道它。
3. **截流**。`ctx.llm.streamWithRegistration` 是所有模型调用的唯一出口，包一层就能把每轮的原始帧留在内存里（`/local/live`），供自动跟随读取。
4. **压住重复**。pi-ai 适配器会把快照帧当增量拼一遍再塞进 `block-end.block.text`，而装配器最后用的正是它——所以转发时要把它换回终稿，否则会话里会出现十几份首尾相接的全文。

## 安装

```bash
# 放进当前 profile
cp -r dsh-mercury-preview "$DSH_HOME/profiles/<profile>/node_modules/"

# 登记到 bundle 列表
# profiles/<profile>/package.json
#   "dsh": { "profile": { "bundles": [ ..., "dsh-mercury-preview" ] } }
```

然后**重启 DSH**（bundle 列表只在启动时扫描，没有热加载）。右侧栏会出现「Mercury」标签。

### 配置密钥

面板走本机转发口时**不需要手填密钥**，host 会读：

```
$DSH_HOME/.credentials.yaml
  refs:
    INCEPTION_API_KEY: sk_...
```

面板里**没有密钥输入框**：转发口会给每个请求补 `Authorization`，密钥只存在于凭据文件。没有该引用时请求原样发出，面板会显示 `invalid_api_key`。密钥页：<https://platform.inceptionlabs.ai/dashboard/api-keys>。

### 代理

`api.inceptionlabs.ai` 在本机直连会被 CloudFront 拦（403）。转发口默认走 `127.0.0.1:7890` 的 CONNECT 隧道，改端口见 `index.js` 顶部的 `UPSTREAM_PROXY`。

## 已知限制

- **官方端点一次只回 3–4 帧**。`diffusing: true` 确实给中间帧（首帧带噪声字符），但帧数取决于输出长度，短回复就三四帧，播起来像「跳变」而不是平滑收敛。这是服务端的行为，客户端无法增加帧数。
- **OpenRouter 会丢 `diffusing`**。`inception/mercury-3` 的 `supported_parameters` 里没有它，走网关只能拿到普通增量流。
- **会话里仍是普通流式**。插件只能改自己那条面板；主对话的渲染由 DSH 本体决定（要改得动 `assembler.js`）。
- 会话记录只在轮次结束后落盘，所以「自动跟随」读的是 host 内存里的截流（`/local/live`），不是文件。
- 只对 `mercury*` 模型补 `diffusing`；其它 provider 的请求原样透传。

## 排障

| 现象 | 原因与查法 |
|---|---|
| `Failed to fetch` | 预检没过。`/local/*` 要求带 `x-mercury-panel: 1` 才会发预检；host 日志每行 `local OPTIONS <path> origin=<o>` 会打出真实 Origin。桌面外壳的 Origin 是 `dsh-app://app`，非 http(s) 一律放行 |
| `连不上本机转发 127.0.0.1:8799` | host 半边没起来（端口被占 / 插件未加载）。看 `$DSH_HOME/mercury-preview.log` 与 DSH 启动日志里的 `forwarder unavailable` |
| 面板有帧，会话里却是普通流式 | 主对话由 DSH 本体渲染，插件只保证转录不被快照帧拼坏，不改变它的视觉 |
| `mercury-preview.log` 越来越大 | 超过 4 MB 会自动改名成 `.log.1`，只留一份 |
| 刚改完代码不生效 | host 半边要重启 DSH；浏览器半边刷新页面即可 |

## 开发

```bash
node --check index.js
node --check lib/client.js
node test/harness.mjs   # 客户端：ModuleLoader 外壳、slot 注册、插值、柱状图指标
node test/tap.mjs       # host：帧归一化（增量 / 窗口 / 快照三种语义）
```

两个测试都是纯离线 stub，不联网、不需要密钥。

## 目录

```
index.js              host 半边：转发口 + 截流 + 会话文件解析
cordis.patch.yml      插件挂载声明
lib/client.js         浏览器半边：面板 UI 与播放器
test/                 离线测试
```

## License

MIT
