/**
 * Phase 4 多模态：multimodal-images 单测
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  getMultimodalOptions,
  decodeDataUrlAndSave,
  processMessagesForMultimodal,
  cleanupUploadsDir,
  MultimodalError,
  PLACEHOLDER_REGEX,
} from '../src/multimodal-images.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 最小合法 1x1 PNG 的 data URL（约 100 字节） */
const MINI_PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

describe('PLACEHOLDER_REGEX', () => {
  it('匹配 [图片: path] 格式', () => {
    const m = '[图片: /tmp/a.png]'.match(PLACEHOLDER_REGEX);
    assert.ok(m);
    assert.strictEqual(m[1].trim(), '/tmp/a.png');
  });
  it('匹配带空格的 path', () => {
    const m = '[图片: /path/to/file.png]'.match(PLACEHOLDER_REGEX);
    assert.ok(m);
    assert.strictEqual(m[1], '/path/to/file.png');
  });
  it('不匹配普通文字', () => {
    assert.ok(!'用户说：你好'.match(PLACEHOLDER_REGEX));
    assert.ok(!'[图片 /tmp/x.png]'.match(PLACEHOLDER_REGEX));
  });
});

describe('getMultimodalOptions', () => {
  it('默认关闭且返回合理默认值', () => {
    const prev = process.env.CURSOR_BRIDGE_MULTIMODAL_IMAGES;
    delete process.env.CURSOR_BRIDGE_MULTIMODAL_IMAGES;
    const opts = getMultimodalOptions('/tmp/ws');
    assert.strictEqual(opts.multimodalImagesEnabled, false);
    assert.ok(opts.uploadDir === '.bridge-uploads' || opts.uploadDir.length > 0);
    assert.ok(opts.maxSizeBytes >= 0);
    assert.ok(opts.maxFilesPerRequest >= 1);
    assert.strictEqual(opts.workspacePath, path.resolve('/tmp/ws'));
    if (prev !== undefined) process.env.CURSOR_BRIDGE_MULTIMODAL_IMAGES = prev;
  });
  it('MULTIMODAL_IMAGES=1 时开启', () => {
    const prev = process.env.CURSOR_BRIDGE_MULTIMODAL_IMAGES;
    process.env.CURSOR_BRIDGE_MULTIMODAL_IMAGES = '1';
    const opts = getMultimodalOptions('/tmp');
    assert.strictEqual(opts.multimodalImagesEnabled, true);
    if (prev !== undefined) process.env.CURSOR_BRIDGE_MULTIMODAL_IMAGES = prev;
    else delete process.env.CURSOR_BRIDGE_MULTIMODAL_IMAGES;
  });
});

describe('decodeDataUrlAndSave', () => {
  const testDir = path.join(__dirname, 'fixtures', 'multimodal-upload');
  const options = {
    workspacePath: path.join(__dirname, '..'),
    uploadDir: '.bridge-uploads',
    maxSizeBytes: 10 * 1024 * 1024,
  };

  it('合法 data URL 落盘并返回绝对路径', () => {
    const requestId = 'test-req-' + Date.now();
    const absolutePath = decodeDataUrlAndSave(MINI_PNG_DATA_URL, requestId, 0, options);
    assert.ok(path.isAbsolute(absolutePath));
    assert.ok(absolutePath.endsWith('.png'));
    assert.ok(fs.existsSync(absolutePath));
    const stat = fs.statSync(absolutePath);
    assert.ok(stat.size > 0 && stat.size < 500);
    try {
      fs.unlinkSync(absolutePath);
    } catch (_) {}
  });

  it('无效 data URL 抛出 400', () => {
    assert.throws(
      () => decodeDataUrlAndSave('not-a-data-url', 'req', 0, options),
      (err) => err instanceof MultimodalError && err.statusCode === 400
    );
  });

  it('空 base64 或解码后无有效数据视为失败', () => {
    assert.throws(
      () => decodeDataUrlAndSave('data:image/png;base64,', 'req', 0, options),
      (err) => err instanceof MultimodalError && err.statusCode === 400
    );
  });

  it('不支持的 MIME 抛出 400', () => {
    assert.throws(
      () => decodeDataUrlAndSave('data:image/bmp;base64,Qk0=', 'req', 0, options),
      (err) => err instanceof MultimodalError && err.statusCode === 400
    );
  });

  it('超过 maxSizeBytes 抛出 400', () => {
    const tinyOpts = { ...options, maxSizeBytes: 10 };
    assert.throws(
      () => decodeDataUrlAndSave(MINI_PNG_DATA_URL, 'req', 0, tinyOpts),
      (err) => err instanceof MultimodalError && err.statusCode === 400
    );
  });
});

