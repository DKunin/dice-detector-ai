import { readFile } from 'node:fs/promises';
import fetch, { type RequestInit } from 'node-fetch';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { DICE_QUESTION, LOOKALIKE_QUESTION, type Config } from './config.js';
import type { Detection } from './types.js';

interface ResponseLike {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<ResponseLike>;

export class PermanentDetectionError extends Error {}

export class LunaDiceDetector {
  private readonly agent: RequestInit['agent'];
  private readonly secrets: string[];

  constructor(
    private readonly config: Pick<
      Config,
      | 'apiKey'
      | 'socksProxy'
      | 'apiUrl'
      | 'model'
      | 'diceThreshold'
      | 'lookalikeMax'
      | 'requestTimeoutMs'
      | 'maxRetries'
    >,
    private readonly fetchImpl: FetchLike = fetch as FetchLike,
  ) {
    this.agent = new SocksProxyAgent(config.socksProxy);
    this.secrets = secretFragments(config.apiKey, config.socksProxy);
  }

  async detect(previewPath: string, signal?: AbortSignal): Promise<Detection> {
    const imageBase64 = (await readFile(previewPath)).toString('base64');
    const body = JSON.stringify({
      model: this.config.model,
      input: [
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: 'Inspect this photo conservatively for real physical gaming dice.',
            },
            {
              type: 'input_image',
              image_url: `data:image/webp;base64,${imageBase64}`,
            },
          ],
        },
      ],
      questions: [
        { type: 'predicate', name: 'contains_rpg_dice', instructions: DICE_QUESTION },
        { type: 'predicate', name: 'lookalike_only', instructions: LOOKALIKE_QUESTION },
      ],
    });

    for (let attempt = 0; ; attempt += 1) {
      try {
        const requestSignal = signal
          ? AbortSignal.any([signal, AbortSignal.timeout(this.config.requestTimeoutMs)])
          : AbortSignal.timeout(this.config.requestTimeoutMs);
        const response = await this.fetchImpl(this.config.apiUrl, {
          method: 'POST',
          agent: this.agent,
          signal: requestSignal,
          headers: {
            authorization: `Bearer ${this.config.apiKey}`,
            'content-type': 'application/json',
          },
          body,
        });

        if (!response.ok) {
          const detail = this.redact((await response.text()).slice(0, 400));
          if (isRetryable(response.status) && attempt < this.config.maxRetries) {
            await backoff(attempt, response.headers.get('retry-after'), signal);
            continue;
          }
          const ErrorType = isRetryable(response.status) ? Error : PermanentDetectionError;
          throw new ErrorType(`OpenAI Decisions returned HTTP ${response.status}: ${detail}`);
        }
        return parseDecision(await response.json(), this.config.diceThreshold, this.config.lookalikeMax);
      } catch (error) {
        if (error instanceof PermanentDetectionError || signal?.aborted) throw error;
        if (attempt >= this.config.maxRetries) {
          throw new Error(`OpenAI Decisions request failed: ${this.redact(errorMessage(error))}`, {
            cause: error,
          });
        }
        await backoff(attempt, null, signal);
      }
    }
  }

  private redact(value: string): string {
    return this.secrets.reduce(
      (redacted, secret) => redacted.replaceAll(secret, '[redacted]'),
      value,
    );
  }
}

export function parseDecision(
  payload: unknown,
  diceThreshold: number,
  lookalikeMax: number,
): Detection {
  if (!isRecord(payload) || !Array.isArray(payload.answers)) {
    throw new PermanentDetectionError('OpenAI Decisions response has no answers array');
  }
  const diceProbability = predicateProbability(payload.answers, 'contains_rpg_dice');
  const lookalikeProbability = predicateProbability(payload.answers, 'lookalike_only');
  return {
    diceProbability,
    lookalikeProbability,
    detected: diceProbability >= diceThreshold && lookalikeProbability <= lookalikeMax,
  };
}

function predicateProbability(answers: unknown[], name: string): number {
  const answer = answers.find((candidate) => isRecord(candidate) && candidate.name === name);
  if (!isRecord(answer)) throw new PermanentDetectionError(`Missing answer ${name}`);
  if (answer.type === 'refusal') throw new PermanentDetectionError(`OpenAI refused ${name}`);
  if (answer.type !== 'predicate' || typeof answer.probability !== 'number') {
    throw new PermanentDetectionError(`Invalid predicate answer ${name}`);
  }
  if (answer.probability < 0 || answer.probability > 1) {
    throw new PermanentDetectionError(`Probability for ${name} is outside 0..1`);
  }
  return answer.probability;
}

function isRetryable(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

async function backoff(
  attempt: number,
  retryAfter: string | null,
  signal?: AbortSignal,
): Promise<void> {
  const retrySeconds = retryAfter === null ? Number.NaN : Number(retryAfter);
  const milliseconds = Number.isFinite(retrySeconds)
    ? Math.min(retrySeconds * 1_000, 60_000)
    : Math.min(1_000 * 2 ** attempt, 30_000) + Math.floor(Math.random() * 250);
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timeout);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

function secretFragments(apiKey: string, proxyUrl: string): string[] {
  const parsed = new URL(proxyUrl);
  return [apiKey, proxyUrl, proxyUrl.replace(/\/$/, ''), parsed.username, parsed.password]
    .filter((value) => value.length >= 4)
    .filter((value, index, all) => all.indexOf(value) === index);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
