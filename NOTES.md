# cursor-bridge 知识说明与排查

与 OpenClaw / OpenAI 兼容 API 相关的**科普**和**调试排查**说明，单独成文，不放在 DESIGN.md 中。

---

## 1. Responses API 与 Chat Completions API 的区别（科普）

当你配置 OpenClaw 的 provider 时，会看到 `api: "openai-completions"` 或 `api: "openai-responses"`。二者都是「和模型对话」的 HTTP 接口，但设计年代、数据形状和适用场景不同。下面用通俗方式说明原理和区别。

### 1.1 一句话类比

- **Chat Completions**：像「发一条短信、等一条回复」——请求里是一串 `messages`（角色+内容），响应里是「一条助理回复」`choices[0].message.content`。简单、老牌、遍地兼容。
- **Responses**：像「提交一张工单、拿回一叠结构化结果」——请求里可以是 `input`（字符串或多种类型的「条目」），响应里是 `output` 数组，里面可以有文本、工具调用、推理过程等多种「产出物」，且每条都有类型和 id，方便多轮、工具、审计。

### 1.2 历史与定位

| 维度 | Chat Completions | Responses |
|------|------------------|-----------|
| **出现时间** | 较早，GPT-3.5/4 时代的主流对话接口 | 较新，面向「多模态 + 工具 + 推理」的一体化接口 |
| **典型路径** | `POST /v1/chat/completions` | `POST /v1/responses` |
| **设计目标** | 多轮对话、一问一答 | 统一承载文本、工具调用、图片输入/输出、推理块等，便于扩展 |

可以理解为：Completions 是「对话专用线」，Responses 是「通用任务结果线」。

### 1.3 请求体的区别

**Completions** 的请求体大致是：

```json
{
  "model": "gpt-4",
  "messages": [
    { "role": "system", "content": "你是助手。" },
    { "role": "user", "content": "你好" }
  ],
  "stream": false
}
```

输入就是「消息列表」：每条有 `role`（system/user/assistant）和 `content`（字符串）。简单直接。

**Responses** 的请求体更「条目化」：

```json
{
  "model": "gpt-4",
  "instructions": "你是助手。",
  "input": [
    { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "你好" }] }
  ]
}
```

这里 `input` 可以是字符串，也可以是**条目数组**：每条条目有 `type`（如 `message`、`input_image`、`function_call_output` 等）和对应字段。这样同一接口就能表达「用户发了一句话」「用户发了一张图」「用户回了工具结果」等多种输入，便于后续支持图片、文件、工具多轮等。

### 1.4 响应体的区别

**Completions** 的响应（非流式）大致是：

```json
{
  "id": "chatcmpl-xxx",
  "object": "chat.completion",
  "choices": [
    {
      "index": 0,
      "message": { "role": "assistant", "content": "你好！有什么可以帮你？" },
      "finish_reason": "stop"
    }
  ],
  "usage": { "prompt_tokens": 10, "completion_tokens": 20 }
}
```

客户端要拿的「助理说的那句话」就在 **`choices[0].message.content`**。几乎所有支持 OpenAI 兼容的客户端都会认这个路径。

**Responses** 的响应是「输出条目列表」：

```json
{
  "id": "rsp-xxx",
  "object": "response",
  "status": "completed",
  "output": [
    {
      "type": "message",
      "id": "msg-0",
      "role": "assistant",
      "content": [
        { "type": "output_text", "id": "text-0", "text": "你好！有什么可以帮你？" }
      ],
      "status": "completed"
    }
  ],
  "usage": { ... }
}
```

这里的「助理说的那句话」在 **`output[0].content[]` 里 type 为 `output_text` 的那一节的 `text`**。此外 `output` 里还可以有 `function_call`、推理块等。好处是结构清晰、可扩展；代价是客户端必须按这套结构解析，否则就「拿不到文字」。

### 1.5 和本桥的关系

- 本桥**同时实现**了两套：
  - **Completions**：`POST /v1/chat/completions`，请求用 `messages`，响应用 `choices[0].message.content`。
  - **Responses**：`POST /v1/responses`，请求用 `input`/`instructions`，响应用 `output[].content[].text`。
- OpenClaw 里若把 cursor-cli 配成 **`api: "openai-completions"`**，请求会走 Completions，界面会从 `choices[0].message.content` 取回复，**能正常显示**。
- 若配成 **`api: "openai-responses"`**，请求会走 Responses，本桥会正确返回 `output[0].content[0].text`；但 OpenClaw 对**自定义** provider 的 Responses 解析尚不完整，可能导致界面不显示回复。因此当前推荐使用 **openai-completions**。

