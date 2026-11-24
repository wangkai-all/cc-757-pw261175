/**
 * Job runner. Long solves run in a worker thread so the HTTP server stays
 * responsive; job state is held in memory and polled by the client.
 *
 * This is a local single-user tool: no persistence, no auth, nothing leaves
 * the machine.
 */
import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const workerFile = path.join(here, 'worker.js');

export class JobStore {
  constructor({ maxJobs = 50 } = {}) {
    this.jobs = new Map();
    this.order = [];
    this.maxJobs = maxJobs;
  }

  submit({ kind, payload, onDone }) {
    const id = randomUUID();
    const job = {
      id,
      kind,
      status: 'running',
      submittedAt: new Date().toISOString(),
      startedAt: Date.now(),
      progress: { stage: 'queued', fraction: 0 },
      result: null,
      error: null,
    };
    this.jobs.set(id, job);
    this.order.push(id);
    while (this.order.length > this.maxJobs) {
      const drop = this.order.shift();
      const j = this.jobs.get(drop);
      if (j && j.status !== 'running') this.jobs.delete(drop);
      else if (j) this.order.push(drop); // keep running jobs
      if (this.order.length > this.maxJobs * 2) break;
    }

    const worker = new Worker(workerFile, { workerData: { kind, payload, jobId: id } });
    job.worker = worker;

    worker.on('message', (msg) => {
      if (msg && msg.type === 'progress') {
        job.progress = msg.progress;
        return;
      }
      if (msg && msg.type === 'done') {
        job.status = 'done';
        job.result = msg.result;
        job.elapsedMs = Date.now() - job.startedAt;
        job.progress = { stage: 'done', fraction: 1 };
        if (onDone) onDone(null, msg.result);
      } else if (msg && msg.type === 'failed') {
        job.status = 'failed';
        job.error = msg.error;
        job.elapsedMs = Date.now() - job.startedAt;
        if (onDone) onDone(msg.error, null);
      }
    });
    worker.on('error', (err) => {
      job.status = 'failed';
      job.error = { message: err.message, stack: err.stack };
      job.elapsedMs = Date.now() - job.startedAt;
      if (onDone) onDone(job.error, null);
    });
    worker.on('exit', (code) => {
      if (job.status === 'running') {
        job.status = 'failed';
        job.error = { message: `求解线程异常退出（code ${code}）。` };
      }
    });

    return job;
  }

  get(id) {
    return this.jobs.get(id) || null;
  }

  publicView(job) {
    if (!job) return null;
    return {
      id: job.id,
      kind: job.kind,
      status: job.status,
      submittedAt: job.submittedAt,
      progress: job.progress,
      elapsedMs: job.elapsedMs ?? Date.now() - job.startedAt,
      result: job.result,
      error: job.error,
    };
  }
}
