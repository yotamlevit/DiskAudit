import { useMemo, useRef, useState, useEffect, useCallback } from "react";
import {
  hierarchy,
  treemap,
  treemapSquarify,
  HierarchyRectangularNode,
} from "d3-hierarchy";
import type { SkipReason, ViewNode } from "./types";
import { formatBytes, formatNumber } from "./format";
import { categorize, CATEGORIES, categoryColor, Category } from "./categories";

export interface Highlight {
  path: string;
  ts: number;
}

interface TreemapProps {
  root: ViewNode;
  onDrillDown: (node: ViewNode) => void;
  highlight?: Highlight | null;
  onContext?: (
    target: { path: string; name: string; isDir: boolean },
    x: number,
    y: number
  ) => void;
}

interface TooltipState {
  visible: boolean;
  x: number;
  y: number;
  node: ViewNode | null;
}

const HEADER_HEIGHT = 18;
const MIN_LEAF_LABEL_W = 50;
const MIN_LEAF_LABEL_H = 22;
const TOOLTIP_W = 340;
const TOOLTIP_H = 170;

const SKIP_TOOLTIP: Record<SkipReason, string> = {
  cloud_storage:
    "Cloud-synced folder — skipped. Its content may not be on this disk.",
  other_volume: "Different volume — skipped, not part of this disk.",
  firmlink_alias:
    "System Data volume — its content is already counted at /Users, /Applications, etc.",
};

