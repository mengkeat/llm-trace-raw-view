import { Hono } from "hono";

type LogState = {
  text: string;
  status: string;
  path?: string;
};

type CliOptions = {
  path?: string;
  txt: boolean;
};

const cliOptions = parseArgs(Bun.argv.slice(2));
const logState = await loadLogFromFile(cliOptions);

const app = new Hono();

type TokenType = "string" | "number" | "identifier" | "punct";

interface Token {
  type: TokenType;
  value: string;
}

class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParseError";
  }
}

const singleStringEscapes: Record<string, string> = {
  "n": "\n",
  "r": "\r",
  "t": "\t",
  "\\": "\\",
  "'": "'",
};

const doubleStringEscapes: Record<string, string> = {
  "n": "\n",
  "r": "\r",
  "t": "\t",
  "\\": "\\",
  '"': '"',
  "/": "/",
  "b": "\b",
  "f": "\f",
};

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;

  while (index < input.length) {
    const char = input[index];

    if (char === " " || char === "\t" || char === "\n" || char === "\r") {
      index += 1;
      continue;
    }

    if (char === "'" || char === '"') {
      const quote = char;
      const escapes = quote === '"' ? doubleStringEscapes : singleStringEscapes;
      let value = "";
      index += 1;
      while (index < input.length) {
        const current = input[index];
        if (current === "\\") {
          const next = input[index + 1];
          if (quote === '"' && next === "u") {
            const hex = input.slice(index + 2, index + 6);
            if (hex.length === 4 && /^[0-9a-fA-F]{4}$/.test(hex)) {
              value += String.fromCharCode(parseInt(hex, 16));
              index += 6;
              continue;
            }
          }
          if (next && escapes[next]) {
            value += escapes[next];
            index += 2;
            continue;
          }
        }
        if (current === quote) {
          index += 1;
          break;
        }
        value += current;
        index += 1;
      }
      tokens.push({ type: "string", value });
      continue;
    }

    if (char === "-" || (char >= "0" && char <= "9")) {
      const slice = input.slice(index);
      const match = slice.match(/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/);
      if (match) {
        tokens.push({ type: "number", value: match[0] });
        index += match[0].length;
        continue;
      }
    }

    if (
      (char >= "a" && char <= "z") ||
      (char >= "A" && char <= "Z") ||
      char === "_"
    ) {
      const slice = input.slice(index);
      const match = slice.match(/^[A-Za-z_][A-Za-z0-9_]*/);
      if (match) {
        tokens.push({ type: "identifier", value: match[0] });
        index += match[0].length;
        continue;
      }
    }

    tokens.push({ type: "punct", value: char });
    index += 1;
  }

  return tokens;
}

class Parser {
  private readonly tokens: Token[];
  private index = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  parseValue(): unknown {
    const token = this.peek();
    if (!token) {
      throw new ParseError("Unexpected end of input");
    }

    if (token.type === "string") {
      this.index += 1;
      return token.value;
    }

    if (token.type === "number") {
      this.index += 1;
      return Number(token.value);
    }

    if (token.type === "identifier") {
      if (token.value === "None" || token.value === "null") {
        this.index += 1;
        return null;
      }
      if (token.value === "True" || token.value === "true") {
        this.index += 1;
        return true;
      }
      if (token.value === "False" || token.value === "false") {
        this.index += 1;
        return false;
      }

      const next = this.peek(1);
      if (next?.type === "punct" && next.value === "(") {
        return this.parseClassCall(token.value);
      }

      this.index += 1;
      return token.value;
    }

    if (token.type === "punct") {
      if (token.value === "[") {
        return this.parseArray();
      }
      if (token.value === "{") {
        return this.parseDict();
      }
      if (token.value === "(") {
        this.consume("(");
        const value = this.parseValue();
        this.consume(")");
        return value;
      }
    }

    throw new ParseError(`Unexpected token ${token.value}`);
  }

  ensureComplete(): void {
    if (this.index < this.tokens.length) {
      const token = this.tokens[this.index];
      throw new ParseError(`Unexpected trailing token ${token.value}`);
    }
  }

  private parseArray(): unknown[] {
    this.consume("[");
    const items: unknown[] = [];
    while (!this.isPunct("]")) {
      items.push(this.parseValue());
      if (this.isPunct(",")) {
        this.consume(",");
        if (this.isPunct("]")) {
          break;
        }
      } else {
        break;
      }
    }
    this.consume("]");
    return items;
  }

