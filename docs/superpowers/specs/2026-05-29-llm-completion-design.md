# LLM-Driven Inline Completion for vscode-beancount

## Overview

Add LLM-powered inline completion (ghost text) to the vscode-beancount extension, serving as a self-hosted alternative to GitHub Copilot's FIM feature. Uses OpenAI-compatible chat APIs (DeepSeek, OpenAI, Ollama, etc.) with prompt engineering to simulate fill-in-middle behavior.

## Goals

- Provide intelligent, context-aware beancount transaction completion via LLM
- Zero new npm dependencies — use native `fetch` (Node 18+)
- Reuse existing data pipeline (`beancheck.py` → `CompletionData`) for prompt context
- Maximize API prompt caching through static prefix ordering
- Coexist with existing `Completer` (traditional autocomplete) without conflict

## Non-Goals

- FIM-native model support (DeepSeek Coder, StarCoder, etc.)
- Streaming responses (may be added later)
- Multi-file context beyond what `beancheck.py` already provides

---

## Architecture

### New Files

```
src/llm/
├── types.ts              # LlmConfig, Message types (~20 lines)
├── provider.ts           # chatCompletion() function (~60 lines)
├── contextBuilder.ts     # Prompt construction (~100 lines)
└── completionProvider.ts # InlineCompletionItemProvider (~180 lines)
```

### Modified Files

```
src/extension.ts          # +15 lines: register InlineCompletionProvider, init LLM config
package.json              # +40 lines: new configuration properties, bump version/publisher
```

### Data Flow

```
beancheck.py (existing)
    ↓ runCmd() + JSON.parse (existing)
CompletionData { accounts, payees, narrations, tags, links }
    ↓ stored in Completer (existing)
    ↓ read by ContextBuilder (new)
System Prompt (static prefix + formatted account/payeelist)
    ↓
ContextBuilder.build(document, position)
    ↓ appends dynamic file context around cursor
User Prompt
    ↓
chatCompletion() — native fetch POST to OpenAI-compatible API
    ↓
LLM response text
    ↓
InlineCompletionItem → VS Code ghost text
```

---

## Component Design

### 1. Types (`src/llm/types.ts`)

```typescript
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
```

### 2. Provider (`src/llm/provider.ts`)

Single function, no classes. Wraps native `fetch` for OpenAI-compatible `/chat/completions` endpoint.

```typescript
export async function chatCompletion(
  config: LlmConfig,
  messages: ChatMessage[],
  signal?: AbortSignal
): Promise<string> {
  const res = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages,
      max_tokens: config.maxTokens,
      temperature: 0.2,
    }),
    signal,
  });

  if (!res.ok) {
    const error = await res.text();
    throw new Error(`LLM API error ${res.status}: ${error}`);
  }

  const data = await res.json();
  return data.choices[0].message.content.trim();
}
```

Key decisions:
- No streaming initially — simpler implementation, ghost text appears all at once
- `temperature: 0.2` for deterministic completions
- AbortSignal support for request cancellation
- Error propagation to VS Code output channel

### 3. Context Builder (`src/llm/contextBuilder.ts`)

Reads from existing `Completer` instance to build prompts.

```typescript
export class ContextBuilder {
  constructor(private completer: Completer) {}

  // Static prefix: same every request → cacheable
  buildSystemPrompt(): string {
    const accounts = Object.keys(this.completer.accounts)
      .filter(name => !this.completer.accounts[name].close)
      .join("\n");
    const payees = this.completer.payees.join(", ");
    const commodities = this.completer.commodities.join(", ");

    return `You are an expert beancount accountant. Generate ONLY the next few lines of a beancount entry. Output raw beancount syntax — no markdown, no explanation, no code fences.

## Known Accounts
${accounts}

## Known Payees
${payees}

## Known Commodities
${commodities}

