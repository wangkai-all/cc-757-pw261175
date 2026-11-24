import React, { useState, useEffect, useRef } from 'react';
import { MISSING_LABEL } from '../lib.js';

/**
 * Editable matrix. Clicking a cell opens a select of the feature's declared
 * states plus "未观测". Missing is stored as null and is never treated as a
 * state; the UI says so next to the legend.
 */
export default function MatrixEditor({
  features,
  taxonIds,
  taxa,
  matrix,
  locks = [],
  errors = [],
  onChange,
  onAddTaxon,
  onRemoveTaxon,
  onRenameTaxon,
}) {
  const [editing, setEditing] = useState(null); // {taxon, fi}
  const [adding, setAdding] = useState(false);
  const [newId, setNewId] = useState('');
  const errCells = new Set(
    errors
      .map((e) => e.path)
      .filter(Boolean)
      .map((p) => p.replace(/^matrix\./, '')),
  );
  const lockedTaxa = new Set(locks.flatMap((l) => l.taxa));

  const setCell = (taxon, fi, value) => {
    const next = { ...matrix, [taxon]: [...(matrix[taxon] || [])] };
    next[taxon][fi] = value;
    onChange(next);
  };

  const addTaxon = () => {
    const id = newId.trim();
    if (!id) return;
    if (taxonIds.includes(id)) return;
    onAddTaxon(id);
    setNewId('');
    setAdding(false);
  };

  return (
    <div>
      <div className="matrix-toolbar">
        <span className="small muted grow">点击格子改状态；缺失记为“未观测”，不当作类别。</span>
        {!adding ? (
          <button className="btn small" onClick={() => setAdding(true)}>+ 样品</button>
        ) : (
          <>
            <input
              className="mono"
              style={{ width: 110 }}
              placeholder="新样品 id"
              value={newId}
              autoFocus
              onChange={(e) => setNewId(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') addTaxon();
                if (e.key === 'Escape') setAdding(false);
              }}
            />
            <button className="btn small primary" onClick={addTaxon}>添加</button>
            <button className="btn small ghost" onClick={() => setAdding(false)}>取消</button>
          </>
        )}
      </div>

      <div className="matrix-wrap">
        <table className="matrix">
          <thead>
            <tr>
              <th style={{ minWidth: 78 }}>样品</th>
              {features.map((f) => (
                <th key={f.id} title={f.name}>
                  {f.name}
                  <span className="ord">{f.ordered ? '有序' : '无序'}</span>
                </th>
              ))}
              <th style={{ width: 34 }} aria-label="操作" />
            </tr>
          </thead>
          <tbody>
            {taxonIds.map((tid) => (
              <tr key={tid} className={lockedTaxa.has(tid) ? 'row-locked-lock' : ''}>
                <th>
                  <span className="mono">{tid}</span>
                  {lockedTaxa.has(tid) ? <span className="small muted" title="参与锁定"> ⚯</span> : null}
                </th>
                {features.map((f, fi) => {
                  const v = (matrix[tid] || [])[fi];
                  const isEditing = editing && editing.taxon === tid && editing.fi === fi;
                  const cellPath = `${tid}.${fi}`;
                  return (
                    <td
                      key={f.id}
                      className={`cell ${v === null || v === undefined ? 'missing' : ''} ${isEditing ? 'editing' : ''} ${
                        errCells.has(cellPath) ? 'conflict' : ''
                      }`}
                    >
                      {isEditing ? (
                        <select
                          autoFocus
                          value={v === null || v === undefined ? '__missing__' : v}
                          onChange={(e) => {
                            const next = e.target.value;
                            setCell(tid, fi, next === '__missing__' ? null : next);
                            setEditing(null);
                          }}
                          onBlur={() => setEditing(null)}
                        >
                          <option value="__missing__">{MISSING_LABEL}</option>
                          {f.states.map((s) => (
                            <option key={s} value={s}>{s}</option>
                          ))}
                        </select>
                      ) : (
                        <button onClick={() => setEditing({ taxon: tid, fi })} title={`${tid} · ${f.name}`}>
                          {v === null || v === undefined ? MISSING_LABEL : v}
                        </button>
                      )}
                    </td>
                  );
                })}
                <td className="cell" style={{ textAlign: 'center', padding: 0 }}>
                  <button
                    className="btn ghost small"
                    title={`删除样品 ${tid}`}
                    aria-label={`删除样品 ${tid}`}
                    onClick={() => {
                      if (lockedTaxa.has(tid)) {
                        if (!window.confirm(`样品 ${tid} 在锁定约束中。删除它会移除相关锁定，继续？`)) return;
                      }
                      onRemoveTaxon(tid);
                    }}
                  >
                    ×
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="legend-inline" style={{ marginTop: 7 }}>
        <span className="swatch missing" />
        <span>“{MISSING_LABEL}”= 该格没有观测值，不参与代价计算，也不会在树上被标成任何状态。</span>
      </div>
    </div>
  );
}
