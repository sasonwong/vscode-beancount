import { LlmConfig, ChatMessage, UsageInfo } from "./types";

export interface LlmResult {
  content: string;
  usage: UsageInfo;
}

export async function chatCompletion(
  config: LlmConfig,
  messages: ChatMessage[],
  signal?: AbortSignal
): Promise<LlmResult> {
  const url = `${config.baseUrl.replace(/\/+$/, "")}/chat/completions`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages,
      max_tokens: config.maxTokens,
      temperature: 0.2,
      thinking: { type: "disabled" },
    }),
    signal,
  });

  if (!res.ok) {
    const errorBody = await res.text();
    throw new Error(`LLM API error ${res.status}: ${errorBody}`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data: any = await res.json();

  if (!data.choices || data.choices.length === 0) {
    throw new Error("LLM returned no choices");
  }

  const content = data.choices[0]?.message?.content;
  if (typeof content !== "string") {
    throw new Error("LLM returned invalid response structure");
  }

  const usage = data.usage || {};
  return {
    content: content.trim(),
    usage: {
      promptTokens: usage.prompt_tokens ?? 0,
      completionTokens: usage.completion_tokens ?? 0,
      totalTokens: usage.total_tokens ?? 0,
      cacheHitTokens: usage.prompt_cache_hit_tokens ?? 0,
      cacheMissTokens: usage.prompt_cache_miss_tokens ?? 0,
    },
  };
}
