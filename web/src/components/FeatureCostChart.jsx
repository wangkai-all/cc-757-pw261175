import React, { useMemo, useState } from 'react';
import { fmt } from '../lib.js';

/**
 * Horizontal bar chart of the selected tree's cost broken down by feature.
 * One series (cost), so no legend; each bar is directly labelled. Values are
 * read from the solver's per-feature decomposition, not recomputed here.
 */
export default function FeatureCostChart({ annotation, features, onHoverFeature, highlightFeature }) {
  const [hover, setHover] = useState(null);

  const rows = useMemo(() => {
    if (!annotation) return [];
    return features
      .map((f) => {
        const row = annotation.perFeature?.[f.id];
        return {
          id: f.id,
          name: f.name,
          ordered: f.ordered,
          cost: row && row.weightedCost !== null && row.weightedCost !== undefined ? row.weightedCost : null,
          unpriced: !row || row.cost === null,
        };
      })
      .sort((a, b) => (b.cost || 0) - (a.cost || 0));
  }, [annotation, features]);

  const total = rows.reduce((a, r) => a + (r.cost || 0), 0);
  const max = Math.max(1, ...rows.map((r) => r.cost || 0));

  const W = 360;
  const rowH = 30;
  const padL = 96;
  const padR = 40;
  const padT = 6;
  const padB = 24;
  const H = padT + padB + Math.max(1, rows.length) * rowH;
  const plotW = W - padL - padR;

  const ticks = niceTicks(0, max, 4);

  return (
    <div className="chart-card">
      <div className="small muted" style={{ marginBottom: 6 }}>
        这棵树的总代价 {fmt(total)}；按特征拆分。每个特征独立取最优，因此各柱之和等于总数。
      </div>
      <svg className="cost-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="各特征在树上的代价">
        {ticks.map((t) => {
          const x = padL + (t / max) * plotW;
          return (
            <g key={t}>
              <line className="grid-line" x1={x} x2={x} y1={padT} y2={H - padB} />
              <text className="tick" x={x} y={H - padB + 14} textAnchor="middle">
                {fmt(t)}
              </text>
            </g>
          );
        })}
        <line className="axis-line" x1={padL} x2={padL} y1={padT} y2={H - padB} />
        {rows.map((r, i) => {
          const y = padT + i * rowH;
          const barH = Math.min(22, rowH - 10);
          const w = r.cost === null ? 0 : Math.max(0, (r.cost / max) * plotW);
          const isHl = highlightFeature === r.id;
          return (
            <g
              key={r.id}
              onMouseEnter={() => {
                setHover(r);
                onHoverFeature && onHoverFeature(r.id);
              }}
              onMouseLeave={() => {
                setHover(null);
                onHoverFeature && onHoverFeature(null);
              }}
              style={{ cursor: 'pointer' }}
            >
              <rect x={0} y={y} width={W} height={rowH} fill="transparent" />
              <text className="cat-label" x={padL - 8} y={y + rowH / 2 + 4} textAnchor="end">
                {truncate(r.name, 7)}
              </text>
              {r.unpriced ? (
                <text className="bar-label" x={padL + 4} y={y + rowH / 2 + 4} style={{ fill: 'var(--critical-ink)' }}>
                  无法定价
                </text>
              ) : (
                <rect
                  className="bar"
                  x={padL}
                  y={y + (rowH - barH) / 2}
                  width={Math.max(w, r.cost > 0 ? 2 : 0)}
                  height={barH}
                  fill={isHl ? 'var(--series-1)' : 'var(--series-1)'}
                  opacity={isHl ? 1 : 0.82}
                />
              )}
              {r.cost !== null ? (
                <text className="bar-label" x={padL + w + 7} y={y + rowH / 2 + 4}>
                  {fmt(r.cost)}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
      {hover ? (
        <div className="small muted" style={{ marginTop: 4 }}>
          {hover.name}：{hover.unpriced ? '无法定价（缺少转移代价）' : `${fmt(hover.cost)}（${hover.ordered ? '有序' : '无序'}特征）`}
        </div>
      ) : null}
    </div>
  );
}

function truncate(s, n) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function niceTicks(min, max, count) {
  if (!(max > min)) return [0];
  const span = max - min;
  const raw = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  const out = [];
  for (let v = 0; v <= max + 1e-9; v += step) out.push(Math.round(v * 1000) / 1000);
  return out;
}
