import { describe, expect, it } from 'vitest';
import { createPayloadFetch } from '../../src/provider/request-payload.js';

function capturingFetch() {
  const seen: { url: unknown; body: unknown }[] = [];
  const impl: typeof fetch = async (input, init) => {
    seen.push({ url: String(input), body: init?.body ?? null });
    return new Response('ok', { status: 200 });
  };
  return { seen, impl };
}

describe('createPayloadFetch', () => {
  it('returns no wrapper when the provider declares no payload', () => {
    expect(createPayloadFetch(undefined, 'swift')).toBeUndefined();
    expect(createPayloadFetch({}, 'swift')).toBeUndefined();
    expect(createPayloadFetch({ payload: {} }, 'swift')).toBeUndefined();
    expect(createPayloadFetch({ modelSpecs: { swift: { context: 1 } } }, 'swift')).toBeUndefined();
  });

  it('merges provider payload, then the model payload, over the original body', async () => {
    const { seen, impl } = capturingFetch();
    const wrapped = createPayloadFetch(
      {
        payload: { reasoning_effort: 'low', chat_template_kwargs: { reasoning_effort: 'low' } },
        modelSpecs: { swift: { payload: { reasoning_effort: 'high' } } },
      },
      'swift',
      impl,
    );
    expect(wrapped).toBeTypeOf('function');
    await wrapped!('https://api.example/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'swift', reasoning_effort: 'xhigh', temperature: 0.2 }),
    });

    expect(seen).toHaveLength(1);
    expect(JSON.parse(String(seen[0].body))).toEqual({
      model: 'swift',
      reasoning_effort: 'high',
      temperature: 0.2,
      chat_template_kwargs: { reasoning_effort: 'low' },
    });
  });

  it('applies only the provider payload for a model without its own', async () => {
    const { seen, impl } = capturingFetch();
    const wrapped = createPayloadFetch({ payload: { reasoning_effort: 'low' }, modelSpecs: { other: {} } }, 'swift', impl);
    await wrapped!('https://api.example/v1/chat/completions', { method: 'POST', body: '{"model":"swift"}' });
    expect(JSON.parse(String(seen[0].body))).toEqual({ model: 'swift', reasoning_effort: 'low' });
  });

  it('forwards bodies that are not JSON objects untouched', async () => {
    const { seen, impl } = capturingFetch();
    const wrapped = createPayloadFetch({ payload: { reasoning_effort: 'low' } }, 'swift', impl);
    await wrapped!('https://api.example/upload', { method: 'POST', body: 'raw-bytes' });
    await wrapped!('https://api.example/upload', { method: 'POST', body: '[1,2,3]' });
    expect(seen.map((entry) => entry.body)).toEqual(['raw-bytes', '[1,2,3]']);
  });
});
