/* Browser APIs used by Ant Design's responsive and overlay primitives. Keep
   these deterministic so component tests exercise real providers in jsdom. */

if (typeof window !== "undefined") {
  if (!window.matchMedia) {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: (query: string): MediaQueryList => ({
        matches: false,
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
