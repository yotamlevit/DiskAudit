import { useMemo } from "react";
import type { ScanResult } from "./types";
import { formatBytes, formatNumber } from "./format";
import { CATEGORIES, categoryForExt, colorForExt, Category } from "./categories";

interface StatsProps {
  result: ScanResult;
}

export default function Stats({ result }: StatsProps) {
  const { stats, total_bytes } = result;

  // Aggregate by category from the per-extension stats.
  const byCategory = useMemo(() => {
    const m = new Map<Category, { count: number; size: number }>();
    for (const e of stats.by_extension) {
      const cat = categoryForExt(e.ext);
      const cur = m.get(cat) ?? { count: 0, size: 0 };
      cur.count += e.count;
      cur.size += e.size;
      m.set(cat, cur);
    }
    return Array.from(m.entries())
      .map(([cat, v]) => ({ cat, ...v }))
      .sort((a, b) => b.size - a.size);
  }, [stats]);

  const totalShown = total_bytes || 1;

  return (
    <div className="stats-root">
      <section className="stats-section">
        <h3>By category</h3>
        <div className="cat-bar-list">
          {byCategory.map(({ cat, count, size }) => {
            const pct = (size / totalShown) * 100;
            const def = CATEGORIES[cat];
            return (
              <div className="cat-bar-row" key={cat}>
                <div className="cat-bar-meta">
                  <span
                    className="cat-bar-swatch"
                    style={{ background: def.color }}
                  />
                  <span className="cat-bar-label">{def.label}</span>
                </div>
                <div className="cat-bar-track">
                  <div
                    className="cat-bar-fill"
                    style={{
                      width: `${Math.max(0.5, pct)}%`,
                      background: def.color,
                    }}
                  />
                </div>
                <div className="cat-bar-numbers">
                  <span className="cat-bar-size">{formatBytes(size)}</span>
                  <span className="cat-bar-pct">{pct.toFixed(1)}%</span>
                  <span className="cat-bar-count">
                    {formatNumber(count)} files
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <div className="stats-grid">
        <section className="stats-section">
          <h3>By extension</h3>
          <div className="ext-table-wrap">
            <table className="ext-table">
              <thead>
                <tr>
                  <th></th>
                  <th>Extension</th>
                  <th className="num">Files</th>
                  <th className="num">Size</th>
                  <th className="num">% of total</th>
                </tr>
              </thead>
              <tbody>
                {stats.by_extension.map((e) => {
                  const pct = (e.size / totalShown) * 100;
                  return (
                    <tr key={e.ext}>
                      <td>
                        <span
                          className="cat-bar-swatch"
                          style={{ background: colorForExt(e.ext) }}
                        />
                      </td>
                      <td className="mono">
                        {e.ext ? `.${e.ext}` : "(none)"}
                      </td>
                      <td className="num">{formatNumber(e.count)}</td>
                      <td className="num">{formatBytes(e.size)}</td>
                      <td className="num">{pct.toFixed(2)}%</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        <section className="stats-section">
          <h3>Largest files</h3>
          <div className="ext-table-wrap">
            <table className="ext-table">
              <thead>
                <tr>
                  <th></th>
                  <th>Name</th>
                  <th className="num">Size</th>
                </tr>
              </thead>
              <tbody>
                {stats.top_files.map((f, i) => (
                  <tr key={f.path + ":" + i}>
                    <td>
                      <span
                        className="cat-bar-swatch"
                        style={{
                          background: colorForExt(extOf(f.name)),
                        }}
                      />
                    </td>
                    <td className="ellip" title={f.path}>
                      <div className="topfile-name">{f.name}</div>
                      <div className="topfile-path">{f.path}</div>
                    </td>
                    <td className="num">{formatBytes(f.size)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  );
}

function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  if (i <= 0 || i === name.length - 1) return "";
  return name.slice(i + 1).toLowerCase();
}
