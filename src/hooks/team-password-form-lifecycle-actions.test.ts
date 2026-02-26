import { describe, expect, it } from "vitest";
import {
  applyTeamEditDataToForm,
  resetTeamFormForClose,
} from "@/hooks/team-password-form-lifecycle-actions";
import { createTeamPasswordFormLifecycleSettersMock } from "@/test-utils/team-password-form-setters";

function createSetters() {
  return createTeamPasswordFormLifecycleSettersMock();
}

describe("team-password-form-lifecycle-actions", () => {
  it("applyTeamEditDataToForm applies incoming edit values", () => {
    const setters = createSetters();

    applyTeamEditDataToForm(
      {
        id: "entry-1",
        title: "Title",
        username: "user@example.com",
        password: "pw",
        content: "content",
        url: "https://example.com",
        notes: "notes",
        brand: "Visa",
        cardNumber: "4111111111111111",
        teamFolderId: "folder-1",
      },
      setters,
    );

    expect(setters.setTitle).toHaveBeenCalledWith("Title");
    expect(setters.setUsername).toHaveBeenCalledWith("user@example.com");
    expect(setters.setPassword).toHaveBeenCalledWith("pw");
    expect(setters.setContent).toHaveBeenCalledWith("content");
    expect(setters.setBrand).toHaveBeenCalledWith("Visa");
    expect(setters.setBrandSource).toHaveBeenCalledWith("manual");
    expect(setters.setTeamFolderId).toHaveBeenCalledWith("folder-1");
    expect(setters.setShowTotpInput).toHaveBeenCalledWith(false);
  });

  it("resetTeamFormForClose resets all mutable UI states", () => {
    const setters = createSetters();

    resetTeamFormForClose(setters);

    expect(setters.setTitle).toHaveBeenCalledWith("");
    expect(setters.setUsername).toHaveBeenCalledWith("");
    expect(setters.setPassword).toHaveBeenCalledWith("");
    expect(setters.setShowPassword).toHaveBeenCalledWith(false);
    expect(setters.setShowGenerator).toHaveBeenCalledWith(false);
    expect(setters.setBrandSource).toHaveBeenCalledWith("auto");
    expect(setters.setTeamFolderId).toHaveBeenCalledWith(null);
    expect(setters.setAttachments).toHaveBeenCalledWith([]);
    expect(setters.setSaving).toHaveBeenCalledWith(false);
  });
});
