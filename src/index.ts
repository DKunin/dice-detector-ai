import { loadConfig } from './config.js';
import { LunaDiceDetector } from './openai.js';
import { DiceScannerService } from './scanner.js';
import { PhotoKunStore } from './store.js';

const abortController = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => abortController.abort(new Error(`received ${signal}`)));
}

let store: PhotoKunStore | undefined;
try {
  const config = loadConfig();
  store = new PhotoKunStore(config);
  const detector = new LunaDiceDetector(config);
  const service = new DiceScannerService(config, store, detector);
  await service.run(abortController.signal);
} catch (error) {
  console.error(
    JSON.stringify({
      time: new Date().toISOString(),
      event: 'service-failed',
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exitCode = 1;
} finally {
  store?.close();
}
