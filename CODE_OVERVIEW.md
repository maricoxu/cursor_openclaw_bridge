# cursor-bridge 代码梳理

> 模块职责、数据流与测试覆盖概览

## 1. 目录与模块

| 路径 | 职责 |
|------|------|
| `src/server.js` | HTTP 入口：路由、鉴权、健康检查、/v1/chat/completions（非流式+流式）、/v1/responses |
| `src/prompt-builder.js` | 将 OpenAI `messages[]` 转为单条 prompt 字符串（供 cursor-agent 使用） |
| `src/agent-runner.js` | 子进程调用 cursor-agent：非流式 `runAgent()`、流式 `runAgentStream()`，超时与错误处理 |
| `src/stream-parser.js` | 将 cursor-agent 的 NDJSON 流解析为 OpenAI 风格 SSE（`data: {...}\n\n`），仅过滤 thinking/心跳，不做去重 |
| `test/*.test.js` | Node 内置 `node:test` 单测，不依赖真实 cursor-agent |

## 2. 请求数据流

```
POST /v1/chat/completions (JSON body)
  → checkAuth
  → buildPrompt(messages)           [prompt-builder]
  → stream? runAgentStream() : runAgent()   [agent-runner]
  → 非流式: extractContentFromJson(stdout) → sendJson(200, choices)
  → 流式:   agentStream → createStreamParser(meta) → res (SSE)
```

- **/v1/responses**（OpenResponses）：解析 `input`/`instructions` 为 messages，再走同一套 `buildPrompt` + `runAgent`，返回 `output[].content[].text` 结构。
- **/health**：spawn `cursor-agent about`，根据退出码与 stderr 判断是否已登录、可用。

## 3. 关键设计点

- **鉴权**：`BRIDGE_API_KEY` 为空则不校验；否则要求 `Authorization: Bearer <key>`。
- **不做去重**：桥仅做 NDJSON→SSE 解析及 thinking/心跳过滤，重复问题根因在上游 Cursor Agent。
- **超时**：`CURSOR_AGENT_TIMEOUT_MS`（默认 180s），超时后子进程 SIGKILL。
- **错误映射**：not logged in → 503，timeout → 504，其他 → 502；错误体为 OpenAI 兼容 `error: { message, type, code }`。

## 4. 测试覆盖

| 套件 | 内容 |
|------|------|
| `prompt-builder.test.js` | 空/非数组、单条 user、system+user、多轮、content 为数组/非字符串、忽略 tool 等 role |
| `stream-parser.test.js` | parseNdjsonLine：非 assistant、content 数组/多 part、无效 JSON、无 content；createStreamParser：NDJSON→SSE |
| `server.test.js` | GET /v1/models、404、POST /v1/chat/completions 无 body/非法 JSON/空 messages（均 400）；不启动真实 agent |

运行：`npm test`（`node --test test/*.test.js`）。

## 5. 环境与配置

- **Node**：>=18，ESM（`"type": "module"`）。
- **依赖**：仅 `dotenv`。
- **配置**：`.env`（见 `.env.example`），含 `BRIDGE_HOST/PORT`、`BRIDGE_API_KEY`、`CURSOR_WORKSPACE`、`CURSOR_AGENT_BIN`、`CURSOR_AGENT_TIMEOUT_MS`、`CURSOR_AGENT_MODEL`、`CURSOR_AGENT_EXTRA_ARGS`。
