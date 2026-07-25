// jsdom lacks ResizeObserver, which the treemap uses to track its canvas.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

if (typeof globalThis.ResizeObserver === "undefined") {
  (globalThis as Record<string, unknown>).ResizeObserver = ResizeObserverStub;
}
