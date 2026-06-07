export type ChunkCallback = (contextId: string, audioBase64: string) => void;
export type DoneCallback = (contextId: string) => void;

export interface TTSProvider {
  connect(): Promise<void>;
  setCallbacks(onChunk: ChunkCallback, onDone: DoneCallback): void;
  createContext(): string;
  sendChunk(contextId: string, text: string, continueTurn: boolean): Promise<void>;
  finalizeContext(contextId: string): Promise<void>;
  cancelContext(contextId: string): void;
  disconnect(): void;
}