### 1.6 小结

| 对比项 | Chat Completions | Responses |
|--------|------------------|-----------|
| **输入** | `messages[]`（role + content） | `input`（字符串或条目数组）+ `instructions` |
| **输出** | `choices[0].message.content` | `output[].content[]`（如 `output_text` 的 `text`） |
| **扩展性** | 以对话为主 | 文本 / 工具 / 图片 / 推理 等统一用「条目」表达 |
| **兼容性** | 极好，第三方和自定义 provider 普遍支持 | 较新，自定义 provider 的客户端解析参差不齐 |
| **本桥 + OpenClaw** | 推荐：`api: "openai-completions"`，界面正常显示 | 可用但界面可能不显示，等 OpenClaw 完善后再切 |

**原理本质**：都是「客户端发一段输入 → 服务端调模型 → 返回一段输出」；Completions 把输入输出都压成「消息+一条回复」，Responses 把输入输出都拆成「带类型的条目」，更灵活但需要客户端按新约定解析。本桥两种都支持，在 OpenClaw 里优先用 Completions 即可获得稳定可用的对话展示。

---

## 2. 图示信息与两种信息流（排查用）

你看到的「红色/粉色气泡里的那种图示信息」（例如「Read HEARTBEAT.md...」「Follow it strictly...」），是 **OpenClaw 侧自动注入的系统指令**（例如心跳轮询 heartbeat），不是用户发的普通聊天。这类消息的「信息流」和普通对话确实不一样：

| 流 | 谁发起 | 内容特点 | 典型展示 |
|----|--------|----------|----------|
| **普通对话流** | 用户发一条消息（如「测试」） | 一次对话请求 → 桥调 cursor-agent → 返回一段纯文本 | 普通聊天气泡 |
| **系统/心跳流** | OpenClaw 定时或按规则发系统指令 | 读 HEARTBEAT、执行清单等；agent 可能回 HEARTBEAT_OK 或简短状态 | 图示/卡片（红色框等） |

所以「以前会自动回这种图示的信息」说明当时走的是**系统指令 + 特殊展示**的那条流；「现在没有任何回复」指的是**普通用户消息**这条流里，界面没有把桥返回的文本显示出来。两条流可以并存，排查时重点确认：普通对话是否已切到 `openai-completions`、Gateway 是否重启、以及终端里是否出现 `POST /v1/chat/completions -> 200` 和 `content length: N`。

### 2.1 没有回复时的排查步骤

1. **看桥的终端**：发一条「测试」后，最后两行是：
   - `[bridge] POST /v1/chat/completions -> 200` 且 `content length: N` → 已走 Completions 且桥有内容，问题在 OpenClaw 展示或解析。
   - `[bridge] POST /v1/responses -> 200` → 仍在走 Responses，需确认 `~/.openclaw/openclaw.json` 里 cursor-cli 为 `"api": "openai-completions"` 并**重启 OpenClaw / Gateway**。
2. **确认配置**：`~/.openclaw/openclaw.json` → `models.providers["cursor-cli"].api` 为 `openai-completions`。
3. **重启**：改完配置后务必完全重启 OpenClaw（或至少重启 Gateway 进程）再试。

### 2.2 修了 [object Object] 后「反而没信息」

若修了 content 提取后从「有错误提示」变成「完全没回复」，可能是：

- **请求没走到桥**：OpenClaw 又走了 fallback（如 OpenRouter），或请求没发到 3847。看终端是否有 `POST /v1/chat/completions -> 200`。
- **prompt 被提成空的**：OpenClaw 的 `message.content` 格式和桥里解析的不一致，提出来是空串，拼出的 prompt 太短或无效，agent 可能超时或返回空。桥会打一行：  
  `[bridge] /v1/chat/completions request: messages=N, lastContentType=string|array|object, promptLen=xxx`  
  看 **promptLen**：若很小（如几十）或 0，说明用户内容没被正确抽出；**lastContentType** 能看出最后一条是 string/array/object，便于对格式做兼容。
- **agent 返回空**：若日志里是 `content length: 0`，是 cursor-agent 没产出文字（超时、报错或模型没回），不是桥或 OpenClaw 展示问题。

