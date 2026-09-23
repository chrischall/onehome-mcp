/**
 * Deadline + cancellation for the direct services.onehome.com fetches
 * both transports make (GraphQL POST and LocalLogic REST GET).
 *
 * Without this a stalled upstream (connection accepted, response never
 * finishing) wedged the tool until the MCP client's multi-minute timeout,
 * and a cancelled tool call kept its request running. The checkToken
 * exchange already had a deadline (issue #55); this extends the same
 * guarantee to every other request.
 */

import { withAmbientCancellation } from '@chrischall/mcp-utils';

/**
 * Per-request deadline. Well under the MCP client's tool timeout so the
 * caller gets an actionable error instead of a hang, and generous enough
 * for OneHome's slowest legitimate responses (200-listing pages).
 */
export const REQUEST_TIMEOUT_MS = 25_000;

/** The request (fetch + body read) did not complete within its deadline. */
export class OneHomeRequestTimeoutError extends Error {
  readonly timeoutMs: number;
  constructor(label: string, timeoutMs: number) {
    super(
      `${label} timed out after ${timeoutMs}ms — services.onehome.com did not ` +
        `answer in time. This is usually a transient upstream stall; retry.`
    );
    this.name = 'OneHomeRequestTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

export interface DeadlineOptions {
  /** Names the request in the timeout message, e.g. `OneHome GraphQL ListingById`. */
  label: string;
  timeoutMs?: number;
}

/**
 * `fetch` + `response.text()` under one deadline, combined with the
 * ambient MCP call cancellation. A timeout rejects with
 * `OneHomeRequestTimeoutError`; a caller cancellation rejects with the
 * signal's own reason. The abort is also raced explicitly so a fetch
 * implementation that ignores `signal` still cannot hang the caller.
 */
export async function fetchTextWithDeadline(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  opts: DeadlineOptions
): Promise<{ response: Response; text: string }> {
  const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = withAmbientCancellation(timeout) ?? timeout;

  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  // Swallow the late rejection if the request wins the race.
  aborted.catch(() => {});

  const roundTrip = (async () => {
    const response = await fetchImpl(url, { ...init, signal });
    const text = await response.text();
    return { response, text };
  })();
  roundTrip.catch(() => {});

  try {
    return await Promise.race([roundTrip, aborted]);
  } catch (err) {
    if (timeout.aborted) throw new OneHomeRequestTimeoutError(opts.label, timeoutMs);
    throw err;
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}
