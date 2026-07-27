import type { AbstractIntlMessages } from "next-intl";
import { clientLogWarn, CLIENT_LOG_EVENT, opaque } from "@/lib/logger/client";

/**
 * Pick a subset of top-level namespaces from the full messages object.
 * Used by layouts to filter what is serialised to the client.
 */
export function pickMessages(
  messages: AbstractIntlMessages,
  namespaces: readonly string[],
): AbstractIntlMessages {
  const picked: Record<string, AbstractIntlMessages[string]> = {};
  for (const ns of namespaces) {
    if (ns in messages) {
      picked[ns] = messages[ns];
    } else if (process.env.NODE_ENV === "development") {
      clientLogWarn(CLIENT_LOG_EVENT.I18N_NAMESPACE_MISSING, { namespace: opaque(ns) });
    }
  }
  return picked;
}
