/** Plain Markdown stays with the VS Code renderer; special syntax uses Quarto. */
export function needsNativeTextRender(source: string): boolean {
  if (source.trim().length === 0) return false;
  if (/`r\s+[^`]+`/.test(source)) return true;
  if (/\\@ref\s*\(/.test(source)) return true;
  if (/(^|[^\w])@(?:fig|tbl|sec|eq|lst|thm|lem|cor|prp|cnj|def|exm|exr|sol|rem|tip|nte|imp|cau|wrn|ref)-[\w:-]+/m.test(source)) return true;
  if (/\[@[^\]]+\]|(^|[^\w@.])@[A-Za-z][\w-]*(?![\w@.])/m.test(source)) return true;
  // Definitions may belong to a different Markdown cell than their uses.
  if (/^ {0,3}\[[^\]\r\n]+\]:/m.test(source)) return true;
  if (/\{\{[<%]/.test(source)) return true;
  if (/^ {0,3}:{3,}/m.test(source)) return true;
  if (/\{(?:#[A-Za-z]|[.][A-Za-z])[^}\n]*\}/.test(source)) return true;
  if (/!\[[^\]]*\]\([^)]+\)\s*\{/.test(source)) return true;
  return false;
}

/** Conservatively decide whether the full notebook needs native semantics. */
export function needsNativeDocumentRender(cells: readonly {
  kind: "markup" | "code";
  value: string;
  chunk?: { openingFence: string };
}[]): boolean {
  return cells.some((cell) => {
    if (cell.kind === "markup") {
      return /^---(?:\r\n|\n|\r)/.test(cell.value) ||
        needsNativeTextRender(cell.value);
    }
    return /^\s*#\|/m.test(cell.value) ||
      Boolean(cell.chunk && /\{[^}\r\n]*[, ]/.test(cell.chunk.openingFence));
  });
}
