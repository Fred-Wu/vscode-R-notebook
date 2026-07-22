import type {
  ActivationFunction,
  OutputItem,
  RendererApi,
} from "vscode-notebook-renderer";
import type { OptionCompletion } from "../Notebook/optionSchema";
import type { CellOptionsFormData as CellOptionsData } from "../Notebook/options";

const errors = new Map<string, HTMLElement>();
const outputRequests = new Map<string, string>();

function readCompletions(value: unknown): OptionCompletion[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object") {
      return [];
    }
    const completion = candidate as { name?: unknown; values?: unknown };
    if (typeof completion.name !== "string") {
      return [];
    }
    const values = Array.isArray(completion.values)
      ? completion.values.filter((item): item is string => typeof item === "string")
      : undefined;
    return [{ name: completion.name, ...(values?.length ? { values } : {}) }];
  });
}

function readData(outputItem: OutputItem): CellOptionsData | undefined {
  const data = outputItem.json() as Partial<CellOptionsData> | undefined;
  return data &&
    typeof data.requestId === "string" &&
    (data.documentKind === "quarto" || data.documentKind === "rMarkdown") &&
    (data.optionStyle === "quarto" || data.optionStyle === "rMarkdown") &&
    typeof data.label === "string" &&
    typeof data.headerOptions === "string" &&
    typeof data.quartoOptions === "string"
    ? {
      ...data,
      rMarkdownCompletions: readCompletions(data.rMarkdownCompletions),
      quartoCompletions: readCompletions(data.quartoCompletions),
    } as CellOptionsData
    : undefined;
}

function formField(
  document: Document,
  labelText: string,
  hintText: string,
  value: string,
  placeholder: string,
  multiline = false
): {
  container: HTMLLabelElement;
  input: HTMLInputElement | HTMLTextAreaElement;
} {
  const container = document.createElement("label");
  container.className = "r-options-field";
  const label = document.createElement("span");
  label.className = "r-options-label";
  label.textContent = labelText;
  const input = document.createElement(multiline ? "textarea" : "input");
  input.className = multiline ? "r-options-textarea" : "r-options-input";
  input.value = value;
  input.placeholder = placeholder;
  input.setAttribute("aria-label", labelText);
  const control = document.createElement("div");
  control.className = "r-options-control";
  control.append(input);
  const hint = document.createElement("span");
  hint.className = "r-options-hint";
  hint.textContent = hintText;
  container.append(label, control, hint);
  return { container, input };
}

interface Suggestion {
  label: string;
  apply: () => void;
}

function matchingCompletions(
  completions: OptionCompletion[],
  query: string
): OptionCompletion[] {
  const normalized = query.toLowerCase();
  return completions
    .filter((completion) => completion.name.toLowerCase().includes(normalized))
    .sort((left, right) => {
      const leftStarts = left.name.toLowerCase().startsWith(normalized) ? 0 : 1;
      const rightStarts = right.name.toLowerCase().startsWith(normalized) ? 0 : 1;
      return leftStarts - rightStarts || left.name.localeCompare(right.name);
    })
    .slice(0, 12);
}

