import "dotenv/config";
import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import { createHandler } from "./socket/handler.js";
import { createSupervisor, runSupervisor } from "./agents/supervisor.js";
import {
  initStagehand,
  createExecutionContext,
  closeStagehand,
} from "./lib/stagehand.js";
import {
  initElasticsearch,
  createKnowledgeBase,
} from "./lib/elasticsearch.js";
import { getChatModelProviderName } from "./llm/chatModel.js";

const PORT = parseInt(process.env.PORT || "3001", 10);
const TEST_MODE = process.env.TEST === "true";

async function start() {
  if (TEST_MODE) {
    console.log("[Server] ========================================");
    console.log("[Server]  TEST MODE ENABLED");
    console.log("[Server]  Skipping Stagehand + Elasticsearch init");
    console.log("[Server]  Responses served from test/responses.ts");
    console.log("[Server] ========================================");
  }

  // ── Initialize Stagehand (graceful degradation) ──────────────
  let executionContext = null;
  if (!TEST_MODE) {
    try {
      await initStagehand();
      executionContext = createExecutionContext();
      if (executionContext) {
        console.log("[Server] Stagehand initialized — browser tools available");
      } else {
        console.log("[Server] Stagehand not available — text-only mode");
      }
    } catch (err) {
      console.warn(
        "[Server] Stagehand init failed — running without browser tools:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  // ── Initialize Elasticsearch (graceful degradation) ─────────
  let knowledgeBase = null;
  if (!TEST_MODE) {
    try {
      const esConnected = await initElasticsearch();
      if (esConnected) {
        knowledgeBase = createKnowledgeBase();
        console.log("[Server] Elasticsearch initialized — knowledge base ENABLED");
      } else {
        console.log("[Server] Elasticsearch not available — knowledge base DISABLED");
      }
    } catch (err) {
      console.warn(
        "[Server] Elasticsearch init failed — running without knowledge base:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  // ── Express + Socket.io ──────────────────────────────────────
  const app = express();
  app.use(cors());
  app.use(express.json());

  const httpServer = createServer(app);

  const io = new Server(httpServer, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"],
    },
  });

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  // Supervisor graph for REST API (text-only, no browser tools)
  const chatGraph = createSupervisor(null, knowledgeBase);

  app.post("/api/chat", async (req, res) => {
    try {
      const { message } = req.body;
      if (!message || typeof message !== "string") {
        res.status(400).json({ error: "message is required" });
        return;
      }
      const result = await runSupervisor(chatGraph, {
        userInput: message,
        conversationHistory: [],
        userProfile: null,
        pageSnapshot: null,
      });
      res.json({ response: result.responseText, agentCategory: result.agentCategory });
    } catch (err) {
      console.error("[Server] /api/chat error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  const handleConnection = createHandler(executionContext, knowledgeBase);
  io.on("connection", handleConnection);

  httpServer.listen(PORT, () => {
    console.log(`[Server] Listening on port ${PORT}`);
    console.log(`[Server] Chat model provider: ${getChatModelProviderName().toUpperCase()}`);
    console.log(`[Server] OpenAI key: ${process.env.OPENAI_API_KEY ? "yes" : "NOT SET"}`);
    console.log(`[Server] Anthropic key: ${process.env.ANTHROPIC_API_KEY ? "yes" : "NOT SET"}`);
    console.log(`[Server] Cartesia key: ${process.env.CARTESIA_API_KEY ? "yes" : "NOT SET"}`);
    console.log(`[Server] Deepgram key: ${process.env.DEEPGRAM_API_KEY ? "yes" : "NOT SET"}`);
    console.log(`[Server] Perplexity key: ${process.env.PERPLEXITY_API_KEY ? "yes" : "NOT SET (web_search disabled)"}`);
    console.log(`[Server] Test mode: ${TEST_MODE ? "ENABLED" : "DISABLED"}`);
    console.log(`[Server] Browser tools: ${executionContext ? "ENABLED" : "DISABLED"}`);
    console.log(`[Server] Knowledge base: ${knowledgeBase?.isAvailable() ? "ENABLED" : "DISABLED"}`);
  });

  // Graceful shutdown
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, async () => {
      console.log(`\n[Server] ${signal} received — shutting down`);
      await closeStagehand();
      httpServer.close();
      process.exit(0);
    });
  }
}

start().catch((err) => {
  console.error("[Server] Fatal error:", err);
  process.exit(1);
});
