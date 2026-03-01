-- AlterTable
ALTER TABLE "team_folders" RENAME CONSTRAINT "org_folders_pkey" TO "team_folders_pkey";

-- AlterTable
ALTER TABLE "team_invitations" RENAME CONSTRAINT "org_invitations_pkey" TO "team_invitations_pkey";

-- AlterTable
ALTER TABLE "team_member_keys" RENAME CONSTRAINT "org_member_keys_pkey" TO "team_member_keys_pkey";

-- AlterTable
ALTER TABLE "team_members" RENAME CONSTRAINT "org_members_pkey" TO "team_members_pkey";

-- AlterTable
ALTER TABLE "team_password_entries" RENAME CONSTRAINT "org_password_entries_pkey" TO "team_password_entries_pkey";

-- AlterTable
ALTER TABLE "team_password_entry_histories" RENAME CONSTRAINT "org_password_entry_histories_pkey" TO "team_password_entry_histories_pkey";

-- AlterTable
ALTER TABLE "team_password_favorites" RENAME CONSTRAINT "org_password_favorites_pkey" TO "team_password_favorites_pkey";

-- AlterTable
ALTER TABLE "team_tags" RENAME CONSTRAINT "org_tags_pkey" TO "team_tags_pkey";

-- RenameForeignKey
ALTER TABLE "audit_logs" RENAME CONSTRAINT "audit_logs_org_id_fkey" TO "audit_logs_team_id_fkey";

-- RenameForeignKey
ALTER TABLE "scim_external_mappings" RENAME CONSTRAINT "scim_external_mappings_org_id_fkey" TO "scim_external_mappings_team_id_fkey";

-- RenameForeignKey
ALTER TABLE "scim_tokens" RENAME CONSTRAINT "scim_tokens_org_id_fkey" TO "scim_tokens_team_id_fkey";

-- RenameForeignKey
ALTER TABLE "team_folders" RENAME CONSTRAINT "org_folders_org_id_fkey" TO "team_folders_team_id_fkey";

-- RenameForeignKey
ALTER TABLE "team_folders" RENAME CONSTRAINT "org_folders_parent_id_fkey" TO "team_folders_parent_id_fkey";

-- RenameForeignKey
ALTER TABLE "team_invitations" RENAME CONSTRAINT "org_invitations_invited_by_id_fkey" TO "team_invitations_invited_by_id_fkey";

-- RenameForeignKey
ALTER TABLE "team_invitations" RENAME CONSTRAINT "org_invitations_org_id_fkey" TO "team_invitations_team_id_fkey";

-- RenameForeignKey
ALTER TABLE "team_member_keys" RENAME CONSTRAINT "org_member_keys_org_id_fkey" TO "team_member_keys_team_id_fkey";

-- RenameForeignKey
ALTER TABLE "team_member_keys" RENAME CONSTRAINT "org_member_keys_user_id_fkey" TO "team_member_keys_user_id_fkey";

-- RenameForeignKey
ALTER TABLE "team_members" RENAME CONSTRAINT "org_members_org_id_fkey" TO "team_members_team_id_fkey";

-- RenameForeignKey
ALTER TABLE "team_members" RENAME CONSTRAINT "org_members_user_id_fkey" TO "team_members_user_id_fkey";

-- RenameForeignKey
ALTER TABLE "team_password_entries" RENAME CONSTRAINT "org_password_entries_created_by_id_fkey" TO "team_password_entries_created_by_id_fkey";

-- RenameForeignKey
ALTER TABLE "team_password_entries" RENAME CONSTRAINT "org_password_entries_org_folder_id_fkey" TO "team_password_entries_team_folder_id_fkey";

-- RenameForeignKey
ALTER TABLE "team_password_entries" RENAME CONSTRAINT "org_password_entries_org_id_fkey" TO "team_password_entries_team_id_fkey";

-- RenameForeignKey
ALTER TABLE "team_password_entries" RENAME CONSTRAINT "org_password_entries_updated_by_id_fkey" TO "team_password_entries_updated_by_id_fkey";

-- RenameForeignKey
ALTER TABLE "team_password_entry_histories" RENAME CONSTRAINT "org_password_entry_histories_changed_by_id_fkey" TO "team_password_entry_histories_changed_by_id_fkey";

-- RenameForeignKey
ALTER TABLE "team_password_entry_histories" RENAME CONSTRAINT "org_password_entry_histories_entry_id_fkey" TO "team_password_entry_histories_entry_id_fkey";

-- RenameForeignKey
ALTER TABLE "team_password_favorites" RENAME CONSTRAINT "org_password_favorites_user_id_fkey" TO "team_password_favorites_user_id_fkey";

-- RenameForeignKey
ALTER TABLE "team_tags" RENAME CONSTRAINT "org_tags_org_id_fkey" TO "team_tags_team_id_fkey";

-- RenameIndex
ALTER INDEX "audit_logs_org_id_created_at_idx" RENAME TO "audit_logs_team_id_created_at_idx";

-- RenameIndex
ALTER INDEX "scim_tokens_org_id_revoked_at_idx" RENAME TO "scim_tokens_team_id_revoked_at_idx";

-- RenameIndex
ALTER INDEX "org_folders_name_parent_id_org_id_key" RENAME TO "team_folders_name_parent_id_team_id_key";

-- RenameIndex
ALTER INDEX "org_folders_org_id_idx" RENAME TO "team_folders_team_id_idx";

-- RenameIndex
ALTER INDEX "org_invitations_token_key" RENAME TO "team_invitations_token_key";

-- RenameIndex
ALTER INDEX "org_member_keys_org_id_user_id_key_version_key" RENAME TO "team_member_keys_team_id_user_id_key_version_key";

-- RenameIndex
ALTER INDEX "org_member_keys_user_id_idx" RENAME TO "team_member_keys_user_id_idx";

-- RenameIndex
ALTER INDEX "org_members_org_id_user_id_key" RENAME TO "team_members_team_id_user_id_key";

-- RenameIndex
ALTER INDEX "org_password_entries_org_id_idx" RENAME TO "team_password_entries_team_id_idx";

-- RenameIndex
ALTER INDEX "org_password_entry_histories_entry_id_changed_at_idx" RENAME TO "team_password_entry_histories_entry_id_changed_at_idx";

-- RenameIndex
ALTER INDEX "org_tags_name_org_id_key" RENAME TO "team_tags_name_team_id_key";
