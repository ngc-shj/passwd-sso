/**
 * Allowlist of env vars that are NOT declared in the Zod schema (src/lib/env-schema.ts).
 *
 * Each entry must:
 *   - Have a justification of ≥40 characters explaining WHY it is excluded from Zod.
 *   - List at least one consumers[] path that reads or references the var.
 *   - Have a reviewedAt ISO-8601 date.
 *
 * The drift-checker (scripts/check-env-docs.ts) validates this file at runtime
 * and fails CI if any entry is malformed, dead, or stale.
 *
 * Governance: changes to this file require a review from @ngc-shj (see .github/CODEOWNERS).
 */

export type LiteralAllowlistEntry = {
  type: "literal";
  key: string;
  justification: string;
  consumers: readonly string[];
  reviewedAt: string;
  /**
   * Set to true for framework-set / runtime-provided vars that our app
   * legitimately reads but are NOT user-configurable (e.g. NEXT_RUNTIME,
   * set by Next.js). Exempts the entry from drift-check rule 9
   * (allowlist-app-read). Use sparingly — the default rule exists to
   * prevent allowlist abuse.
   */
  readByApp?: boolean;
  /**
   * Set to true when operators must configure this var for the app to run
   * (e.g. JACKSON_API_KEY for docker compose, PASSWD_OUTBOX_WORKER_PASSWORD
   * for provisioning scripts). The env-example generator emits these under
   * a dedicated "External" section so new developers see them in the
   * template. The interactive generator (init:env) also prompts for them.
   * Default false (entry is internal-only and not shown to operators).
   */
  includeInExample?: boolean;
  /**
   * Optional one-line operator-facing description shown above the emitted
   * line in .env.example and as the prompt in init:env. When absent the
   * generator falls back to the first line of justification.
   */
  description?: string;
  /**
   * Optional example placeholder value shown after `# KEY=` in .env.example
   * and as the default during init:env prompting. Never write a real secret
   * here — secret-pattern guard (NF-4.6) will fail the build.
   */
  example?: string;
  /**
   * Marks the value as secret so that (a) the env-example generator never
   * emits the `example` verbatim (replaces with a placeholder comment) and
   * (b) init:env suppresses echo at prompt time.
   */
  secret?: boolean;
  /**
   * Set to true when an operator MUST configure this var for the standard
   * deployment path to succeed (e.g. JACKSON_API_KEY for `docker compose up`,
   * PASSWD_OUTBOX_WORKER_PASSWORD for the worker DB role provisioning step).
   * The env-example generator emits these uncommented so a `cp .env.example
   * .env.local` user sees the line ready to fill in — symmetric with the
   * always-required Zod fields like DATABASE_URL (CF4/CF7). Default false:
   * the entry is optional from the operator's perspective.
   */
  requiredForConsumer?: boolean;
};

export type RegexAllowlistEntry = {
  type: "regex";
  pattern: string;
  justification: string;
  consumers: readonly string[];
  reviewedAt: string;
};

export type AllowlistEntry = LiteralAllowlistEntry | RegexAllowlistEntry;

