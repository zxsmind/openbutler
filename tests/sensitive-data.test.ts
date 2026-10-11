import { expect, it } from 'vitest';
import { classifySensitiveEntry, redactSensitive, redactSensitiveText } from '../src/sensitive-data.js';

it('classifies real secrets without flagging token counts', () => {
  expect(classifySensitiveEntry('accessToken', 'x')).toBe('secret');
  expect(classifySensitiveEntry('refresh_token', 'x')).toBe('secret');
  expect(classifySensitiveEntry('apiKey', 'x')).toBe('secret');
  expect(classifySensitiveEntry('token', 'x')).toBe('secret');
  expect(classifySensitiveEntry('x-token', 'x')).toBe('secret');
  expect(classifySensitiveEntry('password', 'x')).toBe('secret');
  expect(classifySensitiveEntry('inputTokens', 1_200)).toBeNull();
  expect(classifySensitiveEntry('maxTokens', 8_000)).toBeNull();
  expect(classifySensitiveEntry('tokenizer', 'cl100k_base')).toBeNull();
  expect(classifySensitiveEntry('tokenCount', 12)).toBeNull();
});

it('only treats a media key as a payload when the value is actually one', () => {
  expect(classifySensitiveEntry('image', 'photo.png')).toBeNull();
  expect(classifySensitiveEntry('image', 'x'.repeat(2_048))).toBe('media');
  expect(classifySensitiveEntry('image', 'data:image/png;base64,AAAA')).toBe('media');
  expect(classifySensitiveEntry('imageCount', 2)).toBeNull();
  expect(classifySensitiveEntry('base64', 'short')).toBeNull();
});

it('redacts nested secrets and payload strings without touching counts or names', () => {
  expect(
    redactSensitive({
      apiKey: 'abc',
      inputTokens: 10,
      image: 'photo.png',
      nested: { password: 'p', count: 3 },
    }),
  ).toEqual({
    apiKey: '[redacted]',
    inputTokens: 10,
    image: 'photo.png',
    nested: { password: '[redacted]', count: 3 },
  });
  expect(redactSensitiveText('Authorization: Bearer abc.def')).toBe('Authorization: Bearer [redacted]');
  expect(redactSensitiveText('password=hunter2')).toBe('password=[redacted]');
});
