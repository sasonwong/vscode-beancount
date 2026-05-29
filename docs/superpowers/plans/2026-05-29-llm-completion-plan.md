# LLM Inline Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add LLM-powered ghost text completion to vscode-beancount using OpenAI-compatible chat APIs.

**Architecture:** Four new TypeScript files under `src/llm/` (types, provider, contextBuilder, completionProvider) + minimal changes to `extension.ts` and `package.json`. Zero new npm dependencies — uses native `fetch`.

**Tech Stack:** TypeScript, VS Code Extension API (`InlineCompletionItemProvider`), native `fetch`, existing `Completer` data pipeline.

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src/llm/types.ts` | Create | `LlmConfig` and `ChatMessage` interfaces |
| `src/llm/provider.ts` | Create | `chatCompletion()` — native fetch wrapper for OpenAI-compatible API |
| `src/llm/contextBuilder.ts` | Create | `ContextBuilder` — builds system prompt (static) and user prompt (dynamic) |
| `src/llm/completionProvider.ts` | Create | `LlmCompletionProvider` — VS Code `InlineCompletionItemProvider` with debounce, skip logic |
| `src/extension.ts` | Modify | Import and register `LlmCompletionProvider` (~10 lines) |
| `package.json` | Modify | Add 7 `beancount.llm.*` config properties, bump version/publisher for local dev |

---

### Task 1: Create `src/llm/types.ts`

**Files:**
- Create: `src/llm/types.ts`

- [ ] **Step 1: Create the llm directory and types file**

```bash
mkdir -p src/llm
```

- [ ] **Step 2: Write types.ts**

```typescript
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
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npx tsc --noEmit src/llm/types.ts
```

Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add src/llm/types.ts
git commit -m "feat(llm): add type definitions for LLM config and chat messages"
```

---

### Task 2: Create `src/llm/provider.ts`

**Files:**
- Create: `src/llm/provider.ts`
- Reference: `src/llm/types.ts` (LlmConfig, ChatMessage)

- [ ] **Step 1: Write provider.ts**

```typescript
// src/llm/provider.ts

import { LlmConfig, ChatMessage } from "./types";

export async function chatCompletion(
  config: LlmConfig,
  messages: ChatMessage[],
  signal?: AbortSignal
): Promise<string> {
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

  return data.choices[0].message.content.trim();
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit src/llm/provider.ts
```

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/llm/provider.ts
git commit -m "feat(llm): add OpenAI-compatible chat completion provider"
```

---

### Task 3: Create `src/llm/contextBuilder.ts`

**Files:**
- Create: `src/llm/contextBuilder.ts`
- Reference: `src/completer.ts` (Completer class, accounts/payees/commodities fields)

- [ ] **Step 1: Write contextBuilder.ts**

```typescript
// src/llm/contextBuilder.ts

import * as vscode from "vscode";
import { TextDocument, Position } from "vscode";
import { Completer } from "../completer";

export class ContextBuilder {
  constructor(private completer: Completer) {}

  /**
   * Build the system prompt — static across requests for cache optimization.
   * Contains account list, payee list, and beancount syntax rules.
   */
  buildSystemPrompt(): string {
    const openAccounts = Object.keys(this.completer.accounts)
      .filter((name) => {
        const acct = this.completer.accounts[name];
        return !acct.close || acct.close === "";
      })
      .join("\n");

    const payees =
      this.completer.payees.length > 0
        ? this.completer.payees.join(", ")
        : "(none yet)";

    const commodities =
      this.completer.commodities.length > 0
        ? this.completer.commodities.join(", ")
        : "(none yet)";

    return `You are an expert beancount accountant. Generate ONLY the next few lines of a beancount entry. Output raw beancount syntax — no markdown, no explanation, no code fences.

## Known Accounts
${openAccounts}

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

  /**
   * Build the user prompt — dynamic, includes file context around cursor.
   */
  buildUserPrompt(document: TextDocument, position: Position): string {
    const maxCtx = vscode.workspace
      .getConfiguration("beancount")
      .get<number>("llm.maxContextLines", 40);

    const startLine = Math.max(0, position.line - maxCtx);
    const endLine = Math.min(document.lineCount - 1, position.line + 10);

    const prefix = this.getLines(document, startLine, position.line);
    const suffix = this.getLines(document, position.line + 1, endLine);

    return `### Context (line ${position.line + 1}):\n${prefix}<<<CURSOR>>>\n${suffix}\n\nComplete the entry at <<<CURSOR>>>:`;
  }