## Beancount Rules
- Date format: YYYY-MM-DD
- Flag: * (cleared) or ! (pending)
- Posting indentation: 2 spaces
- Amount format: NUMBER CURRENCY
- Negative amounts use minus sign
- One posting per line
- Transaction format: DATE FLAG [PAYEE] "NARRATION"
- Posting format:   ACCOUNT  AMOUNT CURRENCY`;
  }

  // Dynamic: current file context around cursor
  buildUserPrompt(document: TextDocument, position: Position): string {
    const maxCtx = vscode.workspace.getConfiguration("beancount")
      .get<number>("llm.maxContextLines", 40);

    const startLine = Math.max(0, position.line - maxCtx);
    const endLine = Math.min(document.lineCount - 1, position.line + 10);

    const prefix = this.getLines(document, startLine, position.line);
    const suffix = this.getLines(document, position.line + 1, endLine);

    return `### Context (line ${position.line + 1}):\n${prefix}<<<CURSOR>>>\n${suffix}\n\nComplete the entry at <<<CURSOR>>>:`;
  }

  private getLines(doc: TextDocument, start: number, end: number): string {
    const lines: string[] = [];
    for (let i = start; i <= end && i < doc.lineCount; i++) {
      lines.push(doc.lineAt(i).text);
    }
    return lines.join("\n") + "\n";
  }
}
```

Prompt structure for cache optimization:
```
[System — ~1500 token, static across requests]
Rules + Account list + Payee list

[User — ~500 token, changes per request]
File context with <<<CURSOR>>> marker
```

### 4. Completion Provider (`src/llm/completionProvider.ts`)

```typescript
export class LlmCompletionProvider implements vscode.InlineCompletionItemProvider {
  private contextBuilder: ContextBuilder;
  private config: LlmConfig;
  private debounceTimer: NodeJS.Timeout | undefined;
  private pendingRequest: vscode.CancellationTokenSource | undefined;

  constructor(extension: Extension) {
    this.contextBuilder = new ContextBuilder(extension.completer);
    this.config = this.loadConfig();
  }

  provideInlineCompletionItems(
    document: TextDocument,
    position: Position,
    context: InlineCompletionContext,
    token: CancellationToken
  ): ProviderResult<InlineCompletionItem[]> {
    if (!this.config.enabled) return [];
    if (this.shouldSkip(document, position)) return [];

    // Cancel previous pending request
    this.pendingRequest?.cancel();
    this.pendingRequest = new CancellationTokenSource();

    return new Promise((resolve) => {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(async () => {
        try {
          const systemPrompt = this.contextBuilder.buildSystemPrompt();
          const userPrompt = this.contextBuilder.buildUserPrompt(document, position);

          const text = await chatCompletion(
            this.config,
            [
              { role: "system", content: systemPrompt },
              { role: "user", content: userPrompt },
            ],
            this.pendingRequest!.token
          );

          // Clean LLM output: strip markdown fences if present
          const cleaned = text.replace(/^```(?:beancount)?\n?/, "").replace(/\n?```$/, "");

          resolve([new InlineCompletionItem(cleaned)]);
        } catch (err) {
          if (err instanceof Error && err.name === "AbortError") {
            resolve([]); // Request cancelled
          } else {
            // Log error to output channel, resolve empty
            resolve([]);
          }
        }
      }, this.config.debounceMs);
    });
  }

