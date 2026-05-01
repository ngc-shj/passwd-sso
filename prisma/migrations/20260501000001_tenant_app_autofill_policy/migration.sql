-- iOS AutoFill MVP (Batch A): tenant-level kill switch for iOS AutoFill.
--
-- Defaults to false so existing tenants must opt in before any of their
-- members can pair an iOS device. Once true, the mobile pairing endpoints
-- accept device registration; flipping back to false leaves existing tokens
-- valid until they expire or are revoked (revocation is operator-driven).

-- AlterTable
ALTER TABLE "tenants"
  ADD COLUMN "allow_app_side_autofill" BOOLEAN NOT NULL DEFAULT false;
