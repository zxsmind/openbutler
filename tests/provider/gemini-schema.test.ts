import { describe, expect, it } from 'vitest';
import { geminiToolSchemaSanitizer, sanitizeGeminiToolSchema } from '../../src/provider/gemini-schema.js';

describe('geminiToolSchemaSanitizer gate', () => {
  it('only answers for models whose requests Google validates', () => {
    expect(geminiToolSchemaSanitizer({ provider: '@ai-sdk/google', modelId: 'gemini-3.5-flash' })).toBeTypeOf('function');
    expect(geminiToolSchemaSanitizer({ provider: '@ai-sdk/google-vertex', modelId: 'gemini-3-pro' })).toBeTypeOf('function');
    expect(geminiToolSchemaSanitizer({ provider: '@openrouter/ai-sdk-provider', modelId: 'google/gemini-2.5-flash' })).toBeTypeOf(
      'function',
    );
    expect(geminiToolSchemaSanitizer({ provider: '@ai-sdk/openai', modelId: 'gpt-5' })).toBeUndefined();
    expect(geminiToolSchemaSanitizer({ provider: '@ai-sdk/anthropic', modelId: 'claude-sonnet-4-5' })).toBeUndefined();
    expect(geminiToolSchemaSanitizer('google/gemini-2.5-flash')).toBeTypeOf('function');
    expect(geminiToolSchemaSanitizer('alibaba/qwen-3-14b')).toBeUndefined();
    expect(geminiToolSchemaSanitizer(undefined)).toBeUndefined();
  });
});

describe('sanitizeGeminiToolSchema', () => {
  it('strips every sibling of anyOf and type-stamps its branches', () => {
    const schema = {
      type: 'object',
      description: 'Root',
      properties: { text: { type: 'string' }, kind: { type: 'string' } },
      anyOf: [{ required: ['text'] }, { required: ['kind'] }],
    };
    expect(sanitizeGeminiToolSchema(schema)).toEqual({
      anyOf: [
        { type: 'object', required: ['text'] },
        { type: 'object', required: ['kind'] },
      ],
    });
  });

  it('strips the siblings of oneOf the same way', () => {
    expect(sanitizeGeminiToolSchema({ type: 'array', description: 'Entries', oneOf: [{ type: 'string' }, { type: 'number' }] })).toEqual({
      oneOf: [{ type: 'string' }, { type: 'number' }],
    });
  });

  it('declares the object type for nodes that carry properties or required without one', () => {
    expect(sanitizeGeminiToolSchema({ properties: { a: { type: 'string' } }, required: ['a'] })).toEqual({
      type: 'object',
      properties: { a: { type: 'string' } },
      required: ['a'],
    });
  });

  it('drops object-only keywords from an explicitly non-object node', () => {
    expect(sanitizeGeminiToolSchema({ type: 'string', properties: { a: { type: 'string' } }, required: ['a'] })).toEqual({
      type: 'string',
    });
  });

  it('turns a nullable scalar type array into its plain type', () => {
    expect(sanitizeGeminiToolSchema({ type: ['string', 'null'], description: 'A name' })).toEqual({
      type: 'string',
      description: 'A name',
    });
  });

  it('turns a multi-type array into an anyOf-only node', () => {
    expect(sanitizeGeminiToolSchema({ type: ['integer', 'number', 'null'], description: 'A number' })).toEqual({
      anyOf: [{ type: 'integer' }, { type: 'number' }],
    });
  });

  it('normalizes nested nodes without mutating the input', () => {
    const schema = {
      type: 'object',
      properties: {
        list: { type: 'array', items: { required: ['path'], properties: { path: { type: 'string' } } } },
      },
    };
    const before = JSON.parse(JSON.stringify(schema));
    expect(sanitizeGeminiToolSchema(schema)).toEqual({
      type: 'object',
      properties: {
        list: { type: 'array', items: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } } },
      },
    });
    expect(schema).toEqual(before);
  });
});
