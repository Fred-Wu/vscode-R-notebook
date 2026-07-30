import type {
  ActivationFunction,
  OutputItem,
  RendererApi,
} from "vscode-notebook-renderer";

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
  marker?: string;
  html?: string;
  cells?: Array<{ id: string; marker: string }>;
  newDocument?: boolean;
  waiting?: string;
  error?: string;
}

interface RefreshRequest {
  type: "rNotebook.refreshText";
}

const renderedSignatures = new WeakMap<HTMLElement, string>();
let responseApplication = Promise.resolve();
let headScriptsLoaded = false;

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
  if (response.waiting) {
    placeholder.title = response.waiting;
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
    placeholder.querySelector("[data-r-notebook-native-error]")?.remove();
    const error = document.createElement("div");
    error.dataset.rNotebookNativeError = "";
    error.setAttribute("role", "alert");
    error.style.color = "var(--vscode-errorForeground)";
    error.style.whiteSpace = "pre-wrap";
    error.textContent = message;
    placeholder.prepend(error);
    console.error(message);
    return;
  }

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
  const titleBlock = nativeDocument.getElementById("title-block-header") ??
    nativeDocument.getElementById("header");
  const titleNodes = titleBlock
    ? [titleBlock]
    : Array.from(nativeDocument.body.children).filter((element) => {
        if (element === firstNativeCell) {
          return false;
        }
        if (element.classList.contains("r-notebook-markdown-cell")) {
          return false;
        }
        return firstNativeCell !== null &&
          element.matches(".title, .subtitle, .author, .date") &&
          Boolean(
            firstNativeCell.compareDocumentPosition(element) &
            Node.DOCUMENT_POSITION_PRECEDING
          );
      });
  const assetSignature = Array.from(
    nativeDocument.head.querySelectorAll("style, script"),
    (element) => element.outerHTML
  ).join("\n");
  const styledRoots = new Set<Document | ShadowRoot>();
  const updatedElements: HTMLElement[] = [];

  for (const root of roots()) {
    for (const element of root.querySelectorAll<HTMLElement>(
      "[data-r-notebook-markup-id]"
    )) {
      const encodedId = element.dataset.rNotebookMarkupId;
      const cell = encodedId ? cellsById.get(encodedId) : undefined;
      if (!cell) {
        continue;
      }
      const renderedCell = nativeDocument.getElementById(cell.marker);
      if (!renderedCell) {
        continue;
      }
      const cellTitle = renderedCell === firstNativeCell
        ? titleNodes.map((node) => node.outerHTML).join("\n")
        : "";
      const signature = `${assetSignature}\n${cellTitle}\n${renderedCell.outerHTML}`;
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
          "style[data-r-notebook-native-style]"
        )) {
          oldStyle.remove();
        }
        for (const style of nativeDocument.head.querySelectorAll("style")) {
          const copy = document.createElement("style");
          copy.dataset.rNotebookNativeStyle = "";
          copy.textContent = style.textContent;
          element.before(copy);
        }
        styledRoots.add(elementRoot);
      }

      const content: Node[] = [];
      if (renderedCell === firstNativeCell) {
        content.push(...titleNodes.map((node) => document.importNode(node, true)));
      }
      content.push(
        ...Array.from(
          renderedCell.childNodes,
          (node) => document.importNode(node, true)
        )
      );
      element.replaceChildren(...content);
      element.id = cell.marker;
      element.className = renderedCell.className;
      element.removeAttribute("title");
      element.removeAttribute("data-r-notebook-text-request");
      renderedSignatures.set(element, signature);
      updatedElements.push(element);
    }
  }

  if (response.newDocument || !headScriptsLoaded) {
    await replaceHeadScripts(nativeDocument);
    headScriptsLoaded = true;
  }
  for (const element of updatedElements) {
    for (const source of element.querySelectorAll("script")) {
      source.replaceWith(liveScript(source));
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
    const response = message as Partial<RenderResponse> & Partial<RefreshRequest>;
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
    const id = decodeURIComponent(anchor.hash.slice(1));
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
      const originalHtml = render(source, environment);
      const id = markupId(environment?.outputItem);
      if (!id) {
        return originalHtml;
      }
      const requestId = crypto.randomUUID();
      context.postMessage?.({ type: "rNotebook.renderText", requestId, markupId: id });
      return [
        `<div data-r-notebook-text-request="${requestId}"`,
        ` data-r-notebook-markup-id="${encodeURIComponent(id)}">`,
        originalHtml,
        "</div>",
      ].join("");
    };
  });
  return undefined;
};
