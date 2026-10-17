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
    const copy = document.importNode(source, true);
    if (source.id === "TOC") {
      copy.dataset.rNotebookToc = "";
      copy.setAttribute("role", "navigation");
      if (!copy.querySelector("h1, h2, h3, h4, h5, h6")) {
        const heading = document.createElement("h2");
        heading.textContent = "Table of contents";
        copy.prepend(heading);
      }
      if (!copy.hasAttribute("aria-label") && !copy.hasAttribute("aria-labelledby")) {
        copy.setAttribute("aria-label", copy.querySelector("h2")?.textContent ?? "Table of contents");
      }
      // Sidebar positioning and collapsible lists require the full Quarto page.
      // Within a notebook the TOC is a normal block with all configured levels visible.
      copy.style.cssText = "position:static;width:auto;height:auto;max-height:none;overflow:visible;display:block";
      for (const list of copy.querySelectorAll<HTMLElement>("ul, ol")) {
        list.classList.remove("collapse", "collapsing");
        list.style.display = "block";
      }
      for (const link of copy.querySelectorAll("a")) {
        link.classList.remove("active");
        link.removeAttribute("data-scroll-target");
      }
    }
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
