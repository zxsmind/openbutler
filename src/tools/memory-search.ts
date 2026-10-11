import {
  isMemoryEmbeddingModelPrepared,
  MEMORY_EMBEDDING_DIMENSIONS,
  MEMORY_EMBEDDING_MODEL_NAME,
  type MemoryIndex,
} from '../memory-index.js';
import { ensureMemoryModelPreparation } from '../memory-model-preparation.js';
import type { ToolDefinition } from './registry.js';

const memorySearchEffect = {
  change: 'none',
  data: 'sensitive',
  network: 'none',
  reversible: 'full',
  outbound: 'model',
} as const;

/** Semantic retrieval over Markdown files, with canonical file and line citations. */
export function createMemorySearchTool(index: MemoryIndex): ToolDefinition {
  return {
    providerId: 'host',
    name: 'memory_search',
    description:
      'Search durable Markdown memory with the local embedding model. Searches the shared user scope and the active workspace only, never session transcripts or other workspaces. Results mix meaning with exact term and identifier matches; unrelated queries return no_matches instead of weak rows. Each match cites the canonical path, title, description, full heading hierarchy, and exact 1-based lines; use file_read around the citation before relying on conditions. Statuses: completed, no_matches, empty_memory (no notes saved), empty_notes (notes without searchable text), model_preparing (first-time local model download in progress), model_unavailable (with the reason), invalid. indexIssues reports MEMORY.md links that need fixing.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'A natural-language question or exact identifier to find in durable memory.' },
        limit: { type: 'integer', minimum: 1, maximum: 10, description: 'Maximum number of source chunks to return; defaults to 5.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    effect: memorySearchEffect,
    autoApprove: () => true,
    execute: async (input) => {
      const query = typeof input.query === 'string' ? input.query : '';
      if (!query.trim()) return { status: 'invalid', error: 'query must be a non-empty string.' };
      if (query.length > 2_000) return { status: 'invalid', error: 'query must be 2,000 characters or fewer.' };
      const rawLimit = typeof input.limit === 'number' ? input.limit : 5;
      if (!Number.isSafeInteger(rawLimit) || rawLimit < 1 || rawLimit > 10) {
        return { status: 'invalid', error: 'limit must be an integer between 1 and 10.' };
      }
      if (!(await isMemoryEmbeddingModelPrepared().catch(() => false))) {
        const preparation = ensureMemoryModelPreparation();
        if (preparation.state === 'preparing') {
          return {
            status: 'model_preparing',
            query,
            message:
              'The local embedding model is being prepared in the background (a first-time download); retry this search in a moment.',
          };
        }
        return {
          status: 'model_unavailable',
          query,
          message: `The local embedding model is not ready: ${preparation.error ?? 'preparation failed'}. Retry later, or run \`ranite setup\` and choose the local memory model option.`,
        };
      }
      const search = await index.search(query, rawLimit);
      return {
        status: search.emptyMemory
          ? 'empty_memory'
          : search.indexedChunks === 0
            ? 'empty_notes'
            : search.matches.length > 0
              ? 'completed'
              : 'no_matches',
        query,
        indexedSources: search.indexedSources,
        indexedChunks: search.indexedChunks,
        ...(search.indexIssues && search.indexIssues.length > 0 ? { indexIssues: search.indexIssues } : {}),
        ...(search.indexedChunks > 0
          ? {
              embedding: {
                model: MEMORY_EMBEDDING_MODEL_NAME,
                dimensions: MEMORY_EMBEDDING_DIMENSIONS,
                runtime: 'local',
              },
            }
          : {}),
        ...(search.emptyMemory
          ? {
              message:
                'No detailed profile or topic memory notes have been saved for this user or the active workspace. The concise MEMORY.md entrypoint is separate; memory_search does not search session transcripts.',
            }
          : search.indexedChunks === 0
            ? {
                message: 'Memory Markdown files exist, but they contain no searchable note text.',
              }
            : {}),
        matches: search.matches,
      };
    },
  };
}
