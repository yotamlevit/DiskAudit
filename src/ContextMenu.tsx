import { useEffect, useRef, useState } from "react";

/** Anything the context menu can act on. */
export interface MenuTarget {
  path: string;
  name: string;
  isDir: boolean;
}

export type MenuAction = "open" | "reveal" | "copy-path" | "copy-delete";

interface ContextMenuProps {
  x: number;
  y: number;
  target: MenuTarget;
  /** Offer "Open in map" (for directory rows outside the treemap). */
  canOpen?: boolean;
  onAction: (action: MenuAction, target: MenuTarget) => void;
  onClose: () => void;
}

const MENU_W = 260;

/** Right-click menu for files and folders. The delete action ONLY copies a
 * command for Terminal — the app itself can't delete anything. */
export default function ContextMenu({
  x,
  y,
  target,
  canOpen,
  onAction,
  onClose,
}: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(200);

  useEffect(() => {
    if (ref.current) setHeight(ref.current.offsetHeight);
  }, []);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", onClose);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  const safeX = Number.isFinite(x) ? x : 0;
  const safeY = Number.isFinite(y) ? y : 0;
  const left = Math.max(8, Math.min(safeX, window.innerWidth - MENU_W - 8));
  const top = Math.max(8, Math.min(safeY, window.innerHeight - height - 8));

  const act = (action: MenuAction) => {
    onAction(action, target);
    onClose();
  };

  return (
    <div
      className="ctx-menu"
      ref={ref}
      style={{ left, top }}
      role="menu"
      aria-label={`Actions for ${target.name}`}
    >
      <div className="ctx-title" title={target.path}>
        {target.name}
      </div>
      {canOpen && target.isDir && (
        <button className="ctx-item" role="menuitem" onClick={() => act("open")}>
          Show in Map
        </button>
      )}
      <button className="ctx-item" role="menuitem" onClick={() => act("reveal")}>
        Reveal in Finder
      </button>
      <button
        className="ctx-item"
        role="menuitem"
        onClick={() => act("copy-path")}
      >
        Copy Path
      </button>
      <div className="ctx-sep" />
      <button
        className="ctx-item ctx-danger"
        role="menuitem"
        onClick={() => act("copy-delete")}
      >
        Copy Delete Command
        <span className="ctx-subtext">
          Copies an <code>rm</code> command for Terminal. DiskAudit itself
          never deletes anything.
        </span>
      </button>
    </div>
  );
}
