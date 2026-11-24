import React, { useState } from 'react';
import { transitionRows, unorderedKey, orderedKey } from '../../../shared/cost.js';
import { convertOrdering } from '../../../shared/validate.js';
import { fmt } from '../lib.js';

/**
 * Per-feature transition-cost editor. Ordered features get one row per
 * direction; unordered ones one row per pair. Missing states are not listed.
 */
export default function CostEditor({ features, featureCosts, onChange, onFeatureMeta }) {
  const [active, setActive] = useState(0);
  const [note, setNote] = useState(null);
  const feature = features[Math.min(active, features.length - 1)];
  if (!feature) return <div className="empty-hint">还没有特征。先添加一个特征。</div>;

  const costs = featureCosts[feature.id] || feature.costs || {};
  const rows = transitionRows(feature);

  const setCost = (key, raw) => {
    const next = { ...costs };
    if (raw === '' || raw === null || raw === undefined) {
      delete next[key];
    } else {
      const num = Number(raw);
      next[key] = Number.isFinite(num) ? num : 0;
    }
    onChange(feature.id, next);
  };

  const toggleOrdered = () => {
    const res = convertOrdering({ ...feature, costs }, !feature.ordered);
    onFeatureMeta(feature.id, { ordered: res.feature.ordered, costs: res.feature.costs });
    setNote({ featureId: feature.id, text: res.note, lost: res.lost });
  };

  const addState = () => {
    const existing = new Set(feature.states);
    let i = 0;
    while (existing.has(String(i))) i++;
    const states = [...feature.states, String(i)].sort((a, b) => (a < b ? -1 : 1));
    onFeatureMeta(feature.id, { states, costs: pruneCosts(costs, states, feature.ordered) });
  };

  const removeState = (s) => {
    if (feature.states.length <= 2) {
      setNote({ featureId: feature.id, text: '至少要保留两个观测状态；缺失不是状态，不能用来替代。', lost: [] });
      return;
    }
    const states = feature.states.filter((x) => x !== s);
    onFeatureMeta(feature.id, { states, costs: pruneCosts(costs, states, feature.ordered) });
  };

  const unpriced = rows.filter((r) => typeof costs[r.key] !== 'number');

  return (
    <div>
      <div className="feature-tabs" role="tablist" aria-label="特征">
        {features.map((f, i) => (
          <button
            key={f.id}
            className="feature-tab"
            role="tab"
            aria-pressed={i === active}
            onClick={() => {
              setActive(i);
              setNote(null);
            }}
          >
            {f.name}
            <span className="tag">{f.ordered ? '有序' : '无序'}</span>
          </button>
        ))}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8, flexWrap: 'wrap' }}>
        <div className="segmented" role="group" aria-label="特征类型">
          <button aria-pressed={!feature.ordered} onClick={() => { if (feature.ordered) toggleOrdered(); }}>
            无序
          </button>
          <button aria-pressed={feature.ordered} onClick={() => { if (!feature.ordered) toggleOrdered(); }}>
            有序
          </button>
        </div>
        <span className="small muted">
          {feature.ordered ? '每个方向单独定价，可以不对称。' : '每对状态共用一份代价，必须对称。'}
        </span>
        <span style={{ flex: 1 }} />
        <button className="btn small" onClick={addState}>+ 状态</button>
      </div>

      <div className="taxon-picker" style={{ marginTop: 0 }}>
        {feature.states.map((s) => (
          <span key={s} className="taxa-chip">
            {s}
            <button
              className="btn ghost small"
              style={{ padding: '0 3px', marginLeft: 3, color: 'var(--text-muted)' }}
              title={`移除状态 ${s}`}
              onClick={() => removeState(s)}
            >
              ×
            </button>
          </span>
        ))}
      </div>

      {note && note.featureId === feature.id ? (
        <div className="banner" style={{ marginBottom: 8 }}>
          {note.text}
        </div>
      ) : null}

      <table className="cost-table">
        <thead>
          <tr>
            <th>转移</th>
            <th>代价</th>
            <th>说明</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const val = costs[r.key];
            const missing = typeof val !== 'number';
            return (
              <tr key={r.key}>
                <td className="mono">
                  {feature.ordered ? (
                    <>
                      {r.from} <span className="muted">→</span> {r.to}
                    </>
                  ) : (
                    <>
                      {'{'}
                      {r.from}, {r.to}
                      {'}'}
                    </>
                  )}
                </td>
                <td>
                  <input
                    type="number"
                    min="0"
                    step="0.5"
                    className="mono"
                    value={missing ? '' : val}
                    placeholder="未定义"
                    onChange={(e) => setCost(r.key, e.target.value)}
                  />
                  {missing ? <span className="cost-cell-flag" title="使用该转移的树将无法定价">缺</span> : null}
                </td>
                <td className="small muted">
                  {feature.ordered
                    ? r.from < r.to
                      ? '正向'
                      : '反向（可不同于正向）'
                    : '对称'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {unpriced.length ? (
        <div className="section-hint">
          有 {unpriced.length} 个转移没有代价：如果某棵树非用不可，它会被标为“无法定价”而不是自动补 0 或 1。
        </div>
      ) : null}
    </div>
  );
}

function pruneCosts(costs, states, ordered) {
  const keep = new Set(states);
  const out = {};
  for (const [k, v] of Object.entries(costs)) {
    const sep = k.includes('>') ? '>' : '|';
    const [a, b] = k.split(sep);
    if (!keep.has(a) || !keep.has(b)) continue;
    const key = ordered ? orderedKey(a, b) : unorderedKey(a, b);
    if (sep === (ordered ? '>' : '|')) out[key] = v;
  }
  return out;
}