function attachAutocomplete(
  document: Document,
  input: HTMLInputElement | HTMLTextAreaElement,
  completions: OptionCompletion[],
  syntax: "rMarkdown" | "quarto"
): void {
  const control = input.parentElement;
  if (!control) {
    return;
  }
  const popup = document.createElement("div");
  popup.className = "r-options-suggestions";
  popup.setAttribute("role", "listbox");
  popup.hidden = true;
  control.append(popup);
  let suggestions: Suggestion[] = [];
  let selected = 0;

  const replace = (start: number, end: number, value: string): void => {
    input.setRangeText(value, start, end, "end");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.focus();
  };

  const currentSuggestions = (): Suggestion[] => {
    const cursor = input.selectionStart ?? input.value.length;
    const boundary = syntax === "rMarkdown" ? "," : "\n";
    const assignment = syntax === "rMarkdown" ? "=" : ":";
    const assignmentSpace = syntax === "quarto" ? " " : "";
    const tokenStart = input.value.lastIndexOf(
      boundary,
      Math.max(0, cursor - 1)
    ) + 1;
    const nextBoundary = input.value.indexOf(boundary, cursor);
    const tokenEnd = nextBoundary < 0 ? input.value.length : nextBoundary;
    const before = input.value.slice(tokenStart, cursor);
    const leading = /^\s*/.exec(before)?.[0] ?? "";
    const token = before.slice(leading.length);
    const separator = token.indexOf(assignment);
    if (separator >= 0) {
      const name = token.slice(0, separator).trim();
      const query = token.slice(separator + 1).trim().toLowerCase();
      const completion = completions.find((item) => item.name === name);
      return (completion?.values ?? [])
        .filter((value) => {
          const normalized = value.toLowerCase();
          return normalized !== query && normalized.includes(query);
        })
        .slice(0, 12)
        .map((value) => ({
          label: value,
          apply: () => replace(
            tokenStart,
            tokenEnd,
            `${leading}${name}${assignment}${assignmentSpace}${value}`
          ),
        }));
    }
    return matchingCompletions(completions, token.trim()).map((completion) => ({
      label: completion.name,
      apply: () => replace(
        tokenStart,
        tokenEnd,
        `${leading}${completion.name}${assignment}${assignmentSpace}`
      ),
    }));
  };

  const draw = (): void => {
    if (input.disabled || document.activeElement !== input) {
      popup.hidden = true;
      return;
    }
    suggestions = currentSuggestions();
    selected = Math.min(selected, Math.max(0, suggestions.length - 1));
    popup.replaceChildren(...suggestions.map((suggestion, index) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "r-options-suggestion";
      item.classList.toggle("selected", index === selected);
      item.textContent = suggestion.label;
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", String(index === selected));
      item.addEventListener("mousedown", (event) => event.preventDefault());
      item.addEventListener("click", suggestion.apply);
      return item;
    }));
    popup.hidden = suggestions.length === 0;
  };

  input.addEventListener("focus", draw);
  input.addEventListener("click", draw);
  input.addEventListener("input", () => {
    selected = 0;
    draw();
  });
  input.addEventListener("blur", () => {
    popup.hidden = true;
  });
  input.addEventListener("keydown", (event) => {
    const keyboardEvent = event as KeyboardEvent;
    if (popup.hidden || suggestions.length === 0) {
      return;
    }
    if (keyboardEvent.key === "ArrowDown" || keyboardEvent.key === "ArrowUp") {
      keyboardEvent.preventDefault();
      const delta = keyboardEvent.key === "ArrowDown" ? 1 : -1;
      selected = (selected + delta + suggestions.length) % suggestions.length;
      draw();
    } else if (keyboardEvent.key === "Enter" || keyboardEvent.key === "Tab") {
      keyboardEvent.preventDefault();
      suggestions[selected]?.apply();
    } else if (keyboardEvent.key === "Escape") {
      keyboardEvent.preventDefault();
      popup.hidden = true;
    }
  });
}

