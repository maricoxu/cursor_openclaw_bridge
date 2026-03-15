# Phase 3 Memory 体系：代码设计与调用拆解

本文档是 Phase 3「Memory 集成」的**实现规格与拆解**，供写代码时按任务逐项实现。产品目标与原则见 [DESIGN.md §10.4](./DESIGN.md)；需求与优先级见笔记库 `1-Projects项目/IDE_openclaw_工作流/MEMORY_REQUIREMENTS.md`。

---

## 1. 目标与约束（摘要）

- **目标**：桥在请求时注入「记忆上下文」、请求结束后写回 daily/MEMORY；支持按 agent_id 分发 workspace；与 OpenClaw 自身 memory、笔记为唯一事实来源兼容。
- **约束**：实现放在 **cursor-bridge 仓内**；笔记 = 完全沉淀 + 方便读取优先；可选接入 Engram MCP 作检索层（本期可实现「读文件注入」为主，Engram 可后续接）。

### 1.1 总开关（便于调试与快速关闭）

- **`CURSOR_BRIDGE_MEMORY_ENABLED`**：未设或 `0` 时，**整个 Phase 3 Memory 功能关闭**（不解析 agent_id、不读 memory、不注入、不写回、workspace 恒为 `CURSOR_WORKSPACE`），行为与未实现 Phase 3 完全一致。设为 `1`/`true` 开启。出问题或调试时可随时关掉。
- **性能**：开关关闭时**不进入**任何 Memory 分支（不调 resolveWorkspace、readMemoryContext、prependMemoryToSystem、appendDailyNote），无额外文件 I/O 或 CPU；仅多一次布尔判断与少量字符串解析，可忽略。代码保留不影响「默认关」时的性能。

### 1.2 记忆分层：近 / 远 / 他 Agent（查得快 vs 查得全）

**核心作用**：**近 = 查得快**（主要功能）；**远 = 索引更少、整体更快**，但**查都能查全**——某个任务突然需要用到远端 memory 时也能查到，只是多花点时间「回想」而已。

| 层级 | 内容 | 限额（默认） | 作用 |
|------|------|--------------|------|
| **近** | 根 MEMORY、今日/昨日 daily、当前 Agent MEMORY | 默认**不限额**；可选 env 设正数做截断 | **查得快**：优先注入，模型先看这里，响应快 |
| **远** | 更早 N 天的 daily | `FAR_DAYS` 控制天数；每文件默认不限额 | 索引更少→整体更快；需要时**仍能查全**，只是回想稍慢 |
| **他 Agent** | 其他 Agent 的 MEMORY | `OTHER_AGENTS=1` 开启；每 Agent 默认不限额 | 同上：能查全，需要时多花点时间 |

### 1.3 字符限额（默认不限额，可选用于分析或控 token）

**默认不设限额**（0 = 读全文）。若后续需要控 token 或做数据分析，可在 `.env` 里把 `CURSOR_BRIDGE_MEMORY_NEAR_MAX_ROOT`、`*_MAX_DAILY_*`、`*_MAX_AGENT`、`FAR_MAX_PER_DAY`、`OTHER_MAX_PER_AGENT` 设成正数，桥才会按字符截断；未设或为 0 时一律不截断。

---

## 2. 架构与端到端数据流

```
┌─────────────────────────────────────────────────────────────────────────┐
│  OpenClaw  POST /v1/chat/completions                                     │
│  Body: { messages, stream }   Header 或 Body 扩展: agent_id (可选)       │
└─────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  server.js                                                               │
│  ① 解析 agent_id（header X-Agent-Id 或 body.agent_id）                   │
│  ② resolveWorkspace(agent_id) → { workspacePath, memoryPaths }          │
│  ③ 若 CURSOR_BRIDGE_INJECT_MEMORY=1：                                    │
│       memoryContext = readMemoryContext(workspacePath, memoryPaths)      │
│     否则 memoryContext = ''                                               │
│  ④ 若注入 memory：messages 可裁剪为「1 system + 1 user」（单轮）         │
│  ⑤ 将 memoryContext 作为 [Memory] 块拼到第一条 system 前                 │
│  ⑥ prompt = buildPrompt(messagesWithMemory)                             │
│  ⑦ runAgentStream({ ... opts, workspace: workspacePath })               │
│  ⑧ 流式/非流式结束且无错误时，若 CURSOR_BRIDGE_UPDATE_DAILY=1：           │
│       appendDailyNote(workspacePath, reqId, lastUser, assistantSummary)  │
└─────────────────────────────────────────────────────────────────────────┘
                                      │
                    ┌─────────────────┴─────────────────┐
                    ▼                                     ▼
         readMemoryContext()                    appendDailyNote()
         (memory-reader.js)                     (daily-writer.js 或同模块)
         读 MEMORY.md + daily + 可选 Agent MEMORY   按模板 append memory/YYYY-MM-DD.md
```

