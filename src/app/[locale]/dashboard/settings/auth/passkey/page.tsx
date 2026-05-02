"use client";

import { PasskeyCredentialsCard } from "@/components/settings/security/passkey-credentials-card";
import { MovedPageNotice } from "@/components/settings/moved-page-notice";

export default function PasskeyPage() {
  return (
    <>
      <MovedPageNotice section="auth" destinationPath="/dashboard/settings/auth/passkey" />
      <PasskeyCredentialsCard />
    </>
  );
}
