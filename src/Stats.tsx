import type { ScanDone } from "./types";
import { formatBytes, formatNumber } from "./format";
import { CATEGORIES, colorForExt, isCategory, categorize } from "./categories";

interface StatsProps {
  summary: ScanDone;
}

export default function Stats({ summary }: StatsProps) {
  const { stats, allocated_bytes } = summary;
  const total = allocated_bytes || 1;

  return (
    <div className="stats-root">
      <section className="stats-section">
        <h3>By category</h3>
        <div className="cat-bar-list">
          {stats.by_category.map(({ category, count, size }) => {
            const pct = (size / total) * 100;
            const def = isCategory(category)
              ? CATEGORIES[category]
              : { label: category, color: "var(--fg-3)" };
            return (
              <div className="cat-bar-row" key={category}>
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
        {summary.hardlink_saved_bytes > 0 && (
          <div className="stats-note">
            {formatBytes(summary.hardlink_saved_bytes)} of hardlinked content
            counted once. Logical size of all files:{" "}
            {formatBytes(summary.logical_bytes)}.
          </div>
        )}
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
                  const pct = (e.size / total) * 100;
                  return (
                    <tr key={e.ext}>
                      <td>
                        <span
                          className="cat-bar-swatch"
                          style={{ background: colorForExt(e.ext) }}
                        />
                      </td>
                      <td className="mono">{e.ext ? `.${e.ext}` : "(none)"}</td>
                      <td className="num">{formatNumber(e.count)}</td>
                      <td className="num">{formatBytes(e.size)}</td>
                      <td className="num">{pct.toFixed(2)}%</td>
                    </tr>
                  );
                })}
                {stats.ext_other && (
                  <tr key="«other»" className="ext-other-row">
                    <td>
                      <span
                        className="cat-bar-swatch"
                        style={{ background: "var(--fg-3)" }}
                      />
                    </td>
                    <td>
                      {formatNumber(stats.ext_other.distinct)} more extensions
                    </td>
                    <td className="num">
                      {formatNumber(stats.ext_other.count)}
                    </td>
                    <td className="num">{formatBytes(stats.ext_other.size)}</td>
                    <td className="num">
                      {((stats.ext_other.size / total) * 100).toFixed(2)}%
                    </td>
                  </tr>
                )}
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
                          background:
                            CATEGORIES[categorize(f.name)].color,
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
