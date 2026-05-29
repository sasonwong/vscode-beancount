import * as vscode from "vscode";
import {
  InlineCompletionItem,
  InlineCompletionContext,
  InlineCompletionItemProvider,
  ProviderResult,
  TextDocument,
  Position,
  CancellationToken,
} from "vscode";
import { Extension } from "../extension";
import { LlmConfig } from "./types";
import { chatCompletion } from "./provider";
import { ContextBuilder } from "./contextBuilder";

export class LlmCompletionProvider implements InlineCompletionItemProvider {
  private contextBuilder: ContextBuilder;
  private config: LlmConfig;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private abortController: AbortController | undefined;
  private logger: vscode.OutputChannel;
  private lastPrefixStart: string = "";
  private extension: Extension;

  constructor(extension: Extension) {
    this.extension = extension;
    this.contextBuilder = new ContextBuilder(extension.completer);
    this.config = this.loadConfig();
    this.logger = extension.logger;
  }

  /** Reload config from settings (used when non-secret LLM settings change). */
  public reloadConfig(): void {
    this.config = this.loadConfig();
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
    this.abortController?.abort();
    this.abortController = new AbortController();

    return new Promise((resolve) => {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(async () => {
        try {
          const buildResult = this.contextBuilder.buildUserPrompt(
            document,
            position
          );

          if (!buildResult) {
            resolve([]);
            return;
          }

          const prefixUnchanged =
            buildResult.userPrompt.substring(0, 200) ===
            this.lastPrefixStart;

          this.logger.appendLine(
            `[LLM] Request  L${position.line + 1}` +
            `  context: ↑${buildResult.prefixLines}` +
            (buildResult.suffixLines > 0
              ? ` ↓${buildResult.suffixLines}`
              : ` (end of file)`) +
            (prefixUnchanged ? `  cached` : ``)
          );

          // Get API key from OS keychain (not from settings.json)
          const apiKey = await this.extension.getLlmApiKey();
          if (!apiKey) {
            this.logger.appendLine(
              '[LLM] No API key configured. Use "Beancount: Set LLM API Key" command.'
            );
            resolve([]);
            return;
          }

          const result = await chatCompletion(
            { ...this.config, apiKey },
            [
              { role: "system", content: buildResult.systemPrompt },
              { role: "user", content: buildResult.userPrompt },
            ],
            this.abortController!.signal
          );

          this.lastPrefixStart = buildResult.userPrompt.substring(0, 200);

          let completion = result.content
            .replace(/^```(?:beancount)?\n?/, "")
            .replace(/\n?```$/, "");

          // Overlap: if completion repeats the current line text before cursor, strip it
          const lineText = document.lineAt(position.line).text;
          const linePrefix = lineText.substring(0, position.character);
          if (linePrefix.trimEnd().length > 0 && completion.startsWith(linePrefix)) {
            completion = completion.slice(linePrefix.length);
          }

          // If at end of an indented posting line, ensure newline before completion
          if (
            lineText.trim().length > 0 &&
            lineText.startsWith(" ") &&
            position.character >= lineText.trimEnd().length &&
            !completion.startsWith("\n")
          ) {
            completion = "\n" + completion;
          }

          if (completion.length === 0) {
            resolve([]);
            return;
          }

          const u = result.usage;
          this.logger.appendLine(
            `[LLM] Response ${completion.length} chars` +
            `  prompt=${u.promptTokens} completion=${u.completionTokens} total=${u.totalTokens}` +
            (u.cacheHitTokens > 0
              ? `  cache hit +${u.cacheHitTokens}`
              : `  cache miss -${u.cacheMissTokens}`)
          );

          const inlineRange = new vscode.Range(position, position);
          resolve([new InlineCompletionItem(completion, inlineRange)]);
        } catch (err) {
          if (
            err instanceof Error &&
            (err.name === "AbortError" || err.message.includes("abort"))
          ) {
            resolve([]);
          } else {
            const errMsg = err instanceof Error ? err.message : String(err);
            this.logger.appendLine(`[LLM] Error: ${errMsg}`);
            vscode.window.showWarningMessage(`LLM completion: ${errMsg}`);
            resolve([]);
          }
        }
      }, this.config.debounceMs);
    });
  }

  private shouldSkip(document: TextDocument, position: Position): boolean {
    const lineText = document.lineAt(position.line).text;

    // Comment lines
    if (lineText.trimStart().startsWith(";")) {
      return true;
    }

    // Directive lines
    if (
      /^\s*(option|include|plugin|pushaccount|popaccount|query|custom)\s/.test(
        lineText
      )
    ) {
      return true;
    }

    // Empty line or whitespace-only (auto-indented by Enter)
    if (lineText.trim() === "") {
      if (position.line === 0) {
        return true;
      }
      const prevLine = document.lineAt(position.line - 1).text;
      if (prevLine.trim() === "") {
        return true;
      }
      // If line has only whitespace (auto-indent after posting), skip.
      // User must either type (to continue entry) or press Enter again (to end entry).
      if (lineText.length > 0 && prevLine.startsWith(" ")) {
        return true;
      }
      return false;
    }

    // Only trigger at end of line (cursor at or after non-whitespace content)
    if (position.character < lineText.trimEnd().length) {
      return true;
    }

    // Inside quotes — let traditional completer handle
    const textBefore = lineText.substring(0, position.character);
    const quoteCount = (textBefore.match(/"/g) || []).length;
    if (quoteCount % 2 === 1) {
      return true;
    }

    // End of entry: skip if current posting is the last in its entry
    if (this.isEndOfEntry(document, position.line)) {
      return true;
    }

    return false;
  }

  private isEndOfEntry(document: TextDocument, line: number): boolean {
    const lineText = document.lineAt(line).text;

    // Must be a posting (indented, has content)
    if (!lineText.startsWith(" ") || lineText.trim() === "") {
      return false;
    }

    // Scan ahead for next non-empty line
    for (let i = line + 1; i < document.lineCount; i++) {
      const text = document.lineAt(i).text;
      if (text.trim() !== "") {
        // If next non-empty line is NOT indented → end of entry
        return !text.startsWith(" ");
      }
    }

    // EOF after this posting → end of entry
    return true;
  }

  private loadConfig(): LlmConfig {
    const cfg = vscode.workspace.getConfiguration("beancount");
    return {
      apiKey: "", // apiKey is fetched from OS keychain via extension.getLlmApiKey()
      model: cfg.get<string>("llm.model", "deepseek-v4-flash"),
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

  dispose() {
    clearTimeout(this.debounceTimer);
    this.abortController?.abort();
  }
}
