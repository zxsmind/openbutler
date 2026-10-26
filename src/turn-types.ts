/** Host-recorded turn completion, shared with transcript renderers. */
export interface TurnCompletion {
  turnOutcome?: 'completed' | 'cancelled' | 'failed' | undefined;
  turnEndedAt?: number | undefined;
}
