/** A document render may finish after a Markdown cell has requested a newer one. */
export function isCurrentTextResponse(
  activeRequestId: string | undefined,
  responseRequestId: string
): boolean {
  return activeRequestId === responseRequestId;
}

/** Reuse widget dependencies until their script declarations actually change. */
export function shouldReloadHeadScripts(
  previousSignature: string | undefined,
  nextSignature: string
): boolean {
  return previousSignature !== nextSignature;
}

/** Show a document-level render failure only once; retain native Markdown elsewhere. */
export function shouldDisplayRenderingError(seen: Set<string>, message: string): boolean {
  if (seen.has(message)) {
    return false;
  }
  seen.add(message);
  return true;
}

/** Native HTML is requested with embedded assets; reject remote script loading. */
export function isAllowedNativeScriptSource(source: string | null): boolean {
  if (source === null) {
    return true;
  }
  return /^(?:data:(?:application|text)\/(?:javascript|ecmascript))(?:[;,]|$)/i.test(source.trim());
}
