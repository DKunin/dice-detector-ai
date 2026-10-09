import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { Config } from './config.js';
import type { Detection, PhotoEntry } from './types.js';

interface EntryRow {
  id: string;
  path: string;
  etag: string | null;
  modifiedAt: string | null;
  size: number | null;
  capturedAt: string | null;
  indexedAt: string;
}

interface UserRow {
  id: string;
}

interface StateRow {
  previewKey: string;
}

export class PhotoKunStore {
  private readonly photoKun: Database.Database;
  private readonly state: Database.Database;
  readonly userId: string;

  constructor(private readonly config: Config) {
    this.photoKun = new Database(config.photoKunDatabasePath, { fileMustExist: true });
    this.photoKun.pragma('busy_timeout = 15000');
    this.photoKun.pragma('foreign_keys = ON');
    this.state = new Database(config.stateDatabasePath);
    this.state.pragma('journal_mode = WAL');
    this.state.pragma('busy_timeout = 15000');
    this.state.exec(`
      CREATE TABLE IF NOT EXISTS detection_results (
        entry_id TEXT NOT NULL,
        detector_version TEXT NOT NULL,
        preview_key TEXT NOT NULL,
        detected INTEGER NOT NULL,
        dice_probability REAL,
        lookalike_probability REAL,
        error TEXT,
        checked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (entry_id, detector_version)
      );
      CREATE INDEX IF NOT EXISTS detection_results_checked_idx
        ON detection_results(detector_version, checked_at);
    `);
    const user = this.photoKun
      .prepare('SELECT id FROM users WHERE auth_subject = ?')
      .get(config.targetAuthSubject) as UserRow | undefined;
    if (!user) throw new Error('TARGET_AUTH_SUBJECT has no PhotoKun user row');
    this.userId = user.id;
  }

  listCandidates(): { entries: PhotoEntry[]; skippedWithoutPreview: number } {
    const root = this.config.libraryRoot;
    const parameters: unknown[] = [];
    let scopeSql = '';
    if (root !== '/') {
      scopeSql = 'AND (e.path = ? OR e.path LIKE ? ESCAPE \'\\\')';
      parameters.push(root, `${escapeLike(root)}/%`);
    }
    let idSql = '';
    if (this.config.entryIds.length > 0) {
      idSql = `AND e.id IN (${this.config.entryIds.map(() => '?').join(', ')})`;
      parameters.push(...this.config.entryIds);
    }
    const rows = this.photoKun
      .prepare(
        `SELECT e.id, e.path, e.etag, e.webdav_modified_at AS modifiedAt, e.size,
                e.indexed_at AS indexedAt, m.captured_at AS capturedAt
         FROM filesystem_entries e
         JOIN photo_metadata m ON m.entry_id = e.id
         WHERE e.type = 'image'
           AND e.missing_at IS NULL
           AND m.extraction_error IS NULL
           ${scopeSql}
           ${idSql}
         ORDER BY COALESCE(m.captured_at, e.webdav_modified_at, e.indexed_at) DESC, e.path DESC`,
      )
      .all(...parameters) as EntryRow[];

    let skippedWithoutPreview = 0;
    const entries: PhotoEntry[] = [];
    for (const row of rows) {
      const version = thumbnailVersion(row);
      const previewKey = `${row.id}-${version}.webp`;
      const previewPath = path.join(this.config.thumbnailRoot, 'small', previewKey);
      if (!existsSync(previewPath)) {
        skippedWithoutPreview += 1;
        continue;
      }
      entries.push({ ...row, previewKey, previewPath });
    }
    return { entries, skippedWithoutPreview };
  }

  isProcessed(entry: PhotoEntry): boolean {
    const row = this.state
      .prepare(
        `SELECT preview_key AS previewKey
         FROM detection_results
         WHERE entry_id = ? AND detector_version = ?`,
      )
      .get(entry.id, this.config.detectorVersion) as StateRow | undefined;
    return row?.previewKey === entry.previewKey;
  }

  saveResult(entry: PhotoEntry, detection: Detection, addTag: boolean): number {
    if (this.config.dryRun) return 0;
    const save = this.state.prepare(`
      INSERT INTO detection_results
        (entry_id, detector_version, preview_key, detected, dice_probability,
         lookalike_probability, error, checked_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL, CURRENT_TIMESTAMP)
      ON CONFLICT(entry_id, detector_version) DO UPDATE SET
        preview_key = excluded.preview_key,
        detected = excluded.detected,
        dice_probability = excluded.dice_probability,
        lookalike_probability = excluded.lookalike_probability,
        error = NULL,
        checked_at = CURRENT_TIMESTAMP
    `);
    const insertTag = this.photoKun.prepare(
      'INSERT OR IGNORE INTO photo_tags (user_id, entry_id, tag) VALUES (?, ?, ?)',
    );
    const tagsAdded = addTag ? insertTag.run(this.userId, entry.id, 'dice').changes : 0;
    save.run(
      entry.id,
      this.config.detectorVersion,
      entry.previewKey,
      detection.detected ? 1 : 0,
      detection.diceProbability,
      detection.lookalikeProbability,
    );
    return tagsAdded;
  }

  savePermanentError(entry: PhotoEntry, error: string): void {
    if (this.config.dryRun) return;
    this.state
      .prepare(`
        INSERT INTO detection_results
          (entry_id, detector_version, preview_key, detected, dice_probability,
           lookalike_probability, error, checked_at)
        VALUES (?, ?, ?, 0, NULL, NULL, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(entry_id, detector_version) DO UPDATE SET
          preview_key = excluded.preview_key,
          detected = 0,
          dice_probability = NULL,
          lookalike_probability = NULL,
          error = excluded.error,
          checked_at = CURRENT_TIMESTAMP
      `)
      .run(entry.id, this.config.detectorVersion, entry.previewKey, error.slice(0, 500));
  }

  close(): void {
    this.state.close();
    this.photoKun.close();
  }
}

export function thumbnailVersion(source: {
  etag: string | null;
  modifiedAt: string | null;
  size: number | null;
}): string {
  return createHash('sha256')
    .update(source.etag ?? `${source.modifiedAt ?? 'unknown'}:${source.size ?? 'unknown'}`)
    .digest('hex')
    .slice(0, 16);
}

function escapeLike(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}
