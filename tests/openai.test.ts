import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/config.js';
import { LunaDiceDetector, parseDecision, type FetchLike } from '../src/openai.js';

const config: Pick<
  Config,
  | 'apiKey'
  | 'socksProxy'
  | 'apiUrl'
  | 'model'
  | 'diceThreshold'
  | 'lookalikeMax'
  | 'requestTimeoutMs'
  | 'maxRetries'
> = {
  apiKey: 'secret-openai-key',
  socksProxy: 'socks5h://proxy-user:proxy-password@127.0.0.1:1080/',
  apiUrl: 'https://api.openai.test/v1/decisions',
  model: 'gpt-6-luna',
  diceThreshold: 0.94,
  lookalikeMax: 0.1,
  requestTimeoutMs: 5_000,
  maxRetries: 1,
};

describe('OpenAI Decisions client', () => {
  it('requires both high dice probability and low lookalike probability', () => {
    expect(
      parseDecision(
        {
          answers: [
            { type: 'predicate', name: 'contains_rpg_dice', probability: 0.98 },
            { type: 'predicate', name: 'lookalike_only', probability: 0.02 },
          ],
        },
        0.94,
        0.1,
      ).detected,
    ).toBe(true);
    expect(
      parseDecision(
        {
          answers: [
            { type: 'predicate', name: 'contains_rpg_dice', probability: 0.98 },
            { type: 'predicate', name: 'lookalike_only', probability: 0.5 },
          ],
        },
        0.94,
        0.1,
      ).detected,
    ).toBe(false);
  });

  it('sends inline WebP through the configured agent', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'dice-detector-ai-'));
    const preview = path.join(directory, 'preview.webp');
    await writeFile(preview, Buffer.from('preview'));
    const fetchImpl = vi.fn(async (_url: string, init: Parameters<FetchLike>[1]) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      expect(body.model).toBe('gpt-6-luna');
      expect(JSON.stringify(body)).toContain('data:image/webp;base64,cHJldmlldw==');
      expect(init.agent).toBeDefined();
      return response(200, {
        answers: [
          { type: 'predicate', name: 'contains_rpg_dice', probability: 0.99 },
          { type: 'predicate', name: 'lookalike_only', probability: 0.01 },
        ],
      });
    });
    const detector = new LunaDiceDetector(config, fetchImpl);
    await expect(detector.detect(preview)).resolves.toMatchObject({ detected: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries transient HTTP failures', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'dice-detector-ai-'));
    const preview = path.join(directory, 'preview.webp');
    await writeFile(preview, Buffer.from('preview'));
    const fetchImpl = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(response(429, { error: 'slow down' }, '0'))
      .mockResolvedValueOnce(
        response(200, {
          answers: [
            { type: 'predicate', name: 'contains_rpg_dice', probability: 0.1 },
            { type: 'predicate', name: 'lookalike_only', probability: 0.9 },
          ],
        }),
      );
    const detector = new LunaDiceDetector(config, fetchImpl);
    await expect(detector.detect(preview)).resolves.toMatchObject({ detected: false });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

function response(status: number, payload: unknown, retryAfter: string | null = null) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => retryAfter },
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}
