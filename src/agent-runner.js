/**
 * 启动 cursor-agent 子进程，管理超时与错误，输出 stdout/stderr。
 */

import { spawn } from 'child_process';
import { Readable } from 'stream';

/**
 * 运行 cursor-agent 非流式，收集完整 stdout 后解析出 assistant 回复。
 * @param {object} opts
 * @param {string} opts.prompt
 * @param {string} opts.workspace
 * @param {string} opts.bin
 * @param {number} opts.timeoutMs
 * @param {string} [opts.model]
 * @param {string} [opts.extraArgs]
 * @returns {Promise<{ ok: boolean, content?: string, error?: string, code?: number }>}
 */
export function runAgent({ prompt, workspace, bin, timeoutMs, model, extraArgs }) {
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

    const proc = spawn(bin, args, {
      cwd: workspace,
      shell: false,
      env: { ...process.env, PATH: process.env.PATH || '' },
    });

    let stdout = '';
    let stderr = '';
    let done = false;

    const finish = (ok, content, error, code) => {
      if (done) return;
      done = true;
      try {
        proc.kill('SIGKILL');
      } catch (_) {}
      resolve({ ok, content, error, code });
    };

    const t = setTimeout(() => {
      finish(false, undefined, 'cursor-agent timeout', undefined);
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
      resolve({
        ok: true,
        content: content !== undefined ? content : stdout.trim(),
        code: 0,
      });
    });
  });
}

/**
 * 从 cursor-agent --output-format json 的 stdout 中提取最终回复文本。
 * 可能格式：单行 JSON 含 result；或 NDJSON 中 type=result 的 result 字段。
 */
function extractContentFromJson(raw) {
  const lines = raw.trim().split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(lines[i]);
      if (obj.result !== undefined) return obj.result;
      if (obj.type === 'result' && obj.result !== undefined) return obj.result;
      if (obj.message?.content) {
        const content = obj.message.content;
        if (Array.isArray(content)) {
          const text = content.map((c) => (c && c.text) || '').join('');
          if (text) return text;
        }
        if (typeof content === 'string') return content;
      }
    } catch (_) {
      // ignore parse error, try next line
    }
  }
  return undefined;
}

/**
 * 流式运行 cursor-agent，返回可读流（NDJSON 行）。
 * @param {object} opts 同 runAgent
 * @returns {{ stream: Readable, kill: () => void }}
 */
export function runAgentStream({ prompt, workspace, bin, timeoutMs, model, extraArgs }) {
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

  const proc = spawn(bin, args, {
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
