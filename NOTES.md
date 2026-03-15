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

### 3.x 流式「什么都不输出」：原因与诊断

**什么时候会出现「流式结束但界面没有任何字」？**

- **agent 只出了 heartbeat/thinking**：桥不转发这些，所以界面是空的。理论上**不应该只有 thinking 没有正文**，若出现则属于 **Cursor 侧输出行为问题**（例如只打了思考、没打最终回复），桥只是按设计不转发 thinking，本身合理。
- **「有 result 行却 0 块」**：当前只推 result；若上游没发任何 `type: result` 行（例如只发了 assistant），就会 0 块并在结束时推兜底提示。可开 `CURSOR_BRIDGE_DEBUG=1` 看 `[stream-raw]` 里是否有 result 行。
- **「全部 trim 为空」导致 0 块**：同样在正常逻辑下**不应出现**——每条流至少有一条「新部分」可推（首条与已发送无重叠），只有后续行可能 trim 成空。若整条流都 trim 成空，说明首条也空或未进入推送路径，属异常。
- **agent 没产出任何 assistant/result/message 行**：例如只输出了 user/system/tool_call、或**非法 JSON**（解析失败）。桥会检测这类情况，在 0 输出的情况下**推一条用户可见提示**（见下），避免界面完全空白。

**桥在「什么都不输出」时做了什么？**

- 流式结束时，若**没有推送过任何 content 块**，桥会打一行：  
  `[bridge] [id] 流式结束但未输出任何 content，界面可能无回复。`  
  便于确认是「无输出」场景。
- **非法或无正文时给用户一句提示**：若上游发过非空行但**从未推送过任何正文**（例如全是 thinking、或出现过 JSON 解析失败、或没有任何 assistant/result/message 行），解析器会在结束前**推一条说明**：`输出解析异常，未得到可展示内容。` 或 `无可展示内容（可能仅为 heartbeat/thinking），请重试或检查 Cursor Agent。` 这样界面不会完全空白，用户能看到原因。
- **结束只写一次**：`finish()` 用 `ended` 防重入，只会写一次 `data: [DONE]\n\n` 并 `res.end()`，不会重复写 [DONE] 或 error。

**如何进一步区分是「上游没发」还是「被去重/过滤」？**

- 开 **`CURSOR_BRIDGE_DEBUG=1`**，流式解析会打 `[stream-dedup]`：每行是 `skip redundant`、`skip trim_empty` 还是 `push`。若整段都是 `skip ...`、没有一条 `push`，说明上游有发内容但被去重或 trim 掉了（正常逻辑下首条应有 push）；若完全没有 `[stream-dedup]` 日志，说明上游没发任何 assistant/result/message 行，或全是 thinking/heartbeat 被过滤。

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

### 4.6 cursor-agent 进程模型：每次请求一新进程、无进程内缓存

**当前行为（桥与 Cursor 官方一致）**  
- **每次调用 cursor-agent 都会起一个全新的子进程**（`spawn(bin, [prompt, '--print', '--output-format', 'stream-json', ...])`），该请求结束后进程被 kill 或自然退出，**没有「常驻一个 agent 进程」**。
- 因此 **没有进程内缓存**：每次请求的 prompt 都是当次传进去的，agent 进程不保留上一轮的对话或状态。你看到的「重复两遍」等问题是**上游 Cursor 在同一条流里多发相同内容**，不是「上一轮缓存带到这一轮」。

**能不能保持在一个进程里、让它自己有缓存？**  
- **Cursor 官方设计**就是「每次请求新进程、跑完即退」（见 DESIGN.md 1.3：不做 cursor-agent 常驻复用）。**cursor-agent CLI 没有提供「常驻进程 + 多轮会话」的官方模式**；若强行自己维护一个长驻进程，需要自己实现「发 prompt → 读 stdout 流 → 结束」的协议，且要处理并发（多请求同时进来时一个进程无法同时服务多路）。
- 若未来 Cursor 提供 daemon/keep-alive 模式，桥可以再对接；目前**保持独立进程**是跟官方行为一致、实现简单、隔离好（一次超时/崩溃不影响其他请求）。

