import type { CancellationToken } from "vscode";

export class RStartupCancelledError extends Error {}

/** Cancel this request's wait without interrupting startup shared by other requests. */
export async function waitForRStartup<T>(
  startup: Promise<T>,
  token?: CancellationToken
): Promise<T> {
  if (!token) return startup;
  let subscription: { dispose(): void } | undefined;
  try {
    const cancelled = new Promise<never>((_resolve, reject) => {
      const cancel = () => reject(new RStartupCancelledError());
      subscription = token.onCancellationRequested(cancel);
      if (token.isCancellationRequested) cancel();
    });
    return await Promise.race([cancelled, startup]);
  } finally {
    subscription?.dispose();
  }
}
