/**
 * Cursor Bridge HTTP 服务：OpenAI 兼容的 /v1/chat/completions + /health
 */

import http from 'http';
import { spawn } from 'child_process';

/** 从 req.url 取出 pathname（去掉 query），兼容带 ? 的请求 */
function pathname(req) {
  const u = req.url || '/';
  const i = u.indexOf('?');
  return i >= 0 ? u.slice(0, i) : u;
}
import { buildPrompt } from './prompt-builder.js';
import { runAgent, runAgentStream } from './agent-runner.js';
import { createStreamParser } from './stream-parser.js';

import dotenv from 'dotenv';
dotenv.config();

const BRIDGE_HOST = process.env.BRIDGE_HOST || '127.0.0.1';
const BRIDGE_PORT = Number(process.env.BRIDGE_PORT) || 3847;
const BRIDGE_API_KEY = process.env.BRIDGE_API_KEY || '';
const CURSOR_AGENT_BIN = process.env.CURSOR_AGENT_BIN || 'cursor-agent';
const CURSOR_WORKSPACE = process.env.CURSOR_WORKSPACE || process.cwd();
const CURSOR_AGENT_TIMEOUT_MS = Number(process.env.CURSOR_AGENT_TIMEOUT_MS) || 180000;
const CURSOR_AGENT_MODEL = process.env.CURSOR_AGENT_MODEL || '';
const CURSOR_AGENT_EXTRA_ARGS = process.env.CURSOR_AGENT_EXTRA_ARGS || '--trust';

const MODEL_ID = 'cursor-agent';
const VERSION = '1.0.0';

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

/** 若内容为完全相同（或仅空白差异）的两段拼接（模型重复输出），只保留一段 */
function dedupeRepeatedContent(s) {
  if (typeof s !== 'string' || s.length < 2) return s;
  const half = Math.floor(s.length / 2);
  const first = s.slice(0, half);
  const second = s.slice(half);
  if (first === second) return first;
  if (first.trim() === second.trim()) return first.trimEnd().length < first.length ? first.trimEnd() : first;
  return s;
}

/** 健康检查：cursor-agent 是否可用且已登录 */
function checkCursorAgent() {
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
  res.once('finish', () => console.log(`${reqLog} -> ${res.statusCode}`));
  if (req.method === 'GET' && (p === '/health' || p === '/')) {
    const agent = await checkCursorAgent();
    const status = agent.ok ? 'ok' : 'degraded';
    const cursor_agent = agent.ok ? 'available' : agent.reason || 'unavailable';
    const body = { status, cursor_agent, version: VERSION };
    res.statusCode = agent.ok ? 200 : 503;
    sendJson(res, res.statusCode, body);
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

    const messages = parsed.messages;
    if (!Array.isArray(messages) || messages.length === 0) {
      sendError(res, 400, 'messages is required and must be a non-empty array');
      return;
    }

    const stream = Boolean(parsed.stream);
    const prompt = buildPrompt(messages);
    if (process.env.NODE_ENV !== 'test') {
      const last = messages[messages.length - 1];
      const lastContentType = last?.content == null ? 'null' : Array.isArray(last.content) ? 'array' : typeof last.content;
      console.log('[bridge] /v1/chat/completions request: messages=%d, lastContentType=%s, promptLen=%d', messages.length, lastContentType, prompt.length);
    }
    if (!prompt.trim()) {
      sendError(res, 400, 'No valid message content in messages');
      return;
    }

    const id = `bridge-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const created = Math.floor(Date.now() / 1000);

    if (!stream) {
      const result = await runAgent({
        prompt,
        workspace: CURSOR_WORKSPACE,
        bin: CURSOR_AGENT_BIN,
        timeoutMs: CURSOR_AGENT_TIMEOUT_MS,
        model: CURSOR_AGENT_MODEL,
        extraArgs: CURSOR_AGENT_EXTRA_ARGS,
      });

      if (!result.ok) {
        const status = result.error?.includes('not logged in') ? 503 : (result.error?.includes('timeout') ? 504 : 502);
        const code = result.error?.includes('not logged in') ? 'bridge_agent_not_ready' : 'bridge_agent_error';
        sendError(res, status, result.error || 'cursor-agent failed', code);
        return;
      }

      const content = dedupeRepeatedContent(result.content != null ? String(result.content) : '');
      if (process.env.NODE_ENV !== 'test') {
        if (content.length === 0) {
          console.warn('[bridge] /v1/chat/completions 200 但 content 为空，界面会无回复。可能原因：cursor-agent 未产出 result 或超时前未写完。');
        } else {
          console.log('[bridge] /v1/chat/completions 200, content length:', content.length, content.slice(0, 60) ? `preview: ${content.slice(0, 60)}...` : '');
        }
      }
      sendJson(res, 200, {
        id,
        object: 'chat.completion',
        created,
        model: MODEL_ID,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });
      return;
    }

    // 流式
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    const { stream: agentStream, kill } = runAgentStream({
      prompt,
      workspace: CURSOR_WORKSPACE,
      bin: CURSOR_AGENT_BIN,
      timeoutMs: CURSOR_AGENT_TIMEOUT_MS,
      model: CURSOR_AGENT_MODEL,
      extraArgs: CURSOR_AGENT_EXTRA_ARGS,
    });

    const meta = { id, created, model: MODEL_ID };
    const parser = createStreamParser(meta);
    let ended = false;
    const finish = () => {
      if (ended) return;
      ended = true;
      kill();
      try {
        res.write('data: [DONE]\n\n');
        res.end();
      } catch (_) {}
    };

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
      const preview = JSON.stringify(parsed.input ?? parsed).slice(0, 400);
      console.warn('[bridge] /v1/responses: no messages from input. input preview:', preview);
      sendError(res, 400, 'No valid message content in input');
      return;
    }
    const prompt = buildPrompt(messages);
    if (!prompt.trim()) {
      console.warn('[bridge] /v1/responses: prompt empty after build. messages count:', messages.length);
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
    });
    if (!result.ok) {
      const status = result.error?.includes('not logged in') ? 503 : (result.error?.includes('timeout') ? 504 : 502);
      const code = result.error?.includes('not logged in') ? 'bridge_agent_not_ready' : 'bridge_agent_error';
      sendError(res, status, result.error || 'cursor-agent failed', code);
      return;
    }
    const assistantText = dedupeRepeatedContent(result.content != null ? String(result.content) : '');
    if (process.env.NODE_ENV !== 'test') {
      console.log('[bridge] /v1/responses 200, content length:', assistantText.length, assistantText.slice(0, 80) ? `preview: ${assistantText.slice(0, 80)}...` : '(empty)');
    }
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
    console.log('  GET  /health');
    console.log('  GET  /v1/models');
    console.log('  POST /v1/chat/completions');
    console.log('  POST /v1/responses (OpenResponses)');
  });
}

export { server };
