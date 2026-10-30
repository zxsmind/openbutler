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
      'Find durable Markdown memory relevant to an earlier decision, a user preference or correction, an ongoing project, or a similar failure. Also use it to locate an existing home before saving a fact. If the relevant path is already known, open it directly with file_read; no search or reread is needed for current contents already in context. Searches shared user memory (preferences, profile, topics, areas), local peer notes, the active workspace profile and active team, never session transcripts or other workspaces or former teams. Use an English semantic query, preserving exact identifiers. Results mix meaning with exact terms and cite canonical paths and 1-based lines; read the relevant note with file_read to check conditions and freshness before applying it. For past conversations use session_search/session_read. Statuses: completed, no_matches, empty_memory, empty_notes, model_preparing, model_unavailable, invalid. If search is unavailable, read a known note or the current MEMORY.md rather than inventing a remembered fact. indexIssues reports index links needing repair.',
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
          message: `The local embedding model is not ready: ${preparation.error ?? 'preparation failed'}. Retry later, or run \`openbutler setup\` and choose the local memory model option.`,
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
