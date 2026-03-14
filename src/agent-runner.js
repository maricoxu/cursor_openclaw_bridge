/**
 * 启动 cursor-agent 子进程，管理超时与错误，输出 stdout/stderr。
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Readable } from 'stream';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEBUG_STDOUT_FILE = path.resolve(__dirname, '..', '.cursor-bridge-last-stdout.txt');

/**
 * 运行 cursor-agent 非流式，收集完整 stdout 后解析出 assistant 回复。
 * @param {object} opts
 * @param {string} opts.prompt
 * @param {string} opts.workspace
 * @param {string} opts.bin
 * @param {number} opts.timeoutMs
 * @param {string} [opts.model]
 * @param {string} [opts.extraArgs]
 * @param {string} [opts.scriptPath] 当 bin 为 node 时，可指定脚本路径作为第一个参数（用于测试 fake-agent）
 * @returns {Promise<{ ok: boolean, content?: string, error?: string, code?: number }>}
 */
export function runAgent({ prompt, workspace, bin, timeoutMs, model, extraArgs, scriptPath }) {
  return new Promise((resolve) => {
    const args = [
      prompt,
      '--print',
      '--trust',
      '--output-format',
      'json',
      '--workspace',
      workspace,
    ];
    if (model && model.trim()) args.push('--model', model.trim());
    if (extraArgs && extraArgs.trim()) {
      args.push(...extraArgs.trim().split(/\s+/));
    }
    const finalArgs = scriptPath ? [scriptPath, ...args] : args;

    const proc = spawn(bin, finalArgs, {
      cwd: workspace,
      shell: false,
      env: { ...process.env, PATH: process.env.PATH || '' },
    });

    let stdout = '';
    let stderr = '';
    let done = false;

    const writeStdoutFile = (reason, out) => {
      if (process.env.NODE_ENV === 'test' || !out || !out.trim()) return;
      try {
        const header = `--- cursor-agent stdout（${reason}） ${new Date().toISOString()} ---\n--- BEGIN STDOUT ---\n`;
        fs.writeFileSync(DEBUG_STDOUT_FILE, header + out + '\n--- END STDOUT ---\n', 'utf8');
        console.warn('[agent-runner] 完整 stdout 已写入:', DEBUG_STDOUT_FILE);
      } catch (e) {
        console.warn('[agent-runner] 写入 stdout 文件失败:', e.message, '路径:', DEBUG_STDOUT_FILE);
      }
    };

    const finish = (ok, content, error, code, outForFile) => {
      if (done) return;
      done = true;
      try {
        proc.kill('SIGKILL');
      } catch (_) {}
      if (!ok && outForFile && outForFile.trim()) {
        writeStdoutFile('超时或异常退出', outForFile);
      }
      resolve({ ok, content, error, code });
    };

    const t = setTimeout(() => {
      if (process.env.NODE_ENV !== 'test') {
        console.warn('[agent-runner] cursor-agent timeout, stdoutLen=%d, stderrLen=%d', (stdout && stdout.length) || 0, (stderr && stderr.length) || 0);
      }
      const timeoutErr = stderr.trim()
        ? `cursor-agent timeout. stderr: ${stderr.trim().slice(0, 500)}`
        : 'cursor-agent timeout';
      finish(false, undefined, timeoutErr, undefined, stdout);
    }, timeoutMs);

    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      stdout += chunk;
    });

    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    proc.on('error', (err) => {
      if (err.code === 'ENOENT') {
        finish(false, undefined, 'cursor-agent not found in PATH', undefined);
      } else {
        finish(false, undefined, err.message || String(err), undefined);
      }
    });

    proc.on('close', (code, signal) => {
      clearTimeout(t);
      if (done) return;
      done = true;

      const errLower = stderr.toLowerCase();
      if (code !== 0) {
        if (process.env.NODE_ENV !== 'test') {
          console.warn('[agent-runner] cursor-agent exit code %s', code, stderr.trim() ? `stderr: ${stderr.trim().slice(0, 200)}` : '');
        }
        if (stdout.trim()) writeStdoutFile(`exit code ${code}`, stdout);
        if (errLower.includes('not logged in') || errLower.includes('login')) {
          return resolve({
            ok: false,
            error: 'cursor-agent is not logged in. Please run: cursor-agent login',
            code,
          });
        }
        return resolve({
          ok: false,
          error: stderr.trim() || `cursor-agent exited with code ${code}`,
          code,
        });
      }

      const content = extractContentFromJson(stdout);
      const final = content !== undefined ? content : stdout.trim();
      if (process.env.NODE_ENV !== 'test' && (final === '' || (content === undefined && stdout.length > 0))) {
        const lineCount = stdout.trim().split('\n').filter(Boolean).length;
        console.warn('[agent-runner] 未从 stdout 解析出 result，stdout 行数:', lineCount, '末行预览:', stdout.trim().slice(-300));
        writeStdoutFile('content 为空', stdout);
      }
      if (process.env.NODE_ENV !== 'test') {
        console.log('[agent-runner] cursor-agent exit 0, contentLen=%d', final.length);
      }
      resolve({
        ok: true,
        content: final,
        code: 0,
      });
    });
  });
}

