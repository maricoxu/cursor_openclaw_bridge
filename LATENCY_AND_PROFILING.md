# 响应速度全链路与 Profiling 说明

## 1. 全链路在做什么（流式路径）

从「用户在 OpenClaw 发送消息」到「界面上首字/流式字出现」的完整路径如下。

```
OpenClaw 客户端
    │
    ▼ ① HTTP POST /v1/chat/completions (body = messages, stream: true)
cursor-bridge (Node HTTP server)
    │
    ├─ ② 读取请求体 (for await chunk) + JSON.parse
    ├─ ③ buildPrompt(messages) → 单条 prompt 字符串
    ├─ ④ runAgentStream() → spawn(cursor-agent, [prompt, --output-format stream-json, ...])
    │
    ▼ ⑤ cursor-agent 子进程
cursor-agent (CLI)
    │
    ├─ ⑥ 启动、加载 workspace/规则、可能拉取会话上下文
    ├─ ⑦ 与 Cursor 后端通信（模型推理、工具调用等）
    ├─ ⑧ 边推理边往 stdout 写 NDJSON 行 (type: assistant / result / thinking...)
    │
    ▼ ⑨ proc.stdout 可读流
agent-runner (runAgentStream)
    │  raw NDJSON 行
    ▼
stream-parser (Transform)
    │
    ├─ ⑩ 按行解析 NDJSON、过滤 thinking/心跳、事件级去重
    ├─ ⑪ 转成 OpenAI SSE 格式：data: {...}\n\n
    │
    ▼ ⑫ parser.pipe(res)
cursor-bridge → HTTP 响应 (text/event-stream)
    │
    ▼ ⑬ 客户端收 SSE、渲染首字/流式
OpenClaw 界面
```

### 各步简要说明

| 阶段 | 位置 | 做什么 | 可能瓶颈 |
|------|------|--------|-----------|
| ① | 网络 / OpenClaw | 客户端组包、发 POST | 网络 RTT、客户端序列化 |
| ② | server.js | 收完 body、解析 JSON | body 大时一次性读入、JSON.parse 成本 |
| ③ | prompt-builder.js | messages → 单条 prompt 字符串 | 消息条数多时循环拼接，一般较小 |
| ④ | server.js → agent-runner.js | spawn 子进程、传 prompt | 进程创建、env 继承 |
| ⑤–⑧ | cursor-agent | 内部逻辑：加载上下文、调 API、推理、写 stdout | **主要瓶颈**：模型首 token、网络、规则/文件加载 |
| ⑨ | agent-runner | 仅把 proc.stdout 暴露为流，无额外缓冲 | 通常不是瓶颈 |
| ⑩–⑪ | stream-parser.js | 按行 parse、过滤、转 SSE | 每行一次 JSON.parse + 字符串拼接，数据量大时可见 |
| ⑫ | server.js | 可写流 res 写 SSE | Node 与 TCP 缓冲，一般很快 |
| ⑬ | 网络 / OpenClaw | 收 SSE、解析、渲染 | 网络、前端渲染 |

结论：**最可能的瓶颈在 ⑤–⑧（cursor-agent 内部）**，其次是 ②（body 大时）和 ⑩–⑪（解析/过滤）。要验证需在实际请求上打点量时间。

---

## 2. 实测数据与结论（2026-03-14）

在 OpenClaw 流式对话下用 `CURSOR_BRIDGE_PROFILE=1 npm start` 打点，得到两组数据。

### 2.1 第一组：简单短句

- **请求**：用户发送「测试一下」
- **日志**：
  - `bridge_ttfb_ms=13022`，`body_parse_ms=2`，`prompt_build_ms=2`，`to_spawn_ms=0`
  - `agent_ttfb_ms=1926`，`parse_to_first_sse_ms=11092`
  - `total_ms=13935`

### 2.2 第二组：复杂问题 + 长输出

- **请求**：用户发送「如果要提高跑步成绩，你觉得应该怎么做？给我一个方法论吧」
- **日志**：
  - `bridge_ttfb_ms=8468`，`body_parse_ms=0`，`prompt_build_ms=1`，`to_spawn_ms=0`
  - `agent_ttfb_ms=1989`，`parse_to_first_sse_ms=6478`
  - `total_ms=18926`

### 2.3 结论

