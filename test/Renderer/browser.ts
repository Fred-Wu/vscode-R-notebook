import { activate } from "../../src/Renderer";
import type { OutputItem } from "vscode-notebook-renderer";

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function run(): Promise<void> {
  const sent: Array<{ type: string; requestId: string; markupId?: string; label?: string }> = [];
  let receive: (message: unknown) => void = () => undefined;
  const markdown = {
    render: (source: string, _environment?: { outputItem?: OutputItem }) => source,
  };
  await activate({
    getRenderer: async () => ({
      extendMarkdownIt: (extend: (value: typeof markdown) => void) => extend(markdown),
    }),
    postMessage: (message: unknown) => sent.push(message as typeof sent[number]),
    onDidReceiveMessage: (listener: typeof receive) => {
      receive = listener;
      return { dispose() {} };
    },
  } as unknown as Parameters<typeof activate>[0]);

  const host = document.createElement("div");
  host.style.color = "rgb(230, 230, 230)";
  host.style.backgroundColor = "rgb(30, 30, 30)";
  document.body.append(host);
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = '<style>.scope-check { color: rgb(1, 2, 3); }</style>' +
    '<div class="scope-check" id="outside">Other notebook output</div>';
  const mount = document.createElement("div");
  mount.innerHTML = markdown.render('<p id="original">Original Markdown</p>', {
    outputItem: { metadata: { rNotebookMarkdown: { id: "cell" } } } as OutputItem,
  });
  root.append(mount);
  const element = mount.firstElementChild as HTMLElement;
  const originalNode = element.firstChild;
  const marker = "r-notebook-markdown-cell";
  const html = '<html><head><style>.scope-check { font-weight: 700; }</style></head><body>' +
    `<div id="${marker}" class="r-notebook-markdown-cell">` +
    '<style>.scope-check { color: rgb(200, 0, 0); }' +
    '.nested { & > span { color: rgb(4, 5, 6); } }</style>' +
    '<link rel="stylesheet" href="data:text/css,.linked%7Bcolor%3Argb(7%2C8%2C9)%7D">' +
    '<link rel="stylesheet" href="/external.css">' +
    '<p class="scope-check">Native text</p>' +
    '<div class="nested"><span>Nested CSS</span></div>' +
    '<p class="linked">Embedded CSS</p></div></body></html>';
  const reply = (requestId: string, extra: object = {}) => receive({
    type: "rNotebook.textResult", requestId, documentId: "notebook",
    marker, cells: [{ id: "cell", marker }], html, ...extra,
  });
  const settled = async (target = element) => {
    for (let i = 0; i < 200 && target.hasAttribute("data-r-notebook-text-request"); i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    check(!target.hasAttribute("data-r-notebook-text-request"), "Response did not settle");
  };
  const firstRequest = sent.at(-1)!.requestId;
  reply(firstRequest);
  await settled();
  check(element.textContent?.includes("Native text"), "Native response was not applied");
  check(getComputedStyle(root.querySelector("#outside")!).color === "rgb(1, 2, 3)",
    "A native body style leaked into another output");
  check(getComputedStyle(element.querySelector(".scope-check")!).color === "rgb(200, 0, 0)",
    "Body CSS no longer styles native Markdown");
  check(getComputedStyle(element.querySelector(".nested span")!).color === "rgb(4, 5, 6)",
    "Scoping dropped nested CSS rules");
  check(getComputedStyle(element.querySelector(".linked")!).color === "rgb(7, 8, 9)",
    "An embedded body stylesheet was lost");
  check(!element.querySelector('link[rel="stylesheet"]'), "A body stylesheet bypassed scoping");

  receive({ type: "rNotebook.refreshText" });
  const nextRequest = sent.at(-1)!.requestId;
  reply(firstRequest, { error: "Stale failure" });
  reply(nextRequest, { nativeOnly: true });
  await settled();
  check(element.firstChild === originalNode, "Plain Markdown did not restore its original DOM");
  check(element.id === "" && element.className === "", "Native attributes survived fallback");
  check(!element.title && !element.textContent?.includes("Stale failure"),
    "An obsolete response changed the current cell");

  receive({ type: "rNotebook.refreshText" });
  reply(sent.at(-1)!.requestId, { error: "Rendering failed" });
  await settled();
  check(element.querySelector('[role="alert"]'), "Render failure was not displayed");
  receive({ type: "rNotebook.refreshText" });
  reply(sent.at(-1)!.requestId, { nativeOnly: true });
  await settled();
  check(element.firstChild === originalNode && !element.querySelector('[role="alert"]') &&
    !element.title, "Plain Markdown retained a previous render failure");

  const mountCell = (id: string, source: string, cellRoot: ShadowRoot) => {
    const container = document.createElement("div");
    container.innerHTML = markdown.render(source, {
      outputItem: { metadata: { rNotebookMarkdown: { id } } } as OutputItem,
    });
    cellRoot.append(container);
    return container.firstElementChild as HTMLElement;
  };
  const headerSource = "---\ntitle: Report\n---\n<p>Introduction</p>";
  let headerCell = mountCell("header", headerSource, root);
  const cells = [
    { id: "header", marker: "r-notebook-markdown-header" },
    { id: "body", marker: "r-notebook-markdown-body" },
  ];
  const bodyHtml = '<div id="r-notebook-markdown-header" class="r-notebook-markdown-cell">' +
    '<h1 id="introduction">Introduction</h1></div>' +
    '<div id="r-notebook-markdown-body" class="r-notebook-markdown-cell">' +
    '<section id="results"><h1>Results</h1></section>' +
    '<section id="results-1"><h2>Results</h2></section>' +
    '<section id="résumé"><h2>Résumé</h2></section></div>';
  const tocLinks = '<ul class="collapse"><li><a href="#results">Results</a>' +
    '<ul class="collapse"><li><a href="#results-1">Results again</a></li>' +
    '<li><a href="#r%C3%A9sum%C3%A9">Résumé</a></li></ul></li></ul>';
  const quartoHtml = '<html><head><style>html{background:#fff;color:#111}body{padding:50px;max-width:36em}' +
    '#TOC{position:fixed}.collapse{display:none}</style></head><body>' +
    '<header id="title-block-header"><h1 class="title">A <em>formatted</em> report</h1>' +
    '<style>.scope-check{color:rgb(99,88,77)}</style>' +
    '<div class="quarto-title-meta"><p>Example Author</p><p class="date">October 17, 2026</p></div></header>' +
    '<nav id="TOC" role="doc-toc"><h2>On this page</h2>' + tocLinks + '</nav>' + bodyHtml + '</body></html>';
  const replyCell = (target: HTMLElement, id: string, html: string) => receive({
    type: "rNotebook.textResult", requestId: target.dataset.rNotebookTextRequest,
    documentId: "notebook", marker: cells.find((cell) => cell.id === id)!.marker, cells, html,
  });
  replyCell(headerCell, "header", quartoHtml);
  await settled(headerCell);
  const title = headerCell.querySelector("#title-block-header")!;
  const toc = headerCell.querySelector<HTMLElement>("[data-r-notebook-toc]")!;
  check(title.querySelector("em")?.textContent === "formatted", "Native title formatting was lost");
  check(title.textContent?.includes("Example Author") && title.textContent.includes("October 17, 2026"),
    "Author or formatted date was omitted");
  check(headerCell.querySelector("[data-r-notebook-front-matter]"), "Editable YAML display disappeared");
  check(title.compareDocumentPosition(toc) & Node.DOCUMENT_POSITION_FOLLOWING,
    "TOC is not after the title block");
  check(toc.compareDocumentPosition(headerCell.querySelector("#introduction")!) & Node.DOCUMENT_POSITION_FOLLOWING,
    "TOC is not before the document body");
  check(toc.querySelector("h2")?.textContent === "On this page", "Native TOC title was changed");
  check(getComputedStyle(toc).position === "static" &&
    getComputedStyle(toc.querySelector("ul ul")!).display !== "none", "TOC still needs a floating page sidebar");
  check(getComputedStyle(headerCell).backgroundColor === "rgba(0, 0, 0, 0)" &&
    getComputedStyle(headerCell).color === "rgb(230, 230, 230)" &&
    getComputedStyle(headerCell).padding === "0px", "Quarto page defaults replaced the notebook theme");

  // The destination has no DOM yet, as happens with a virtualized notebook cell.
  toc.querySelector<HTMLAnchorElement>('a[href="#results-1"]')!.click();
  check(sent.at(-1)?.type === "rNotebook.revealReference" && sent.at(-1)?.markupId === "body" &&
    sent.at(-1)?.label === "results-1", "TOC did not ask VS Code to reveal the destination cell");
  const scrolled: string[] = [];
  const scrollIntoView = HTMLElement.prototype.scrollIntoView;
  HTMLElement.prototype.scrollIntoView = function() { scrolled.push(this.id); };
  receive({ type: "rNotebook.revealAnchor", markupId: "body", label: "results-1" });
  check(scrolled.length === 0, "Navigation chose an unrelated cell before the target rendered");
  const bodyHost = document.createElement("div");
  document.body.append(bodyHost);
  const bodyCell = mountCell("body", "<p>Results</p>", bodyHost.attachShadow({ mode: "open" }));
  replyCell(bodyCell, "body", quartoHtml);
  await settled(bodyCell);
  check(scrolled.at(-1) === "results-1", "Navigation did not finish after the target rendered");
  check(!bodyCell.querySelector("[data-r-notebook-document-header]"), "The header was repeated in another cell");
  toc.querySelector<HTMLAnchorElement>('a[href="#r%C3%A9sum%C3%A9"]')!.click();
  check(sent.at(-1)?.markupId === "body" && sent.at(-1)?.label === "résumé", "Unicode anchors were not decoded");
  receive({ type: "rNotebook.revealAnchor", markupId: "body", label: "résumé" });
  check(scrolled.at(-1) === "résumé", "An existing target in another shadow root was not revealed");
  HTMLElement.prototype.scrollIntoView = scrollIntoView;

  headerCell.remove();
  headerCell = mountCell("header", headerSource, root);
  check(headerCell.querySelector('[data-r-notebook-pending-header] .title')?.textContent === "A formatted report" &&
    headerCell.querySelector('[data-r-notebook-toc] a')?.getAttribute("data-r-notebook-target-cell") === "body",
    "An unchanged cell lost its title or jumpable TOC while waiting for native HTML");
  check(getComputedStyle(root.querySelector("#outside")!).color === "rgb(1, 2, 3)",
    "The cached header restored unscoped native styles");
  receive({ type: "rNotebook.textResult", requestId: headerCell.dataset.rNotebookTextRequest, nativeOnly: true });
  await settled(headerCell);
  check(!headerCell.querySelector('[data-r-notebook-document-header]') &&
    headerCell.textContent?.includes("Introduction"), "Plain Markdown retained the cached header");

  const rmdHeader = '<h1 class="title toc-ignore">Updated report</h1>' +
    '<h4 class="author">Another Author</h4><h4 class="date">2026-10-18</h4>';
  receive({ type: "rNotebook.refreshText" });
  replyCell(headerCell, "header", '<html><body>' + rmdHeader + '<div id="TOC">' + tocLinks + '</div>' + bodyHtml + '</body></html>');
  await settled(headerCell);
  check(headerCell.querySelector(".title")?.textContent === "Updated report" &&
    headerCell.querySelector(".author")?.textContent === "Another Author" &&
    headerCell.querySelector(".date")?.textContent === "2026-10-18", "R Markdown header did not refresh");
  check(headerCell.querySelectorAll("[data-r-notebook-document-header]").length === 1 &&
    headerCell.querySelectorAll("[data-r-notebook-toc]").length === 1, "Refresh duplicated the header or TOC");
  check(headerCell.querySelector('[data-r-notebook-toc] h2')?.textContent === "Table of contents",
    "R Markdown's TOC has no visible heading");
  receive({ type: "rNotebook.refreshText" });
  replyCell(headerCell, "header", '<html><body>' + rmdHeader + bodyHtml + '</body></html>');
  await settled(headerCell);
  check(!headerCell.querySelector("[data-r-notebook-toc]") && headerCell.querySelector(".title"),
    "Disabling the TOC retained it or removed the title");
  receive({ type: "rNotebook.refreshText" });
  replyCell(headerCell, "header", '<html><body>' + bodyHtml + '</body></html>');
  await settled(headerCell);
  check(!headerCell.querySelector("[data-r-notebook-document-header]"), "Removed metadata left a stale header");

  const nativeFixtures = await (await fetch("/native-fixtures")).json() as Array<{
    name: string; html: string; cells: Array<{ id: string; marker: string }>;
  }>;
  for (const fixture of nativeFixtures) {
    const fixtureHost = document.createElement("div");
    document.body.append(fixtureHost);
    const cell = fixture.cells[0]!;
    const fixtureCell = mountCell(cell.id, "---\ntitle: Test\n---\n", fixtureHost.attachShadow({ mode: "open" }));
    receive({ type: "rNotebook.textResult", requestId: fixtureCell.dataset.rNotebookTextRequest,
      documentId: fixture.name, marker: cell.marker, html: fixture.html, cells: fixture.cells });
    await settled(fixtureCell);
    const renderedTitle = fixtureCell.querySelector<HTMLElement>(".title");
    const renderedToc = fixtureCell.querySelector<HTMLElement>("[data-r-notebook-toc]");
    check(renderedTitle && getComputedStyle(renderedTitle).display !== "none" &&
      renderedTitle.getBoundingClientRect().height > 0, `${fixture.name}: native title is not visible`);
    check(fixtureCell.querySelector("[data-r-notebook-document-header]")?.textContent?.includes("Fred Wu"),
      `${fixture.name}: native author is missing`);
    check(renderedToc && getComputedStyle(renderedToc).display !== "none" &&
      renderedToc.getBoundingClientRect().height > 0, `${fixture.name}: native TOC is not visible`);
    const resultsLink = renderedToc.querySelector<HTMLAnchorElement>('a[href="#results"]');
    check(resultsLink && resultsLink.dataset.rNotebookTargetCell === fixture.cells[1]?.id,
      `${fixture.name}: native TOC does not target the Results notebook cell`);
    resultsLink.click();
    check(sent.at(-1)?.markupId === fixture.cells[1]?.id && sent.at(-1)?.label === "results",
      `${fixture.name}: native TOC navigation failed`);
  }
}

void run().then(
  () => fetch("/result", { method: "POST", body: JSON.stringify({ success: true }) }),
  (error: unknown) => fetch("/result", { method: "POST", body: JSON.stringify({
    success: false, error: error instanceof Error ? error.stack : String(error),
  }) })
);
