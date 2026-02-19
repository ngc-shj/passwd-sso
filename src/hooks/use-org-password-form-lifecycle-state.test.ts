import { describe, expect, it } from "vitest";
import {
  applyOrgEditDataToForm,
  resetOrgFormForClose,
} from "@/hooks/use-org-password-form-lifecycle";
import { createOrgPasswordFormLifecycleSettersMock } from "@/test-utils/org-password-form-setters";

function createSetters() {
  return createOrgPasswordFormLifecycleSettersMock();
}

describe("use-org-password-form-lifecycle state helpers", () => {
  it("applyOrgEditDataToForm applies incoming edit values", () => {
    const setters = createSetters();

    applyOrgEditDataToForm(
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
        orgFolderId: "folder-1",
      },
      setters,
    );

    expect(setters.setTitle).toHaveBeenCalledWith("Title");
    expect(setters.setUsername).toHaveBeenCalledWith("user@example.com");
    expect(setters.setPassword).toHaveBeenCalledWith("pw");
    expect(setters.setContent).toHaveBeenCalledWith("content");
    expect(setters.setBrand).toHaveBeenCalledWith("Visa");
    expect(setters.setBrandSource).toHaveBeenCalledWith("manual");
    expect(setters.setOrgFolderId).toHaveBeenCalledWith("folder-1");
    expect(setters.setShowTotpInput).toHaveBeenCalledWith(false);
  });

  it("resetOrgFormForClose resets all mutable UI states", () => {
    const setters = createSetters();

    resetOrgFormForClose(setters);

    expect(setters.setTitle).toHaveBeenCalledWith("");
    expect(setters.setUsername).toHaveBeenCalledWith("");
    expect(setters.setPassword).toHaveBeenCalledWith("");
    expect(setters.setShowPassword).toHaveBeenCalledWith(false);
    expect(setters.setShowGenerator).toHaveBeenCalledWith(false);
    expect(setters.setBrandSource).toHaveBeenCalledWith("auto");
    expect(setters.setOrgFolderId).toHaveBeenCalledWith(null);
    expect(setters.setAttachments).toHaveBeenCalledWith([]);
    expect(setters.setSaving).toHaveBeenCalledWith(false);
  });
});
