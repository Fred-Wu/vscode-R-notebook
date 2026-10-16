import * as path from "node:path";

/** Resource changes that can affect text produced by Quarto or Pandoc. */
const renderExtensions = new Set([
  ".bib", ".csl", ".css", ".scss", ".md", ".markdown",
  ".html", ".htm", ".js", ".svg",
]);

export function isTextRenderDependency(filePath: string): boolean {
  return renderExtensions.has(path.extname(filePath).toLowerCase());
}
