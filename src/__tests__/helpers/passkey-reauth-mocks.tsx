// Shared `vi.mock()` stubs for the passkey-reauth UI components used by
// developer-settings credential-issuance cards. Import this module for its
// side effect -- `import "@/__tests__/helpers/passkey-reauth-mocks"` -- and the
// stubs register themselves.
//
// The calls sit at module scope rather than inside an exported setup function:
// vi.mock() nested in a function body is still hoisted, but Vitest warns that
// the source no longer reflects the execution order and will reject it in a
// future major.
//
// Per-file `mockCanUsePasskeyRecovery` and `mockReauthenticateWithPasskey`
// (the stateful `vi.hoisted()` factories) cannot move into a shared module
// because Vitest hoists `vi.hoisted` calls to each importing file's
// top-level scope and the closure cannot reach across files. Each consumer
// still wires those two with `vi.mock("@/lib/auth/webauthn/...")` locally.
import React from "react";
import { vi } from "vitest";

vi.mock("@/components/auth/passkey-reauth-dialog", () => ({
  PasskeyReauthDialog: ({
    open,
    onAction,
  }: {
    open: boolean;
    onAction: () => void | Promise<void>;
  }) =>
    open ? (
      <div data-testid="passkey-reauth-dialog">
        <button
          type="button"
          data-testid="passkey-reauth-action"
          onClick={() => void onAction()}
        >
          verify
        </button>
      </div>
    ) : null,
}));

vi.mock("@/components/auth/recent-session-required-dialog", () => ({
  RecentSessionRequiredDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="recent-session-dialog" /> : null,
}));

