/**
 * Cursor Bridge HTTP 服务：OpenAI 兼容的 /v1/chat/completions + /health
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 从 req.url 取出 pathname（去掉 query），兼容带 ? 的请求 */
function pathname(req) {
  const u = req.url || '/';
  const i = u.indexOf('?');
  return i >= 0 ? u.slice(0, i) : u;
}
import { buildPrompt } from './prompt-builder.js';
import { runAgent, runAgentStream, resolveExecutable } from './agent-runner.js';
import { createStreamParser } from './stream-parser.js';
import { resolveWorkspace } from './memory-resolver.js';
import { readMemoryContext } from './memory-reader.js';
import { appendDailyNote } from './daily-writer.js';
import { getMultimodalOptions, processMessagesForMultimodal, cleanupUploadsDir, MultimodalError } from './multimodal-images.js';

import dotenv from 'dotenv';
if (process.env.NODE_ENV !== 'test') {
  const projectRoot = path.join(__dirname, '..');
  dotenv.config({ path: path.join(projectRoot, '.env') });
}

const BRIDGE_HOST = process.env.BRIDGE_HOST || '127.0.0.1';
const BRIDGE_PORT = Number(process.env.BRIDGE_PORT) || 3847;
const BRIDGE_API_KEY = process.env.BRIDGE_API_KEY || '';
const CURSOR_AGENT_BIN = resolveExecutable(process.env.CURSOR_AGENT_BIN || 'cursor-agent');
const CURSOR_AGENT_SCRIPT = process.env.CURSOR_AGENT_SCRIPT || '';
const CURSOR_WORKSPACE = process.env.CURSOR_WORKSPACE || process.cwd();
const CURSOR_AGENT_TIMEOUT_MS = Number(process.env.CURSOR_AGENT_TIMEOUT_MS) || 180000;
const CURSOR_AGENT_MODEL = process.env.CURSOR_AGENT_MODEL || '';
const CURSOR_AGENT_EXTRA_ARGS = process.env.CURSOR_AGENT_EXTRA_ARGS || '--trust';
const CURSOR_MAX_MESSAGES = Math.max(0, parseInt(process.env.CURSOR_MAX_MESSAGES || '0', 10));
const CURSOR_SINGLE_TURN = /^(1|true|yes)$/i.test(process.env.CURSOR_SINGLE_TURN || '');
const CURSOR_DEBUG_PROMPT = /^(1|true|yes)$/i.test(process.env.CURSOR_DEBUG_PROMPT || '');
/** 为 true 时：客户端即使请求 stream: true 也走非流式，便于排查无回复问题并拿到 stdout 调试文件 */
const CURSOR_FORCE_NON_STREAM = /^(1|true|yes)$/i.test(process.env.CURSOR_FORCE_NON_STREAM || '');
/** 为 1/true 时：打印请求/响应及 runAgent 等调试日志；默认不打印，减少开销 */
const BRIDGE_DEBUG = /^(1|true|yes)$/i.test(process.env.CURSOR_BRIDGE_DEBUG || '');

