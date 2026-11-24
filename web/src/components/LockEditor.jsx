import React, { useState } from 'react';
import { validateLocks } from '../../../shared/locks.js';

/**
 * Lock authoring. Locks are compiled and validated here, then passed into the
 * solver; the solver never paints a lock onto a finished tree.
 */
export default function LockEditor({ taxonIds, constraints, onChange, lockReport = [], visible = false }) {
  const [draft, setDraft] = useState([]);
  const [note, setNote] = useState('');

  const local = validateLocks(constraints, taxonIds);
  const toggle = (t) =>
    setDraft((d) => (d.includes(t) ? d.filter((x) => x !== t) : [...d, t]));

  const add = () => {
    if (draft.length === 0) {
      setNote('先选至少两个样品。');
      return;
    }
    if (draft.length === 1) {
      setNote('锁定只含一个样品没有约束力：任何树都满足。请再选一个。');
      return;
    }
    const existing = new Set(constraints.map((c) => [...c.taxa].sort().join('|')));
    if (existing.has([...draft].sort().join('|'))) {
      setNote('这个样品集合已经有锁定了。');
      return;
    }
    const id = nextLockId(constraints);
    onChange([...constraints, { id, taxa: [...draft].sort(), note: '' }]);
    setDraft([]);
    setNote('');
  };

  const errorById = new Map();
  for (const e of local.errors) {
    for (const id of e.lockIds || [e.lockId]) {
      if (!id) continue;
      if (!errorById.has(id)) errorById.set(id, []);
      errorById.get(id).push(e);
    }
  }
  const warningById = new Map();
  for (const w of local.warnings) {
    if (!w.lockId) continue;
    if (!warningById.has(w.lockId)) warningById.set(w.lockId, []);
    warningById.get(w.lockId).push(w);
  }
  const infoById = new Map();
  for (const i of local.infos || []) {
    if (!i.lockId) continue;
    if (!infoById.has(i.lockId)) infoById.set(i.lockId, []);
    infoById.get(i.lockId).push(i);
  }

  return (
    <div>
      <div className="small muted" style={{ marginBottom: 8 }}>
        锁定要求这些样品构成一个<b>共同分支</b>。约束直接进入搜索：不可行会明确报出，不会在画好的树上调整。
      </div>

      <div className="taxon-picker">
        {taxonIds.map((t) => (
          <button
            key={t}
            className="taxon-toggle"
            aria-pressed={draft.includes(t)}
            onClick={() => toggle(t)}
            type="button"
          >
            {t}
          </button>
        ))}
      </div>
      <div className="btn-row" style={{ marginBottom: 8 }}>
        <button className="btn small primary" onClick={add}>锁定所选样品为共同分支</button>
        {draft.length ? (
          <button className="btn small ghost" onClick={() => { setDraft([]); setNote(''); }}>
            清空选择
          </button>
        ) : null}
      </div>
      {note ? <div className="section-hint" style={{ color: 'var(--critical-ink)' }}>{note}</div> : null}

      {constraints.length === 0 ? (
        <div className="empty-hint">还没有锁定约束。没有锁定时求解器在全部树形中搜索。</div>
      ) : (
        <div className="lock-list">
          {constraints.map((c) => {
            const errs = errorById.get(c.id) || [];
            const warns = warningById.get(c.id) || [];
            const infos = infoById.get(c.id) || [];
            const report = lockReport.find((r) => r.id === c.id);
            return (
              <div key={c.id} className={`lock-card ${errs.length ? 'is-conflict' : ''}`}>
                <div className="head">
                  <span className="id">{c.id}</span>
                  <span className="taxa-chip" style={{ background: 'var(--accent-wash)', color: 'var(--accent-ink)' }}>
                    共同分支
                  </span>
                  <span style={{ flex: 1 }} />
                  {report ? (
                    <span className="badge" style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                      {report.holds ? '树上成立' : '树上不成立'}
                    </span>
                  ) : null}
                  <button
                    className="btn ghost small"
                    title={`删除锁定 ${c.id}`}
                    onClick={() => onChange(constraints.filter((x) => x.id !== c.id))}
                  >
                    ×
                  </button>
                </div>
                <div className="taxa-chips">
                  {c.taxa.map((t) => (
                    <span key={t} className="taxa-chip">{t}</span>
                  ))}
                </div>
                {errs.map((e, i) => (
                  <div className="msg error" key={i}>{e.message}</div>
                ))}
                {warns.map((w, i) => (
                  <div className="msg info" key={i}>{w.message}</div>
                ))}
                {infos.map((inf, i) => (
                  <div className="msg info" key={i}>{inf.message}</div>
                ))}
                {!errs.length && !warns.length && !infos.length ? (
                  <div className="msg info">这组样品将作为一个整体分支出现在最优树中。</div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}

      {local.errors.length ? (
        <div className="diag error" style={{ marginTop: 10 }}>
          <span className="code">锁定冲突</span>
          <span>这些锁定互相矛盾，求解会被拒绝。请先处理上面的提示。</span>
        </div>
      ) : null}
    </div>
  );
}

function nextLockId(constraints) {
  let i = 1;
  const used = new Set(constraints.map((c) => c.id));
  while (used.has(`L${i}`)) i++;
  return `L${i}`;
}
