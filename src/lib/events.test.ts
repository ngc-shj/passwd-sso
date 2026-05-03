// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  TEAM_DATA_CHANGED_EVENT,
  VAULT_DATA_CHANGED_EVENT,
  notifyTeamDataChanged,
  notifyVaultDataChanged,
} from "./events";

describe("events module", () => {
  describe("event name constants", () => {
    it("exports the team-data-changed event name", () => {
      expect(TEAM_DATA_CHANGED_EVENT).toBe("team-data-changed");
    });

    it("exports the vault-data-changed event name", () => {
      expect(VAULT_DATA_CHANGED_EVENT).toBe("vault-data-changed");
    });
  });

  describe("notifyTeamDataChanged", () => {
    beforeEach(() => {
      vi.restoreAllMocks();
    });

    it("dispatches a CustomEvent with the team-data-changed name on window", () => {
      const dispatched: Event[] = [];
      const spy = vi
        .spyOn(window, "dispatchEvent")
        .mockImplementation((evt: Event) => {
          dispatched.push(evt);
          return true;
        });

      notifyTeamDataChanged();

      expect(spy).toHaveBeenCalledTimes(1);
      expect(dispatched[0]).toBeInstanceOf(CustomEvent);
      expect(dispatched[0].type).toBe(TEAM_DATA_CHANGED_EVENT);
    });

    it("can be observed by an event listener registered on window", () => {
      const handler = vi.fn();
      window.addEventListener(TEAM_DATA_CHANGED_EVENT, handler);

      notifyTeamDataChanged();

      expect(handler).toHaveBeenCalledTimes(1);
      window.removeEventListener(TEAM_DATA_CHANGED_EVENT, handler);
    });
  });

  describe("notifyVaultDataChanged", () => {
    beforeEach(() => {
      vi.restoreAllMocks();
    });

    it("dispatches a CustomEvent with the vault-data-changed name on window", () => {
      const dispatched: Event[] = [];
      vi.spyOn(window, "dispatchEvent").mockImplementation((evt: Event) => {
        dispatched.push(evt);
        return true;
      });

      notifyVaultDataChanged();

      expect(dispatched[0].type).toBe(VAULT_DATA_CHANGED_EVENT);
    });

    it("can be observed by an event listener registered on window", () => {
      const handler = vi.fn();
      window.addEventListener(VAULT_DATA_CHANGED_EVENT, handler);

      notifyVaultDataChanged();

      expect(handler).toHaveBeenCalledTimes(1);
      window.removeEventListener(VAULT_DATA_CHANGED_EVENT, handler);
    });
  });
});
