-- iOS AutoFill MVP (Batch A): distinguish browser-extension from iOS-app tokens.
--
-- The ExtensionToken table is being repurposed to back both the browser
-- extension and the iOS host-app session. New rows from the iOS pairing flow
-- carry clientKind = IOS_APP and supply the binding fields (devicePubkey,
-- cnfJkt) used by the DPoP-style proof-of-possession check on every iOS API
-- call. lastUsedIp / lastUsedUserAgent capture forensic context for the
-- mobile sessions list.
--
-- Backward compatibility: client_kind defaults to BROWSER_EXTENSION so all
-- existing rows backfill cleanly under the NOT NULL constraint without
-- needing a separate UPDATE step.

-- CreateEnum
CREATE TYPE "extension_token_client_kind" AS ENUM ('BROWSER_EXTENSION', 'IOS_APP');

-- AlterTable
ALTER TABLE "extension_tokens"
  ADD COLUMN "client_kind" "extension_token_client_kind" NOT NULL DEFAULT 'BROWSER_EXTENSION',
  ADD COLUMN "device_pubkey" TEXT,
  ADD COLUMN "cnf_jkt" VARCHAR(64),
  ADD COLUMN "last_used_ip" VARCHAR(64),
  ADD COLUMN "last_used_user_agent" TEXT;
