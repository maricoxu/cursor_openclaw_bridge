#!/usr/bin/env node
/**
 * 测试用假 cursor-agent：根据 argv 的 --output-format 输出 json 或 stream-json。
 * 根据 prompt 是否包含「天气」返回不同内容，模拟多轮对话与工具类问题。
 */

const argv = process.argv.slice(2);
const hasOutputFormat = (fmt) => argv.some((a, i) => a === '--output-format' && argv[i + 1] === fmt);
const isStream = hasOutputFormat('stream-json');

const prompt = argv[0] || '';
const isWeather = /天气|weather/i.test(prompt);

const nonStreamReply = isWeather
  ? '今天上海晴，气温 15-22°C。适合出门。'
  : '收到，测试通过。连接正常。有什么需要帮忙的吗？';

const streamReply = isWeather
  ? '今天上海晴，气温 15-22°C。适合出门。'
  : '收到，测试通过。连接正常。有什么需要帮忙的吗？';

if (isStream) {
  // 流式：多行 NDJSON，每行 type assistant + message.content
  const chars = streamReply.split('');
  for (let i = 0; i < chars.length; i++) {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ text: chars[i] }] },
    });
    process.stdout.write(line + '\n');
  }
} else {
  // 非流式：单行 JSON，与 agent-runner extractContentFromJson 兼容
  const line = JSON.stringify({ type: 'result', result: nonStreamReply });
  process.stdout.write(line + '\n');
}

process.exit(0);
