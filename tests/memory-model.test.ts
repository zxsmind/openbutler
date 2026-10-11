import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MEMORY_EMBEDDING_MODEL, MEMORY_EMBEDDING_REVISION, prepareMemoryEmbeddingModel } from '../src/memory-index.js';

const model = vi.hoisted(() => ({
  tokenizer: vi.fn(),
  load: vi.fn(),
  extract: vi.fn(),
  dispose: vi.fn(),
}));

vi.mock('@huggingface/transformers', () => ({
  AutoTokenizer: { from_pretrained: model.tokenizer },
  AutoModel: { from_pretrained: model.load },
  FeatureExtractionPipeline: vi.fn(function () {
    return Object.assign(model.extract, { dispose: model.dispose });
  }),
}));

beforeEach(() => {
  vi.stubEnv('RANITE_DATA_DIR', mkdtempSync(join(tmpdir(), 'ranite-memory-model-')));
  model.tokenizer.mockResolvedValue({});
  model.load.mockResolvedValue({});
  model.dispose.mockResolvedValue(undefined);
  const normalized = new Float32Array(384);
  normalized[0] = 1;
  model.extract.mockResolvedValue({ dims: [1, 384], data: normalized });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('setup memory model readiness', () => {
  it('uses the pinned CPU model, validates a real-sized normalized vector, and disposes sessions', async () => {
    await prepareMemoryEmbeddingModel();
    expect(model.load).toHaveBeenCalledWith(
      MEMORY_EMBEDDING_MODEL,
      expect.objectContaining({
        revision: MEMORY_EMBEDDING_REVISION,
        device: 'cpu',
        dtype: 'q8',
        cache_dir: join(process.env.RANITE_DATA_DIR!, 'models'),
      }),
    );
    expect(model.extract).toHaveBeenCalledWith(['Local memory search readiness check.'], { pooling: 'mean', normalize: true });
    expect(model.dispose).toHaveBeenCalledTimes(1);
  });

  it('loads a complete pinned cache by its absolute path for offline operation', async () => {
    const cachedDirectory = join(process.env.RANITE_DATA_DIR!, 'models', MEMORY_EMBEDDING_MODEL, MEMORY_EMBEDDING_REVISION);
    mkdirSync(join(cachedDirectory, 'onnx'), { recursive: true });
    for (const file of ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_quantized.onnx']) {
      writeFileSync(join(cachedDirectory, file), 'cached fixture');
    }
    await prepareMemoryEmbeddingModel();
    expect(model.tokenizer).toHaveBeenCalledWith(cachedDirectory, expect.objectContaining({ local_files_only: true }));
    expect(model.load).toHaveBeenCalledWith(cachedDirectory, expect.objectContaining({ local_files_only: true }));
  });

  it('rejects invalid inference without marking memory ready and still releases the model', async () => {
    model.extract.mockResolvedValue({ dims: [1, 384], data: new Float32Array(384).fill(Number.NaN) });
    await expect(prepareMemoryEmbeddingModel()).rejects.toThrow('invalid embedding');
    expect(model.dispose).toHaveBeenCalledTimes(1);
    model.extract.mockRejectedValue(new Error('inference failed'));
    await expect(prepareMemoryEmbeddingModel()).rejects.toThrow('inference failed');
    expect(model.dispose).toHaveBeenCalledTimes(2);
  });
});
