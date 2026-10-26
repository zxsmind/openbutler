/**
 * Merges a provider's declared `payload` (and a model's override) into every
 * JSON request body sent to that provider.
 *
 * This rides on the fetch the runtime hands to `createLanguageModel`, so the
 * AI SDK's internals stay untouched and the merge is scoped to one provider.
 * Bodies merge shallowly: a payload key replaces the request's own key, which
 * is what `{"reasoning_effort": "low", "chat_template_kwargs": {...}}` needs.
 * Non-JSON and non-object bodies pass through unchanged.
 */
import type { ProviderState } from '../settings.js';

type Fetch = typeof globalThis.fetch;

export function createPayloadFetch(
  state: Pick<ProviderState, 'payload' | 'modelSpecs'> | undefined,
  modelId: string,
  impl: Fetch = globalThis.fetch,
): Fetch | undefined {
  const providerPayload = state?.payload;
  const modelPayload = state?.modelSpecs?.[modelId]?.payload;
  if ((!providerPayload || Object.keys(providerPayload).length === 0) && (!modelPayload || Object.keys(modelPayload).length === 0)) {
    return undefined;
  }
  return async (input, init) => {
    let next = init;
    if (init?.body !== undefined && typeof init.body === 'string' && init.body.length > 0) {
      try {
        const parsed: unknown = JSON.parse(init.body);
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          next = {
            ...init,
            body: JSON.stringify({ ...(parsed as Record<string, unknown>), ...providerPayload, ...modelPayload }),
          };
        }
      } catch {
        // A body that only looked like JSON is forwarded untouched.
      }
    }
    return impl(input, next);
  };
}
