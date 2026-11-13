import type {
  ActivationFunction,
  OutputItem,
  RendererApi,
} from "vscode-notebook-renderer";
import { splitFrontMatter, yamlFrontMatterHtml } from "../markdown";

import { scopeNativeCss, decodeEmbeddedCss } from "./nativeCss";
import { annotateReferenceLinks, nativeDocumentHeader } from "./documentHeader";
import { isCurrentTextResponse, shouldDisplayRenderingError, clearRenderingErrors, shouldReloadHeadScripts, isAllowedNativeScriptSource, isAllowedNativeStylesheetSource } from "./textResult";

interface MarkdownEnvironment {
  outputItem?: OutputItem;
}

interface MarkdownIt {
  render(source: string, environment?: MarkdownEnvironment): string;
}

interface MarkdownRenderer extends RendererApi {
  extendMarkdownIt(callback: (markdownIt: MarkdownIt) => void): void;
}

interface RenderResponse {
  type: "rNotebook.textResult";
  requestId: string;
  documentId?: string;
  marker?: string;
  html?: string;
  cells?: Array<{ id: string; marker: string }>;
  newDocument?: boolean;
  nativeOnly?: boolean;
  error?: string;
}

interface RefreshRequest {
  type: "rNotebook.refreshText";
}

interface RevealReferenceRequest {
  type: "rNotebook.revealAnchor";
  label: string;
  markupId: string;
}

const renderedSignatures = new WeakMap<HTMLElement, string>();
const originalMarkup = new WeakMap<HTMLElement, {
  nodes: Node[];
  id: string;
  className: string;
}>();
// VS Code recreates Markdown DOM for metadata changes and preview toggles.
// Keep the document header visible while an unchanged cell requests its HTML again.
const documentHeaders = new Map<string, { source: string; html?: string }>();
let responseApplication = Promise.resolve();
let loadedHeadSignature: string | undefined;
const displayedRenderingErrors = new Set<string>();
let pendingReference: RevealReferenceRequest | undefined;

