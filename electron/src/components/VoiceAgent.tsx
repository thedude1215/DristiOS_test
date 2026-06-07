import { useState, useCallback, useEffect, useRef, type FormEvent } from "react";
import { useSocket } from "@/hooks/useSocket";
import { useDeepgramSTT } from "@/hooks/useDeepgramSTT";
import { useAudioPlayer } from "@/hooks/useAudioPlayer";
import { MicButton } from "./MicButton";
import { StatusIndicator } from "./StatusIndicator";
import { Transcript } from "./Transcript";
import type { AgentState, TranscriptEntry } from "@/lib/types";

export function VoiceAgent() {
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [streamingText, setStreamingText] = useState("");
  const [agentState, setAgentState] = useState<AgentState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [draftMessage, setDraftMessage] = useState("");

  const streamingTextRef = useRef("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const messageCountRef = useRef(0);

  const {
    isConnected,
    sendMessage,
    stopAudio,
    serverState,
    onAssistantText,
    onAudioChunk,
    onAudioDone,
    onError,
    onConsoleLog,
    socketRef,
  } = useSocket();

  const { playChunk, stopPlayback, initAudio, isPlaying } = useAudioPlayer();

  const showError = useCallback((message: string) => {
    setError(message);
    setTimeout(() => setError(null), 5000);
  }, []);

  // Stable refs for functions used in barge-in callback
  const stopAudioRef = useRef(stopAudio);
  const stopPlaybackRef = useRef(stopPlayback);
  const sendMessageRef = useRef(sendMessage);
  const isPlayingRef = useRef(isPlaying);
  useEffect(() => {
    stopAudioRef.current = stopAudio;
    stopPlaybackRef.current = stopPlayback;
    sendMessageRef.current = sendMessage;
    isPlayingRef.current = isPlaying;
  }, [stopAudio, stopPlayback, sendMessage, isPlaying]);

  // Instant barge-in: any speech detected → kill audio immediately
  const handleBargeIn = useCallback(() => {
    // Only act if audio is actually playing
    if (!isPlayingRef.current()) return;

    // Stop local audio playback instantly
    stopPlaybackRef.current();

    // Tell server to abort pipeline (stops LLM + TTS)
    stopAudioRef.current();

    // Finalize any in-progress streaming assistant text
    const pendingText = streamingTextRef.current;
    if (pendingText) {
      setEntries((prev) => [...prev, {
        id: crypto.randomUUID(),
        role: "assistant",
        text: pendingText,
        timestamp: Date.now(),
      }]);
      setStreamingText("");
      streamingTextRef.current = "";
    }
  }, []);

  const submitUserMessage = useCallback((text: string) => {
    if (!text.trim()) return;
    const trimmed = text.trim();
    messageCountRef.current++;
    console.log("[VoiceAgent] Sending message (#" + messageCountRef.current + "):", trimmed);

    const entry: TranscriptEntry = {
      id: crypto.randomUUID(),
      role: "user",
      text: trimmed,
      timestamp: Date.now(),
    };
    setEntries((prev) => [...prev, entry]);

    sendMessageRef.current(trimmed);
  }, []);

  // On final transcript — send the complete user message
  const handleFinalTranscript = useCallback((text: string) => {
    submitUserMessage(text);
  }, [submitUserMessage]);

  const handleTextSubmit = useCallback((event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = draftMessage.trim();
    if (!text || !isConnected) return;

    if (isPlayingRef.current()) {
      handleBargeIn();
    }

    setDraftMessage("");
    submitUserMessage(text);
  }, [draftMessage, handleBargeIn, isConnected, submitUserMessage]);

  const {
    isListening,
    interimTranscript,
    startListening,
    stopListening,
    isSupported,
    isMuted,
    toggleMute,
  } = useDeepgramSTT(handleFinalTranscript, handleBargeIn, socketRef, showError);

  // Wire up socket event handlers
  useEffect(() => {
    onAssistantText((text, done) => {
      console.log("[VoiceAgent] assistant_text:", { text: text.slice(0, 80), done });
      if (done) {
        const finalText = streamingTextRef.current;
        if (finalText) {
          const entry: TranscriptEntry = {
            id: crypto.randomUUID(),
            role: "assistant",
            text: finalText,
            timestamp: Date.now(),
          };
          setEntries((prev) => [...prev, entry]);
          setStreamingText("");
          streamingTextRef.current = "";
        }
      } else {
        streamingTextRef.current += text;
        setStreamingText(streamingTextRef.current);
      }
    });

    onAudioChunk((data) => {
      console.log("[VoiceAgent] audio_chunk received, length:", data.length);
      playChunk(data);
    });

    onAudioDone(() => {
      console.log("[VoiceAgent] audio_done");
    });

    onError((message) => {
      console.error("[VoiceAgent] error:", message);
      showError(message);
    });

    onConsoleLog((message) => {
      console.log("[VoiceAgent] console_log:", message);
      setEntries((prev) => [...prev, {
        id: crypto.randomUUID(),
        role: "console",
        text: message,
        timestamp: Date.now(),
      }]);
    });
  }, [onAssistantText, onAudioChunk, onAudioDone, onError, onConsoleLog, playChunk, showError]);

  // Derive combined state
  useEffect(() => {
    let next: AgentState;
    if (serverState === "thinking" || serverState === "speaking") {
      next = serverState;
    } else if (isListening) {
      next = "listening";
    } else {
      next = "idle";
    }
    setAgentState(next);
  }, [isListening, serverState]);

  // Auto-scroll chat log to bottom
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [entries, streamingText]);

  // Initialize audio context when connected (STT starts closed — user clicks mic to begin)
  const prevConnectedRef = useRef(false);
  useEffect(() => {
    if (isConnected && !prevConnectedRef.current) {
      console.log("[VoiceAgent] Connected — initializing audio (STT off until mic click)");
      initAudio();
    }
    prevConnectedRef.current = isConnected;
  }, [isConnected, initAudio]);

  const handleMicClick = useCallback(() => {
    console.log("[VoiceAgent] Mic click:", { isConnected, isSupported, isListening });
    initAudio();
    if (!isConnected) {
      showError("Voice server is still connecting. Try the mic again in a moment.");
      return;
    }
    if (!isSupported) {
      showError("Microphone capture is not supported in this window.");
      return;
    }
    if (isListening) {
      stopListening();
    } else {
      startListening();
    }
  }, [isConnected, isListening, isSupported, showError, startListening, stopListening, initAudio]);

  return (
    <div style={{ 
      width: '700px', 
      height: '350px', 
      display: 'flex', 
      flexDirection: 'column',
      position: 'relative',
      background: 'transparent',
      overflow: 'hidden',
    }}>
      {/* Title - top left */}
      <div style={{ 
        position: 'absolute',
        top: '16px',
        left: '16px',
        zIndex: 20,
        pointerEvents: 'none'
      }}>
        <span style={{ 
          color: 'rgba(255, 255, 255, 0.5)', 
          fontSize: '13px', 
          fontWeight: '500',
          letterSpacing: '-0.4px',
          fontFamily: '"SF Pro Rounded", "SF Pro Display", "SF Pro Text", -apple-system, BlinkMacSystemFont, system-ui, sans-serif',
          textShadow: '0 1px 3px rgba(0,0,0,0.5)'
        }}>
        VisionOS
        </span>
      </div>

      {/* Status dot - top right */}
      <div style={{ 
        position: 'absolute',
        top: '16px',
        right: '16px',
        zIndex: 20,
        pointerEvents: 'none'
      }}>
        <div style={{
          width: '10px',
          height: '10px',
          borderRadius: '50%',
          background: isListening ? '#10b981' : (isConnected ? '#6b7280' : '#ef4444'),
          boxShadow: isListening ? '0 0 12px rgba(16, 185, 129, 0.8)' : 'none',
        }} />
      </div>

      {/* Draggable area - top bar */}
      <div 
        className="drag-region"
        style={{ 
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          height: '50px',
          zIndex: 10,
          cursor: 'move',
          pointerEvents: 'auto'
        }}
      />

      {/* Content area */}
      <div 
        ref={scrollRef}
        style={{ 
          position: 'absolute',
          top: '45px',
          left: 0,
          right: 0,
          bottom: '72px',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: (interimTranscript || (entries.length === 0 && !streamingText)) ? 'center' : 'flex-end',
          alignItems: (interimTranscript || (entries.length === 0 && !streamingText)) ? 'center' : 'stretch',
          padding: '8px 24px 8px 24px',
          overflowY: 'auto',
          overflowX: 'hidden',
          zIndex: 5,
        }} 
        className="custom-scrollbar"
      >

        {/* Live speech */}
        {interimTranscript ? (
          <div style={{ 
            textAlign: 'center',
            color: 'white',
            fontSize: '20px',
            fontWeight: '300',
            opacity: 0.85,
            textShadow: '0 2px 4px rgba(0,0,0,0.8)',
            maxWidth: '580px',
            lineHeight: '1.4',
            alignSelf: 'center',
            fontFamily: '"SF Pro Rounded", "SF Pro Display", -apple-system, BlinkMacSystemFont, system-ui, sans-serif',
          }}>
            {interimTranscript}
          </div>
        ) : entries.length === 0 && !streamingText ? (
          /* Greeting when no conversation yet */
          <div style={{ 
            textAlign: 'center',
            color: 'white',
            fontSize: '28px',
            fontWeight: '300',
            opacity: 0.9,
            textShadow: '0 2px 4px rgba(0,0,0,0.8)',
            alignSelf: 'center',
            fontFamily: '"SF Pro Rounded", "SF Pro Display", -apple-system, BlinkMacSystemFont, system-ui, sans-serif',
          }}>
            Hello, Jordan.
          </div>
        ) : (
          /* Chat log */
          <div style={{ 
            display: 'flex', 
            flexDirection: 'column', 
            gap: '6px',
            width: '100%',
          }}>
            {entries.map((entry) => (
              <div
                key={entry.id}
                style={{
                  display: 'flex',
                  justifyContent: entry.role === 'user' ? 'flex-end' : 'flex-start',
                }}
              >
                {entry.role === 'console' ? (
                  <div style={{
                    padding: '2px 0',
                    fontSize: '11px',
                    color: 'rgba(255,255,255,0.4)',
                    fontStyle: 'italic',
                    lineHeight: '1.4',
                    maxWidth: '90%',
                    textShadow: '0 1px 2px rgba(0,0,0,0.3)',
                    fontWeight: '400',
                  }}>
                    {entry.text}
                  </div>
                ) : (
                  <div style={{
                    padding: '6px 12px',
                    borderRadius: '12px',
                    fontSize: '13px',
                    color: entry.role === 'user' ? 'rgba(255,255,255,0.7)' : 'rgba(255,255,255,0.9)',
                    background: entry.role === 'user' 
                      ? 'rgba(255, 255, 255, 0.08)' 
                      : 'rgba(255, 255, 255, 0.12)',
                    lineHeight: '1.5',
                    maxWidth: '80%',
                    textShadow: '0 1px 2px rgba(0,0,0,0.4)',
                    fontWeight: '400',
                  }}>
                    {entry.text}
                  </div>
                )}
              </div>
            ))}

            {/* Streaming assistant response — appears as latest bubble */}
            {streamingText && (
              <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
                <div style={{
                  padding: '6px 12px',
                  borderRadius: '12px',
                  fontSize: '13px',
                  color: 'rgba(255,255,255,0.9)',
                  background: 'rgba(255, 255, 255, 0.12)',
                  lineHeight: '1.5',
                  maxWidth: '80%',
                  textShadow: '0 1px 2px rgba(0,0,0,0.4)',
                  fontWeight: '400',
                }}>
                  {streamingText}
                  <span style={{ 
                    display: 'inline-block', 
                    width: '2px', 
                    height: '14px', 
                    background: 'white',
                    marginLeft: '4px',
                    verticalAlign: 'middle',
                    animation: 'blink 1s infinite'
                  }} />
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Bottom controls - text input + mic + mute */}
      <div
        className="no-drag"
        style={{
          position: 'absolute',
          bottom: '16px',
          left: '50%',
          transform: 'translateX(-50%)',
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
          pointerEvents: 'auto',
          zIndex: 20,
          width: 'calc(100% - 48px)',
        }}
      >
        <form
          onSubmit={handleTextSubmit}
          style={{
            flex: 1,
            height: '44px',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            borderRadius: '22px',
            padding: '0 8px 0 16px',
            background: 'rgba(255, 255, 255, 0.12)',
            border: '1px solid rgba(255, 255, 255, 0.22)',
            backdropFilter: 'blur(14px)',
            boxShadow: '0 2px 12px rgba(0,0,0,0.24)',
            minWidth: 0,
          }}
        >
          <input
            value={draftMessage}
            onChange={(event) => setDraftMessage(event.target.value)}
            disabled={!isConnected}
            placeholder={isConnected ? "Type a message" : "Connecting..."}
            style={{
              flex: 1,
              minWidth: 0,
              height: '100%',
              border: 0,
              outline: 0,
              background: 'transparent',
              color: 'rgba(255,255,255,0.92)',
              fontSize: '13px',
              fontFamily: '"SF Pro Rounded", "SF Pro Display", -apple-system, BlinkMacSystemFont, system-ui, sans-serif',
            }}
          />
          <button
            type="submit"
            disabled={!isConnected || !draftMessage.trim()}
            style={{
              width: '32px',
              height: '32px',
              borderRadius: '50%',
              border: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: isConnected && draftMessage.trim() ? 'pointer' : 'not-allowed',
              opacity: isConnected && draftMessage.trim() ? 1 : 0.45,
              background: 'rgba(255,255,255,0.24)',
              color: 'white',
              padding: 0,
            }}
            aria-label="Send message"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <path d="m22 2-7 20-4-9-9-4Z" />
              <path d="M22 2 11 13" />
            </svg>
          </button>
        </form>

        {/* Mute button - only visible when listening */}
        {isListening && (
          <div
            onClick={toggleMute}
            style={{
              width: '38px',
              height: '38px',
              borderRadius: '50%',
              background: isMuted ? 'rgba(234, 179, 8, 0.35)' : 'rgba(255, 255, 255, 0.12)',
              backdropFilter: 'blur(12px)',
              border: isMuted ? '2px solid rgba(234, 179, 8, 0.6)' : '2px solid rgba(255, 255, 255, 0.25)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              transition: 'all 0.3s ease',
              boxShadow: isMuted ? '0 0 16px rgba(234, 179, 8, 0.4)' : '0 2px 8px rgba(0,0,0,0.2)',
            }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              {isMuted ? (
                <>
                  <line x1="1" y1="1" x2="23" y2="23" />
                  <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6" />
                  <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2c0 .76-.12 1.5-.35 2.18" />
                  <line x1="12" y1="19" x2="12" y2="22" />
                  <line x1="8" y1="22" x2="16" y2="22" />
                </>
              ) : (
                <>
                  <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
                  <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                  <line x1="12" y1="19" x2="12" y2="22" />
                  <line x1="8" y1="22" x2="16" y2="22" />
                </>
              )}
            </svg>
          </div>
        )}

        {/* Mic button */}
        <button
          type="button"
          onClick={handleMicClick}
          aria-label={isListening ? "Stop listening" : "Start listening"}
          title={isListening ? "Stop listening" : "Start listening"}
          style={{
            cursor: isConnected ? 'pointer' : 'not-allowed',
            opacity: isConnected ? 1 : 0.5,
            width: '50px',
            height: '50px',
            flex: '0 0 50px',
            border: 0,
            borderRadius: '50%',
            background: 'transparent',
            color: 'white',
            padding: 0,
          }}
        >
          <div style={{
            width: '50px',
            height: '50px',
            flex: '0 0 50px',
            borderRadius: '50%',
            background: isListening ? 'rgba(239, 68, 68, 0.4)' : 'rgba(255, 255, 255, 0.2)',
            backdropFilter: 'blur(12px)',
            border: '2px solid rgba(255, 255, 255, 0.4)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            transition: 'all 0.3s ease',
            boxShadow: isListening ? '0 0 24px rgba(239, 68, 68, 0.6)' : '0 4px 12px rgba(0,0,0,0.3)'
          }}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              {isListening ? (
                <rect x="9" y="9" width="6" height="6" />
              ) : (
                <>
                  <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
                  <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                  <line x1="12" y1="19" x2="12" y2="22" />
                  <line x1="8" y1="22" x2="16" y2="22" />
                </>
              )}
            </svg>
          </div>
        </button>
      </div>

      {error && (
        <div style={{
          position: 'absolute',
          bottom: '80px',
          left: '50%',
          transform: 'translateX(-50%)',
          padding: '10px 16px',
          background: 'rgba(239, 68, 68, 0.9)',
          backdropFilter: 'blur(12px)',
          border: '1px solid rgba(239, 68, 68, 0.6)',
          borderRadius: '10px',
          color: 'white',
          fontSize: '12px',
          fontWeight: '500',
          boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
          whiteSpace: 'nowrap',
          zIndex: 20
        }}>
          {error}
        </div>
      )}
    </div>
  );
}
