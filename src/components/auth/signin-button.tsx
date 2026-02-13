"use client";

import { signIn } from "next-auth/react";
import { useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";
import { useState } from "react";

interface SignInButtonProps {
  provider: string;
  label: string;
  icon: React.ReactNode;
}

export function SignInButton({
  provider,
  label,
  icon,
}: SignInButtonProps) {
  const searchParams = useSearchParams();
  const [loading, setLoading] = useState(false);

  const handleSignIn = async () => {
    setLoading(true);
    // Preserve callbackUrl set by proxy (e.g. ?ext_connect=1 survives SSO).
    // Validate to prevent open-redirect: relative paths or same-origin only.
    const raw = searchParams.get("callbackUrl");
    let callbackUrl = "/dashboard";
    if (raw) {
      if (raw.startsWith("/")) {
        callbackUrl = raw;
      } else {
        try {
          const url = new URL(raw);
          if (url.origin === window.location.origin) {
            callbackUrl = url.pathname + url.search;
          }
        } catch {
          // Malformed URL — use default
        }
      }
    }
    await signIn(provider, { callbackUrl });
  };

  return (
    <Button
      variant="outline"
      size="lg"
      className="w-full justify-start gap-3 h-12"
      onClick={handleSignIn}
      disabled={loading}
    >
      {loading ? <Loader2 className="h-5 w-5 animate-spin" /> : icon}
      {label}
    </Button>
  );
}
