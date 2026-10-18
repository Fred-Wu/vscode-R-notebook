/** Use native TOC labels and destinations with one notebook layout for both engines. */
function notebookToc(source: HTMLElement): HTMLElement {
  const toc = document.createElement("nav");
  toc.dataset.rNotebookToc = "";
  toc.setAttribute("role", "navigation");
  toc.style.cssText = "display:block;position:static;background:transparent;color:inherit;font:inherit;line-height:1.5;margin:1em 0;padding:0;width:auto;height:auto;max-height:none;overflow:visible";
  const heading = document.createElement("h2");
  const nativeHeading = source.querySelector("h1, h2, h3, h4, h5, h6");
  if (nativeHeading) heading.append(...Array.from(nativeHeading.childNodes, node => document.importNode(node, true)));
  else heading.textContent = "Table of contents";
  heading.style.cssText = "font:inherit;font-size:1.2em;font-weight:600;line-height:1.5;margin:0 0 0.5em;padding:0;border:0;color:inherit";
  toc.setAttribute("aria-label", heading.textContent ?? "Table of contents");
  toc.append(heading);
  for (const list of source.querySelectorAll("ul, ol")) {
    if (!list.parentElement?.closest("ul, ol")) toc.append(document.importNode(list, true));
  }
  // Drop page navigation classes and IDs, so Quarto's sidebar styles cannot
  // change the notebook TOC. Preserve inline label formatting and native hashes.
  for (const element of toc.querySelectorAll<HTMLElement>("ul, ol, li, a")) {
    element.removeAttribute("class");
    element.removeAttribute("id");
    element.removeAttribute("style");
    element.removeAttribute("data-scroll-target");
    if (element.matches("ul, ol")) {
      element.style.cssText = "display:block;position:static;margin:0;padding:0 0 0 1.5em;list-style:disc outside;font:inherit;color:inherit";
    } else if (element.matches("li")) {
      element.style.cssText = "display:list-item;margin:0;padding:0;border:0;font:inherit;color:inherit";
    } else {
      element.style.cssText = "display:inline;margin:0;padding:0;border:0;background:transparent;font:inherit;color:var(--vscode-textLink-foreground);text-decoration:none";
    }
  }
  return toc;
}

/** Keep the native title and TOC, which Pandoc emits outside the cell wrappers. */
export function nativeDocumentHeader(nativeDocument: Document): HTMLElement | undefined {
  const header = document.createElement("div");
  header.dataset.rNotebookDocumentHeader = "";
  const outsideCell = (selector: string) =>
    Array.from(nativeDocument.querySelectorAll<HTMLElement>(selector))
      .find((element) => !element.closest(".r-notebook-markdown-cell"));
  let title = outsideCell("#title-block-header, #header");
  if (!title) {
    // R Markdown's unthemed template emits metadata headings without a wrapper.
    const metadata = Array.from(nativeDocument.querySelectorAll<HTMLElement>(
      "h1.title, h3.subtitle, p.subtitle, h4.author, p.author, h4.date, p.date"
    )).filter((element) => !element.closest(".r-notebook-markdown-cell"));
    if (metadata.length > 0) {
      title = nativeDocument.createElement("header");
      title.append(...metadata.map((element) => element.cloneNode(true)));
    }
  }
  for (const source of [title, outsideCell("#TOC")]) {
    if (!source) continue;
    const copy = source.id === "TOC" ? notebookToc(source) : document.importNode(source, true);
    header.append(copy);
  }
  return header.childNodes.length > 0 ? header : undefined;
}

/** Native IDs handle explicit labels, duplicate headings, and Pandoc's slug rules. */
export function annotateReferenceLinks(
  fragment: DocumentFragment,
  nativeDocument: Document,
  cells: readonly { id: string; marker: string }[]
): void {
  const idsByMarker = new Map(cells.map((cell) => [cell.marker, cell.id]));
  for (const link of fragment.querySelectorAll<HTMLAnchorElement>('a[href^="#"]')) {
    let label: string;
    try {
      label = decodeURIComponent(link.getAttribute("href")!.slice(1));
    } catch {
      continue;
    }
    const marker = nativeDocument.getElementById(label)
      ?.closest(".r-notebook-markdown-cell")?.id;
    const markupId = marker ? idsByMarker.get(marker) : undefined;
    if (markupId) link.dataset.rNotebookTargetCell = markupId;
  }
}
