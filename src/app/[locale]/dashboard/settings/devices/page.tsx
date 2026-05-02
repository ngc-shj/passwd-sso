"use client";

import { SessionsCard } from "@/components/sessions/sessions-card";
import { MovedPageNotice } from "@/components/settings/moved-page-notice";

export default function DevicesPage() {
  return (
    <>
      <MovedPageNotice section="devices" destinationPath="/dashboard/settings/devices" />
      <SessionsCard />
    </>
  );
}
