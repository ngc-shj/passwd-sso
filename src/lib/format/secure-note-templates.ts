export interface SecureNoteTemplate {
  id: string;
  titleKey: string;
  contentTemplate: string;
}

export const SECURE_NOTE_TEMPLATES: readonly SecureNoteTemplate[] = [
  {
    id: "blank",
    titleKey: "template_blank",
    contentTemplate: "",
  },
  {
    id: "wifi",
    titleKey: "template_wifi",
    contentTemplate: [
      "Network: ",
      "Password: ",
      "Security: WPA2/WPA3",
      "Hidden: No",
    ].join("\n"),
  },
  {
    id: "api_key",
    titleKey: "template_apiKey",
    contentTemplate: [
      "Service: ",
      "API Key: ",
      "Secret: ",
      "Base URL: ",
      "Docs: ",
    ].join("\n"),
  },
  {
    id: "server",
    titleKey: "template_server",
    contentTemplate: [
      "Host: ",
      "Port: 22",
      "Username: ",
      "Auth: SSH Key / Password",
      "Notes: ",
    ].join("\n"),
  },
  {
    id: "recovery_codes",
    titleKey: "template_recoveryCodes",
    contentTemplate: [
      "Service: ",
      "Date Generated: ",
      "",
      "Recovery Codes:",
      "1. ",
      "2. ",
      "3. ",
      "4. ",
      "5. ",
      "6. ",
      "7. ",
      "8. ",
    ].join("\n"),
  },
  {
    id: "meeting",
    titleKey: "template_meeting",
    contentTemplate: [
      "Date: ",
      "Platform: Zoom / Teams / Meet",
      "Meeting URL: ",
      "Meeting ID: ",
      "Passcode: ",
    ].join("\n"),
  },
] as const;
