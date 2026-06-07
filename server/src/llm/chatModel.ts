import { ChatAnthropic } from "@langchain/anthropic";
import { ChatOpenAI } from "@langchain/openai";

interface ChatModelOptions {
  openAIModel: string;
  anthropicModel?: string;
  temperature: number;
  maxTokens: number;
}

export function createChatModel(options: ChatModelOptions) {
  if (process.env.OPENAI_API_KEY) {
    return new ChatOpenAI({
      model: options.openAIModel,
      temperature: options.temperature,
      maxTokens: options.maxTokens,
    });
  }

  if (process.env.ANTHROPIC_API_KEY) {
    return new ChatAnthropic({
      model: options.anthropicModel ?? "claude-sonnet-4-5-20250929",
      temperature: options.temperature,
      maxTokens: options.maxTokens,
      apiKey: process.env.ANTHROPIC_API_KEY,
    });
  }

  throw new Error("No chat model API key configured. Set OPENAI_API_KEY or ANTHROPIC_API_KEY.");
}

export function getChatModelProviderName(): "openai" | "anthropic" | "missing" {
  if (process.env.OPENAI_API_KEY) return "openai";
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  return "missing";
}