  private parseDict(): Record<string, unknown> {
    this.consume("{");
    const result: Record<string, unknown> = {};
    while (!this.isPunct("}")) {
      const keyValue = this.parseValue();
      let key: string;
      if (typeof keyValue === "string" || typeof keyValue === "number") {
        key = String(keyValue);
      } else {
        key = JSON.stringify(keyValue);
      }
      this.consume(":");
      result[key] = this.parseValue();
      if (this.isPunct(",")) {
        this.consume(",");
        if (this.isPunct("}")) {
          break;
        }
      } else {
        break;
      }
    }
    this.consume("}");
    return result;
  }

  private parseClassCall(name: string): Record<string, unknown> {
    this.consumeIdentifier(name);
    this.consume("(");
    const result: Record<string, unknown> = { __type__: name };
    const positional: unknown[] = [];

    while (!this.isPunct(")")) {
      if (this.peek()?.type === "identifier" && this.peek(1)?.value === "=") {
        const key = this.consumeIdentifier();
        this.consume("=");
        result[key] = this.parseValue();
      } else {
        positional.push(this.parseValue());
      }

      if (this.isPunct(",")) {
        this.consume(",");
        if (this.isPunct(")")) {
          break;
        }
      } else {
        break;
      }
    }

    this.consume(")");
    if (positional.length > 0) {
      result.__args__ = positional;
    }
    return result;
  }

  private consume(value: string): void {
    const token = this.peek();
    if (!token || token.type !== "punct" || token.value !== value) {
      throw new ParseError(`Expected '${value}'`);
    }
    this.index += 1;
  }

  private consumeIdentifier(expected?: string): string {
    const token = this.peek();
    if (!token || token.type !== "identifier") {
      throw new ParseError("Expected identifier");
    }
    if (expected && token.value !== expected) {
      throw new ParseError(`Expected identifier ${expected}`);
    }
    this.index += 1;
    return token.value;
  }

  private isPunct(value: string): boolean {
    const token = this.peek();
    return Boolean(token && token.type === "punct" && token.value === value);
  }

  private peek(offset = 0): Token | undefined {
    return this.tokens[this.index + offset];
  }
}

function sanitizeToJson(input: string): string {
  const parser = new Parser(tokenize(input));
  const value = parser.parseValue();
  parser.ensureComplete();
  return JSON.stringify(value);
}

function tryParseValue(input: string): { ok: true; value: unknown } | { ok: false } {
  try {
    const json = sanitizeToJson(input);
    return { ok: true, value: JSON.parse(json) };
  } catch {
    return { ok: false };
  }
}

function stripAnsiAndControl(input: string): string {
  const withoutAnsi = input
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, "");

  return withoutAnsi.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

function parseLine(line: string): unknown {
  const normalized = stripAnsiAndControl(line);
  const trimmed = normalized.trim();
  if (!trimmed) {
    return "";
  }

  const curlResult = parseCurlCommand(trimmed);
  if (curlResult) {
    return curlResult;
  }

  try {
    const jsonValue = JSON.parse(trimmed);
    if (jsonValue !== null && typeof jsonValue === "object") {
      return jsonValue;
    }
  } catch {}

  const direct = tryParseValue(trimmed);
  if (direct.ok) {
    if (typeof direct.value === "string" && !trimmed.startsWith("'") && !trimmed.startsWith('"')) {
      return { __raw__: normalized };
    }
    return direct.value;
  }

  const parts = trimmed.split(";").map((part) => part.trim()).filter(Boolean);
  const entries: Record<string, unknown> = {};
  const extras: unknown[] = [];
  let hasKeyValue = false;

  for (const part of parts) {
    const match = part.match(/^([^:=]+?)\s*(=|:)\s*(.+)$/);
    if (match) {
      hasKeyValue = true;
      const key = match[1].trim();
      const parsed = tryParseValue(match[3].trim());
      entries[key] = parsed.ok ? parsed.value : match[3].trim();
    } else {
      const parsed = tryParseValue(part);
      extras.push(parsed.ok ? parsed.value : part);
    }
  }

  if (hasKeyValue) {
    if (extras.length > 0) {
      entries.__extras__ = extras;
    }
    return entries;
  }

  if (extras.length === 1) {
    return extras[0];
  }
  if (extras.length > 1) {
    return extras;
  }

  return { __raw__: normalized };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderValue(value: unknown, depth: number): string {
  if (value === null) {
    return `<span class="literal null">null</span>`;
  }

  if (typeof value === "string") {
    const html = escapeHtml(value).replace(/\n/g, "<br>");
    return `<span class="string">${html}</span>`;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return `<span class="literal">${value}</span>`;
  }

  if (Array.isArray(value)) {
    const open = depth <= 1 ? " open" : "";
    const items = value
      .map((item, index) =>
        `<div class="entry"><span class="key">${index}</span>${renderValue(item, depth + 1)}</div>`
      )
      .join("");
    return `
      <details class="node"${open}>
        <summary>Array(${value.length})</summary>
        <div class="children">${items}</div>
      </details>
    `;
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.__raw__ === "string") {
      return `<span class="raw">${escapeHtml(record.__raw__)}</span>`;
    }
    const entries = Object.entries(record).filter(([key]) => key !== "__type__");
    const typeLabel = typeof record.__type__ === "string" ? record.__type__ : "Object";
    const open = depth === 0 ? " open" : "";
    const children = entries
      .map(([key, val]) =>
        `<div class="entry"><span class="key">${escapeHtml(key)}</span>${renderValue(val, depth + 1)}</div>`
      )
      .join("");

    return `
      <details class="node"${open}>
        <summary>${escapeHtml(typeLabel)}${entries.length === 0 ? " {}" : ""}</summary>
        <div class="children">${children}</div>
      </details>
    `;
  }

  return `<span class="literal">${escapeHtml(String(value))}</span>`;
}