export const ALLOWLIST: readonly AllowlistEntry[] = [
  {
    type: "literal",
    key: "JACKSON_API_KEY",
    justification:
      "Used only by BoxyHQ SAML Jackson container; never read by our Next app or worker. " +
      "Declared as ${JACKSON_API_KEY:?...} required only at Jackson container start.",
    consumers: ["docker-compose.yml"],
    reviewedAt: "2026-04-24",
    includeInExample: true,
    requiredForConsumer: true,
    description:
      "Admin API key for BoxyHQ SAML Jackson container's /api/v1/* endpoints.\n" +
      "Required by docker-compose.yml; generate with: openssl rand -hex 24\n" +
      "NOT read by the Next.js app — only the Jackson container consumes it.",
    secret: true,
  },
  {
    type: "literal",
    key: "PASSWD_OUTBOX_WORKER_PASSWORD",
    justification:
      "Consumed only by the one-shot provisioning script that sets the passwd_outbox_worker DB role password. " +
      "Not read by any running process.",
    consumers: [
      "scripts/set-outbox-worker-password.sh",
      "infra/postgres/initdb",
    ],
    reviewedAt: "2026-04-24",
    includeInExample: true,
    requiredForConsumer: true,
    description:
      "Password for the passwd_outbox_worker least-privilege DB role.\n" +
      "Consumed by infra/postgres/initdb on first boot AND by\n" +
      "scripts/set-outbox-worker-password.sh for existing clusters.",
    secret: true,
  },
  {
    type: "literal",
    key: "PASSWD_DCR_CLEANUP_WORKER_PASSWORD",
    justification:
      "Consumed only by the one-shot provisioning script that sets the passwd_dcr_cleanup_worker DB role password. " +
      "Not read by any running process.",
    consumers: [
      "scripts/set-dcr-cleanup-worker-password.sh",
      "infra/postgres/initdb",
    ],
    reviewedAt: "2026-04-28",
    includeInExample: true,
    requiredForConsumer: true,
    description:
      "Password for the passwd_dcr_cleanup_worker least-privilege DB role.\n" +
      "Consumed by infra/postgres/initdb on first boot AND by\n" +
      "scripts/set-dcr-cleanup-worker-password.sh for existing clusters.",
    secret: true,
  },
  {
    type: "literal",
    key: "NEXT_RUNTIME",
    justification:
      "Provided by the Next.js framework at runtime; user configuration has no effect. " +
      "Value space is {nodejs, edge}. Read-only from our code — framework sets it, we only observe it.",
    consumers: ["src/instrumentation.ts"],
    reviewedAt: "2026-04-24",
    // Framework-set: legitimately read by src/ code but not user-configurable.
    readByApp: true,
  },
  {
    type: "literal",
    key: "SENTRY_AUTH_TOKEN",
    justification:
      "Build-time-only: consumed by the Sentry webpack plugin during npm run build for source-map upload. " +
      "Referenced in README.md/README.ja.md operator-facing docs as a deploy-time secret.",
    consumers: ["README.md", "README.ja.md"],
    reviewedAt: "2026-04-24",
    includeInExample: true,
    description:
      "Sentry auth token for source map upload during production build.\n" +
      "Optional — only needed when deploying with Sentry source maps.",
    secret: true,
  },
  {
    type: "literal",
    key: "BASE_URL",
    justification:
      "Manual/REPL helper for ad-hoc testing; never read by the app or automated tests. " +
      "Present only in manual test scripts for developer convenience.",
    consumers: ["scripts/manual-tests"],
    reviewedAt: "2026-04-24",
  },
  {
    type: "literal",
    key: "APP_DATABASE_URL",
    justification:
      "Test helper override for integration tests that need a non-default app-role connection string; " +
      "not read in production code paths.",
    consumers: ["src/__tests__/db-integration/helpers.ts"],
    reviewedAt: "2026-04-24",
  },
  {
    type: "literal",
    key: "NEXT_DEV_ALLOWED_ORIGINS",
    justification:
      "Read by the Next CLI at config-evaluation time, before @/lib/env runs; schema validation " +
      "would be unreachable at the reader site. Comma-separated hostnames, enforced by Next's own dev-origin check (F19).",
    consumers: ["next.config.ts"],
    reviewedAt: "2026-04-24",
    includeInExample: true,
    description:
      "Comma-separated hostnames allowed to access `npm run dev`.\n" +
      "Required when accessing the dev server from a non-localhost\n" +
      "origin (e.g., Tailscale or LAN hostname).",
    example: "",
  },
  {
    type: "regex",
    // V11..V100: variadic slots not modeled as explicit Zod fields.
    // The pattern is bounded: anchored prefix SHARE_MASTER_KEY_V (18 chars),
    // followed by the numeric range (1[1-9]|[2-9]\d|100).
    pattern: "^SHARE_MASTER_KEY_V(1[1-9]|[2-9]\\d|100)$",
    justification:
      "Variadic master key slots for versions 11..100. V1..V10 are modeled as explicit Zod fields; " +
      "V11+ remain accessed via process.env[...] in superRefine as a documented exception because " +
      "adding 90 explicit fields would bloat the schema without proportional benefit. " +
      "A follow-up PR will add explicit fields if any deployment rotates past V10.",
    consumers: [
      "src/lib/env-schema.ts",
      "src/lib/key-provider/env-provider.ts",
    ],
    reviewedAt: "2026-04-24",
  },
];
