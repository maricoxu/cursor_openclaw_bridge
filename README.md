# cursor-bridge

OpenClaw ↔ Cursor CLI 桥接服务：让钉钉等 IM 的请求走 Cursor 订阅，省钱且稳。

- **设计文档**：[DESIGN.md](./DESIGN.md)
- **代码梳理**（模块职责、数据流、测试覆盖）：[CODE_OVERVIEW.md](./CODE_OVERVIEW.md)
- **知识说明与排查**（API 区别科普、图示信息、无回复排查）：[NOTES.md](./NOTES.md)
- **Phase 1**：已实现非流式 + 流式 `/v1/chat/completions`、`/health`、超时与错误处理。

## 快速开始

### 1. 环境

- Node.js 18+
- 已安装并登录 [cursor-agent](https://cursor.com/install)：`cursor-agent login`
- 工作区信任（可选）：在目标目录执行一次 `cursor-agent "test" --print --trust`

### 2. 安装与配置

```bash
cd cursor-bridge
npm install
cp .env.example .env
# 编辑 .env，确认 CURSOR_WORKSPACE 指向你的笔记库（或项目）路径
```

若不需要 API 鉴权，在 `.env` 中留空 `BRIDGE_API_KEY=`，则请求可不带 `Authorization`。

### 3. 启动

```bash
npm start
# 或 node src/server.js
```

默认监听 `http://127.0.0.1:3847`。提供 `GET /health`、`GET /v1/models`（OpenAI 兼容模型列表，可减少控制台 404）、`POST /v1/chat/completions`。

**调试日志**：默认不打印请求/响应等日志，以减少开销。需要排查时设置环境变量 `CURSOR_BRIDGE_DEBUG=1` 再启动（如 `CURSOR_BRIDGE_DEBUG=1 npm start`），即可看到每条请求的路径、状态码及 runAgent 等调试信息。

### 4. 验证

```bash
# 健康检查（cursor-agent 可用且已登录时返回 200）
curl -s http://127.0.0.1:3847/health

# 非流式对话（若配置了 BRIDGE_API_KEY，需加 -H "Authorization: Bearer <你的 key>"）
curl -s -X POST http://127.0.0.1:3847/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"cursor-agent","messages":[{"role":"user","content":"hello"}],"stream":false}'
```

### 5. OpenClaw 配置

在 `~/.openclaw/openclaw.json` 中：

1. **增加 cursor-cli provider**（`models.providers`）：

**推荐使用 `openai-completions`**（界面能正常显示回复；若用 `openai-responses`，OpenClaw 对自定义 provider 的解析可能不显示内容）：

```json
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
```

2. **把默认模型设为桥，fallback 留 OpenRouter**：

```json
"agents": {
  "defaults": {
    "model": {
      "primary": "cursor-cli/cursor-agent",
      "fallbacks": ["openrouter/google/gemini-3-flash-preview"]
    }
  }
}
```

`apiKey` 与桥 `.env` 中的 `BRIDGE_API_KEY` 一致；若桥未配置 `BRIDGE_API_KEY`，OpenClaw 里可填 `"apiKey": "any"`。

配置后重启 OpenClaw Gateway，在钉钉发消息即可走 Cursor。

**若桥返回 200 但界面没有任何回复**：多半是 OpenClaw 对自定义 provider 的 `openai-responses` 解析不完整。把上面的 `"api": "openai-responses"` 改成 `"api": "openai-completions"`，重启 Gateway 再试，回复会走 `POST /v1/chat/completions` 并正常显示。

## 常驻运行（可选）

```bash
npm install -g pm2
pm2 start src/server.js --name cursor-bridge --cwd /path/to/cursor-bridge
pm2 save
pm2 startup  # 按提示执行以开机自启
```

## 测试

```bash
npm test
```

使用 Node 内置 `node:test`。覆盖：

- **单元**：`prompt-builder`（拼 prompt）、`stream-parser`（NDJSON→SSE，含 type assistant/result/顶层 content）
- **集成**：`test/bridge.test.js` 用 **fake-agent**（`test/fixtures/fake-agent.js`）模拟 cursor-agent，测 **非流式 + 流式** `/v1/chat/completions`、多轮对话、以及「今天天气怎么样」类内容（fake-agent 根据 prompt 是否含「天气」返回不同回复）

测试时自动设 `NODE_ENV=test`、`CURSOR_AGENT_BIN=node`、`CURSOR_AGENT_SCRIPT=test/fixtures/fake-agent.js`，无需真实 cursor-agent。本地改完代码跑一遍 `npm test` 通过后再上 OpenClaw 界面调试即可。

## 目录结构

```
cursor-bridge/
├── DESIGN.md           # 设计文档
├── CODE_OVERVIEW.md    # 代码梳理（模块、数据流、测试）
├── NOTES.md            # 知识说明与排查（科普、图示信息、无回复排查）
├── README.md           # 本说明
├── package.json
├── .env.example / .env
├── src/
│   ├── server.js       # HTTP 入口、路由、健康检查
│   ├── prompt-builder.js
│   ├── agent-runner.js
│   └── stream-parser.js
└── scripts/
    └── start.sh
```