describe('processMessagesForMultimodal', () => {
  const workspacePath = path.join(__dirname, '..');
  const options = {
    multimodalImagesEnabled: true,
    workspacePath,
    uploadDir: '.bridge-uploads',
    maxSizeBytes: 10 * 1024 * 1024,
    maxFilesPerRequest: 5,
  };

  it('未开启时原样返回 messages', () => {
    const messages = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }];
    const out = processMessagesForMultimodal(messages, 'id', { ...options, multimodalImagesEnabled: false });
    assert.strictEqual(out, messages);
  });

  it('纯文本 content 不变', () => {
    const messages = [{ role: 'user', content: [{ type: 'text', text: '你好' }] }];
    const out = processMessagesForMultimodal(messages, 'id', options);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].content[0].type, 'text');
    assert.strictEqual(out[0].content[0].text, '你好');
  });

  it('image_url 被替换为路径说明文本并落盘', () => {
    const requestId = 'test-pm-' + Date.now();
    const messages = [
      { role: 'user', content: [{ type: 'image_url', image_url: { url: MINI_PNG_DATA_URL } }] },
    ];
    const out = processMessagesForMultimodal(messages, requestId, options);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].content.length, 1);
    assert.strictEqual(out[0].content[0].type, 'text');
    assert.ok(out[0].content[0].text.includes('用户发送了一张图片，路径为：'));
    assert.ok(out[0].content[0].text.includes('.png'));
    const pathMatch = out[0].content[0].text.match(/路径为：(.+?)。请/);
    assert.ok(pathMatch, '应包含路径为：...。请');
    assert.ok(fs.existsSync(pathMatch[1]), '落盘文件应存在');
    try {
      fs.unlinkSync(pathMatch[1]);
    } catch (_) {}
  });

  it('文字 + 图片 顺序保留', () => {
    const requestId = 'test-txt-img-' + Date.now();
    const messages = [
      {
        role: 'user',
        content: [
          { type: 'text', text: '看看这张图' },
          { type: 'image_url', image_url: { url: MINI_PNG_DATA_URL } },
        ],
      },
    ];
    const out = processMessagesForMultimodal(messages, requestId, options);
    assert.strictEqual(out[0].content.length, 2);
    assert.strictEqual(out[0].content[0].text, '看看这张图');
    assert.ok(out[0].content[1].text.includes('用户发送了一张图片，路径为：'));
    const pathMatch = out[0].content[1].text.match(/路径为：(.+?)。请/);
    if (pathMatch) {
      try {
        fs.unlinkSync(pathMatch[1]);
      } catch (_) {}
    }
  });

  it('路径占位 [图片: path] 在 text part 中保留', () => {
    const messages = [
      { role: 'user', content: [{ type: 'text', text: '[图片: /tmp/from-openclaw.png]' }] },
    ];
    const out = processMessagesForMultimodal(messages, 'id', options);
    assert.strictEqual(out[0].content[0].text, '[图片: /tmp/from-openclaw.png]');
  });

  it('超过 maxFilesPerRequest 抛出 400', () => {
    const requestId = 'test-max-' + Date.now();
    const messages = [
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: MINI_PNG_DATA_URL } },
          { type: 'image_url', image_url: { url: MINI_PNG_DATA_URL } },
          { type: 'image_url', image_url: { url: MINI_PNG_DATA_URL } },
          { type: 'image_url', image_url: { url: MINI_PNG_DATA_URL } },
          { type: 'image_url', image_url: { url: MINI_PNG_DATA_URL } },
          { type: 'image_url', image_url: { url: MINI_PNG_DATA_URL } },
        ],
      },
    ];
    const limitedOpts = { ...options, maxFilesPerRequest: 5 };
    assert.throws(
      () => processMessagesForMultimodal(messages, requestId, limitedOpts),
      (err) => err instanceof MultimodalError && err.statusCode === 400
    );
    const uploadDir = path.join(workspacePath, options.uploadDir);
    const files = fs.readdirSync(uploadDir).filter((f) => f.startsWith(requestId.replace(/[^a-zA-Z0-9-_]/g, '_')));
    for (const f of files) {
      try {
        fs.unlinkSync(path.join(uploadDir, f));
      } catch (_) {}
    }
  });

  it('非数组 messages 原样返回', () => {
    assert.strictEqual(processMessagesForMultimodal(null, 'id', options), null);
    const out = processMessagesForMultimodal([], 'id', options);
    assert.deepStrictEqual(out, []);
  });
});

describe('cleanupUploadsDir', () => {
  const workspacePath = path.join(__dirname, '..');
  const uploadDir = '.bridge-uploads';

  it('目录不存在时返回 deleted=0', () => {
    const result = cleanupUploadsDir(workspacePath, '.nonexistent-uploads-dir', 24);
    assert.strictEqual(result.deleted, 0);
    assert.strictEqual(result.errors, 0);
  });

  it('删除超过 olderThanHours 的文件', () => {
    const dir = path.join(workspacePath, uploadDir);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const oldFile = path.join(dir, 'cleanup-test-old.png');
    const newFile = path.join(dir, 'cleanup-test-new.png');
    fs.writeFileSync(oldFile, Buffer.from([0x89, 0x50, 0x4e]));
    fs.writeFileSync(newFile, Buffer.from([0x89, 0x50, 0x4e]));
    const oldTime = Date.now() - (25 * 60 * 60 * 1000);
    fs.utimesSync(oldFile, oldTime / 1000, oldTime / 1000);
    const result = cleanupUploadsDir(workspacePath, uploadDir, 24);
    assert.ok(result.deleted >= 1);
    assert.ok(!fs.existsSync(oldFile));
    try {
      if (fs.existsSync(newFile)) fs.unlinkSync(newFile);
    } catch (_) {}
  });
});
