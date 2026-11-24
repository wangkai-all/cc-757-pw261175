import React, { useState } from 'react';
import { fmt, newick } from '../lib.js';

export default function DiagnosticList({ diagnostics }) {
  if (!diagnostics || !diagnostics.length) {
    return <div className="empty-hint">没有诊断信息。</div>;
  }
  const order = { error: 0, warning: 1, info: 2 };
  const sorted = [...diagnostics].sort((a, b) => (order[a.level] ?? 3) - (order[b.level] ?? 3));
  return (
    <div className="diag-list">
      {sorted.map((d, i) => (
        <div className={`diag ${d.level}`} key={i}>
          <Icon level={d.level} />
          <div>
            <div>{d.message}</div>
            {d.code ? <div className="code">{d.code}</div> : null}
          </div>
        </div>
      ))}
    </div>
  );
}

function Icon({ level }) {
  if (level === 'error') {
    return (
      <svg className="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
        <circle cx="8" cy="8" r="6.4" />
        <path d="M8 4.6v4.2M8 11.3v.1" strokeLinecap="round" />
      </svg>
    );
  }
  if (level === 'warning') {
    return (
      <svg className="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
        <path d="M8 2.2 14.4 13H1.6L8 2.2Z" strokeLinejoin="round" />
        <path d="M8 6.4v3M8 11.4v.1" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg className="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
      <circle cx="8" cy="8" r="6.4" />
      <path d="M8 7.2v4M8 4.8v.1" strokeLinecap="round" />
    </svg>
  );
}

export function ProofBanner({ result }) {
  if (!result || !result.proof) return null;
  const p = result.proof;
  const proven = p.provenOptimal;
  const exact = p.exact;
  const gap = p.gap;
  const tight = gap !== null && gap !== undefined && Math.abs(gap) < 1e-9;
  return (
    <div className={`proof-banner ${proven ? 'proven' : 'unproven'}`}>
      <div className="head">
        {proven ? (
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="var(--good)" strokeWidth="2">
            <path d="M3 8.5 6.4 12 13 4.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : (
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="#a97800" strokeWidth="1.8">
            <path d="M8 2.4v7M8 12.4v.1" strokeLinecap="round" />
          </svg>
        )}
        <span>
          {exact ? '代价由精确搜索证明最优' : proven ? '局部搜索结果已达到下界，代价已证明最优' : '这是找到的最好树，不是全局最优声明'}
        </span>
      </div>
      <div className="small" style={{ color: 'var(--text-secondary)', marginBottom: 6 }}>
        {p.statement}
      </div>
      {p.lowerBound !== null && p.lowerBound !== undefined ? (
        <div className="small" style={{ color: 'var(--text-secondary)' }}>
          独立可核对下界 {fmt(p.lowerBound)}，当前代价 {fmt(result.result?.total)}。
          {tight ? (
            <> 下界与代价相等，因此这条下界也独立证实了最优。</>
          ) : exact ? (
            <> 这条下界不是紧的（差额 {fmt(gap)}）；它的作用只是给出一个不依赖搜索过程的独立参考。最优性来自穷尽全部拓扑，不来自这条下界。</>
          ) : (
            <> 差额 {fmt(gap)}：搜索尚未证明该代价最小。</>
          )}
        </div>
      ) : null}
    </div>
  );
}

export function TiesList({ result, activeIndex, onPick, labels }) {
  if (!result) return null;
  const ties = result.result?.ties || [];
  if (!ties.length) return <div className="empty-hint">没有等代价结构列表。</div>;
  const groups = result.result.tieGroups || [];

  return (
    <div>
      <div className="small muted" style={{ marginBottom: 8 }}>
        {result.result.tiesComplete ? (
          <>
            {result.result.tieCount} 个有根树形总代价相同
            {result.result.distinctUnrooted !== undefined
              ? `，归为 ${result.result.distinctUnrooted} 个未根化结构`
              : ''}
            。
          </>
        ) : (
          <>
            这里只有搜索找到的 {result.result.tieCount} 个树形（代价同为 {fmt(ties[0]?.total)}）；
            本次搜索没有枚举其他等代价结构，因此不能据此认为它唯一。
          </>
        )}
        点任一项切换到该树形查看。
      </div>
      {result.result.tieNote ? <div className="banner small" style={{ marginBottom: 8 }}>{result.result.tieNote}</div> : null}
      <div className="tie-list">
        {groups.map((g, gi) => (
          <div key={g.unrootedSignature || gi}>
            <div className="tie-group-head">
              {result.result.tiesComplete
                ? `未根化结构 ${gi + 1}：${g.rootedVariants.length} 个根位置${
                    gi === 0 ? '（当前结构在其中）' : ''
                  }`
                : '搜索找到的树（未按未根化结构分组）'}
            </div>
            {g.rootedVariants.map((idx) => {
              const tie = ties[idx];
              if (!tie) return null;
              return (
                <button
                  key={idx}
                  className="tie-item"
                  aria-pressed={activeIndex === idx}
                  onClick={() => onPick(idx)}
                  style={{ marginBottom: 4 }}
                >
                  <div className="row">
                    <span className="idx">#{idx + 1}</span>
                    <span className="badge">代价 {fmt(tie.total)}</span>
                    {activeIndex === idx ? <span className="badge" style={{ background: 'var(--accent-wash)', color: 'var(--accent-ink)' }}>正在显示</span> : null}
                  </div>
                  <div className="newick">{newick(tie.tree, labels)}</div>
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

export function ResamplePanel({ resample, onRun, running, options, setOptions }) {
  return (
    <div>
      <div className="small muted" style={{ marginBottom: 8 }}>
        重采样以整列特征为单位（不是逐格），锁定约束在每个重复里保持不变。
      </div>
      <div className="btn-row" style={{ alignItems: 'center', marginBottom: 10 }}>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={!!options.reoptimise}
            onChange={(e) => setOptions({ ...options, reoptimise: e.target.checked })}
          />
          每个重复重新求解（否则只对当前树重新计价）
        </label>
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}>
        <span className="small muted">重复次数</span>
        <input
          type="number"
          min="10"
          max="2000"
          step="10"
          style={{ width: 90 }}
          value={options.replicates}
          onChange={(e) => setOptions({ ...options, replicates: Math.max(10, Number(e.target.value) || 10) })}
        />
        <button className="btn small primary" onClick={onRun} disabled={running}>
          {running ? <span className="spin" /> : null} 运行重采样
        </button>
      </div>
      {resample ? <ResampleView resample={resample} /> : <div className="empty-hint">尚未运行重采样。</div>}
    </div>
  );
}

function ResampleView({ resample }) {
  if (!resample.ok) {
    return <div className="diag error"><div>{resample.message || '重采样失败。'}</div></div>;
  }
  const s = resample.summary;
  const samples = resample.samples || [];
  return (
    <div>
      <div className="summary-grid" style={{ marginBottom: 8 }}>
        <div className="stat">
          <div className="label">中位代价</div>
          <div className="value small">{fmt(s.median)}</div>
        </div>
        <div className="stat">
          <div className="label">2.5% – 97.5%</div>
          <div className="value small">{fmt(s.q025)} – {fmt(s.q975)}</div>
        </div>
        <div className="stat">
          <div className="label">有效重复</div>
          <div className="value small">{resample.validReplicates}/{resample.replicatesDone}</div>
        </div>
      </div>
      {resample.mode === 'reoptimised' && resample.topologySummary ? (
        <div style={{ marginBottom: 8 }}>
          <div className="small muted" style={{ marginBottom: 4 }}>各拓扑在重复中取得最优的次数：</div>
          {resample.topologySummary.slice(0, 6).map((t) => (
            <div key={t.signature} style={{ marginBottom: 4 }}>
              <div className="small mono" style={{ overflowWrap: 'anywhere' }}>{t.signature}</div>
              <div className="bar-mini"><span style={{ width: `${Math.round(t.share * 100)}%` }} /></div>
              <div className="small muted">{t.count} 次 · {Math.round(t.share * 100)}%</div>
            </div>
          ))}
        </div>
      ) : null}
      {samples.length ? <Histogram samples={samples} /> : null}
      {resample.limited ? <div className="section-hint">已达到时间上限，重复次数被截断。</div> : null}
      {resample.reoptNote ? <div className="banner small" style={{ marginTop: 8 }}>{resample.reoptNote}</div> : null}
      <div className="section-hint">{resample.note}</div>
    </div>
  );
}

function Histogram({ samples }) {
  const min = Math.min(...samples);
  const max = Math.max(...samples);
  const bins = Math.min(14, Math.max(3, Math.round(Math.sqrt(samples.length))));
  const width = max - min || 1;
  const counts = new Array(bins).fill(0);
  for (const v of samples) {
    let b = Math.floor(((v - min) / width) * bins);
    if (b === bins) b = bins - 1;
    if (b < 0) b = 0;
    counts[b]++;
  }
  const maxCount = Math.max(...counts);
  const W = 520;
  const H = 130;
  const padL = 30;
  const padB = 24;
  const padT = 8;
  const bw = (W - padL - 8) / bins;
  return (
    <div className="dist-chart">
      <div className="small muted" style={{ marginBottom: 4 }}>重复的代价分布（{samples.length} 个有效样本）</div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="重采样代价分布">
        {[0, Math.ceil(maxCount / 2), maxCount].map((c, i) => {
          const y = H - padB - (c / Math.max(1, maxCount)) * (H - padB - padT);
          return (
            <g key={i}>
              <line className="grid-line" x1={padL} x2={W - 8} y1={y} y2={y} />
              <text className="tick" x={padL - 5} y={y + 3} textAnchor="end">{c}</text>
            </g>
          );
        })}
        {counts.map((c, i) => {
          const h = (c / Math.max(1, maxCount)) * (H - padB - padT);
          return (
            <rect
              key={i}
              x={padL + i * bw + 1}
              y={H - padB - h}
              width={Math.max(1, bw - 2)}
              height={h}
              rx={3}
              fill="var(--series-1)"
              opacity={0.85}
            />
          );
        })}
        <text className="tick" x={padL} y={H - 8}>{fmt(min)}</text>
        <text className="tick" x={W - 8} y={H - 8} textAnchor="end">{fmt(max)}</text>
        <line className="axis-line" x1={padL} x2={W - 8} y1={H - padB} y2={H - padB} />
      </svg>
    </div>
  );
}

export function CheckTreePanel({ check, onCheck, disabled, running }) {
  return (
    <div>
      <div className="small muted" style={{ marginBottom: 8 }}>
        把当前树形交给独立的计价与枚举核对，不经过产生它的搜索过程。
      </div>
      <button className="btn small" onClick={onCheck} disabled={disabled || running}>
        {running ? <span className="spin" /> : null} 核对当前树
      </button>
      {check ? <CheckView check={check} /> : null}
    </div>
  );
}

function CheckView({ check }) {
  if (!check.ok) {
    return <div className="diag error" style={{ marginTop: 10 }}><div>{check.message || '核对失败。'}</div></div>;
  }
  return (
    <div style={{ marginTop: 10 }}>
      <div className="kv">
        <dt>该树总代价</dt>
        <dd>{check.cost === null ? '无法定价' : fmt(check.cost)}</dd>
        <dt>锁定</dt>
        <dd>{check.allLocksHold ? '全部成立' : '有不成立的锁定'}</dd>
        {check.rank ? (
          <>
            <dt>枚举排名</dt>
            <dd>
              {check.rank.isOptimal ? '最优' : `比它便宜的有 ${check.rank.cheaperThanThis} 个`}
              （共 {check.rank.totalTopologies} 个树形，等代价 {check.rank.equalCost} 个）
            </dd>
            {check.rank.locked ? (
              <>
                <dt>同样锁定下</dt>
                <dd>
                  {check.rank.locked.infeasible ? (
                    '没有满足锁定的树形'
                  ) : (
                    <>
                      {check.rank.locked.isOptimal ? '最优' : `比它便宜的有 ${check.rank.locked.cheaperThanThis} 个`}
                      （共 {check.rank.locked.totalTopologies} 个树形，等代价 {check.rank.locked.equalCost} 个）
                    </>
                  )}
                </dd>
              </>
            ) : null}
          </>
        ) : null}
      </div>
      {check.message ? <div className="diag warning" style={{ marginTop: 8 }}><div>{check.message}</div></div> : null}
      {check.locks.map((l) => (
        <div key={l.id} className={`diag ${l.holds ? 'info' : 'error'}`} style={{ marginTop: 6 }}>
          <div>锁定 {l.id}：{l.holds ? '成立' : '不成立'}{l.trivial ? `（${l.reason}）` : ''}</div>
        </div>
      ))}
      {check.unpricedFeatures.length ? (
        <div className="diag error" style={{ marginTop: 6 }}>
          <div>{check.unpricedFeatures.map((u) => u.message).join(' ')}</div>
        </div>
      ) : null}
      <div className="section-hint">{check.note}</div>
      {check.rank ? (
        <div className="section-hint">
          枚举排名把当前树与全部 {check.rank.totalTopologies} 个有根树形比较；
          {check.rank.locked ? '“同样锁定下”只比较满足锁定约束的树形。' : '当前数据没有锁定约束。'}
        </div>
      ) : null}
    </div>
  );
}
