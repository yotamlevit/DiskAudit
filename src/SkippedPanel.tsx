import { useEffect } from "react";
import type { ScanDone, SkipReason } from "./types";
import { formatNumber } from "./format";

interface SkippedPanelProps {
  summary: ScanDone;
  onClose: () => void;
}

const REASON_INFO: Record<SkipReason, { label: string; why: string }> = {
  cloud_storage: {
    label: "Cloud storage",
    why: "Synced by iCloud/Dropbox/etc. Much of it may live only in the cloud, and reading it can trigger downloads or hang on the network — so it isn't scanned.",
  },
  other_volume: {
    label: "Different volume",
    why: "Lives on another disk or mount (external drive, network share, disk image). Its bytes don't occupy space on the scanned disk.",
  },
  firmlink_alias: {
    label: "Data volume alias",
    why: "macOS shows the Data volume's content at its usual places (/Users, /Applications, …). This mount point is skipped so nothing is counted twice.",
  },
};

/** What the scan deliberately left out, and why. */
export default function SkippedPanel({ summary, onClose }: SkippedPanelProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return (
    <div className="list-overlay" onClick={onClose}>
      <div
        className="list-panel"
        role="dialog"
        aria-label="Locations not scanned"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="list-header">
          <div className="list-title">
            <div className="list-title-name">Not scanned</div>
            <div className="list-title-path">
              {formatNumber(summary.skipped_total)} location
              {summary.skipped_total === 1 ? "" : "s"} deliberately left out
            </div>
          </div>
          <button className="btn btn-ghost" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="list-body skipped-body">
          {summary.skipped.length === 0 && (
            <p className="skipped-empty">
              Details are still being gathered — reopen this panel in a moment.
            </p>
          )}
          {(Object.keys(REASON_INFO) as SkipReason[]).map((reason) => {
            const entries = summary.skipped.filter((s) => s.reason === reason);
            if (entries.length === 0) return null;
            const info = REASON_INFO[reason];
            return (
              <section key={reason} className="skipped-group">
                <h4>
                  {info.label}
                  <span className="skipped-count">{entries.length}</span>
                </h4>
                <p className="skipped-why">{info.why}</p>
                <ul>
                  {entries.map((s) => (
                    <li key={s.path} className="mono">
                      {s.path}
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
          {summary.skipped_total > summary.skipped.length &&
            summary.skipped.length > 0 && (
              <p className="skipped-empty">
                …and{" "}
                {formatNumber(summary.skipped_total - summary.skipped.length)}{" "}
                more.
              </p>
            )}
        </div>
      </div>
    </div>
  );
}
