// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

// Mock RepromptDialog to avoid heavy dependency chain (useVault, useTranslations, Radix)
vi.mock("@/components/passwords/reprompt-dialog", () => ({
  RepromptDialog: () => null,
}));

import { useReprompt } from "./use-reprompt";

describe("useReprompt hook behavior", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // --- requireVerification ---

  describe("requireVerification", () => {
    it("calls callback immediately when requireReprompt=false", () => {
      const { result } = renderHook(() => useReprompt());
      const cb = vi.fn();

      act(() => {
        result.current.requireVerification("e1", false, cb);
      });

      expect(cb).toHaveBeenCalledOnce();
      // No dialog
      expect(result.current.repromptDialog).toBeNull();
    });

    it("opens dialog when requireReprompt=true and cache is empty", () => {
      const { result } = renderHook(() => useReprompt());
      const cb = vi.fn();

      act(() => {
        result.current.requireVerification("e1", true, cb);
      });

      // Callback is NOT called yet
      expect(cb).not.toHaveBeenCalled();
      // Dialog is rendered
      expect(result.current.repromptDialog).not.toBeNull();
    });

    it("calls callback immediately when cache is valid (within 30s)", () => {
      const { result } = renderHook(() => useReprompt());
      const cb1 = vi.fn();
      const cb2 = vi.fn();

      // First call: triggers dialog
      act(() => {
        result.current.requireVerification("e1", true, cb1);
      });
      expect(cb1).not.toHaveBeenCalled();

      // Simulate verification via onVerified prop
      const dialogElement = result.current.repromptDialog as React.ReactElement;
      act(() => {
        (dialogElement.props as { onVerified: () => void }).onVerified();
      });
      expect(cb1).toHaveBeenCalledOnce();

      // Second call within 30s: cache hit, no dialog
      act(() => {
        result.current.requireVerification("e1", true, cb2);
      });
      expect(cb2).toHaveBeenCalledOnce();
      expect(result.current.repromptDialog).toBeNull();
    });

    it("requires re-verification after cache expires (30s+)", () => {
      const { result } = renderHook(() => useReprompt());
      const cb1 = vi.fn();

      // Trigger and verify
      act(() => {
        result.current.requireVerification("e1", true, cb1);
      });
      const dialogElement = result.current.repromptDialog as React.ReactElement;
      act(() => {
        (dialogElement.props as { onVerified: () => void }).onVerified();
      });
      expect(cb1).toHaveBeenCalledOnce();

      // Advance past TTL
      act(() => {
        vi.advanceTimersByTime(30_001);
      });

      const cb2 = vi.fn();
      act(() => {
        result.current.requireVerification("e1", true, cb2);
      });
      // Expired: dialog shown again
      expect(cb2).not.toHaveBeenCalled();
      expect(result.current.repromptDialog).not.toBeNull();
    });

    it("cache is entry-scoped: entry-A verification does not apply to entry-B", () => {
      const { result } = renderHook(() => useReprompt());
      const cb1 = vi.fn();

      // Verify entry-A
      act(() => {
        result.current.requireVerification("eA", true, cb1);
      });
      const dialogElement = result.current.repromptDialog as React.ReactElement;
      act(() => {
        (dialogElement.props as { onVerified: () => void }).onVerified();
      });
      expect(cb1).toHaveBeenCalledOnce();

      // entry-B requires its own verification
      const cb2 = vi.fn();
      act(() => {
        result.current.requireVerification("eB", true, cb2);
      });
      expect(cb2).not.toHaveBeenCalled();
      expect(result.current.repromptDialog).not.toBeNull();
    });

    it("cancel does not call callback", () => {
      const { result } = renderHook(() => useReprompt());
      const cb = vi.fn();

      act(() => {
        result.current.requireVerification("e1", true, cb);
      });

      const dialogElement = result.current.repromptDialog as React.ReactElement;
      act(() => {
        (dialogElement.props as { onCancel: () => void }).onCancel();
      });

      expect(cb).not.toHaveBeenCalled();
      expect(result.current.repromptDialog).toBeNull();
    });
  });

  // --- createGuardedGetter ---

  describe("createGuardedGetter", () => {
    it("resolves immediately when requireReprompt=false", async () => {
      const { result } = renderHook(() => useReprompt());

      const getter = result.current.createGuardedGetter("e1", false, () => "secret");
      const value = await getter();

      expect(value).toBe("secret");
      expect(result.current.repromptDialog).toBeNull();
    });

    it("opens dialog when requireReprompt=true and cache is empty", () => {
      const { result } = renderHook(() => useReprompt());

      let resolved = false;
      act(() => {
        const getter = result.current.createGuardedGetter("e1", true, () => "secret");
        getter().then(() => { resolved = true; });
      });

      expect(resolved).toBe(false);
      expect(result.current.repromptDialog).not.toBeNull();
    });

    it("resolves after verification", async () => {
      const { result } = renderHook(() => useReprompt());

      let resolvedValue: string | undefined;
      act(() => {
        const getter = result.current.createGuardedGetter("e1", true, () => "secret");
        getter().then((v) => { resolvedValue = v; });
      });

      // Verify
      const dialogElement = result.current.repromptDialog as React.ReactElement;
      await act(async () => {
        (dialogElement.props as { onVerified: () => void }).onVerified();
      });

      expect(resolvedValue).toBe("secret");
    });

    it("rejects on cancel", async () => {
      const { result } = renderHook(() => useReprompt());

      let rejected = false;
      act(() => {
        const getter = result.current.createGuardedGetter("e1", true, () => "secret");
        getter().catch(() => { rejected = true; });
      });

      await act(async () => {
        const dialogElement = result.current.repromptDialog as React.ReactElement;
        (dialogElement.props as { onCancel: () => void }).onCancel();
      });

      expect(rejected).toBe(true);
    });

    it("resolves immediately when cache is valid", async () => {
      const { result } = renderHook(() => useReprompt());

      // First: verify via requireVerification
      act(() => {
        result.current.requireVerification("e1", true, () => {});
      });
      const dialogElement = result.current.repromptDialog as React.ReactElement;
      act(() => {
        (dialogElement.props as { onVerified: () => void }).onVerified();
      });

      // Now createGuardedGetter should resolve immediately
      const getter = result.current.createGuardedGetter("e1", true, () => "cached-secret");
      const value = await getter();

      expect(value).toBe("cached-secret");
      expect(result.current.repromptDialog).toBeNull();
    });
  });
});
