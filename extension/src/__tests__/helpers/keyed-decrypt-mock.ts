import type { Mock } from "vitest";

/**
 * Input-keyed decryptData mock, shared by the background-module test files
 * (issue #784). Positional mockResolvedValueOnce queues are forbidden for
 * decryptData in files that load background/index: UNLOCK_VAULT schedules a
 * fire-and-forget context-menu refresh (real 200 ms debounce) whose overview
 * decrypt would steal a positional slot under load. Keying the response on
 * the ciphertext makes the result independent of call interleaving.
 *
 * An unmapped ciphertext THROWS with the offending input named, so a
 * coverage gap fails loudly in the test that exposed it instead of
 * diverging silently (plan C1-I3). Callers must keep every ciphertext the
 * fire-and-forget consumer can request (the overview ciphertext) mapped in
 * the install() defaults so that consumer can never hit the miss path.
 */
export function createKeyedDecryptMock(decryptData: Mock): {
  install: (defaults: Record<string, string>) => void;
  set: (ciphertext: string, plaintext: string) => void;
} {
  let responses: Record<string, string> = {};
  return {
    /** Reset the map to `defaults` and (re)install the keyed implementation.
     * Call from beforeEach — vi.clearAllMocks() clears call history but not
     * implementations, so without the per-test reinstall a leftover keyed
     * entry from an earlier test would carry forward. */
    install(defaults: Record<string, string>): void {
      responses = { ...defaults };
      decryptData.mockImplementation(
        async (encrypted: { ciphertext: string }) => {
          const plaintext = responses[encrypted.ciphertext];
          if (plaintext === undefined) {
            throw new Error(
              `decryptData mock miss: no keyed response registered for ciphertext "${encrypted.ciphertext}"`,
            );
          }
          return plaintext;
        },
      );
    },
    /** Register the plaintext decryptData resolves to for a ciphertext. */
    set(ciphertext: string, plaintext: string): void {
      responses[ciphertext] = plaintext;
    },
  };
}