/** Phase 3 Memory：总开关。未设或 0 时关闭整个 Memory 功能（注入、写回、agent workspace 分发） */
const CURSOR_BRIDGE_MEMORY_ENABLED = /^(1|true|yes)$/i.test(process.env.CURSOR_BRIDGE_MEMORY_ENABLED || '');
const CURSOR_BRIDGE_MEMORY_SINGLE_TURN = /^(1|true|yes)$/i.test(process.env.CURSOR_BRIDGE_MEMORY_SINGLE_TURN || '');
const CURSOR_BRIDGE_UPDATE_DAILY = /^(1|true|yes)$/i.test(process.env.CURSOR_BRIDGE_UPDATE_DAILY || '');
// 字符限额：默认 0 = 不限额；仅当显式配置为正数时才截断（便于后续分析或控 token 时再设）
const CURSOR_BRIDGE_MEMORY_NEAR_MAX_ROOT = Math.max(0, parseInt(process.env.CURSOR_BRIDGE_MEMORY_NEAR_MAX_ROOT || '0', 10));
const CURSOR_BRIDGE_MEMORY_NEAR_MAX_DAILY_TODAY = Math.max(0, parseInt(process.env.CURSOR_BRIDGE_MEMORY_NEAR_MAX_DAILY_TODAY || '0', 10));
const CURSOR_BRIDGE_MEMORY_NEAR_MAX_DAILY_YESTERDAY = Math.max(0, parseInt(process.env.CURSOR_BRIDGE_MEMORY_NEAR_MAX_DAILY_YESTERDAY || '0', 10));
const CURSOR_BRIDGE_MEMORY_NEAR_MAX_AGENT = Math.max(0, parseInt(process.env.CURSOR_BRIDGE_MEMORY_NEAR_MAX_AGENT || '0', 10));
const CURSOR_BRIDGE_MEMORY_FAR_DAYS = Math.max(0, parseInt(process.env.CURSOR_BRIDGE_MEMORY_FAR_DAYS || '0', 10));
const CURSOR_BRIDGE_MEMORY_FAR_MAX_PER_DAY = Math.max(0, parseInt(process.env.CURSOR_BRIDGE_MEMORY_FAR_MAX_PER_DAY || '0', 10));
const CURSOR_BRIDGE_MEMORY_OTHER_AGENTS = /^(1|true|yes)$/i.test(process.env.CURSOR_BRIDGE_MEMORY_OTHER_AGENTS || '');
const CURSOR_BRIDGE_MEMORY_OTHER_MAX_PER_AGENT = Math.max(0, parseInt(process.env.CURSOR_BRIDGE_MEMORY_OTHER_MAX_PER_AGENT || '0', 10));
const CURSOR_BRIDGE_DAILY_WRITE_THROTTLE_MIN = Math.max(0, parseInt(process.env.CURSOR_BRIDGE_DAILY_WRITE_THROTTLE_MIN || '5', 10));

const MODEL_ID = 'cursor-agent';
const DEBUG_PROMPT_FILE = path.join(__dirname, '..', '.cursor-bridge-last-prompt.txt');
const VERSION = '1.0.0';

/** 当前进程生效的配置（用于启动日志与 GET /config），敏感项脱敏 */
function getEffectiveConfig() {
  const projectRoot = path.join(__dirname, '..');
  const envPath = path.join(projectRoot, '.env');
  let envLoaded = false;
  try {
    envLoaded = fs.existsSync(envPath);
  } catch (_) {}
  return {
    envFile: envPath,
    envFileExists: envLoaded,
    cwd: process.cwd(),
    BRIDGE_HOST,
    BRIDGE_PORT,
    BRIDGE_API_KEY: BRIDGE_API_KEY ? '(set)' : '(empty)',
    CURSOR_AGENT_BIN,
    CURSOR_WORKSPACE,
    CURSOR_AGENT_TIMEOUT_MS,
    CURSOR_AGENT_MODEL: CURSOR_AGENT_MODEL || '(empty)',
    CURSOR_AGENT_EXTRA_ARGS: (CURSOR_AGENT_EXTRA_ARGS || '').slice(0, 80),
    CURSOR_MAX_MESSAGES,
    CURSOR_SINGLE_TURN,
    CURSOR_FORCE_NON_STREAM,
    CURSOR_BRIDGE_DEBUG: BRIDGE_DEBUG,
    CURSOR_BRIDGE_MEMORY_ENABLED: CURSOR_BRIDGE_MEMORY_ENABLED,
    CURSOR_BRIDGE_UPDATE_DAILY: CURSOR_BRIDGE_UPDATE_DAILY,
  };
}

/** 从 messages 中取最后一条 user 的 content 纯文本（供 daily 写回用） */
function getLastUserContent(messages) {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if ((m?.role || '').toLowerCase() === 'user') {
      const c = m.content;
      if (typeof c === 'string') return c;
      if (c == null) return '';
      if (Array.isArray(c)) {
        return c.map((p) => (p && (p.text != null ? String(p.text) : p.content != null ? String(p.content) : '')) || '').join('');
      }
      if (typeof c === 'object') return String(c.text ?? c.content ?? '');
      return String(c);
    }
  }
  return '';
}

