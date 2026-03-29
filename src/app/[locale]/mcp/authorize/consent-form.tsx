"use client";

import { useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ShieldCheck, ShieldX, Loader2 } from "lucide-react";
import { useTranslations, useMessages } from "next-intl";
import { withBasePath } from "@/lib/url-helpers";


interface ConsentFormProps {
  clientName: string;
  clientId: string;
  isDcr: boolean;
  scopes: string[];
  redirectUri: string;
  state: string;
  codeChallenge: string;
  codeChallengeMethod: string;
}

export function ConsentForm({
  clientName,
  clientId,
  isDcr,
  scopes,
  redirectUri,
  state,
  codeChallenge,
  codeChallengeMethod,
}: ConsentFormProps) {
  const t = useTranslations("McpConsent");
  const messages = useMessages();
  const scopeDescriptions = (messages.McpConsent as Record<string, unknown>)?.scopeDescriptions as Record<string, string> | undefined;
  const [loading, setLoading] = useState(false);

  const handleAllow = () => {
    setLoading(true);
    const form = document.createElement("form");
    form.method = "POST";
    form.action = withBasePath("/api/mcp/authorize/consent");
    const fields: Record<string, string> = {
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: scopes.join(" "),
      code_challenge: codeChallenge,
      code_challenge_method: codeChallengeMethod,
      state,
    };
    for (const [key, value] of Object.entries(fields)) {
      const input = document.createElement("input");
      input.type = "hidden";
      input.name = key;
      input.value = value;
      form.appendChild(input);
    }
    document.body.appendChild(form);
    form.submit();
  };

  const handleDeny = () => {
    setLoading(true);
    const form = document.createElement("form");
    form.method = "POST";
    form.action = withBasePath("/api/mcp/authorize/consent");
    const fields = {
      action: "deny",
      client_id: clientId,
      redirect_uri: redirectUri,
      state,
    };
    for (const [key, value] of Object.entries(fields)) {
      const input = document.createElement("input");
      input.type = "hidden";
      input.name = key;
      input.value = value;
      form.appendChild(input);
    }
    document.body.appendChild(form);
    form.submit();
  };

  return (
    <div className="flex items-center justify-center min-h-screen bg-muted/30">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <ShieldCheck className="mx-auto h-12 w-12 text-primary mb-2" />
          <CardTitle>{t("title")}</CardTitle>
          <CardDescription>
            <span className="font-semibold">{clientName}</span>
            {isDcr && (
              <Badge variant="outline" className="ml-2">
                DCR
              </Badge>
            )}
            {" "}
            {t("description")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            <p className="text-sm font-medium">{t("requestedScopes")}</p>
            {scopes.map((scope) => (
              <div key={scope} className="flex items-center gap-2 rounded-md border p-2">
                <Badge variant="outline" className="shrink-0">
                  {scope}
                </Badge>
                <span className="text-xs text-muted-foreground">
                  {scopeDescriptions?.[scope] ?? scope}
                </span>
              </div>
            ))}
          </div>
        </CardContent>
        <CardFooter className="flex gap-2">
          <Button
            variant="outline"
            className="flex-1"
            onClick={handleDeny}
            disabled={loading}
          >
            <ShieldX className="mr-2 h-4 w-4" />
            {t("deny")}
          </Button>
          <Button className="flex-1" onClick={handleAllow} disabled={loading}>
            {loading ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <ShieldCheck className="mr-2 h-4 w-4" />
            )}
            {t("allow")}
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}