function render(
  outputItem: OutputItem,
  element: HTMLElement,
  data: CellOptionsData,
  postMessage: (message: unknown) => void
): void {
  const document = element.ownerDocument;
  const style = document.createElement("style");
  style.textContent = `
    .r-options-card { box-sizing: border-box; width: min(720px, calc(100% - 12px)); margin: 8px 6px 12px; border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); border-radius: 6px; padding: 16px 18px; color: var(--vscode-foreground); background: var(--vscode-editorWidget-background, var(--vscode-editor-background)); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
    .r-options-close { display: block; width: 30px; height: 30px; margin: 0 0 4px auto; border: 0; border-radius: 4px; padding: 0; color: var(--vscode-foreground); background: transparent; font: inherit; font-size: 22px; line-height: 28px; cursor: pointer; }
    .r-options-close:hover { background: var(--vscode-toolbar-hoverBackground); }
    .r-options-field { display: grid; grid-template-columns: 165px minmax(260px, 1fr); column-gap: 12px; row-gap: 4px; align-items: center; margin-top: 11px; }
    .r-options-label { font-weight: 600; }
    .r-options-control { position: relative; min-width: 0; }
    .r-options-input, .r-options-textarea { box-sizing: border-box; width: 100%; border: 1px solid var(--vscode-input-border, transparent); border-radius: 3px; padding: 7px 9px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); font: inherit; }
    .r-options-input:focus, .r-options-textarea:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
    .r-options-textarea { min-height: 96px; resize: vertical; font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); }
    .r-options-hint { grid-column: 2; color: var(--vscode-descriptionForeground); font-size: 12px; }
    .r-options-field.disabled { opacity: 0.5; }
    .r-options-suggestions { position: absolute; z-index: 20; top: calc(100% + 2px); left: 0; right: 0; max-height: 220px; overflow-y: auto; border: 1px solid var(--vscode-editorSuggestWidget-border, var(--vscode-widget-border)); border-radius: 3px; padding: 3px; background: var(--vscode-editorSuggestWidget-background, var(--vscode-editorWidget-background)); box-shadow: 0 3px 8px var(--vscode-widget-shadow); }
    .r-options-suggestions[hidden] { display: none; }
    .r-options-suggestion { display: block; width: 100%; border: 0; padding: 5px 8px; color: var(--vscode-editorSuggestWidget-foreground, var(--vscode-foreground)); background: transparent; font: inherit; font-family: var(--vscode-editor-font-family); text-align: left; cursor: pointer; }
    .r-options-suggestion:hover, .r-options-suggestion.selected { color: var(--vscode-editorSuggestWidget-selectedForeground, var(--vscode-list-activeSelectionForeground)); background: var(--vscode-editorSuggestWidget-selectedBackground, var(--vscode-list-activeSelectionBackground)); }
    .r-options-error { min-height: 18px; margin: 10px 0 0 177px; color: var(--vscode-errorForeground); font-size: 12px; }
    .r-options-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 10px; }
    .r-options-button { border: 0; border-radius: 3px; padding: 7px 16px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); font: inherit; cursor: pointer; }
    .r-options-button:hover { background: var(--vscode-button-hoverBackground); }
    .r-options-button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
    .r-options-button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
    @media (max-width: 620px) { .r-options-field { grid-template-columns: 1fr; } .r-options-hint { grid-column: 1; } .r-options-error { margin-left: 0; } }
  `;
  const form = document.createElement("form");
  form.className = "r-options-card";
  const close = document.createElement("button");
  close.type = "button";
  close.className = "r-options-close";
  close.textContent = "×";
  close.title = "Close";
  close.setAttribute("aria-label", "Close");

  const label = formField(
    document,
    "Chunk label",
    "Applied using the active R Markdown or Quarto option style.",
    data.label,
    "Optional"
  );
  const options = formField(
    document,
    "R Markdown options",
    "Comma-separated name=value options with autocomplete.",
    data.headerOptions,
    "echo=FALSE, eval=TRUE"
  );
  const quarto = formField(
    document,
    "Quarto options",
    "One option per line, without the #| prefix.",
    data.quartoOptions,
    "echo: false\nwarning: false",
    true
  );
  const error = document.createElement("div");
  error.className = "r-options-error";
  error.setAttribute("role", "alert");
  const actions = document.createElement("div");
  actions.className = "r-options-actions";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "r-options-button secondary";
  cancel.textContent = "Cancel";
  const apply = document.createElement("button");
  apply.type = "submit";
  apply.className = "r-options-button";
  apply.textContent = "Apply";
  actions.append(cancel, apply);
  form.append(
    close,
    label.container,
    options.container,
    quarto.container,
    error,
    actions
  );
  element.replaceChildren(style, form);

  attachAutocomplete(
    document,
    options.input,
    data.rMarkdownCompletions,
    "rMarkdown"
  );
  attachAutocomplete(document, quarto.input, data.quartoCompletions, "quarto");

  let activeStyle = data.documentKind === "quarto" ? "quarto" : data.optionStyle;
  const updateOptionStyle = (): void => {
    const rMarkdownUsed = options.input.value.trim().length > 0;
    const quartoUsed = quarto.input.value.trim().length > 0;
    const disableRMarkdown = data.documentKind === "quarto" ||
      (activeStyle === "quarto" && quartoUsed);
    const disableQuarto = data.documentKind !== "quarto" &&
      activeStyle === "rMarkdown" && rMarkdownUsed;
    options.input.disabled = disableRMarkdown;
    quarto.input.disabled = disableQuarto;
    options.container.classList.toggle("disabled", disableRMarkdown);
    quarto.container.classList.toggle("disabled", disableQuarto);
  };
  options.input.addEventListener("input", () => {
    activeStyle = "rMarkdown";
    updateOptionStyle();
  });
  quarto.input.addEventListener("input", () => {
    activeStyle = "quarto";
    updateOptionStyle();
  });
  options.input.addEventListener("focus", () => {
    if (data.documentKind === "rMarkdown" && !quarto.input.value.trim()) {
      activeStyle = "rMarkdown";
    }
  });
  quarto.input.addEventListener("focus", () => {
    if (!options.input.value.trim()) {
      activeStyle = "quarto";
    }
  });
  updateOptionStyle();
  const closeForm = (): void => postMessage({
    type: "rNotebook.cancelCellOptions",
    requestId: data.requestId,
  });
  close.addEventListener("click", closeForm);
  cancel.addEventListener("click", closeForm);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    error.textContent = "";
    postMessage({
      type: "rNotebook.applyCellOptions",
      requestId: data.requestId,
      optionStyle: activeStyle,
      label: label.input.value,
      headerOptions: options.input.value,
      quartoOptions: quarto.input.value,
    });
  });
  errors.set(data.requestId, error);
  outputRequests.set(outputItem.id, data.requestId);
}

export const activate: ActivationFunction = (context): RendererApi | undefined => {
  if (!context.postMessage) {
    return undefined;
  }
  context.onDidReceiveMessage?.((message: unknown) => {
    const response = message as { type?: unknown; requestId?: unknown; message?: unknown };
    if (
      response.type !== "rNotebook.cellOptionsError" ||
      typeof response.requestId !== "string" ||
      typeof response.message !== "string"
    ) {
      return;
    }
    const error = errors.get(response.requestId);
    if (error) {
      error.textContent = response.message;
    }
  });
  return {
    renderOutputItem(outputItem, element) {
      const data = readData(outputItem);
      if (!data) {
        element.textContent = "Invalid cell options data.";
        return;
      }
      render(outputItem, element, data, context.postMessage!);
    },
    disposeOutputItem(id) {
      if (id === undefined) {
        errors.clear();
        outputRequests.clear();
        return;
      }
      const requestId = outputRequests.get(id);
      if (requestId) {
        errors.delete(requestId);
        outputRequests.delete(id);
      }
    },
  };
};
