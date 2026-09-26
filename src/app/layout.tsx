import { getLocale } from "next-intl/server";
import { getCspNonce } from "@/lib/security/csp-nonce.server";
import { CSP_NONCE_META_NAME } from "@/lib/security/csp-nonce-names";
import "./globals.css";

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const locale = await getLocale();
  const nonce = await getCspNonce();

  return (
    <html lang={locale} suppressHydrationWarning>
      <head>
        {/*
          Fallback carrier for client code that must nonce a runtime-created
          <style>. The preferred read is the `nonce` IDL property of a nonced
          <script>, which the browser keeps out of every serialising path; this
          tag exists for the moment before any such script has been parsed.
          See src/lib/ui/csp-nonce.ts.
        */}
        <meta name={CSP_NONCE_META_NAME} content={nonce} />
      </head>
      <body>{children}</body>
    </html>
  );
}
