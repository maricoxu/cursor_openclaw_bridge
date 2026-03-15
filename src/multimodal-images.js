/**
 * Phase 4 多模态：图片 data URL 落盘与路径占位，供 buildPrompt 前预处理 messages。
 * 仅处理 /v1/chat/completions 的 messages；失败即抛错（400/500），不静默跳过。
 */

import fs from 'fs';
import path from 'path';

/** 路径占位格式： [图片: <path>] */
export const PLACEHOLDER_REGEX = /^\[图片:\s*(.+)\]$/;

const DEFAULT_UPLOAD_DIR = '.bridge-uploads';
const DEFAULT_MAX_SIZE_BYTES = 10 * 1024 * 1024; // 10MB
const DEFAULT_MAX_FILES_PER_REQUEST = 5;

const MIME_TO_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

/** 可配置选项，从环境变量或调用方传入 */
export function getMultimodalOptions(workspacePath) {
  const enabled = process.env.CURSOR_BRIDGE_MULTIMODAL_IMAGES === '1' || process.env.CURSOR_BRIDGE_MULTIMODAL_IMAGES === 'true';
  const uploadDir = typeof process.env.CURSOR_BRIDGE_UPLOAD_DIR === 'string' && process.env.CURSOR_BRIDGE_UPLOAD_DIR.trim()
    ? process.env.CURSOR_BRIDGE_UPLOAD_DIR.trim()
    : DEFAULT_UPLOAD_DIR;
  const maxSizeBytes = Math.max(0, parseInt(process.env.CURSOR_BRIDGE_UPLOAD_MAX_SIZE_BYTES || String(DEFAULT_MAX_SIZE_BYTES), 10) || DEFAULT_MAX_SIZE_BYTES);
  const maxFilesPerRequest = Math.max(1, parseInt(process.env.CURSOR_BRIDGE_UPLOAD_MAX_FILES_PER_REQUEST || String(DEFAULT_MAX_FILES_PER_REQUEST), 10) || DEFAULT_MAX_FILES_PER_REQUEST);
  const workspace = typeof workspacePath === 'string' && workspacePath.trim() ? workspacePath.trim() : process.env.CURSOR_WORKSPACE || process.cwd();
  return {
    multimodalImagesEnabled: enabled,
    uploadDir,
    maxSizeBytes,
    maxFilesPerRequest,
    workspacePath: path.resolve(workspace),
  };
}

/** 用于请求失败时返回 400/500 */
export class MultimodalError extends Error {
  constructor(message, statusCode = 500) {
    super(message);
    this.name = 'MultimodalError';
    this.statusCode = statusCode;
  }
}

/**
 * 解析 data URL (data:image/xxx;base64,...)，校验大小与 MIME，落盘并返回绝对路径。
 * 失败时抛出 MultimodalError(statusCode 400 为客户端错误，500 为服务端错误)。
 * @param {string} dataUrl
 * @param {string} requestId
 * @param {number} partIndex
 * @param {{ workspacePath: string, uploadDir: string, maxSizeBytes: number }}
 * @returns {string} 绝对路径
 */
