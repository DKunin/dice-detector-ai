import { createHash } from 'node:crypto';

export const DICE_QUESTION =
  'Are one or more real, physical tabletop role-playing or board-game dice visibly present in the photo? Count polyhedral dice such as d4, d6, d8, d10, d12, d20 and percentile dice, including partially occluded dice. Do not count printed or screen images of dice, dice-shaped logos, jewelry, buttons, buildings, windows, toys without numbered faces, or other geometric objects.';

export const LOOKALIKE_QUESTION =
  'Does this photo contain only dice-like false-positive shapes and no real physical gaming dice? Examples include red clothing, rings or jewelry, buildings or windows, color wheels, numbered bottles or containers, UI graphics, printed dice pictures, and other polygonal objects.';

export interface Config {
  apiKey: string;
  socksProxy: string;
  apiUrl: string;
  model: string;
  photoKunDatabasePath: string;
  thumbnailRoot: string;
  stateDatabasePath: string;
  statusPath: string;
  targetAuthSubject: string;
  libraryRoot: string;
  diceThreshold: number;
  lookalikeMax: number;
  positiveConfirmations: number;
  concurrency: number;
  pollIntervalMs: number;
  requestTimeoutMs: number;
  maxRetries: number;
  runOnce: boolean;
  dryRun: boolean;
  scanLimit: number | null;
  entryIds: string[];
  detectorVersion: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const apiKey = required(env.OPENAI_API_KEY, 'OPENAI_API_KEY');
  const socksProxy = normalizeSocksProxy(
    required(env.SOCKS5_PROXY ?? env.DICE_TAGGER_SOCKS_PROXY, 'SOCKS5_PROXY'),
  );
  const model = env.OPENAI_MODEL?.trim() || 'gpt-6-luna';
  const diceThreshold = numberInRange(env.DICE_PROBABILITY_THRESHOLD, 0.94, 0, 1);
  const lookalikeMax = numberInRange(env.LOOKALIKE_PROBABILITY_MAX, 0.1, 0, 1);
  const positiveConfirmations = integerInRange(env.POSITIVE_CONFIRMATIONS, 2, 1, 3);
  const configuredVersion = env.DETECTOR_VERSION?.trim();
  const versionInput = [
    model,
    DICE_QUESTION,
    LOOKALIKE_QUESTION,
    diceThreshold,
    lookalikeMax,
    positiveConfirmations,
  ].join('\n');

  return {
    apiKey,
    socksProxy,
    apiUrl: env.OPENAI_API_URL?.trim() || 'https://api.openai.com/v1/decisions',
    model,
    photoKunDatabasePath:
      env.PHOTOKUN_DATABASE_PATH?.trim() || '/photokun-data/photokun.sqlite',
    thumbnailRoot: env.THUMBNAIL_ROOT?.trim() || '/photokun-thumbnails',
    stateDatabasePath: env.STATE_DATABASE_PATH?.trim() || '/data/dice-detector-ai.sqlite',
    statusPath: env.STATUS_PATH?.trim() || '/data/status.json',
    targetAuthSubject: required(env.TARGET_AUTH_SUBJECT, 'TARGET_AUTH_SUBJECT'),
    libraryRoot: normalizeLibraryRoot(env.LIBRARY_ROOT?.trim() || '/dkuninphotos'),
    diceThreshold,
    lookalikeMax,
    positiveConfirmations,
    concurrency: integerInRange(env.CONCURRENCY, 4, 1, 16),
    pollIntervalMs: integerInRange(env.POLL_INTERVAL_MS, 60_000, 5_000, 3_600_000),
    requestTimeoutMs: integerInRange(env.REQUEST_TIMEOUT_MS, 60_000, 5_000, 300_000),
    maxRetries: integerInRange(env.MAX_RETRIES, 4, 0, 10),
    runOnce: booleanValue(env.RUN_ONCE, false),
    dryRun: booleanValue(env.DRY_RUN, false),
    scanLimit: positiveIntegerOrNull(env.SCAN_LIMIT),
    entryIds: (env.ENTRY_IDS ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
    detectorVersion:
      configuredVersion || `luna-dice-${createHash('sha256').update(versionInput).digest('hex').slice(0, 12)}`,
  };
}

export function normalizeSocksProxy(value: string): string {
  const parsed = new URL(value);
  if (parsed.protocol === 'socks5:') parsed.protocol = 'socks5h:';
  if (parsed.protocol !== 'socks5h:') {
    throw new Error('SOCKS5_PROXY must use socks5:// or socks5h://');
  }
  return parsed.toString();
}

function required(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}

function numberInRange(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`Expected a number from ${minimum} to ${maximum}, received ${value}`);
  }
  return parsed;
}

function integerInRange(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = numberInRange(value, fallback, minimum, maximum);
  if (!Number.isInteger(parsed)) throw new Error(`Expected an integer, received ${value}`);
  return parsed;
}

function positiveIntegerOrNull(value: string | undefined): number | null {
  if (!value || value === '0') return null;
  return integerInRange(value, 0, 1, Number.MAX_SAFE_INTEGER);
}

function booleanValue(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`Expected true or false, received ${value}`);
}

function normalizeLibraryRoot(value: string): string {
  const normalized = `/${value.split('/').filter(Boolean).join('/')}`;
  return normalized === '/' ? '/' : normalized.replace(/\/$/, '');
}
