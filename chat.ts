// chat.ts — Agent 多轮对话核心逻辑（可供 CLI / HTTP / 飞书机器人复用）
import { config as loadEnv } from "dotenv";
import { query } from "@anthropic-ai/claude-agent-sdk";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  unlinkSync,
} from "node:fs";
import { resolve, join } from "node:path";

// 从项目根目录加载 .env，保证 Cursor/调试器启动时也能带上网关与 token
loadEnv({ path: resolve(process.cwd(), ".env") });

const DEFAULT_SESSION_FILE = ".claude-session.json";
const SESSION_DIR = ".claude-sessions";

export type RunTurnOptions = {
  /** 会话隔离键（如飞书话题：p2p:{chat_id}:thread:{root_id}）；不传则用默认单文件 */
  sessionKey?: string;
};

type TurnResult = { answer: string; sessionId: string };

/** 校验运行 Agent SDK 所需的鉴权环境变量 */
export function assertAuthEnv(): void {
  const missing = ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"].filter(
    (key) => !process.env[key]?.trim(),
  );
  if (missing.length > 0) {
    throw new Error(
      `缺少环境变量: ${missing.join(", ")}。请复制 .env.example 为 .env 并填入与 ~/.zshrc 一致的值。`,
    );
  }
}

/** 将任意 sessionKey 映射到本地 session 文件路径 */
function sessionFilePath(sessionKey?: string): string {
  if (!sessionKey) return DEFAULT_SESSION_FILE;
  mkdirSync(SESSION_DIR, { recursive: true });
  // 只保留安全文件名字符，避免路径穿越
  const safe = sessionKey.replace(/[^a-zA-Z0-9_-]/g, "_");
  return join(SESSION_DIR, `${safe}.json`);
}

/** 读取已持久化的 sessionId；没有则返回 undefined */
function readSessionId(file: string): string | undefined {
  if (!existsSync(file)) return undefined;
  return (JSON.parse(readFileSync(file, "utf8")) as { sessionId: string }).sessionId;
}

/** 删除失效的本地 session 记录 */
function clearSession(file: string): void {
  if (existsSync(file)) unlinkSync(file);
}

/** 判断是否为「会话不存在」类错误，便于自动开新会话重试 */
function isMissingSessionError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /No conversation found with session ID/i.test(message);
}

/** 构造传给 Claude Code 子进程的环境变量 */
function buildAgentEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
    ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
    ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL,
    ANTHROPIC_DEFAULT_OPUS_MODEL: process.env.ANTHROPIC_DEFAULT_OPUS_MODEL,
    ANTHROPIC_DEFAULT_SONNET_MODEL: process.env.ANTHROPIC_DEFAULT_SONNET_MODEL,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL,
    CLAUDE_CODE_SUBAGENT_MODEL: process.env.CLAUDE_CODE_SUBAGENT_MODEL,
    CLAUDE_CODE_EFFORT_LEVEL: process.env.CLAUDE_CODE_EFFORT_LEVEL,
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW,
  };
}

/** 实际执行一轮 query（可选 resume） */
async function queryTurn(userPrompt: string, resume?: string): Promise<TurnResult> {
  const stream = query({
    prompt: userPrompt,
    options: {
      resume,
      allowedTools: ["Read", "Grep", "Glob"],
      permissionMode: "acceptEdits",
      env: buildAgentEnv(),
    },
  });

  let answer = "";
  let sessionId = "";

  for await (const msg of stream) {
    if (msg.type === "assistant") {
      for (const block of msg.message.content) {
        if (block.type === "text") process.stdout.write(block.text);
      }
    } else if (msg.type === "result") {
      answer = msg.result;
      sessionId = msg.session_id;
      console.log("\n--- 花费 $", msg.total_cost_usd, "轮数", msg.num_turns);
    }
  }

  return { answer, sessionId };
}

/** 执行一轮对话，并在本地持久化 sessionId 以便续接 */
export async function runTurn(
  userPrompt: string,
  options: RunTurnOptions = {},
): Promise<string> {
  const file = sessionFilePath(options.sessionKey);
  const resume = readSessionId(file);

  try {
    const { answer, sessionId } = await queryTurn(userPrompt, resume);
    if (sessionId) writeFileSync(file, JSON.stringify({ sessionId }));
    return answer;
  } catch (err) {
    // 本地存了过期 sessionId 时，清掉后不带 resume 重试一次
    if (resume && isMissingSessionError(err)) {
      console.warn("[runTurn] session 失效，清空后重开会话:", resume);
      clearSession(file);
      const { answer, sessionId } = await queryTurn(userPrompt, undefined);
      if (sessionId) writeFileSync(file, JSON.stringify({ sessionId }));
      return answer;
    }
    throw err;
  }
}
