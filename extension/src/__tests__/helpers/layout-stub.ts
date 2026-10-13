// Global test setup: a stand-in layout for jsdom, which has none (every rect
// is 0×0, clientWidth/clientHeight are 0, and there is no checkVisibility).
// isFieldVisible denies a zero rect by design, so without this every field in
// every jsdom test would read as hidden.
//
// - Every element's rect defaults to 100×20 at (10, 10). An element overrides
//   it with `data-rect="w,h,x,y"`, resolved at call time so it survives an
//   `innerHTML` rebuild and reaches the injected direct-autofill twin.
// - clientWidth / clientHeight follow the rect; scrollLeft / scrollTop come from
//   `data-scroll="x,y"` (default 0).
// - Content of a closed <details> (other than its <summary>) is unrendered in a
//   browser: a zero rect, and checkVisibility() false.
// - checkVisibility({ opacityProperty }) is also false when the element or an
//   ancestor has computed opacity 0, as Chrome's is.
// - setCheckVisibility() replaces or removes checkVisibility for one test; it is
//   restored after each test.
import { afterEach } from "vitest";

const DEFAULT_RECT = { width: 100, height: 20, x: 10, y: 10 };

type CheckVisibility = (this: HTMLElement, opts?: { opacityProperty?: boolean }) => boolean;

function inClosedDetails(el: Element): boolean {
  const details = el.closest("details:not([open])");
  if (!details || details === el) return false;
  const summary = details.querySelector(":scope > summary");
  return !(summary && (summary === el || summary.contains(el)));
}

function layoutOf(el: Element): { width: number; height: number; x: number; y: number } {
  if (inClosedDetails(el)) return { width: 0, height: 0, x: 0, y: 0 };
  const spec = el.getAttribute("data-rect");
  if (!spec) return DEFAULT_RECT;
  const [width, height, x, y] = spec.split(",").map((part) => Number(part.trim()));
  return { width, height, x: x ?? 0, y: y ?? 0 };
}

const defaultCheckVisibility: CheckVisibility = function (opts) {
  if (inClosedDetails(this)) return false;
  if (opts?.opacityProperty) {
    for (let node: Element | null = this; node; node = node.parentElement) {
      if (getComputedStyle(node).opacity === "0") return false;
    }
  }
  return true;
};

let checkVisibility: CheckVisibility | undefined = defaultCheckVisibility;

/** Replace (or, with undefined, remove) checkVisibility for the current test. */
export function setCheckVisibility(fn: CheckVisibility | undefined): void {
  checkVisibility = fn;
}

if (typeof Element !== "undefined") {
  Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
    const { width, height, x, y } = layoutOf(this);
    return {
      x,
      y,
      width,
      height,
      left: x,
      top: y,
      right: x + width,
      bottom: y + height,
      toJSON() {
        return this;
      },
    } as DOMRect;
  };
  Object.defineProperty(Element.prototype, "clientWidth", {
    configurable: true,
    get(this: Element) {
      return layoutOf(this).width;
    },
  });
  Object.defineProperty(Element.prototype, "clientHeight", {
    configurable: true,
    get(this: Element) {
      return layoutOf(this).height;
    },
  });
  const scrollOf = (el: Element, axis: 0 | 1): number => {
    const spec = el.getAttribute("data-scroll");
    return spec ? Number(spec.split(",")[axis]?.trim() ?? 0) : 0;
  };
  Object.defineProperty(Element.prototype, "scrollLeft", {
    configurable: true,
    get(this: Element) {
      return scrollOf(this, 0);
    },
  });
  Object.defineProperty(Element.prototype, "scrollTop", {
    configurable: true,
    get(this: Element) {
      return scrollOf(this, 1);
    },
  });
  Object.defineProperty(HTMLElement.prototype, "checkVisibility", {
    configurable: true,
    get() {
      return checkVisibility;
    },
  });
  afterEach(() => {
    checkVisibility = defaultCheckVisibility;
  });
}
