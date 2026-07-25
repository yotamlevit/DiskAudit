import { useMemo, useRef, useState, useEffect, useCallback } from "react";
import {
  hierarchy,
  treemap,
  treemapSquarify,
  HierarchyRectangularNode,
} from "d3-hierarchy";
import type { TreeNode } from "./types";
import { formatBytes } from "./format";
import { categorize, CATEGORIES, categoryColor } from "./categories";

interface TreemapProps {
  root: TreeNode;
  onDrillDown: (node: TreeNode) => void;
}

interface TooltipState {
  visible: boolean;
  x: number;
  y: number;
  node: TreeNode | null;
}

const HEADER_HEIGHT = 18;
const MIN_LEAF_LABEL_W = 50;
const MIN_LEAF_LABEL_H = 22;
// How many levels below the current root to render. Folders deeper than this
// still contribute to layout proportions, but their interiors aren't drawn.
// Click such a folder to re-root the treemap and see another 3 levels down.
const MAX_VIEW_DEPTH = 3;

export default function Treemap({ root, onDrillDown }: TreemapProps) {
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

    const h = hierarchy<TreeNode>(root, (d) => d.children)
      .sum((d) =>
        // Files contribute their size; folders contribute 0 (their value
        // comes from descendants).
        d.children && d.children.length > 0 ? 0 : d.size
      )
      .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));

    const t = treemap<TreeNode>()
      .tile(treemapSquarify.ratio(1.4))
      .size([size.width, size.height])
      // Reserve a header strip on every internal (folder) node so we can
      // render its name. The root itself doesn't need a header (the
      // breadcrumbs already show where you are).
      .paddingTop((d) => (d.depth === 0 ? 0 : HEADER_HEIGHT))
      .paddingInner(2)
      .paddingOuter(0)
      .round(true);

    return t(h);
  }, [root, size.width, size.height]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    setTooltip((t) =>
      t.visible ? { ...t, x: e.clientX + 14, y: e.clientY + 14 } : t
    );
  }, []);

  const handleEnter = (
    node: HierarchyRectangularNode<TreeNode>,
    e: React.MouseEvent
  ) => {
    setHoverPath(node.data.path);
    setTooltip({
      visible: true,
      x: e.clientX + 14,
      y: e.clientY + 14,
      node: node.data,
    });
  };

  const handleLeave = () => {
    setHoverPath(null);
    setTooltip((t) => ({ ...t, visible: false }));
  };

  const handleClick = (node: HierarchyRectangularNode<TreeNode>) => {
    if (node.data.aggregated) {
      onDrillDown(node.data);
      return;
    }
    if (node.data.is_dir && node.data.children && node.data.children.length > 0) {
      onDrillDown(node.data);
    }
  };

  // Render order: parents first (so leaves render on top). Cap at
  // MAX_VIEW_DEPTH levels below the current root — deeper nodes still
  // shape the layout (so proportions are honest) but their interiors
  // aren't drawn. Folders at the cap with hidden children below get a
  // "drill in" cue.
  const allNodes = layout
    ? layout
        .descendants()
        .filter((d) => d.depth >= 1 && d.depth <= MAX_VIEW_DEPTH)
        .sort((a, b) => a.depth - b.depth)
    : [];

  return (
    <div className="treemap-host" onMouseMove={handleMouseMove}>
      <div className="treemap-canvas" ref={containerRef}>
      {layout && (
        <svg
          width={size.width}
          height={size.height}
          className="treemap-svg"
          shapeRendering="crispEdges"
        >
          {allNodes.map((node) => {
            const w = node.x1 - node.x0;
            const h = node.y1 - node.y0;
            if (w < 1 || h < 1) return null;

            const isFolder = !!node.data.is_dir && !node.data.aggregated;
            const isAggregate = !!node.data.aggregated;
            const isExternal = !!node.data.external;
            const isLeaf = !node.data.is_dir;
            // Folder at the rendered cap that has more content below.
            const isCapped =
              isFolder &&
              node.depth === MAX_VIEW_DEPTH &&
              !!node.children &&
              node.children.length > 0;

            const value = node.value ?? node.data.size;

            // Fill
            let fill: string;
            if (isExternal) {
              fill = "rgba(80, 80, 80, 0.35)";
            } else if (isAggregate) {
              fill = "rgba(120, 95, 60, 0.5)";
            } else if (isCapped) {
              // Stronger, slightly warmer fill so capped folders read as
              // "click me to see what's inside".
              fill = "rgba(56, 102, 145, 0.55)";
            } else if (isFolder) {
              // Folder background: tinted by depth so nested folders read.
              const t = Math.min(0.55, 0.18 + node.depth * 0.07);
              fill = `rgba(30, 41, 59, ${t})`;
            } else {
              // Leaf: color by file type category.
              fill = categoryColor(node.data.name);
            }

            // Stroke
            const isHover = node.data.path === hoverPath;
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
            } else if (isFolder) {
              stroke = "rgba(120, 145, 180, 0.55)";
              strokeWidth = 1;
              strokeDash = undefined;
            } else {
              stroke = "rgba(0,0,0,0.45)";
              strokeWidth = 0.5;
              strokeDash = undefined;
            }

            return (
              <g
                key={node.data.path + ":" + node.depth}
                transform={`translate(${node.x0},${node.y0})`}
                onMouseEnter={(e) => handleEnter(node, e)}
                onMouseLeave={handleLeave}
                onClick={() => handleClick(node)}
                style={{
                  cursor:
                    isFolder || isAggregate ? "pointer" : "default",
                }}
              >
                <rect
                  width={w}
                  height={h}
                  fill={fill}
                  stroke={stroke}
                  strokeWidth={strokeWidth}
                  strokeDasharray={strokeDash}
                />
                {/* Folder header strip with name */}
                {isFolder && h > HEADER_HEIGHT + 2 && w > 30 && (
                  <>
                    <rect
                      width={w}
                      height={HEADER_HEIGHT}
                      fill="rgba(15, 23, 42, 0.65)"
                      pointerEvents="none"
                    />
                    <text
                      x={5}
                      y={12}
                      className="folder-label"
                      pointerEvents="none"
                    >
                      {truncate(node.data.name, Math.floor((w - 8) / 6))}
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
                {/* Drill-in cue for capped folders with hidden content */}
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
                      className="leaf-label-name"
                      pointerEvents="none"
                    >
                      {truncate(node.data.name, Math.floor(w / 6))}
                    </text>
                    {h >= 32 && (
                      <text
                        x={5}
                        y={26}
                        className="leaf-label-size"
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
      )}
      </div>

      {/* Legend (bottom strip) */}
      <div className="treemap-legend-strip">
        {Object.entries(CATEGORIES).map(([k, v]) => (
          <div className="legend-item" key={k} title={v.label}>
            <span
              className="legend-swatch"
              style={{ background: v.color }}
            />
            <span className="legend-label">{v.label}</span>
          </div>
        ))}
        <div className="legend-spacer" />
        <div className="legend-hint">
          <span className="legend-cap-cue">
            <svg width="14" height="14" viewBox="-7 -7 14 14">
              <circle r={6} fill="rgba(56, 189, 248, 0.18)" />
              <path
                d="M -2 -1 L 0 1.5 L 2 -1"
                fill="none"
                stroke="rgba(186, 230, 253, 0.95)"
                strokeWidth={1.4}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
          click to drill in
        </div>
      </div>

      {tooltip.visible && tooltip.node && (
        <div
          className="treemap-tooltip"
          style={{
            left: clamp(tooltip.x, 0, size.width - 320),
            top: clamp(tooltip.y, 0, size.height - 120),
          }}
        >
          <div className="tt-name">
            {!tooltip.node.is_dir && (
              <span
                className="tt-color-chip"
                style={{
                  background: categoryColor(tooltip.node.name),
                }}
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
            <span className="tt-label">Size</span>
            <span className="tt-value">{formatBytes(tooltip.node.size)}</span>
          </div>
          {!tooltip.node.is_dir && (
            <div className="tt-row">
              <span className="tt-label">Type</span>
              <span className="tt-value">
                {CATEGORIES[categorize(tooltip.node.name)].label}
              </span>
            </div>
          )}
          {tooltip.node.aggregated && (
            <div className="tt-row">
              <span className="tt-label">Files rolled up</span>
              <span className="tt-value">
                {tooltip.node.aggregated_count.toLocaleString()}
              </span>
            </div>
          )}
          {tooltip.node.is_dir && !tooltip.node.aggregated && (
            <div className="tt-row">
              <span className="tt-label">Contains</span>
              <span className="tt-value">
                {tooltip.node.file_count.toLocaleString()} files,{" "}
                {tooltip.node.dir_count.toLocaleString()} dirs
              </span>
            </div>
          )}
          {tooltip.node.is_dir && tooltip.node.error_count > 0 && (
            <div className="tt-row tt-warn">
              <span className="tt-label">Permission errors</span>
              <span className="tt-value">
                {tooltip.node.error_count.toLocaleString()}
              </span>
            </div>
          )}
          {tooltip.node.external && (
            <div className="tt-row tt-warn">
              <span className="tt-label">External</span>
              <span className="tt-value">cloud / mount — not on disk</span>
            </div>
          )}
          <div className="tt-hint">
            {tooltip.node.external
              ? "Skipped: bytes are not on local disk"
              : tooltip.node.aggregated
              ? "Click to expand the smaller files"
              : tooltip.node.is_dir &&
                tooltip.node.children &&
                tooltip.node.children.length > 0
              ? "Click to drill down"
              : "Leaf"}
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

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
