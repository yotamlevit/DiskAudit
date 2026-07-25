// Thin indirection over the Tauri IPC. In the real app this is a pass-through
// to @tauri-apps/api. In a plain browser during development (vite dev server
// without Tauri) it swaps in ./devMock so the whole UI can be exercised and
// visually tested with synthetic data. The mock is dev-only and never ships:
// production builds always run inside Tauri where the pass-through is used,
// and the dynamic import below is guarded by import.meta.env.DEV.

import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen, UnlistenFn } from "@tauri-apps/api/event";
import { open as tauriOpenDialog } from "@tauri-apps/plugin-dialog";

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
  };
}

export const invoke = ipc.invoke;
export const listen = ipc.listen;
export const openDialog = ipc.openDialog;
export const isMock = !hasTauri;