  private shouldSkip(document: TextDocument, position: Position): boolean {
    const lineText = document.lineAt(position.line).text;

    // Comment lines
    if (lineText.trimStart().startsWith(";")) return true;

    // Directive lines (option/include/plugin)
    if (/^\s*(option|include|plugin|pushaccount|popaccount)\s/.test(lineText)) return true;

    // Empty lines at cursor
    if (lineText.trim() === "") return true;

    // Inside quotes (let traditional completer handle)
    const textBefore = lineText.substring(0, position.character);
    const quoteCount = (textBefore.match(/"/g) || []).length;
    if (quoteCount % 2 === 1) return true;

    return false;
  }

  private loadConfig(): LlmConfig {
    const cfg = vscode.workspace.getConfiguration("beancount");
    return {
      apiKey: cfg.get<string>("llm.apiKey", ""),
      model: cfg.get<string>("llm.model", "deepseek-chat"),
      baseUrl: cfg.get<string>("llm.baseUrl", "https://api.deepseek.com/v1"),
      maxTokens: cfg.get<number>("llm.maxTokens", 150),
      enabled: cfg.get<boolean>("llm.enabled", false),
      debounceMs: cfg.get<number>("llm.debounceMs", 300),
      maxContextLines: cfg.get<number>("llm.maxContextLines", 40),
    };
  }
}
```

### 5. Extension Registration (`src/extension.ts` changes)

```diff
+ import { LlmCompletionProvider } from "./llm/completionProvider";

  export function activate(context: vscode.ExtensionContext) {
    const extension = new Extension(context);
    // ... existing registrations ...

+   // LLM inline completion
+   const llmCompletionProvider = new LlmCompletionProvider(extension);
+   context.subscriptions.push(
+     vscode.languages.registerInlineCompletionItemProvider(
+       beancountDocumentSelector,
+       llmCompletionProvider
+     )
+   );
  }
```

### 6. Package.json Configuration

New properties under `contributes.configuration.properties`:

```json
"beancount.llm.enabled": {
  "type": "boolean",
  "default": false,
  "description": "Enable LLM-powered inline completion."
},
"beancount.llm.apiKey": {
  "type": "string",
  "default": "",
  "description": "API key for the OpenAI-compatible LLM provider."
},
"beancount.llm.baseUrl": {
  "type": "string",
  "default": "https://api.deepseek.com/v1",
  "description": "Base URL for OpenAI-compatible chat completions API."
},
"beancount.llm.model": {
  "type": "string",
  "default": "deepseek-chat",
  "description": "Model name for LLM completion (e.g. deepseek-chat, gpt-4o-mini)."
},
"beancount.llm.maxTokens": {
  "type": "integer",
  "default": 150,
  "description": "Maximum tokens for LLM to generate per completion."
},
"beancount.llm.debounceMs": {
  "type": "integer",
  "default": 300,
  "description": "Debounce delay in milliseconds before triggering LLM completion."
},
"beancount.llm.maxContextLines": {
  "type": "integer",
  "default": 40,
  "description": "Number of lines before cursor to include as context."
}
```

Identity changes for local development:

```diff
- "name": "beancount",
+ "name": "beancount-dev",
- "publisher": "Lencerf",
+ "publisher": "sason",
- "displayName": "Beancount",
+ "displayName": "Beancount (Dev)",
- "version": "0.14.0",
+ "version": "0.15.0"
```

---

## Smart Skip Logic

`LlmCompletionProvider.shouldSkip()` returns `true` (no LLM call) for:

| Condition | Reason |
|-----------|--------|
| Comment line (`;` prefix) | No need for completion |
| Directive lines (`option`, `include`, `plugin`) | Structured, traditional completion handles |
| Empty line at cursor | Ambiguous intent |
| Cursor inside quotes (`"..."`) | Traditional completer handles payee/narration |

This ensures LLM API calls only happen when they provide value.

---

## Cost Estimate

Using DeepSeek (`deepseek-chat`):
- Static prefix: ~1500 token (cached at 10% cost after first call)
- Dynamic context: ~500 token
- Generated output: ~50 token
- Per request: ~¥0.0003
- 2000 requests/month: **~¥0.6/month**

Using OpenAI (`gpt-4o-mini`):
- Per request: ~$0.0001
- 2000 requests/month: **~$0.20/month**

---

## Implementation Order

1. `src/llm/types.ts` — type definitions
2. `src/llm/provider.ts` — fetch wrapper
3. `src/llm/contextBuilder.ts` — prompt construction
4. `src/llm/completionProvider.ts` — VS Code integration
5. `src/extension.ts` — register provider
6. `package.json` — config properties + identity changes
7. Manual testing with DeepSeek API key

---

## Testing

- Unit: `ContextBuilder.buildSystemPrompt()` output format
- Unit: `shouldSkip()` logic for various line types
- Integration: Manual test with `.beancount` file, verify ghost text appears
- Integration: Verify traditional completer still works (tags, accounts, etc.)
- Edge cases: empty file, cursor at line start/end, very long lines
