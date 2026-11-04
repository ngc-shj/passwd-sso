"use client";

import { useState, useEffect, useRef } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { RotateCcw, Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  generateTeamSymmetricKey,
  createTeamKeyEscrow,
  deriveTeamEncryptionKey,
} from "@/lib/crypto/crypto-team";
import { fetchApi } from "@/lib/url-helpers";
import { apiPath } from "@/lib/constants";
import { useTeamVault } from "@/lib/team/team-vault-core";
import { readApiErrorBody } from "@/lib/http/read-api-error-body";
import { API_ERROR, apiErrorToI18nKey } from "@/lib/http/api-error-codes";
import { RecentSessionRequiredDialog } from "@/components/auth/recent-session-required-dialog";
import { PasskeyReauthDialog } from "@/components/auth/passkey-reauth-dialog";
import { useInlineReauth } from "@/hooks/auth/use-inline-reauth";
import { clientLogError, CLIENT_LOG_EVENT, toClientErrorCode } from "@/lib/logger/client";
import { ROTATE_CARRY_REASON } from "@/lib/constants/team/rotate-key";
import { normalizeTeamKeyVersion } from "@/lib/team/team-key-resolution";
import {
  RotationAbortedError,
  buildRotationPayload,
  type RotateCarry,
  type RotationSourceEntry,
} from "@/lib/team/rotation-payload";
import {
  buildRekeyReport,
  holderInputsFrom,
  type RekeyReport,
  type RekeyReportInput,
} from "@/lib/team/rekey-report";
import type { RekeyListResponse } from "@/lib/team/rekey-runner";
import { RekeyReportView } from "@/components/team/security/rekey-report-view";

// ─── Types ────────────────────────────────────────────────────

interface RotateKeyDataMember {
  userId: string;
  ecdhPublicKey: string;
}

interface RotateKeyData {
  teamKeyVersion: number;
  entries: RotationSourceEntry[];
  members: RotateKeyDataMember[];
  /** Team key versions the caller holds a member key for. */
  actorKeyVersions: number[];
}

interface TeamRotateKeyButtonProps {
  teamId: string;
  /** Called after a committed rotation (the page starts the re-key pass). */
  onSuccess?: () => void;
  /** Held while a re-key pass runs. */
  disabled?: boolean;
}

// ─── Progress tracking ────────────────────────────────────────

type RotatePhase = "idle" | "fetching" | "encrypting" | "submitting";

function describeProgress(phase: RotatePhase, current: number, total: number): string {
  switch (phase) {
    case "fetching":
      return "...";
    case "encrypting":
      return total > 0 ? `${current}/${total}` : "...";
    case "submitting":
      return "...";
    default:
      return "";
  }
}

/** The holder-claim carries (undecryptable / key_invalid) as a report. */
function carryReport(
  carry: readonly RotateCarry[],
  entries: readonly RotationSourceEntry[],
  held: ReadonlySet<number>,
  holders: Pick<RekeyReportInput, "otherHoldersByVersion">,
): RekeyReport {
  const attemptedByVersion = new Map<number, number>();
  for (const e of entries) {
    const v = normalizeTeamKeyVersion(e.teamKeyVersion);
    if (held.has(v)) attemptedByVersion.set(v, (attemptedByVersion.get(v) ?? 0) + 1);
  }
  const at = (reason: string) =>
    carry.filter((c) => c.reason === reason).map((c) => ({ entryId: c.id, teamKeyVersion: c.teamKeyVersion }));
  return buildRekeyReport({
    undecryptable: at(ROTATE_CARRY_REASON.UNDECRYPTABLE),
    keyInvalid: at(ROTATE_CARRY_REASON.KEY_INVALID),
    attemptedByVersion,
    ...holders,
  });
}

// ─── Component ───────────────────────────────────────────────