/** 从单行 JSON 的 message.content 里抽出纯文本 */
function textFromMessageContent(content) {
  if (typeof content === 'string') return content;
  if (!content || !Array.isArray(content)) return '';
  return content.map((c) => (c && (c.text != null ? String(c.text) : c.content != null ? String(c.content) : '')) || '').join('');
}

/**
 * 从 cursor-agent --output-format json 的 stdout 中提取最终回复文本。
 * 优先：单行或末行的 type=result / result 字段。
 * 若无 result（例如只调了工具、未产出 result 行）：收集所有 type=assistant 的 message.content 拼成一段，避免工具调用后无回复。
 */
function extractContentFromJson(raw) {
  const lines = raw.trim().split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(lines[i]);
      if (obj.result !== undefined && obj.result !== '') return obj.result;
      if (obj.type === 'result' && obj.result !== undefined && obj.result !== '') return obj.result;
    } catch (_) {}
  }
  const assistantParts = [];
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (!obj.message?.content) continue;
      if (obj.type === 'assistant' || obj.type === 'result' || obj.type === 'message') {
        const text = textFromMessageContent(obj.message.content);
        if (text.trim()) assistantParts.push(text);
      }
    } catch (_) {}
  }
  if (assistantParts.length > 0) return assistantParts.join('\n\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(lines[i]);
      const top = obj.output ?? obj.content ?? obj.text;
      if (typeof top === 'string' && top.trim()) return top.trim();
      if (top && typeof top === 'object' && !Array.isArray(top) && (top.text != null || top.content != null)) {
        const s = String(top.text ?? top.content ?? '').trim();
        if (s) return s;
      }
    } catch (_) {}
  }
  return undefined;
}

/**
 * 流式运行 cursor-agent，返回可读流（NDJSON 行）。
 * @param {object} opts 同 runAgent（含 scriptPath）
 * @returns {{ stream: Readable, kill: () => void }}
 */
export function runAgentStream({ prompt, workspace, bin, timeoutMs, model, extraArgs, scriptPath }) {
  const args = [
    prompt,
    '--print',
    '--trust',
    '--output-format',
    'stream-json',
    '--stream-partial-output',
    '--workspace',
    workspace,
  ];
  if (model && model.trim()) args.push('--model', model.trim());
  if (extraArgs && extraArgs.trim()) {
    args.push(...extraArgs.trim().split(/\s+/));
  }
  const finalArgs = scriptPath ? [scriptPath, ...args] : args;

  const proc = spawn(bin, finalArgs, {
    cwd: workspace,
    shell: false,
    env: { ...process.env, PATH: process.env.PATH || '' },
  });

  const timeout = setTimeout(() => {
    try {
      proc.kill('SIGKILL');
    } catch (_) {}
  }, timeoutMs);

  const kill = () => {
    clearTimeout(timeout);
    try {
      proc.kill('SIGKILL');
    } catch (_) {}
  };

  const stream = proc.stdout;
  stream.on('close', () => clearTimeout(timeout));
  stream.on('error', () => clearTimeout(timeout));

  return { stream, kill };
}
