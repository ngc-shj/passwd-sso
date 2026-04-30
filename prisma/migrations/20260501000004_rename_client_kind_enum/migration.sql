-- Rename ExtensionTokenClientKind enum from snake_case to PascalCase to match
-- the project's enum naming convention (other enums in the schema do not use
-- @@map). The schema-side @@map directive has been removed in the same change.
-- The enum's VALUES (BROWSER_EXTENSION, IOS_APP) are unchanged.
--
-- The rename is name-only at the storage layer; existing extension_tokens
-- rows continue to point at the same enum values via their column type
-- reference.

ALTER TYPE "extension_token_client_kind" RENAME TO "ExtensionTokenClientKind";
