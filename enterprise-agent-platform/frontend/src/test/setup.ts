/* Browser APIs jsdom lacks but the app uses (theme and reduced-motion queries, resize-driven scroll pinning). */

if (typeof window !== "undefined") {
  if (!window.matchMedia) {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: (query: string): MediaQueryList => ({
        matches: query === "(prefers-reduced-motion: reduce)",
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }),
    });
  }

  if (!("ResizeObserver" in window)) {
    class ResizeObserverStub implements ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    Object.defineProperty(window, "ResizeObserver", { configurable: true, value: ResizeObserverStub });
    Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: ResizeObserverStub });
  }

  if (!HTMLElement.prototype.scrollTo) {
    HTMLElement.prototype.scrollTo = () => {};
  }
}
