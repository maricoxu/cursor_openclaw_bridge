# Cursor Bridge 设计文档

> OpenClaw ↔ Cursor CLI 桥接服务：省钱、高性能、移动端联动、能力完整、面向未来的 Memory 体系

---

## 1. 设计目标与动机

### 1.1 为什么做这个桥

当前你的 AI 助手体系有**两条路径**在消耗成本：

| 路径 | 模型来源 | 计费方式 |
|------|----------|----------|
| Cursor（桌面 + Mobile） | Cursor 账号内置模型 | **月费订阅**（含量大、边际成本低） |
| OpenClaw（钉钉等 IM） | OpenRouter / Google API | **按 token 付费**（用得多就贵） |

桥的核心思路：**让 OpenClaw 的请求「借道」Cursor**，把按量付费变成走订阅额度。

### 1.2 五大设计目标（按优先级）

| 优先级 | 目标 | 衡量标准 |
|--------|------|----------|
| P0 | **省钱** | OpenClaw 默认模型走 Cursor 账号，不再产生 OpenRouter/Google API 费用 |
| P0 | **性能可接受** | 端到端延迟 ≤ 直连 API + 3 秒（cursor-agent 冷启动开销）；流式模式下首 token 可感知 |
| P1 | **能力完整** | cursor-agent 具备读写文件、执行命令、MCP 等全套工具，OpenClaw 的 Agent 能力不降级 |
| P1 | **移动端联动** | 桥与 Cursor AI Agent for Mac 并存，手机 Cursor Mobile、钉钉 OpenClaw、桌面 Cursor 三路共用同一 cursor-agent |
| P2 | **Memory 体系就绪** | 桥调用 cursor-agent 时传入 workspace，使 agent 能直接读写 Memory 文件（MEMORY.md、daily notes 等），为未来搭载完整 Memory 体系做准备 |

### 1.3 不做什么（边界）

- 不做 cursor-agent 的常驻复用（Cursor 设计为每次请求新进程，我们遵循）
- 不对外网暴露端口（只绑 127.0.0.1）
- 不替代 OpenClaw 已有的 OpenRouter/Google 通道（保留为 fallback）
- 不修改 Cursor 或 OpenClaw 的源码

---

## 2. 整体架构

### 2.1 全景数据流

```
┌─────────────────────────────────────────────────────────────────┐
│                         你的 Mac                                 │
│                                                                   │
│  ┌──────────┐     ┌───────────────┐     ┌──────────────────┐    │
│  │ 钉钉 IM  │────▶│ OpenClaw GW   │────▶│  cursor-bridge   │    │
│  │ (手机/PC) │     │ :18789        │     │  :3847           │    │
│  └──────────┘     └───────────────┘     └────────┬─────────┘    │
│                                                    │              │
│  ┌──────────┐     ┌───────────────┐              ▼              │
│  │ Cursor   │────▶│ Cursor AI     │     ┌──────────────────┐    │
│  │ Mobile   │     │ Agent (Mac)   │────▶│  cursor-agent    │    │
│  │ (手机)   │     └───────────────┘     │  (CLI 进程)      │    │
│  └──────────┘                           └────────┬─────────┘    │
│                                                    │              │
│  ┌──────────┐                                      ▼              │
│  │ Cursor   │─────────────────────────▶ Cursor 云端 API          │
│  │ 桌面 IDE │                           (模型推理)              │
│  └──────────┘                                                     │
│                                                                   │
│         三路共用同一 Cursor 账号 + 同一工作区                     │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 桥的定位

```
OpenClaw ──HTTP──▶ cursor-bridge ──spawn──▶ cursor-agent ──HTTPS──▶ Cursor 云端
           (OpenAI 兼容)    (协议翻译)         (CLI)           (模型推理)
```

桥只做**一件事**：把 OpenAI 兼容的 HTTP 请求翻译成 cursor-agent CLI 调用，再把 CLI 的输出翻译回 OpenAI 兼容的 HTTP 响应。

### 2.3 与现有体系的并存关系

| 入口 | 链路 | 说明 |
|------|------|------|
| **Cursor 桌面** | IDE → Cursor 云端 | 正常使用，不经过桥 |
| **Cursor Mobile** | 手机 → Cursor AI Agent (Mac) → cursor-agent → Cursor 云端 | 不经过桥 |
| **钉钉 OpenClaw** | 钉钉 → OpenClaw GW → **cursor-bridge** → cursor-agent → Cursor 云端 | **走桥** |
| **OpenClaw fallback** | 钉钉 → OpenClaw GW → OpenRouter/Google API | 桥不可用时自动降级 |

### 2.4 多后端兼容：Cursor CLI 与 Gemini CLI（设计讨论）

**同一类逻辑**：调用 Cursor CLI 和调用 Gemini CLI 在抽象层面是同一类逻辑——**spawn 子进程 → 传入输入（prompt + 参数）→ 读 stdout（流或缓冲）→ 转成 OpenAI 兼容的 HTTP 响应**。桥当前只对接 cursor-agent，但若把「谁被 spawn、传什么参数、怎么解析 stdout」抽成可插拔的后端，理论上可以在同一套桥里做**兼容与切换**。

**可抽象出的统一形态**：

| 层次 | 统一接口 | Cursor 实现 | Gemini 实现（假设） |
|------|----------|-------------|----------------------|
| **入口** | HTTP POST /v1/chat/completions（不变） | 同左 | 同左 |
| **Runner** | `runAgent(opts)` / `runAgentStream(opts)`，返回 content 或 stream | 当前 agent-runner：spawn cursor-agent，args 含 `--print`、`--output-format stream-json`、`--workspace` 等 | spawn gemini CLI，args 含 prompt 位置、`--model`、`--output-format` 等（以 Gemini CLI 实际能力为准） |
| **输出解析** | 将 stdout 转为「同一套」SSE 或 JSON 体 | stream-parser：NDJSON（type: assistant/result/message）→ OpenAI SSE | 需适配：Gemini CLI 可能是纯文本或另一种 JSON/流格式，需单独 parser 或 adapter 转成同一 SSE 形状 |
| **配置切换** | 通过环境变量或配置选择后端 | `AGENT_BACKEND=cursor`（或默认），`CURSOR_AGENT_BIN`、`CURSOR_WORKSPACE` 等 | `AGENT_BACKEND=gemini`，`GEMINI_CLI_BIN`、`GEMINI_MODEL` 等 |

**实现上需要做的**（讨论用，非承诺实现）：

1. **Runner 抽象**：定义 `createRunner(backend)` 或按 `AGENT_BACKEND` 返回不同 runner；每个 runner 暴露 `runAgent` / `runAgentStream`，入参可统一（如 `{ prompt, workspace?, model?, timeoutMs }`），内部各自 spawn 对应 CLI、传各自参数。
2. **解析层**：Cursor 继续用现有 stream-parser（NDJSON → SSE）；Gemini 需新增一层「Gemini stdout → 与现有 SSE 同构」的转换（若 Gemini 只出纯文本，可封装成「单块 content」的 SSE）。
3. **配置**：如 `AGENT_BACKEND=cursor|gemini`，以及各后端自己的 `*_BIN`、`*_WORKSPACE`/`*_MODEL` 等，避免冲突。
4. **健康检查**：`GET /health` 需根据当前 backend 调对应 CLI（如 `cursor-agent about` vs `gemini --version` 或等价）判断可用性。

**注意点**：

- **workspace**：cursor-agent 强依赖 `--workspace`（当前桥的 CURSOR_WORKSPACE）；Gemini CLI 是否支持「工作区」或等价概念需查文档，若没有则传空或忽略。
- **流式**：Cursor 有 `--output-format stream-json`；Gemini CLI 是否支持流式、格式如何，决定是「全量读再转 SSE」还是「边读边转」。
- **成本与目标**：多后端会增加维护和测试量；若目标是「同一 OpenClaw 入口可切 Cursor 或 Gemini」，在桥里做统一抽象是合理方向；若只是「偶尔用 Gemini」，也可以由 OpenClaw 直接配多条模型通道（如主 Cursor 桥、备选 OpenRouter/Gemini API），不必一定在桥内切 CLI。

本节为设计讨论，具体是否实现、以何优先级实现，可按需求再定。

---

## 3. 接口设计（协议契约）

### 3.1 桥对外暴露的接口

桥实现一个 **OpenAI Chat Completions 兼容端点**：

```
POST http://127.0.0.1:3847/v1/chat/completions
Content-Type: application/json
Authorization: Bearer <optional-token>
```

**请求体**（OpenClaw 发来的）：

```json
{
  "model": "cursor-agent",
  "messages": [
    {"role": "system", "content": "你是小哩中枢..."},
    {"role": "user", "content": "帮我查一下今天的日程"}
  ],
  "stream": true,
  "max_tokens": 32000
}
```

**非流式响应**（`stream: false`）：

```json
{
  "id": "bridge-xxxxx",
  "object": "chat.completion",
  "created": 1773414000,
  "model": "cursor-agent",
  "choices": [{
    "index": 0,
    "message": {
      "role": "assistant",
      "content": "好的，让我查看一下今天的日程..."
    },
    "finish_reason": "stop"
  }],
  "usage": {
    "prompt_tokens": 0,
    "completion_tokens": 0,
    "total_tokens": 0
  }
}
```

**流式响应**（`stream: true`）：

```
data: {"id":"bridge-xxxxx","object":"chat.completion.chunk","created":1773414000,"model":"cursor-agent","choices":[{"index":0,"delta":{"role":"assistant","content":"好的"},"finish_reason":null}]}

