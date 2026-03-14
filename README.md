# cursor-bridge

OpenClaw ↔ Cursor CLI 桥接服务：让钉钉等 IM 的请求走 Cursor 订阅，省钱且稳。

- **设计文档**：[DESIGN.md](./DESIGN.md)
- **代码梳理**（模块职责、数据流、测试覆盖）：[CODE_OVERVIEW.md](./CODE_OVERVIEW.md)
- **知识说明与排查**（API 区别科普、图示信息、无回复排查）：[NOTES.md](./NOTES.md)

---

## 从无到有安装

以下步骤从零开始，装好即可在 OpenClaw / 钉钉里用 Cursor 回复。

### 1. 前置条件

| 项目 | 要求 | 说明 |
|------|------|------|
| **Node.js** | 18 或以上 | `node -v` 检查；未装请到 [nodejs.org](https://nodejs.org/) 安装 LTS |
| **Cursor 桌面版** | 已安装 | 用于使用 Cursor 订阅与 Agent 能力 |
| **cursor-agent CLI** | 已安装并在 PATH | 见下一步 |
| **OpenClaw** | 已安装并运行 | 桥只负责「把 OpenClaw 的请求转给 cursor-agent」 |

### 2. 安装并登录 cursor-agent

1. 安装 **cursor-agent**（若尚未安装）：
   - 打开 Cursor 桌面版 → 设置中查看 CLI 安装说明，或参考 [Cursor 文档](https://cursor.com/install)。
   - 常见位置：安装后会在 `~/.local/bin/cursor-agent` 或系统 PATH 中。
2. 终端执行登录（只需做一次）：
   ```bash
   cursor-agent login
   ```
   按提示在浏览器完成授权。
3. （可选）在工作区目录做一次信任，避免首次对话弹窗：
   ```bash
   cd /path/to/your/workspace
   cursor-agent "test" --print --trust
   ```

### 3. 安装桥

```bash
# 进入项目目录（若从 git 克隆则先 cd 到克隆目录）
cd cursor-bridge

# 安装依赖（仅 dotenv，无其他）
npm install
```

### 4. 配置 .env

```bash
cp .env.example .env
# 用任意编辑器打开 .env，修改下面两项即可
```

**必改项：**

| 变量 | 说明 | 示例 |
|------|------|------|
| **CURSOR_WORKSPACE** | 工作区绝对路径（笔记库或项目目录） | `"/Users/你/笔记库"` 或 `"/Users/你/project"` |
| **BRIDGE_API_KEY** | 鉴权密钥（可选） | 留空则请求可不带 Authorization；若填 `my-secret`，OpenClaw 里需填相同 key |

**可保持默认的：**

- `CURSOR_AGENT_BIN=cursor-agent`：桥会自动从 PATH 和常见目录（如 `~/.local/bin`、`/usr/local/bin`、`/opt/homebrew/bin`）查找，一般无需写绝对路径。
- `BRIDGE_HOST=127.0.0.1`、`BRIDGE_PORT=3847`：本机访问即可。
- `CURSOR_AGENT_TIMEOUT_MS=180000`、`CURSOR_AGENT_MODEL=auto` 等可按需改。

### 5. 启动与验证

**前台启动：**

```bash
npm start
```

看到 `cursor-bridge 1.0.0 listening on http://127.0.0.1:3847` 即表示成功。

**验证：**

```bash
# 健康检查（应返回 JSON 且 status 为 ok 或 degraded）
curl -s http://127.0.0.1:3847/health

# 看当前生效配置（含解析后的 CURSOR_AGENT_BIN 路径）
curl -s http://127.0.0.1:3847/config
```

若 `/health` 返回 503，多半是 cursor-agent 未登录或未找到，可看终端里的 `[bridge] effective config` 或 `curl .../config` 确认 `CURSOR_AGENT_BIN` 是否解析到正确路径。

### 6. 接入 OpenClaw（钉钉等）

1. 打开 OpenClaw 配置（如 `~/.openclaw/openclaw.json`）。
2. 在 **models.providers** 中增加 cursor-cli（若已有可跳过）：

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

3. 把 **agents.defaults.model** 设成走桥，并保留 fallback（桥不可用时走 OpenRouter 等）：

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

4. **apiKey** 与桥 `.env` 里 `BRIDGE_API_KEY` 一致；若桥未配置 `BRIDGE_API_KEY`，这里可填 `"apiKey": "any"`。
5. **重启 OpenClaw Gateway**，在钉钉发一条消息测试。

### 7. 可选：pm2 常驻

需要桥在后台常驻、开机自启时：

```bash
npm install -g pm2
npm run pm2:start
pm2 save
pm2 startup   # 按提示执行以开机自启
```

部署后用 `npm run pm2:smoke` 校验；日常可 `pm2 logs cursor-bridge`、`pm2 restart cursor-bridge`。

**遇到问题**：`cursor-agent` 找不到（ENOENT）时可在 `.env` 里把 `CURSOR_AGENT_BIN` 设为绝对路径；pm2 下超时或重启频繁可看 [NOTES.md](./NOTES.md) 的排查说明。

---

## 快速开始（已有环境时）

已具备 Node 18+、cursor-agent 登录、.env 配置时：`npm install` → `cp .env.example .env` 并改 `CURSOR_WORKSPACE` → `npm start`。调试可设 `CURSOR_BRIDGE_DEBUG=1`。非流式测试示例：

```bash
curl -s -X POST http://127.0.0.1:3847/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"cursor-agent","messages":[{"role":"user","content":"hello"}],"stream":false}'
```

**无回复排查**：桥返回 200 但钉钉/界面无内容时，把 OpenClaw 里该 provider 的 `"api"` 设为 `"openai-completions"` 并重启 Gateway，详见 [NOTES.md](./NOTES.md)。

## 常驻运行（可选）

在项目根目录执行：

```bash
npm install -g pm2
npm run pm2:start    # 等同 pm2 start src/server.js --name cursor-bridge
pm2 save
pm2 startup          # 按提示执行以开机自启
```

部署后可用 `npm run pm2:smoke` 校验桥是否正常（请求 /health 与 /config，均 200 则通过）。其他：`npm run pm2:stop`、`pm2:restart`、`pm2:logs`。

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
