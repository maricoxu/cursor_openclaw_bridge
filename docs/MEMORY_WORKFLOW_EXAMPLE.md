# Memory 工作流示例：一次请求从进入到生效

用**一个完整例子**说明：典型单次请求长什么样、Memory 在流程里怎么被读/拼/写回，以及你怎样验证它「生效了」。

---

## 1. 典型单次请求长什么样

一次从 OpenClaw（钉钉）发到 cursor-bridge 的请求，大致是这样：

**请求**

- **方法 / URL**：`POST http://127.0.0.1:3847/v1/chat/completions`
- **Header**：`Content-Type: application/json`，可选 `X-Agent-Id: 00_小哩中枢`，鉴权时还有 `Authorization: Bearer <BRIDGE_API_KEY>`
- **Body 示例**：

```json
{
  "model": "cursor-agent",
  "stream": false,
  "messages": [
    { "role": "system", "content": "你是小哩，负责日常提醒与任务协调。" },
    { "role": "user", "content": "今天有什么待办？" }
  ]
}
```

可选：不用 Header 时，也可以在 body 里带 `"agent_id": "00_小哩中枢"`，效果等价（Header 优先）。

**前置条件（Memory 要生效）**

- `.env` 里 **`CURSOR_BRIDGE_MEMORY_ENABLED=1`**（总开关打开）
- `CURSOR_WORKSPACE` 指向你的**笔记库根**（例如 `/Users/你/yehua的笔记`）
- 若用 agent_id：`CURSOR_BRIDGE_AGENT_WORKSPACES=00_小哩中枢:7-Agents/00_小哩中枢`（可选）
- 可选写回：`CURSOR_BRIDGE_UPDATE_DAILY=1`

---

## 2. Memory 使用过程：完整工作流

下面按**时间顺序**走一遍：从请求进桥，到响应返回、以及可选的写回。

### 步骤 0：请求进入桥

- OpenClaw 把上面那一段 HTTP 发到 bridge。
- 桥解析 body 得到 `messages`、`stream`，并准备 `workspace = CURSOR_WORKSPACE`、`resolution = null`。

### 步骤 1：解析 agent_id（仅当 MEMORY 开启时）

- 从 `req.headers['x-agent-id']` 或 `body.agent_id` / `body.agentId` 取出 **agent_id**（本例：`00_小哩中枢`）。
- 若 **`CURSOR_BRIDGE_MEMORY_ENABLED` 未开**：后面所有 Memory 逻辑都不跑，直接用 `CURSOR_WORKSPACE`，不读 memory、不写回。

### 步骤 2：resolveWorkspace(agent_id) → 决定 workspace 和要读哪些文件

- 调用 **memory-resolver**：`resolveWorkspace('00_小哩中枢', CURSOR_WORKSPACE)`。
- 查映射表：`00_小哩中枢` → `7-Agents/00_小哩中枢`。
- 得到（示意）：

```text
workspacePath = /Users/你/yehua的笔记/7-Agents/00_小哩中枢   ← 传给 cursor-agent 的 --workspace
notesRoot     = /Users/你/yehua的笔记
memoryPaths = {
  rootMemory        = /Users/你/yehua的笔记/MEMORY.md
  dailyPath         = /Users/你/yehua的笔记/memory/2026-03-15.md
  dailyPathYesterday = /Users/你/yehua的笔记/memory/2026-03-14.md
  agentMemory       = /Users/你/yehua的笔记/7-Agents/00_小哩中枢/MEMORY.md
}
otherAgentMemoryPaths = [ ... 其他 Agent 的 MEMORY.md，若配置了 OTHER_AGENTS ]
```

- 桥把 **workspace** 设为上面的 `workspacePath`，后面跑 cursor-agent 时用这个目录。

### 步骤 3：readMemoryContext(resolution) → 读出「近/远/他 Agent」并拼成一块

- 调用 **memory-reader**，按分层读文件（默认不限额，读全文）：
  - **近**：根 `MEMORY.md`、今日 daily、昨日 daily、当前 Agent 的 `MEMORY.md`
  - **远**：若配置了 `FAR_DAYS`，再读更早几天的 daily
  - **他 Agent**：若配置了 `OTHER_AGENTS`，再读其他 Agent 的 `MEMORY.md`
- 拼成一段带标题的文本，例如：

```text
[Memory]

[近] 常用记忆（优先查阅）
<根 MEMORY.md 全文>

---
## 今日记录
<memory/2026-03-15.md 全文>

---
## 昨日记录
<memory/2026-03-14.md 全文>

---
## 当前 Agent 记忆
<7-Agents/00_小哩中枢/MEMORY.md 全文>
```

- 若所有文件都不存在或为空，这里会得到空字符串，后面就不会注入 Memory 块。

### 步骤 4：把 Memory 块拼进 system（注入）

- 若 **memoryContext 非空**：
  - 若配置了 **Memory 单轮**（`CURSOR_BRIDGE_MEMORY_SINGLE_TURN=1`）：先把 messages 裁成 **1 条 system + 1 条当前 user**。
  - 然后 **prependMemoryToSystem**：把上面那段 `[Memory] ...` 拼到**第一条 system 的 content 前面**（若没有 system，就插一条 system，content = Memory 块）。
- 本例假设原 messages 是 1 system + 1 user，拼完后变成（示意）：