function renderLine(line: string, index: number): string {
  try {
    const parsed = parseLine(line);
    if (parsed === "") {
      return `<div class="line"><span class="line-no">${index}</span><span class="empty">(empty)</span></div>`;
    }
    return `<div class="line"><span class="line-no">${index}</span>${renderValue(parsed, 0)}</div>`;
  } catch {
    return `<div class="line"><span class="line-no">${index}</span><span class="raw">${escapeHtml(line)}</span></div>`;
  }
}

function deduplicateLines(lines: string[]): string[] {
  if (lines.length === 0) return lines;
  const result: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const current = lines[i];
    const normalized = stripAnsiAndControl(current).trim();
    let count = 1;
    while (
      i + count < lines.length &&
      stripAnsiAndControl(lines[i + count]).trim() === normalized
    ) {
      count++;
    }
    result.push(count > 1 && normalized !== "" ? `${current} (×${count})` : current);
    i += count;
  }
  return result;
}

function preprocessLines(rawLines: string[]): string[] {
  const result: string[] = [];
  let i = 0;

  while (i < rawLines.length) {
    const line = rawLines[i];
    if (line.trimEnd().endsWith("\\")) {
      let joined = line.trimEnd().slice(0, -1);
      i += 1;
      while (i < rawLines.length) {
        const next = rawLines[i];
        if (next.trimEnd().endsWith("\\")) {
          joined += " " + next.trim().slice(0, -1);
          i += 1;
        } else {
          joined += " " + next.trim();
          i += 1;
          break;
        }
      }
      result.push(joined);
    } else {
      result.push(line);
      i += 1;
    }
  }

  return result;
}

function parseCurlCommand(line: string): Record<string, unknown> | null {
  const curlMatch = line.match(/^curl\s+/);
  if (!curlMatch) {
    return null;
  }

  const result: Record<string, unknown> = { __type__: "curl" };

  const methodMatch = line.match(/-X\s+(\w+)/);
  if (methodMatch) {
    result.method = methodMatch[1];
  }

  const urlMatch = line.match(/(?:^curl\s+|-X\s+\w+\s+)(https?:\/\/\S+)/);
  if (urlMatch) {
    result.url = urlMatch[1];
  }

  const dataIndex = line.search(/\s-d\s/);
  const headerPart = dataIndex !== -1 ? line.slice(0, dataIndex) : line;

  const headers: Record<string, string> = {};
  const headerRegex = /-H\s+'([^']+)'/g;
  let hMatch;
  while ((hMatch = headerRegex.exec(headerPart)) !== null) {
    const colonIndex = hMatch[1].indexOf(":");
    if (colonIndex !== -1) {
      const key = hMatch[1].slice(0, colonIndex).trim();
      const val = hMatch[1].slice(colonIndex + 1).trim();
      headers[key] = val;
    }
  }
  if (Object.keys(headers).length > 0) {
    result.headers = headers;
  }

  if (dataIndex !== -1) {
    const dataPart = line.slice(dataIndex);
    const dataMatch = dataPart.match(/-d\s+'([\s\S]+)'\s*$/);
    if (dataMatch) {
      const bodyStr = dataMatch[1];
      const parsed = tryParseValue(bodyStr);
      result.body = parsed.ok ? parsed.value : bodyStr;
    }
  }

  return result;
}