export default function Treemap({
  root,
  onDrillDown,
  highlight,
  onContext,
}: TreemapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 800, height: 600 });
  const [tooltip, setTooltip] = useState<TooltipState>({
    visible: false,
    x: 0,
    y: 0,
    node: null,
  });
  const [hoverPath, setHoverPath] = useState<string | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        setSize({
          width: Math.max(200, Math.floor(width)),
          height: Math.max(200, Math.floor(height)),
        });
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const layout = useMemo(() => {
    if (!root || !root.children || root.children.length === 0) return null;

    const h = hierarchy<ViewNode>(root, (d) => d.children)
      .sum((d) =>
        // Nodes without rendered children contribute their full size —
        // that includes files AND unexpanded folders (depth-capped,
        // budget-capped, skipped), so proportions stay honest.
        d.children && d.children.length > 0 ? 0 : d.size
      )
      .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));

    const t = treemap<ViewNode>()
      .tile(treemapSquarify.ratio(1.4))
      .size([size.width, size.height])
      // Header strip on internal (folder) nodes for their name; the current
      // root doesn't need one (breadcrumbs show where you are).
      .paddingTop((d) => (d.depth === 0 ? 0 : HEADER_HEIGHT))
      .paddingInner(2)
      .paddingOuter(0)
      .round(true);

    return t(h);
  }, [root, size.width, size.height]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    setTooltip((t) =>
      t.visible ? { ...t, x: e.clientX, y: e.clientY } : t
    );
  }, []);

  const handleEnter = (
    node: HierarchyRectangularNode<ViewNode>,
    e: React.MouseEvent
  ) => {
    setHoverPath(node.data.path);
    setTooltip({
      visible: true,
      x: e.clientX,
      y: e.clientY,
      node: node.data,
    });
  };

  const handleLeave = () => {
    setHoverPath(null);
    setTooltip((t) => ({ ...t, visible: false }));
  };

  const handleClick = (node: HierarchyRectangularNode<ViewNode>) => {
    if (node.data.aggregated) {
      onDrillDown(node.data);
      return;
    }
    if (node.data.is_dir && !node.data.skip_reason) {
      onDrillDown(node.data);
    }
  };

  // Parents render first so leaves draw on top of folder backgrounds.
  const allNodes = layout
    ? layout
        .descendants()
        .filter((d) => d.depth >= 1)
        .sort((a, b) => a.depth - b.depth)
    : [];

  // Legend: only what is actually on screen.
  const present = useMemo(() => {
    const cats = new Set<Category>();
    let hasAggregate = false;
    let hasSkipped = false;
    const visit = (n: ViewNode) => {
      if (n.aggregated) hasAggregate = true;
      else if (n.skip_reason) hasSkipped = true;
      else if (!n.is_dir) cats.add(categorize(n.name));
      n.children?.forEach(visit);
    };
    root.children?.forEach(visit);
    return { cats, hasAggregate, hasSkipped };
  }, [root]);

  // Tooltip position: fixed, clamped against the WINDOW (it renders in
  // viewport coordinates), flipping to the other side of the cursor near
  // the right/bottom edges.
  const ttLeft =
    tooltip.x + 14 + TOOLTIP_W > window.innerWidth
      ? Math.max(8, tooltip.x - 14 - TOOLTIP_W)
      : tooltip.x + 14;
  const ttTop =
    tooltip.y + 14 + TOOLTIP_H > window.innerHeight
      ? Math.max(8, tooltip.y - 14 - TOOLTIP_H)
      : tooltip.y + 14;

  return (
    <div className="treemap-host" onMouseMove={handleMouseMove}>
      <div className="treemap-canvas" ref={containerRef}>
        {layout ? (
          <svg
            width={size.width}
            height={size.height}
            className="treemap-svg"
            shapeRendering="crispEdges"
            role="group"
            aria-label={`Treemap of ${root.path}: ${formatBytes(root.size)} in ${
              root.children?.length ?? 0
            } top-level items`}
          >
            {allNodes.map((node) => {
              const w = node.x1 - node.x0;
              const h = node.y1 - node.y0;
              if (w < 1 || h < 1) return null;

              const d = node.data;
              const isAggregate = !!d.aggregated;
              const isSkipped = !!d.skip_reason;
              const isFolder = d.is_dir && !isAggregate;
              const isLeaf = !d.is_dir;
              const isCapped =
                isFolder &&
                !isSkipped &&
                !!d.has_hidden_children &&
                (!node.children || node.children.length === 0);

              const value = node.value ?? d.size;

              // Structural colors come from CSS variables so light mode
              // works; category colors are theme-independent.
              let fill: string;
              if (isSkipped) {
                fill = "var(--map-skip-bg)";
              } else if (isAggregate) {
                fill = "var(--map-agg-bg)";
              } else if (isCapped) {
                fill = "var(--map-capped-bg)";
              } else if (isFolder) {
                const t = Math.min(0.55, 0.18 + node.depth * 0.07);
                fill = `rgba(var(--map-folder-rgb), ${t})`;
              } else {
                fill = categoryColor(d.name);
              }

              const isHover = d.path === hoverPath;
              let stroke: string;
              let strokeWidth: number;
              let strokeDash: string | undefined;
              if (isHover) {
                stroke = "#7dd3fc";
                strokeWidth = 2;
                strokeDash = undefined;
              } else if (isAggregate) {
                stroke = "rgba(245, 158, 11, 0.55)";
                strokeWidth = 1;
                strokeDash = "4 3";
              } else if (isSkipped) {
                stroke = "rgba(148, 163, 184, 0.5)";
                strokeWidth = 1;
                strokeDash = "2 3";
              } else if (isFolder) {
                stroke = "rgba(120, 145, 180, 0.55)";
                strokeWidth = 1;
                strokeDash = undefined;
              } else {
                stroke = "rgba(0,0,0,0.45)";
                strokeWidth = 0.5;
                strokeDash = undefined;
              }

              const clickable = isAggregate || (isFolder && !isSkipped);

              return (
                <g
                  key={d.path + ":" + node.depth}
                  transform={`translate(${node.x0},${node.y0})`}
                  onMouseEnter={(e) => handleEnter(node, e)}
                  onMouseLeave={handleLeave}
                  onClick={() => handleClick(node)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (isAggregate) {
                      onDrillDown(d); // aggregate has no real path; list it
                    } else {
                      onContext?.(
                        { path: d.path, name: d.name, isDir: d.is_dir },
                        e.clientX,
                        e.clientY
                      );
                    }
                  }}
                  style={{ cursor: clickable ? "pointer" : "default" }}
                  role={clickable ? "button" : undefined}
                  aria-label={`${d.name}, ${formatBytes(value)}${
                    isAggregate
                      ? `, ${formatNumber(
                          d.aggregated_count ?? 0
                        )} smaller items, click to list`
                      : isFolder
                      ? ", folder, click to open"
                      : ""
                  }`}
                >
                  <rect
                    width={w}
                    height={h}
                    fill={fill}
                    stroke={stroke}
                    strokeWidth={strokeWidth}
                    strokeDasharray={strokeDash}
                  />
                  {highlight && d.path === highlight.path && (
                    <rect
                      key={highlight.ts}
                      width={w}
                      height={h}
                      className="highlight-flash"
                      pointerEvents="none"
                    />
                  )}
                  {/* Folder header strip */}
                  {isFolder && h > HEADER_HEIGHT + 2 && w > 30 && (
                    <>
                      <rect
                        width={w}
                        height={HEADER_HEIGHT}
                        fill="var(--map-header-bg)"
                        pointerEvents="none"
                      />
                      <text
                        x={5}
                        y={12}
                        className="folder-label"
                        pointerEvents="none"
                      >
                        {truncate(
                          isSkipped ? `${d.name} (skipped)` : d.name,
                          Math.floor((w - 8) / 6)
                        )}
                      </text>
                      {w >= 140 && (
                        <text
                          x={w - 5}
                          y={12}
                          textAnchor="end"
                          className="folder-size-label"
                          pointerEvents="none"
                        >
                          {formatBytes(value)}
                        </text>
                      )}
                    </>
                  )}
                  {/* Drill-in cue for folders with unrendered content */}
                  {isCapped && w >= 28 && h >= 28 && (
                    <g
                      transform={`translate(${w - 16}, ${h - 14})`}
                      pointerEvents="none"
                    >
                      <circle r={9} fill="rgba(56, 189, 248, 0.18)" />
                      <path
                        d="M -3 -2 L 0 2 L 3 -2"
                        fill="none"
                        stroke="rgba(186, 230, 253, 0.95)"
                        strokeWidth={1.6}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </g>
                  )}
                  {/* Leaf label */}
                  {isLeaf && w >= MIN_LEAF_LABEL_W && h >= MIN_LEAF_LABEL_H && (
                    <>
                      <text
                        x={5}
                        y={13}
                        className={
                          isAggregate ? "aggregate-label" : "leaf-label-name"
                        }
                        pointerEvents="none"
                      >
                        {truncate(d.name, Math.floor(w / 6))}
                      </text>
                      {h >= 32 && (
                        <text
                          x={5}
                          y={26}
                          className={
                            isAggregate ? "aggregate-label-size" : "leaf-label-size"
                          }
                          pointerEvents="none"
                        >
                          {formatBytes(value)}
                        </text>
                      )}
                    </>
                  )}
                </g>
              );
            })}
          </svg>
        ) : (
          <div className="treemap-empty">
            {root.size === 0 && !root.has_hidden_children
              ? "This folder is empty."
              : "Nothing to draw yet."}
          </div>
        )}
      </div>

      {/* Legend: categories present in this view only */}
      <div className="treemap-legend-strip">
        {(Object.keys(CATEGORIES) as Category[])
          .filter((k) => present.cats.has(k))
          .map((k) => (
            <div className="legend-item" key={k} title={CATEGORIES[k].label}>
              <span
                className="legend-swatch"
                style={{ background: CATEGORIES[k].color }}
              />
              <span className="legend-label">{CATEGORIES[k].label}</span>
            </div>
          ))}
        {present.hasAggregate && (
          <div className="legend-item" title="Smaller items, rolled up — click to list them">
            <span
              className="legend-swatch"
              style={{
                background: "rgba(120, 95, 60, 0.8)",
                outline: "1px dashed rgba(245, 158, 11, 0.8)",
              }}
            />
            <span className="legend-label">Smaller items (click to list)</span>
          </div>
        )}
        {present.hasSkipped && (
          <div className="legend-item" title="Not scanned: cloud storage or another volume">
            <span
              className="legend-swatch"
              style={{
                background: "rgba(120, 120, 135, 0.5)",
                outline: "1px dashed rgba(148, 163, 184, 0.8)",
              }}
            />
            <span className="legend-label">Skipped</span>
          </div>
        )}
      </div>

      {tooltip.visible && tooltip.node && (
        <div
          className="treemap-tooltip"
          style={{ left: ttLeft, top: ttTop }}
          role="tooltip"
        >
          <div className="tt-name">
            {!tooltip.node.is_dir && !tooltip.node.aggregated && (
              <span
                className="tt-color-chip"
                style={{ background: categoryColor(tooltip.node.name) }}
              />
            )}
            {tooltip.node.name}
          </div>
          {!tooltip.node.aggregated && (
            <div className="tt-path" title={tooltip.node.path}>
              {tooltip.node.path}
            </div>
          )}
          {tooltip.node.aggregated && tooltip.node.aggregated_parent && (
            <div className="tt-path" title={tooltip.node.aggregated_parent}>
              in {tooltip.node.aggregated_parent}
            </div>
          )}
          <div className="tt-row">
            <span className="tt-label">Size on disk</span>
            <span className="tt-value">{formatBytes(tooltip.node.size)}</span>
          </div>
          {!tooltip.node.is_dir && !tooltip.node.aggregated && (
            <div className="tt-row">
              <span className="tt-label">Type</span>
              <span className="tt-value">
                {tooltip.node.is_symlink
                  ? "Symlink (not followed)"
                  : CATEGORIES[categorize(tooltip.node.name)].label}
              </span>
            </div>
          )}
          {tooltip.node.aggregated && (
            <div className="tt-row">
              <span className="tt-label">Items rolled up</span>
              <span className="tt-value">
                {formatNumber(tooltip.node.aggregated_count ?? 0)}
              </span>
            </div>
          )}
          {tooltip.node.is_dir && !tooltip.node.skip_reason && (
            <div className="tt-row">
              <span className="tt-label">Contains</span>
              <span className="tt-value">
                {formatNumber(tooltip.node.file_count ?? 0)} files,{" "}
                {formatNumber(tooltip.node.dir_count ?? 0)} folders
              </span>
            </div>
          )}
          {(tooltip.node.error_count ?? 0) > 0 && (
            <div className="tt-row tt-warn">
              <span className="tt-label">Unreadable entries</span>
              <span className="tt-value">
                {formatNumber(tooltip.node.error_count ?? 0)}
              </span>
            </div>
          )}
          <div className="tt-hint">
            {tooltip.node.skip_reason
              ? SKIP_TOOLTIP[tooltip.node.skip_reason]
              : tooltip.node.aggregated
              ? "Click to list every item"
              : tooltip.node.is_dir
              ? "Click to open"
              : ""}
          </div>
        </div>
      )}
    </div>
  );
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  if (max <= 1) return "";
  return s.slice(0, Math.max(1, max - 1)) + "…";
}