  private getLines(
    doc: TextDocument,
    start: number,
    end: number
  ): string {
    const lines: string[] = [];
    for (let i = start; i <= end && i < doc.lineCount; i++) {
      lines.push(doc.lineAt(i).text);
    }
    return lines.join("\n") + "\n";
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit src/llm/contextBuilder.ts
```

Expected: No errors (imports `Completer` from `../completer`).

- [ ] **Step 3: Commit**

```bash
git add src/llm/contextBuilder.ts
git commit -m "feat(llm): add context builder for LLM prompts"
```

---

### Task 4: Create `src/llm/completionProvider.ts`

**Files:**
- Create: `src/llm/completionProvider.ts`
- Reference: `src/llm/types.ts`, `src/llm/provider.ts`, `src/llm/contextBuilder.ts`, `src/extension.ts` (Extension class)

- [ ] **Step 1: Write completionProvider.ts**

```typescript
// src/llm/completionProvider.ts

import * as vscode from "vscode";
import {
  InlineCompletionItem,
  InlineCompletionContext,
  InlineCompletionItemProvider,
  ProviderResult,
  TextDocument,
  Position,
  CancellationToken,
  CancellationTokenSource,
} from "vscode";
import { Extension } from "../extension";
import { LlmConfig } from "./types";
import { chatCompletion } from "./provider";
import { ContextBuilder } from "./contextBuilder";

export class LlmCompletionProvider implements InlineCompletionItemProvider {
  private contextBuilder: ContextBuilder;
  private config: LlmConfig;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private pendingRequest: CancellationTokenSource | undefined;
  private logger: vscode.OutputChannel;

  constructor(extension: Extension) {
    this.contextBuilder = new ContextBuilder(extension.completer);
    this.config = this.loadConfig();
    this.logger = extension.logger;
  }

  provideInlineCompletionItems(
    document: TextDocument,
    position: Position,
    _context: InlineCompletionContext,
    _token: CancellationToken
  ): ProviderResult<InlineCompletionItem[]> {
    if (!this.config.enabled) {
      return [];
    }

    if (this.shouldSkip(document, position)) {
      return [];
    }

    // Cancel previous pending request
    this.pendingRequest?.cancel();
    this.pendingRequest = new CancellationTokenSource();

    return new Promise((resolve) => {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(async () => {
        try {
          const systemPrompt = this.contextBuilder.buildSystemPrompt();
          const userPrompt = this.contextBuilder.buildUserPrompt(
            document,
            position
          );

          this.logger.appendLine(
            `[LLM] Requesting completion at line ${position.line + 1}`
          );

          const text = await chatCompletion(
            this.config,
            [
              { role: "system", content: systemPrompt },
              { role: "user", content: userPrompt },
            ],
            this.pendingRequest!.token
          );

          // Clean LLM output: strip markdown fences if present
          const cleaned = text
            .replace(/^```(?:beancount)?\n?/, "")
            .replace(/\n?```$/, "");

          this.logger.appendLine(`[LLM] Got completion: ${cleaned.substring(0, 80)}...`);

          resolve([new InlineCompletionItem(cleaned)]);
        } catch (err) {
          if (
            err instanceof Error &&
            (err.name === "AbortError" || err.message.includes("abort"))
          ) {
            // Request cancelled — normal, resolve empty
            resolve([]);
          } else {
            const errMsg = err instanceof Error ? err.message : String(err);
            this.logger.appendLine(`[LLM] Error: ${errMsg}`);
            resolve([]);
          }
        }
      }, this.config.debounceMs);
    });
  }

  /**
   * Determines whether LLM completion should be skipped for this position.
   * Returns true for comments, directives, empty lines, and inside quotes.
   */
  private shouldSkip(document: TextDocument, position: Position): boolean {
    const lineText = document.lineAt(position.line).text;

    // Comment lines
    if (lineText.trimStart().startsWith(";")) {
      return true;
    }

    // Directive lines (option/include/plugin/etc.)
    if (
      /^\s*(option|include|plugin|pushaccount|popaccount|query|custom)\s/.test(
        lineText
      )
    ) {
      return true;
    }

    // Empty lines at cursor
    if (lineText.trim() === "") {
      return true;
    }

    // Inside quotes — let traditional completer handle payee/narration
    const textBefore = lineText.substring(0, position.character);
    const quoteCount = (textBefore.match(/"/g) || []).length;
    if (quoteCount % 2 === 1) {
      return true;
    }

    return false;
  }

  private loadConfig(): LlmConfig {
    const cfg = vscode.workspace.getConfiguration("beancount");
    return {
      apiKey: cfg.get<string>("llm.apiKey", ""),
      model: cfg.get<string>("llm.model", "deepseek-chat"),
      baseUrl: cfg.get<string>(
        "llm.baseUrl",
        "https://api.deepseek.com/v1"
      ),
      maxTokens: cfg.get<number>("llm.maxTokens", 150),
      enabled: cfg.get<boolean>("llm.enabled", false),
      debounceMs: cfg.get<number>("llm.debounceMs", 300),
      maxContextLines: cfg.get<number>("llm.maxContextLines", 40),
    };
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit src/llm/completionProvider.ts
```

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/llm/completionProvider.ts
git commit -m "feat(llm): add inline completion provider with debounce and skip logic"
```

---

### Task 5: Register LLM provider in `src/extension.ts`

**Files:**
- Modify: `src/extension.ts` (lines 1-12 imports, lines 13-97 activate function)

- [ ] **Step 1: Add import at top of extension.ts**

Add after line 11 (`import { HintsUpdater } from "./inlayHints";`):

```typescript
import { LlmCompletionProvider } from "./llm/completionProvider";
```

- [ ] **Step 2: Register the provider in activate()**

Add after the existing `registerCompletionItemProvider` block (after line 38), before the `registerHoverProvider` block:

```typescript
  // LLM inline completion
  const llmCompletionProvider = new LlmCompletionProvider(extension);
  context.subscriptions.push(
    vscode.languages.registerInlineCompletionItemProvider(
      beancountDocumentSelector,
      llmCompletionProvider
    )
  );
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add src/extension.ts
git commit -m "feat(llm): register LLM inline completion provider"
```

---

### Task 6: Update `package.json` — configuration and identity

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Update identity fields for local dev**

Change these fields at the top of package.json:

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

- [ ] **Step 2: Add LLM configuration properties**

Inside `contributes.configuration.properties`, add after the `beancount.inlayHints` entry (after line 92):

```json
"beancount.llm.enabled": {
  "type": "boolean",
  "default": false,
  "description": "Enable LLM-powered inline completion (ghost text)."
},
"beancount.llm.apiKey": {
  "type": "string",
  "default": "",
  "description": "API key for the OpenAI-compatible LLM provider."
},
"beancount.llm.baseUrl": {
  "type": "string",
  "default": "https://api.deepseek.com/v1",
  "description": "Base URL for OpenAI-compatible chat completions API (e.g. DeepSeek, OpenAI, Ollama)."
},
"beancount.llm.model": {
  "type": "string",
  "default": "deepseek-chat",
  "description": "Model name for LLM completion (e.g. deepseek-chat, gpt-4o-mini, qwen2.5-coder)."
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
  "description": "Number of lines before cursor to include as context in LLM prompt."
}
```

- [ ] **Step 3: Verify package.json is valid JSON**

```bash
node -e "JSON.parse(require('fs').readFileSync('package.json','utf8')); console.log('Valid JSON')"
```

Expected: `Valid JSON`

- [ ] **Step 4: Commit**

```bash
git add package.json
git commit -m "feat(llm): add LLM configuration properties and update package identity"
```

---

### Task 7: Build and verify

**Files:**
- None (verification only)

- [ ] **Step 1: Run full TypeScript compilation**

```bash
npm run compile
```

Expected: No errors, `dist/extension.js` is generated.

- [ ] **Step 2: Run ESLint**

```bash
npm run lint
```

Expected: No errors (or only pre-existing warnings).

- [ ] **Step 3: Package the extension**

```bash
npx vsce package --allow-missing-repository
```

Expected: `beancount-dev-0.15.0.vsix` is generated.

- [ ] **Step 4: Final commit (if any fixes needed)**

```bash
git add -A
git commit -m "fix(llm): address compilation and lint issues"
```

(Skip if no issues found.)

---

### Task 8: Manual testing guide

**Files:**
- None (manual testing)

- [ ] **Step 1: Install the packaged extension**

```bash
code --install-extension beancount-dev-0.15.0.vsix
```

- [ ] **Step 2: Configure API key**

Open VS Code Settings (Ctrl+,), search `Beancount LLM`, set:
- `beancount.llm.enabled`: true
- `beancount.llm.apiKey`: your DeepSeek API key

- [ ] **Step 3: Test basic completion**

Open a `.beancount` file, type a new transaction line:

```
2026-05-29 * "Starbucks" "
```

Wait 300ms — ghost text should appear suggesting the narration continuation and posting lines.

- [ ] **Step 4: Test skip logic**

- Type a comment line (`; test`) — no ghost text expected
- Type an empty line — no ghost text expected
- Type inside quotes — no ghost text expected
- Type a posting line (indented with account name) — ghost text expected

- [ ] **Step 5: Test coexistence with traditional completer**

- Press `Ctrl+Space` on a posting line — traditional account completion should still appear
- Ghost text should appear alongside the completion menu

- [ ] **Step 6: Check output channel**

Open Output panel → select "Beancount" channel, verify `[LLM]` log lines appear for requests and completions.

---

## Summary

| Task | New Lines | Files Changed |
|------|-----------|---------------|
| 1. types.ts | ~15 | 1 new |
| 2. provider.ts | ~40 | 1 new |
| 3. contextBuilder.ts | ~70 | 1 new |
| 4. completionProvider.ts | ~150 | 1 new |
| 5. extension.ts | ~10 | 1 modified |
| 6. package.json | ~45 | 1 modified |
| 7. Build verify | 0 | 0 |
| 8. Manual test | 0 | 0 |
| **Total** | **~330** | **4 new, 2 modified** |