建议：重启桥后再发一条，把终端里上述两行（request + 200 那行）贴出来，便于判断是「没请求 / prompt 空 / agent 空」中的哪一种。

**若终端里是 `POST /v1/chat/completions -> 200` 但界面仍无回复**：说明桥返回了 200 但回复体里 content 为空。桥会打一行：`[bridge] /v1/chat/completions 200 但 content 为空`。常见原因：cursor-agent 跑完了但没有产出我们认的 `result`（例如**只调了工具、没写最终一句**，或输出格式变了）；或 agent 超时被杀了、在超时前没写完。此时还会看到 `[agent-runner] 未从 stdout 解析出 result` 和末行预览，可根据末行结构再排查。

**典型现象 1：「测试」有回复、「今天天气怎么样」无回复**：问天气时 agent 可能去调天气类工具；若只发了 tool_call、没有再用一句自然语言总结，以前我们只认 `result` 就会得到空。桥已增强：在拿不到 `result` 时，会收集所有 `type=assistant` / `result` / `message` 的 `message.content` 拼成回复；并会从任意一行的顶层 `output` / `content` / `text` 再兜底取一次，工具调用后只要有任意一段助理文本就能展示。

**典型现象 2：「天气怎么样」有回复、「你用的模型是什么」或「测试」无回复**：可能是第二句时 prompt 更大（带上前一轮历史）、agent 超时或输出格式不同；或短回复时 cursor-agent 用了别的 JSON 结构。桥已对顶层 `output`/`content`/`text` 做兜底。若仍无回复：看终端是否出现「content 为空」和 `[agent-runner] 未从 stdout 解析出 result` 的**末行预览**，把末行贴出来可再对格式做兼容。

**调试日志**：默认不打印请求/响应等日志。排查时在 `.env` 或启动前设 **`CURSOR_BRIDGE_DEBUG=1`**（如 `CURSOR_BRIDGE_DEBUG=1 npm start`），即可看到 `[bridge] ... -> 200`、`runAgent start`、`runAgentStream start`、`[agent-runner]` 等调试信息。

**200 有、但界面无回复时**：说明 prompt 已正确发给 cursor-agent（可用 `CURSOR_DEBUG_PROMPT=1` 看 `.cursor-bridge-last-prompt.txt`），但**我们没从 cursor-agent 的 stdout 里解析出文本**。此时只要发生「content 为空」，桥会把 **cursor-agent 的完整 stdout** 写入 **`.cursor-bridge-last-stdout.txt`**。该文件**只会在出现「无回复」的那次请求时生成**，且固定写在 **cursor-bridge 项目根目录**（与 `package.json` 同级），与从哪个目录执行 `npm start` 无关。若目录里没有该文件，说明自上次重启桥以来还没有触发过「200 但 content 为空」；再问一次「你是什么模型」等触发无回复后即可看到。

**502 刷屏、OpenClaw 一直无回复**：桥会对**非流式** completions 做**串行化**（同一时间只跑一个 runAgent），避免多实例冲突和重复 502。若仍出现连续 502，看终端里的 `[bridge] [id] runAgent failed: …` 和 `[agent-runner] cursor-agent exit code …` 或 `cursor-agent timeout`，可判断是超时、非零退出还是未登录，再对症排查。

**若错误信息含 `… is not available in the slow pool. Please switch to Auto`**：这是 Cursor 侧模型/配额限制，桥会返回 **503**、code `cursor_model_unavailable`。**推荐**：在 **cursor-bridge 的 `.env`** 里设 **`CURSOR_AGENT_MODEL=auto`**，桥会传 `--model auto` 给 cursor-agent，由 Cursor 自动选模型，省用量、避免 503；也可在 Cursor 设置里把默认模型改为 Auto。不要固定用 `claude-4.6-opus-high-thinking` 等贵模型跑简单对话。

**若开启 CURSOR_BRIDGE_DEBUG=1 后终端里只有 `[bridge] [id] POST /v1/chat/completions -> 200`、没有任何 `[agent-runner]` 或 `runAgent start`**：说明本次请求走的是**流式**（客户端发了 `stream: true`）。流式路径不会打 runAgent/agent-runner 的日志，且若 cursor-agent 的 stream-json 输出格式与解析器预期不一致，就可能 200 但无内容。可设置 **`CURSOR_FORCE_NON_STREAM=1`**（在 `.env` 里），桥会**内部**用 runAgent 非流式取回复，但若客户端请求的是 stream，桥仍会以 **SSE 单块**（一整段 content + [DONE]）回写，这样 OpenClaw 等只渲染流式响应的界面也能正常显示。

