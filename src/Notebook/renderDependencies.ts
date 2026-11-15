import * as path from "node:path";
import { readFile } from "node:fs/promises";

/** Resource changes that can affect text produced by Quarto or Pandoc. */
const renderExtensions = new Set([
  ".bib", ".csl", ".css", ".scss", ".md", ".markdown", ".qmd", ".rmd",
  ".html", ".htm", ".js", ".svg", ".lua", ".py",
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".bmp",
  ".tif", ".tiff", ".ico", ".pdf", ".eps",
]);

// Use the same extensions for filtering and watching, including mixed casing.
export const TEXT_RENDER_DEPENDENCY_GLOB = "**/*.{" + [...renderExtensions]
  .map((extension) => extension.slice(1).replace(/[a-z]/g,
    (letter) => `[${letter}${letter.toUpperCase()}]`))
  .join(",") + "}";

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
  const decoded = source.replace(/(?:%[0-9a-f]{2})+/gi, (value) => {
    try { return decodeURIComponent(value); }
    catch { return value; }
  });
  return name.length > 0 && decoded.includes(name);
}

/** Quarto resources may be declared by the project rather than the document. */
export async function quartoProjectReferencesDependency(
  documentPath: string,
  changedPath: string
): Promise<boolean> {
  return quartoConfigurationMatches(documentPath, (source) =>
    sourceReferencesDependency(source, changedPath));
}

/** Even plain text can inherit native formatting from Quarto configuration. */
export function hasQuartoProjectConfiguration(documentPath: string): Promise<boolean> {
  return quartoConfigurationMatches(documentPath, () => true);
}

async function quartoConfigurationMatches(
  documentPath: string,
  matches: (source: string) => boolean
): Promise<boolean> {
  let directory = path.dirname(documentPath);
  while (true) {
    for (const name of ["_quarto.yml", "_quarto.yaml", "_metadata.yml"]) {
      try {
        const source = await readFile(path.join(directory, name), "utf8");
        if (matches(source)) {
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