data: {"id":"bridge-xxxxx","object":"chat.completion.chunk","created":1773414000,"model":"cursor-agent","choices":[{"index":0,"delta":{"content":"，让我"},"finish_reason":null}]}

...

data: {"id":"bridge-xxxxx","object":"chat.completion.chunk","created":1773414000,"model":"cursor-agent","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]
```

### 3.2 桥对内调用 cursor-agent 的方式

#### 非流式

```bash
cd /path/to/workspace
cursor-agent "<拼好的 prompt>" \
  --print \
  --trust \
  --output-format json \
  --workspace /path/to/workspace
```

从 stdout 收集完整 JSON，提取 assistant 回复内容。

#### 流式

```bash
cd /path/to/workspace
cursor-agent "<拼好的 prompt>" \
  --print \
  --trust \
  --output-format stream-json \
  --stream-partial-output \
  --workspace /path/to/workspace
```

从 stdout 逐行读取 NDJSON，筛选 `type === "assistant"` 的行，提取 `message.content[].text`，转成 OpenAI SSE 格式写入 HTTP 响应流。

### 3.3 Prompt 拼装逻辑

OpenClaw 发来的 `messages` 数组需要拼成**一条文本**给 cursor-agent：

```
拼装规则：
1. system 消息 → 作为上下文前缀
2. 历史 user/assistant 消息 → 按对话格式拼接
3. 最后一条 user 消息 → 作为当前 prompt

拼装格式：
---
[System] {system_content}
---
[User] {user_msg_1}
[Assistant] {assistant_msg_1}
[User] {user_msg_2}
[Assistant] {assistant_msg_2}
...
[User] {current_user_message}
```

cursor-agent 只接受单条 prompt 输入（不像 OpenAI API 有 messages 数组），所以桥负责把多轮对话「压平」成一条。

---

## 4. 模块划分

桥的代码结构简洁，只有 4 个核心模块：

```
cursor-bridge/
├── DESIGN.md              ← 本文档
├── package.json           ← 依赖声明
├── .env.example           ← 配置模板
├── src/
│   ├── server.js          ← HTTP 服务入口，路由分发
│   ├── prompt-builder.js  ← messages → 单条 prompt 的拼装
│   ├── agent-runner.js    ← spawn cursor-agent，处理 stdout/stderr
│   └── stream-parser.js   ← NDJSON → OpenAI SSE 的流式转换
└── scripts/
    ├── start.sh           ← 启动脚本
    └── install-service.sh ← 注册 launchd 常驻（可选）
```

### 4.1 模块职责

| 模块 | 输入 | 输出 | 职责 |
|------|------|------|------|
| `server.js` | HTTP 请求 | HTTP 响应 | 监听端口、路由、CORS、apiKey 校验 |
| `prompt-builder.js` | OpenAI messages 数组 | 单条 prompt 字符串 | 多轮对话压平、system prompt 处理 |
| `agent-runner.js` | prompt + 配置 | stdout 流或最终文本 | spawn cursor-agent 子进程、超时管理、错误处理 |
| `stream-parser.js` | NDJSON 行 | OpenAI SSE chunk | 解析 cursor-agent 的 stream-json 输出，转成标准 SSE |

### 4.2 模块间调用关系

```
HTTP 请求
    │
    ▼
server.js ──▶ prompt-builder.js（拼 prompt）
    │
    ▼
server.js ──▶ agent-runner.js（spawn cursor-agent）
    │                │
    │           stream-parser.js（若流式）
    │                │
    ▼                ▼
HTTP 响应 ◀────── SSE 流 / JSON 一次性响应
```

---

## 5. 配置设计

### 5.1 桥自身配置（`.env` 或环境变量）

```bash
# 桥监听
BRIDGE_HOST=127.0.0.1
BRIDGE_PORT=3847

# 安全（可选，OpenClaw 请求带的 apiKey）
BRIDGE_API_KEY=any-token-you-want

# cursor-agent 相关
CURSOR_AGENT_BIN=cursor-agent              # 或绝对路径
CURSOR_WORKSPACE=/Users/xuyehua/Library/Mobile Documents/iCloud~md~obsidian/Documents/yehua的笔记
CURSOR_AGENT_TIMEOUT_MS=180000             # 3 分钟超时
CURSOR_AGENT_MODEL=                        # 留空 = auto；可选 gpt-5, sonnet-4 等
CURSOR_AGENT_EXTRA_ARGS=--trust            # 额外参数
```

### 5.2 OpenClaw 配置变更

在 `~/.openclaw/openclaw.json` 中新增 `cursor-cli` provider：

```json5
{
  "models": {
    "mode": "merge",
    "providers": {
      "cursor-cli": {
        "baseUrl": "http://127.0.0.1:3847/v1",
        "apiKey": "any-token-you-want",
        "api": "openai-completions",
        "models": [
          {
            "id": "cursor-agent",
            "name": "Cursor CLI (Bridge)",
            "reasoning": false,
            "input": ["text"],
            "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
            "contextWindow": 128000,
            "maxTokens": 32000
          }
        ]
      }
    }
  }
}
```

然后修改 agents.defaults.model：

```json5
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "cursor-cli/cursor-agent",
        "fallbacks": ["openrouter/google/gemini-3-flash-preview"]
      }
    }
  }
}
```

**关键设计**：`fallbacks` 保留现有的 OpenRouter 模型。当桥不可用（Mac 未开机、cursor-agent 未登录等），OpenClaw 自动降级到按量付费的 fallback 模型，保证可用性。

---

## 6. 错误处理设计

### 6.1 错误分类与响应

| 错误场景 | 检测方式 | 桥的响应 | 说明 |
|----------|----------|----------|------|
| cursor-agent 未安装/不在 PATH | spawn ENOENT | HTTP 503 + JSON 错误体 | OpenClaw 走 fallback |
| cursor-agent 未登录 | exit code ≠ 0 + stderr 含 "not logged in" | HTTP 503 + 友好消息 | 提示用户登录 |
| cursor-agent 超时 | 超过 CURSOR_AGENT_TIMEOUT_MS | 杀进程 + HTTP 504 | 防止 OpenClaw 无限等待 |
| cursor-agent 非 0 退出 | exit code ≠ 0 | HTTP 502 + stderr 内容 | 透传错误信息 |
| 请求体格式错误 | JSON 解析失败或缺少 messages | HTTP 400 | 桥自行处理 |
| 流式中断 | cursor-agent 意外退出 | SSE 发送错误 event + `[DONE]` | 优雅关闭流 |

### 6.2 错误响应格式

所有错误统一返回 OpenAI 兼容的错误结构（避免 OpenClaw 解析失败）：

```json
{
  "error": {
    "message": "cursor-agent is not logged in. Please run: cursor-agent login",
    "type": "service_unavailable",
    "code": "bridge_agent_not_ready"
  }
}
```

---

## 7. 性能设计

### 7.1 延迟分析

```
端到端延迟 = 桥处理 + cursor-agent 冷启动 + Cursor 云端推理 + 桥转发

