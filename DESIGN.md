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

### 10.3 与 OpenClaw 多 Agent 体系的对接

你当前的 OpenClaw 配置有 8 个 Agent（小哩中枢、技术管理、首席架构…），每个 Agent 有独立的 `agentDir`。未来桥可以：

1. OpenClaw 在请求头或 body 中传递 `agent_id`
2. 桥根据 `agent_id` 查找对应 Agent 的 `agentDir`
3. cursor-agent 用该 `agentDir` 作为 `--workspace`
4. 不同 Agent 看到不同的文件上下文 → 表现出不同的「记忆」和「能力」

### 10.4 Phase 3 Memory 体系运作设计（讨论稿）

目标：让经桥调用的 cursor-agent **有记忆**——既能读到「记忆」上下文，又能在合适时机把本次对话沉淀回记忆。下面按三条 Phase 3 任务拆成「谁读谁写、何时、怎么接 OpenClaw」。

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
  - **长度与裁剪**：MEMORY.md + daily 可能很长，需策略（按字符/按段/按条数裁剪、或只取「最近 N 条」）。否则容易爆上下文、拖慢首 token。
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

#### 10.4.6 开放问题（待定）

- **OpenClaw 是否已支持在请求里带 agent_id**：若尚未支持，需 OpenClaw 侧先扩展（header 或 body），桥再按约定解析；或短期用「单 workspace + 只注入根 MEMORY/daily」不区分 Agent。
- **注入记忆的 token 上限与裁剪策略**：例如「MEMORY.md 最多取前 4k 字 + 今日 daily 前 2k 字」，避免首 token 过慢。
- **daily 更新内容格式**：与现有 `memory/YYYY-MM-DD.md` 的用法（如 AI 交互记录、复盘）是否统一，是否需要和 AGENTS.md 里「Write It Down」的格式对齐。
- **Agent 级 MEMORY.md 的维护**：若每个 Agent 有独立 MEMORY，是仅「注入读取」还是也支持「请求结束后写回该 Agent 的 MEMORY」；若写回，是否一律走 cursor-agent 归档（避免桥解析语义）。

以上可作为 Phase 3 实现前与产品/OpenClaw 对齐的讨论基础；定稿后再反哺到 11 节 Phase 3 的拆项与验收标准。

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

### Phase 4：体验优化

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
