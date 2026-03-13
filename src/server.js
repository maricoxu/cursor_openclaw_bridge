/**
 * Cursor Bridge HTTP 服务：OpenAI 兼容的 /v1/chat/completions + /health
 */

import http from 'http';
import { spawn } from 'child_process';
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
  if (req.method === 'GET' && (req.url === '/health' || req.url === '/')) {
    const agent = await checkCursorAgent();
    const status = agent.ok ? 'ok' : 'degraded';
    const cursor_agent = agent.ok ? 'available' : agent.reason || 'unavailable';
    const body = { status, cursor_agent, version: VERSION };
    res.statusCode = agent.ok ? 200 : 503;
    sendJson(res, res.statusCode, body);
    return;
  }

  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
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

      sendJson(res, 200, {
        id,
        object: 'chat.completion',
        created,
        model: MODEL_ID,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: result.content || '' },
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

  res.statusCode = 404;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ error: { message: 'Not Found', type: 'invalid_request' } }));
});

server.listen(BRIDGE_PORT, BRIDGE_HOST, () => {
  console.log(`cursor-bridge ${VERSION} listening on http://${BRIDGE_HOST}:${BRIDGE_PORT}`);
  console.log('  GET  /health');
  console.log('  POST /v1/chat/completions');
});
