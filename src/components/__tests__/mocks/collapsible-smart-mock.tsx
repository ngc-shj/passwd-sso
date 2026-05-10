// Smart Collapsible mock used by tests that render components wrapping
// `InactiveItemsSection` or other Radix Collapsible consumers.
//
// The factory pattern that previously rendered children unconditionally
// (`<>{children}</>`) masked the helper's `open` semantics — clicking the
// trigger appeared to work even when collapse logic was broken (a
// false-positive class flagged in unify-settings-page-layout-plan-review.md
// F-10 / F-18). This mock respects the controlled `open` prop while keeping
// uncontrolled `<Collapsible>` (no `open` prop) defaulted to OPEN — preserves
// the existing test behavior for accordion-style toggles whose tests assert
// content visibility without simulating click-to-expand.
//
// Usage (inside a test file's top-level mock block):
//
//   vi.mock("@/components/ui/collapsible", () => mockCollapsibleSmart());
//
// Caveat: vi.mock factories are hoisted and cannot reference module-scope
// values from the test file. This export is a factory function so the
// react import resolves at the time vi.mock evaluates the factory.

import type { ReactElement, ReactNode, MouseEvent } from "react";

type Ctx = { open: boolean; onOpenChange?: (open: boolean) => void };

export async function mockCollapsibleSmart() {
  const React = await import("react");
  const CollapsibleCtx = React.createContext<Ctx>({ open: true });

  function Collapsible({
    children,
    open,
    onOpenChange,
  }: {
    children: ReactNode;
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
  }) {
    const value: Ctx = {
      open: open === undefined ? true : open,
      onOpenChange,
    };
    return (
      <CollapsibleCtx.Provider value={value}>
        {children}
      </CollapsibleCtx.Provider>
    );
  }

  function CollapsibleContent({ children }: { children: ReactNode }) {
    const { open } = React.useContext(CollapsibleCtx);
    return open ? <>{children}</> : null;
  }

  function CollapsibleTrigger({
    children,
    asChild,
    className,
    onClick,
  }: {
    children: ReactNode;
    asChild?: boolean;
    className?: string;
    onClick?: (e: MouseEvent) => void;
  }) {
    const { open, onOpenChange } = React.useContext(CollapsibleCtx);
    const handleClick = (e: MouseEvent) => {
      onClick?.(e);
      onOpenChange?.(!open);
    };
    if (asChild) {
      const child = React.Children.only(children) as ReactElement<{
        onClick?: (e: MouseEvent) => void;
      }>;
      return React.cloneElement(child, {
        onClick: (e: MouseEvent) => {
          child.props.onClick?.(e);
          handleClick(e);
        },
      });
    }
    return (
      <button type="button" className={className} onClick={handleClick}>
        {children}
      </button>
    );
  }

  return { Collapsible, CollapsibleContent, CollapsibleTrigger };
}
