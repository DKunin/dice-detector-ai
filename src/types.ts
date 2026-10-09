export interface PhotoEntry {
  id: string;
  path: string;
  etag: string | null;
  modifiedAt: string | null;
  size: number | null;
  capturedAt: string | null;
  indexedAt: string;
  previewKey: string;
  previewPath: string;
}

export interface Detection {
  diceProbability: number;
  lookalikeProbability: number;
  detected: boolean;
}

export interface ScanSummary {
  eligible: number;
  pending: number;
  processed: number;
  detected: number;
  tagsAdded: number;
  failed: number;
  skippedWithoutPreview: number;
  dryRun: boolean;
}