function markupId(outputItem: OutputItem | undefined): string | undefined {
  const metadata = outputItem?.metadata as {
    rNotebookMarkdown?: { id?: unknown };
  } | undefined;
  const id = metadata?.rNotebookMarkdown?.id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

function roots(): Array<Document | ShadowRoot> {
  const result: Array<Document | ShadowRoot> = [document];
  for (let index = 0; index < result.length; index += 1) {
    for (const element of result[index]?.querySelectorAll("*") ?? []) {
      if (element.shadowRoot) {
        result.push(element.shadowRoot);
      }
    }
  }
  return result;
}

function revealPendingReference(): void {
  if (!pendingReference) return;
  const cellSelector = `[data-r-notebook-markup-id="${CSS.escape(encodeURIComponent(pendingReference.markupId))}"]`;
  for (const root of roots()) {
    const cell = root.querySelector<HTMLElement>(cellSelector);
    const target = cell?.querySelector<HTMLElement>(`#${CSS.escape(pendingReference.label)}`);
    if (target) {
      target.scrollIntoView({ block: "center" });
      pendingReference = undefined;
      return;
    }
  }
}

function liveScript(source: HTMLScriptElement): HTMLScriptElement {
  const script = document.createElement("script");
  for (const attribute of source.attributes) {
    script.setAttribute(attribute.name, attribute.value);
  }
  script.textContent = source.textContent;
  return script;
}

async function replaceHeadScripts(nativeDocument: Document): Promise<void> {
  for (const script of document.head.querySelectorAll(
    "script[data-r-notebook-native-script]"
  )) {
    script.remove();
  }

  for (const source of nativeDocument.head.querySelectorAll("script")) {
    if (!isAllowedNativeScriptSource(source.getAttribute("src"))) {
      console.warn("Skipped an external script in native notebook text.");
      continue;
    }
    const script = liveScript(source);
    script.dataset.rNotebookNativeScript = "";
    const type = (script.getAttribute("type") ?? "").trim().toLowerCase();
    const executable = type === "" ||
      type === "module" ||
      type.includes("javascript") ||
      type.includes("ecmascript");
    const waitForExecution = !script.hasAttribute("nomodule") &&
      executable &&
      (script.hasAttribute("src") || type === "module");
    const execution = waitForExecution
      ? new Promise<void>((resolve) => {
          script.addEventListener("load", () => resolve(), { once: true });
          script.addEventListener("error", () => resolve(), { once: true });
        })
      : undefined;
    document.head.appendChild(script);
    await execution;
  }
}

function requestText(
  element: HTMLElement,
  markupId: string,
  postMessage: (message: unknown) => void
): void {
  const requestId = crypto.randomUUID();
  element.dataset.rNotebookTextRequest = requestId;
  element.dataset.rNotebookMarkupId = encodeURIComponent(markupId);
  postMessage({
    type: "rNotebook.renderText",
    requestId,
    markupId,
  });
}

async function applyResponse(response: RenderResponse): Promise<void> {
  const selector = `[data-r-notebook-text-request="${CSS.escape(response.requestId)}"]`;
  const placeholder = roots()
    .map((root) => root.querySelector<HTMLElement>(selector))
    .find((element) => element !== null);
  if (!placeholder) {
    return;
  }
  if (!originalMarkup.has(placeholder)) {
    const pendingHeader = placeholder.querySelector('[data-r-notebook-pending-header]');
    originalMarkup.set(placeholder, {
      nodes: Array.from(placeholder.childNodes).filter(node => node !== pendingHeader),
      id: placeholder.id,
      className: placeholder.className,
    });
  }
  if (response.nativeOnly) {
    const encodedId = placeholder.dataset.rNotebookMarkupId;
    if (encodedId) documentHeaders.delete(decodeURIComponent(encodedId));
    clearRenderingErrors(displayedRenderingErrors, response.documentId ?? "");
    const original = originalMarkup.get(placeholder)!;
    placeholder.replaceChildren(...original.nodes);
    placeholder.id = original.id;
    placeholder.className = original.className;
    placeholder.removeAttribute("title");
    renderedSignatures.delete(placeholder);
    placeholder.removeAttribute("data-r-notebook-text-request");
    return;
  }
  if (
    response.error ||
    !response.html ||
    !response.marker ||
    !response.cells
  ) {
    const message = response.error ?? "Native text rendering failed.";
    placeholder.title = message;
    if (!shouldDisplayRenderingError(
      displayedRenderingErrors,
      response.documentId ?? "",
      message
    )) {
      placeholder.removeAttribute("data-r-notebook-text-request");
      return;
    }
    placeholder.querySelector("[data-r-notebook-native-error]")?.remove();
    const error = document.createElement("div");
    error.dataset.rNotebookNativeError = "";
    error.setAttribute("role", "alert");
    error.style.color = "var(--vscode-errorForeground)";
    error.style.whiteSpace = "pre-wrap";
    error.textContent = message;
    placeholder.prepend(error);
    console.error(message);
    placeholder.removeAttribute("data-r-notebook-text-request");
    return;
  }

  clearRenderingErrors(displayedRenderingErrors, response.documentId ?? "");
  const nativeDocument = new DOMParser().parseFromString(response.html, "text/html");
  const nativeCell = nativeDocument.getElementById(response.marker);
  if (!nativeCell) {
    placeholder.title = "The native text output did not contain this Markdown cell.";
    console.error(placeholder.title);
    return;
  }
  const cellsById = new Map(
    response.cells.map((cell) => [encodeURIComponent(cell.id), cell])
  );
  const firstNativeCell = nativeDocument.querySelector(".r-notebook-markdown-cell");
  const assetSignature = Array.from(
    nativeDocument.head.querySelectorAll("style, script, link[rel=\"stylesheet\"]"),
    (element) => element.outerHTML
  ).join("\n");
  const styledRoots = new Set<Document | ShadowRoot>();
  const updatedElements: HTMLElement[] = [];

  for (const root of roots()) {
    for (const element of root.querySelectorAll<HTMLElement>(
      "[data-r-notebook-markup-id]"
    )) {
      // A response belongs to one request. Applying its document-wide HTML
      // to sibling cells can overwrite edits whose newer requests are pending.
      if (!isCurrentTextResponse(
        element.dataset.rNotebookTextRequest,
        response.requestId
      )) {
        continue;
      }
      const encodedId = element.dataset.rNotebookMarkupId;
      const cell = encodedId ? cellsById.get(encodedId) : undefined;
      if (!cell) {
        continue;
      }
      const renderedCell = nativeDocument.getElementById(cell.marker);
      if (!renderedCell) {
        continue;
      }
      const frontMatter = renderedCell === firstNativeCell
        ? element.querySelector<HTMLElement>("[data-r-notebook-front-matter]")
        : null;
      const frontMatterSignature = frontMatter?.outerHTML ?? "";
      const header = renderedCell === firstNativeCell
        ? nativeDocumentHeader(nativeDocument)
        : undefined;
      const signature = [
        assetSignature,
        frontMatterSignature,
        header?.outerHTML ?? "",
        renderedCell.outerHTML,
      ].join("\n");
      if (element !== placeholder && renderedSignatures.get(element) === signature) {
        element.removeAttribute("data-r-notebook-text-request");
        continue;
      }

      const elementRoot = element.getRootNode();
      if (
        (elementRoot instanceof Document || elementRoot instanceof ShadowRoot) &&
        !styledRoots.has(elementRoot)
      ) {
        for (const oldStyle of elementRoot.querySelectorAll(
          "style[data-r-notebook-native-style],link[data-r-notebook-native-style]"
        )) {
          oldStyle.remove();
        }
        for (const style of nativeDocument.head.querySelectorAll("style")) {
          const copy = document.createElement("style");
          copy.dataset.rNotebookNativeStyle = "";
          copy.textContent = scopeNativeCss(style.textContent ?? "");
          element.before(copy);
        }
        for (const sheet of nativeDocument.head.querySelectorAll<HTMLLinkElement>(
          'link[rel="stylesheet"]'
        )) {
          if (!isAllowedNativeStylesheetSource(sheet.getAttribute("href"))) {
            continue;
          }
          const css = decodeEmbeddedCss(sheet.getAttribute("href"));
          if (css === undefined) {
            continue;
          }
          const copy = document.createElement("style");
          copy.dataset.rNotebookNativeStyle = "";
          copy.textContent = scopeNativeCss(css);
          element.before(copy);
        }
        const notebookStyle = document.createElement("style");
        notebookStyle.dataset.rNotebookNativeStyle = "";
        // HTML page defaults (notably Quarto's white page and 50px padding)
        // must not replace the notebook theme or constrain the cell's width.
        notebookStyle.textContent = `
          .r-notebook-markdown-cell {
            background: transparent !important;
            color: inherit !important;
            font: inherit !important;
            margin: 0 !important;
            padding: 0 !important;
            max-width: none !important;
          }
          .r-notebook-markdown-cell a { color: var(--vscode-textLink-foreground); }
          .r-notebook-markdown-cell a:hover { color: var(--vscode-textLink-activeForeground); }
        `;
        element.before(notebookStyle);
        styledRoots.add(elementRoot);
      }

      const content: Node[] = [];
      if (frontMatter) {
        content.push(document.importNode(frontMatter, true));
      }
      if (header) content.push(header);
      content.push(
        ...Array.from(
          renderedCell.childNodes,
          (node) => document.importNode(node, true)
        )
      );
      const fragment = document.createDocumentFragment();
      fragment.append(...content);
      annotateReferenceLinks(fragment, nativeDocument, response.cells);
      // Body styles share the same root as other cells, just like head styles.
      for (const style of fragment.querySelectorAll("style")) {
        style.textContent = scopeNativeCss(style.textContent ?? "");
      }
      for (const sheet of fragment.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')) {
        const css = decodeEmbeddedCss(sheet.getAttribute("href"));
        if (css === undefined) {
          sheet.remove();
        } else {
          const style = document.createElement("style");
          style.media = sheet.media;
          style.textContent = scopeNativeCss(css);
          sheet.replaceWith(style);
        }
      }
      if (encodedId) {
        const id = decodeURIComponent(encodedId);
        const cachedHeader = documentHeaders.get(id);
        if (header && cachedHeader) cachedHeader.html = header.outerHTML;
        else documentHeaders.delete(id);
      }
      element.replaceChildren(fragment);
      element.id = cell.marker;
      element.className = renderedCell.className;
      element.removeAttribute("title");
      element.removeAttribute("data-r-notebook-text-request");
      renderedSignatures.set(element, signature);
      updatedElements.push(element);
    }
  }

  revealPendingReference();

  const nextHeadSignature = Array.from(
    nativeDocument.head.querySelectorAll("script"),
    (script) => script.outerHTML
  ).join("\n");
  if (shouldReloadHeadScripts(loadedHeadSignature, nextHeadSignature)) {
    await replaceHeadScripts(nativeDocument);
    loadedHeadSignature = nextHeadSignature;
  }
  for (const element of updatedElements) {
    for (const source of element.querySelectorAll("script")) {
      if (isAllowedNativeScriptSource(source.getAttribute("src"))) {
        source.replaceWith(liveScript(source));
      } else {
        source.remove();
      }
    }
  }
}

export const activate: ActivationFunction = async (context) => {
  const renderer = await context.getRenderer("vscode.markdown-it-renderer") as
    | MarkdownRenderer
    | undefined;
  if (!renderer || !context.postMessage) {
    return undefined;
  }

  context.onDidReceiveMessage?.((message: unknown) => {
    const response = message as Partial<RenderResponse> | Partial<RefreshRequest> |
      Partial<RevealReferenceRequest>;
    if (response.type === "rNotebook.revealAnchor" &&
        typeof response.label === "string" && typeof response.markupId === "string") {
      pendingReference = response as RevealReferenceRequest;
      revealPendingReference();
      return;
    }
    if (
      response.type === "rNotebook.textResult" &&
      typeof response.requestId === "string"
    ) {
      responseApplication = responseApplication
        .then(() => applyResponse(response as RenderResponse))
        .catch((error: unknown) => {
          console.error(
            error instanceof Error ? error.message : String(error)
          );
        });
      return;
    }
    if (response.type === "rNotebook.refreshText") {
      for (const root of roots()) {
        for (const element of root.querySelectorAll<HTMLElement>(
          "[data-r-notebook-markup-id]"
        )) {
          const encodedId = element.dataset.rNotebookMarkupId;
          if (encodedId) {
            requestText(element, decodeURIComponent(encodedId), context.postMessage!);
          }
        }
      }
    }
  });

  document.addEventListener("click", (event) => {
    const anchor = event.composedPath().find((node) => node instanceof HTMLAnchorElement);
    if (
      !(anchor instanceof HTMLAnchorElement) ||
      !anchor.hash ||
      !anchor.getAttribute("href")?.startsWith("#")
    ) {
      return;
    }
    let id: string;
    try {
      id = decodeURIComponent(anchor.hash.slice(1));
    } catch {
      return;
    }
    const targetCell = anchor.dataset.rNotebookTargetCell;
    if (targetCell) {
      event.preventDefault();
      context.postMessage?.({
        type: "rNotebook.revealReference",
        label: id,
        markupId: targetCell,
      });
      return;
    }
    const target = roots()
      .map((root) => root.querySelector<HTMLElement>(`#${CSS.escape(id)}`))
      .find((element) => element !== null);
    if (target) {
      event.preventDefault();
      target.scrollIntoView({ block: "center" });
      return;
    }
    event.preventDefault();
    context.postMessage?.({
      type: "rNotebook.revealReference",
      label: id,
    });
  });

  renderer.extendMarkdownIt((markdownIt) => {
    const render = markdownIt.render.bind(markdownIt);
    markdownIt.render = (source, environment) => {
      const split = splitFrontMatter(source);
      const renderedBody = render(split.body, environment);
      const originalHtml = yamlFrontMatterHtml(split.frontMatter) +
        renderedBody;
      const id = markupId(environment?.outputItem);
      if (!id) {
        return originalHtml;
      }
      const previousHeader = documentHeaders.get(id);
      if (previousHeader?.source !== source) documentHeaders.set(id, { source });
      const cachedHeader = documentHeaders.get(id)?.html;
      const pendingHeader = cachedHeader
        ? cachedHeader.replace("<div ", '<div data-r-notebook-pending-header="" ')
        : "";
      const requestId = crypto.randomUUID();
      context.postMessage?.({ type: "rNotebook.renderText", requestId, markupId: id });
      return [
        `<div data-r-notebook-text-request="${requestId}"`,
        ` data-r-notebook-markup-id="${encodeURIComponent(id)}">`,
        yamlFrontMatterHtml(split.frontMatter),
        pendingHeader,
        renderedBody,
        "</div>",
      ].join("");
    };
  });
  return undefined;
};
