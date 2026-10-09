import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Config } from './config.js';
import { LunaDiceDetector, PermanentDetectionError } from './openai.js';
import { PhotoKunStore } from './store.js';
import type { PhotoEntry, ScanSummary } from './types.js';

export interface StatusDocument extends ScanSummary {
  service: 'dice-detector-ai';
  phase: 'starting' | 'scanning' | 'waiting' | 'stopped' | 'failed';
  detectorVersion: string;
  model: string;
  startedAt: string;
  updatedAt: string;
  completedScans: number;
  lastError: string | null;
}

export class DiceScannerService {
  private readonly startedAt = new Date().toISOString();
  private completedScans = 0;

  constructor(
    private readonly config: Config,
    private readonly store: PhotoKunStore,
    private readonly detector: LunaDiceDetector,
  ) {}

  async run(signal?: AbortSignal): Promise<void> {
    await this.writeStatus('starting', emptySummary(this.config.dryRun), null);
    while (!signal?.aborted) {
      try {
        const summary = await this.scan(signal);
        this.completedScans += 1;
        if (this.config.runOnce || signal?.aborted) {
          await this.writeStatus('stopped', summary, null);
          return;
        }
        await this.writeStatus('waiting', summary, null);
        await wait(this.config.pollIntervalMs, signal);
      } catch (error) {
        const message = errorMessage(error);
        await this.writeStatus('failed', emptySummary(this.config.dryRun), message);
        throw error;
      }
    }
  }

  async scan(signal?: AbortSignal): Promise<ScanSummary> {
    const { entries, skippedWithoutPreview } = this.store.listCandidates();
    let pending = entries.filter((entry) => !this.store.isProcessed(entry));
    if (this.config.scanLimit !== null) pending = pending.slice(0, this.config.scanLimit);
    const summary: ScanSummary = {
      eligible: entries.length,
      pending: pending.length,
      processed: 0,
      detected: 0,
      tagsAdded: 0,
      failed: 0,
      skippedWithoutPreview,
      dryRun: this.config.dryRun,
    };
    log('scan-started', {
      eligible: summary.eligible,
      pending: summary.pending,
      skippedWithoutPreview,
      concurrency: this.config.concurrency,
      dryRun: this.config.dryRun,
    });
    await this.writeStatus('scanning', summary, null);

    let nextIndex = 0;
    const worker = async (): Promise<void> => {
      while (!signal?.aborted) {
        const index = nextIndex;
        nextIndex += 1;
        const entry = pending[index];
        if (!entry) return;
        await this.processEntry(entry, summary, signal);
        if (summary.processed % 25 === 0 || summary.processed === summary.pending) {
          log('scan-progress', {
            processed: summary.processed,
            pending: summary.pending,
            detected: summary.detected,
            tagsAdded: summary.tagsAdded,
            failed: summary.failed,
          });
          await this.writeStatus('scanning', summary, null);
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(this.config.concurrency, pending.length) }, () => worker()),
    );
    log('scan-completed', { ...summary });
    return summary;
  }

  private async processEntry(
    entry: PhotoEntry,
    summary: ScanSummary,
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      let detection = await this.detector.detect(entry.previewPath, signal);
      for (
        let confirmation = 1;
        detection.detected && confirmation < this.config.positiveConfirmations;
        confirmation += 1
      ) {
        detection = combineConfirmations(
          detection,
          await this.detector.detect(entry.previewPath, signal),
        );
      }
      summary.processed += 1;
      if (detection.detected) summary.detected += 1;
      const tagAdded = this.store.saveResult(entry, detection, detection.detected);
      summary.tagsAdded += tagAdded;
      if (detection.detected) {
        log('dice-detected', {
          entryId: entry.id,
          diceProbability: detection.diceProbability,
          lookalikeProbability: detection.lookalikeProbability,
          tagAdded,
        });
      }
    } catch (error) {
      summary.processed += 1;
      summary.failed += 1;
      const message = errorMessage(error);
      if (error instanceof PermanentDetectionError) this.store.savePermanentError(entry, message);
      log('entry-failed', { entryId: entry.id, error: message });
    }
  }

  private async writeStatus(
    phase: StatusDocument['phase'],
    summary: ScanSummary,
    lastError: string | null,
  ): Promise<void> {
    const document: StatusDocument = {
      service: 'dice-detector-ai',
      phase,
      detectorVersion: this.config.detectorVersion,
      model: this.config.model,
      startedAt: this.startedAt,
      updatedAt: new Date().toISOString(),
      completedScans: this.completedScans,
      lastError,
      ...summary,
    };
    await mkdir(path.dirname(this.config.statusPath), { recursive: true });
    const temporary = `${this.config.statusPath}.tmp`;
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.config.statusPath);
  }
}

export function combineConfirmations(
  first: { diceProbability: number; lookalikeProbability: number; detected: boolean },
  second: { diceProbability: number; lookalikeProbability: number; detected: boolean },
) {
  return {
    diceProbability: Math.min(first.diceProbability, second.diceProbability),
    lookalikeProbability: Math.max(first.lookalikeProbability, second.lookalikeProbability),
    detected: first.detected && second.detected,
  };
}

export function emptySummary(dryRun: boolean): ScanSummary {
  return {
    eligible: 0,
    pending: 0,
    processed: 0,
    detected: 0,
    tagsAdded: 0,
    failed: 0,
    skippedWithoutPreview: 0,
    dryRun,
  };
}

function log(event: string, detail: Record<string, unknown>): void {
  console.log(JSON.stringify({ time: new Date().toISOString(), event, ...detail }));
}

async function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
