"use client";

import { useState, useEffect } from "react";
import { useTranslations } from "next-intl";
import { useVault } from "@/lib/vault-context";
import { useTeamVaultOptional } from "@/lib/team-vault-context";
import { PagePane } from "@/components/layout/page-pane";
import { PageTitleCard } from "@/components/layout/page-title-card";
import { FileUp } from "lucide-react";
import { API_PATH } from "@/lib/constants";
import { apiPath } from "@/lib/constants/api-path";
import {
  ImportActions,
  ImportDecryptStep,
  ImportDoneStep,
  ImportFileSelectStep,
  ImportPreviewStep,
} from "@/components/passwords/password-import-steps";
import { useImportFileFlow } from "@/components/passwords/use-import-file-flow";
import { useImportExecution } from "@/components/passwords/use-import-execution";

// ─── Component ──────────────────────────────────────────────

interface ImportPanelContentProps {
  onComplete: () => void;
  orgId?: string;
  teamId?: string;
}

function ImportPanelContent({ onComplete, orgId, teamId }: ImportPanelContentProps) {
  const scopedId = teamId ?? orgId;
  const t = useTranslations("Import");
  const { encryptionKey, userId } = useVault();
  const orgVault = useTeamVaultOptional();
  const isOrgImport = Boolean(scopedId);
  const tagsPath = scopedId ? apiPath.teamTags(scopedId) : API_PATH.TAGS;
  const passwordsPath = scopedId ? apiPath.teamPasswords(scopedId) : API_PATH.PASSWORDS;

  // Resolve org encryption key for org imports
  const [orgEncryptionKey, setOrgEncryptionKey] = useState<CryptoKey | undefined>();
  const [orgKeyVersion, setOrgKeyVersion] = useState<number | undefined>();
  useEffect(() => {
    if (!isOrgImport || !scopedId || !orgVault) return;
    orgVault.getOrgKeyInfo(scopedId).then((info) => {
      if (info) {
        setOrgEncryptionKey(info.key);
        setOrgKeyVersion(info.keyVersion);
      }
    });
  }, [isOrgImport, scopedId, orgVault]);

  const {
    fileRef,
    entries,
    format,
    dragOver,
    encryptedFile,
    decryptPassword,
    decrypting,
    decryptError,
    sourceFilename,
    encryptedInput,
    setDragOver,
    setDecryptPasswordAndClearError,
    handleFileChange,
    handleDrop,
    handleDecrypt,
    reset: resetFileFlow,
  } = useImportFileFlow();
  const {
    importing,
    progress,
    done,
    result,
    resetExecution,
    runImport,
  } = useImportExecution({
    t,
    onComplete,
    isOrgImport,
    tagsPath,
    passwordsPath,
    sourceFilename,
    encryptedInput,
    userId: userId ?? undefined,
    encryptionKey: encryptionKey ?? undefined,
    orgEncryptionKey,
    orgKeyVersion,
    orgId: scopedId,
  });

  const reset = () => {
    resetExecution();
    resetFileFlow();
  };

  const content = (
    <>
      {done ? (
        <ImportDoneStep t={t} successCount={result.success} onReset={reset} />
      ) : encryptedFile ? (
        <ImportDecryptStep
          t={t}
          decryptPassword={decryptPassword}
          decryptError={decryptError}
          decrypting={decrypting}
          onReset={reset}
          onDecrypt={() => handleDecrypt(t("decryptionFailed"))}
          onDecryptPasswordChange={setDecryptPasswordAndClearError}
          encryptedFile={encryptedFile}
        />
      ) : entries.length === 0 ? (
        <ImportFileSelectStep
          t={t}
          dragOver={dragOver}
          fileRef={fileRef}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
          onFileChange={handleFileChange}
        />
      ) : (
        <ImportPreviewStep
          t={t}
          entries={entries}
          format={format}
          importing={importing}
          progress={progress}
        />
      )}

      {!done && entries.length > 0 && (
        <ImportActions
          t={t}
          importing={importing}
          entriesCount={entries.length}
          onReset={reset}
          onImport={() => runImport(entries)}
        />
      )}
    </>
  );

  return content;
}

interface ImportPagePanelProps {
  onComplete: () => void;
  orgId?: string;
  teamId?: string;
}

export function ImportPagePanel({ onComplete, orgId, teamId }: ImportPagePanelProps) {
  const t = useTranslations("Import");
  return (
    <PagePane
      header={
        <PageTitleCard
          icon={<FileUp className="h-5 w-5" />}
          title={t("title")}
          description={t("description")}
        />
      }
    >
      <ImportPanelContent onComplete={onComplete} orgId={orgId} teamId={teamId} />
    </PagePane>
  );
}

interface OrgImportPagePanelProps {
  orgId?: string;
  teamId?: string;
  onComplete: () => void;
}

export function OrgImportPagePanel({ orgId, teamId, onComplete }: OrgImportPagePanelProps) {
  return <ImportPagePanel onComplete={onComplete} orgId={orgId} teamId={teamId} />;
}
