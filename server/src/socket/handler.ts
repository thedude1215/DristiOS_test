import type { Socket } from "socket.io";
import { VoicePipeline } from "../pipeline/voicePipeline.js";
import { CartesiaTTS } from "../tts/cartesia.js";
import { DeepgramSTT } from "../stt/deepgram.js";
import { createSupervisor, runSupervisor } from "../agents/supervisor.js";
import { getNextSequence } from "../test/responses.js";
import type {
  ConversationTurn,
  UserProfile,
  ExecutionContext,
  InterimSpeechCallback,
  KnowledgeBase,
} from "../types/index.js";

const TEST_MODE = process.env.TEST === "true";

/**
 * Create a socket connection handler with access to the execution context.
 * Call once after Stagehand is initialized (or with null for text-only mode).
 */
export function createHandler(
  executionContext: ExecutionContext | null,
  kb: KnowledgeBase | null = null,
) {
  // Compile the supervisor graph once — reused across all connections
  const supervisorGraph = createSupervisor(executionContext, kb);

  return function handleConnection(socket: Socket) {
    console.log(`[Socket] Client connected: ${socket.id}`);

    const tts = new CartesiaTTS({
      apiKey: process.env.CARTESIA_API_KEY || "",
      voiceId: "a0e99841-438c-4a64-b679-ae501e7d6091",
    });

    const pipeline = new VoicePipeline(null, tts, socket);
    const conversationHistory: ConversationTurn[] = [];

    // Load user profile from KB (async, fallback handled inside KB)
    let userProfile: UserProfile | null = null;
    if (kb) {
      kb.getProfile(socket.id).then((p) => {
        userProfile = p;
        if (p) console.log(`[Socket] Loaded profile for ${socket.id}: ${p.name}`);
      }).catch(() => {});
    }

    // Tracks the current supervisor run so we can cancel it on barge-in
    let supervisorAbort: AbortController | null = null;
    let testSequenceAbort: AbortController | null = null;

    // OpenAI STT — created lazily when client starts listening
    const deepgramApiKey = process.env.DEEPGRAM_API_KEY || "";
    let stt: DeepgramSTT | null = null;

    // Connect TTS WebSocket eagerly
    pipeline.connect().catch((err) => {
      console.error("[Socket] Failed to connect TTS:", err.message);
    });

    socket.on("user_message", async (payload: { text: string }) => {
      const text = payload.text?.trim();
      if (!text) return;
      console.log(`[Socket] ${socket.id} says: "${text}"`);

      conversationHistory.push({
        role: "user",
        text,
        timestamp: Date.now(),
      });

      // ── Test mode: skip supervisor, play canned sequence ──
      if (TEST_MODE) {
        pipeline.abort();
        testSequenceAbort?.abort();
        
        const abort = new AbortController();
        testSequenceAbort = abort;
        
        const sequence = getNextSequence();
        console.log(`[Socket] [TEST] Playing sequence with ${sequence.steps.length} steps`);

        try {
          socket.emit("status", { state: "thinking" });

          const defaultDelay = sequence.delay ?? 600;

          for (const step of sequence.steps) {
            if (abort.signal.aborted) break;
            
            // Pre-delay before this step (e.g. simulate processing)
            if (step.preDelay) {
              await new Promise((r) => setTimeout(r, step.preDelay));
              if (abort.signal.aborted) break;
            }

            if (step.type === "console") {
              socket.emit("console_log", { message: step.text });
              await new Promise((r) => setTimeout(r, step.delay ?? defaultDelay));
            } else {
              console.log(`[Socket] [TEST] Speaking: "${step.text.slice(0, 80)}..."`);
              conversationHistory.push({
                role: "assistant",
                text: step.text,
                timestamp: Date.now(),
              });
              await pipeline.processSupervisorResponse(step.text);
              if (abort.signal.aborted) break;
              // Delay after assistant before next step (e.g. console log)
              await new Promise((r) => setTimeout(r, step.delay ?? defaultDelay));
            }
          }
        } catch (err: unknown) {
          if (abort.signal.aborted) return;
          console.error("[Socket] [TEST] TTS error:", err);
          socket.emit("error", {
            message: err instanceof Error ? err.message : "Test TTS error",
          });
          socket.emit("status", { state: "idle" });
        } finally {
          if (testSequenceAbort === abort) testSequenceAbort = null;
        }
        return;
      }

      // ── Normal mode: full supervisor pipeline ─────────────────────

      // Fire-and-forget: index user turn to ES
      if (kb) {
        kb.indexConversation({
          sessionId: socket.id,
          role: "user",
          text,
          timestamp: new Date().toISOString(),
        }).catch(() => {});
      }

      // Cancel any in-flight supervisor run + TTS
      supervisorAbort?.abort();
      pipeline.abort();

      const abort = new AbortController();
      supervisorAbort = abort;

      try {
        socket.emit("status", { state: "thinking" });

        const interimSpeech: InterimSpeechCallback = (phrase) => {
          if (!abort.signal.aborted) {
            socket.emit("console_log", { message: phrase });
            pipeline.speakInterim(phrase);
          }
        };

        const result = await runSupervisor(supervisorGraph, {
          userInput: text,
          conversationHistory,
          userProfile,
          pageSnapshot: null,
        }, interimSpeech, abort.signal, socket.id);

        // If aborted while running, silently drop the result
        if (abort.signal.aborted) {
          console.log(`[Socket] Supervisor result dropped (aborted): "${text.slice(0, 40)}"`);
          return;
        }

        console.log(
          `[Socket] Supervisor response (${result.agentCategory}): "${result.responseText.slice(0, 80)}..."`,
        );

        conversationHistory.push({
          role: "assistant",
          text: result.responseText,
          timestamp: Date.now(),
        });

        // Fire-and-forget: index assistant turn to ES
        if (kb) {
          kb.indexConversation({
            sessionId: socket.id,
            role: "assistant",
            text: result.responseText,
            agentCategory: result.agentCategory,
            timestamp: new Date().toISOString(),
          }).catch(() => {});
        }

        await pipeline.processSupervisorResponse(result.responseText);
      } catch (err: unknown) {
        if (abort.signal.aborted) return; // Expected — barge-in cancelled this run
        console.error("[Socket] Supervisor error:", err);
        socket.emit("error", {
          message: err instanceof Error ? err.message : "Supervisor error",
        });
        socket.emit("status", { state: "idle" });
      } finally {
        if (supervisorAbort === abort) supervisorAbort = null;
      }
    });

    socket.on("stop_audio", () => {
      console.log(`[Socket] ${socket.id} requested stop`);
      testSequenceAbort?.abort();
      testSequenceAbort = null;
      supervisorAbort?.abort();
      supervisorAbort = null;
      pipeline.abort();
      socket.emit("status", { state: "idle" });
    });

    // ── STT (OpenAI Realtime) events ───────────────────────────

    socket.on("stt_start", (payload?: { encoding?: string; sampleRate?: number; channels?: number }) => {
      if (!deepgramApiKey) {
        console.error("[Socket] DEEPGRAM_API_KEY not set — STT unavailable");
        socket.emit("error", { message: "Speech-to-text not configured" });
        return;
      }
      console.log(
        `[Socket] ${socket.id} starting STT (${payload?.encoding ?? "linear16"} ` +
          `${payload?.sampleRate ?? 16000}Hz ${payload?.channels ?? 1}ch)`,
      );
      stt = new DeepgramSTT(deepgramApiKey);
      stt.start(socket, payload);
    });

    let audioChunkCount = 0;
    socket.on("stt_audio", (data: Buffer) => {
      audioChunkCount++;
      if (audioChunkCount <= 3 || audioChunkCount % 50 === 0) {
        console.log(`[Socket] ${socket.id} stt_audio #${audioChunkCount}, bytes: ${data.byteLength}`);
      }
      stt?.sendAudio(Buffer.from(data));
    });

    socket.on("stt_stop", () => {
      console.log(`[Socket] ${socket.id} stopping STT`);
      stt?.stop();
      stt = null;
    });

    // ── Session Restore ────────────────────────────────────────

    socket.on("restore_session", async (payload: { previousSessionId: string }) => {
      const prevId = payload.previousSessionId?.trim();
      if (!prevId || !kb) return;

      try {
        const entries = await kb.restoreConversation(prevId);
        if (entries.length > 0) {
          for (const entry of entries) {
            conversationHistory.push({
              role: entry.role,
              text: entry.text,
              timestamp: new Date(entry.timestamp).getTime(),
            });
          }
          console.log(`[Socket] Restored ${entries.length} conversation entries from session ${prevId}`);
          socket.emit("session_restored", { count: entries.length });
        }
      } catch (err) {
        console.warn("[Socket] Session restore failed:", err instanceof Error ? err.message : err);
      }
    });

    // ── Disconnect ─────────────────────────────────────────────

    socket.on("disconnect", () => {
      console.log(`[Socket] Client disconnected: ${socket.id}`);
      stt?.stop();
      stt = null;
      pipeline.disconnect();
    });
  };
}
