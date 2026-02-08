import { getLocale } from "next-intl/server";
import { cookies } from "next/headers";
import "./globals.css";

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const locale = await getLocale();
  const nonce = (await cookies()).get("csp-nonce")?.value ?? "";

  return (
    <html lang={locale} suppressHydrationWarning>
      <head>
        <meta name="csp-nonce" content={nonce} />
      </head>
      <body>{children}</body>
    </html>
  );
}