**不起进程、改常驻会不会有问题？**  
- 会：**(1) 并发**：一个进程只能串行处理一条 prompt，多用户或多请求同时来时要么排队要么多进程；(2) **协议**：当前 CLI 是「一次调用 = 一次 prompt → 一次流式输出」，没有「连接保持、多轮对话」的接口；(3) **超时与隔离**：单进程卡死或泄漏会影响所有后续请求。所以**独立进程更利于隔离和超时控制**（例如当前每个请求有独立 timeout、超时只 kill 当次子进程）。

**独立进程能不能加速？**  
- **冷启动**：每次新进程有 1～3 秒左右的启动与鉴权成本（见 LATENCY_AND_PROFILING.md），这是当前首包慢的主要来源之一。若有一天 Cursor 支持「常驻进程 + 复用连接」，理论上可以省掉冷启动，**加速首包**。  
- 在**没有**官方常驻模式前，保持「每次请求独立进程」是当前最稳妥、可维护的做法；加速更多依赖 Cursor 侧优化或官方提供长连/daemon 能力。

### 4.7 cursor 每轮无「上一轮」记忆；上下文只能靠 bridge 或 memory

- 因为每次都是新进程，**没有进程内记忆**。agent「知道」的只有本次 prompt 传进去的那一段。
- 所以：要么在 **bridge 里多攒点信息**（把 OpenClaw 发来的历史都塞进 prompt，或做限条数/单轮取舍），要么配合**外部 memory 系统**：例如把历史摘要、关键事实存到 MEMORY.md 或别处，下次请求前由 bridge 或上游把「记忆」拼进 system/user，再传给 cursor-agent。这是常见做法，没有在 bridge 里实现 memory 的话，就只能在「多带历史」和「控制长度防超时」之间折中（CURSOR_MAX_MESSAGES / CURSOR_SINGLE_TURN）。

### 4.8 在哪里加？怎么加？

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

## 5. 走 cursor-bridge 时 OpenClaw 能力：能用到的 vs 用不到的（利弊简表）

当 OpenClaw 把「主模型」或某条通道配成 cursor-cli（baseUrl 指向桥）时，请求会走 **Gateway → 桥 → cursor-agent**。下面区分**仍然被 OpenClaw 用到**的能力和**用不到或变味**的能力，便于你评估利弊。

### 5.1 能用到、基本不受影响

| 能力 | 说明 |
|------|------|
| **渠道与入口** | 钉钉/Telegram/Discord 等照常收消息；Gateway 照常收请求、做认证与路由。 |
| **多智能体路由** | 按 `model` / `x-openclaw-agent-id` 选 agent、会话；桥只收到「已经选好的」那一路请求。 |
| **会话与历史** | OpenClaw 把历史拼进 `messages` 再发给桥；桥用 `buildPrompt(messages)` 拼成一条 prompt → **历史在 prompt 里，被 cursor-agent 看到**。 |
| **身份 / 系统提示 / Skills** | 都在 `messages` 里（如 system、identity 等），桥原样拼进 prompt → **用上**。 |
| **流式** | 桥支持 `stream: true`，SSE 回写；OpenClaw 照常做流式展示。 |
| **记忆（若在消息里）** | 若 OpenClaw 在发请求前做了 memory 检索并塞进 system/user 消息，这些会在 `messages` 里 → 桥拼进 prompt → **用上**。 |
| **模型回退** | OpenClaw 可配 primary=cursor-cli、fallbacks=openrouter/…；桥不可用时自动走 fallback。 |

### 5.2 用不到或变味

| 能力 | 说明 |
|------|------|
| **OpenAI 式 tools / function calling** | 桥**只取 `messages`**，不读、不转发请求体里的 `tools`、`tool_choice`。若 OpenClaw 发的是「带 tools 的 Completions」、期望模型回 `tool_calls` 再由 Gateway 调 `/tools/invoke`，这条链路在走桥时**用不到**——桥不传 tools，cursor-agent 返回的也不是 OpenAI 的 tool_calls 格式。取而代之的是 **cursor-agent 自带能力**（MCP、读文件、执行命令等）在**子进程内**完成，不经过 OpenClaw 的「定义 tools → 模型返回 tool_calls → Gateway 执行」编排。 |
| **OpenClaw 工具编排** | exec、browser、自定义工具等由 Gateway 的 `/tools/invoke` 与策略控制；当「模型」是 cursor-agent 时，推理侧工具在 Cursor 进程内执行，**不在 OpenClaw 的 tools 列表里**。若你需要「同一对话里既用 Cursor 能力又用 OpenClaw 的某工具」，需要别的方式（如该 agent 改用支持 tool_calls 的 API 模型，或拆成两条链路）。 |
| **按 agent 切 workspace** | 桥当前单 `CURSOR_WORKSPACE`，不按 OpenClaw 的 agent_id 切不同目录；Phase3 设计里有「按 agent 分发 workspace」，尚未实现。 |
| **Responses API 的完整解析** | 若配成 `api: "openai-responses"`，桥也支持 `/v1/responses`，但 OpenClaw 对自定义 provider 的 Responses 解析可能不完整，推荐 `openai-completions`。 |

