// feishu-bot.ts — 飞书长连接收消息，把用户文本交给 Claude Code，再回复到飞书
import * as lark from "@larksuiteoapi/node-sdk";
import { runTurn } from "./chat.ts";

/** 飞书单条文本消息建议控制在此长度内，超出则分段发送 */
const FEISHU_TEXT_CHUNK = 3500;

type ReceiveMessageEvent = {
  sender: { sender_type?: string };
  message: {
    message_id: string;
    chat_id: string;
    chat_type?: string;
    message_type?: string;
    content: string;
    mentions?: Array<{ key: string; name?: string; id?: { open_id?: string } }>;
  };
};

/** 从消息 content JSON 中取出纯文本，并去掉 @ 机器人占位符 */
function extractPrompt(data: ReceiveMessageEvent): string | undefined {
  if (data.message.message_type && data.message.message_type !== "text") {
    return undefined;
  }

  let text = "";
  try {
    text = (JSON.parse(data.message.content) as { text?: string }).text ?? "";
  } catch {
    return undefined;
  }

  // 群聊里常见 @_user_1 这类 mention 占位，去掉后再当 prompt
  for (const mention of data.message.mentions ?? []) {
    if (mention.key) text = text.split(mention.key).join("");
  }

  text = text.replace(/\s+/g, " ").trim();
  return text || undefined;
}

/** 群聊仅在被 @ 时响应；单聊直接响应 */
function shouldHandle(data: ReceiveMessageEvent): boolean {
  if (data.sender.sender_type === "app") return false;
  if (data.message.chat_type === "group") {
    return (data.message.mentions?.length ?? 0) > 0;
  }
  return true;
}

/** 按飞书长度限制切分回复文本 */
function chunkText(text: string): string[] {
  if (text.length <= FEISHU_TEXT_CHUNK) return [text];
  const parts: string[] = [];
  for (let i = 0; i < text.length; i += FEISHU_TEXT_CHUNK) {
    parts.push(text.slice(i, i + FEISHU_TEXT_CHUNK));
  }
  return parts;
}

/**
 * 启动飞书长连接机器人（可与 Hono 同进程调用）。
 * 需已配置 FEISHU_APP_ID / FEISHU_APP_SECRET。
 */
export function startFeishuBot(): void {
  const appId = process.env.FEISHU_APP_ID?.trim();
  const appSecret = process.env.FEISHU_APP_SECRET?.trim();

  if (!appId || !appSecret) {
    throw new Error(
      "缺少 FEISHU_APP_ID / FEISHU_APP_SECRET。请在 .env 中填写飞书应用凭证。",
    );
  }

  const baseConfig = { appId, appSecret };
  const client = new lark.Client(baseConfig);
  const wsClient = new lark.WSClient({
    ...baseConfig,
    loggerLevel: lark.LoggerLevel.info,
  });

  /** 回复原消息（优先 reply，超长续发到同一会话） */
  async function replyText(
    data: ReceiveMessageEvent,
    text: string,
  ): Promise<void> {
    const chunks = chunkText(text || "（Claude 未返回文本）");

    for (const [index, chunk] of chunks.entries()) {
      const content = JSON.stringify({ text: chunk });
      if (index === 0) {
        await client.im.v1.message.reply({
          path: { message_id: data.message.message_id },
          data: { content, msg_type: "text" },
        });
        continue;
      }
      await client.im.v1.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: data.message.chat_id,
          content,
          msg_type: "text",
        },
      });
    }
  }

  /**
   * 真正耗时的处理放到后台：长连接要求事件回调约 3 秒内返回，
   * Claude Code 往往更久，因此不能在 handler 里 await 整轮对话。
   */
  async function handleMessage(data: ReceiveMessageEvent): Promise<void> {
    if (!shouldHandle(data)) return;

    const prompt = extractPrompt(data);
    if (!prompt) {
      await replyText(data, "目前只支持文本消息，请直接发送文字或 @我 提问。");
      return;
    }

    console.log(`[feishu] chat=${data.message.chat_id} prompt=`, prompt);

    try {
      // 先回复「处理中」，最终答案另发到同一会话（Claude 耗时通常 > 3s）
      await replyText(data, "收到，正在调用 Claude Code…");
      const answer = await runTurn(prompt, { sessionKey: data.message.chat_id });
      for (const chunk of chunkText(answer || "（Claude 未返回文本）")) {
        await client.im.v1.message.create({
          params: { receive_id_type: "chat_id" },
          data: {
            receive_id: data.message.chat_id,
            content: JSON.stringify({ text: chunk }),
            msg_type: "text",
          },
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[feishu] 处理失败:", message);
      await client.im.v1.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: data.message.chat_id,
          content: JSON.stringify({ text: `调用 Claude Code 失败：${message}` }),
          msg_type: "text",
        },
      });
    }
  }

  wsClient.start({
    eventDispatcher: new lark.EventDispatcher({}).register({
      "im.message.receive_v1": async (data) => {
        // 立即返回，后台异步跑 Claude，避免长连接 3s 超时重推
        void handleMessage(data as ReceiveMessageEvent);
      },
    }),
  });

  console.log("[feishu] 长连接已启动，等待机器人消息…");
}
