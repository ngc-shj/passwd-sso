-- AlterTable: Add parent_id to tags
ALTER TABLE "tags" ADD COLUMN "parent_id" TEXT;

-- AlterTable: Add parent_id to team_tags
ALTER TABLE "team_tags" ADD COLUMN "parent_id" TEXT;

-- AddForeignKey: tags self-reference
ALTER TABLE "tags" ADD CONSTRAINT "tags_parent_id_fkey"
  FOREIGN KEY ("parent_id") REFERENCES "tags"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey: team_tags self-reference
ALTER TABLE "team_tags" ADD CONSTRAINT "team_tags_parent_id_fkey"
  FOREIGN KEY ("parent_id") REFERENCES "team_tags"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddCheck: prevent self-referencing parent
ALTER TABLE "tags" ADD CONSTRAINT "tags_no_self_parent" CHECK ("parent_id" != "id");
ALTER TABLE "team_tags" ADD CONSTRAINT "team_tags_no_self_parent" CHECK ("parent_id" != "id");

-- DropIndex: old unique constraints
DROP INDEX "tags_name_user_id_key";
DROP INDEX "team_tags_name_team_id_key";

-- CreateIndex: new unique constraints (name + parentId + owner)
-- For tags with a parent:
CREATE UNIQUE INDEX "tags_name_parent_id_user_id_key" ON "tags"("name", "parent_id", "user_id");
-- For root-level tags (parentId IS NULL):
CREATE UNIQUE INDEX "tags_name_user_id_root_key" ON "tags"("name", "user_id") WHERE "parent_id" IS NULL;

-- For team_tags with a parent:
CREATE UNIQUE INDEX "team_tags_name_parent_id_team_id_key" ON "team_tags"("name", "parent_id", "team_id");
-- For root-level team_tags (parentId IS NULL):
CREATE UNIQUE INDEX "team_tags_name_team_id_root_key" ON "team_tags"("name", "team_id") WHERE "parent_id" IS NULL;