**典型现象 3：只有第一条有回复，第二、三条是空气泡**：OpenClaw 每次请求都会带上整段历史（例如 30+ 条），第二句起 prompt 很大，cursor-agent 容易超时或产不出我们解析的 result，桥就回 200 但 content 为空。**处理办法**：用下面的 `CURSOR_MAX_MESSAGES` 限制条数。

**典型现象 4：第一条有回复，第二条（如「今天天气怎么样」）一直转圈、像在循环**：多半是**流式**请求下，cursor-agent 对这类问题会调工具/联网，迟迟不输出「结束」信号（或没有我们认的 `type: result` 行），桥就从不发送 `[DONE]`，OpenClaw 一直等 → 表现为转圈/循环。**桥已做**：流式路径增加**超时强制结束**（到 `CURSOR_AGENT_TIMEOUT_MS` 后主动写 `[DONE]` 并结束响应），避免无限转圈；超时后客户端会收到已输出的内容 + 结束。**建议排查顺序**：① 先在 `.env` 里设 **`CURSOR_FORCE_NON_STREAM=1`**，重启桥，再问一次「今天天气怎么样」——桥会内部走非流式，一次拿完整 stdout；看终端是否打 `runAgent done`、是否有 `content length: 0`，若有「content 为空」会生成 `.cursor-bridge-last-stdout.txt`，打开可看到 cursor-agent 对这次请求的完整输出，便于判断是超时、只调了工具无 result，还是格式问题。② 确认非流式能拿到回复或至少看到 stdout 后，再关掉 `CURSOR_FORCE_NON_STREAM` 用流式；流式下现在有超时兜底，不会无限转圈。

---

## 4. CURSOR_MAX_MESSAGES 环境变量说明

### 4.1 它是干什么的？

OpenClaw 每次把**整段对话历史**都发给桥（你发过的 + 小哩回过的，一条算一条）。桥把这些消息拼成一大段文字（prompt）交给 cursor-agent。**消息越多，这段文字越长**。

- **第一条**：「测试」→ 可能只有 2～5 条（系统说明 + 你这一句），prompt 短，agent 很快能回。
- **第二、三条**：「你用的模型是什么」「今天天气怎么样」→ 请求里会带上**之前所有轮**（例如 30+ 条），prompt 变成几万字符，agent 容易超时或产不出我们认的 `result`，界面就变成空气泡。

`CURSOR_MAX_MESSAGES` 的意思是：**只拿「最近 N 条」消息去拼这段 prompt，更早的丢掉**。这样第二句、第三句的请求也不会再带 30+ 条，prompt 变短，更容易在超时内跑完并有回复。

### 4.1.1 为什么「只问了 3 个问题」也会变成 30+ 条、几万字符？

你只发了 3 句（测试 / 你用的模型是什么 / 今天天气怎么样），但**一次请求里的 messages 不只有你这 3 条**。里面还有大量「系统/上下文」：

| 来源 | 说明 |
|------|------|
| **系统说明** | 一条或很多条：你是小哩、你能用什么工具（read / write / exec / process…）、工具用法说明等，往往几千字。 |
| **工作区 / HEARTBEAT** | OpenClaw 可能把当前工作区、HEARTBEAT 清单等塞进系统或单独几条消息，又会占很多字。 |
| **你这 3 问 + 小哩的回复** | 用户 3 条 + 助理 3 条（含空气泡也算一条），一共 6 条。 |

所以「messages 条数」≈ **很多条系统/上下文 + 6 条对话**。系统那部分可能被拆成十几条甚至二十几条（例如工具列表、bootstrap 各算一条），加起来就 30+ 条、拼出来几万字符。  
也就是说：**长的主要是「系统 + 上下文」，不是你把 3 句话重复发了很多遍**。限制 `CURSOR_MAX_MESSAGES` 会优先丢掉**最早**的那批系统/上下文，只保留最近 N 条（通常最后几条才是你这 3 问 3 答），所以 prompt 会明显变短。

### 4.2 只保留 20 条会有什么弊端？

会。因为保留的是**最近 20 条**，被丢掉的是**最前面**的那几条：

- **可能丢掉部分系统说明**：若系统/工具说明分布在最前面几条里，截断后 agent 可能看不到完整的「你是谁、能用什么工具」，表现会变怪或能力变弱。
- **多轮对话会失忆**：例如你先说「我叫小明」，再说「我叫什么？」——若「我叫小明」在那 20 条之前被截掉，agent 就不知道你叫小明。

