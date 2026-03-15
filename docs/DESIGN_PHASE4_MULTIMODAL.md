# Phase 4：多模态（图片）桥支持 — 设计文档

本文档是 cursor-bridge **Phase 4 多模态**的完整设计与实现规格，与 [DESIGN.md §10.5](../DESIGN.md) 和 [NOTES.md §5.6](../NOTES.md) 对齐，供开发与评审使用。

---

## 1. 目标与范围

### 1.1 产品目标

- **钉钉等渠道上传的图片**能经桥传导给 cursor-agent，使 Cursor 能「看图说话」。
- 用户在与 OpenClaw（钉钉）对话时发送图片 + 文字，agent 收到的是「文字 + 图片的本地路径」，通过读文件工具看图并回答。

### 1.2 范围边界

| 在范围内 | 不在本阶段 |
|----------|-------------|
| 图片输入：`image_url`（含 data URL）→ 落盘 → prompt 中写入路径 | 视频、语音、文档（PDF/Office）等多模态 |
| OpenAI 兼容的 `content: [{ type: "image_url", ... }, { type: "text", ... }]` | 输出侧「agent 生成图片」 |
| 落盘目录在 workspace 下或约定临时目录，便于 agent 读文件 | 图片编辑、裁剪、压缩等预处理 |
| 与现有 prompt-builder / buildPrompt 集成 | OpenClaw 侧 UI/上传逻辑（由上游实现） |

---

## 2. 约束与前提

### 2.1 cursor-agent CLI 约束

