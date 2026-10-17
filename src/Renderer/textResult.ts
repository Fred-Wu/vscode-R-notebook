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
export function shouldDisplayRenderingError(
  seen: Set<string>,
  documentId: string,
  message: string
): boolean {
  const key = JSON.stringify([documentId, message]);
  if (seen.has(key)) {
    return false;
  }
  seen.add(key);
  return true;
}

/** Clearing one document's errors must not suppress another notebook. */
export function clearRenderingErrors(seen: Set<string>, documentId: string): void {
  for (const key of seen) {
    if (key.startsWith(JSON.stringify([documentId]).slice(0, -1) + ",")) {
      seen.delete(key);
    }
  }
}

/** Native HTML is requested with embedded assets; reject remote script loading. */
export function isAllowedNativeScriptSource(source: string | null): boolean {
  if (source === null) {
    return true;
  }
  return /^(?:data:(?:application|text)\/(?:javascript|ecmascript))(?:[;,]|$)/i.test(source.trim());
}

/** Only embedded CSS is allowed into the notebook's shared render environment. */
export function isAllowedNativeStylesheetSource(source: string | null): boolean {
  return source !== null && /^data:text\/css(?:[;,]|$)/i.test(source.trim());
}
