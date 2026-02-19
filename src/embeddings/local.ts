import type { EmbeddingProvider } from '../types.js';

const log = (...args: unknown[]) => console.log('[lsm-ei:local]', ...args);
const logError = (...args: unknown[]) => console.error('[lsm-ei:local]', ...args);

export interface LocalEmbeddingConfig {
  model?: string;
  dimensions?: number;
}

export class LocalEmbedding implements EmbeddingProvider {
  readonly dimensions: number;
  private model: string;
  private pipelinePromise: Promise<any> | null = null;

  constructor(config: LocalEmbeddingConfig = {}) {
    this.model = config.model ?? 'BAAI/bge-base-en-v1.5';
    this.dimensions = config.dimensions ?? 768;
    log(`initialized model=${this.model} dimensions=${this.dimensions}`);
  }

  private getPipeline(): Promise<any> {
    if (!this.pipelinePromise) {
      log('lazy-initializing local pipeline (first call downloads the model)');
      this.pipelinePromise = import('@huggingface/transformers').then(
        ({ pipeline }) => pipeline('feature-extraction', this.model),
      );
    }
    return this.pipelinePromise;
  }

  async embed(text: string): Promise<Float32Array> {
    const result = await this.embedBatch([text]);
    return result[0];
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    log(`embedBatch count=${texts.length} totalChars=${texts.reduce((s, t) => s + t.length, 0)}`);
    try {
      const pipe = await this.getPipeline();
      const outputs = await pipe(texts, { pooling: 'mean', normalize: true });

      const vectors: Float32Array[] = [];
      for (let i = 0; i < texts.length; i++) {
        vectors.push(new Float32Array(outputs[i].data));
      }

      log(`embedBatch complete vectors=${vectors.length}`);
      return vectors;
    } catch (err) {
      logError(`embedBatch failed for ${texts.length} text(s)`, err);
      throw err;
    }
  }
}