各段预估：
├── 桥处理（常驻进程，只做 JSON 解析 + spawn）：< 50ms
├── cursor-agent 冷启动（新进程 + 鉴权 + 加载）：1 ~ 3 秒
├── Cursor 云端推理（与直连 API 相同）：取决于模型和 prompt 长度
└── 桥转发（JSON 解析 + SSE 组装）：< 10ms / chunk

额外开销：1 ~ 3 秒（主要在冷启动）
```

### 7.2 优化策略

| 策略 | 效果 | 优先级 |
|------|------|--------|
| **桥常驻**（pm2 / launchd） | 消除桥自身启动时间 | P0，第一版就做 |
| **流式优先** | 用户感知到「在输出」的等待大幅缩短 | P0，第一版就做 |
| **prompt 精简** | 减少拼装后的 prompt 长度，降低推理耗时 | P1，后续优化 |
| **模型选择** | cursor-agent 支持 `--model`，可选更快的模型 | P1，后续优化 |

### 7.3 与各方案的性能对比

| 方案 | 首 token 延迟 | 整体延迟 | 成本 |
|------|---------------|----------|------|
| OpenClaw 直连 OpenRouter | 快（< 1s） | 正常 | **按 token 付费** |
| OpenClaw → cursor-bridge → Cursor | 中（2~4s） | 正常 + 1~3s | **订阅额度内** |
| Cursor Mobile（手机） | 中（2~4s） | 正常 + 1~3s | **订阅额度内** |
| Cursor 桌面 IDE | 最快 | 最快 | **订阅额度内** |

结论：桥方案的延迟主要在 cursor-agent 冷启动，但**成本降至 0**（在订阅额度内），性价比最优。

---

## 8. 部署设计

### 8.1 开发阶段（手动启动）

```bash
cd cursor-bridge/
node src/server.js
# 或
npm start
```

手动测试：

```bash
curl -X POST http://127.0.0.1:3847/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"cursor-agent","messages":[{"role":"user","content":"hello"}],"stream":false}'
```

### 8.2 生产阶段（常驻进程）

**方案 A：pm2（推荐，简单）**

```bash
npm install -g pm2
pm2 start src/server.js --name cursor-bridge
pm2 save
pm2 startup  # 生成开机自启命令
```

**方案 B：macOS launchd**

```xml
<!-- ~/Library/LaunchAgents/com.cursor-bridge.plist -->
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.cursor-bridge</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/path/to/cursor-bridge/src/server.js</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/cursor-bridge.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/cursor-bridge.err</string>
</dict>
</plist>
```

### 8.3 健康检查

桥提供一个简单的健康检查端点：

```
GET http://127.0.0.1:3847/health
→ 200 {"status": "ok", "cursor_agent": "available", "version": "1.0.0"}

GET http://127.0.0.1:3847/health
→ 503 {"status": "degraded", "cursor_agent": "not_logged_in", "version": "1.0.0"}
```

---

## 9. 安全设计

| 层面 | 措施 |
|------|------|
| **网络** | 仅绑定 `127.0.0.1`，不暴露外网 |
| **认证** | 可选的 `apiKey` 校验（桥检查 Authorization header） |
| **输入** | prompt 长度限制（避免超大 payload 打爆 cursor-agent） |
| **进程** | 每个 cursor-agent 子进程有超时上限，超时自动 kill |
| **敏感信息** | 不在日志中记录完整 prompt 和响应内容 |

---

## 10. Memory 体系集成设计（面向未来）

### 10.1 当前已具备的基础

cursor-agent 支持 `--workspace` 参数，可以指定工作目录。当工作目录是你的笔记库时：

```
cursor-agent "帮我查看今天的日记" \
  --print --trust \
  --workspace "/Users/xuyehua/Library/Mobile Documents/iCloud~md~obsidian/Documents/yehua的笔记"
