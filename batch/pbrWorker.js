// Worker-thread entry for the batch PBR stage (see runPbrInWorker in
// actionRunner.js). The filters are seconds of synchronous work on a 4K
// texture; run on the main thread they would stall every request and progress
// stream the server is handling. Loads nothing but pbr.js and what it imports.
import { Buffer } from 'node:buffer';
import { parentPort, workerData } from 'node:worker_threads';
import { applyPbrFromAlbedoToGlb } from './pbr.js';

try {
  const input = Buffer.from(workerData.buffer.buffer, workerData.buffer.byteOffset, workerData.buffer.byteLength);
  const result = applyPbrFromAlbedoToGlb(input, workerData.options, {
    onProgress: (frac, message) => parentPort.postMessage({ type: 'progress', frac, message })
  });
  parentPort.postMessage({ type: 'done', buffer: result.buffer, stats: result.stats, warnings: result.warnings });
} catch (err) {
  parentPort.postMessage({ type: 'error', message: err?.message || String(err) });
}
