/**
 * Gives a window a stand-in for the ResizeObserver that jsdom does not have:
 * each observer that the window makes, the elements that it observes, and
 * whether it is still connected. `report` runs the callbacks of those
 * connected, as a window does once its layout has changed sizes.
 */
export function resizeObservers(win: Window) {
  const observers: { observed: Element[]; connected: boolean; callback: () => void }[] = [];
  class ResizeObserver {
    private readonly record;
    constructor(callback: () => void) {
      this.record = { observed: [] as Element[], connected: true, callback };
      observers.push(this.record);
    }
    observe(element: Element): void {
      this.record.observed.push(element);
    }
    disconnect(): void {
      this.record.connected = false;
    }
  }
  Object.defineProperty(win, "ResizeObserver", { configurable: true, value: ResizeObserver });
  const report = (): void => {
    for (const observer of observers) if (observer.connected) observer.callback();
  };
  return { observers, report };
}
