/**
 * R languageserver detects R Markdown from a notebook-cell URI's .rmd/.qmd
 * filename, even when the individual cell is plain R with no code fences.
 * Only these notebook-cell documents require the plain-R completion proxy.
 */
export function needsPlainRCompletionProxy(
  scheme: string,
  filePath: string,
  languageId: string
): boolean {
  return scheme === "vscode-notebook-cell" &&
    languageId === "r" &&
    /\.(?:rmd|rmarkdown|qmd)$/i.test(filePath);
}
