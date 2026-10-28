/**
 * A loaded slice that still fits the viewport can never produce a scroll event,
 * so the top of history is reachable without a gesture. The transcript keeps
 * loading until the reader has something to scroll through or history runs out;
 * a scrollable slice keeps its normal edge-triggered loading instead.
 */
export function shouldLoadOlderFitted(hasOlder: boolean, loadingOlder: boolean, scrollHeight: number, clientHeight: number): boolean {
  return hasOlder && !loadingOlder && scrollHeight <= clientHeight + 8;
}