/** 将 memory 块拼到第一条 system 前；无 system 则插入一条 system */
function prependMemoryToSystem(messages, memoryBlock) {
  if (!memoryBlock || !Array.isArray(messages) || messages.length === 0) return messages;
  const out = [...messages];
  const firstSystemIdx = out.findIndex((m) => (m?.role || '').toLowerCase() === 'system');
  const prefix = memoryBlock.trim() + '\n\n';
  if (firstSystemIdx >= 0) {
    const orig = out[firstSystemIdx];
    const origContent = typeof orig.content === 'string' ? orig.content : (orig.content && typeof orig.content === 'object' && !Array.isArray(orig.content) ? String(orig.content?.text ?? orig.content?.content ?? '') : '');
    out[firstSystemIdx] = { ...orig, content: prefix + origContent };
  } else {
    out.unshift({ role: 'system', content: memoryBlock.trim() });
  }
  return out;
}

/** Memory 单轮：仅保留 1 条 system + 1 条当前 user */
function toSingleTurnMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return messages;
  const firstSystem = messages.find((m) => (m?.role || '').toLowerCase() === 'system');
  const lastUser = [...messages].reverse().find((m) => (m?.role || '').toLowerCase() === 'user');
  return [firstSystem, lastUser].filter(Boolean);
}

/** 非流式 completions 串行化：同一时间只跑一个 runAgent，避免多实例冲突与 502 刷屏 */
let _completionsTail = Promise.resolve();

function sendJson(res, status, body) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.statusCode = status;
  res.end(JSON.stringify(body));
}

function sendError(res, status, message, code = 'bridge_error') {
  sendJson(res, status, {
    error: {
      message,
      type: status >= 500 ? 'server_error' : 'invalid_request',
      code,
    },
  });
}

function checkAuth(req) {
  if (!BRIDGE_API_KEY) return true;
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return false;
  return auth.slice(7) === BRIDGE_API_KEY;
}

/** 当 CURSOR_DEBUG_PROMPT=1 时：把发给 cursor-agent 的完整 prompt 写入文件，并在控制台打印长度与头尾预览 */
function debugDumpPrompt(prompt, label) {
  if (process.env.NODE_ENV === 'test' || !CURSOR_DEBUG_PROMPT || !prompt) return;
  const len = prompt.length;
  const approxTokens = Math.ceil(len / 2.5);
  const header = `--- cursor-bridge 输入 cursor-agent 的 prompt (${label}) ${new Date().toISOString()} ---\n长度: ${len} 字符（约 ${approxTokens} token，按 2.5 字/token 粗估）\n--- BEGIN PROMPT ---\n`;
  const footer = '\n--- END PROMPT ---\n';
  try {
    fs.writeFileSync(DEBUG_PROMPT_FILE, header + prompt + footer, 'utf8');
  } catch (e) {
    console.warn('[bridge] 写入 debug prompt 文件失败:', e.message);
  }
  const head = prompt.slice(0, 600);
  const tail = prompt.slice(-400);
  const mid = len > 1000 ? ' ... [中间省略] ... ' : '';
  console.log('[bridge] 输入 cursor-agent 的 prompt 已写入 %s，长度 %d 字符（约 %d token）', DEBUG_PROMPT_FILE, len, approxTokens);
  console.log('[bridge] prompt 头尾预览:\n%s%s%s', head, mid, tail);
}

/** 健康检查：cursor-agent 是否可用且已登录 */
function checkCursorAgent() {
  if (process.env.NODE_ENV === 'test') return Promise.resolve({ ok: true });
  return new Promise((resolve) => {
    const proc = spawn(CURSOR_AGENT_BIN, ['about'], {
      shell: false,
      env: { ...process.env, PATH: process.env.PATH || '' },
    });
    let stdout = '';
    let stderr = '';
    const t = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch (_) {}
      resolve({ ok: false, reason: 'timeout' });
    }, 8000);

    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (c) => { stdout += c; });
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (c) => { stderr += c; });

    proc.on('error', (err) => {
      clearTimeout(t);
      resolve({ ok: false, reason: err.code === 'ENOENT' ? 'not_found' : err.message });
    });

    proc.on('close', (code) => {
      clearTimeout(t);
      if (code !== 0) {
        const out = (stdout + stderr).toLowerCase();
        const notLoggedIn = out.includes('not logged in') || out.includes('login');
        return resolve({ ok: false, reason: notLoggedIn ? 'not_logged_in' : 'error' });
      }
      resolve({ ok: true });
    });
  });
}

