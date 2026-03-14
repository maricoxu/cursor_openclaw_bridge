#!/usr/bin/env node
/**
 * 测试用假 cursor-agent：模拟失败场景，用于 Phase 2 错误契约与 OpenClaw fallback 单测。
 * 环境变量 FAIL_MODE：
 *   - not_logged_in：stderr 写 "not logged in"，exit 1 → 桥应返回 503
 *   - timeout：不退出，由桥超时杀进程 → 桥应返回 504
 */

const FAIL_MODE = process.env.FAIL_MODE || 'not_logged_in';

if (FAIL_MODE === 'timeout') {
  setInterval(() => {}, 60000);
} else if (FAIL_MODE === 'not_logged_in') {
  process.stderr.write('not logged in. run cursor-agent login.');
  process.exit(1);
} else {
  process.exit(1);
}
