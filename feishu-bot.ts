// feishu-bot.ts — 飞书长连接收消息，把用户文本交给 Claude Code，再在话题内回复
import * as lark from "@larksuiteoapi/node-sdk";
import { runTurn } from "./chat.ts";

/** 飞书单条文本消息建议控制在此长度内，超出则分段发送 */
const FEISHU_TEXT_CHUNK = 3500;

/** 「思考中」表情，用作处理中状态（非文本提示） */
const THINKING_EMOJI = "THINKING";

type ReceiveMessageEvent = {
  sender: { sender_type?: string };
  message: {
    message_id: string;
    chat_id: string;
    chat_type?: string;
    message_type?: string;
    content: string;
    /** 话题根消息 id；在话题内续聊时会带上 */
    root_id?: string;
    /** 被回复消息 id */
    parent_id?: string;
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

/** 解析话题根 message_id：有 root_id 用 root，否则本条就是新话题根 */
function resolveThreadRootId(data: ReceiveMessageEvent): string {
  return data.message.root_id || data.message.message_id;
}

/**
 * 每个飞书话题对应一个 Claude session。
 * 单聊/群聊都用 chat 类型 + chat_id + 话题根 message_id 隔离。
 */
function resolveThreadSessionKey(data: ReceiveMessageEvent): string {
  const chatType = data.message.chat_type === "group" ? "group" : "p2p";
  const rootId = resolveThreadRootId(data);
  return `${chatType}:${data.message.chat_id}:thread:${rootId}`;
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

  /** 在指定消息上添加 THINKING 表情；失败只打日志，不中断主流程 */
  async function addThinkingReaction(messageId: string): Promise<string | undefined> {
    try {
      const res = await client.im.v1.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: THINKING_EMOJI } },
      });
      return res.data?.reaction_id;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn("[feishu] 添加 THINKING 表情失败:", message);
      return undefined;
    }
  }

  /** 删除之前添加的表情；失败只打日志 */
  async function removeReaction(
    messageId: string,
    reactionId: string | undefined,
  ): Promise<void> {
    if (!reactionId) return;
    try {
      await client.im.v1.messageReaction.delete({
        path: { message_id: messageId, reaction_id: reactionId },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn("[feishu] 删除 THINKING 表情失败:", message);
    }
  }

  /**
   * 在用户消息的话题内回复（reply_in_thread=true）。
   * 超长文本分段，每一段都挂在同一条用户消息下。
   */
  async function replyInThread(messageId: string, text: string): Promise<void> {
    const chunks = chunkText(text || "（Claude 未返回文本）");
    for (const chunk of chunks) {
      await client.im.v1.message.reply({
        path: { message_id: messageId },
        data: {
          content: JSON.stringify({ text: chunk }),
          msg_type: "text",
          reply_in_thread: true,
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

    const userMessageId = data.message.message_id;
    const prompt = extractPrompt(data);
    if (!prompt) {
      await replyInThread(
        userMessageId,
        "目前只支持文本消息，请直接发送文字或 @我 提问。",
      );
      return;
    }

    const sessionKey = resolveThreadSessionKey(data);
    console.log(
      `[feishu] chat=${data.message.chat_id} thread=${resolveThreadRootId(data)} prompt=`,
      prompt,
    );

    // 用表情表示「思考中」，代替文字提示
    const reactionId = await addThinkingReaction(userMessageId);

    try {
      const answer = await runTurn(prompt, { sessionKey });
      await replyInThread(userMessageId, answer);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[feishu] 处理失败:", message);
      await replyInThread(userMessageId, `调用 Claude Code 失败：${message}`);
    } finally {
      await removeReaction(userMessageId, reactionId);
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