export function decodeDataUrlAndSave(dataUrl, requestId, partIndex, options) {
  if (!dataUrl || typeof dataUrl !== 'string') {
    throw new MultimodalError('无效的图片 data URL', 400);
  }
  const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9+.-]+);base64,(.+)$/);
  if (!match) {
    throw new MultimodalError('图片格式须为 data:image/xxx;base64,...', 400);
  }
  const mime = match[1].toLowerCase();
  const ext = MIME_TO_EXT[mime];
  if (!ext) {
    throw new MultimodalError(`不支持的图片类型: ${mime}`, 400);
  }
  let buffer;
  try {
    buffer = Buffer.from(match[2], 'base64');
  } catch (_) {
    throw new MultimodalError('base64 解码失败', 400);
  }
  if (buffer.length === 0) {
    throw new MultimodalError('图片数据为空', 400);
  }
  if (buffer.length > options.maxSizeBytes) {
    throw new MultimodalError(`单张图片超过大小限制（${options.maxSizeBytes} 字节）`, 400);
  }
  const dir = path.join(options.workspacePath, options.uploadDir);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    throw new MultimodalError(`无法创建上传目录: ${err.message}`, 500);
  }
  const safeId = (requestId || 'req').replace(/[^a-zA-Z0-9-_]/g, '_').slice(0, 64);
  const filename = `${safeId}-${partIndex}.${ext}`;
  const filePath = path.join(dir, filename);
  try {
    fs.writeFileSync(filePath, buffer, { flag: 'wx' });
  } catch (err) {
    if (err.code === 'EEXIST') {
      try {
        fs.writeFileSync(filePath, buffer);
      } catch (e) {
        throw new MultimodalError(`写入图片失败: ${e.message}`, 500);
      }
    } else {
      throw new MultimodalError(`写入图片失败: ${err.message}`, 500);
    }
  }
  return path.resolve(filePath);
}

/**
 * 预处理 messages：将 content 中的 image_url（data URL）落盘并替换为路径说明文本；路径占位 [图片: path] 原样保留。
 * 若未开启多模态，直接返回原 messages。
 * 失败时抛出 MultimodalError。
 * @param {Array<{ role: string, content: string|array }>} messages
 * @param {string} requestId
 * @param {{ multimodalImagesEnabled: boolean, uploadDir: string, maxSizeBytes: number, maxFilesPerRequest: number, workspacePath: string }} options
 * @returns {Array<{ role: string, content: string|array }>}
 */
export function processMessagesForMultimodal(messages, requestId, options) {
  if (!options.multimodalImagesEnabled) return messages;
  if (!Array.isArray(messages)) return messages;

  const out = [];
  let imageCount = 0;

  for (const msg of messages) {
    const content = msg.content;
    if (typeof content === 'string') {
      out.push(msg);
      continue;
    }
    if (!Array.isArray(content)) {
      out.push(msg);
      continue;
    }

    const newParts = [];
    for (let i = 0; i < content.length; i++) {
      const part = content[i];
      if (part?.type === 'image_url' && part?.image_url?.url) {
        if (imageCount >= options.maxFilesPerRequest) {
          throw new MultimodalError(`单请求最多 ${options.maxFilesPerRequest} 张图片`, 400);
        }
        const absolutePath = decodeDataUrlAndSave(part.image_url.url, requestId, imageCount, options);
        imageCount += 1;
        newParts.push({ type: 'text', text: `用户发送了一张图片，路径为：${absolutePath}。请根据图片内容回答。` });
      } else if (part?.type === 'text' || part?.type === 'input_text' || part?.text != null || part?.content != null) {
        newParts.push(part);
      }
    }
    out.push({ ...msg, content: newParts.length ? newParts : content });
  }
  return out;
}

/**
 * 清理上传目录中超过指定时长的文件（供定时任务或外部调用）。
 * @param {string} workspacePath - workspace 根路径
 * @param {string} uploadDir - 相对 workspace 的上传子目录
 * @param {number} olderThanHours - 删除超过此时长的文件（小时）
 * @returns {{ deleted: number, errors: number }}
 */
export function cleanupUploadsDir(workspacePath, uploadDir, olderThanHours = 24) {
  const dir = path.join(workspacePath, uploadDir);
  let deleted = 0;
  let errors = 0;
  const cutoff = Date.now() - olderThanHours * 60 * 60 * 1000;
  try {
    if (!fs.existsSync(dir)) return { deleted: 0, errors: 0 };
    const names = fs.readdirSync(dir);
    for (const name of names) {
      const filePath = path.join(dir, name);
      try {
        const stat = fs.statSync(filePath);
        if (stat.mtimeMs < cutoff) {
          fs.unlinkSync(filePath);
          deleted += 1;
        }
      } catch (_) {
        errors += 1;
      }
    }
  } catch (_) {
    errors += 1;
  }
  return { deleted, errors };
}