所以 20 是折中：既压短 prompt、减少超时/无回复，又尽量保留近期对话；若你发现 agent 经常「忘了角色」或「忘了上文」，可以适当调大（例如 30），或改用下面的单轮模式。

### 4.3 只针对「当前这一条」组装 prompt，可行吗？——可行，用单轮模式

可以。不保留上一条对话，**只拿「当前这一句」+ 一条系统说明**去拼 prompt，在桥里叫**单轮模式**。

- **做法**：在 `.env` 里设 `CURSOR_SINGLE_TURN=1`（或 `true`）。桥会只取：**1 条 system（有的话取第一条）+ 1 条当前 user（最后一条用户消息）**，不再带任何历史对话。
- **效果**：prompt 最短，每次请求都像「新开一局」；不会超时、不会因历史过长而无回复。代价是**没有多轮记忆**：agent 不知道你上句说了啥，不能接「继续」「再详细点」这种跟上一句有关的追问。
- **和「只保留 20 条」的关系**：单轮模式更激进（只 2 条），限条数则是「保留最近 20 条」。需要多轮对话时用 `CURSOR_MAX_MESSAGES=20`；可以接受无记忆、只要每句都回得上时用 `CURSOR_SINGLE_TURN=1`。

### 4.4 取值含义小结

| 配置 | 含义 |
|------|------|
| **CURSOR_MAX_MESSAGES=0**（默认） | 不限制条数。 |
| **CURSOR_MAX_MESSAGES=20** | 只用最近 20 条拼 prompt；可能丢掉最前面的系统/上文。 |
| **CURSOR_SINGLE_TURN=1** | 只拿 1 条 system + 1 条当前 user，无历史；无多轮记忆。 |

### 4.5 看「输入 cursor-agent 的完整信息」：调试用

想确认**到底塞给 cursor-agent 多少字、长什么样**时，在 `.env` 里设 **`CURSOR_DEBUG_PROMPT=1`**，重启桥后：

- 每次请求都会把**完整 prompt** 写入 **cursor-bridge 目录下的 `.cursor-bridge-last-prompt.txt`**（每次覆盖），文件开头会写长度和约等于多少 token（按 2.5 字/token 粗估）。
- 终端会打一行「已写入 .cursor-bridge-last-prompt.txt，长度 N 字符（约 M token）」并打印**前 600 字 + 后 400 字**预览。

这样你可以直接打开该文件看「第三轮」时整段输入有多长、前面是系统说明还是历史对话，再判断是不是 prompt 过大或结构问题。看完可把 `CURSOR_DEBUG_PROMPT` 改回 0 或删掉，避免每次请求都写文件。

### 4.6 cursor 每轮是独立进程、没有「上一轮」；上下文只能靠 bridge 或 memory

- **cursor-agent 每次请求都是新进程**，跑完就退出，**没有进程内记忆**。它「知道」的东西，只有我们**这一次**通过 stdin/prompt 传进去的那一段。
- 所以：要么在 **bridge 里多攒点信息**（把 OpenClaw 发来的历史都塞进 prompt，或做限条数/单轮取舍），要么配合**外部 memory 系统**：例如把历史摘要、关键事实存到 MEMORY.md 或别处，下次请求前由 bridge 或上游把「记忆」拼进 system/user，再传给 cursor-agent。这是常见做法，没有在 bridge 里实现 memory 的话，就只能在「多带历史」和「控制长度防超时」之间折中（CURSOR_MAX_MESSAGES / CURSOR_SINGLE_TURN）。

### 4.7 在哪里加？怎么加？

就是在 **cursor-bridge 这个代码目录下面**的 **`.env`** 文件里加。

- **路径**：`cursor-bridge/.env`（和 `package.json`、`src/` 同级；若没有就复制 `.env.example` 为 `.env` 再改）。
- **加一行**：`CURSOR_MAX_MESSAGES=20`（数字可按需要改成 10～30）。
- **生效**：改完保存后，**重启一次 cursor-bridge**（停掉 `npm start` 再重新运行），新值才会被读进去。

`.env` 里别的变量（如 `CURSOR_WORKSPACE`、`BRIDGE_PORT`）已经在那的话，和它们写在一起即可，例如：

