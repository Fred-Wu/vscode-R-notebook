export interface MarkdownParts {
  frontMatter: string;
  body: string;
}

export function splitFrontMatter(source: string): MarkdownParts {
  const opening = /^---(?:\r\n|\n|\r)/.exec(source);
  if (!opening) {
    return { frontMatter: "", body: source };
  }
  const closing = /^(?:---|\.\.\.)(?:\r\n|\n|\r|$)/m.exec(
    source.slice(opening[0].length)
  );
  if (!closing) {
    return { frontMatter: "", body: source };
  }
  const end = opening[0].length + closing.index + closing[0].length;
  return { frontMatter: source.slice(0, end), body: source.slice(end) };
}

export function yamlFrontMatterHtml(source: string): string {
  const escaped = source
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return source
    ? `<pre data-r-notebook-front-matter><code class="language-yaml">${escaped}</code></pre>`
    : "";
}
