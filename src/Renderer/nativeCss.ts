const MARKDOWN_SCOPE = ".r-notebook-markdown-cell";

/** Split selectors at top-level commas, preserving :is(..., ...) expressions. */
export function scopeNativeCssSelector(selectors: string): string {
  const pieces: string[] = [];
  let start = 0;
  let depth = 0;
  let quote = "";
  let escape = false;
  for (let i = 0; i < selectors.length; i++) {
    const char = selectors[i] ?? "";
    if (escape) {
      escape = false;
    } else if (char === "\\") {
      escape = true;
    } else if (quote) {
      if (char === quote) quote = "";
    } else if (char === "'" || char === '"') {
      quote = char;
    } else if (char === "(" || char === "[") {
      depth++;
    } else if (char === ")" || char === "]") {
      depth = Math.max(0, depth - 1);
    } else if (char === "," && depth === 0) {
      pieces.push(selectors.slice(start, i));
      start = i + 1;
    }
  }
  pieces.push(selectors.slice(start));
  return pieces.map((piece) => {
    const selector = piece.trim();
    if (/^(?::root|html|body)(?=$|[\s.#[:])/.test(selector)) {
      return selector.replace(/^(?::root|html|body)/, MARKDOWN_SCOPE);
    }
    return MARKDOWN_SCOPE + " " + selector;
  }).join(", ");
}

/** Parse CSS with the browser CSSOM to preserve at-rules and complex selectors. */
export function scopeNativeCss(css: string): string {
  const sheet = new CSSStyleSheet();
  try {
    sheet.replaceSync(css);
  } catch {
    return "";
  }
  const convert = (rule: CSSRule): string => {
    if (rule.type === CSSRule.IMPORT_RULE) return "";
    if (rule.type === CSSRule.STYLE_RULE) {
      const style = rule as CSSStyleRule;
      return scopeNativeCssSelector(style.selectorText) + "{" + style.style.cssText + "}";
    }
    if (rule.type !== CSSRule.KEYFRAMES_RULE && "cssRules" in rule) {
      const group = rule as CSSGroupingRule;
      const prefix = rule.cssText.slice(0, rule.cssText.indexOf("{"));
      return prefix + "{" + Array.from(group.cssRules, convert).join("\n") + "}";
    }
    return rule.cssText;
  };
  return Array.from(sheet.cssRules, convert).join("\n");
}

/** Decode the self-contained CSS that Quarto or Pandoc embedded in HTML. */
export function decodeEmbeddedCss(uri: string | null): string | undefined {
  if (!uri) return undefined;
  const match = /^data:text\/css(?:;charset=[^;,]+)?(;base64)?,([\s\S]*)$/i.exec(uri);
  if (!match) return undefined;
  try {
    const payload = match[2] ?? "";
    if (!match[1]) return decodeURIComponent(payload);
    const binary = atob(payload);
    return new TextDecoder().decode(Uint8Array.from(binary, (byte) => byte.charCodeAt(0)));
  } catch {
    return undefined;
  }
}
