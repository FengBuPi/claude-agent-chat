// server.ts — 同一进程启动 Hono HTTP + 飞书长连接
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { assertAuthEnv, runTurn } from "./chat.ts";
import { startFeishuBot } from "./feishu-bot.ts";

assertAuthEnv();

const app = new Hono();

/** 健康检查 */
app.get("/health", (c) => c.json({ ok: true }));

/**
 * POST /api/turn
 * body: { "prompt": string }
 * 返回: { "answer": string }
 */
app.post("/api/turn", async (c) => {
  try {
    const body = await c.req.json<{ prompt: string }>();
    const prompt = body.prompt?.trim();
    if (!prompt) {
      return c.json({ error: "prompt 不能为空" }, 400);
    }

    const answer = await runTurn(prompt);
    return c.json({ answer });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[/api/turn]", message);
    return c.json({ error: message }, 500);
  }
});

const port = Number(process.env.PORT ?? 3000);

// HTTP 与飞书长连接同进程并存
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Hono server listening on http://localhost:${info.port}`);
});

startFeishuBot();
