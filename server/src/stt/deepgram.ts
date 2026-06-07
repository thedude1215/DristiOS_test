import { createClient, LiveTranscriptionEvents } from "@deepgram/sdk";
import type { Socket } from "socket.io";

export interface DeepgramStartOptions {
  encoding?: string;
  sampleRate?: number;
  channels?: number;
}

export class DeepgramSTT {
  private apiKey: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private connection: any = null;
  private isOpen = false;
  private pendingAudio: Buffer[] = [];
  private keepAliveInterval: ReturnType<typeof setInterval> | null = null;
  private generation = 0;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  start(socket: Socket, options: DeepgramStartOptions = {}): void {
    this.stop();
    const generation = ++this.generation;

    const deepgram = createClient(this.apiKey);

    const connection = deepgram.listen.live({
      model: "nova-3",
      language: "en-US",
      encoding: options.encoding ?? "linear16",
      sample_rate: options.sampleRate ?? 16000,
      channels: options.channels ?? 1,
      smart_format: true,
      interim_results: true,
      utterance_end_ms: 1500,
      vad_events: true,
      endpointing: 600,
    });

    connection.on(LiveTranscriptionEvents.Open, () => {
      if (generation !== this.generation) return;
      console.log("[Deepgram] Connection opened");
      this.isOpen = true;

      // Flush any audio that arrived before connection opened
      for (const chunk of this.pendingAudio) {
        connection.send(new Uint8Array(chunk).buffer);
      }
      this.pendingAudio = [];
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    connection.on(LiveTranscriptionEvents.Transcript, (data: any) => {
      if (generation !== this.generation) return;
      const transcript = data.channel?.alternatives?.[0]?.transcript;
      if (transcript === undefined || transcript === null) return;

      socket.emit("stt_transcript", {
        text: transcript,
        is_final: !!data.is_final,
        speech_final: !!data.speech_final,
      });
      if (transcript) {
        console.log(
          `[Deepgram] transcript final=${!!data.is_final} speechFinal=${!!data.speech_final}: "${transcript}"`,
        );
      }
    });

    connection.on(LiveTranscriptionEvents.SpeechStarted, () => {
      if (generation !== this.generation) return;
      socket.emit("stt_speech_started", {});
    });

    connection.on(LiveTranscriptionEvents.UtteranceEnd, () => {
      if (generation !== this.generation) return;
      socket.emit("stt_utterance_end", {});
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    connection.on(LiveTranscriptionEvents.Error, (err: any) => {
      if (generation !== this.generation) return;
      console.error("[Deepgram] Error:", err);
      socket.emit("error", {
        message: `Speech-to-text error: ${err?.message ?? String(err)}`,
      });
    });

    connection.on(LiveTranscriptionEvents.Close, () => {
      if (generation !== this.generation) return;
      console.log("[Deepgram] Connection closed");
      this.isOpen = false;
    });

    this.connection = connection;

    // Keep-alive every 8 seconds to prevent timeout
    this.keepAliveInterval = setInterval(() => {
      if (this.connection && this.isOpen) {
        this.connection.keepAlive();
      }
    }, 8000);
  }

  sendAudio(data: Buffer): void {
    if (!this.connection) return;

    if (this.isOpen) {
      this.connection.send(new Uint8Array(data).buffer);
    } else {
      this.pendingAudio.push(data);
    }
  }

  stop(): void {
    this.generation++;

    if (this.keepAliveInterval) {
      clearInterval(this.keepAliveInterval);
      this.keepAliveInterval = null;
    }

    if (this.connection) {
      try {
        this.connection.finish();
      } catch {
        // best-effort cleanup
      }
      this.connection = null;
      this.isOpen = false;
      this.pendingAudio = [];
    }
  }
}