根据 [Cursor Headless CLI 文档](https://cursor.com/docs/cli/headless)：

- **不接收** prompt 中的内联 base64 或 HTTP URL 作为图片。
- **只认「在 prompt 里写文件路径」**：agent 通过 **tool calling（读文件）** 打开该路径下的文件（含图片）。
- 路径可为相对路径（相对 agent 的 cwd/workspace）或绝对路径；需保证 agent 进程能访问到该路径。

因此桥必须：**把渠道传来的图片落到磁盘 → 在拼出的 prompt 中写入该文件的（相对或绝对）路径**。

### 2.2 当前桥的限制

- **prompt-builder** 只从 `messages[].content` 抽取**纯文本**（`text` / `content` / `input_text`），不处理 `image_url` 或其它 part 类型。
- 钉钉发来的图片若以 `image_url` 形式进入 messages，当前会被**忽略**，agent 只收到文字。

### 2.3 依赖方

- **OpenClaw**：需在调用桥时，把渠道（钉钉）上传的图片以以下任一形式放入请求的 `messages`：
  - **方式 A**：`content: [{ type: "text", text: "…" }, { type: "image_url", image_url: { url: "data:image/...;base64,..." } }]`（OpenAI 多模态约定）；
  - **方式 B**：先落盘得到路径后，在消息里用文字注明路径（如 `[图片: /tmp/xxx.png]`），由桥原样拼进 prompt。
- 若 OpenClaw 当前未传图，需先在其侧支持图片上传并填入 messages，再在桥侧对接。

---

## 3. 数据流

### 3.1 端到端

```
钉钉用户发送「图片 + 文字」
    │
    ▼
OpenClaw 将图片转为 base64 或路径，填入 POST /v1/chat/completions 的 messages[].content
    │
    ▼
桥收到 messages
    │
    ├─ 若 content 中含 type: "image_url" 且 url 为 data URL
    │      → 解码 base64 → 落盘到约定目录（如 <workspace>/.bridge-uploads/<requestId>-<n>.<ext>）
    │      → 得到本地绝对路径（或相对 workspace 的路径）
    │
    ├─ 若 content 中已是路径占位文字（如 [图片: /path/to/x.png]）
    │      → 不落盘，直接保留该段文字参与拼 prompt
    │
    ▼
buildPrompt 前/中：将「图片 part」替换或追加为一句说明文本
    例如：「用户发送了一张图片，路径为：<绝对路径>。请根据图片内容回答。\n\n用户说：<用户文字>」
    │
    ▼
单条 prompt 字符串（含路径）→ runAgent / runAgentStream
    │
    ▼
cursor-agent 解析 prompt，在需要时通过 readToolCall 读该路径 → 看图并回答
    │
    ▼
响应返回 OpenClaw → 钉钉展示
```

### 3.2 桥侧职责小结

| 步骤 | 桥要做的事 |
|------|------------|
| **解析** | 遍历每条 message 的 content；识别 `type: "image_url"` 且 `image_url.url` 为 data URL（`data:image/...;base64,...`） |
| **落盘** | 解码 base64 → 写入 workspace 下约定目录，文件名含 requestId 与序号，避免冲突；记录扩展名（png/jpeg/webp 等） |
| **路径** | 使用 agent 可访问的路径：建议 **绝对路径**（避免 cwd 歧义），或相对 `CURSOR_WORKSPACE` 且 agent 的 `--workspace` 指向同一根 |
| **拼 prompt** | 将每条 message 中「图片 part」替换为/追加为一句「用户发送了一张图片，路径为：<path>。请根据图片内容回答。」；同一 message 内多图则多句；与同条 user 的文字一起保留顺序 |
| **路径占位** | 若 content 中某 part 已是路径占位（约定格式见下），直接保留进 prompt，不重复落盘 |

---

## 4. 协议与格式约定

### 4.1 输入：OpenAI 风格多模态 content

- **文本**：`{ type: "text", text: "…" }` 或 `{ type: "input_text", text: "…" }`。
- **图片（data URL）**：`{ type: "image_url", image_url: { url: "data:image/png;base64,..." } }`。  
  - `url` 可为 `data:image/<subtype>;base64,<data>`，subtype 如 png、jpeg、webp、gif。
- **顺序**：同一 message 内可多个 part，如先文字后图、先图后文字；桥按顺序处理，在 prompt 中保持「文字 + 图片说明」的顺序。

### 4.2 路径占位（做；约定格式由 OpenClaw 与桥对齐）

若 OpenClaw 已在本地或 COS 等落盘，可在 content 中发**纯文本**占位，桥识别后**不**做 base64 解码与落盘，直接将整段文字拼入 prompt，agent 仍能通过路径读图。

**约定格式**：`[图片: <绝对或相对路径>]`，例如 `[图片: /path/to/image.png]`。桥用正则识别该格式，原样保留进 prompt；避免与用户正常输入冲突（用户极少在消息里写 `[图片: ...]`）。

**路径占位的利弊**

| 利 | 弊 |
|----|-----|
| OpenClaw 可先落盘（如上传 COS）、再只传路径，桥不占磁盘、不重复存 | 需约定格式，否则误识别或漏识别 |
| 路径在 prompt 里是明文，便于日志、排查、后续若做「按路径搜索/归档」可复用 | OpenClaw 需实现「上传 → 得到路径 → 填占位」 |
| 同一张图可被多次引用（同一路径），不重复解码 | 占位路径需 agent 可访问（如 COS 挂载到本机、或 OpenClaw 落盘在共享目录） |

**结论**：利大于弊，Phase 4 **做路径占位**；格式采用 `[图片: <path>]`，桥识别后原样拼入 prompt。

### 4.3 落盘目录与命名

- **目录**：**单独目录存图片，不做 memory**。在 `CURSOR_WORKSPACE` 下使用**独立上传目录**，例如：
  - **默认**：`.bridge-uploads/`（隐藏目录，与笔记/memory 分离，专用于桥落盘图片）；
  - 可配置 `CURSOR_BRIDGE_UPLOAD_DIR` 覆盖（如 `uploads`、`temp/images` 等）。
- **命名**：`<requestId>-<partIndex>.<ext>`，例如 `req-abc123-0.png`、`req-abc123-1.jpeg`。  
  - requestId 由桥在请求级别生成（现有 `id` 即可）；partIndex 为该 message 内第几个图片 part；ext 从 data URL 的 MIME 解析（png/jpeg/webp/gif）。
- **绝对路径**：落盘后得到绝对路径（`path.resolve`），写入 prompt，避免 agent 工作目录与桥不一致导致读不到。

### 4.4 prompt 中图片的表述

- 单图示例：`用户发送了一张图片，路径为：/path/to/workspace/.bridge-uploads/req-xxx-0.png。请根据图片内容回答。\n\n用户说：这张图是什么？`
- 多图：每张图一句「用户发送了一张图片，路径为：…。」，再跟用户文字；或合并为「用户发送了 N 张图片，路径分别为：path1、path2、…。请根据图片内容回答。\n\n用户说：…」
- 与现有 `[User]\n...` 格式兼容：图片说明与用户文字一起放在同一段 `[User]` 下即可。

---

## 5. 配置与开关

| 配置项 | 含义 | 默认 | 说明 |
|--------|------|------|------|
| `CURSOR_BRIDGE_MULTIMODAL_IMAGES` | 是否开启图片落盘与路径注入 | `0` / 未设 | 设为 `1` 或 `true` 时，才解析 `image_url`、落盘并写路径入 prompt；关闭时保持当前行为（仅文本） |
| `CURSOR_BRIDGE_UPLOAD_DIR` | 落盘目录（相对 CURSOR_WORKSPACE） | `.bridge-uploads` | 单独目录存图片，与 memory 分离；需确保目录存在或桥启动时创建 |
| `CURSOR_BRIDGE_UPLOAD_MAX_SIZE_BYTES` | 单张图片最大字节数 | 如 10 * 1024 * 1024（10MB） | 防止过大 base64 导致内存/磁盘占用；超限可拒绝或跳过该 part 并打日志 |
| `CURSOR_BRIDGE_UPLOAD_MAX_FILES_PER_REQUEST` | 单请求最多处理图片数 | 如 5 | 超过则只处理前 N 张，其余忽略或打 warn |

**清理策略**（做）：

- 上传文件本质上会由上游传到 COS、并被 memory 等记录，**桥侧落盘只是临时供 agent 读图**，清理是安全的。
- 采用**定时任务**：例如**每天晚间**（可配置具体小时）清理上传目录下**超过 N 小时**的文件（如 24h），避免磁盘堆积。
- 配置建议：`CURSOR_BRIDGE_UPLOAD_CLEANUP_CRON` 或「清理间隔小时数 + 每日执行时间」；实现可为桥内 setInterval/定时脚本，或依赖系统 cron 调用桥提供的清理接口。

---

## 6. 实现要点（桥侧）

### 6.1 模块职责

- **图片解析与落盘**：建议独立成**预处理步骤**或**小模块**（如 `src/multimodal-images.js`），输入为 `messages` 和 `requestId`，输出为「改写后的 messages」或「供 buildPrompt 使用的、已把 image_url 替换为路径说明的 content 序列」。  
  - 这样 `prompt-builder.js` 仍只关心「从 content 抽文本」，而「content 中图片 → 路径说明」在进入 buildPrompt 前完成。
- **与 buildPrompt 的衔接**：  
  - **方案 A**：预处理阶段把每条 message 的 content 中 `image_url` 部分替换为 `{ type: "text", text: "用户发送了一张图片，路径为：<path>。请根据图片内容回答。" }`，再交给现有 `buildPrompt`（其 `getTextFromContent` 会抽这段 text）。  
  - **方案 B**：预处理阶段直接产出「已展开的」message 列表（每条 message 的 content 已是纯文本 + 图片路径句子的拼接），再 `buildPrompt`。  
  - 推荐 **方案 A**：复用现有 getTextFromContent，改动最小；仅新增「预处理 messages → 替换 image_url 为 path 文本」的一层。

### 6.2 预处理流程（伪代码）

```
function processMessagesForMultimodal(messages, requestId, options) {
  if (!options.multimodalImagesEnabled) return messages;
  const out = [];
  for (const msg of messages) {
    const content = msg.content;
    if (typeof content === 'string') {
      // 路径占位：整条为 "[图片: path]" 时原样保留
      out.push(msg);
      continue;
    }
    if (!Array.isArray(content)) { out.push(msg); continue; }
    const newParts = [];
    for (let i = 0; i < content.length; i++) {
      const part = content[i];
      if (part?.type === 'image_url' && part?.image_url?.url) {
        const path = decodeDataUrlAndSave(part.image_url.url, requestId, i, options);
        if (!path) throw new Error('图片解码或落盘失败'); // 失败即报错，不跳过
        newParts.push({ type: 'text', text: `用户发送了一张图片，路径为：${path}。请根据图片内容回答。` });
      } else if (part?.type === 'text' || part?.type === 'input_text' || part?.content != null) {
        const text = String(part.text ?? part.content ?? '');
        // 路径占位 "[图片: ...]" 原样保留
        newParts.push(part);
      }
    }
    out.push({ ...msg, content: newParts.length ? newParts : content });
  }
  return out;
}
```

- `decodeDataUrlAndSave`：解析 `data:image/xxx;base64,<data>`，校验 MIME 与大小，写文件到 `CURSOR_WORKSPACE/<UPLOAD_DIR>/<requestId>-<i>.<ext>`，返回绝对路径；**失败则 throw 或返回 null 并由上层报 400/500**，不静默跳过。

### 6.3 调用位置

- 在 **server.js** 中，在调用 `buildPrompt(messages)` 之前，先执行：
  - `messages = processMessagesForMultimodal(messages, id, { multimodalImagesEnabled, uploadDir, maxSize, maxFiles })`；
  - 再 `buildPrompt(messages)`。
- 流式与非流式共用的都是同一套 `messages` → `prompt` 的路径，因此**只需在一处**（拼 prompt 前）做预处理即可。

### 6.4 错误与边界（失败即报错）

- **base64 解码失败**：打 error，**整请求报错**（如 400 Bad Request），返回明确错误信息，不静默跳过。
- **落盘失败**（权限、磁盘满等）：打 error，**整请求报错**（如 500 Internal Server Error），不继续用「无图」方式处理。
- **单请求图片过多**：超过 `UPLOAD_MAX_FILES_PER_REQUEST` 时返回 400，提示超过单次图片数量限制。
- **单张过大**：超过 `UPLOAD_MAX_SIZE_BYTES` 时返回 400，提示单张图片过大。

---

## 7. 与 OpenClaw 的约定（对接清单）

- 请求体：`POST /v1/chat/completions`，`messages` 中任一条的 `content` 可为数组，且可包含：
  - `{ type: "text", text: "…" }`
  - `{ type: "image_url", image_url: { url: "data:image/...;base64,..." } }`
- 顺序：按用户看到的顺序排列（如先文字后图、先图后文字）。
- 若 OpenClaw 采用「先落盘再传路径」：使用路径占位格式 `[图片: <path>]`，桥识别后原样拼入 prompt，不重复落盘。

**接口范围**：Phase 4 只做 **`POST /v1/chat/completions`**；`/v1/responses` 的 input 结构不同（如 `input_image`），后续若有需要再单独支持。

---

## 8. 输出端（生成侧）说明

**Cursor Agent 返回的是什么？我们能拿到吗？**

- **当前能力**：cursor-agent 的 stdout 输出是**文本**——流式下为 NDJSON（`type: assistant` / `type: result`），非流式下为聚合后的 `result` 字段。桥已完整解析并返回给 OpenClaw，即 **agent 的文本回复我们都能拿到**（`choices[0].message.content` 或 SSE 的 content delta）。
- **agent 能否「生成图片」并返回？** 当前 Cursor CLI / 桥的协议是**文本输入、文本输出**；没有「模型输出图片 URL 或 base64」的约定。若未来 Cursor 支持 agent 返回图片（如工具调用写文件后返回路径），需在桥侧扩展「从 result/工具结果中解析图片并回传给 OpenClaw」；**本阶段 Phase 4 不包含输出侧多模态**，只做输入侧「图片 → 落盘 → 路径进 prompt」。

---

## 9. 任务清单（实现顺序建议）

| 序号 | 任务 | 说明 |
|------|------|------|
| 1 | 配置与开关 | 读 `CURSOR_BRIDGE_MULTIMODAL_IMAGES`、`CURSOR_BRIDGE_UPLOAD_DIR`、大小/数量限制；默认关闭 |
| 2 | data URL 解析与落盘 | 实现 `decodeDataUrlAndSave`：MIME 解析、base64 解码、扩展名、写文件、返回绝对路径；创建上传目录 |
| 3 | 预处理 messages | 实现 `processMessagesForMultimodal`：遍历 content，替换 `image_url` 为路径说明文本 |
| 4 | 接入 server.js | 在 `buildPrompt(messages)` 前调用预处理；传入 requestId 与配置 |
| 5 | 单测 | prompt-builder 或新模块：含仅文本、仅图、图+文、多图、超限、非法 data URL 等用例 |
| 6 | 文档与 .env.example | 更新 NOTES.md §5.6、DESIGN.md §10.5；.env.example 中多模态相关配置说明 |
| 7 | 路径占位识别 | 识别 content 中 `[图片: <path>]` 格式，原样拼入 prompt，不落盘 |
| 8 | 清理策略（定时任务） | 每日晚间清理上传目录下超过 N 小时（如 24h）的文件；可配置执行时间与保留时长 |

---

## 10. 已拍板决策（小结）

| 项 | 决策 |
|----|------|
| 落盘目录 | 单独目录，默认 `.bridge-uploads`，与 memory 分离 |
| 路径占位 | 做；格式 `[图片: <path>]`，利大于弊（可搜索/复用、桥不重复存） |
| 失败策略 | 落盘或解码失败 → 报错（400/500），不静默跳过 |
| 接口范围 | 先只做 `/v1/chat/completions`，不做 `/v1/responses` |
| 清理策略 | 做；定时任务每日晚间清理上传目录中过期文件（上传已到 COS/memory，清理安全） |
| 输出端 | Agent 返回文本，我们都能拿到；输出侧「生成图片」本阶段不做 |

---

*文档版本：v1.1 | Phase 4 多模态设计 | 已纳入落盘目录、路径占位、失败策略、清理策略、输出端说明*
