/*
  Warnings:

  - You are about to drop the column `max_session_duration_minutes` on the `team_policies` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "audit_chain_anchors" ALTER COLUMN "prev_hash" SET DEFAULT '\x00'::bytea;

-- AlterTable
ALTER TABLE "team_policies" DROP COLUMN "max_session_duration_minutes";