```env
CURSOR_AGENT_EXTRA_ARGS=--trust
# 只取最近 N 条消息拼 prompt，避免第二句起历史太长导致超时/无回复。0=不限制
CURSOR_MAX_MESSAGES=20
```

---

## 2.8 pm2 常驻与「LLM request timed out」排查

用 **pm2** 后台常驻启动桥时，若 OpenClaw 出现 **「LLM request timed out」**（尤其带 `main : heartbeat` 时），多半是：桥没起来、桥不可达、或客户端超时早于 cursor-agent 响应。

**桥已做**：`server.js` 从**项目根目录**加载 `.env`（不依赖 `process.cwd()`），即使用 pm2 且未加 `--cwd`，只要进程能启动，`.env` 和 `CURSOR_WORKSPACE` 也会被正确读取。

**建议排查顺序**：

1. **确认桥在跑**：`pm2 list` 看 `cursor-bridge` 是否为 `online`；`pm2 logs cursor-bridge` 看是否有报错或 `listening on http://...`。
2. **确认环境变量是否生效**：桥启动时会打一行 `[bridge] effective config: envFileExists=... cwd=... CURSOR_WORKSPACE=...`，pm2 下看 `pm2 logs cursor-bridge --lines 20` 即可核对。也可直接请求 **`GET /config`** 看当前进程实际用到的配置：`curl -s http://127.0.0.1:3847/config`（返回 JSON，含 `envFileExists`、`cwd`、`CURSOR_WORKSPACE`、`CURSOR_AGENT_BIN`、`CURSOR_AGENT_TIMEOUT_MS` 等，API key 仅显示 `(set)`/`(empty)`）。若 pm2 下 `cwd` 或 `CURSOR_WORKSPACE` 不对，说明 .env 没被读到或读错路径，桥已从**项目根**加载 `.env`，与 `process.cwd()` 无关，可再查 `.env` 是否在 cursor-bridge 根目录。
3. **确认桥可访问**：`curl -s http://127.0.0.1:3847/health`（端口以 `.env` 里 `BRIDGE_PORT` 为准），应返回 JSON 含 `ok: true`。
4. **确认 OpenClaw 连的是本机**：OpenClaw 里 cursor 的 baseUrl 应为 `http://127.0.0.1:3847`（或你设的 `BRIDGE_HOST:BRIDGE_PORT`），且本机防火墙未拦 3847。
5. **心跳/对话超时**：若界面是「心跳」请求超时，说明 OpenClaw 在轮询 HEARTBEAT；cursor-agent 处理一次心跳可能要几秒到十几秒，若**客户端超时**（如 10s）短于桥/agent 响应时间，就会显示 timed out。**处理**：① 在 OpenClaw 的 cursor 配置里把**请求超时**调大（例如 60s 或 90s），具体项名以 OpenClaw 文档为准（如 `timeout`、`requestTimeout` 等）；② 桥已消费 cursor-agent 的 stderr，避免子进程写 stderr 阻塞导致首包过慢；③ 用 `CURSOR_BRIDGE_DEBUG=1` 看桥是否收到请求、是否打出 `runAgentStream start`。

**pm2 error 日志里出现大段 prompt 和 `--print`/`--workspace` 等参数**：那是 **cursor-agent**（Cursor CLI）在调试时往 stderr 打的。桥在**流式**路径里已用 `stdio: ['ignore', 'pipe', 'ignore']` 把子进程 stderr 直接丢弃，这些内容不会再进桥的 error 日志；非流式路径仍会读 stderr 用于判断「not logged in」等。

**为何 pm2 下超时、而 npm start 正常？** 常见原因是**客户端先断开**（OpenClaw 超时关连接）后，桥仍在向 `res` 写 SSE，下一次写入触发 EPIPE/ECONNRESET，若未监听 `res.on('close')`/`res.on('error')` 会变成未捕获异常 → 进程退出 → pm2 自动重启（`pm2 list` 里 ↺ 重启次数会很高）。桥已对流式响应做 `res.on('close', finish)` 与 `res.on('error', finish)`，客户端断开时只收尾、不再写，避免进程被写断开的 socket 拖垮。部署后观察 `pm2 list` 的 ↺ 是否不再增长。