---

## 3. 输入输出约定

### 3.1 请求输入

| 来源 | 字段/方式 | 说明 |
|------|-----------|------|
| Header | `X-Agent-Id` | 可选，Agent 标识，如 `00_小哩中枢` |
| Body | `agent_id` 或 `agentId` | 可选，与 Header 二选一或同传（Header 优先） |
| Body | `messages` | 必填，OpenAI 格式；开启 memory 注入时桥可裁剪为 1 system + 1 user |
| Body | `stream` | 布尔，是否流式 |

### 3.2 workspace 与 memory 路径解析

- **无 agent_id**：`workspacePath = CURSOR_WORKSPACE`（笔记库根）；memory 读根目录 `MEMORY.md`、`memory/YYYY-MM-DD.md`。
- **有 agent_id**：查映射表 `agent_id → workspace 子路径`（见下「配置」）。  
  - 若映射为**目录**（如 `7-Agents/00_小哩中枢`）：`workspacePath = path.join(CURSOR_WORKSPACE, mappedDir)`；memory 可读该目录下 `MEMORY.md` + 笔记库根的 `memory/YYYY-MM-DD.md`（策略可配置）。  
  - 若映射为根：同无 agent_id。

输出结构建议：

```ts
// 类型示意
interface WorkspaceResolution {
  workspacePath: string;   // 绝对路径，传给 cursor-agent --workspace
  memoryPaths: {
    rootMemory: string;   // 根 MEMORY.md 绝对路径
    dailyPath: string;     // memory/YYYY-MM-DD.md 绝对路径（今日）
    dailyPathYesterday?: string;  // 可选昨日
    agentMemory?: string;  // 7-Agents/xx/MEMORY.md 绝对路径（若有）
  };
}
```

### 3.3 注入内容格式

- 读到的多段文本拼成一块，前面加标题，例如：`[Memory]\n\n${rootMemory}\n\n---\n\n${daily}\n\n${agentMemory ?? ''}`。
- 插入位置：在**第一条 system 消息的 content 前面**拼上该块；若没有 system，则作为第一条 system 的 content。再交给现有 `buildPrompt(messages)`。
- 裁剪策略：单文件可设最大字符数（如 MEMORY.md 前 8000 字，daily 前 4000 字），超出截断并加省略提示。

### 3.4 写回内容与路径

- **路径**：`workspacePath` 下的 `memory/YYYY-MM-DD.md`（按服务器当前日期）。若 workspace 为子目录（如 7-Agents/xx），写回策略可选「仍写笔记库根的 memory/YYYY-MM-DD.md」或「写 workspace 下的 memory/」（需在配置里约定）。
- **格式**：固定模板，与 OpenClaw / AGENTS 约定对齐，例如：
  ```markdown
  ## AI 交互记录
  ### {time} - {agent_id 或 'bridge'}
  - **问题**: {最后一条 user 摘要或原文截断}
  - **要点**: {assistant 回复摘要或原文截断}
  - **请求 id**: {reqId}
  ```
  实现前可再定最终模板（见 DESIGN 10.4.6 写回格式）。

---

## 4. 模块拆解与职责

### 4.1 新增/修改文件一览

| 文件 | 职责 |
|------|------|
| `src/memory-resolver.js` | 解析 agent_id → WorkspaceResolution（workspacePath + memoryPaths） |
| `src/memory-reader.js` | 同步读 MEMORY.md、daily、可选 Agent MEMORY；裁剪；返回拼接后的 memory 文本 |
| `src/daily-writer.js` | 按模板 append 到 memory/YYYY-MM-DD.md；可选限频 |
| `src/prompt-builder.js` | 扩展：支持传入「预拼好的 memory 块」，拼到第一条 system 前（或新增 buildPromptWithMemory） |
| `src/server.js` | 串联：解析 agent_id、调 resolver、读 memory、拼 prompt、传 workspace、写回 daily |

### 4.2 memory-resolver.js

- **输入**：`agentId: string | undefined`，`workspaceRoot: string`（即 CURSOR_WORKSPACE）。
- **输出**：`WorkspaceResolution`（见 3.2）。
- **逻辑**：
  - 无 agentId 或映射表里没有 → workspacePath = workspaceRoot；memoryPaths 只含根 MEMORY + 根下 memory/YYYY-MM-DD。
  - 有 agentId 且映射存在 → workspacePath = path.join(workspaceRoot, mappedPath)；memoryPaths 含根 MEMORY、根 daily、以及可选 agent 目录下 MEMORY。
