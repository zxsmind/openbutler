import type { ToolDefinition, ToolEffect } from './registry.js';

const MAX_QUESTION_CHARS = 2_000;
const MAX_OPTION_CHARS = 120;
const MAX_OPTIONS = 8;

const questionEffect: ToolEffect = {
  change: 'none',
  data: 'local',
  network: 'none',
  reversible: 'full',
  outbound: 'model',
};

/** Asks the interactive user a question and returns the answer to the model. */
export function createQuestionTool(): ToolDefinition {
  return {
    providerId: 'host',
    name: 'question',
    description:
      'Ask the user one direct question during a run and wait for their answer. Provide short options when you can enumerate the likely answers; the user can still reply in their own words. Use it for a blocking choice or a missing detail you cannot discover with tools or safe defaults — not for progress updates or rhetorical questions. In unattended or background runs no interactive user is attached; the tool then reports that and you must include the question in your final response instead.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The single question to ask, with enough context to answer it.' },
        options: {
          type: 'array',
          items: { type: 'string' },
          maxItems: MAX_OPTIONS,
          description: `Optional 1-${MAX_OPTIONS} short suggested answers; the user may still answer freely.`,
        },
      },
      required: ['question'],
      additionalProperties: false,
    },
    effect: questionEffect,
    autoApprove: () => true,
    execute: async (input, signal, context) => {
      const question = typeof input.question === 'string' ? input.question.trim() : '';
      if (!question) return { status: 'invalid', error: 'question must be a non-empty string.' };
      if (question.length > MAX_QUESTION_CHARS) {
        return { status: 'invalid', error: `question must be at most ${MAX_QUESTION_CHARS} characters.` };
      }
      const rawOptions = input.options;
      let options: string[] | undefined;
      if (rawOptions !== undefined) {
        const invalid =
          !Array.isArray(rawOptions) ||
          rawOptions.length === 0 ||
          rawOptions.length > MAX_OPTIONS ||
          rawOptions.some((option) => typeof option !== 'string' || !option.trim() || option.length > MAX_OPTION_CHARS);
        if (invalid) {
          return {
            status: 'invalid',
            error: `options must be 1-${MAX_OPTIONS} non-empty strings of at most ${MAX_OPTION_CHARS} characters.`,
          };
        }
        options = (rawOptions as string[]).map((option) => option.trim());
      }
      if (!context?.ask) {
        return {
          status: 'unavailable',
          error: 'No interactive user is attached to this run. Include the question in your final response instead of waiting.',
        };
      }
      const answer = await context.ask({ text: question, ...(options ? { options } : {}) }, signal);
      if (answer === null) {
        return {
          status: 'dismissed',
          error:
            'The user dismissed the question without answering. Continue with your best judgment, state the assumption you made, or include the question in your final response.',
        };
      }
      return { status: 'answered', question, answer };
    },
  };
}
