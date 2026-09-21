
/* Deterministic browser APIs for production UI primitives in jsdom. */

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

  const browserGetComputedStyle = window.getComputedStyle.bind(window);
  Object.defineProperty(window, "getComputedStyle", {
    configurable: true,
    value: (element: Element) => browserGetComputedStyle(element),
  });

  if (!HTMLElement.prototype.scrollTo) {
    HTMLElement.prototype.scrollTo = () => {};
  }
}
