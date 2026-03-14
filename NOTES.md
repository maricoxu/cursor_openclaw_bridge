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

**200 有、但界面无回复时**：说明 prompt 已正确发给 cursor-agent（可用 `CURSOR_DEBUG_PROMPT=1` 看 `.cursor-bridge-last-prompt.txt`），但**我们没从 cursor-agent 的 stdout 里解析出文本**。此时只要发生「content 为空」，桥会把 **cursor-agent 的完整 stdout** 写入 **`.cursor-bridge-last-stdout.txt`**。该文件**只会在出现「无回复」的那次请求时生成**，且固定写在 **cursor-bridge 项目根目录**（与 `package.json` 同级），与从哪个目录执行 `npm start` 无关。若目录里没有该文件，说明自上次重启桥以来还没有触发过「200 但 content 为空」；再问一次「你是什么模型」等触发无回复后即可看到。

**502 刷屏、OpenClaw 一直无回复**：桥会对**非流式** completions 做**串行化**（同一时间只跑一个 runAgent），避免多实例冲突和重复 502。若仍出现连续 502，看终端里的 `[bridge] [id] runAgent failed: …` 和 `[agent-runner] cursor-agent exit code …` 或 `cursor-agent timeout`，可判断是超时、非零退出还是未登录，再对症排查。

**若错误信息含 `… is not available in the slow pool. Please switch to Auto`**：这是 Cursor 侧模型/配额限制，桥会返回 **503**、code `cursor_model_unavailable`。请在 **Cursor 设置**里把模型改为 **Auto**（或选用当前 slow pool 支持的模型），不要固定指定 `claude-4.6-opus-high-thinking` 等仅在 fast pool 可用的模型。

**若终端里只有 `[bridge] [id] POST /v1/chat/completions -> 200`、没有任何 `[agent-runner]` 或 `runAgent start`**：说明本次请求走的是**流式**（客户端发了 `stream: true`）。流式路径不会打 runAgent/agent-runner 的日志，且若 cursor-agent 的 stream-json 输出格式与解析器预期不一致，就可能 200 但无内容。可设置 **`CURSOR_FORCE_NON_STREAM=1`**（在 `.env` 里），桥会**内部**用 runAgent 非流式取回复，但若客户端请求的是 stream，桥仍会以 **SSE 单块**（一整段 content + [DONE]）回写，这样 OpenClaw 等只渲染流式响应的界面也能正常显示。

**典型现象 3：只有第一条有回复，第二、三条是空气泡**：OpenClaw 每次请求都会带上整段历史（例如 30+ 条），第二句起 prompt 很大，cursor-agent 容易超时或产不出我们解析的 result，桥就回 200 但 content 为空。**处理办法**：用下面的 `CURSOR_MAX_MESSAGES` 限制条数。

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

## 3. 为什么会出现「两段相同内容」与流式如何去重

### 3.1 为什么生成时会出两段相同内容？

**先说明「要重启谁」**：去重逻辑在 **cursor-bridge**（本桥）里，不在 OpenClaw。若改完代码后仍看到两遍，需要**重启 cursor-bridge**（停掉 `npm start` 再重新跑），不用重启 OpenClaw。若重启桥后仍两遍，可能是两段有细微差别（空格、标点），桥已做「两段 trim 后相同也去重」的放宽处理。

可能原因（不互斥）：

| 原因 | 说明 |
|------|------|
| **上下文过长** | 一次带了 31 条消息、prompt 约 3.8 万字符，容易触发下面说的「长上下文重复」机制。 |
| **解码/采样** | 生成长回复时，若重复惩罚不够或采样碰巧，模型会沿着「收到! 测试成功…」再生成一遍相同或极像的段落。 |
| **接口/实现** | 从目前实现看我们只取一条 `result`，更可能是模型侧重复；若上游把同一段拼两次也会出现，但较少见。 |

**可做的缓解**：控制发给桥的对话轮数（例如只带最近 N 条）、或依赖桥侧「整段重复」去重（非流式已做，流式见下）。

### 3.1.1 底层一点：为什么「上下文一大」更容易重复同一段？

可以粗分为「模型怎么生成」和「长上下文带来什么」两层。

- **模型是怎么生成下一句的**  
  当前这类模型（Transformer）是**按 token 一个一个生成**的：每生成一个 token，都会根据「当前已有的整段上下文」算一个概率分布，再按这个分布采样出下一个 token。也就是说，**下一个词长什么样，完全由「已经写出来的那一大段」决定**。如果这一段里已经出现过「收到! 测试成功，连接正常。我是小哩…」，那么在这些 token 附近的概率分布里，**再出现同样或很类似序列的概率并不会变成 0**，只是被「重复惩罚」压下去一些；惩罚不够或采样偶然时，就会再采出一遍类似内容。

- **上下文一长，为什么更容易「再采出一遍」**  
  1. **注意力是分散的**：模型对上下文的利用方式是「注意力」——每个位置会去看其他位置。上下文越长，同一段话在「很前面」和「刚写完的结尾」会同时存在，模型在生成结尾时既看到「前面某处有过这段」，又看到「刚写完这段」，若重复惩罚不强，就容易在结尾再生成一段「和前面或刚写过的很像」的内容。  
  2. **有效记忆变短**：长上下文下，模型更依赖「近处的 token」；早先的消息虽然还在，但权重会被摊薄。所以它更容易「跟着刚写的那几句」继续写，而不是牢牢记住「我已经说过一遍了，别再说」。  
  3. **训练数据里就有重复**：训练语料里本身就有「同一段意思换句话再说一遍」或列表、条款重复等，模型会学到「可以这样收尾」；长回复 + 弱重复惩罚，就容易在结尾再「收尾」一次，变成两段相同或几乎相同。

所以「上下文一大，更容易产生同一段内容」的底层原因可以概括成：**生成是局部依赖、按概率采样；上下文长了以后，注意力更偏向近期内容，且同一句话在上下文里已经出现，再被采样的概率仍在，就容易在结尾再生成一段相同或几乎相同的话**。桥的去重是在**结果上**兜底，根本缓解仍是：缩短上下文（少带历史轮次）或依赖上游/模型侧的重复惩罚。

### 3.2 流式时怎么判断「会有重复」？

流式是**边收边转发**，不能等整段结束再一次性判断，只能**边累积边看**：

- **思路**：在桥里维护「已转发给客户端的助理文本」`accumulatedText`。每收到 cursor-agent 的一小块 delta（如一行 NDJSON 里的 `message.content[].text`），先拼成 `next = accumulatedText + 本块`，再检查 `next` 是否等于「同一段写两遍」（即 `next.slice(0, half) === next.slice(half)`）。
- **若发现重复**：说明当前块正在写「第二遍」。此时只把「还属于第一遍」的那一段转发出去（即只转发到第一遍结束为止），之后本回复的后续块都不再转发，客户端就只会看到一遍。
- **实现位置**：在 `stream-parser.js` 的 `createStreamParser` 里，对每块在 push 前做上述判断；若 `wouldBeDuplicated(accumulatedText, text)` 为 true，则只 push 补全第一段的那部分内容，并设 `dedupeStopped`，后续块一律不再转发。

这样流式下也能在「整段重复」出现时只保留第一段，和当前非流式的 `dedupeRepeatedContent` 行为一致；若重复边界刚好落在某一块中间，会尽量只截出「第一段」的那一段再转发，避免把第一段截断。
