// src/llm/types.ts

export interface LlmConfig {
  apiKey: string;
  model: string;
  baseUrl: string;
  maxTokens: number;
  enabled: boolean;
  debounceMs: number;
  maxContextLines: number;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface UsageInfo {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
}
