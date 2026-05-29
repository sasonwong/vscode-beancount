import * as vscode from "vscode";
import { TextDocument, Position } from "vscode";
import { Completer } from "../completer";

export interface BuildResult {
  systemPrompt: string;
  userPrompt: string;
  prefixLines: number;
  suffixLines: number;
}

export class ContextBuilder {
  constructor(private completer: Completer) {}

  buildSystemPrompt(): string {
    const openAccountsList = Object.keys(this.completer.accounts)
      .filter((name) => {
        const acct = this.completer.accounts[name];
        return !acct.close || acct.close === "";
      });
    const openAccounts =
      openAccountsList.length > 0
        ? openAccountsList.join("\n")
        : "(none yet)";

    const commodities =
      this.completer.commodities.length > 0
        ? this.completer.commodities.join(", ")
        : "(none yet)";

    return `You are an expert beancount accountant. Complete the text at the cursor position. Output ONLY beancount syntax — no markdown, no explanation, no code fences.

## Known Accounts
${openAccounts}

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
- Posting format:   ACCOUNT  AMOUNT CURRENCY
- Separate entries with 2 blank lines`;
  }

  buildUserPrompt(document: TextDocument, position: Position): BuildResult | null {
    if (position.line >= document.lineCount) {
      return null;
    }

    const maxCtx = vscode.workspace
      .getConfiguration("beancount")
      .get<number>("llm.maxContextLines", 40);

    const startLine = Math.max(0, position.line - maxCtx);
    const endLine = Math.min(document.lineCount - 1, position.line + 10);

    const prefix = this.getLines(document, startLine, position.line);
    const suffix = this.getLines(document, position.line + 1, endLine);

    const prefixLines = position.line - startLine;
    const suffixLines = endLine - position.line;

    return {
      systemPrompt: this.buildSystemPrompt(),
      userPrompt: `### Context (line ${position.line + 1}):\n${prefix}<<<CURSOR>>>\n${suffix}\n\nComplete at <<<CURSOR>>>:`,
      prefixLines,
      suffixLines,
    };
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
