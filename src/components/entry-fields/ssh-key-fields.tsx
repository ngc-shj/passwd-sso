"use client";

import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { NotesField, TwoColumnFields, VisibilityToggleInput } from "@/components/entry-fields/form-fields";

interface SshKeyFieldsProps {
  privateKey: string;
  onPrivateKeyChange: (value: string) => void;
  privateKeyPlaceholder: string;
  showPrivateKey: boolean;
  onTogglePrivateKey: () => void;
  publicKey: string;
  onPublicKeyChange: (value: string) => void;
  publicKeyPlaceholder: string;
  keyType: string;
  fingerprint: string;
  keySize: number;
  passphrase: string;
  onPassphraseChange: (value: string) => void;
  passphrasePlaceholder: string;
  showPassphrase: boolean;
  onTogglePassphrase: () => void;
  comment: string;
  onCommentChange: (value: string) => void;
  commentPlaceholder: string;
  notesLabel: string;
  notes: string;
  onNotesChange: (value: string) => void;
  notesPlaceholder: string;
  labels: {
    privateKey: string;
    publicKey: string;
    keyType: string;
    keySize: string;
    fingerprint: string;
    passphrase: string;
    comment: string;
  };
  autoDetectedLabel?: string;
  idPrefix?: string;
}

export function SshKeyFields({
  privateKey,
  onPrivateKeyChange,
  privateKeyPlaceholder,
  showPrivateKey,
  onTogglePrivateKey,
  publicKey,
  onPublicKeyChange,
  publicKeyPlaceholder,
  keyType,
  fingerprint,
  keySize,
  passphrase,
  onPassphraseChange,
  passphrasePlaceholder,
  showPassphrase,
  onTogglePassphrase,
  comment,
  onCommentChange,
  commentPlaceholder,
  notesLabel,
  notes,
  onNotesChange,
  notesPlaceholder,
  labels,
  autoDetectedLabel,
  idPrefix = "",
}: SshKeyFieldsProps) {
  const privateKeyId = `${idPrefix}privateKey`;
  const publicKeyId = `${idPrefix}publicKey`;
  const passphraseId = `${idPrefix}passphrase`;
  const commentId = `${idPrefix}comment`;

  return (
    <>
      <div className="space-y-2">
        <Label htmlFor={privateKeyId}>{labels.privateKey}</Label>
        <div className="relative">
          <Textarea
            id={privateKeyId}
            value={showPrivateKey ? privateKey : privateKey ? "••••••••" : ""}
            onChange={(e) => {
              if (showPrivateKey) onPrivateKeyChange(e.target.value);
            }}
            placeholder={privateKeyPlaceholder}
            rows={4}
            className="font-mono text-xs"
            readOnly={!showPrivateKey}
            onFocus={() => {
              if (!showPrivateKey && !privateKey) onTogglePrivateKey();
            }}
          />
          <button
            type="button"
            className="absolute right-2 top-2 text-xs text-muted-foreground hover:text-foreground"
            onClick={onTogglePrivateKey}
          >
            {showPrivateKey ? "Hide" : "Show"}
          </button>
        </div>
      </div>

      {(keyType || fingerprint) && (
        <TwoColumnFields
          left={(
            <>
              <Label>{labels.keyType}</Label>
              <Input
                value={keyType ? `${keyType.toUpperCase()}${keySize ? ` (${keySize} bit)` : ""}` : ""}
                readOnly
                className="bg-muted text-muted-foreground"
              />
            </>
          )}
          right={(
            <>
              <Label>{labels.fingerprint}</Label>
              <Input
                value={fingerprint}
                readOnly
                className="bg-muted font-mono text-xs text-muted-foreground"
              />
            </>
          )}
        />
      )}

      <div className="space-y-2">
        <Label htmlFor={publicKeyId}>
          {labels.publicKey}
          {publicKey && autoDetectedLabel && (
            <span className="ml-2 text-xs text-muted-foreground">({autoDetectedLabel})</span>
          )}
        </Label>
        <Textarea
          id={publicKeyId}
          value={publicKey}
          onChange={(e) => onPublicKeyChange(e.target.value)}
          placeholder={publicKeyPlaceholder}
          rows={2}
          className="font-mono text-xs"
        />
      </div>

      <TwoColumnFields
        left={(
          <>
            <Label htmlFor={passphraseId}>{labels.passphrase}</Label>
            <VisibilityToggleInput
              show={showPassphrase}
              onToggle={onTogglePassphrase}
              inputProps={{
                id: passphraseId,
                value: passphrase,
                onChange: (e) => onPassphraseChange(e.target.value),
                placeholder: passphrasePlaceholder,
                autoComplete: "off",
              }}
            />
          </>
        )}
        right={(
          <>
            <Label htmlFor={commentId}>{labels.comment}</Label>
            <Input
              id={commentId}
              value={comment}
              onChange={(e) => onCommentChange(e.target.value)}
              placeholder={commentPlaceholder}
              autoComplete="off"
            />
          </>
        )}
      />

      <NotesField
        label={notesLabel}
        value={notes}
        onChange={onNotesChange}
        placeholder={notesPlaceholder}
      />
    </>
  );
}