function renderReport(logText: string, state: LogState): string {
  const rawLines = logText.split(/\r?\n/);
  const lines = deduplicateLines(preprocessLines(rawLines));
  const rendered = lines
    .map((line, index) => renderLine(line, index + 1))
    .join("");

  return `<!doctype html>
  <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>LLM Trace Viewer</title>
      <style>
        :root {
          color-scheme: dark;
          --bg: #0e1116;
          --text: #d6dbe3;
          --muted: #8b96a9;
          --key: #88c0f0;
          --string: #e7c787;
          --literal: #9bd67c;
          --line: #202734;
          --accent: #ffb370;
        }

        * {
          box-sizing: border-box;
        }

        body {
          margin: 0;
          font-family: "Fira Code", "JetBrains Mono", "Consolas", monospace;
          background: var(--bg);
          color: var(--text);
        }

        header {
          padding: 20px 24px 8px;
        }

        h1 {
          margin: 0 0 8px;
          font-size: 1.6rem;
          letter-spacing: 0.5px;
        }

        p {
          margin: 0;
          color: var(--muted);
        }

        .container {
          padding: 8px 24px 32px;
        }

        .report {
          display: grid;
          gap: 4px;
        }

        .line {
          display: flex;
          gap: 12px;
          padding: 2px 0;
          border-bottom: 1px solid var(--line);
        }

        .line-no {
          display: inline-block;
          width: 48px;
          color: var(--muted);
          flex-shrink: 0;
          text-align: right;
        }

        .key {
          color: var(--key);
          margin-right: 6px;
        }

        .string {
          color: var(--string);
        }

        .literal {
          color: var(--literal);
        }

        .literal.null {
          color: #e58a8a;
        }

        .raw {
          color: var(--text);
        }

        .empty {
          color: var(--muted);
          font-style: italic;
        }

        details.node > summary {
          cursor: pointer;
          color: var(--accent);
        }

        .children {
          padding: 6px 0 4px 16px;
          display: grid;
          gap: 4px;
        }

        .entry {
          display: flex;
          gap: 8px;
          align-items: flex-start;
        }
      </style>
    </head>
    <body>
      <header>
        <h1>LLM Trace Raw View</h1>
        <p>${escapeHtml(state.status)}</p>
      </header>
      <section class="container">
        <div class="report">
          ${rendered || "<p class=\"empty\">No log lines provided.</p>"}
        </div>
      </section>
    </body>
  </html>`;
}

if (cliOptions.txt) {
  const rawLines = logState.text.split(/\r?\n/);
  const lines = deduplicateLines(preprocessLines(rawLines));
  for (const [i, line] of lines.entries()) {
    try {
      const parsed = parseLine(line);
      console.log(`${i + 1}: ${JSON.stringify(parsed)}`);
    } catch (e) {
      console.log(`${i + 1}: [ERROR] ${e}`);
    }
  }
  process.exit(0);
}

app.get("/", (c) => c.html(renderReport(logState.text, logState)));

app.get("/health", (c) => c.text("ok"));

export default app;

async function loadLogFromFile(options: CliOptions): Promise<LogState> {
  if (!options.path) {
    return {
      text: "",
      status: "No log file provided. Run: bun run dev -- path/to/log.txt",
    };
  }

  const file = Bun.file(options.path);
  const exists = await file.exists();
  if (!exists) {
    return {
      text: "",
      status: `File not found: ${options.path}`,
      path: options.path,
    };
  }

  const text = await file.text();
  return {
    text,
    status: `Loaded ${text.split(/\r?\n/).length} lines from ${options.path}`,
    path: options.path,
  };
}

function parseArgs(args: string[]): CliOptions {
  let path: string | undefined;
  let txt = false;

  for (const arg of args) {
    if (arg.toLowerCase() === "--txt") {
      txt = true;
      continue;
    }
    if (!path) {
      path = arg;
    }
  }

  return { path, txt };
}