export function TeamRotateKeyButton({ teamId, onSuccess, disabled = false }: TeamRotateKeyButtonProps) {
  const t = useTranslations("Teams");
  const tApi = useTranslations("ApiErrors");
  const { resolveTeamKey, invalidateTeamKey } = useTeamVault();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [phase, setPhase] = useState<RotatePhase>("idle");
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [confirmInput, setConfirmInput] = useState("");
  const [report, setReport] = useState<RekeyReport | null>(null);

  // Inline step-up reauth — rotate-key is server-side step-up-gated. On a stale
  // session the confirm dialog stays open and the hook replays the rotation
  // (re-fetch + re-encrypt) after reauth.
  const rotateRetryRef = useRef<() => Promise<void>>(async () => {});
  const inlineReauth = useInlineReauth(() => rotateRetryRef.current());

  const rotationErrorMessage = (status: number, code: string | undefined): string => {
    if (status === 429) return t("rotateKeyRateLimited");
    switch (code) {
      case API_ERROR.TEAM_KEY_VERSION_MISMATCH:
        return t("rotateKeyVersionConflict");
      case API_ERROR.ENTRY_COUNT_MISMATCH:
        return t("rotateKeyEntryMismatch");
      case API_ERROR.VALIDATION_ERROR:
        return t("rotateKeyMembersChanged");
      case undefined:
        return t("rotateKeyFailed");
      default: {
        const key = apiErrorToI18nKey(code);
        return key === "unknownError" ? t("rotateKeyFailed") : tApi(key);
      }
    }
  };

  // Who else holds the carried entries' versions, so the report can name
  // another holder (every entry is pending right after the rotation). Without
  // it the report falls back to exits that need no names.
  const carriedVersionHolders = async (
    carry: readonly RotateCarry[],
  ): Promise<Pick<RekeyReportInput, "otherHoldersByVersion">> => {
    if (!carry.some((c) => c.reason !== ROTATE_CARRY_REASON.NOT_HELD)) return {};
    try {
      const res = await fetchApi(`${apiPath.teamRekey(teamId)}?limit=1`);
      if (!res.ok) return {};
      const list = (await res.json()) as RekeyListResponse;
      return {
        otherHoldersByVersion: holderInputsFrom(list.versionHolders ?? {}, t("rekeyUnknownHolder")).otherHoldersByVersion,
      };
    } catch {
      return {};
    }
  };

  const handleRotate = async () => {
    setLoading(true);
    setPhase("fetching");
    setReport(null);

    let newTeamKeyBytes: Uint8Array | null = null;
    try {
      // 1. Fetch all entries, member public keys and the versions the caller holds
      const dataRes = await fetchApi(apiPath.teamRotateKeyData(teamId));
      if (!dataRes.ok) {
        if (dataRes.status === 429) {
          toast.error(t("rotateKeyRateLimited"));
        } else {
          toast.error(t("rotateKeyFetchFailed"));
        }
        return;
      }
      const data: RotateKeyData = await dataRes.json();

      if (data.members.length === 0) {
        toast.error(t("rotateKeyNoMembers"));
        return;
      }

      const currentTeamKeyVersion = data.teamKeyVersion;
      const newTeamKeyVersion = currentTeamKeyVersion + 1;

      // The caller must hold the current key: the new one is distributed from it.
      const current = await resolveTeamKey(teamId, currentTeamKeyVersion);
      if (!("key" in current)) {
        toast.error(t("rotateKeyVaultRequired"));
        return;
      }

      // 2. Generate new team symmetric key
      newTeamKeyBytes = generateTeamSymmetricKey();
      const newTeamEncryptionKey = await deriveTeamEncryptionKey(newTeamKeyBytes);

      // 3. Each entry with the key at its own version; entries the caller
      // cannot open are carried with a reason.
      setPhase("encrypting");
      const heldVersions = new Set(data.actorKeyVersions.map(normalizeTeamKeyVersion));
      let payload: Awaited<ReturnType<typeof buildRotationPayload>>;
      try {
        payload = await buildRotationPayload(
          data.entries,
          (version) => resolveTeamKey(teamId, version),
          { teamId, newTeamKeyVersion, newTeamEncryptionKey, heldVersions },
          (current, total) => setProgress({ current, total }),
        );
      } catch (e) {
        if (e instanceof RotationAbortedError) {
          toast.error(t("rotateKeyAborted"));
          return;
        }
        throw e;
      }

      // 4. Re-wrap new TeamKey for each active member
      const memberKeys = await Promise.all(
        data.members.map(async (member) => {
          const escrow = await createTeamKeyEscrow(
            newTeamKeyBytes as Uint8Array,
            member.ecdhPublicKey,
            teamId,
            member.userId,
            newTeamKeyVersion,
          );
          return {
            userId: member.userId,
            encryptedTeamKey: escrow.encryptedTeamKey,
            teamKeyIv: escrow.teamKeyIv,
            teamKeyAuthTag: escrow.teamKeyAuthTag,
            ephemeralPublicKey: escrow.ephemeralPublicKey,
            hkdfSalt: escrow.hkdfSalt,
            keyVersion: newTeamKeyVersion,
            wrapVersion: escrow.wrapVersion,
          };
        }),
      );

      // Zero-clear raw team key bytes
      newTeamKeyBytes.fill(0);

      // 5. POST rotation to server
      setPhase("submitting");

      // @stepup id:team-rotate-key-post
      const res = await fetchApi(apiPath.teamRotateKey(teamId), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          newTeamKeyVersion,
          entries: payload.entries,
          carry: payload.carry,
          memberKeys,
        }),
      });

      if (!res.ok) {
        const body = await readApiErrorBody(res);
        if (body?.error === API_ERROR.SESSION_STEP_UP_REQUIRED) {
          await inlineReauth.triggerOnStaleError();
        } else {
          toast.error(rotationErrorMessage(res.status, body?.error));
        }
        return;
      }

      // 6. Invalidate cached team key so next access fetches the new one
      invalidateTeamKey(teamId);

      toast.success(
        payload.carry.length > 0
          ? t("rotateKeySuccessWithCarry", { count: payload.carry.length })
          : t("rotateKeySuccess"),
      );
      setReport(
        carryReport(payload.carry, data.entries, heldVersions, await carriedVersionHolders(payload.carry)),
      );
      setOpen(false);
      setConfirmInput("");
      onSuccess?.();
    } catch (e) {
      clientLogError(CLIENT_LOG_EVENT.TEAM_KEY_ROTATION_FAILED, {
        code: toClientErrorCode(e),
      });
      toast.error(t("rotateKeyFailed"));
    } finally {
      newTeamKeyBytes?.fill(0);
      setLoading(false);
      setPhase("idle");
      setProgress({ current: 0, total: 0 });
    }
  };

  useEffect(() => {
    rotateRetryRef.current = () => handleRotate();
  });

  const progressLabel = describeProgress(phase, progress.current, progress.total);

  return (
    <>
    <AlertDialog open={open} onOpenChange={(v) => { if (!loading) { setOpen(v); if (!v) setConfirmInput(""); } }}>
      <AlertDialogTrigger asChild>
        <Button variant="destructive" size="sm" disabled={disabled}>
          <RotateCcw className="h-4 w-4 mr-2" />
          {t("rotateKeyButton")}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("rotateKeyTitle")}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2">
              <p>{t("rotateKeyDescription")}</p>
              <ul className="list-disc list-inside space-y-1 text-sm text-muted-foreground">
                <li>{t("rotateKeyWarning1")}</li>
                <li>{t("rotateKeyWarning2")}</li>
                <li>{t("rotateKeyWarning3")}</li>
              </ul>
              <div className="space-y-1 pt-2">
                <p className="text-sm font-medium">{t("rotateKeyTypePrompt")}</p>
                <Input
                  value={confirmInput}
                  onChange={(e) => setConfirmInput(e.target.value)}
                  placeholder={t("rotateKeyTypePlaceholder")}
                  disabled={loading}
                  autoComplete="off"
                />
              </div>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={loading}>{t("rotateKeyCancel")}</AlertDialogCancel>
          <Button
            variant="destructive"
            onClick={handleRotate}
            disabled={loading || confirmInput !== "rotate"}
          >
            {loading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {phase === "encrypting" && progressLabel
                  ? t("rotateKeyProgressEncrypting", { progress: progressLabel })
                  : t("rotateKeyInProgress")}
              </>
            ) : (
              t("rotateKeyConfirm")
            )}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>

      {report && <div className="mt-4"><RekeyReportView report={report} /></div>}

      <RecentSessionRequiredDialog
        {...inlineReauth.recentSessionDialogProps}
        cancelLabel={t("rotateKeyCancel")}
      />
      <PasskeyReauthDialog
        {...inlineReauth.reauthDialogProps}
        cancelLabel={t("rotateKeyCancel")}
      />
    </>
  );
}