```text
messages[0].content = "
[Memory]
[近] 常用记忆...
...
---
你是小哩，负责日常提醒与任务协调。
"
messages[1] = { role: "user", content: "今天有什么待办？" }
```

### 步骤 5：buildPrompt(messages) → 得到发给 cursor-agent 的一条 prompt

- 用现有 **prompt-builder** 把 messages 转成**一条** prompt 字符串，例如：

```text
[System]
[Memory]
[近] 常用记忆（优先查阅）
...（你的 MEMORY.md、今日/昨日 daily、Agent MEMORY 内容）...

---
你是小哩，负责日常提醒与任务协调。

---
[User]
今天有什么待办？
```

- 这条字符串就是**最终发给 cursor-agent 的完整 prompt**；模型看到的「上下文」里已经包含你笔记里的记忆，这就是 **Memory 生效** 的体现。

### 步骤 6：runAgent / runAgentStream(workspace)

- 桥用 **workspace = 上面的 workspacePath**（例如 `.../7-Agents/00_小哩中枢`）调用 cursor-agent。
- cursor-agent 的 cwd 和可读文件范围都是这个目录，同时 prompt 里已经带好了 [Memory] 块，所以既「看得见」记忆，又能在正确 workspace 下干活。

### 步骤 7：响应返回 OpenClaw

- 流式或非流式把 assistant 的回复返回给 OpenClaw，钉钉里正常显示。

### 步骤 8：请求结束后写回 daily（若开启 UPDATE_DAILY）

- 若 **`CURSOR_BRIDGE_UPDATE_DAILY=1`** 且本次请求成功结束：
  - 桥调用 **daily-writer**：`appendDailyNote(notesRoot, reqId, lastUserContent, assistantSummary, { agentId })`。
  - 写回路径：**笔记库根**下的 `memory/YYYY-MM-DD.md`（例如 `memory/2026-03-15.md`）。
  - 追加一段固定格式，例如：

```markdown
### 14:30:00 - 00_小哩中枢
- **问题**: 今天有什么待办？
- **要点**: （assistant 的回复摘要或全文，非流式是全文；流式目前是「流式回复」占位）
- **请求 id**: bridge-1734567890123-abc1def
```

- 这样**这次对话**就被记进当天的 daily，下次读「今日/昨日」时会被读进 [Memory]，形成闭环。

---

## 3. 小结：Memory 是怎么「生效」的

| 环节 | 你看到的/能验证的 |
|------|-------------------|
| **读** | 桥从 `MEMORY.md`、`memory/今日.md`、`memory/昨日.md`、当前 Agent 的 `MEMORY.md` 读内容，拼成 [Memory] 块。 |
| **注入** | 这段块被拼到**第一条 system 前面**，再和 system + user 一起变成一条 prompt。 |
| **生效** | cursor-agent 收到的**唯一一条 prompt** 里已经包含 [Memory]，所以回答会基于你笔记里的内容（待办、偏好、历史等）。 |
| **写回** | 若开写回，本次 user 问题 + assistant 要点会追加到 `memory/YYYY-MM-DD.md`，下次请求会被当成「今日/昨日」再次注入。 |

---

## 4. 怎么自己验证「生效了」

1. **开调试**：`.env` 里设 `CURSOR_BRIDGE_DEBUG=1`，重启桥。控制台会打请求 id、prompt 长度等。
2. **看 prompt 内容**：设 `CURSOR_DEBUG_PROMPT=1`，桥会把**完整 prompt** 写入项目根下的 `.cursor-bridge-last-prompt.txt`，打开即可看到整段 [Memory] 和后面的 system/user。
3. **看写回**：开 `CURSOR_BRIDGE_UPDATE_DAILY=1`，发一条请求，然后打开笔记库里的 `memory/今天日期.md`，看是否多了一条「AI 交互记录」。
4. **关 Memory 对比**：把 `CURSOR_BRIDGE_MEMORY_ENABLED` 设为 0 或删掉，再发同样问题，对比回答是否不再引用笔记里的待办/记忆。

---

## 5. 一张图串起来

```text
OpenClaw 发请求 (messages + 可选 X-Agent-Id)
         │
         ▼
┌─────────────────────────────────────────────────────────────┐
│ 桥：MEMORY_ENABLED=1 时                                      │
│  ① 解析 agent_id → resolveWorkspace → workspace + 要读的路径  │
│  ② readMemoryContext → 读 MEMORY.md / memory/今日·昨日 /     │
│     当前 Agent MEMORY，拼成 "[Memory]\n\n[近]..."            │
│  ③ 把这段拼到第一条 system 前面 → buildPrompt(messages)       │
│  ④ runAgent(prompt, workspace) → cursor-agent 看到的         │
│     就是「带整段记忆」的一条 prompt                           │
└─────────────────────────────────────────────────────────────┘
         │
         ▼
   OpenClaw 收到回复
         │
         ▼
┌─────────────────────────────────────────────────────────────┐
│ 若 UPDATE_DAILY=1：appendDailyNote(notesRoot, ...)           │
│  → 在 memory/YYYY-MM-DD.md 追加本条对话的「问题 + 要点」      │
│  → 下次请求时会被当「今日记录」再次读进 [Memory]              │
└─────────────────────────────────────────────────────────────┘
```

这样一次典型单次请求，以及 Memory 从「读 → 注入 → 生效 → 写回」的完整工作流就都串起来了；你按上面 4 步验证，就能确认它在你环境里是怎么生效的。
