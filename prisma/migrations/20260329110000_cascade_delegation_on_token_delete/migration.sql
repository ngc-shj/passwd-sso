-- DropForeignKey
ALTER TABLE "delegation_sessions" DROP CONSTRAINT "delegation_sessions_mcp_token_id_fkey";

-- AddForeignKey
ALTER TABLE "delegation_sessions" ADD CONSTRAINT "delegation_sessions_mcp_token_id_fkey" FOREIGN KEY ("mcp_token_id") REFERENCES "mcp_access_tokens"("id") ON DELETE CASCADE ON UPDATE CASCADE;
