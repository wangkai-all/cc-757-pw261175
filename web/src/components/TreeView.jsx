import React, { useMemo, useRef, useState } from 'react';
import { fmt, MISSING_LABEL } from '../lib.js';

/**
 * Rectangular dendrogram-style layout of a rooted binary tree.
 * Leaves sit on the right, root on the left; y is leaf order.
 */

function layout(annotation) {
  if (!annotation) return null;
  const { root, nodes, edges } = annotation;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const leafNodes = nodes.filter((n) => n.kind === 'leaf');
  const order = [];
  const y = new Map();
  // assign y for leaves first then internals
  const leafIndex = new Map();
  leafNodes.forEach((n, i) => leafIndex.set(n.id, i));
  const setY = (node) => {
    if (node.kind === 'leaf') {
      y.set(node.id, leafIndex.get(node.id));
      return y.get(node.id);
    }
    const vals = node.children.map(setY);
    const mid = (Math.min(...vals) + Math.max(...vals)) / 2;
    y.set(node.id, mid);
    return mid;
  };
  setY(root);
  order.length = 0;
  const collect = (n) => {
    if (n.kind === 'leaf') order.push(n);
    else n.children.forEach(collect);
  };
  collect(root);

  // x by depth
  const maxDepth = Math.max(...nodes.map((n) => n.depth));
  const x = (n) => n.depth;
  return { order, y, x, maxDepth, byId, leafNodes: order };
}

