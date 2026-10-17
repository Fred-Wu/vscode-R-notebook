import * as path from "node:path";

/** Resource changes that can affect text produced by Quarto or Pandoc. */
const renderExtensions = new Set([
  ".bib", ".csl", ".css", ".scss", ".md", ".markdown",
  ".html", ".htm", ".js", ".svg",
]);

export function isTextRenderDependency(filePath: string): boolean {
  return renderExtensions.has(path.extname(filePath).toLowerCase());
}

/**
 * Match direct filename references in a notebook or its project configuration.
 * Ambiguous dynamic dependencies still require manual refresh.
 */
export function sourceReferencesDependency(
  source: string,
  resourcePath: string
): boolean {
  const name = path.basename(resourcePath).replace(/\\/g, "/");
  return name.length > 0 && source.includes(name);
}