const server = http.createServer(async (req, res) => {
  const p = pathname(req);
  const reqLog = `[bridge] ${req.method} ${req.url}`;
  res.once('finish', () => { if (BRIDGE_DEBUG) console.log(res._bridgeReqId ? `[bridge] [${res._bridgeReqId}] ${req.method} ${req.url} -> ${res.statusCode}` : `${reqLog} -> ${res.statusCode}`); });
  if (req.method === 'GET' && (p === '/health' || p === '/')) {
    const agent = await checkCursorAgent();
    const status = agent.ok ? 'ok' : 'degraded';
    const cursor_agent = agent.ok ? 'available' : agent.reason || 'unavailable';
    const body = { status, cursor_agent, version: VERSION };
    res.statusCode = agent.ok ? 200 : 503;
    sendJson(res, res.statusCode, body);
    return;
  }

  if (req.method === 'GET' && (p === '/config' || p === '/config/')) {
    sendJson(res, 200, getEffectiveConfig());
    return;
  }

  // OpenAI 兼容：模型列表；单模型 GET /v1/models/:id 也返回 200，避免 OpenClaw 探测时 404
  const modelPayload = {
    object: 'list',
    data: [
      {
        id: MODEL_ID,
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'cursor-bridge',
      },
    ],
  };
  if (req.method === 'GET' && (p === '/v1/models' || p.startsWith('/v1/models/'))) {
    sendJson(res, 200, modelPayload);
    return;
  }

  if (req.method === 'POST' && (p === '/v1/chat/completions' || p === '/v1/chat/completions/')) {
    if (!checkAuth(req)) {
      sendError(res, 401, 'Missing or invalid Authorization', 'unauthorized');
      return;
    }

    let body = '';
    for await (const chunk of req) {
      body += chunk.toString();
    }
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch (_) {
      sendError(res, 400, 'Invalid JSON body');
      return;
    }

    let messages = parsed.messages;
    if (!Array.isArray(messages) || messages.length === 0) {
      sendError(res, 400, 'messages is required and must be a non-empty array');
      return;
    }

    let workspace = CURSOR_WORKSPACE;
    let resolution = null;

    if (CURSOR_BRIDGE_MEMORY_ENABLED) {
      const rawAgentId = req.headers['x-agent-id'] || parsed.agent_id || parsed.agentId;
      const agentId = (typeof rawAgentId === 'string' ? rawAgentId.trim() : '') || undefined;
      resolution = resolveWorkspace(agentId, CURSOR_WORKSPACE);
      workspace = resolution.workspacePath;
      const memoryContext = readMemoryContext(resolution, {
        maxRootChars: CURSOR_BRIDGE_MEMORY_NEAR_MAX_ROOT,
        maxDailyTodayChars: CURSOR_BRIDGE_MEMORY_NEAR_MAX_DAILY_TODAY,
        maxDailyYesterdayChars: CURSOR_BRIDGE_MEMORY_NEAR_MAX_DAILY_YESTERDAY,
        maxAgentChars: CURSOR_BRIDGE_MEMORY_NEAR_MAX_AGENT,
        includeYesterday: true,
        farDays: CURSOR_BRIDGE_MEMORY_FAR_DAYS,
        farMaxPerDayChars: CURSOR_BRIDGE_MEMORY_FAR_MAX_PER_DAY,
        includeOtherAgents: CURSOR_BRIDGE_MEMORY_OTHER_AGENTS,
        otherMaxPerAgentChars: CURSOR_BRIDGE_MEMORY_OTHER_MAX_PER_AGENT,
      });
      if (memoryContext) {
        if (CURSOR_BRIDGE_MEMORY_SINGLE_TURN) {
          messages = toSingleTurnMessages(messages);
          if (messages.length === 0) {
            sendError(res, 400, 'messages is required and must be a non-empty array');
            return;
          }
          if (BRIDGE_DEBUG) console.log('[bridge] Memory 单轮模式，仅用 1 system + 1 user（原 %d 条）', parsed.messages.length);
        }
        messages = prependMemoryToSystem(messages, memoryContext);
      }
    } else {
      if (CURSOR_SINGLE_TURN) {
        const firstSystem = messages.find((m) => (m.role || '').toLowerCase() === 'system');
        const lastUser = [...messages].reverse().find((m) => (m.role || '').toLowerCase() === 'user');
        messages = [firstSystem, lastUser].filter(Boolean);
        if (messages.length === 0) {
          sendError(res, 400, 'messages is required and must be a non-empty array');
          return;
        }
        if (BRIDGE_DEBUG) console.log('[bridge] /v1/chat/completions: 单轮模式，仅用 1 条 system + 1 条当前 user（原 %d 条）', parsed.messages.length);
      } else if (CURSOR_MAX_MESSAGES > 0 && messages.length > CURSOR_MAX_MESSAGES) {
        messages = messages.slice(-CURSOR_MAX_MESSAGES);
        if (BRIDGE_DEBUG) console.log('[bridge] /v1/chat/completions: 仅使用最近 %d 条消息（原 %d 条）', CURSOR_MAX_MESSAGES, parsed.messages.length);
      }
    }

    const reqId = `bridge-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const multimodalOpts = getMultimodalOptions(workspace);
    if (multimodalOpts.multimodalImagesEnabled) {
      try {
        messages = processMessagesForMultimodal(messages, reqId, multimodalOpts);
      } catch (err) {
        if (err instanceof MultimodalError) {
          sendError(res, err.statusCode, err.message);
          return;
        }
        throw err;
      }
    }

    const lastUserContent = getLastUserContent(messages);

    let stream = Boolean(parsed.stream);
    const clientWantedStream = Boolean(parsed.stream);
    if (CURSOR_FORCE_NON_STREAM) {
      if (BRIDGE_DEBUG) console.log('[bridge] CURSOR_FORCE_NON_STREAM=1，内部走 runAgent 非流式，响应仍按客户端 stream=%s 回写', parsed.stream);
      stream = false;
    }
    const prompt = buildPrompt(messages);
    if (BRIDGE_DEBUG) {
      const last = messages[messages.length - 1];
      const lastContentType = last?.content == null ? 'null' : Array.isArray(last.content) ? 'array' : typeof last.content;
      console.log('[bridge] [%s] /v1/chat/completions request: messages=%d, lastContentType=%s, promptLen=%d', reqId, messages.length, lastContentType, prompt.length);
      debugDumpPrompt(prompt, 'completions');
    }
    if (!prompt.trim()) {
      sendError(res, 400, 'No valid message content in messages');
      return;
    }

    const id = reqId;
    const created = Math.floor(Date.now() / 1000);
    res._bridgeReqId = id; // 用于 finish 时打印，便于和 agent-runner 日志对应

    if (!stream) {
      const runOne = async () => {
        if (BRIDGE_DEBUG) console.log('[bridge] [%s] runAgent start (非流式)', id);
        const result = await runAgent({
          prompt,
          workspace,
          bin: CURSOR_AGENT_BIN,
          timeoutMs: CURSOR_AGENT_TIMEOUT_MS,
          model: CURSOR_AGENT_MODEL,
          extraArgs: CURSOR_AGENT_EXTRA_ARGS,
          scriptPath: CURSOR_AGENT_SCRIPT || undefined,
        });

        if (BRIDGE_DEBUG) {
          console.log('[bridge] [%s] runAgent done, ok=%s contentLen=%s', id, result.ok, result.content != null ? String(result.content).length : 0);
          if (!result.ok) console.warn('[bridge] [%s] runAgent failed: %s', id, result.error || 'unknown');
        }

        if (!result.ok) {
          const err = result.error || 'cursor-agent failed';
          const isNotLoggedIn = err.includes('not logged in');
          const isTimeout = err.includes('timeout');
          const isModelUnavailable = /slow pool|switch to Auto|not available in the slow pool/i.test(err);
          let status = 502;
          let code = 'bridge_agent_error';
          if (isNotLoggedIn) {
            status = 503;
            code = 'bridge_agent_not_ready';
          } else if (isTimeout) {
            status = 504;
            code = 'bridge_agent_timeout';
          } else if (isModelUnavailable) {
            status = 503;
            code = 'cursor_model_unavailable';
          }
          sendError(res, status, err, code);
          return;
        }

        const content = result.content != null ? String(result.content) : '';
        if (CURSOR_BRIDGE_UPDATE_DAILY && resolution) {
          appendDailyNote(resolution.notesRoot, id, lastUserContent, content, {
            agentId: resolution.agentId,
            throttleMin: CURSOR_BRIDGE_DAILY_WRITE_THROTTLE_MIN,
          });
        }
        if (BRIDGE_DEBUG) {
          if (content.length === 0) {
            console.warn('[bridge] [%s] /v1/chat/completions 200 但 content 为空，界面会无回复。', id);
            console.warn('[bridge] [%s] 若上方有 [agent-runner] 完整 stdout 已写入 … 则请打开该路径查看 cursor-agent 原始输出；若无该行，可能是本次请求超时/失败后重试走了 fallback。', id);
          } else {
            console.log('[bridge] [%s] /v1/chat/completions 200, content length: %d %s', id, content.length, content.slice(0, 60) ? `preview: ${content.slice(0, 60)}...` : '');
          }
        }
        // 客户端请求了 stream 时用 SSE 回写一整段，否则 OpenClaw 等只渲染流式的不显示
        if (clientWantedStream) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          });
          const chunk = {
            id,
            object: 'chat.completion.chunk',
            created,
            model: MODEL_ID,
            choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: 'stop' }],
          };
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
        } else {
          sendJson(res, 200, {
            id,
            object: 'chat.completion',
            created,
            model: MODEL_ID,
            choices: [
              { index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' },
            ],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          });
        }
      };
      _completionsTail = _completionsTail.then(runOne).catch(() => {});
      await _completionsTail;
      return;
    }

    // 流式
    if (BRIDGE_DEBUG) console.log('[bridge] [%s] runAgentStream start (流式)', id);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    const { stream: agentStream, kill } = runAgentStream({
      prompt,
      workspace,
      bin: CURSOR_AGENT_BIN,
      timeoutMs: CURSOR_AGENT_TIMEOUT_MS,
      model: CURSOR_AGENT_MODEL,
      extraArgs: CURSOR_AGENT_EXTRA_ARGS,
      scriptPath: CURSOR_AGENT_SCRIPT || undefined,
    });

    const meta = { id, created, model: MODEL_ID };
    const parser = createStreamParser(meta);
    let ended = false;
    let streamChunkCount = 0; // 实际推送过的 content 块数，用于诊断「什么都不输出」
    let streamTimeoutId = null;
    parser.on('data', () => { streamChunkCount += 1; });
    const finish = () => {
      if (ended) return;
      ended = true;
      if (streamTimeoutId) clearTimeout(streamTimeoutId);
      streamTimeoutId = null;
      kill();
      if (CURSOR_BRIDGE_UPDATE_DAILY && resolution) {
        appendDailyNote(resolution.notesRoot, id, lastUserContent, '(流式回复)', {
          agentId: resolution.agentId,
          throttleMin: CURSOR_BRIDGE_DAILY_WRITE_THROTTLE_MIN,
        });
      }
      if (streamChunkCount === 0) {
        console.warn('[bridge] [%s] 流式结束但未输出任何 content，界面可能无回复。常见原因：仅 heartbeat/thinking、或 agent 未产出 result 行。', id);
      }
      try {
        res.write('data: [DONE]\n\n');
        res.end();
      } catch (_) {}
    };

    streamTimeoutId = setTimeout(() => {
      if (ended) return;
      if (BRIDGE_DEBUG) console.warn('[bridge] [%s] 流式超时（%dms），强制结束并发送 [DONE]', id, CURSOR_AGENT_TIMEOUT_MS);
      finish();
    }, CURSOR_AGENT_TIMEOUT_MS);

    agentStream.on('error', (err) => {
      try {
        res.write(`data: ${JSON.stringify({ error: { message: err.message } })}\n\n`);
      } catch (_) {}
      finish();
    });

    agentStream.on('close', (code) => {
      if (code !== 0 && code !== null && !ended) {
        try {
          res.write(`data: ${JSON.stringify({ error: { message: 'cursor-agent exited unexpectedly' } })}\n\n`);
        } catch (_) {}
      }
    });

    parser.on('end', finish);
    parser.on('error', finish);
    res.on('close', finish);
    res.on('error', finish);
    agentStream.pipe(parser);
    parser.pipe(res, { end: false });
    return;
  }

  // OpenResponses API：OpenClaw 配置 api: "openai-responses" 时会请求 POST /v1/responses
  if (req.method === 'POST' && (p === '/v1/responses' || p === '/v1/responses/')) {
    if (!checkAuth(req)) {
      sendError(res, 401, 'Missing or invalid Authorization', 'unauthorized');
      return;
    }
    let body = '';
    for await (const chunk of req) {
      body += chunk.toString();
    }
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch (_) {
      sendError(res, 400, 'Invalid JSON body');
      return;
    }
    const model = parsed.model;
    const input = parsed.input;
    const instructions = parsed.instructions;
    if (input === undefined) {
      sendError(res, 400, 'input is required');
      return;
    }
    function extractTextFromContent(content) {
      if (typeof content === 'string') return content;
      if (!content || typeof content !== 'object') return '';
      if (Array.isArray(content)) {
        let out = '';
        for (const part of content) {
          if (part && typeof part === 'object') {
            if (part.text != null) out += String(part.text);
            else if (part.content != null) out += String(part.content);
          }
        }
        return out;
      }
      if (content.text != null) return String(content.text);
      if (content.content != null) return String(content.content);
      return '';
    }
    const messages = [];
    if (instructions && typeof instructions === 'string') {
      messages.push({ role: 'system', content: instructions });
    }
    if (typeof input === 'string') {
      messages.push({ role: 'user', content: input });
    } else if (Array.isArray(input)) {
      for (const item of input) {
        const role = item?.role === 'developer' ? 'system' : item?.role;
        if (!role) continue;
        const content = extractTextFromContent(item.content);
        if (content || messages.length > 0) messages.push({ role, content });
      }
    } else if (input && typeof input === 'object') {
      if (input.type === 'message' || input.role) {
        const role = input.role === 'developer' ? 'system' : input.role;
        const content = extractTextFromContent(input.content);
        if (role) messages.push({ role, content });
      } else if (Array.isArray(input.items)) {
        for (const item of input.items) {
          const role = item?.role === 'developer' ? 'system' : item?.role;
          if (!role) continue;
          const content = extractTextFromContent(item.content);
          if (content || messages.length > 0) messages.push({ role, content });
        }
      } else if (input.content != null || input.text != null) {
        messages.push({ role: 'user', content: String(input.content ?? input.text) });
      }
    }
    if (messages.length === 0) {
      if (BRIDGE_DEBUG) {
        const preview = JSON.stringify(parsed.input ?? parsed).slice(0, 400);
        console.warn('[bridge] /v1/responses: no messages from input. input preview:', preview);
      }
      sendError(res, 400, 'No valid message content in input');
      return;
    }
    if (CURSOR_SINGLE_TURN) {
      const firstSystem = messages.find((m) => (m.role || '').toLowerCase() === 'system');
      const lastUser = [...messages].reverse().find((m) => (m.role || '').toLowerCase() === 'user');
      const single = [firstSystem, lastUser].filter(Boolean);
      if (single.length > 0) {
        messages = single;
        if (BRIDGE_DEBUG) console.log('[bridge] /v1/responses: 单轮模式，仅用 1 条 system + 1 条当前 user');
      }
    } else if (CURSOR_MAX_MESSAGES > 0 && messages.length > CURSOR_MAX_MESSAGES) {
      const origCount = messages.length;
      messages = messages.slice(-CURSOR_MAX_MESSAGES);
      if (BRIDGE_DEBUG) console.log('[bridge] /v1/responses: 仅使用最近 %d 条消息（原 %d 条）', CURSOR_MAX_MESSAGES, origCount);
    }
    const prompt = buildPrompt(messages);
    if (BRIDGE_DEBUG) debugDumpPrompt(prompt, 'responses');
    if (!prompt.trim()) {
      if (BRIDGE_DEBUG) console.warn('[bridge] /v1/responses: prompt empty after build. messages count:', messages.length);
      sendError(res, 400, 'No valid message content in input');
      return;
    }
    const id = `rsp-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const created = Math.floor(Date.now() / 1000);
    const result = await runAgent({
      prompt,
      workspace: CURSOR_WORKSPACE,
      bin: CURSOR_AGENT_BIN,
      timeoutMs: CURSOR_AGENT_TIMEOUT_MS,
      model: CURSOR_AGENT_MODEL,
      extraArgs: CURSOR_AGENT_EXTRA_ARGS,
      scriptPath: CURSOR_AGENT_SCRIPT || undefined,
    });
    if (!result.ok) {
      const status = result.error?.includes('not logged in') ? 503 : (result.error?.includes('timeout') ? 504 : 502);
      const code = result.error?.includes('not logged in') ? 'bridge_agent_not_ready' : 'bridge_agent_error';
      sendError(res, status, result.error || 'cursor-agent failed', code);
      return;
    }
    const assistantText = result.content != null ? String(result.content) : '';
    if (BRIDGE_DEBUG) console.log('[bridge] /v1/responses 200, content length:', assistantText.length, assistantText.slice(0, 80) ? `preview: ${assistantText.slice(0, 80)}...` : '(empty)');
    const responseResource = {
      id,
      object: 'response',
      created_at: created,
      status: 'completed',
      model: model || MODEL_ID,
      output: [
        {
          type: 'message',
          id: `${id}-msg-0`,
          role: 'assistant',
          content: [{ type: 'output_text', id: `${id}-msg-0-text-0`, text: assistantText }],
          status: 'completed',
        },
      ],
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    };
    sendJson(res, 200, responseResource);
    return;
  }

  res.statusCode = 404;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ error: { message: 'Not Found', type: 'invalid_request' } }));
});

