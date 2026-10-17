import * as path from "node:path";
import { readFile } from "node:fs/promises";

/** Resource changes that can affect text produced by Quarto or Pandoc. */
const renderExtensions = new Set([
  ".bib", ".csl", ".css", ".scss", ".md", ".markdown",
  ".html", ".htm", ".js", ".svg", ".lua", ".py",
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

/** Quarto resources may be declared by the project rather than the document. */
export async function quartoProjectReferencesDependency(
  documentPath: string,
  changedPath: string
): Promise<boolean> {
  let directory = path.dirname(documentPath);
  while (true) {
    for (const name of ["_quarto.yml", "_quarto.yaml", "_metadata.yml"]) {
      try {
        const source = await readFile(path.join(directory, name), "utf8");
        if (sourceReferencesDependency(source, changedPath)) {
          return true;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      return false;
    }
    directory = parent;
  }
}
