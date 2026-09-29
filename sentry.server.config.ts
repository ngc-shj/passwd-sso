import * as Sentry from "@sentry/nextjs";
import {
  SENTRY_DATA_COLLECTION,
  scrubSentryEvent,
  scrubSentrySpan,
} from "@/lib/security/sentry-scrub";

const dsn = process.env.SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    tracesSampleRate: 0.1,
    dataCollection: SENTRY_DATA_COLLECTION,
    beforeSend(event) {
      return scrubSentryEvent(event as unknown as Record<string, unknown>) as unknown as typeof event;
    },
    beforeSendSpan: scrubSentrySpan,
  });
}
