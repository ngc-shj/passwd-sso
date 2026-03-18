"use client";

import { useEffect } from "react";
import { sanitizeErrorForSentry } from "@/lib/sentry-sanitize";

// Hardcoded fallback strings — no i18n dependency in global error boundary
const STRINGS = {
  heading: {
    ja: "予期しないエラーが発生しました",
    en: "An unexpected error occurred",
  },
  retry: {
    ja: "再試行",
    en: "Try again",
  },
};

function getLocaleStrings() {
  if (typeof navigator !== "undefined" && navigator.language?.startsWith("ja")) {
    return { heading: STRINGS.heading.ja, retry: STRINGS.retry.ja };
  }
  return { heading: STRINGS.heading.en, retry: STRINGS.retry.en };
}

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    if (process.env.NEXT_PUBLIC_SENTRY_DSN) {
      import("@sentry/nextjs")
        .then(({ captureException }) => {
          captureException(sanitizeErrorForSentry(error));
        })
        .catch(() => {});
    }
  }, [error]);

  const s = getLocaleStrings();

  return (
    <html>
      <body>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            minHeight: "100vh",
            gap: "1rem",
            fontFamily: "system-ui, sans-serif",
            padding: "1rem",
          }}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="40"
            height="40"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ color: "#ef4444" }}
            aria-hidden="true"
          >
            <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
            <path d="M12 9v4" />
            <path d="M12 17h.01" />
          </svg>
          <p style={{ color: "#6b7280", margin: 0 }}>{s.heading}</p>
          <button
            onClick={reset}
            style={{
              padding: "0.5rem 1rem",
              borderRadius: "0.375rem",
              border: "1px solid #d1d5db",
              background: "#fff",
              cursor: "pointer",
              fontSize: "0.875rem",
            }}
          >
            {s.retry}
          </button>
        </div>
      </body>
    </html>
  );
}
