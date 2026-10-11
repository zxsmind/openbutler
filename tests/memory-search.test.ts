import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gateMemoryScores, MEMORY_SEARCH_BAND_RATIO, MEMORY_SEARCH_FLOOR, MemoryIndex } from '../src/memory-index.js';
import type { MemorySearchResult } from '../src/memory-index.js';
import { createMemorySearchTool } from '../src/tools/memory-search.js';
import { getMemoryPaths } from '../src/memory-paths.js';
import { createWriteTool } from '../src/tools/file-write.js';

const dimensions = 384;

const fake = vi.hoisted(() => {
  const wordIds = new Map<string, number>();
  const encode = (text: string): number[] => {
    const words = text.toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? [];
    const ids = words.map((word) => {
      let id = wordIds.get(word);
      if (id === undefined) {
        id = wordIds.size + 1;
        wordIds.set(word, id);
      }
      return id;
    });
    return ids.length > 0 ? ids : [0];
  };
  return {
    encode,
    reset: () => wordIds.clear(),
    session: {
      inputNames: ['input_ids', 'attention_mask', 'token_type_ids'],
      outputNames: ['last_hidden_state'],
      release: vi.fn(async () => {}),
      run: vi.fn(async (feeds: Record<string, { data: BigInt64Array; dims: number[] }>) => {
        const ids = feeds.input_ids!.data;
        const [batch, sequence] = feeds.input_ids!.dims;
        const data = new Float32Array(batch! * sequence! * dimensions);
        for (let index = 0; index < ids.length; index++) data[index * dimensions + (Number(ids[index]!) % dimensions)] = 1;
        return { last_hidden_state: { dims: [batch, sequence, dimensions], data } };
      }),
    },
  };
});

vi.mock('onnxruntime-node', () => ({
  InferenceSession: { create: vi.fn(async () => fake.session) },
  Tensor: class {
    constructor(
      readonly type: string,
      readonly data: BigInt64Array,
      readonly dims: number[],
    ) {}
  },
}));

vi.mock('@huggingface/tokenizers', () => ({
  Tokenizer: class {
    encode(text: string) {
      const ids = fake.encode(text);
      return { ids, attention_mask: ids.map(() => 1), token_type_ids: ids.map(() => 0) };
    }
  },
}));

function memoryDataDirectory(): string {
  return join(process.env.RANITE_DATA_DIR!, 'models', 'Xenova/all-MiniLM-L6-v2', '751bff37182d3f1213fa05d7196b954e230abad9');
}

function writeModelCache() {
  const directory = memoryDataDirectory();
  mkdirSync(join(directory, 'onnx'), { recursive: true });
  for (const file of ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_quantized.onnx']) {
    writeFileSync(join(directory, file), '{}');
  }
}

const subtitleNote = `---
type: project
title: Subtitle Pipeline
description: Extraction and timing rules for subtitle files.
---
# Subtitle Pipeline
## Encoding
### Timing Rules
#### Summary
Subtitle extraction keeps original timing offsets for the ripping pipeline.
#### Details
Timing offsets survive subtitle extraction; the pipeline only normalizes encoding.
`;

