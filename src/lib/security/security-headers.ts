// Shared security header values used by both next.config.ts (static layer)
// and src/proxy.ts middleware (dynamic layer). Single source of truth to
// prevent drift between the two header-setting locations.

export const PERMISSIONS_POLICY =
  "camera=(), microphone=(), geolocation=(), payment=(), browsing-topics=()";
