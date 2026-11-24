/**
 * Local HTTP API for the workbench. Static build is served from web/dist when
 * present. Everything runs on this machine; no dataset or result is sent
 * anywhere.
 */
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JobStore } from './jobs.js';
import { validateDataset } from '../shared/validate.js';
import { solveDataset } from './solver/solve.js';
import { resampleFeatures } from './solver/resample.js';
import { crossCheckTree } from './solver/crossCheck.js';
import { topologySignature } from './solver/tree.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);
const dataDir = path.join(root, 'data');
const distDir = path.join(root, 'web', 'dist');

export function createApp({ store = new JobStore() } = {}) {
  const app = express();
  app.use(express.json({ limit: '4mb' }));

  const samples = new Map();
  for (const file of fs.readdirSync(dataDir).filter((f) => f.endsWith('.json'))) {
    try {
      const ds = JSON.parse(fs.readFileSync(path.join(dataDir, file), 'utf8'));
      samples.set(ds.id || file.replace(/\.json$/, ''), { ...ds, __file: file });
    } catch {
      // A malformed sample is skipped, not fatal.
    }
  }

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, service: 'branchwork', version: 1 });
  });

  app.get('/api/samples', (_req, res) => {
    res.json({
      samples: [...samples.values()].map((s) => ({
        id: s.id,
        title: s.title,
        note: s.note,
        taxiCount: Array.isArray(s.taxa) ? s.taxa.length : 0,
        featureCount: Array.isArray(s.features) ? s.features.length : 0,
        constraintCount: Array.isArray(s.constraints) ? s.constraints.length : 0,
        dataset: s,
      })),
    });
  });

  app.post('/api/validate', (req, res) => {
    const ds = req.body && req.body.dataset;
    const v = validateDataset(ds);
    res.json({
      ok: v.ok,
      errors: v.errors,
      warnings: v.warnings,
      infos: v.infos || [],
      locks: v.locks,
      stats: v.stats,
      features: v.features,
      taxonIds: v.taxonIds,
      taxa: v.taxa,
    });
  });

  // Quick solves (small) may run inline; anything else is submitted as a job.
  app.post('/api/solve', (req, res) => {
    const { dataset, options = {}, background = false } = req.body || {};
    if (!dataset) return res.status(400).json({ error: 'missing dataset' });
    if (!background) {
      try {
        const result = solveDataset(dataset, options);
        return res.json(result);
      } catch (err) {
        return res.status(500).json({ ok: false, error: { message: err.message } });
      }
    }
    const job = store.submit({ kind: 'solve', payload: { dataset, options } });
    res.status(202).json({ jobId: job.id, status: job.status });
  });

  app.post('/api/resample', (req, res) => {
    const { dataset, options = {}, background = true } = req.body || {};
    if (!dataset) return res.status(400).json({ error: 'missing dataset' });
    if (!background) {
      try {
        return res.json(resampleFeatures(dataset, options));
      } catch (err) {
        return res.status(500).json({ ok: false, error: { message: err.message } });
      }
    }
    const job = store.submit({ kind: 'resample', payload: { dataset, options } });
    res.status(202).json({ jobId: job.id, status: job.status });
  });

  app.post('/api/check-tree', (req, res) => {
    const { dataset, tree, options = {}, background = false } = req.body || {};
    if (!dataset || !tree) return res.status(400).json({ error: 'missing dataset or tree' });
    if (!background) {
      try {
        return res.json(crossCheckTree(dataset, tree, options));
      } catch (err) {
        return res.status(500).json({ ok: false, error: { message: err.message } });
      }
    }
    const job = store.submit({ kind: 'check-tree', payload: { dataset, tree, options } });
    res.status(202).json({ jobId: job.id, status: job.status });
  });

  app.get('/api/jobs/:id', (req, res) => {
    const job = store.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'unknown job' });
    res.json(store.publicView(job));
  });

  // Small helper used by tests: compare reported trees by canonical signature.
  app.post('/api/tree-signature', (req, res) => {
    const { tree } = req.body || {};
    if (!tree) return res.status(400).json({ error: 'missing tree' });
    res.json({ signature: topologySignature(tree) });
  });

  if (fs.existsSync(distDir)) {
    app.use(express.static(distDir));
    app.get(/^(?!\/api\/).*/, (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  } else {
    app.get('/', (_req, res) => {
      res
        .status(200)
        .type('text/plain')
        .send('前端尚未构建。运行 `npm run build` 后重新启动，或使用 `npm run dev`。');
    });
  }

  app.locals.store = store;
  return app;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const port = Number(process.env.PORT || 4173);
  const app = createApp();
  app.listen(port, '127.0.0.1', () => {
    console.log(`Branchwork 本地服务: http://127.0.0.1:${port}`);
  });
}