function put(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

let root: string;
let workspace: string;
beforeEach(() => {
  fake.reset();
  fake.session.run.mockClear();
  root = mkdtempSync(join(tmpdir(), 'ranite-memory-search-test-'));
  workspace = join(root, 'workspace');
  mkdirSync(workspace);
  vi.stubEnv('RANITE_DATA_DIR', join(root, 'data'));
  writeModelCache();
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe('relevance gates', () => {
  it('drops below-floor rows, trims the tail outside the top band, and applies the limit last', () => {
    const scores = [0.9, 0.85, 0.8, 0.62, 0.58, 0.29, 0.1].map((score) => ({ score }));
    // floor 0.30 removes 0.29/0.1; band 0.65 * 0.9 = 0.585 removes 0.58.
    expect(gateMemoryScores(scores, 10).map((item) => item.score)).toEqual([0.9, 0.85, 0.8, 0.62]);
    expect(gateMemoryScores(scores, 2).map((item) => item.score)).toEqual([0.9, 0.85]);
    expect(gateMemoryScores([{ score: MEMORY_SEARCH_FLOOR - 0.01 }], 5)).toEqual([]);
    expect(gateMemoryScores([], 5)).toEqual([]);
    expect(MEMORY_SEARCH_BAND_RATIO).toBeLessThan(1);
    expect(MEMORY_SEARCH_FLOOR).toBeGreaterThan(0.2);
  });
});

describe('search over the derived index', () => {
  it('finds a related note, reports no matches honestly, and never returns another workspace', async () => {
    const paths = getMemoryPaths(workspace);
    put(join(paths.userTopicsDirectory, 'subtitle-pipeline.md'), subtitleNote);
    const other = join(root, 'other-workspace');
    mkdirSync(other);
    put(join(getMemoryPaths(other).workspaceTopicsDirectory, 'foreign.md'), subtitleNote.replace('Subtitle Pipeline', 'Foreign Copy'));
    const index = new MemoryIndex(workspace);
    try {
      const related = await index.search('subtitle extraction timing', 5);
      expect(related.matches.length).toBeGreaterThan(0);
      expect(related.matches[0]!.path).toBe(join(paths.userTopicsDirectory, 'subtitle-pipeline.md'));
      expect(related.matches[0]!.heading).toContain('Timing Rules');
      expect(related.matches.every((match) => !match.path.includes('other-workspace'))).toBe(true);
      const unrelated = await index.search('kubernetes ingress certificate renewal', 5);
      expect(unrelated.matches).toEqual([]);
      expect(unrelated.indexedChunks).toBeGreaterThan(0);
    } finally {
      await index.close();
    }
  });

  it('reindexes changed and deleted notes on the next search without a filesystem watcher', async () => {
    const paths = getMemoryPaths(workspace);
    const notePath = join(paths.userTopicsDirectory, 'pipeline-step.md');
    put(notePath, subtitleNote);
    const index = new MemoryIndex(workspace);
    try {
      expect((await index.search('subtitle extraction timing', 5)).matches.length).toBeGreaterThan(0);
      put(
        notePath,
        `---
type: project
title: Loudness Normalization
description: Audio loudness targets for rendered files.
---
# Loudness Normalization
## Audio
### Loudness Targets
#### Summary
Rendered audio uses loudness normalization to minus fourteen loudness units.
`,
      );
      expect((await index.search('chroma subtitle timing', 5)).matches).toEqual([]);
      const updated = await index.search('loudness normalization audio', 5);
      expect(updated.matches[0]?.path).toBe(notePath);
    } finally {
      await index.close();
    }
  });

  it('reports MEMORY.md gaps and dangling links as index issues, repaired by the next native note write', async () => {
    const paths = getMemoryPaths(workspace);
    const notePath = join(paths.userTopicsDirectory, 'subtitle-pipeline.md');
    put(notePath, subtitleNote);
    const index = new MemoryIndex(workspace);
    try {
      const before = await index.search('subtitle extraction timing', 5);
      expect(before.indexIssues).toEqual([expect.stringContaining('no MEMORY.md entry')]);
      const writeTool = createWriteTool(workspace);
      expect(await writeTool.execute({ path: notePath, content: subtitleNote })).toMatchObject({ memoryIndexEntry: 'added' });
      expect((await index.search('subtitle extraction timing', 5)).indexIssues).toBeUndefined();
      put(paths.indexFile, `${readFileSync(paths.indexFile, 'utf8')}- [Gone](user/notes/gone.md) — removed note\n`);
      expect((await index.search('subtitle extraction timing', 5)).indexIssues).toContain(
        'MEMORY.md links a missing document: user/notes/gone.md',
      );
    } finally {
      await index.close();
    }
  });
});

describe('memory_search tool statuses', () => {
  function toolFor(result: Partial<MemorySearchResult>) {
    const index = {
      search: vi.fn(async () => ({ matches: [], indexedSources: 0, indexedChunks: 0, emptyMemory: false, ...result })),
    } as unknown as MemoryIndex;
    return createMemorySearchTool(index);
  }

  it('maps engine results to empty_memory, empty_notes, no_matches, and completed', async () => {
    expect(await toolFor({ emptyMemory: true }).execute({ query: 'anything' })).toMatchObject({ status: 'empty_memory' });
    expect(await toolFor({ indexedSources: 2, indexedChunks: 0 }).execute({ query: 'anything' })).toMatchObject({
      status: 'empty_notes',
    });
    expect(await toolFor({ indexedSources: 2, indexedChunks: 5 }).execute({ query: 'anything' })).toMatchObject({
      status: 'no_matches',
    });
    const match = {
      path: 'C:\\memory\\user\\notes\\note.md',
      startLine: 1,
      endLine: 2,
      type: 'user' as const,
      title: 'Note',
      description: '',
      heading: 'Note > Summary',
      score: 0.5,
      snippet: 'text',
    };
    expect(await toolFor({ indexedSources: 1, indexedChunks: 1, matches: [match] }).execute({ query: 'anything' })).toMatchObject({
      status: 'completed',
      matches: [expect.objectContaining({ path: match.path })],
    });
  });
});