### 5.3 小结

- **对话、历史、身份、流式、渠道、回退**：都还是 OpenClaw 在管，桥只做「把 messages 变成 prompt、把 agent 输出变成 SSE」。
- **工具**：走桥时用的是 **cursor-agent 自己的工具**（MCP、workspace 等），不是 OpenClaw 的 tools + tool_calls 编排；若你要「OpenClaw 定义工具、模型返回 tool_calls、Gateway 执行」，需用支持该协议的模型通道（如 OpenRouter/直接 API），不能靠桥实现。
- 利弊权衡：**省订阅钱、用 Cursor 能力** ↔ **不能用 OpenClaw 的 tools 编排与 tool_calls**；若你主要要的是「钉钉里用 Cursor 回话」，当前桥已经覆盖，其余能力可按上表按需选通道。

### 5.4 分工小结：Cursor 强在工具，OpenClaw 强在编排；记忆尽量不依赖 OpenClaw

- **Cursor（含 cursor-agent）**：作为 IDE 侧，工具能力更强——MCP、读写 workspace 文件、执行命令、完整项目上下文等，适合「在笔记/代码库里做事」。
- **OpenClaw**：强在多智能体、渠道、会话历史、身份与路由；把「谁在说话、历史几条、发往哪个 agent」管好，再发 `messages` 给桥即可。
- **记忆放在哪**：**长期/持久记忆**（事实、偏好、发生过的事、daily 日志）建议尽量**不依赖 OpenClaw 的 memory 系统**，而放在 **workspace + 桥/agent 侧**：例如 MEMORY.md、memory/YYYY-MM-DD.md 在笔记库里，由桥在拼 prompt 时读入并注入，或由 cursor-agent 通过 MCP/读文件直接访问。这样**单一事实来源**在 repo，Cursor 与桥都能读写，不依赖 OpenClaw 的 memory 存储或检索；OpenClaw 只负责「本会话的对话历史」在 `messages` 里带给桥，已经足够。

### 5.5 若记忆也放在桥侧，OpenClaw 在这个体系里做什么？

OpenClaw 的角色可以概括为：**渠道接入 + 会话与路由编排**，不是「远程沟通」四个字能说完，但远程沟通是其中一块。

| 作用 | 说明 |
|------|------|
| **渠道接入（远程沟通）** | 连钉钉、Telegram、Discord、iMessage 等；用户在手机/电脑上通过这些 IM 发消息，OpenClaw **收进来**，AI 回复后 **发回去**。所以「远程沟通」成立：没有 OpenClaw，用户没法在钉钉里和 Cursor 对话。 |
| **会话与对话历史** | 同一个群/私聊的「这一串对话」由 OpenClaw 维护：谁说了什么、按时间排好，在每次要调用模型时拼成 `messages`（含 system、历史轮次、当前这条），发给桥。**长期记忆**可以放在桥/workspace；**本会话的这几轮**仍然是 OpenClaw 管。 |
| **多智能体与路由** | 决定这条消息由哪个 agent 处理（main / beta / 不同身份），用哪套身份与 system prompt，以及用哪个模型通道（cursor-cli 还是 fallback）。 |
| **调用模型并回写** | 把 `messages` 以 HTTP 形式发给桥（或 OpenRouter 等），拿到流式/非流式回复后，再通过渠道**回写到**钉钉/Telegram 的对话里。 |

所以：**OpenClaw = 把你和「AI 后端」连起来的中间层**：一头接各种 IM（远程沟通），一头按会话与路由组好 `messages` 并调用桥（或别的 API），再把回复塞回 IM。若记忆也放在桥/workspace，OpenClaw 仍然负责「这条对话的上下文」和「谁在跟谁说话、从哪来回哪去」；它不负责「跨会话的长期记忆存储」，那一块在 workspace + 桥更合适。