if (process.env.NODE_ENV !== 'test') {
  server.listen(BRIDGE_PORT, BRIDGE_HOST, () => {
    console.log(`cursor-bridge ${VERSION} listening on http://${BRIDGE_HOST}:${BRIDGE_PORT}`);
    console.log('  GET  /health   GET  /config   GET  /v1/models   POST /v1/chat/completions   POST /v1/responses');
    const cfg = getEffectiveConfig();
    console.log('[bridge] effective config: envFileExists=%s cwd=%s CURSOR_WORKSPACE=%s CURSOR_AGENT_BIN=%s CURSOR_AGENT_TIMEOUT_MS=%s',
      cfg.envFileExists, cfg.cwd, cfg.CURSOR_WORKSPACE, cfg.CURSOR_AGENT_BIN, cfg.CURSOR_AGENT_TIMEOUT_MS);

    const cleanupHour = parseInt(process.env.CURSOR_BRIDGE_UPLOAD_CLEANUP_HOUR ?? '22', 10);
    const cleanupOlderHours = Math.max(1, parseInt(process.env.CURSOR_BRIDGE_UPLOAD_CLEANUP_OLDER_HOURS ?? '24', 10));
    if (cleanupHour >= 0 && cleanupHour <= 23) {
      let lastCleanupDay = null;
      const runCleanupIfScheduled = () => {
        const now = new Date();
        if (now.getHours() !== cleanupHour) return;
        const today = now.toDateString();
        if (lastCleanupDay === today) return;
        lastCleanupDay = today;
        const opts = getMultimodalOptions(CURSOR_WORKSPACE);
        const result = cleanupUploadsDir(opts.workspacePath, opts.uploadDir, cleanupOlderHours);
        if (result.deleted > 0 || result.errors > 0) {
          console.log('[bridge] 多模态上传目录定时清理: deleted=%d errors=%d', result.deleted, result.errors);
        }
      };
      setInterval(runCleanupIfScheduled, 60 * 60 * 1000);
      runCleanupIfScheduled();
    }
  });
}

export { server };