**pm2 下 `spawn cursor-agent ENOENT`**：桥会在启动时**自动解析** `CURSOR_AGENT_BIN`：若填的是裸名（如 `cursor-agent`），会依次查 **PATH** 与常见目录（`~/.local/bin`、`/usr/local/bin`、`/opt/homebrew/bin`），解析为绝对路径后再 spawn，故 pm2 下一般只需在 `.env` 里写 `CURSOR_AGENT_BIN=cursor-agent` 即可，无需手写绝对路径。若仍报 ENOENT，再改为绝对路径（如 `CURSOR_AGENT_BIN=/Users/你/.local/bin/cursor-agent`）。桥已对流式 spawn 做 `proc.on('error')` 处理，即使未找到也不会崩进程、不会把整段 spawnargs 打进 error 日志。

**清理 pm2 旧日志**：`pm2 flush` 会清空 out/error 日志文件，之后只保留新输出。

**pm2 启动建议**（可选）：仍建议用 `--cwd` 指向 cursor-bridge 根目录，便于日志、重启行为一致：

```bash
pm2 start src/server.js --name cursor-bridge --cwd /path/to/cursor-bridge
pm2 save
```

---

## 3. 为什么会出现「两段相同内容」

### 3.1 为什么生成时会出两段相同内容？

**桥当前不做去重**：流式解析器已移除所有去重逻辑，重复问题视为 **Cursor Agent 侧** 责任；桥只做 NDJSON → SSE 解析及 thinking/心跳过滤。

可能原因（不互斥）：

| 原因 | 说明 |
|------|------|
| **上下文过长** | 一次带了 31 条消息、prompt 约 3.8 万字符，容易触发下面说的「长上下文重复」机制。 |
| **解码/采样** | 生成长回复时，若重复惩罚不够或采样碰巧，模型会沿着「收到! 测试成功…」再生成一遍相同或极像的段落。 |
| **接口/实现** | 从目前实现看我们只取一条 `result`，更可能是模型侧重复；若上游把同一段拼两次也会出现，但较少见。 |

**可做的缓解**：控制发给桥的对话轮数（例如只带最近 N 条）；桥侧不做去重，需 Cursor 产品侧修复。

### 3.1.1 底层一点：为什么「上下文一大」更容易重复同一段？

可以粗分为「模型怎么生成」和「长上下文带来什么」两层。

- **模型是怎么生成下一句的**  
  当前这类模型（Transformer）是**按 token 一个一个生成**的：每生成一个 token，都会根据「当前已有的整段上下文」算一个概率分布，再按这个分布采样出下一个 token。也就是说，**下一个词长什么样，完全由「已经写出来的那一大段」决定**。如果这一段里已经出现过「收到! 测试成功，连接正常。我是小哩…」，那么在这些 token 附近的概率分布里，**再出现同样或很类似序列的概率并不会变成 0**，只是被「重复惩罚」压下去一些；惩罚不够或采样偶然时，就会再采出一遍类似内容。

- **上下文一长，为什么更容易「再采出一遍」**  
  1. **注意力是分散的**：模型对上下文的利用方式是「注意力」——每个位置会去看其他位置。上下文越长，同一段话在「很前面」和「刚写完的结尾」会同时存在，模型在生成结尾时既看到「前面某处有过这段」，又看到「刚写完这段」，若重复惩罚不强，就容易在结尾再生成一段「和前面或刚写过的很像」的内容。  
  2. **有效记忆变短**：长上下文下，模型更依赖「近处的 token」；早先的消息虽然还在，但权重会被摊薄。所以它更容易「跟着刚写的那几句」继续写，而不是牢牢记住「我已经说过一遍了，别再说」。  
  3. **训练数据里就有重复**：训练语料里本身就有「同一段意思换句话再说一遍」或列表、条款重复等，模型会学到「可以这样收尾」；长回复 + 弱重复惩罚，就容易在结尾再「收尾」一次，变成两段相同或几乎相同。

所以「上下文一大，更容易产生同一段内容」的底层原因可以概括成：**生成是局部依赖、按概率采样；上下文长了以后，注意力更偏向近期内容，且同一句话在上下文里已经出现，再被采样的概率仍在，就容易在结尾再生成一段相同或几乎相同的话**。根本缓解仍是：缩短上下文（少带历史轮次）或依赖上游/模型侧（Cursor Agent）的重复惩罚或产品修复。

### 3.2 流式解析器：type 与去重（当前实现）

