import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, debounce, fmt, newick, splitDiff } from './lib.js';
import TreeView from './components/TreeView.jsx';
import MatrixEditor from './components/MatrixEditor.jsx';
import CostEditor from './components/CostEditor.jsx';
import LockEditor from './components/LockEditor.jsx';
import FeatureCostChart from './components/FeatureCostChart.jsx';
import DiagnosticList, {
  ProofBanner,
  TiesList,
  ResamplePanel,
  CheckTreePanel,
} from './components/panels.jsx';

const EMPTY_DATASET = {
  id: 'scratch',
  title: '未命名数据集',
  note: '自建虚构数据。',
  taxa: [
    { id: 'A', label: '样品 A' },
    { id: 'B', label: '样品 B' },
    { id: 'C', label: '样品 C' },
  ],
  features: [
    {
      id: 'F1',
      name: '特征 1',
      ordered: false,
      states: ['0', '1'],
      costs: { '0|1': 1 },
    },
  ],
  matrix: { A: ['0'], B: ['1'], C: ['0'] },
  constraints: [],
};

export default function App() {
  const [sampleList, setSampleList] = useState([]);
  const [dataset, setDataset] = useState(null);
  const [activeSample, setActiveSample] = useState(null);
  const [validation, setValidation] = useState(null);
  const [method, setMethod] = useState('auto');
  const [result, setResult] = useState(null);
  const [solving, setSolving] = useState(false);
  const [progress, setProgress] = useState(null);
  const [solveError, setSolveError] = useState(null);

  const [activeTie, setActiveTie] = useState(0);
  const [highlightFeature, setHighlightFeature] = useState(null);
  const [selectedTaxon, setSelectedTaxon] = useState(null);
  const [selectedEdge, setSelectedEdge] = useState(null);

  const [leftTab, setLeftTab] = useState('features');
  const [rightTab, setRightTab] = useState('result');

  const [resample, setResample] = useState(null);
  const [resampling, setResampling] = useState(false);
  const [resampleOptions, setResampleOptions] = useState({ replicates: 200, reoptimise: false });

  const [check, setCheck] = useState(null);
  const [checking, setChecking] = useState(false);

  const [notice, setNotice] = useState(null);
  const jobRef = useRef(null);

  // ------------------------------------------------------------------ loading

  useEffect(() => {
    api('/api/samples')
      .then((data) => {
        setSampleList(data.samples || []);
        if (data.samples && data.samples.length) {
          loadSample(data.samples[0]);
        } else {
          setDataset(EMPTY_DATASET);
        }
      })
      .catch((err) => {
        setNotice({ level: 'error', text: `无法读取内置样例：${err.message}` });
        setDataset(EMPTY_DATASET);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function loadSample(sample) {
    const ds = structuredClone(sample.dataset);
    setActiveSample(sample.id);
    setDataset(ds);
    setResult(null);
    setCheck(null);
    setResample(null);
    setActiveTie(0);
    setSelectedEdge(null);
    setSelectedTaxon(null);
    setHighlightFeature(ds.features?.[0]?.id || null);
  }

  // validate on change (debounced)
  const runValidate = useMemo(
    () =>
      debounce(async (ds, setter) => {
        try {
          const v = await api('/api/validate', { method: 'POST', body: { dataset: ds } });
          setter(v);
        } catch (err) {
          setter({ ok: false, errors: [{ code: 'validate-failed', message: err.message }], warnings: [], infos: [] });
        }
      }, 220),
    [],
  );

  useEffect(() => {
    if (!dataset) return;
    runValidate(dataset, setValidation);
    // Dataset changed: previous result may no longer apply.
    setCheck(null);
    setResample(null);
  }, [dataset, runValidate]);

  useEffect(() => () => runValidate.cancel(), [runValidate]);

  // ------------------------------------------------------------------ mutations

  const updateDataset = useCallback((patch) => {
    setDataset((prev) => {
      if (!prev) return prev;
      const next = { ...prev, ...patch };
      return next;
    });
    setResult(null);
    setSolveError(null);
  }, []);

  const setMatrix = (matrix) => updateDataset({ matrix });

  const setConstraints = (constraints) => updateDataset({ constraints });

  const updateFeatureCosts = (featureId, costs) => {
    setDataset((prev) => ({
      ...prev,
      features: prev.features.map((f) => (f.id === featureId ? { ...f, costs } : f)),
    }));
    setResult(null);
  };

  const updateFeatureMeta = (featureId, patch) => {
    setDataset((prev) => ({
      ...prev,
      features: prev.features.map((f) => (f.id === featureId ? { ...f, ...patch } : f)),
    }));
    setResult(null);
  };

  const addTaxon = (id) => {
    setDataset((prev) => ({
      ...prev,
      taxa: [...prev.taxa, { id, label: `样品 ${id}` }],
      matrix: { ...prev.matrix, [id]: prev.features.map(() => null) },
    }));
    setResult(null);
  };

  const removeTaxon = (id) => {
    setDataset((prev) => {
      const matrix = { ...prev.matrix };
      delete matrix[id];
      return {
        ...prev,
        taxa: prev.taxa.filter((t) => t.id !== id),
        matrix,
        constraints: prev.constraints
          .map((c) => ({ ...c, taxa: c.taxa.filter((t) => t !== id) }))
          .filter((c) => c.taxa.length >= 2),
      };
    });
    setResult(null);
  };

  const addFeature = () => {
    setDataset((prev) => {
      let i = 1;
      const used = new Set(prev.features.map((f) => f.id));
      while (used.has(`F${i}`)) i++;
      const id = `F${i}`;
      const feature = {
        id,
        name: `特征 ${i}`,
        ordered: false,
        states: ['0', '1'],
        costs: { '0|1': 1 },
      };
      return {
        ...prev,
        features: [...prev.features, feature],
        matrix: Object.fromEntries(
          Object.entries(prev.matrix).map(([t, row]) => [t, [...row, null]]),
        ),
      };
    });
    setResult(null);
  };

  const removeFeature = (featureId) => {
    setDataset((prev) => {
      const idx = prev.features.findIndex((f) => f.id === featureId);
      return {
        ...prev,
        features: prev.features.filter((f) => f.id !== featureId),
        matrix: Object.fromEntries(
          Object.entries(prev.matrix).map(([t, row]) => [t, row.filter((_, i) => i !== idx)]),
        ),
        constraints: prev.constraints,
      };
    });
    if (highlightFeature === featureId) setHighlightFeature(null);
    setResult(null);
  };

  const renameFeature = (featureId, name) => updateFeatureMeta(featureId, { name });

  // ------------------------------------------------------------------ solving

  const pollJob = (jobId, onDone) => {
    const started = Date.now();
    const tick = async () => {
      try {
        const job = await api(`/api/jobs/${jobId}`);
        setProgress(job.progress);
        if (job.status === 'done') {
          setProgress(null);
          onDone(null, job.result);
          return;
        }
        if (job.status === 'failed') {
          setProgress(null);
          onDone(job.error || { message: '求解线程失败。' });
          return;
        }
        if (Date.now() - started > 60000) {
          setProgress(null);
          onDone({ message: '等待求解超时。' });
          return;
        }
        setTimeout(tick, 120);
      } catch (err) {
        setProgress(null);
        onDone({ message: err.message });
      }
    };
    tick();
  };

  const solve = async () => {
    if (!dataset || !validation || !validation.ok) {
      setRightTab('diagnostics');
      setSolveError('数据还没有通过校验，先修正红色提示再求解。');
      return;
    }
    setSolving(true);
    setSolveError(null);
    setResult(null);
    setCheck(null);
    try {
      const { jobId } = await api('/api/solve', {
        method: 'POST',
        body: { dataset, options: { method, maxTies: 400 }, background: true },
      });
      jobRef.current = jobId;
      pollJob(jobId, (err, res) => {
        setSolving(false);
        if (err) {
          setSolveError(err.message || String(err));
          setRightTab('diagnostics');
          return;
        }
        setResult(res);
        setActiveTie(0);
        setSelectedEdge(null);
        if (res.status !== 'solved') setRightTab('diagnostics');
        else setRightTab('result');
      });
    } catch (err) {
      setSolving(false);
      setSolveError(err.message);
    }
  };

  const runResample = async () => {
    if (!dataset) return;
    const tree = currentTree();
    setResampling(true);
    setResample(null);
    try {
      const payload = {
        dataset,
        options: {
          ...resampleOptions,
          seed: 20260101,
          fixedTree: resampleOptions.reoptimise ? null : tree,
        },
        background: true,
      };
      const { jobId } = await api('/api/resample', { method: 'POST', body: payload });
      pollJob(jobId, (err, res) => {
        setResampling(false);
        if (err) {
          setResample({ ok: false, message: err.message || String(err) });
          return;
        }
        setResample(res);
      });
    } catch (err) {
      setResampling(false);
      setResample({ ok: false, message: err.message });
    }
  };

  const runCheck = async () => {
    const tree = currentTree();
    if (!dataset || !tree) return;
    setChecking(true);
    setCheck(null);
    try {
      const { jobId } = await api('/api/check-tree', {
        method: 'POST',
        body: { dataset, tree, background: true },
      });
      pollJob(jobId, (err, res) => {
        setChecking(false);
        if (err) setCheck({ ok: false, message: err.message || String(err) });
        else setCheck(res);
      });
    } catch (err) {
      setChecking(false);
      setCheck({ ok: false, message: err.message });
    }
  };

  // ------------------------------------------------------------------ derived

  const currentTie = result?.status === 'solved' ? result.result.ties[activeTie] || result.result.ties[0] : null;
  const annotation = currentTie?.annotation || (result?.status === 'solved' ? result.result.annotation : null);
  const displayTree = currentTie?.tree || (result?.status === 'solved' ? result.result.tree : null);

  function currentTree() {
    return displayTree;
  }

  const labels = useMemo(() => {
    const out = {};
    for (const t of dataset?.taxa || []) out[t.id] = t.label;
    return out;
  }, [dataset]);

  const lockReport = useMemo(() => {
    if (!annotation) return [];
    const sets = new Set(annotation.nodes.map((n) => n.cladeMask));
    return (validation?.locks || []).map((l) => {
      let mask = 0;
      const idx = new Map(validation.taxonIds.map((t, i) => [t, i]));
      for (const t of l.taxa) mask |= 1 << idx.get(t);
      return { id: l.id, holds: sets.has(mask), mask };
    });
  }, [annotation, validation]);

  const tieDiff = useMemo(() => {
    if (!result?.result?.ties || result.result.ties.length < 2) return null;
    const ties = result.result.ties;
    const current = ties.find((t) => t.index === activeTie);
    // Prefer a candidate that is genuinely different as an unrooted structure;
    // comparing two rootings of the same structure would always read "same".
    const other =
      ties.find((t) => t.index !== activeTie && t.unrootedSignature !== current?.unrootedSignature) ||
      ties.find((t) => t.index !== activeTie);
    if (!other) return null;
    const taxonIds = result.taxa ? result.taxa.map((t) => t.id) : dataset.taxa.map((t) => t.id);
    return { other, diff: splitDiff(displayTree, other.tree, taxonIds) };
  }, [result, activeTie, displayTree, dataset]);

  const status = useMemo(() => {
    if (solving) return { state: 'busy', label: '正在求解…' };
    if (!validation) return { state: 'idle', label: '校验中…' };
    if (!validation.ok) return { state: 'error', label: `${validation.errors.length} 个数据错误` };
    if (!result) return { state: 'idle', label: '数据就绪，未求解' };
    if (result.status === 'solved') {
      return result.proof?.provenOptimal
        ? { state: 'ok', label: `最优代价 ${fmt(result.result.total)}` }
        : { state: 'warn', label: `找到最好树 ${fmt(result.result.total)}` };
    }
    if (result.status === 'infeasible') return { state: 'error', label: '无可行树' };
    return { state: 'error', label: '未求解' };
  }, [solving, validation, result]);

  const featureForHighlight = dataset?.features.find((f) => f.id === highlightFeature) || null;

  // ------------------------------------------------------------------ render

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="mark" aria-hidden="true">
            <svg viewBox="0 0 16 16" fill="none" stroke="#fff" strokeWidth="1.7" strokeLinecap="round">
              <path d="M3 8h3M6 8V4.5h4M6 8v3.5h4" />
              <circle cx="3" cy="8" r="1.2" fill="#fff" stroke="none" />
              <circle cx="12.4" cy="4.5" r="1.2" fill="#fff" stroke="none" />
              <circle cx="12.4" cy="11.5" r="1.2" fill="#fff" stroke="none" />
            </svg>
          </span>
          <div>
            <h1>分支关系工作台</h1>
            <div className="sub">离散特征 · 虚构数据 · 只比较代价，不推断真实亲缘</div>
          </div>
        </div>
        <span className="spacer" />
        <label className="small muted nowrap" htmlFor="method-select">搜索方式</label>
        <select
          id="method-select"
          style={{ width: 150 }}
          value={method}
          onChange={(e) => setMethod(e.target.value)}
        >
          <option value="auto">自动（小样本精确）</option>
          <option value="exact">精确（穷尽状态向量）</option>
          <option value="local">局部搜索 + 下界</option>
        </select>
        <button className="btn primary" onClick={solve} disabled={solving || !validation?.ok}>
          {solving ? <span className="spin" style={{ borderTopColor: '#fff' }} /> : <PlayIcon />}
          求解
        </button>
        <div className="status-chip" data-state={status.state} role="status" aria-live="polite">
          <span className="dot" />
          {status.label}
        </div>
      </header>

      {notice ? (
        <div className="banner" style={{ margin: '8px 20px 0', borderColor: 'rgba(208,59,59,0.4)' }}>
          {notice.text}
          <button className="btn ghost small" style={{ marginLeft: 8 }} onClick={() => setNotice(null)}>知道了</button>
        </div>
      ) : null}

      <div className="workspace">
        <aside className="pane pane-left">
          <section className="section">
            <header>
              <h2>虚构样例</h2>
              <span className="small muted">{sampleList.length} 个</span>
            </header>
            <div className="sample-list">
              {sampleList.map((s) => (
                <button
                  key={s.id}
                  className="sample-card"
                  aria-pressed={activeSample === s.id}
                  onClick={() => loadSample(s)}
                >
                  <span className="title">{s.title}</span>
                  <span className="meta">
                    {s.taxiCount} 样品 · {s.featureCount} 特征 · {s.constraintCount} 锁定
                  </span>
                  {s.note ? <span className="note">{s.note}</span> : null}
                </button>
              ))}
            </div>
            <div className="btn-row" style={{ marginTop: 10 }}>
              <button className="btn small" onClick={() => { setDataset(structuredClone(EMPTY_DATASET)); setActiveSample(null); setResult(null); }}>
                新建空白数据
              </button>
              <button className="btn small" onClick={importJson}>导入 JSON</button>
              <button className="btn small" onClick={exportJson}>导出 JSON</button>
            </div>
          </section>

          <section className="section">
            <div className="tabs" role="tablist">
              <button role="tab" aria-selected={leftTab === 'features'} onClick={() => setLeftTab('features')}>特征与代价</button>
              <button role="tab" aria-selected={leftTab === 'locks'} onClick={() => setLeftTab('locks')}>锁定分支</button>
              <button role="tab" aria-selected={leftTab === 'data'} onClick={() => setLeftTab('data')}>数据流</button>
            </div>

            {leftTab === 'features' ? (
              <>
                <div className="btn-row" style={{ marginBottom: 10 }}>
                  <button className="btn small" onClick={addFeature}>+ 特征</button>
                  {dataset?.features.length ? (
                    <button
                      className="btn small danger"
                      onClick={() => removeFeature(dataset.features[dataset.features.length - 1].id)}
                      title="删除最后一个特征"
                    >
                      删除末位特征
                    </button>
                  ) : null}
                </div>
                <FeatureNameRow
                  features={dataset?.features || []}
                  onRename={renameFeature}
                />
                <CostEditor
                  features={dataset?.features || []}
                  featureCosts={Object.fromEntries((dataset?.features || []).map((f) => [f.id, f.costs]))}
                  onChange={updateFeatureCosts}
                  onFeatureMeta={updateFeatureMeta}
                />
              </>
            ) : null}

            {leftTab === 'locks' ? (
              <LockEditor
                taxonIds={dataset?.taxa.map((t) => t.id) || []}
                constraints={dataset?.constraints || []}
                onChange={setConstraints}
                lockReport={lockReport}
              />
            ) : null}

            {leftTab === 'data' ? (
              <DataFlow dataset={dataset} validation={validation} annotation={annotation} result={result} />
            ) : null}
          </section>
        </aside>

        <main className="pane pane-center">
          <section className="section" style={{ marginBottom: 0 }}>
            <header>
              <h2>特征矩阵</h2>
              <span className="small muted">
                {dataset?.taxa.length || 0} 样品 × {dataset?.features.length || 0} 特征
                {validation?.stats?.missingCells ? ` · ${validation.stats.missingCells} 格未观测` : ''}
              </span>
            </header>
            {dataset ? (
              <MatrixEditor
                features={dataset.features}
                taxonIds={dataset.taxa.map((t) => t.id)}
                taxa={dataset.taxa}
                matrix={dataset.matrix}
                locks={(validation?.locks || [])}
                errors={validation?.errors || []}
                onChange={setMatrix}
                onAddTaxon={addTaxon}
                onRemoveTaxon={removeTaxon}
              />
            ) : (
              <div className="empty-hint">载入样例或新建数据后，这里可编辑每个格子。</div>
            )}
            {validation && (validation.errors.length || validation.warnings.length) ? (
              <div style={{ marginTop: 10 }}>
                <CompactIssues validation={validation} onMore={() => setRightTab('diagnostics')} result={result} />
              </div>
            ) : null}
          </section>

          <section className="section tree-card" style={{ marginBottom: 0 }}>
            <div className="tree-toolbar">
              <h2 style={{ marginRight: 4 }}>代价最小树</h2>
              {result?.status === 'solved' ? (
                <>
                  <span className="small muted">总代价</span>
                  <span className="mono" style={{ fontWeight: 700, fontSize: 15 }}>{fmt(result.result.total)}</span>
                  {result.method === 'local' ? (
                    <span className="badge" style={{ background: 'rgba(250,178,25,0.16)', color: '#8a6100', fontSize: 10.5, padding: '1px 7px', borderRadius: 999 }}>
                      局部搜索 · 非全局声明
                    </span>
                  ) : (
                    <span className="badge" style={{ background: 'rgba(12,163,12,0.12)', color: 'var(--good-ink)', fontSize: 10.5, padding: '1px 7px', borderRadius: 999 }}>
                      精确求解
                    </span>
                  )}
                </>
              ) : null}
              <span className="grow" />
              <label className="small muted" htmlFor="hl-feature">高亮特征</label>
              <select
                id="hl-feature"
                style={{ width: 148 }}
                value={highlightFeature || ''}
                onChange={(e) => setHighlightFeature(e.target.value || null)}
                disabled={!dataset}
              >
                <option value="">不高亮</option>
                {(dataset?.features || []).map((f) => (
                  <option key={f.id} value={f.id}>{f.name}</option>
                ))}
              </select>
            </div>
            {result?.status === 'solved' ? (
              <div className="tree-canvas-wrap">
                <TreeView
                  annotation={annotation}
                  features={dataset.features}
                  labels={labels}
                  locks={lockReport}
                  highlightFeature={highlightFeature}
                  selectedTaxon={selectedTaxon}
                  onSelectTaxon={(t) => { setSelectedTaxon(t); setRightTab('result'); }}
                  selectedEdge={selectedEdge}
                  onSelectEdge={(k) => { setSelectedEdge(k); setRightTab('result'); }}
                />
              </div>
            ) : (
              <div className="tree-empty">
                <div>
                  <p>{solving ? '正在后台搜索…' : '还没有树。'}</p>
                  <p className="muted small" style={{ marginTop: 6 }}>
                    {validation?.ok
                      ? <>按右上角“求解”开始。当前方式：{method === 'local' ? '局部搜索（会给出可核对下界）' : '精确求解'}。</>
                      : '先修正矩阵或代价表中的问题，再求解。'}
                  </p>
                </div>
              </div>
            )}
          </section>
        </main>

        <aside className="pane pane-right">
          <section className="section">
            <div className="tabs" role="tablist">
              <button role="tab" aria-selected={rightTab === 'result'} onClick={() => setRightTab('result')}>结果</button>
              <button role="tab" aria-selected={rightTab === 'ties'} onClick={() => setRightTab('ties')}>
                候选树{result?.result?.tieCount > 1 ? ` (${result.result.tieCount})` : ''}
              </button>
              <button role="tab" aria-selected={rightTab === 'diagnostics'} onClick={() => setRightTab('diagnostics')}>
                诊断{result?.diagnostics?.length ? ` (${result.diagnostics.length})` : ''}
              </button>
              <button role="tab" aria-selected={rightTab === 'check'} onClick={() => setRightTab('check')}>核对与重采样</button>
            </div>

            {solveError ? (
              <div className="diag error" style={{ marginBottom: 10 }}>
                <div>{solveError}</div>
              </div>
            ) : null}

            {rightTab === 'result' ? (
              <ResultTab
                result={result}
                solving={solving}
                progress={progress}
                annotation={annotation}
                features={dataset?.features || []}
                highlightFeature={highlightFeature}
                onHoverFeature={setHighlightFeature}
                selectedEdge={selectedEdge}
                tieDiff={tieDiff}
                onSelectTie={(i) => { setActiveTie(i); setRightTab('ties'); }}
                activeTie={activeTie}
                check={check}
                onCheck={runCheck}
                checking={checking}
                selectedTaxon={selectedTaxon}
                displayTree={displayTree}
              />
            ) : null}

            {rightTab === 'ties' ? (
              result?.status === 'solved' ? (
                <TiesList
                  result={result}
                  activeIndex={activeTie}
                  onPick={(i) => { setActiveTie(i); setSelectedEdge(null); }}
                  labels={labels}
                />
              ) : (
                <div className="empty-hint">求解后这里列出所有等代价树形，并按未根化结构分组。</div>
              )
            ) : null}

            {rightTab === 'diagnostics' ? (
              <>
                {result?.status === 'infeasible' ? (
                  <div className="diag error" style={{ marginBottom: 10 }}>
                    <div>{result.message || '没有可行树。'}</div>
                  </div>
                ) : null}
                <DiagnosticList diagnostics={[...(result?.diagnostics || []), ...(validation ? [...validation.errors.map((e) => ({ level: 'error', ...e })), ...validation.warnings.map((w) => ({ level: 'warning', ...w }))] : [])]} />
              </>
            ) : null}

            {rightTab === 'check' ? (
              <>
                <CheckTreePanel
                  check={check}
                  onCheck={runCheck}
                  disabled={!result || result.status !== 'solved'}
                  running={checking}
                />
                <hr style={{ border: 'none', borderTop: '1px solid var(--border)', margin: '14px 0' }} />
                <ResamplePanel
                  resample={resample}
                  onRun={runResample}
                  running={resampling}
                  options={resampleOptions}
                  setOptions={setResampleOptions}
                />
              </>
            ) : null}
          </section>
        </aside>
      </div>
    </div>
  );

  // -------------------------------------------------------------- helpers in scope

  function importJson() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.onchange = () => {
      const file = input.files && input.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const parsed = JSON.parse(String(reader.result));
          if (!parsed || !parsed.taxa || !parsed.features || !parsed.matrix) {
            throw new Error('缺少 taxa / features / matrix 字段。');
          }
          setDataset(parsed);
          setActiveSample(null);
          setResult(null);
          setNotice({ level: 'info', text: `已导入 ${file.name}。` });
        } catch (err) {
          setNotice({ level: 'error', text: `导入失败：${err.message}` });
        }
      };
      reader.readAsText(file, 'utf-8');
    };
    input.click();
  }

  function exportJson() {
    if (!dataset) return;
    const blob = new Blob([JSON.stringify(dataset, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${dataset.id || 'dataset'}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }
}

// ------------------------------------------------------------------ sub views

function FeatureNameRow({ features, onRename }) {
  if (!features.length) return null;
  return (
    <div style={{ marginBottom: 10 }}>
      {features.map((f) => (
        <div key={f.id} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
          <span className="mono small muted" style={{ width: 26 }}>{f.id}</span>
          <input
            type="text"
            value={f.name}
            onChange={(e) => onRename(f.id, e.target.value)}
            aria-label={`特征 ${f.id} 名称`}
          />
        </div>
      ))}
    </div>
  );
}

function PlayIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
      <path d="M3 1.8v8.4l7-4.2-7-4.2Z" />
    </svg>
  );
}

function CompactIssues({ validation, onMore, result }) {
  const errs = validation.errors.length;
  const warns = validation.warnings.length;
  return (
    <div className="banner" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <span>
        {errs ? <b style={{ color: 'var(--critical-ink)' }}>{errs} 个错误</b> : null}
        {errs && warns ? '，' : null}
        {warns ? <>{warns} 个提醒</> : null}
        {!errs && !warns && result ? '数据校验通过。' : ''}
      </span>
      <span style={{ flex: 1 }} />
      <button className="btn small ghost" onClick={onMore}>查看详情</button>
    </div>
  );
}

function ResultTab({
  result,
  solving,
  progress,
  annotation,
  features,
  highlightFeature,
  onHoverFeature,
  selectedEdge,
  tieDiff,
  onSelectTie,
  activeTie,
  check,
  onCheck,
  checking,
  selectedTaxon,
  displayTree,
}) {
  if (solving) {
    return (
      <div className="empty-hint" style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <span className="spin" />
        后台求解中{progress && progress.stage ? ` · ${stageName(progress.stage)}` : ''}…
      </div>
    );
  }
  if (!result) {
    return (
      <div className="empty-hint">
        还没有求解结果。左栏选样例（或自建数据），右上按“求解”。
      </div>
    );
  }
  if (result.status !== 'solved') {
    return (
      <div>
        <div className="diag error"><div>{result.message || '没有可行解。'}</div></div>
        <DiagnosticList diagnostics={result.diagnostics} />
      </div>
    );
  }

  const edge = annotation?.edges.find((e) => `${e.parentId}:${e.childId}` === selectedEdge);
  const edgeFeatureRows = edge
    ? features
        .map((f) => ({ f, info: edge.perFeature?.[f.id] }))
        .filter((x) => x.info)
    : [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div className="summary-grid">
        <div className="stat">
          <div className="label">总代价</div>
          <div className="value">{fmt(result.result.total)}</div>
          <div className="sub">{result.method === 'exact' ? '精确 DP' : '局部搜索'}</div>
        </div>
        <div className="stat">
          <div className="label">等代价树形</div>
          {result.result.tiesComplete ? (
            <>
              <div className="value">{result.result.tieCount}</div>
              <div className="sub">{result.result.distinctUnrooted} 个未根化结构</div>
            </>
          ) : result.result.tieCount > 1 ? (
            <>
              <div className="value">{result.result.tieCount}</div>
              <div className="sub">仅列出找到的，未枚举</div>
            </>
          ) : (
            <>
              <div className="value">未枚举</div>
              <div className="sub">局部搜索未列出等价结构</div>
            </>
          )}
        </div>
        <div className="stat">
          <div className="label">独立下界</div>
          <div className="value">{fmt(result.proof.lowerBound)}</div>
          <div className="sub">
            {Math.abs(result.proof.gap ?? 1) < 1e-9 ? '与代价相等（紧）' : `代价 − 下界 = ${fmt(result.proof.gap)}`}
          </div>
        </div>
      </div>

      <ProofBanner result={result} />

      <div>
        <h3 style={{ marginBottom: 6 }}>各特征在这棵树上的代价</h3>
        <FeatureCostChart
          annotation={annotation}
          features={features}
          highlightFeature={highlightFeature}
          onHoverFeature={onHoverFeature}
        />
      </div>

      {edgeFeatureRows.length ? (
        <div>
          <h3 style={{ marginBottom: 6 }}>选中枝条的代价明细</h3>
          <table className="data-table">
            <thead>
              <tr><th>特征</th><th>转移</th><th className="num">代价</th></tr>
            </thead>
            <tbody>
              {edgeFeatureRows.map(({ f, info }) => (
                <tr key={f.id}>
                  <td>{f.name}</td>
                  <td className="mono small">
                    {info.missing ? '未观测（不产生代价）' : `${info.from}→${info.to}`}
                  </td>
                  <td className="num">{fmt(info.cost)}</td>
                </tr>
              ))}
              <tr>
                <td colSpan={2}><b>合计</b></td>
                <td className="num"><b>{fmt(edge.totalCost)}</b></td>
              </tr>
            </tbody>
          </table>
        </div>
      ) : null}

      {tieDiff ? (
        <div>
          <h3 style={{ marginBottom: 6 }}>与另一个候选树的差异</h3>
          <div className="small muted" style={{ marginBottom: 4 }}>
            对比：当前 #{activeTie + 1} 与 #{tieDiff.other.index + 1}（代价同为 {fmt(result.result.total)}）
          </div>
          {tieDiff.diff.same ? (
            <div className="banner small">两棵树的未根化结构相同，只是根的位置不同（代价不变）。</div>
          ) : (
            <div className="small" style={{ lineHeight: 1.7 }}>
              <div>只在当前树的分割：{tieDiff.diff.onlyA.length ? tieDiff.diff.onlyA.join('；') : '无'}</div>
              <div>只在对比树的分割：{tieDiff.diff.onlyB.length ? tieDiff.diff.onlyB.join('；') : '无'}</div>
              <div className="muted">分割写法：左集合 ⟷ 右集合，表示该枝条把样品分成两半。</div>
            </div>
          )}
          <button className="btn small" style={{ marginTop: 8 }} onClick={() => onSelectTie(tieDiff.other.index)}>
            查看对比树
          </button>
        </div>
      ) : null}

      {selectedTaxon ? (
        <TaxonDrawer taxon={selectedTaxon} annotation={annotation} features={features} labels={{}} />
      ) : null}

      <div>
        <h3 style={{ marginBottom: 6 }}>Newick</h3>
        <div className="mono small" style={{ overflowWrap: 'anywhere', background: 'var(--surface-2)', padding: '7px 9px', borderRadius: 7 }}>
          {displayNewick(displayTree, result.taxa)}
        </div>
        <div className="section-hint">
          导出的是这棵有根树；未根化结构与等价结构请以候选树页签为准。
        </div>
      </div>

      <details>
        <summary className="small muted" style={{ cursor: 'pointer' }}>独立核对这棵树</summary>
        <div style={{ marginTop: 8 }}>
          <CheckTreePanel check={check} onCheck={onCheck} disabled={false} running={checking} />
        </div>
      </details>
    </div>
  );
}

function TaxonDrawer({ taxon, annotation, features, labels }) {
  const leaf = annotation.nodes.find((n) => n.kind === 'leaf' && n.taxon === taxon);
  if (!leaf) return null;
  const incoming = annotation.edges.find((e) => e.childId === leaf.id);
  return (
    <div>
      <h3 style={{ marginBottom: 6 }}>样品 {labels[taxon] || taxon}</h3>
      <table className="data-table">
        <thead>
          <tr><th>特征</th><th>状态</th><th className="num">进入该叶的代价</th></tr>
        </thead>
        <tbody>
          {features.map((f) => {
            const info = incoming?.perFeature?.[f.id];
            const state = annotation.featureNodeStates?.[f.id]?.[leaf.id];
            return (
              <tr key={f.id}>
                <td>{f.name}</td>
                <td className="mono small">{state === null || state === undefined ? '未观测' : f.states[state]}</td>
                <td className="num">{info ? fmt(info.cost) : '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="section-hint">“未观测”的格子不产生代价，也不会被标成某个状态。</div>
    </div>
  );
}

function DataFlow({ dataset, validation, annotation, result }) {
  if (!dataset) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div>
        <h3 style={{ marginBottom: 4 }}>数据流</h3>
        <ol className="small" style={{ paddingLeft: 18, margin: 0, color: 'var(--text-secondary)', lineHeight: 1.7 }}>
          <li>编辑矩阵与每个特征的转移代价（缺失写作 null）。</li>
          <li>锁定若干样品，要求它们成为共同分支；约束直接进入搜索。</li>
          <li>在后台求解：精确 DP 或局部搜索（局部结果附可核对下界）。</li>
          <li>查看各特征代价、等代价结构、候选树差异，并可独立核对当前树。</li>
          <li>重采样以整列特征为单位，锁定约束保持不变。</li>
        </ol>
      </div>
      <dl className="kv">
        <dt>样品</dt><dd>{dataset.taxa.length}</dd>
        <dt>特征</dt><dd>{dataset.features.length}</dd>
        <dt>有序特征</dt><dd>{dataset.features.filter((f) => f.ordered).length}</dd>
        <dt>缺失格</dt><dd>{validation?.stats?.missingCells ?? '—'}</dd>
        <dt>锁定</dt><dd>{dataset.constraints?.length || 0}</dd>
        <dt>求解状态</dt><dd>{result?.status || '未求解'}</dd>
      </dl>
      <div className="section-hint">
        全部数据都是虚构示例。这里只计算“这些离散特征在树上要付多少代价”，不声称样品之间存在真实的亲缘关系。
      </div>
    </div>
  );
}

function stageName(stage) {
  const map = {
    queued: '排队',
    starting: '启动',
    validating: '校验',
    resampling: '重采样',
    checking: '核对',
    finishing: '收尾',
    done: '完成',
  };
  return map[stage] || stage;
}

function displayNewick(tree, taxa) {
  const labels = {};
  for (const t of taxa || []) labels[t.id] = t.id;
  return newick(tree, labels);
}