export default function TreeView({
  annotation,
  features,
  labels,
  locks = [],
  highlightFeature = null,
  selectedTaxon = null,
  onSelectTaxon,
  selectedEdge = null,
  onSelectEdge,
  statusNote,
}) {
  const [hover, setHover] = useState(null);
  const wrapRef = useRef(null);

  const geo = useMemo(() => layout(annotation), [annotation]);
  const dims = useMemo(() => {
    if (!geo) return null;
    const leaves = geo.leafNodes.length;
    const padL = 34;
    const padR = 168;
    const padT = 26;
    const padB = 30;
    const xStep = 92;
    const yStep = Math.max(34, Math.min(58, 460 / Math.max(1, leaves - 1) || 34));
    const width = padL + geo.maxDepth * xStep + padR;
    const height = padT + padB + Math.max(1, leaves - 1) * yStep;
    return { padL, padR, padT, padB, xStep, yStep, width, height };
  }, [geo]);

  if (!geo || !dims) {
    return (
      <div className="tree-empty">
        <div>
          <p>还没有可显示的树。</p>
          <p className="muted small" style={{ marginTop: 6 }}>
            在左侧选择虚构样例，然后按“求解”。求解结果会画在这里。
          </p>
        </div>
      </div>
    );
  }

  const px = (n) => dims.padL + n.depth * dims.xStep;
  const py = (n) => dims.padT + geo.y.get(n.id) * dims.yStep;

  // leaf state chips (state of the highlighted feature, if any)
  const featureIndex = highlightFeature ? features.findIndex((f) => f.id === highlightFeature) : -1;
  const feature = featureIndex >= 0 ? features[featureIndex] : null;

  const edgeById = new Map(annotation.edges.map((e) => [`${e.parentId}:${e.childId}`, e]));

  const changedFeatureCost = (edge) => {
    const info = edge.perFeature?.[highlightFeature];
    return info ? info.cost : null;
  };

  const renderEdge = (parent, child) => {
    const key = `${parent.id}:${child.id}`;
    const e = edgeById.get(key);
    const x1 = px(parent);
    const y1 = py(parent);
    const x2 = px(child);
    const y2 = py(child);
    const isChanged = highlightFeature
      ? (e?.perFeature?.[highlightFeature]?.cost ?? 0) > 0
      : false;
    const selected = selectedEdge === key;
    // rectangular: horizontal out of parent, vertical, horizontal into child
    const midX = x2 - dims.xStep * 0.42;
    const d = `M ${x1} ${y1} H ${midX} V ${y2} H ${x2}`;
    return (
      <g key={key} className="edge-group">
        <path className={`edge ${isChanged ? 'is-changed' : ''}`} d={d} style={selected ? { stroke: 'var(--accent)' } : undefined} />
        <path
          className="hit"
          d={d}
          onMouseEnter={(ev) => setHover({ kind: 'edge', edge: e, parent, child, x: ev.clientX, y: ev.clientY, key })}
          onMouseMove={(ev) => setHover((h) => (h && h.kind === 'edge' ? { ...h, x: ev.clientX, y: ev.clientY } : h))}
          onMouseLeave={() => setHover(null)}
          onClick={() => onSelectEdge && e && onSelectEdge(key)}
          tabIndex={-1}
        />
      </g>
    );
  };

  const renderNode = (node) => {
    if (node.kind === 'internal') {
      return (
        <g key={`n${node.id}`} className={hover?.node?.id === node.id ? 'hover-node' : ''}>
          <circle className={`node-dot ${node.parent === null ? 'root' : ''}`} cx={px(node)} cy={py(node)} r={node.parent === null ? 3.4 : 3} />
          <circle
            cx={px(node)}
            cy={py(node)}
            r={12}
            fill="transparent"
            onMouseEnter={(ev) => {
              setHover({ kind: 'node', node, x: ev.clientX, y: ev.clientY });
            }}
            onMouseLeave={() => setHover(null)}
          />
        </g>
      );
    }
    const isSelected = selectedTaxon === node.taxon;
    const value = feature ? featureStateOf(annotation, node, feature.id) : null;
    return (
      <g key={`leaf${node.id}`} style={{ cursor: 'pointer' }} onClick={() => onSelectTaxon && onSelectTaxon(node.taxon)}>
        <text
          x={px(node) + 10}
          y={py(node) + 4}
          className="leaf-label"
          style={isSelected ? { fill: 'var(--accent-ink)', fontWeight: 700 } : undefined}
        >
          {labels?.[node.taxon] || node.taxon}
        </text>
        {feature ? (
          <text x={px(node) + 10} y={py(node) + 18} className="leaf-state">
            {value === null ? MISSING_LABEL : `${feature.name}=${value}`}
            {value === null ? '（不参与状态标注）' : ''}
          </text>
        ) : null}
      </g>
    );
  };

  const segments = [];
  const walkEdges = (node) => {
    if (node.kind === 'leaf') return;
    for (const child of node.children) {
      segments.push(renderEdge(node, child));
      walkEdges(child);
    }
  };
  walkEdges(annotation.root);
  const nodeEls = [];
  const walkNodes = (node) => {
    nodeEls.push(renderNode(node));
    node.children.forEach(walkNodes);
  };
  walkNodes(annotation.root);

  const lockBrackets = computeLockBrackets(annotation, locks, px, py);

  return (
    <>
      <svg
        className="tree-canvas"
        viewBox={`0 0 ${dims.width} ${dims.height}`}
        width={dims.width}
        height={dims.height}
        role="img"
        aria-label="离散特征代价树"
        ref={wrapRef}
      >
        <g>{segments}</g>
        <g>{nodeEls}</g>
        <g>{lockBrackets}</g>
        <text
          x={px(annotation.root)}
          y={py(annotation.root) - 12}
          className="tick"
          textAnchor="middle"
          style={{ fontSize: 10.5 }}
        >
          根
        </text>
      </svg>
      {hover && (hover.kind === 'edge' || hover.kind === 'node') ? (
        <Tooltip
          hover={hover}
          features={features}
          labels={labels}
          annotation={annotation}
          highlightFeature={highlightFeature}
        />
      ) : null}
      {statusNote ? <div className="banner small" style={{ margin: '8px 14px 12px' }}>{statusNote}</div> : null}
    </>
  );
}

