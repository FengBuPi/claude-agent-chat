// cli.ts — 本地多轮对话演示（原 chat.ts 顶层脚本）
import { assertAuthEnv, runTurn } from "./chat.ts";

assertAuthEnv();

await runTurn("简单帮我分析当前目录的项目结构");
console.log("\n======== 下一轮 ========\n");
await runTurn("如何持久化 sessionId 的值？");
console.log("\n======== 再下一轮 ========\n");
await runTurn("为什么要持久化 sessionId 的值？");