**官方 stream-json 格式**（[Output Format](https://cursor.com/docs/cli/reference/output-format)）：`system`、`user`、`assistant`、`tool_call`、`result`。*thinking events are suppressed in print mode*。

**2. 一共有多少种 type，我们处理了哪些？（当前表）**

| type | 桥是否处理 | 说明 |
|------|------------|------|
| **assistant** | ✅ 处理 | 从 `message.content` 取正文（字符串或 `[{ type: "text", text: "..." }]` 拼接） |
| **result** | ✅ 处理 | **仅**从 `result` 字段取（与官方 doc 一致；不读 output/content/text，避免与其它行重复） |
| **message** | ✅ 处理 | 仅当 `role === assistant` 时取 `content`（兼容用；**参与事件级去重**） |
| **thinking / reasoning / thought** | ❌ 默认不处理 | 可设 `CURSOR_STREAM_SHOW_THINKING=1` 打开 |
| **user / system / tool_call** 等 | ❌ 不处理 | 不产出助理正文 |
| **无 type 或仅有顶层 output/content/text** | ❌ 不处理 | **无兜底**：此类行不抽取、不转发，避免重复 |

**同一条 NDJSON 不会处理两次**：只走 assistant → result → message 三个分支之一，命中即 return，无兜底。

**事件级去重**：`assistant`、`result`、`message` 三种都参与。以下任一成立则当前行跳过：已转发全文 === 当前行；已转发结尾包含当前行（≥20 字）；已转发开头 === 当前行；当前行≥10 字且已转发包含；**已转发长度 > 当前行长度且已转发包含当前行**（防 result 先到后 assistant 单字/短 chunk 重复）。单测覆盖：result+单字 assistant、两行相同 assistant、result+message、无 type 不产出、result 只读 result 字段等。

**事件级去重**：若同一段正文先以 `result` 整段下发、再以 `assistant` 分片下发（或先 assistant 拼出整段再 result 再发一遍），桥会视为冗余，只转发一遍。规则：已转发内容 `streamedText` 与当前行抽取的 `normNew` 比较——相等、或已转发结尾包含新内容、或已转发开头等于新内容、或新内容 ≥10 字且已转发包含新内容时，该行跳过。

**若出现「两条独立气泡」**：两条气泡通常说明客户端发了**两次请求**或渲染创建了多条消息。排查：看桥终端是否有两次 `runAgentStream start`。

### 3.3 是否该在「上游」修？如何单测 Cursor Agent？

**结论**：若 Cursor Agent 本身在一条流里就输出两遍，需在 **Cursor Agent / Cursor 产品侧** 排查并修复；桥已不做去重。

**单测 Cursor Agent（不走桥）**：用仓库内脚本直接跑一次 Agent，看原始 stdout 是否已经重复：

```bash
cd /path/to/cursor-bridge
node scripts/check-agent-raw-output.mjs
```

脚本会用与桥相同的参数调用 `cursor-agent`（prompt 为 `[User]\n你是什么模型`），把原始 NDJSON 写入 `.cursor-agent-raw-stdout.txt`，并打印「原始 stdout 中回复是否出现同一段两遍：是/否」。**实际跑过后的结论**：在仅发一条「你是什么模型」、无桥无 OpenClaw 的情况下，Cursor Agent 的**原始输出里就已经出现同一段两遍**，说明重复来自 **Cursor Agent / Cursor 产品侧**，不是 OpenClaw 或桥引入的。

**根因在 Cursor 侧**：这是 Cursor Agent 的已知行为/ bug，社区有多人反馈「Agent 流式输出同一句重复多遍」或「Agent stream bug」。桥已做**事件级去重**（同一段先 result 后 assistant 或先 assistant 后 result 只出一遍），可缓解「整段重复说两遍」；若 Cursor 单条流内就重复多次或顺序复杂，仍可能残留重复，需 Cursor 产品侧修复。

**Cursor 侧可尝试的缓解**（来自社区，非官方保证）：
- 关闭 MCP：Cursor 设置 → Tools & MCP，暂时禁用所有 MCP 后重启 Cursor，再试一次 Agent/stream。
- 清全局状态：删除 `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb` 后重启（会清掉部分本地状态）。
- 升级或降级 Cursor 版本后重试（有用户反馈不同版本表现不同）。

**参考**：Cursor 论坛 [Agent just repeats same sentence again and again](https://forum.cursor.com/t/agent-just-repeates-same-sentence-again-and-again/128285)、[Agent stream bug](https://forum.cursor.com/t/agent-stream-bug/151533)。若仍复现，建议在 Cursor 论坛发帖或向 Cursor 官方反馈，以便产品侧修复。
