import { useRef, useState, useCallback, useEffect } from "react";
import type { Socket } from "socket.io-client";

interface UseDeepgramSTTReturn {
  isListening: boolean;
  interimTranscript: string;
  startListening: () => void;
  stopListening: () => void;
  isSupported: boolean;
  isMuted: boolean;
  toggleMute: () => void;
}

/**
 * Deepgram STT via server relay.
 *
 * Flow: Mic → AudioContext PCM16 → socket.io → server → Deepgram WS
 *       Deepgram → server → socket.io → this hook (transcript + VAD events)
 */
export function useDeepgramSTT(
  onFinalTranscript?: (text: string) => void,
  onBargeIn?: () => void,
  socketRef?: { current: Socket | null },
  onError?: (message: string) => void
): UseDeepgramSTTReturn {
  const [isListening, setIsListening] = useState(false);
  const [interimTranscript, setInterimTranscript] = useState("");
  const [isMuted, setIsMuted] = useState(false);
  const isMutedRef = useRef(false);

  const audioCtxRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const silentGainRef = useRef<GainNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const onFinalRef = useRef(onFinalTranscript);
  const onBargeInRef = useRef(onBargeIn);
  const onErrorRef = useRef(onError);
  const finalSegmentsRef = useRef<string[]>([]);
  const interimTranscriptRef = useRef("");
  const listenersAttachedRef = useRef(false);

  const isSupported =
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia;

  useEffect(() => {
    onFinalRef.current = onFinalTranscript;
    onBargeInRef.current = onBargeIn;
    onErrorRef.current = onError;
  }, [onFinalTranscript, onBargeIn, onError]);

  const toggleMute = useCallback(() => {
    const next = !isMutedRef.current;
    isMutedRef.current = next;
    setIsMuted(next);
    if (next) {
      // Clear any buffered segments and interim text when muting
      finalSegmentsRef.current = [];
      interimTranscriptRef.current = "";
      setInterimTranscript("");
    }
    console.log("[DeepgramSTT] Mute:", next);
  }, []);

  const handleTranscript = useCallback(
    (payload: { text: string; is_final: boolean; speech_final: boolean }) => {
      if (isMutedRef.current) return;
      const { text, is_final, speech_final } = payload;

      if (speech_final) {
        if (text) finalSegmentsRef.current.push(text);
        const fullText = finalSegmentsRef.current.join(" ").trim();
        finalSegmentsRef.current = [];
        interimTranscriptRef.current = "";
        setInterimTranscript("");
        if (fullText) {
          onFinalRef.current?.(fullText);
        }
      } else if (is_final) {
        if (text) finalSegmentsRef.current.push(text);
        // Keep showing finalized segments in the interim display
        const buffered = finalSegmentsRef.current.join(" ");
        interimTranscriptRef.current = buffered;
        setInterimTranscript(buffered);
      } else {
        if (text) {
          onBargeInRef.current?.();
          const buffered = finalSegmentsRef.current.join(" ");
          const display = buffered ? `${buffered} ${text}` : text;
          interimTranscriptRef.current = display;
          setInterimTranscript(display);
        }
      }
    },
    [],
  );

  const handleSpeechStarted = useCallback(() => {}, []);

  const handleUtteranceEnd = useCallback(() => {
    if (isMutedRef.current) return;
    if (finalSegmentsRef.current.length > 0) {
      const fullText = finalSegmentsRef.current.join(" ").trim();
      finalSegmentsRef.current = [];
      interimTranscriptRef.current = "";
      setInterimTranscript("");
      if (fullText) {
        onFinalRef.current?.(fullText);
      }
    }
  }, []);

  const startListening = useCallback(async () => {
    if (!isSupported) {
      const message = "Microphone capture is not supported in this window.";
      console.error("[DeepgramSTT]", message);
      onErrorRef.current?.(message);
      return;
    }

    const socket = socketRef?.current;
    if (!socket || !socket.connected) {
      const message = "Voice server is still connecting. Try the mic again in a moment.";
      console.error("[DeepgramSTT]", message);
      onErrorRef.current?.(message);
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      if (!listenersAttachedRef.current) {
        socket.on("stt_transcript", handleTranscript);
        socket.on("stt_speech_started", handleSpeechStarted);
        socket.on("stt_utterance_end", handleUtteranceEnd);
        listenersAttachedRef.current = true;
      }

      const audioCtx = new AudioContext();
      const source = audioCtx.createMediaStreamSource(stream);
      const processor = audioCtx.createScriptProcessor(4096, 1, 1);
      const silentGain = audioCtx.createGain();
      const targetSampleRate = 16000;
      silentGain.gain.value = 0;

      audioCtxRef.current = audioCtx;
      sourceRef.current = source;
      processorRef.current = processor;
      silentGainRef.current = silentGain;

      socket.emit("stt_start", {
        encoding: "linear16",
        sampleRate: targetSampleRate,
        channels: 1,
      });

      processor.onaudioprocess = (event) => {
        if (isMutedRef.current) return;
        const input = event.inputBuffer.getChannelData(0);
        const pcm = downsampleToPCM16(input, audioCtx.sampleRate, targetSampleRate);
        if (pcm.byteLength > 0) {
          socketRef?.current?.emit("stt_audio", pcm.buffer);
        }
      };

      source.connect(processor);
      processor.connect(silentGain);
      silentGain.connect(audioCtx.destination);

      setIsListening(true);
      finalSegmentsRef.current = [];
      console.log("[DeepgramSTT] Started listening with PCM16 @ 16kHz");
    } catch (err) {
      console.error("[DeepgramSTT] Failed to start:", err);
      const message =
        err instanceof DOMException && err.name === "NotAllowedError"
          ? "Microphone permission was denied. Allow microphone access for this app in macOS Privacy settings."
          : err instanceof Error
            ? `Could not start microphone: ${err.message}`
            : "Could not start microphone.";
      onErrorRef.current?.(message);
    }
  }, [isSupported, socketRef, handleTranscript, handleSpeechStarted, handleUtteranceEnd]);

  const stopListening = useCallback(() => {
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current.onaudioprocess = null;
      processorRef.current = null;
    }

    silentGainRef.current?.disconnect();
    silentGainRef.current = null;

    sourceRef.current?.disconnect();
    sourceRef.current = null;

    audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;

    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }

    socketRef?.current?.emit("stt_stop", {});

    const bestTranscript = (
      finalSegmentsRef.current.join(" ") || interimTranscriptRef.current
    ).trim();
    if (bestTranscript) {
      onFinalRef.current?.(bestTranscript);
    }

    const socket = socketRef?.current;
    if (socket && listenersAttachedRef.current) {
      socket.off("stt_transcript", handleTranscript);
      socket.off("stt_speech_started", handleSpeechStarted);
      socket.off("stt_utterance_end", handleUtteranceEnd);
      listenersAttachedRef.current = false;
    }

    setIsListening(false);
    setInterimTranscript("");
    interimTranscriptRef.current = "";
    finalSegmentsRef.current = [];
    console.log("[DeepgramSTT] Stopped listening");
  }, [socketRef, handleTranscript, handleSpeechStarted, handleUtteranceEnd]);

  useEffect(() => {
    return () => {
      processorRef.current?.disconnect();
      silentGainRef.current?.disconnect();
      sourceRef.current?.disconnect();
      audioCtxRef.current?.close().catch(() => {});
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
      }
      const socket = socketRef?.current;
      if (socket && listenersAttachedRef.current) {
        socket.off("stt_transcript", handleTranscript);
        socket.off("stt_speech_started", handleSpeechStarted);
        socket.off("stt_utterance_end", handleUtteranceEnd);
      }
    };
  }, [socketRef, handleTranscript, handleSpeechStarted, handleUtteranceEnd]);

  return {
    isListening,
    interimTranscript,
    startListening,
    stopListening,
    isSupported,
    isMuted,
    toggleMute,
  };
}

function downsampleToPCM16(
  input: Float32Array,
  sourceSampleRate: number,
  targetSampleRate: number,
): Int16Array {
  if (sourceSampleRate === targetSampleRate) {
    return floatToPCM16(input);
  }

  const ratio = sourceSampleRate / targetSampleRate;
  const outputLength = Math.floor(input.length / ratio);
  const output = new Float32Array(outputLength);

  for (let i = 0; i < outputLength; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(Math.floor((i + 1) * ratio), input.length);
    let sum = 0;
    let count = 0;

    for (let j = start; j < end; j++) {
      sum += input[j];
      count++;
    }

    output[i] = count > 0 ? sum / count : 0;
  }

  return floatToPCM16(output);
}

function floatToPCM16(input: Float32Array): Int16Array {
  const output = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const sample = Math.max(-1, Math.min(1, input[i]));
    output[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return output;
}