- **配置**：映射表可从环境变量或配置文件读，例如 `CURSOR_BRIDGE_AGENT_WORKSPACES='00_小哩中枢:7-Agents/00_小哩中枢'`（多组用 `,` 或 `;` 分隔），或单文件 `config/agent-workspaces.json`。

### 4.3 memory-reader.js

- **输入**：`resolution: WorkspaceResolution`，`options: { maxRootChars?, maxDailyChars?, includeYesterday?: boolean }`。
- **输出**：`string`（拼接好的 [Memory] 块，无则返回 ''）。
- **逻辑**：
  - 按 resolution.memoryPaths 同步 `fs.readFileSync`（不存在则当空字符串）。
  - 对每段做长度裁剪；拼成 `[Memory]\n\n...`。
  - 若所有文件都不存在或为空，可返回 ''，避免注入空块。

### 4.4 daily-writer.js

- **输入**：`workspacePath: string`，`reqId: string`，`lastUserContent: string`，`assistantSummary: string`，可选 `agentId`。
- **逻辑**：
  - 计算今日日期 `YYYY-MM-DD`，目标文件 `memory/YYYY-MM-DD.md`（相对 workspacePath；若约定写回始终在笔记库根，则 workspacePath 用 CURSOR_WORKSPACE）。
  - 若文件不存在，可先写一级标题再 append 本条。
  - 限频：内存中记录「上次写回时间」，若与本次间隔 &lt; N 分钟可跳过（N 可配置，如 5）。
- **错误**：写失败打日志，不抛出不中断响应（已返回 200）。

### 4.5 prompt-builder.js 扩展

- **方式 A**：新导出 `buildPromptWithMemory(messages, memoryBlock)`。若 `memoryBlock` 非空，在拼 parts 时最前面插入 `[Memory]\n\n${memoryBlock}\n\n---\n\n`，再按现有逻辑拼 system + turns。
- **方式 B**：在 server 里先构造「带 memory 的 system」：若原 messages 有 system，则新 system content = memoryBlock + '\n\n' + 原 system content；否则新 messages 开头插一条 system，content = memoryBlock。再 `buildPrompt(messages)` 不变。
- 推荐 **方式 B**，少改 prompt-builder，易单测现有 buildPrompt。

### 4.6 server.js 改动点

- **解析 agent_id**：从 `req.headers['x-agent-id']` 或 `parsed.agent_id ?? parsed.agentId` 取；若未开 memory 功能可忽略。
- **调用顺序**（仅当开启 memory 时）：
  1. `resolution = resolveWorkspace(agentId, CURSOR_WORKSPACE)`；
  2. `memoryContext = readMemoryContext(resolution, opts)`；
  3. 若 `memoryContext` 非空且配置了「单轮」：messages 裁剪为 1 system + 1 user；
  4. 将 memoryContext 拼入第一条 system（或插入 system）；
  5. `prompt = buildPrompt(messages)`；
  6. `runAgentStream({ ..., workspace: resolution.workspacePath })`；
  7. 非流式：在返回 200 前，若开写回则 `appendDailyNote(...)`；流式：在 `finish()` 里若开写回则 `appendDailyNote(...)`，注意拿到「最后一条 user」和「assistant 全文或摘要」（流式需在 parser/response 里累积 content 或由上层传回）。
- **流式写回**：当前流式路径没有在桥侧累积 assistant 全文；若要写回摘要，可选（a）在 finish 时只写 lastUser + 占位「流式回复」或（b）在 parser 里累积 content，finish 时传出一段摘要（或 truncate 前 N 字）。可先实现「非流式写回 + 流式仅写 lastUser + 占位」，后续再补流式摘要。

---

## 5. 配置与环境变量

