export const NOTEBOOK_TYPE = "r-notebook";
export const NATIVE_TEXT_VERSION = 11;

export interface NativeTextState {
  version: number;
  sourceHash: string;
  html: string;
}

export interface ChunkMetadata {
  openingFence: string;
  closingFence: string;
  engine: string;
}

export interface ParsedCell {
  kind: "markup" | "code";
  value: string;
  languageId: string;
  chunk?: ChunkMetadata;
}

export interface RNotebookCellMetadata {
  rNotebook?: ChunkMetadata;
  rNotebookMarkdown?: { id: string };
  rNotebookOutputSourceHash?: string;
}

export interface RNotebookDocumentMetadata {
  rNotebook?: { eol?: string };
  rNotebookState?: NativeTextState;
}

interface ParsedDocument {
  cells: ParsedCell[];
  eol: "\n" | "\r\n" | "\r";
}

export interface SourceLine {
  content: string;
  raw: string;
  start: number;
  end: number;
}

interface MarkdownFence {
  marker: string;
  info: string;
}

interface OpeningFence extends MarkdownFence {
  engine: string;
}

export function sourceLines(source: string): SourceLine[] {
  const lines: SourceLine[] = [];
  const pattern = /[^\r\n]*(?:\r\n|\n|\r|$)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const raw = match[0];
    if (raw.length === 0) {
      break;
    }
    const content = raw.replace(/(?:\r\n|\n|\r)$/, "");
    lines.push({ content, raw, start: match.index, end: match.index + raw.length });
  }
  return lines;
}

function markdownFence(line: string): MarkdownFence | undefined {
  const match = /^(?: {0,3})(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match?.[1]) {
    return undefined;
  }
  const info = match[2] ?? "";
  if (match[1].startsWith("`") && info.includes("`")) {
    return undefined;
  }
  return { marker: match[1], info };
}

function executableFence(fence: MarkdownFence): OpeningFence | undefined {
  const match = /^[ \t]*\{(.+)\}[ \t]*$/.exec(fence.info);
  if (!match?.[1]) {
    return undefined;
  }
  const header = match[1].trim();
  const engine = header.split(/[\s,]+/, 1)[0]?.trim().toLowerCase();
  if (!engine || /^[.#=]/.test(engine) || engine.includes("=")) {
    return undefined;
  }
  return { ...fence, engine };
}

function isClosingFence(line: string, opening: MarkdownFence): boolean {
  const markerCharacter = opening.marker[0];
  if (!markerCharacter) {
    return false;
  }
  const escaped = markerCharacter === "`" ? "`" : "~";
  const pattern = new RegExp(`^(?: {0,3})${escaped}{${opening.marker.length},}[ \\t]*$`);
  return pattern.test(line);
}

function languageIdForEngine(engine: string): string {
  if (engine === "r") {
    return "r";
  }
  if (engine === "js" || engine === "ojs") {
    return "javascript";
  }
  if (engine === "py") {
    return "python";
  }
  return engine;
}

export function parseDocument(source: string): ParsedDocument {
  const lines = sourceLines(source);
  const cells: ParsedCell[] = [];
  let markdownStart = 0;
  let lineIndex = 0;

  while (lineIndex < lines.length) {
    const line = lines[lineIndex];
    if (!line) {
      break;
    }
    const fence = markdownFence(line.content);
    if (!fence) {
      lineIndex += 1;
      continue;
    }

    let closingIndex = lineIndex + 1;
    while (closingIndex < lines.length) {
      const candidate = lines[closingIndex];
      if (candidate && isClosingFence(candidate.content, fence)) {
        break;
      }
      closingIndex += 1;
    }
    if (closingIndex >= lines.length) {
      break;
    }

    const opening = executableFence(fence);
    if (!opening) {
      lineIndex = closingIndex + 1;
      continue;
    }

    if (line.start > markdownStart) {
      const markdown = source.slice(markdownStart, line.start);
      const previous = cells.at(-1);
      if (previous?.kind === "code" && previous.chunk && /^\s+$/.test(markdown)) {
        previous.chunk.closingFence += markdown;
      } else {
        cells.push({
          kind: "markup",
          value: markdown,
          languageId: "markdown",
        });
      }
    }

    const closing = lines[closingIndex];
    if (!closing) {
      break;
    }
    cells.push({
      kind: "code",
      value: source.slice(line.end, closing.start),
      languageId: languageIdForEngine(opening.engine),
      chunk: {
        openingFence: line.raw,
        closingFence: closing.raw,
        engine: opening.engine,
      },
    });
    markdownStart = closing.end;
    lineIndex = closingIndex + 1;
  }

  if (markdownStart < source.length) {
    cells.push({
      kind: "markup",
      value: source.slice(markdownStart),
      languageId: "markdown",
    });
  }
  if (cells.length === 0) {
    cells.push({ kind: "markup", value: source, languageId: "markdown" });
  }

  const eolMatch = /\r\n|\n|\r/.exec(source);
  const eol = (eolMatch?.[0] ?? "\n") as ParsedDocument["eol"];
  return { cells, eol };
}

function endsWithEol(value: string): boolean {
  return /(?:\r\n|\n|\r)$/.test(value);
}

export function defaultChunk(languageId: string, eol: string): ChunkMetadata {
  const engine = languageId || "r";
  return {
    openingFence: `\`\`\`{${engine}}${eol}`,
    closingFence: "```",
    engine,
  };
}

export function codeCellSource(cell: ParsedCell, eol: string): string {
  const chunk = cell.chunk ?? defaultChunk(cell.languageId, eol);
  let body = cell.value;
  if (body.length > 0 && !endsWithEol(body)) {
    body += eol;
  }
  return chunk.openingFence + body + chunk.closingFence;
}

export function serializeDocument(cells: readonly ParsedCell[], eol: string): string {
  let result = "";
  for (const cell of cells) {
    const next = cell.kind === "code" ? codeCellSource(cell, eol) : cell.value;
    if (result.length > 0 && next.length > 0 && !endsWithEol(result) && !/^(?:\r\n|\n|\r)/.test(next)) {
      result += eol;
    }
    result += next;
  }
  return result;
}