| 指标 | 第一组 | 第二组 | 说明 |
|------|--------|--------|------|
| bridge_ttfb_ms | 13022 | 8468 | 从请求到首字的时间 |
| agent_ttfb_ms | 1926 | 1989 | 稳定 ~2s，spawn 到 agent 首字节 |
| parse_to_first_sse_ms | 11092 | 6478 | 从 agent 首字节到首条**可展示**内容 |
| total_ms | 13935 | 18926 | 整段流结束时间 |

- **桥侧**（body_parse、prompt_build、to_spawn）仅数毫秒，可忽略。
- **agent_ttfb_ms** 稳定在约 2s：进程启动 + 模型「任意首输出」。
- **parse_to_first_sse_ms** 不是解析耗时，而是「从 agent 写出第一个字节到写出第一条被转发的内容」的间隔；这期间 agent 多在输出 thinking/reasoning/心跳，被我们过滤掉，未转发。因此瓶颈在 **cursor-agent 何时产出第一条可展示内容**（模型与规则/HEARTBEAT），不在桥内解析。
- 要缩短首字时间，需从 **Cursor/模型、SOUL/规则、或是否展示 thinking**（如 `CURSOR_STREAM_SHOW_THINKING=1`）入手。

---

## 3. Profiling 打点设计（按需复现）

当前代码仓**默认不包含**打点逻辑，以减少热路径开销。需要做延迟分析时：设置 **`CURSOR_BRIDGE_PROFILE=1`**，并按下述打点设计在 `server.js` / `stream-parser.js` 中**临时加回**打点逻辑即可。

### 3.1 打点定义（流式）

| 打点标识 | 含义 | 所在模块 |
|----------|------|----------|
| `t_req_start` | 请求进入 handler，开始读 body 前（或收到 POST 路由时） | server.js |
| `t_body_parsed` | body 读完且 JSON.parse 完成 | server.js |
| `t_prompt_built` | buildPrompt 完成，得到 prompt 字符串 | server.js |
| `t_spawn` | runAgentStream 被调用（spawn 之前） | server.js |
| `t_first_byte_agent` | cursor-agent 首字节到达 proc.stdout（子进程首输出） | agent-runner.js |
| `t_first_sse` | 第一个 SSE 块 push 到 response（客户端可见首字） | stream-parser.js 或 server.js |
| `t_stream_end` | 流结束，收到 [DONE] 或 close | server.js |

派生指标（日志中可打印）：

- **body_parse_ms** = t_body_parsed - t_req_start  
- **prompt_build_ms** = t_prompt_built - t_body_parsed  
- **to_spawn_ms** = t_spawn - t_prompt_built  
- **agent_ttfb_ms** = t_first_byte_agent - t_spawn（子进程首字节延迟）  
- **bridge_ttfb_ms** = t_first_sse - t_req_start（桥到客户端的 TTFB）  
- **parse_to_first_sse_ms** = t_first_sse - t_first_byte_agent（从 agent 首字节到首 SSE 的解析延迟）

### 3.2 实现要点（加回打点时参考）

- **server.js**：`t_req_start` 进入 completions 分支即记；读完 body 后 `t_body_parsed`；buildPrompt 后 `t_prompt_built`；runAgentStream 前 `t_spawn`。对 `agentStream.once('data')` 记 `res._tFirstByteAgent`；在 `meta.onFirstChunk` 中记 `res._tFirstSse` 并打印 TTFB 汇总。`finish()` 时打印 `total_ms`。仅在 `process.env.CURSOR_BRIDGE_PROFILE === '1'` 时执行上述逻辑。
- **agent-runner.js**：可不改；首字节时间由 server 通过 `agentStream.once('data')` 在 pipe 前监听得到。
- **stream-parser.js**：第一次 `this.push(...)` 前若 `meta.onFirstChunk` 存在则调用一次并置空，用于 server 计算 t_first_sse 与 parse_to_first_sse_ms。

---

## 4. 如何使用（加回打点后）

1. 启动桥时开启 profiling：`CURSOR_BRIDGE_PROFILE=1 npm start`。
2. 在 OpenClaw 发一条流式请求，观察终端输出的各阶段耗时。
3. 根据 **agent_ttfb_ms** 与 **parse_to_first_sse_ms** 判断瓶颈在 cursor-agent 还是桥内解析。

---

## 5. 非流式路径（可选）

非流式 POST /v1/chat/completions 路径：没有「首字」概念，可只打 **t_req_start / t_body_parsed / t_prompt_built / t_spawn / t_agent_done**（runAgent  resolve 时），并打印 **total_ms** 与 **agent_ms**（t_agent_done - t_spawn）。若后续需要再在 agent-runner runAgent 里用同样方式加打点。