| 变量 | 含义 | 默认 |
|------|------|------|
| **`CURSOR_BRIDGE_MEMORY_ENABLED`** | **总开关**：1/true 开启整个 Memory 功能；未设或 0 则关闭（不注入、不写回、不按 agent 分发） | 不设=关闭 |
| `CURSOR_BRIDGE_UPDATE_DAILY` | 是否请求结束后写回 daily | 不设=不写回 |
| `CURSOR_BRIDGE_MEMORY_SINGLE_TURN` | 注入 memory 时是否强制单轮（1 system + 1 user） | 不设=不强制 |
| `CURSOR_BRIDGE_AGENT_WORKSPACES` | agent_id 到子路径映射，如 `id1:path1,id2:path2` | 不设=所有请求用 CURSOR_WORKSPACE |
| **近/远/他 Agent 字符限额** | **默认 0 = 不限额**；设为正数时才按字符截断（用于后续分析或控 token） | |
| `CURSOR_BRIDGE_MEMORY_NEAR_MAX_ROOT` | 根 MEMORY 最大字符数 | 0 |
| `CURSOR_BRIDGE_MEMORY_NEAR_MAX_DAILY_TODAY` | 今日 daily 最大字符数 | 0 |
| `CURSOR_BRIDGE_MEMORY_NEAR_MAX_DAILY_YESTERDAY` | 昨日 daily 最大字符数 | 0 |
| `CURSOR_BRIDGE_MEMORY_NEAR_MAX_AGENT` | 当前 Agent MEMORY 最大字符数 | 0 |
| `CURSOR_BRIDGE_MEMORY_FAR_DAYS` | 更早几天 daily 纳入（0=不读远层） | 0 |
| `CURSOR_BRIDGE_MEMORY_FAR_MAX_PER_DAY` | 远层每文件最大字符数 | 0 |
| `CURSOR_BRIDGE_MEMORY_OTHER_AGENTS` | 是否注入其他 Agent 的 MEMORY（1/true 开启） | 不设=不注入 |
| `CURSOR_BRIDGE_MEMORY_OTHER_MAX_PER_AGENT` | 每个他 Agent MEMORY 最大字符数 | 0 |
| `CURSOR_BRIDGE_DAILY_WRITE_THROTTLE_MIN` | 写回 daily 最小间隔（分钟） | 5 |

（`CURSOR_WORKSPACE` 已存在，为笔记库根。）

---

## 6. 调用顺序（伪代码）

```text
// POST /v1/chat/completions
parsed = JSON.parse(body)
agentId = req.headers['x-agent-id'] ?? parsed.agent_id ?? parsed.agentId
resolution = resolveWorkspace(agentId, process.env.CURSOR_WORKSPACE)

if (INJECT_MEMORY) {
  memoryContext = readMemoryContext(resolution, { maxRootChars, maxDailyChars })
  if (memoryContext && MEMORY_SINGLE_TURN)
    messages = toSingleTurn(messages)  // 1 system + 1 user
  messages = prependMemoryToSystem(messages, memoryContext)
}

prompt = buildPrompt(messages)
{ stream, kill } = runAgentStream({ ..., workspace: resolution.workspacePath })

// 流式：在 finish() 中
onStreamFinish = () => {
  if (UPDATE_DAILY && !ended)
    appendDailyNote(resolution.workspacePath, id, lastUser, assistantSummary)
  // ... 原有 finish 逻辑
}

// 非流式：在 runOne 里拿到 result.content 后
if (UPDATE_DAILY && result.ok)
  appendDailyNote(resolution.workspacePath, id, lastUser, result.content)
```

---

## 7. 实现任务清单（按实现顺序）

- [ ] **7.1** 新增 `src/memory-resolver.js`：`resolveWorkspace(agentId, workspaceRoot)`，支持无 agent_id 与映射表；单测。
- [ ] **7.2** 新增 `src/memory-reader.js`：`readMemoryContext(resolution, options)`，读文件、裁剪、拼接；单测（可 mock fs 或 fixture 目录）。
- [ ] **7.3** 在 server 中：解析 agent_id；若 INJECT_MEMORY 则调 resolver + memory-reader，将 memory 块拼入 messages 首条 system；buildPrompt 前若 MEMORY_SINGLE_TURN 则裁剪 messages；runAgentStream 传入 resolution.workspacePath。
- [ ] **7.4** 新增 `src/daily-writer.js`：`appendDailyNote(workspacePath, reqId, lastUser, assistantSummary)`，模板固定、限频可选；单测（写临时目录）。
- [ ] **7.5** 在 server 中：非流式分支在 200 返回前若 UPDATE_DAILY 则调 appendDailyNote；流式分支在 finish() 中若 UPDATE_DAILY 则调 appendDailyNote（流式可先只传 lastUser + 占位或简单摘要，见 4.6）。
- [ ] **7.6** 环境变量与配置：.env.example 与 README 中补充 Phase 3 相关变量；agent 映射表格式与解析。
- [ ] **7.7** 单测与回归：现有 bridge / server 单测仍通过；新增 memory-resolver、memory-reader、daily-writer 单测；可选集成测试「带 INJECT_MEMORY 的请求拿到含 [Memory] 的 prompt」。

---

## 8. 与 Engram MCP 的衔接（后续）

- 本期可实现**仅「读文件注入」**，不依赖 Engram。
- 若后续接入 Engram：可在 `readMemoryContext` 内增加「若配置了 Engram HTTP/API，先调 recall/search，再与文件内容合并」；或由 cursor-agent 配置 Engram MCP，桥只做文件注入。接口上为 `readMemoryContext(resolution, options)` 返回 string，Engram 作为另一数据源即可。

---

*文档版本：v1 | 2026-03-14 | Phase 3 代码设计与拆解，便于按任务实现。*
