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
import { fetchApi, SessionChangedError } from "@/lib/url-helpers";
import { apiPath } from "@/lib/constants";
import { useTeamVault } from "@/lib/team/team-vault-core";
import { useVault } from "@/lib/vault/vault-context";
import { readApiErrorBody } from "@/lib/http/read-api-error-body";
import { API_ERROR, apiErrorToI18nKey } from "@/lib/http/api-error-codes";
import { PROXY_PRE_ROUTE_REFUSALS } from "@/lib/vault/pre-commit-refusals";
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

// Codes that prove the rotate-key POST was refused before its transaction
// committed (src/app/api/teams/[teamId]/rotate-key/route.ts). Anything else —
// a rejected fetch, a body that is not the app envelope (a proxy's 502/504
// page, the 500 Next renders for an uncaught throw, including a throw from the
// limiter clear() that runs after a committed rotation), or an unlisted code —
// leaves the outcome unknown.
//
// Emitted before the route runs: PROXY_PRE_ROUTE_REFUSALS.
// Emitted by the route before its transaction: UNAUTHORIZED, NOT_FOUND and
// FORBIDDEN (requireTeamPermission), SESSION_STEP_UP_REQUIRED (handled before
// this list), RATE_LIMIT_EXCEEDED, TEAM_NOT_FOUND, PAYLOAD_TOO_LARGE,
// INVALID_JSON, VALIDATION_ERROR, TEAM_KEY_VERSION_MISMATCH.
// Emitted from the transaction's catch, so rolled back: TEAM_KEY_VERSION_MISMATCH
// (version CAS, P2002), ACTOR_NOT_PERMITTED, TEAM_ROTATE_CARRY_INVALID,
// TEAM_ROTATE_KEY_UNAVAILABLE, ENTRY_COUNT_MISMATCH, TEAM_KEY_RECIPIENT_CHANGED,
// VALIDATION_ERROR (member-key set), TEAM_BUSY and CONFLICT (tenant-row lock
// timeout).
// After the commit the route returns only 200.
const ROTATE_REFUSALS: ReadonlySet<string> = new Set([
  ...PROXY_PRE_ROUTE_REFUSALS,
  API_ERROR.FORBIDDEN,
  API_ERROR.NOT_FOUND,
  API_ERROR.RATE_LIMIT_EXCEEDED,
  API_ERROR.TEAM_NOT_FOUND,
  API_ERROR.PAYLOAD_TOO_LARGE,
  API_ERROR.INVALID_JSON,
  API_ERROR.VALIDATION_ERROR,
  API_ERROR.TEAM_KEY_VERSION_MISMATCH,
  API_ERROR.ACTOR_NOT_PERMITTED,
  API_ERROR.TEAM_ROTATE_CARRY_INVALID,
  API_ERROR.TEAM_ROTATE_KEY_UNAVAILABLE,
  API_ERROR.ENTRY_COUNT_MISMATCH,
  API_ERROR.TEAM_KEY_RECIPIENT_CHANGED,
  API_ERROR.TEAM_BUSY,
  API_ERROR.CONFLICT,
]);

// ─── Component ───────────────────────────────────────────────

export function TeamRotateKeyButton({ teamId, onSuccess, disabled = false }: TeamRotateKeyButtonProps) {
  const t = useTranslations("Teams");
  const tApi = useTranslations("ApiErrors");
  const { resolveTeamKey, invalidateTeamKey } = useTeamVault();
  const { getLockEpoch, lockedSince } = useVault();
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

  const rotationErrorMessage = (status: number, code: string): string => {
    if (status === 429) return t("rotateKeyRateLimited");
    switch (code) {
      case API_ERROR.TEAM_KEY_VERSION_MISMATCH:
        return t("rotateKeyVersionConflict");
      case API_ERROR.ENTRY_COUNT_MISMATCH:
        return t("rotateKeyEntryMismatch");
      case API_ERROR.VALIDATION_ERROR:
        return t("rotateKeyMembersChanged");
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

  // The POST may have rotated the team: drop the cached key and refresh the
  // page as a commit would (the re-key status reloads), and say it is unknown.
  const onOutcomeUnknown = () => {
    invalidateTeamKey(teamId);
    toast.error(t("rotateKeyOutcomeUnknown"));
    setOpen(false);
    setConfirmInput("");
    onSuccess?.();
  };

  const handleRotate = async () => {
    // The new key is distributed from the current one this vault unwrapped: a
    // lock (or a session end or user switch) since the start sends nothing.
    const lockEpoch = getLockEpoch();
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
            recipientKeyFingerprint: escrow.recipientKeyFingerprint,
          };
        }),
      );

      // Zero-clear raw team key bytes
      newTeamKeyBytes.fill(0);

      // 5. POST rotation to server
      if (lockedSince(lockEpoch)) {
        toast.error(t("rotateKeyVaultRequired"));
        return;
      }
      setPhase("submitting");

      let res: Response;
      try {
        // @stepup id:team-rotate-key-post
        res = await fetchApi(apiPath.teamRotateKey(teamId), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            newTeamKeyVersion,
            entries: payload.entries,
            carry: payload.carry,
            memberKeys,
          }),
        });
      } catch (e) {
        // Refused by the proxy before the route ran: nothing was rotated. The
        // page is reloading for the session that replaced this one.
        if (e instanceof SessionChangedError) {
          toast.error(tApi("sessionChanged"));
          return;
        }
        onOutcomeUnknown();
        return;
      }

      if (!res.ok) {
        const body = await readApiErrorBody(res);
        if (body?.error === API_ERROR.SESSION_STEP_UP_REQUIRED) {
          await inlineReauth.triggerOnStaleError();
        } else if (body && ROTATE_REFUSALS.has(body.error)) {
          toast.error(rotationErrorMessage(res.status, body.error));
        } else {
          onOutcomeUnknown();
        }
        return;
      }

      // Committed: the route answers 2xx only after its transaction, and its
      // body is never read here, so an unreadable 2xx body is still a commit.

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
