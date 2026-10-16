/** A document render may finish after a Markdown cell has requested a newer one. */
export function isCurrentTextResponse(
  activeRequestId: string | undefined,
  responseRequestId: string
): boolean {
  return activeRequestId === responseRequestId;
}