function featureStateOf(annotation, node, featureId) {
  const states = annotation.featureNodeStates?.[featureId];
  if (!states) return null;
  const s = states[node.id];
  return s === null || s === undefined ? null : s;
}

function computeLockBrackets(annotation, locks, px, py) {
  if (!locks || !locks.length) return [];
  const out = [];
  for (const lock of locks) {
    if (!lock.mask) continue;
    // the clade node whose mask equals the lock exactly
    const node = annotation.nodes.find((n) => n.kind === 'internal' && n.cladeMask === lock.mask);
    if (!node) continue;
    // collect the lock's leaves by walking the matched subtree
    const members = [];
    const walk = (n) => {
      if (n.kind === 'leaf') members.push(n);
      else n.children.forEach(walk);
    };
    walk(node);
    if (!members.length) continue;
    const ys = members.map((m) => py(m));
    const top = Math.min(...ys) - 11;
    const bottom = Math.max(...ys) + 11;
    const x = px(node) - 14;
    out.push(
      <g key={`lock-${lock.id}`}>
        <path
          className="clade-bracket locked-brace"
          d={`M ${x + 7} ${top} q -7 0 -7 7 V ${bottom - 7} q 0 7 7 7`}
          style={{ stroke: 'var(--series-2)' }}
        />
        <text x={x - 2} y={(top + bottom) / 2} className="clade-label" textAnchor="end" style={{ fill: 'var(--series-2)' }}>
          锁定 {lock.id}
        </text>
      </g>,
    );
  }
  return out;
}

function Tooltip({ hover, features, labels, annotation, highlightFeature }) {
  if (hover.kind === 'node') {
    const node = hover.node;
    const visible = features
      .map((f) => {
        const s = annotation.featureNodeStates?.[f.id]?.[node.id];
        return { f, s };
      })
      .filter((x) => x.s !== null && x.s !== undefined);
    return (
      <div className="tooltip" style={{ left: hover.x + 14, top: hover.y + 14, position: 'fixed' }}>
        <div className="tt-title">内部节点（深度 {node.depth}）</div>
        {visible.length ? (
          visible.map(({ f, s }) => (
            <div className="tt-row" key={f.id}>
              <span className="k">{f.name}</span>
              <span className="v">{f.states[s]}</span>
            </div>
          ))
        ) : (
          <div className="muted">没有可重建的状态</div>
        )}
        <div className="muted small" style={{ marginTop: 4 }}>
          这里的“状态”只是代价最小的一种重建，不代表祖先的真实形态。
        </div>
      </div>
    );
  }
  const { edge, parent, child } = hover;
  if (!edge) return null;
  return (
    <div className="tooltip" style={{ left: hover.x + 14, top: hover.y + 14, position: 'fixed' }}>
      <div className="tt-title">枝条代价</div>
      <div className="tt-row">
        <span className="k">合计</span>
        <span className="v">{fmt(edge.totalCost)}</span>
      </div>
      {features.map((f) => {
        const info = edge.perFeature?.[f.id];
        if (!info) return null;
        const emphasized = highlightFeature === f.id;
        if (info.missing) {
          return (
            <div className="tt-row" key={f.id}>
              <span className="k" style={emphasized ? { color: 'var(--accent-ink)' } : undefined}>
                {f.name}
              </span>
              <span className="v muted">未观测 · 0</span>
            </div>
          );
        }
        if ((info.cost ?? 0) === 0) return null;
        return (
          <div className="tt-row" key={f.id}>
            <span className="k" style={emphasized ? { color: 'var(--accent-ink)' } : undefined}>
              {f.name}
            </span>
            <span className="v">
              {info.from}→{info.to} · {fmt(info.cost)}
              {info.tie ? '（有并列状态）' : ''}
            </span>
          </div>
        );
      })}
      <div className="muted small" style={{ marginTop: 4 }}>
        点击枝条可在右侧查看该枝条各特征的代价明细。
      </div>
    </div>
  );
}