```

cursor-agent 在该 workspace 下可以：
- **读取** MEMORY.md、daily notes、Agent 的 RULES.md
- **写入** 记录、日记、待办
- **搜索** workspace 内的文件
- **执行** 脚本（如果 `--trust` 或 `--force`）

### 10.2 未来扩展方向

| 阶段 | 能力 | 实现方式 |
|------|------|----------|
| **V1（当前）** | cursor-agent 在笔记库 workspace 下执行 | `--workspace` 指向笔记库 |
| **V2** | 桥自动注入 Memory 上下文到 system prompt | prompt-builder 读取 MEMORY.md + 当日 daily note，拼入 system 消息 |
| **V3** | 按 Agent 分发到不同 workspace / 不同 memory | 桥根据 OpenClaw 传来的 agent_id，选择对应的 agentDir 和 memory 文件 |
| **V4** | cursor-agent 执行后自动更新 memory | 桥在请求结束后，触发一次 cursor-agent 做 memory 归档 |
| **Phase 4：多模态** | 钉钉/渠道上传的图片等经桥传给 Cursor | 桥识别 `image_url`、落盘并在 prompt 中写入路径；cursor-agent 通过读文件看图（见 10.5） |
| **Phase 5：厂内环境 + memory 复用** | 厂内与厂外共享上下文、厂内沉淀可合并回本地 | BOS 仅存 index/摘要（不做全量同步）；厂外推摘要到 BOS、厂内读 index 注入并写回摘要、厂外拉取合并（见 10.6） |
| **Phase 6：体验优化** | 更快、更智能 | 模型选择、prompt 压缩、plan/ask 只读、并发管理（见 §11） |

### 10.3 与 OpenClaw 多 Agent 体系的对接

你当前的 OpenClaw 配置有 8 个 Agent（小哩中枢、技术管理、首席架构…），每个 Agent 有独立的 `agentDir`。未来桥可以：

1. OpenClaw 在请求头或 body 中传递 `agent_id`
2. 桥根据 `agent_id` 查找对应 Agent 的 `agentDir`
3. cursor-agent 用该 `agentDir` 作为 `--workspace`
4. 不同 Agent 看到不同的文件上下文 → 表现出不同的「记忆」和「能力」

### 10.4 Phase 3 Memory 体系运作设计（讨论稿）

目标：让经桥调用的 cursor-agent **有记忆**——既能读到「记忆」上下文，又能在合适时机把本次对话沉淀回记忆。下面按三条 Phase 3 任务拆成「谁读谁写、何时、怎么接 OpenClaw」。

#### 10.4.0 需求与优先级（产品锚点）

- **需求一**：**节省 token 输入**。少发重复或冗长上下文，用记忆/索引替代「最近 N 条」完整历史。
- **需求二**：**最大化获取第二大脑的信息**。AI 能充分读取**笔记与代码**（如 `Code_Library` 下的 Python、C++ 等）中的知识、任务、记忆，不遗漏可用的沉淀内容。
- **需求三**：**Cursor 与 OpenClaw（经桥）的对话与记忆，都存到同一套笔记里**。公用、持久化，知识/任务管理等有一处统一的存储，两路调用共享同一套第二大脑；代码改动仍落在对应代码库目录。

- **使用形态**：**笔记**改写较多（daily、MEMORY、项目笔记等经常更新）；**代码**以读为主、少部分改写（查实现与上下文为主，按需求改某段代码为少数）。
- **最高优先级**：**第二大脑（笔记 + 代码） = 完全沉淀 + 方便读取**。  
  一切设计以「笔记库与代码库是唯一的事实来源、该沉淀的落库、且人类与 AI 都能方便读取」为第一原则。即：**先保证写进去、读得着；再在之上做索引、省 token、多路写入**。  
  若与「省 token」或「实现复杂度」冲突，优先保证沉淀完整与可读性。

#### 10.4.1 记忆在笔记库里的形态（约定）

与 AGENTS.md / 当前实践对齐，约定：

| 记忆类型 | 路径（相对 workspace 根） | 用途 |
|----------|---------------------------|------|
| **长期记忆** | `MEMORY.md` | 提炼后的重要事实、决策、偏好，跨会话保留 |
| **近期日志** | `memory/YYYY-MM-DD.md` | 当日（及可选的昨日）原始记录，供「最近发生什么」 |
| **Agent 专属记忆** | `7-Agents/<Agent名>/MEMORY.md` | 某 Agent 的长期记忆（若存在） |
| **Agent 身份/规则** | `7-Agents/<Agent名>/SOUL.md`、`RULES.md` 等 | 已由 cursor-agent 通过 `--workspace` 读到，桥可不重复注入 |

workspace 根 = 当前桥的 `CURSOR_WORKSPACE`（笔记库根）。若 Phase 3 做「按 Agent 分发 workspace」，则某 Agent 的 workspace 可以是笔记库根，也可以是 `7-Agents/xx/` 等子目录，由配置或 agent_id 映射决定。

#### 10.4.2 任务一：prompt-builder 注入 Memory 上下文

- **做什么**：在拼好「当前对话」的 system + 多轮 user/assistant 之前或之中，**插入一段「记忆上下文」**，让 cursor-agent 的 prompt 里自带 MEMORY.md（及可选 daily note）的摘要或全文。
- **谁读**：桥（prompt-builder 或 server 调用的「memory 读取模块」）在收到请求后、调用 `buildPrompt` 前，从 **当前请求对应的 workspace** 读文件：
  - `MEMORY.md`
  - `memory/YYYY-MM-DD.md`（今日，可选昨日）
  - 若按 Agent 分发：还可读 `7-Agents/<id>/MEMORY.md`
- **注入方式**：把上述内容拼成一段文本（例如 `[Memory]\n...`），**预拼到 system 消息前面**，或作为第一条 system 的 content 前缀，再交给现有 `buildPrompt(messages)`。这样 cursor-agent 看到的 prompt 里已经带记忆，无需它自己先读文件（减少工具调用、延迟更可控）。
- **边界与开放点**：
  - **长度与裁剪**：MEMORY.md + daily 可能很长，需策略（按字符/按段裁剪，或只取摘要段）。否则容易爆上下文、拖慢首 token。产品决策：有 Memory 注入时，**对话历史可极简为「当前一条 user」**，其余上下文靠 Memory 承载（见 10.4.6）。
  - **是否可配置**：例如环境变量 `CURSOR_BRIDGE_INJECT_MEMORY=1`、`CURSOR_BRIDGE_INJECT_DAILY=1`，或按 agent_id 配置「只注入根 MEMORY」「根 + daily」「根 + daily + Agent MEMORY」等。

#### 10.4.3 任务二：按 Agent 分发不同 workspace

- **做什么**：同一次桥请求，根据「是哪个 OpenClaw Agent」选用不同的 **workspace**（及可选的不同 memory 集合），再 spawn cursor-agent 时传对应的 `--workspace`。
- **谁决定 workspace**：桥。输入需要「当前请求对应哪个 Agent」的标识。两种常见方式：
  1. **请求里带 agent 标识**：OpenClaw 在请求头（如 `X-Agent-Id: 00_小哩中枢`）或 body 的扩展字段里传 `agent_id` / `agent_dir`；桥解析后查本地映射表（如「agent_id → 笔记库下的 7-Agents/00_小哩中枢」），得到 `--workspace`。
  2. **仅用默认 workspace**：不传则用 `CURSOR_WORKSPACE`（当前行为）；传了则用映射后的目录。这样同一桥可服务多 Agent，且每个 Agent 的 RULES/SOUL/MEMORY 自然隔离（因为 cursor-agent 的 cwd 和可读文件不同）。
- **与任务一的关系**：若按 Agent 分发，则「注入 Memory 上下文」时读的 MEMORY.md / memory/ 路径，应相对于**该 Agent 的 workspace**（例如 workspace = 7-Agents/00_小哩中枢 时，可读该目录下的 MEMORY.md 和笔记库根的 memory/YYYY-MM-DD.md，具体策略可配置）。

#### 10.4.4 任务三：请求结束后自动更新 daily note

- **做什么**：在一次对话（非流式结束或流式 [DONE]）结束后，**把本次交互的摘要或关键信息写回 daily note**（或 MEMORY.md），以便后续会话能通过「注入 Memory」再次被看到。
- **谁写**：有两种实现思路：
  1. **桥侧直接写**：桥在请求结束时，把「当前时间、最后一条 user、assistant 回复摘要」等 append 到 `memory/YYYY-MM-DD.md`（或按 agent 分到不同 daily 路径）。优点实现简单、不依赖 cursor-agent 再跑一轮；缺点桥没有「理解」能力，只能做固定模板（时间 + 原文/摘要）。
  2. **桥触发 cursor-agent 做归档**：请求结束后，桥再 spawn 一次 cursor-agent，专门执行一条「把刚才这场对话归档到 daily / MEMORY」的 prompt（例如把上一轮的 user/assistant 和对话 id 塞进 prompt，让 agent 写文件）。优点可以写得更智能、可更新 MEMORY.md；缺点多一次调用、延迟与成本增加。
- **时机**：流式在 `finish()` 且无错误时；非流式在拿到 `result.content` 并 200 返回后。可加开关（如 `CURSOR_BRIDGE_UPDATE_DAILY=1`）和限频（例如同一用户/会话 N 分钟内只写一次），避免刷屏。

#### 10.4.5 数据流小结（Phase 3 目标态）

```
OpenClaw 请求 (messages + 可选 agent_id)
    │
    ▼
