/**
 * Worker thread entry point. Receives { kind, payload }, posts progress and a
 * final done/failed message. Kept free of HTTP concerns.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { solveDataset } from './solver/solve.js';
import { resampleFeatures } from './solver/resample.js';
import { crossCheckTree } from './solver/crossCheck.js';

const { kind, payload } = workerData;

function post(msg) {
  parentPort.postMessage(msg);
}

try {
  post({ type: 'progress', progress: { stage: 'starting', fraction: 0.02 } });
  let result;
  if (kind === 'solve') {
    post({ type: 'progress', progress: { stage: 'validating', fraction: 0.08 } });
    result = solveDataset(payload.dataset, payload.options || {});
  } else if (kind === 'resample') {
    post({ type: 'progress', progress: { stage: 'resampling', fraction: 0.2 } });
    result = resampleFeatures(payload.dataset, payload.options || {});
  } else if (kind === 'check-tree') {
    post({ type: 'progress', progress: { stage: 'checking', fraction: 0.2 } });
    result = crossCheckTree(payload.dataset, payload.tree, payload.options || {});
  } else {
    throw new Error(`unknown job kind: ${kind}`);
  }
  post({ type: 'progress', progress: { stage: 'finishing', fraction: 0.95 } });
  post({ type: 'done', result });
} catch (err) {
  post({
    type: 'failed',
    error: { message: err && err.message ? err.message : String(err), stack: err && err.stack },
  });
}
