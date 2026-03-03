import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const rawBasePath = process.env.NEXT_PUBLIC_BASE_PATH || "";
if (rawBasePath && (!/^\/[\w\-/]+$/.test(rawBasePath) || rawBasePath.endsWith("/"))) {
  throw new Error(
    `Invalid NEXT_PUBLIC_BASE_PATH: "${rawBasePath}" — must start with "/" and not end with "/"`,
  );
}

const nextConfig: NextConfig = {
  basePath: rawBasePath || undefined,
  output: "standalone",
  serverExternalPackages: ["file-type"],

  // Security headers
  async headers() {
    const isProd = process.env.NODE_ENV === "production";
    return [
      {
        source: "/(.*)",
        headers: [
          {
            key: "X-Frame-Options",
            value: "DENY",
          },
          {
            key: "X-Content-Type-Options",
            value: "nosniff",
          },
          {
            key: "Referrer-Policy",
            value: "strict-origin-when-cross-origin",
          },
          {
            key: "X-XSS-Protection",
            value: "1; mode=block",
          },
          {
            key: "Permissions-Policy",
            value:
              "camera=(), microphone=(), geolocation=(), browsing-topics=()",
          },
          {
            key: "Strict-Transport-Security",
            value: isProd
              ? "max-age=63072000; includeSubDomains; preload"
              : "max-age=0",
          },
        ],
      },
    ];
  },
};

const withNextIntl = createNextIntlPlugin();

export default withNextIntl(nextConfig);
