"use client";

import { signIn } from "next-auth/react";
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
  const [loading, setLoading] = useState(false);

  const handleSignIn = async () => {
    setLoading(true);
    await signIn(provider, { callbackUrl: "/dashboard" });
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
