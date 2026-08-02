import * as path from "node:path";

export type NotebookExtension = ".rmd" | ".qmd";

export function normalizeNotebookExtension(
  filePath: string
): NotebookExtension | undefined {
  const extension = path.extname(filePath).toLowerCase();
  return extension === ".rmd" || extension === ".qmd"
    ? extension
    : undefined;
}

export function isQuartoNotebook(filePath: string): boolean {
  return normalizeNotebookExtension(filePath) === ".qmd";
}