桥解析 agent_id → 决定 workspace（及要注入的 memory 文件集合）
    │
    ▼
桥读取 MEMORY.md / memory/YYYY-MM-DD.md（+ 可选 Agent MEMORY）
    │
    ▼
拼成「[Memory] ...」注入到 system 前 → buildPrompt(messages) → 单条 prompt
    │
    ▼
runAgent / runAgentStream(--workspace <该 Agent 的 workspace>)
    │
    ▼
响应返回 OpenClaw
    │
    ▼
（可选）请求结束后：桥写 daily 或再调 cursor-agent 做 memory 归档
```

#### 10.4.6 决策结论（产品侧拍板）

- **① Agent ID**：支持传 agent_id。信息多时用 agent_id 做区分；OpenClaw 在请求头或 body 中传递，桥解析后用于 workspace 分发与 memory 选择。
- **② 注入长度与「最近 N 条」**：有 Memory 注入后，**不再依赖「最近 N 条」对话历史**——上下文由 Memory 承载，请求里只需**当前一条 user** 即可。即：开启 Memory 注入时，可默认或配置为「单轮」（一条 system + 一条当前 user），其余信息全在 MEMORY.md / daily 里；这样既省 token，又避免重复。若 OpenClaw 仍传多轮，桥可配置为「仅取最后一条 user」或保留 1 条 system + 1 条 user。
- **③ 写回格式**：尽量统一；格式可参考**社区最佳实践**（如 daily note、AI 交互记录的常见模板），并与现有 `memory/YYYY-MM-DD.md`、AGENTS.md「Write It Down」用法对齐。实现前可做一次社区写法调研，再定桥侧写回模板。
- **④ Agent memory 与公用 memory、索引模型**：见下节 10.4.7。

#### 10.4.7 Memory 作为索引层（与 Agent / 公用统一）

目标：**Agent 记忆与公用记忆尽量统一**；**Cursor 每次对话、笔记本里的内容，都方便记入同一套 memory**；**能从 memory 里快速索引、取出信息**。采用「Memory 存索引、笔记本存正文」的分层方式。

- **分层约定**
  - **笔记本 + 代码库（大量正文与实现）**：日常笔记、项目文档、对话记录等放在笔记库的 .md 中；Python、C++ 等代码放在如 `3-Resources资料参考/Code_Library代码库` 等目录。**笔记**改写较多；**代码**以读为主、少部分改写。
  - **Memory（索引与摘要）**：MEMORY.md（及按 Agent 的 MEMORY）里存的主要是**索引、摘要、关键结论、指针**（例如「某主题见 `path/to/note.md`」「某实现见 `Code_Library/xxx`」「某决策：…」），而不是大段原文。AI 需要时先看 Memory，再按索引打开对应笔记或代码文件读取详情。
- **统一写入与来源**
  - **Cursor 桌面 / Cursor Mobile 的对话**：其产生的记忆应能写入同一套 memory 体系（例如通过 Cursor 侧或桥侧约定：会话结束后更新 MEMORY.md / daily，以索引或摘要形式）。
  - **桥（OpenClaw 钉钉）的对话**：请求结束后写回 daily / MEMORY，格式与上统一，便于和 Cursor 的对话记忆合流。
  - **笔记本内手写/整理的内容**：也可通过约定路径或模板（如 daily、项目下的 README）被视作 memory 的一部分；Memory 层只存指向这些内容的索引或一句摘要。
- **统一读取与检索**
  - 桥注入 Memory 时，把「根 MEMORY + 今日 daily + 可选 Agent MEMORY」注入 prompt；cursor-agent 在 workspace 下也能直接读任意笔记文件。即：**AI 先用 Memory 里的索引知道「有什么、在哪」，再按需读具体笔记**。后续若做检索（如按关键词找 note），可在 Memory 文本或独立索引结构中实现，目标都是「从 memory 快速索引、拿到信息」。
- **与 Agent 的共用**
  - Agent 级 MEMORY（如 `7-Agents/00_小哩中枢/MEMORY.md`）与公用 MEMORY（根目录 `MEMORY.md`）在**格式与用法上尽量一致**：都以索引/摘要为主，正文在笔记里。不同 Agent 可共享根 MEMORY 的只读注入，同时拥有自己目录下的 MEMORY 用于该 Agent 的专属记忆；写回时可按 agent_id 决定写根 daily、根 MEMORY，还是 Agent 目录下的 MEMORY，实现「尽可能和 Agent 及公用」统一。

以上结论已纳入 Phase 3 设计；实现时按 10.4.1～10.4.5 的流程，并遵循 10.4.6、10.4.7 的决策与索引模型。

#### 10.4.8 实现归属：放在 cursor-bridge 还是单独代码仓

| 维度 | 放在 cursor-bridge | 单独代码仓（如 memory-service） |
|------|--------------------|----------------------------------|
| **职责** | 桥 = 协议翻译 + 记忆注入 + 写回，一个进程完成 | 桥只做协议翻译；记忆获取/写回由独立服务做，职责更清晰 |
| **部署** | 只跑一个 bridge，用户心智简单 | 需跑 bridge + memory 服务，多一个进程与配置 |
| **调用链** | 请求 → 桥（读 MEMORY/调 Engram/拼 prompt）→ cursor-agent；写回在桥内完成 | 请求 → 桥 → 调 memory 服务取上下文 → 拼 prompt → cursor-agent；写回时桥再调 memory 服务，多一跳 |
| **复用** | 记忆逻辑与桥强绑定，若 Cursor 桌面等要复用需再抽 | 记忆服务可被 bridge、其他工具共用，独立迭代 |
| **复杂度** | 桥代码库略变重，但 Phase 3 增量可控（读文件/可选调 API、写回模板） | 多一个仓库与运维，适合「记忆服务很重、多调用方」时 |

**推荐**：**Phase 3 优先放在 cursor-bridge 内实现**。  
- 请求必经桥，注入与写回和请求生命周期强绑定，放在桥里最直接，无需多一层网络或进程。  
- 当前阶段「读 MEMORY/daily 注入 + 请求结束写回」体量不大，单独起仓收益有限，反而增加部署与排障成本。  
- 若后续记忆逻辑变重、或 Cursor 桌面/其他工具也要复用同一套「记忆上下文服务」，再把记忆相关代码抽成独立仓库或服务不迟。

**与 Engram MCP 的关系**：若采用「cursor-agent 配置 Engram MCP、由 agent 内部调 MCP 取记忆」，则桥侧可只做「读文件注入」或不做注入，桥无需直接调 Engram。若采用「桥在拼 prompt 前调 Engram 的 HTTP/API 拿到记忆再注入」，则该调用逻辑放在 bridge 仓内即可，仍推荐单仓。

### 10.5 多模态（图片等）桥支持

**完整设计文档**（目标、数据流、协议、实现要点、任务清单）：[docs/DESIGN_PHASE4_MULTIMODAL.md](docs/DESIGN_PHASE4_MULTIMODAL.md)。

**目标**：钉钉等渠道上传的图片（或其它媒体）能经桥传导给 cursor-agent，使 Cursor 能「看图说话」。

**当前限制**：桥的 prompt-builder 只从 `messages[].content` 抽取纯文本，不处理 `image_url` 或图片 part，钉钉发来的图片在桥侧被忽略。cursor-agent CLI 根据 [Headless 文档](https://cursor.com/docs/cli/headless) **不接收内联 base64/URL**，而是通过 **「在 prompt 里写文件路径」** 传图，agent 用读文件工具打开。

**设计要点**：

| 环节 | 职责 |
|------|------|
| **OpenClaw** | 钉钉上传图片后，在请求里带多模态 content：如 `content: [{ type: "text", text: "…" }, { type: "image_url", image_url: { url: "data:image/...;base64,..." } }]`；或先落盘后在消息里注明路径（如 `[图片: /tmp/xxx.png]`），由桥原样拼进 prompt。 |
| **桥** | (1) 识别 `content` 中的 `image_url`（含 data URL）：解码 base64 → 在 workspace 或约定临时目录写入文件（如 `memory/.uploads/<requestId>.<ext>`）；(2) 在拼出的 prompt 中插入「用户发送了一张图片，路径为：<绝对路径>。请根据图片内容回答。」并把用户文字一起拼进去；(3) 若消息中已是路径占位文字，直接保留在 prompt 中。 |
| **cursor-agent** | 无需改；prompt 中带文件路径后，agent 通过读文件工具看图并回答。 |

**实现范围（桥侧）**：

- 扩展 `prompt-builder`（或前置步骤）：遍历每条 message 的 content；遇 `type: "image_url"` 且 `image_url.url` 为 data URL 时，解码并落盘，得到本地路径，再将该条替换为/追加为「图片路径说明」文本参与拼 prompt。
- 落盘目录：建议在 `CURSOR_WORKSPACE` 下约定子目录（如 `memory/.uploads/` 或 `.bridge-uploads/`），按请求 id 或时间戳命名，避免冲突；可选请求结束或定时清理旧文件。
- 配置：可选 `CURSOR_BRIDGE_MULTIMODAL_IMAGES=1` 开启图片落盘与路径注入；关闭时保持当前行为（仅文本）。

**依赖**：OpenClaw 需在调用桥时把渠道图片以 `image_url` 或路径占位形式放入 messages；若 OpenClaw 当前未传图，需先在其侧支持再在桥侧对接。

详细现象与方案参见 NOTES.md §5.6。

### 10.6 厂内环境与 memory 复用（Phase 5）

**背景**：厂内机器无操作权限，无法在机器上做工程实验或直接跑 cursor-bridge；需要用厂内 comet 或厂内部署的 OpenClaw。希望**无论厂内用哪种工具、厂外用 cursor-bridge，都能复用同一套第二大脑**，所有内容沉淀到公用 memory。

**目标**：厂内（comet / 厂内 OpenClaw）与厂外（cursor-bridge + Cursor）通过 **BOS 上的 index/摘要** 共享上下文轮廓；厂内会话沉淀以摘要写回 BOS，厂外合并进本地第二大脑，实现「跨环境记忆衔接」而不做全量同步、不把私有正文上云。

**约束**：

- 厂内不能直接装桥或动机器；**厂内不可访问厂外，数据也不能出厂**（方式 A 不可行）。
- 厂内存储可走 BOS，BOS 可从外网访问，故 BOS 可作为**中转**；但**笔记本体量大，全量实时同步不现实**，且**私有数据不宜整库放 BOS**，只适合在 BOS 上存 **index/摘要** 级别的内容。

**两层问题**：

- **存到哪里**：BOS 只做**轻量中转**——存 index/摘要，不存完整第二大脑全文；厂外完整数据留在本地，厂内只读 BOS 上的 index、写回摘要。
- **谁、怎样用这份 memory**：厂外桥在本地做完整「读→注入、写回」；厂内从 BOS 读 index 注入、会话结束写回摘要到 BOS；厂外可定期拉取厂内写回条目并合并进本地 memory。

#### 10.6.1 厂内如何用上 memory：三种方式（当前仅 B/C 可行）

| 方式 | 做法 | 适用性 |
|------|------|--------|
| **A. 厂内直接接入厂外 cursor-bridge** | 厂内请求打厂外桥，桥调 Cursor；memory 在桥侧。 | **不可行**：厂内不可访问厂外、数据不能出厂。 |
| **B. 协议 + BOS index，厂内工具自实现** | BOS 只存 **index/摘要**（见 10.6.2）；厂内工具读 BOS 上的 index → 注入 prompt，会话结束把**摘要**写回 BOS；厂外定期把厂内写回合并进本地。 | 可行；厂内实现「读 BOS index、注入、写回摘要」。 |
| **C. 厂内轻量 memory 适配服务** | 厂内小服务：读 BOS index、按协议注入与写回摘要；厂内 comet/OpenClaw 调该服务。 | 可行；协议集中在一处，多工具复用。 |

**结论**：在「数据不出厂、不访问厂外」前提下，仅 **B 或 C**；BOS 上只放 **index/摘要**，不做全量同步，私有正文留在本地。

#### 10.6.2 BOS 只存 index/摘要（不做全量同步）

**原则**：完整第二大脑（MEMORY.md、daily、笔记库）留在**厂外本地**；BOS 仅作为**厂内/厂外共享的轻量层**，存可对外暴露的 index/摘要，体量小、可定期更新。

| 环节 | 职责 |
|------|------|
| **厂外 → BOS（推送）** | 桥或本地脚本**定期/按需**生成并上传：例如「MEMORY 摘要」（关键事实、决策、偏好，脱敏）、「近期要点」（如近 N 日 daily 的摘要或标题列表）。不推送全文；格式可为约定好的 JSON/MD，体积可控。 |
| **BOS 上内容** | 仅 index/摘要：如 `memory_index.json`（MEMORY 摘要）、`recent_highlights.md`（近期要点）、可选 `structure_index.md`（笔记/项目目录结构索引，不含正文）。厂内会话写回也以「摘要条目」形式 append（如「日期 + 主题 + 结论」），不存完整对话。 |
| **厂内** | 从 BOS 拉取上述 index；在请求前把 index 内容注入到 prompt，使厂内 agent 具备「上下文轮廓」。会话结束后，把**本次会话摘要**（时间、主题、关键结论）写回 BOS 的写回区；不写完整对话内容。 |
| **厂外 ← BOS（拉取合并）** | 厂外定期（或手动）拉取 BOS 上「厂内写回」的摘要条目，合并进本地 `memory/YYYY-MM-DD.md` 或 MEMORY.md（如「厂内 session：…」），保证第二大脑里也有厂内产生的沉淀。 |

**隐私与体量**：私有正文不落 BOS；BOS 仅存可接受对外/上云的 index 与摘要，且数据量小，无需实时全量拷贝。

#### 10.6.3 协议（index 格式与写回约定）

- **Index 格式**：约定 BOS 上文件名与结构（如 `memory_index.json`、`recent_highlights.md`、`inbound/` 厂内写回目录）；与 10.4.1 的「记忆形态」在**语义上对齐**（摘要对应 MEMORY/daily 的提炼），但**不要求**与本地文件路径一致（因 BOS 不是全量镜像）。
- **厂内写回格式**：约定单条摘要的字段（日期、来源、主题、结论/要点），便于厂外脚本解析并合并到本地 daily/MEMORY。
- **文档化**：将「BOS index 结构 + 厂内读/写回协议」整理成独立说明，便于厂内按 B 或 C 实现、厂外实现推送/拉取合并脚本。

#### 10.6.4 独立同步工具：MCP + BOS 中转 + 本机轮询 server（推荐形态）

**思路**：做一个**独立工具**，通过 BOS 中转 + 本机轮询，同时满足「厂内沉淀进第二大脑」和「厂内查第二大脑」两条需求；两条需求**统一放在同一个 MCP** 里，厂内一个入口，本机一个 server 处理两类 BOS 目录。

**需求一：厂内做的事 / 知识沉淀 → 进第二大脑**

- 厂内工具（comet 等）调用 MCP 的 **「存到第二大脑」** 工具（如 `save_to_second_brain(content, metadata?)`）。
- MCP 侧：把内容按约定格式写入 BOS 的**写回区**（如 `inbound/save/`），可选带元数据（日期、来源、类型）。
- 本机侧：**轮询 server** 定期拉取 BOS 写回区，发现新条目就解析并**合并进本地 iCloud 第二大脑**（如 append 到 `memory/YYYY-MM-DD.md` 或写入 MEMORY，按约定规则）。
- 效果：厂内产生的信息/知识自动经 BOS 进入你的专属第二大脑，无需厂内直接访问本机。

**需求二：厂内查第二大脑（带 Cursor 的「真」查询）**

- 厂内工具调用 MCP 的 **「查第二大脑」** 工具（如 `query_second_brain(prompt)`）。
- MCP 侧：把 `prompt` 及约定格式（如 request_id、时间戳）写入 BOS 的**查询请求区**（如 `inbound/query/`）。
- 本机侧：轮询 server 发现新请求 → 把该 prompt **带入本机 Cursor 进程**（如经 cursor-bridge 或 cursor-agent）执行 → 得到返回后写入 BOS 的**响应区**（如 `outbound/query/<request_id>`）。
- 厂内侧：MCP 轮询或一次性读 BOS 响应区，拿到结果后返回给厂内调用方。
- 效果：厂内「问第二大脑」时，实际是本机 Cursor 在完整第二大脑上执行，答案经 BOS 回传厂内；数据不出厂（只有 prompt 与结果经 BOS 中转，且可由你控制脱敏与体积）。

**是否把需求一和需求二都放进同一个 MCP？**

- **推荐：统一进同一个 MCP**。  
  - 厂内只需对接一个 MCP，暴露两个能力：`query_second_brain`（查）、`save_to_second_brain`（存）。心智简单、一次配置。  
  - 本机侧同一个 **轮询 server** 即可：既轮询「查询请求区」并调 Cursor、写回响应区，又轮询「写回区」并合并到本地第二大脑。实现可复用 BOS 客户端、鉴权与目录约定。  
  - 「存」和「查」语义对称，都表达「和第二大脑交互」，放在一个工具里更一致。
- **若需求一单独做**：厂内不用 MCP 存，而是直接往 BOS 某目录写（或调别的 API），本机只做 BOS→本地合并。这样 MCP 只负责「查」。缺点是多一套对接方式；适合「存」的触发方非常分散、且形态简单（仅写文件）时再考虑。

**BOS 目录建议（与 10.6.2 / 10.6.3 对齐）**

| BOS 路径 | 方向 | 用途 |
|----------|------|------|
| `index/memory_index.json`、`index/recent_highlights.md` 等 | 厂外 → BOS | 本机推送的 index/摘要，厂内 MCP 或工具可读后注入 prompt |
| `inbound/query/<id>.json` | 厂内 → BOS | 厂内「查第二大脑」请求（prompt + 元数据）；本机轮询处理 |
| `outbound/query/<id>.json` | BOS → 厂内 | 本机 Cursor 执行结果；厂内 MCP 读后返回调用方 |
| `inbound/save/<id>.json` 或按日分文件 | 厂内 → BOS | 厂内「存到第二大脑」内容；本机轮询合并到本地 |

**实施要点**：见 Phase 5 checklist（§11）；独立工具可拆为「厂内 MCP 实现」+「本机轮询 server（含 Cursor 调用与写回合并）」两部分的实现与部署说明。

#### 10.6.5 厂内工具选型：Comate vs OpenClaw（厂内）

**核心**：厂内只要有一种工具**能接上述 MCP**（查第二大脑、存到第二大脑），即可满足「和第二大脑互相同步」的需求；不必同时上 Comate 和 OpenClaw，按场景选一个或两个即可。

| 工具 | 典型场景 | 与 MCP 的关系 | 是否「必须」 |
|------|----------|----------------|--------------|
| **Comate**（AI IDE） | 厂内编码、问问题、读代码；调 MCP 查第二大脑、存沉淀。 | 若 Comate 支持配置 MCP，接上即可实现查/存。 | **不必**和 OpenClaw 二选一；若你主要需求是「厂内 IDE 里用第二大脑」，Comate 单用就够。 |
| **OpenClaw（厂内）** | 在**聊天渠道**（如钉钉）里和 AI 对话、并可**在聊天里发起/运行实验**（提交任务、跑流水线等）。 | 厂内 OpenClaw 配置成调用同一套 MCP，即可在钉钉里也「查/存第二大脑」。 | 多出来的价值是「**在聊天里跑实验**」——若你需要这条，配厂内 OpenClaw 才有意义；若不需要，Comate + MCP 即可。 |

**建议**：

- **只想要「厂内也能查第二大脑、把厂内产出沉淀回去」**：用 **Comate + MCP** 即可，不必额外配厂内 OpenClaw；配置量小、心智简单。
- **还想要「在钉钉/聊天里一句话触发厂内实验」**：再上 **厂内 OpenClaw**，并把同一 MCP 配进去；这样聊天里既能查/存第二大脑，又能跑实验。此时 OpenClaw 的「多 Agent + 聊天入口 + 可编排动作」才有明显加成。

**结论**：Comate 和厂内 OpenClaw 不是非此即彼；**至少有一种厂内工具能接该 MCP** 就有意义。OpenClaw 厂内的额外意义在于「在聊天里跑实验」，按需决定是否配置。

---

## 11. 实施计划

### Phase 1：最小可行桥（MVP）

**目标**：非流式 + 流式打通，OpenClaw 钉钉能收到 Cursor 回复

- [x] cursor-agent 登录（环境前置，非代码项）
- [x] 实现 `server.js`：监听 `/v1/chat/completions` 和 `/health`；单测见 `test/server.test.js`、`test/bridge.test.js`。
- [x] 实现 `prompt-builder.js`：messages → 单条 prompt；单测见 `test/prompt-builder.test.js`。
- [x] 实现 `agent-runner.js`：spawn cursor-agent（非流式 + 流式）；单测见 `test/bridge.test.js`（使用 `test/fixtures/fake-agent.js`）。
- [x] 实现 `stream-parser.js`：NDJSON → SSE（流式）；单测见 `test/stream-parser.test.js`。
- [x] 配置 OpenClaw 指向桥（文档见 README / NOTES）
- [x] 手动启动桥，钉钉发消息验证（验收步骤）

### Phase 2：稳定运行

**目标**：常驻、自愈、日志

- [x] **pm2 / launchd 常驻部署**：`npm run pm2:start` / `pm2:stop` / `pm2:restart` / `pm2:logs`；部署后可用 `npm run pm2:smoke` 校验 /health 与 /config。
- [x] **健康检查端点**：GET /health、GET / 返回 200 及 status/cursor_agent/version；单测见 `test/phase2-stable.test.js`。
- [x] **错误日志和监控**：错误响应均为 OpenAI 兼容 `{ error: { message, type, code? } }`；404/400/503 契约由 Phase 2 单测覆盖。
- [x] **OpenClaw fallback 配置验证**：agent 不可用（如 not logged in）时返回 503、code `bridge_agent_not_ready`，单测用 `test/fixtures/fake-agent-fail.js` 模拟，OpenClaw 可据此降级。

### Phase 3：Memory 集成

**目标**：cursor-agent 有记忆

- [ ] prompt-builder 注入 Memory 上下文
- [ ] 按 Agent 分发不同 workspace
- [ ] 请求结束后自动更新 daily note

### Phase 4：多模态（图片）桥支持

**目标**：钉钉等渠道上传的图片经桥传给 Cursor，agent 能看图回答（见 10.5）

- [ ] prompt-builder 扩展：识别 `content` 中的 `image_url`（data URL），解码 base64 并落盘到 workspace 约定目录
- [ ] 在拼出的 prompt 中插入图片路径说明（「用户发送了一张图片，路径为：…」）
- [ ] 可选配置 `CURSOR_BRIDGE_MULTIMODAL_IMAGES=1` 与落盘目录、清理策略
- [ ] 与 OpenClaw 侧约定：请求中带图片时以 `image_url` 或路径占位形式放入 messages

### Phase 5：厂内环境与 memory 复用

**目标**：厂内（无机器操作权限、不可访问厂外、数据不出厂）也能用 AI；厂内**沉淀**进第二大脑、厂内**查**第二大脑，通过「独立同步工具：MCP + BOS 中转 + 本机轮询 server」统一实现（见 10.6，含 10.6.4）

- [ ] **BOS 仅存 index/摘要 + 中转文件**：约定 BOS 目录（index 区、`inbound/query`、`outbound/query`、`inbound/save`）；不存全量笔记库，私有正文留本地
- [ ] **厂内 MCP（统一入口）**：提供 `query_second_brain(prompt)`（写 BOS 请求区、读响应区返回）与 `save_to_second_brain(content, metadata?)`（写 BOS 写回区）；厂内 comet 等接此 MCP 即可「查」+「存」
- [ ] **本机轮询 server**：常驻进程轮询 BOS——(1) 发现新查询请求则调本机 Cursor（或 cursor-bridge）执行，结果写 BOS 响应区；(2) 发现新写回则合并进本地 iCloud 第二大脑（memory/daily 或 MEMORY）
- [ ] **厂外 → BOS（index）**：定期/按需生成 MEMORY 摘要与近期要点上传 BOS index 区，供厂内注入上下文（可选，与 MCP 读 index 对齐）
- [ ] **协议与部署文档化**：BOS 路径与报文格式、本机 server 与 Cursor 的调用方式、合并规则；独立工具可拆为「厂内 MCP」+「本机 server」两部分的实现说明

### Phase 6：体验优化

**目标**：更快、更智能

- [ ] 模型选择策略（不同 Agent 用不同 `--model`）
- [ ] prompt 压缩（长对话历史的摘要）
- [ ] cursor-agent `--mode plan/ask` 用于只读场景
- [ ] 并发请求管理（避免同时 spawn 过多 agent）

---

## 12. 技术选型

| 决策项 | 选择 | 理由 |
|--------|------|------|
| **语言** | Node.js | OpenClaw 本身是 Node 生态；npm 生态成熟；子进程管理 (`child_process`) 稳定 |
| **HTTP 框架** | 无框架（原生 `http` 模块） | 桥只有 2 个端点，不需要 Express/Fastify 的复杂度；减少依赖 |
| **进程管理** | pm2 | 简单、跨平台、自动重启、日志管理 |
| **流式** | Node.js Readable Stream + readline | 逐行读取 cursor-agent stdout，天然适配 NDJSON |
| **配置** | dotenv + 环境变量 | 最简单的配置方式；一个 `.env` 文件搞定 |

### 依赖清单（极简）

```json
{
  "dependencies": {
    "dotenv": "^16.0.0"
  },
  "devDependencies": {}
}
```

只有一个依赖。其他全部用 Node.js 内置模块（`http`、`child_process`、`readline`、`crypto`）。

---

## 13. 前置条件确认清单

在开始写代码之前，需要确认的事项：

| 项目 | 当前状态 | 需要的操作 |
|------|----------|------------|
| Cursor 桌面版 | 已安装 | 无 |
| cursor-agent CLI | 已安装 (2026.03.11) | 无 |
| cursor-agent 登录 | **未登录** | 执行 `cursor-agent login` |
| cursor-agent 信任 | 未做 | 在笔记库目录执行一次 `cursor-agent "test" --print --trust` |
| Node.js | 需确认版本 | `node --version`（需要 18+） |
| OpenClaw | 已安装并运行 | 无 |
| 钉钉 channel | 已配置 | 无 |

---

## 14. 参考资料

- **知识说明与排查**（Responses vs Completions 科普、图示信息与排查步骤）：[NOTES.md](./NOTES.md)
- **cursor-agent CLI 帮助**：`cursor-agent --help`（完整参数见本文 3.2 节）
- **OpenClaw custom provider 文档**：`openclaw/docs/gateway/configuration-examples.md`（Local models 示例）
- **OpenClaw models 配置**：`openclaw/docs/concepts/models.md`
- **已有桥接方案文档**：`1-Projects项目/Antigravity_openclaw_工作流/OpenClaw与Cursor_CLI桥接方案.md`
- **Trust wrapper 脚本**：`6-System系统/Scripts脚本/cursor_agent_trust_wrapper_setup.sh`

---

*文档版本：v1.0 | 2026-03-13 | 基于实际环境调研和 OpenClaw + cursor-agent 文档编写*
