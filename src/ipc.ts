// Thin indirection over the Tauri IPC. In the real app this is a pass-through
// to @tauri-apps/api. In a plain browser during development (vite dev server
// without Tauri) it swaps in ./devMock so the whole UI can be exercised and
// visually tested with synthetic data. The mock is dev-only and never ships:
// production builds always run inside Tauri where the pass-through is used,
// and the dynamic import below is guarded by import.meta.env.DEV.

import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen, UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as tauriOpenDialog } from "@tauri-apps/plugin-dialog";
import { revealItemInDir, openUrl } from "@tauri-apps/plugin-opener";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";

export type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
export type ListenFn = <T>(
  event: string,
  handler: (event: { payload: T }) => void
) => Promise<UnlistenFn>;
export type OpenDialogFn = () => Promise<string | null>;

interface Ipc {
  invoke: InvokeFn;
  listen: ListenFn;
  openDialog: OpenDialogFn;
  /** Open the enclosing folder in Finder with the item selected. */
  revealItem: (path: string) => Promise<void>;
  /** Put text on the clipboard (write-only; the app never reads it). */
  copyText: (text: string) => Promise<void>;
  /** Deep-link to System Settings → Privacy & Security → Full Disk Access. */
  openFdaSettings: () => Promise<void>;
  /** Native drag-and-drop of Finder items onto the window. */
  onDragDrop: (handlers: {
    onDrop: (paths: string[]) => void;
    onEnter?: () => void;
    onLeave?: () => void;
  }) => Promise<UnlistenFn>;
}

const hasTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

let ipc: Ipc;
if (!hasTauri && import.meta.env.DEV) {
  ipc = (await import("./devMock")).mockIpc;
} else {
  ipc = {
    invoke: (cmd, args) => tauriInvoke(cmd, args),
    listen: (event, handler) => tauriListen(event, handler),
    openDialog: async () => {
      const sel = await tauriOpenDialog({ directory: true, multiple: false });
      return typeof sel === "string" ? sel : null;
    },
    revealItem: (path) => revealItemInDir(path),
    copyText: (text) => writeText(text),
    openFdaSettings: () =>
      openUrl(
        "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"
      ),
    onDragDrop: (handlers) =>
      getCurrentWebview().onDragDropEvent((event) => {
        const p = event.payload;
        if (p.type === "drop" && p.paths.length > 0) {
          handlers.onDrop(p.paths);
        } else if (p.type === "enter" || p.type === "over") {
          handlers.onEnter?.();
        } else if (p.type === "leave") {
          handlers.onLeave?.();
        }
      }),
  };
}

export const invoke = ipc.invoke;
export const listen = ipc.listen;
export const openDialog = ipc.openDialog;
export const revealItem = ipc.revealItem;
export const copyText = ipc.copyText;
export const openFdaSettings = ipc.openFdaSettings;
export const onDragDrop = ipc.onDragDrop;
export const isMock = !hasTauri;
