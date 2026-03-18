import type { NextConfig } from "next";
import { execSync } from "node:child_process";
import createNextIntlPlugin from "next-intl/plugin";

// Build metadata for reproducible build tracking
function getGitSha(): string {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf-8" }).trim();
  } catch {
    return "unknown";
  }
}

const rawBasePath = process.env.NEXT_PUBLIC_BASE_PATH || "";
if (rawBasePath && !/^\/[\w-]+(?:\/[\w-]+)*$/.test(rawBasePath)) {
  throw new Error(
    `Invalid NEXT_PUBLIC_BASE_PATH: "${rawBasePath}" — must start with "/" and not end with "/"`,
  );
}

const nextConfig: NextConfig = {
  basePath: rawBasePath || undefined,
  output: "standalone",
  serverExternalPackages: ["file-type", "argon2-browser", "@aws-sdk/client-secrets-manager", "@azure/keyvault-secrets", "@azure/identity", "@google-cloud/secret-manager"],

  env: {
    NEXT_PUBLIC_BUILD_SHA: getGitSha(),
    NEXT_PUBLIC_BUILD_TIME: new Date().toISOString(),
  },

  // Security headers
  async headers() {
    const isProd = process.env.NODE_ENV === "production";

    const commonSecurityHeaders = [
      {
        key: "X-Frame-Options",
        value: "DENY",
      },
      {
        key: "X-Content-Type-Options",
        value: "nosniff",
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
    ];

    return [
      {
        source: "/(.*)",
        headers: [
          ...commonSecurityHeaders,
          {
            key: "Referrer-Policy",
            value: "strict-origin-when-cross-origin",
          },
        ],
      },
      {
        // Vault-reset page: suppress Referrer to prevent token leakage
        // Must come AFTER global rule so no-referrer overrides strict-origin
        source: "/:locale/vault-reset/admin",
        headers: [
          {
            key: "Referrer-Policy",
            value: "no-referrer",
          },
        ],
      },
    ];
  },
};

const withNextIntl = createNextIntlPlugin();

export default withNextIntl(nextConfig);
