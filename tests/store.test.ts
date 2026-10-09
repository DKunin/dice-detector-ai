import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import { PhotoKunStore, thumbnailVersion } from '../src/store.js';

describe('PhotoKun store', () => {
  it('selects the current preview newest-first and writes an idempotent tag', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'dice-detector-ai-store-'));
    const databasePath = path.join(root, 'photokun.sqlite');
    const statePath = path.join(root, 'state.sqlite');
    const thumbnailRoot = path.join(root, 'thumbnails');
    await mkdir(path.join(thumbnailRoot, 'small'), { recursive: true });
    const sqlite = new Database(databasePath);
    sqlite.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY, auth_subject TEXT NOT NULL UNIQUE);
      CREATE TABLE filesystem_entries (
        id TEXT PRIMARY KEY, path TEXT NOT NULL, type TEXT NOT NULL, etag TEXT,
        webdav_modified_at TEXT, indexed_at TEXT NOT NULL, size INTEGER, missing_at TEXT
      );
      CREATE TABLE photo_metadata (
        entry_id TEXT PRIMARY KEY, captured_at TEXT, extraction_error TEXT
      );
      CREATE TABLE photo_tags (user_id TEXT, entry_id TEXT, tag TEXT);
      CREATE UNIQUE INDEX photo_tags_pk ON photo_tags(user_id, entry_id, tag);
    `);
    sqlite.prepare('INSERT INTO users VALUES (?, ?)').run('user-1', 'subject-1');
    const older = randomUUID();
    const newer = randomUUID();
    insertPhoto(sqlite, older, '/dkuninphotos/older.jpg', 'old-etag', '2025-01-01');
    insertPhoto(sqlite, newer, '/dkuninphotos/newer.jpg', 'new-etag', '2026-01-01');
    for (const [id, etag] of [
      [older, 'old-etag'],
      [newer, 'new-etag'],
    ]) {
      const version = createHash('sha256').update(etag).digest('hex').slice(0, 16);
      await writeFile(path.join(thumbnailRoot, 'small', `${id}-${version}.webp`), 'preview');
    }
    sqlite.close();

    const config = makeConfig(databasePath, statePath, thumbnailRoot);
    const store = new PhotoKunStore(config);
    const entries = store.listCandidates().entries;
    expect(entries.map((entry) => entry.id)).toEqual([newer, older]);
    const detection = { detected: true, diceProbability: 0.99, lookalikeProbability: 0.01 };
    expect(store.saveResult(entries[0]!, detection, true)).toBe(1);
    expect(store.saveResult(entries[0]!, detection, true)).toBe(0);
    expect(store.isProcessed(entries[0]!)).toBe(true);
    store.close();

    const verification = new Database(databasePath, { readonly: true });
    expect(verification.prepare('SELECT count(*) AS count FROM photo_tags').get()).toEqual({
      count: 1,
    });
    verification.close();
  });

  it('matches PhotoKun thumbnail version semantics', () => {
    expect(thumbnailVersion({ etag: 'abc', modifiedAt: null, size: null })).toBe(
      createHash('sha256').update('abc').digest('hex').slice(0, 16),
    );
    expect(thumbnailVersion({ etag: null, modifiedAt: 'date', size: 42 })).toBe(
      createHash('sha256').update('date:42').digest('hex').slice(0, 16),
    );
  });
});

function insertPhoto(
  sqlite: Database.Database,
  id: string,
  photoPath: string,
  etag: string,
  capturedAt: string,
): void {
  sqlite
    .prepare('INSERT INTO filesystem_entries VALUES (?, ?, ?, ?, ?, ?, ?, NULL)')
    .run(id, photoPath, 'image', etag, capturedAt, capturedAt, 100);
  sqlite.prepare('INSERT INTO photo_metadata VALUES (?, ?, NULL)').run(id, capturedAt);
}

function makeConfig(databasePath: string, statePath: string, thumbnailRoot: string): Config {
  return {
    apiKey: 'test-key',
    socksProxy: 'socks5h://127.0.0.1:1080/',
    apiUrl: 'https://api.openai.test/v1/decisions',
    model: 'gpt-6-luna',
    photoKunDatabasePath: databasePath,
    thumbnailRoot,
    stateDatabasePath: statePath,
    statusPath: path.join(path.dirname(statePath), 'status.json'),
    targetAuthSubject: 'subject-1',
    libraryRoot: '/dkuninphotos',
    diceThreshold: 0.94,
    lookalikeMax: 0.1,
    positiveConfirmations: 2,
    concurrency: 4,
    pollIntervalMs: 60_000,
    requestTimeoutMs: 60_000,
    maxRetries: 4,
    runOnce: true,
    dryRun: false,
    scanLimit: null,
    entryIds: [],
    detectorVersion: 'test-v1',
  };
}
