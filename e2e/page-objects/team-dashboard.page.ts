import type { Page } from "@playwright/test";

export class TeamDashboardPage {
  constructor(private page: Page) {}

  get newItemButton() {
    return this.page.getByRole("button", { name: /New Item|新規アイテム/i });
  }

  get newPasswordOption() {
    return this.page.getByRole("menuitem", { name: /New Password|新規パスワード/i });
  }

  get membersTab() {
    // Top-level "Members" / "メンバー" tab (exact match to avoid matching "Add Member" / "メンバー追加")
    return this.page.getByRole("tab", { name: /^Members$|^メンバー$/i });
  }

  get settingsTab() {
    return this.page.getByRole("tab", { name: /General|一般設定/i });
  }

  get policyTab() {
    return this.page.getByRole("tab", { name: /Security Policy|セキュリティポリシー/i });
  }

  get addMemberTab() {
    // t("addMember") = "Add Member" (en) / "メンバー追加" (ja)
    return this.page.getByRole("tab", { name: /Add Member|メンバー追加/i });
  }

  get inviteEmailInput() {
    // Email input in the "Invite by email" section on the settings page
    return this.page.locator('input[type="email"]').last();
  }

  get inviteRoleSelect() {
    // Role selector next to the invite email input
    return this.page.getByRole("combobox").last();
  }

  get inviteSendButton() {
    return this.page.getByRole("button", { name: /Send Invitation|招待を送信/i });
  }

  /**
   * Open the new team entry dropdown and select "New Password".
   * Waits for the dialog to appear.
   */
  async createNewPassword(): Promise<void> {
    await this.newItemButton.click();
    await this.newPasswordOption.click();
    await this.page.locator("[role='dialog']").waitFor({ timeout: 5_000 });
  }

  /**
   * Navigate to a named tab on the team settings page.
   * Valid values: "passwords" | "members" | "settings" | "policy" | "webhook"
   */
  async switchTab(tab: "members" | "settings" | "policy" | "webhook"): Promise<void> {
    const tabMap: Record<string, () => Promise<void>> = {
      members: async () => { await this.page.getByRole("tab", { name: /Members|メンバー/i }).click(); },
      settings: async () => { await this.page.getByRole("tab", { name: /General|一般設定/i }).click(); },
      policy: async () => { await this.page.getByRole("tab", { name: /Security Policy|セキュリティポリシー/i }).click(); },
      webhook: async () => { await this.page.getByRole("tab", { name: /Webhook/i }).click(); },
    };
    await tabMap[tab]();
  }

  /**
   * Send an email invitation to a new team member.
   * Navigates to the "Members" top-level tab, then the "Add Member" sub-tab,
   * fills the email, optionally selects a role, and submits.
   */
  async inviteMember(email: string, role?: string): Promise<void> {
    // First click the "Members" top-level tab to make sub-tabs visible
    await this.membersTab.click();
    // Then click the nested "Add Member" sub-tab
    await this.addMemberTab.click();

    // Scroll to the invite-by-email section
    const emailInput = this.page.locator('input[type="email"]');
    await emailInput.fill(email);

    if (role) {
      // The invite role select is the last combobox in the add-member tab
      const roleSelect = this.page
        .getByRole("tabpanel", { name: /Add Member|メンバー追加/i })
        .getByRole("combobox")
        .last();
      await roleSelect.click();
      await this.page.getByRole("option", { name: new RegExp(role, "i") }).click();
    }

    await this.inviteSendButton.click();
  }
}