### 5.6 钉钉上传的图片能否通过桥传给 Cursor？

**当前**：**不能**。桥的 `prompt-builder` 只从 `messages[].content` 里抽**纯文本**（`text` / `content` / `input_text`），不处理 `image_url` 或图片 part，所以钉钉发来的图片在桥侧会被**忽略**，cursor-agent 只收到文字。

**cursor-agent 的能力**：根据 [Cursor Headless CLI 文档](https://cursor.com/docs/cli/headless)，**图片要通过「在 prompt 里写文件路径」传给 agent**，agent 再用 tool（读文件）打开图片。即：prompt 里写 `"看看这张图：/path/to/image.png"`，agent 会去读该路径下的文件（含图片）。不支持在 prompt 里内联 base64 或 URL。

**若要支持「钉钉图片 → 桥 → Cursor」**，需要：

| 环节 | 要做的事 |
|------|----------|
| **OpenClaw** | 钉钉上传图片后，把图片转成可传给桥的形式：例如 (1) 在请求里带 `content: [{ type: "text", text: "…" }, { type: "image_url", image_url: { url: "data:image/...;base64,..." } }]`，或 (2) 先落盘得到路径，在消息里用文字注明路径（如 `[图片: /tmp/xxx.png]`）由桥原样拼进 prompt。 |
| **桥** | (1) 若收到 `image_url`（含 data URL）：解码 base64 → 在 workspace 或临时目录写入文件（如 `memory/.uploads/xxx.png`）→ 在拼出的 prompt 里加上「用户发送了一张图片，路径为：<绝对路径>。请根据图片内容回答。」并把用户文字一起拼进去；(2) 若收到的是「路径占位」文字，直接保留在 prompt 里即可。 |
| **cursor-agent** | 无需改；prompt 里带文件路径后，agent 会用读文件工具看图并回答。 |

**小结**：理论上可以传导，需要 **OpenClaw 把图片给到桥**（base64 或路径）+ **桥把图片落盘并在 prompt 里写清路径**。当前桥未做图片解析与落盘，若要做可单独加一版「多模态输入」支持（识别 `image_url`、落盘、改写 prompt）。

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

**桥当前不做去重，且只推 result**：流式解析器已移除所有去重逻辑，且**只转发 `type: result` 的整段内容**，不转发 assistant/message；无 result 时推兜底提示。重复问题视为 **Cursor Agent 侧** 责任；桥只做 NDJSON → SSE 解析及 thinking/心跳过滤。

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

### 3.2 流式解析器：只推 result（当前实现）

**适用场景**：以下逻辑**仅作用于流式响应**（客户端请求 `stream: true` 时）。非流式走 agent-runner 聚合 stdout，不经 stream-parser。

**当前策略（无去重，只推 result）**  
流式解析按 **「一行 NDJSON」** 为单位处理。桥**只推送 `type: result` 的整段内容**：解析到 `type === 'result'` 且 `result` 字段有效时，将该段原样 push；**不转发** `assistant`、`message` 等类型。若整条流从未 push 过任何内容（例如只有 thinking/heartbeat、或仅有 assistant 无 result），在结束前推一条兜底提示（解析异常 / 无可展示内容）。详见 `DEDUP_LOGIC.md` 顶部「当前策略」。

**官方 stream-json 格式**（[Output Format](https://cursor.com/docs/cli/reference/output-format)）：`system`、`user`、`assistant`、`tool_call`、`result`。*thinking events are suppressed in print mode*。

**type 与是否转发（当前表）**

| type | 是否转发 | 说明 |
|------|----------|------|
| **assistant** | ❌ 不转发 | 不 push，避免与 result 重复 |
| **result** | ✅ 转发 | 从 `result` 字段取整段正文，原样 push |
| **message** | ❌ 不转发 | 不 push |
| **thinking / reasoning / thought** | 可选 | 设 `CURSOR_STREAM_SHOW_THINKING=1` 时作为**前期输出**先推（可配 `CURSOR_STREAM_THINKING_PREFIX`，默认「思考：」），result 再作为最终输出，体感更连贯 |
| **user / system / tool_call** 等 | ❌ 不处理 | 不产出助理正文 |
| **无 type 或仅有顶层 output/content/text** | ❌ 不处理 | 不抽取、不转发 |

**调试**：设 `CURSOR_BRIDGE_DEBUG=1` 后，stream-parser 会打 `[stream-raw]`（每行 type/textLen/snippet），便于查看上游 type 顺序与内容摘要。

**thinking/reasoning 是否流式？能否做「前期输出」改善体感？**  
- **官方说明**：Cursor 文档写明 [Output Format](https://cursor.com/docs/cli/reference/output-format) 中 *thinking events are suppressed in print mode*，即 **print 模式（桥当前用法）下上游可能不发出** `type: thinking` 事件，故多数情况下看不到独立的 thinking 行。  
- **若上游有发**：thinking/reasoning 通常是一行一行 NDJSON（每行一个事件），相当于「流式一步步产生」。此时若开启 **`CURSOR_STREAM_SHOW_THINKING=1`**，桥会把每条 thinking/reasoning 作为**前期输出**先推给客户端（默认加前缀「思考：」，可用 `CURSOR_STREAM_THINKING_PREFIX` 改或置空），等 **result** 到达后再推整段 result 作为最终/诊断输出。这样用户先看到思考过程、再看到正式回复，**体感上不会长时间空白**，体验更好。  
- **小结**：理论上 thinking 可以是流式多行；当前 print 模式下上游可能不发，一旦有发且开启 SHOW_THINKING，桥已支持「前期 thinking → 最终 result」的输出顺序。

**超时未收到 result 时的提示（处理时间较长）**  
若迟迟没有 thinking 也没有 result，用户会面对空白。可设 **`CURSOR_STREAM_WAITING_MSG_AFTER_MS`**（毫秒，如 10000～20000）：从收到第一块流数据起，超过 N 秒仍未推送过任何可展示内容时，桥会先推一条提示（默认「处理时间较长，请稍候。」，可用 **`CURSOR_STREAM_WAITING_MSG_TEXT`** 覆盖）。一旦之后有 result 或 thinking，会照常追加；超时定时器会在推送任意内容或流结束时清除。

**流式体验提升的方法论（小结）**  
| 手段 | 作用 | 本桥实现 |
|------|------|----------|
| **前期输出** | 有内容先出，不等整段结束 | `CURSOR_STREAM_SHOW_THINKING=1`：thinking/reasoning 先推，result 再推 |
| **超时提示** | 长时间无内容时给一句「请稍候」，避免误以为卡死 | `CURSOR_STREAM_WAITING_MSG_AFTER_MS` + `CURSOR_STREAM_WAITING_MSG_TEXT` |
| **占位首帧** | 一连接就出「正在处理…」 | 未实现：需在首字节或首行即推，易与后续 result 拼成一段，可按需加 |
| **进度/状态** | 解析到 tool_call 时推「正在调用工具…」 | 未实现：需解析 type=tool_call 并推独立提示，前端可区分展示 |
| **最终替换** | 前期占位、后期用 result 替换而非追加 | 依赖前端：SSE 只有 content delta，前端可约定「最后一整段为正式回复」做折叠/替换 |

建议优先打开 **SHOW_THINKING**（若上游有 thinking 会立刻有字）和 **WAITING_MSG_AFTER_MS**（如 15 秒），再按需调提示文案。

**3.2.1 历史去重算法（已废弃，仅排查参考）**

每收到一行 NDJSON（type 为 assistant/result/message 且抽出正文后），按下面顺序执行；**归一化**统一为：`normalizeForEchoCheck(t) = t.replace(/\s+/g, ' ').trim()`（空白压成单空格再 trim）。

1. **事件级去重（整行跳过）**  
   设 `streamedText` = 目前已推送内容的拼接，`normStreamed` = 归一化(streamedText)，`normNew` = 归一化(当前行正文)。  
   若以下**任一**为真，则**整行不推送、不更新 streamedText**：
   - `normNew === normStreamed`
   - `normNew.length >= 20` 且 `normStreamed.endsWith(normNew)`
   - `normStreamed.startsWith(normNew)`
   - `normNew.length >= 10` 且 `normStreamed.includes(normNew)`
   - `normStreamed.length > normNew.length` 且 `normStreamed.includes(normNew)`
   - `normNew.length >= 20` 且 `normStreamed.length >= 20` 且 `normStreamed.includes(normNew)`

2. **跨行 trim（只推「新部分」）**  
   若未在步骤 1 跳过，计算**已发送尾部**与**当前行前缀**在归一化下的最长重叠：  
   - 找最大 `len`（从 min(streamedText长, 当前行长) 往下试），使得 `normStreamed.endsWith(normNew.slice(0, len))`。  
   - 把该 `len` 映射回原始字符边界，得到当前行中「与已发送重叠」的前缀长度 `rawPrefixLen`。  
   - 只推送 `当前行.slice(rawPrefixLen)`；若为空则不推送。  
   - 推送后：`streamedText += 本次推送的内容`（assistant/result/message 规则略）。  

   **跨行能否基本精准不重复？** 能。只要「当前行开头」和「已发送内容的结尾」在归一化下能对上，就会把**重复的那一段前缀整段砍掉**，只推后面真正新的部分；若整行都是重复（重叠 = 整行），就推 0，相当于这一行不发出。例如：第二行已经发了「……我这边拿不到当前会话用的大模型」，第三行是「我这边拿不到当前会话用的大模型。若要在 openclaw…」，算法会算出第三行前几句和第二行结尾重复，只推「。若要在 openclaw…」及之后。所以**在归一化一致的前提下，跨行不会把同一段再发一遍**；若仍出现重复，多半是两行在空格/标点/字符上有细微差异，归一化后重叠被算短了，导致多推了一截。

3. **单行内去重**  
   对**即将推送**的那段字符串（即上面跨行 trim 后的结果）再做一次检测：若归一化后「结尾 L 字」与「开头 L 字」相同（L 在 40～半长），则只保留第一段再推送（去掉末尾重复段）。

   **通俗理解（单行内去重「结尾 L 字 = 开头 L 字」是什么）**  
   可以把它想成：**一整段话被「复制粘贴」了一次，同一行里出现了「段落 + 段落」**。  
   例如 Cursor 在一行里就输出了：

   > 我这边没有实时天气接口，没法直接查你所在位置的天气。你可以用手机自带天气查。**我这边没有实时天气接口，没法直接查你所在位置的天气。你可以用手机自带天气查。**

   归一化（去掉多余空格、换行）之后，整段可以看成 **A + A**：前半段和后半段是同一段话。  
   这时：
   - **「开头 L 字」** = 从第一个字开始数 L 个字（比如 L=40，就是「我这边没有实时天气接口，没法直接查你所在位置的天气。你可以用手机」）；
   - **「结尾 L 字」** = 从最后一个字往前数 L 个字（同样是那 40 个字，因为后半段和前半段一样）。

   所以**「结尾 L 字」和「开头 L 字」会一模一样**。算法发现这一点后，就认为：**末尾一整块是在重复开头**，于是只保留「从开头到重复块之前」的那一段再推送，相当于把后面那遍整段删掉，只给用户看一遍。  
   L 限制在 40～半长，是为了：太短（如 L=5）容易误删正常内容；只检查「至少半长」的重复，才算是「整段又出现了一次」。

**为什么图示（第四行和第二行、第五行和第三行整段重复）按理不该出现却仍出现？**  
按设计，第二行发完后「第四行」那整段若和已发内容一致，应被事件级判冗余整行跳过；若只是前缀重复，跨行 trim 会只推新部分。仍出现「整段又发一遍」多半是：**第二份和第一份在字符级有细微差异**（例如多一个「或」写成「或或」、空格/标点不同），严格归一化后 `includes` 不成立，事件级没拦，跨行 trim 的重叠也算短，结果整段又被推出去。  
**已做加强（轻量级）**：当当前行与已发送都 **≥8 字**时，再做一次**宽松归一化**（连续重复字合并，如「或或」→「或」）；为控性能，**只取已发送内容的末尾 600 字**做宽松比较，若这段「尾巴的宽松版」包含「当前行的宽松版」则判冗余整行跳过。重复多出现在「刚发过的半段」内，取尾 600 字即可覆盖，且不对整段做正则；可能漏判较久之前的重复或偶发误判，可接受。

**12:40 案例（用的什么模型 / 显示当前模型 回复仍两遍）根因与补充**：日志显示同一轮内 (1) 多段小 assistant 推满 streamedTotal=1047 后，(2) 上游又发一条 **type=assistant textLen=792**（「在当前这个工作区…」到结尾整段）被整段 push → 1839，(3) 再发 **type=result textLen=967** 又被 push → 2806。原因：**600 字尾巴**无法覆盖 792/967 的长块，且严格归一化因空格/标点差异导致 `includes` 未命中。**补充**：当当前行 **≥300 字**时，用已发**末尾 2500 字**做宽松包含判定（长块宽松）；当 **type=result** 且已发≥500 字、当前行≥100 字时，用已发**全文（最多 3000 字）**做宽松包含判定（result 整段重复）。据此 792 与 967 应被拦下。

**跨行仍两遍的其它原因**：  
- 不可见字符、全角/半角等导致宽松比较仍不包含。  
- 建议：开 `CURSOR_BRIDGE_DEBUG=1` 看该条回复对应日志里是 `skip redundant` / `skip trim_empty` 还是 `push`；若多数是 `push` 且 push 了两次长段，说明桥侧判定仍未识别为重复，可再加强归一化或做相似度阈值。

**事件级去重**（仅流式）：`assistant`、`result`、`message` 三种都参与。以下任一成立则当前行整行跳过：已转发全文 === 当前行（归一化后）；已转发结尾/开头包含或等于当前行；已转发长度 > 当前行且已转发包含当前行（防 result 后单字/短 chunk 重复）；**长文本（≥20 字）且已转发内容包含当前行**（避免上游略有空格/换行差异仍漏判）；**当前行以已转发内容开头且仅多出 ≤25 字**（防「先多段 assistant 流式、再发一整段 assistant 重复」如 12:29 两遍案例）；**长块（≥300 字）宽松包含**：用已发内容的**末尾 2500 字**做宽松归一化，若包含当前行的宽松版则跳过（防「792 字 assistant 整段重复」——原先只比最后 600 字，长块会漏）；**result 且已发≥500 字**：用已发**全文（最多 3000 字）**做宽松包含，若包含当前 result 的宽松版则跳过（防「967 字 result 整段再推」）。单测覆盖：result+单字 assistant、两行相同 assistant、result+message、真实长段落两遍、整段+新句只发新部分、startsWith+短尾整行跳过等。

**单条内去重（跨行）**（仅流式）：在事件级未整行跳过时，若当前行内容的前缀与已发送内容的**尾部**重复，只推送「新部分」（`trimDuplicatePrefix`），避免同一段在一条消息里出现两遍（如「问1 / 问1问2 / 问1问2问3」只出问1、问2、问3 各一段）。实现为 O(min(M,N)) 的归一化比较 + 原始边界映射。

**为什么有时「单条内去重」没生效？** 常见两种原因：（1）**单行内就带了整段重复**：Cursor 有时在一行里就输出整段两遍（例如一个 `result` 的 content 就是「段落+段落」），我们只做「当前行 vs 已发送」的跨行 trim，不做「当前行内部」的检查，就会整段原样推送；（2）**第二行有轻微字符差异**（如多一个「或」→「或或」），归一化后重叠变短，trim 只去掉较短前缀，又推了一大段含重复的尾巴。  

**单行内去重**（仅流式）：在推送前对当前要推的字符串做**行内重复段**检测：若归一化后「结尾 L 字」与「开头 L 字」相同（L 在 40～半长），视为末尾整段重复，只保留第一段再推送（`removeWithinLineDuplicate`），可缓解「一行即两遍」和部分轻微差异导致的重复。

**去重对性能的影响**：事件级与跨行 trim 只做字符串比较和少量归一化，单条流式下每行成本很低。单行内去重仅在对「即将推送」的块执行，且长度 &lt; 80 直接返回；检测到重复时用二分找截断点，整体 O(n log n)，单行 2k 字量级约在 1ms 内。若非常在意延迟，可在环境变量中提供开关关闭单行内去重（当前未实现，可按需加）。

**若出现「两条独立气泡」**：两条气泡通常说明客户端发了**两次请求**或渲染创建了多条消息。排查：看桥终端是否有两次 `runAgentStream start`。

**排查「仍两遍」用调试日志**：设 `CURSOR_BRIDGE_DEBUG=1` 后重启桥，stream-parser 会打 **`[stream-raw]`**（每行 NDJSON 一条）：`type=assistant|result|message|...`、`textLen=`、`snippet=` 前 55 字或 `-`/`(filtered)`。用来看**上游发来的完整 type 顺序**和每段内容摘要。当前桥只推 result、不推 assistant/message，若界面仍两遍，多半是 **openclaw/control-ui** 同一条消息渲染了两次或上游同一条流内发了多段，需在客户端或 Cursor Agent 侧排查。

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
