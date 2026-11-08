"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { KeyRound, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { RecentSessionRequiredDialog } from "@/components/auth/recent-session-required-dialog";
import { PasskeyReauthDialog } from "@/components/auth/passkey-reauth-dialog";
import { useInlineReauth } from "@/hooks/auth/use-inline-reauth";
import { apiPath } from "@/lib/constants";
import { fetchApi } from "@/lib/url-helpers";
import { useTeamVault } from "@/lib/team/team-vault-core";
import { REKEY_ENTRY_STATE } from "@/lib/constants/team/rotate-key";
import {
  REKEY_STOP_REASON,
  runRekeyPass,
  type RekeyListResponse,
  type RekeyPassResult,
} from "@/lib/team/rekey-runner";
import { buildRekeyReport, holderInputsFrom } from "@/lib/team/rekey-report";
import { RekeyReportView } from "@/components/team/security/rekey-report-view";
import { clientLogError, CLIENT_LOG_EVENT, toClientErrorCode } from "@/lib/logger/client";

interface TeamRekeyFinishControlProps {
  teamId: string;
  /** Start the pass as soon as the status is loaded (after a committed rotation). */
  autoStart?: boolean;
  /** Told when a pass starts and ends (the page holds rotation while one runs). */
  onRunningChange?: (running: boolean) => void;
}

type Status =
  | { kind: "loading" }
  | { kind: "hidden" }
  | { kind: "error" }
  | { kind: "ready"; list: RekeyListResponse };

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function fetchStatus(teamId: string): Promise<Status> {
  try {
    const res = await fetchApi(`${apiPath.teamRekey(teamId)}?limit=1`);
    // Not a TEAM_UPDATE holder (or no such team): the control is not offered.
    if (res.status === 403 || res.status === 404) return { kind: "hidden" };
    if (!res.ok) return { kind: "error" };
    return { kind: "ready", list: (await res.json()) as RekeyListResponse };
  } catch {
    return { kind: "error" };
  }
}

function holderNames(
  holders: RekeyListResponse["holders"],
  unknown: string,
): Record<number, string[]> {
  const out: Record<number, string[]> = {};
  for (const [version, list] of Object.entries(holders)) {
    out[Number(version)] = list.map((h) => h.name || h.email || unknown);
  }
  return out;
}

/**
 * "Finish re-key (N)": the re-key pass control for TEAM_UPDATE holders on the
 * key-rotation page (docs/archive/review/team-key-rotation-rekey-plan.md C3).
 */
export function TeamRekeyFinishControl({ teamId, autoStart = false, onRunningChange }: TeamRekeyFinishControlProps) {
  const t = useTranslations("Teams");
  const { resolveTeamKey, invalidateTeamKey } = useTeamVault();
  const [status, setStatus] = useState<Status>({ kind: "loading" });
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({ processed: 0, total: 0 });
  const [result, setResult] = useState<RekeyPassResult | null>(null);

  // Another team (same instance): drop the old team's status and report so
  // they are never shown under the new team (round-3 F-R3-1).
  const [prevTeamId, setPrevTeamId] = useState(teamId);
  if (prevTeamId !== teamId) {
    setPrevTeamId(teamId);
    setResult(null);
    setStatus({ kind: "loading" });
  }
  // Bumped at commit on a team change; a pass's closing status fetch applies
  // only if no change happened while it was in flight.
  const teamGenerationRef = useRef(0);
  useLayoutEffect(() => {
    teamGenerationRef.current += 1;
  }, [teamId]);

  // Step-up from inside the pass: the runner awaits this promise, resolved by
  // a completed re-authentication (true) or a dismissed dialog (false).
  const reauthWaiterRef = useRef<((ok: boolean) => void) | null>(null);
  const settleReauth = (ok: boolean) => {
    reauthWaiterRef.current?.(ok);
    reauthWaiterRef.current = null;
  };
  const inlineReauth = useInlineReauth(async () => settleReauth(true));
  const reauthenticate = () =>
    new Promise<boolean>((resolve) => {
      reauthWaiterRef.current = resolve;
      void inlineReauth.triggerOnStaleError();
    });

  // The running pass's controller: aborted when the control unmounts (a
  // remount after a rotation must not leave the old pass racing the new one).
  const abortRef = useRef<AbortController | null>(null);
  const onRunningChangeRef = useRef(onRunningChange);
  useEffect(() => {
    onRunningChangeRef.current = onRunningChange;
  });

  const runPass = async (total: number) => {
    const generation = teamGenerationRef.current;
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    onRunningChangeRef.current?.(true);
    setResult(null);
    setProgress({ processed: 0, total });
    try {
      const passResult = await runRekeyPass({
        teamId,
        signal: controller.signal,
        fetch: fetchApi,
        resolveKey: (version) => resolveTeamKey(teamId, version),
        invalidateTeamKeys: () => invalidateTeamKey(teamId),
        reauthenticate,
        sleep,
        onProgress: (p) => setProgress({ processed: p.processed, total: Math.max(total, p.pendingCount) }),
      });
      if (controller.signal.aborted) return;
      setResult(passResult);
    } catch (e) {
      if (controller.signal.aborted) return;
      clientLogError(CLIENT_LOG_EVENT.TEAM_KEY_ROTATION_FAILED, { code: toClientErrorCode(e) });
      setResult({
        status: "stopped",
        stop: { reason: REKEY_STOP_REASON.TRANSIENT },
        rekeyed: [],
        undecryptable: [],
        keyInvalid: [],
        notHeld: [],
        skipped: [],
        retained: [],
        attemptedByVersion: new Map(),
      });
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      // An aborted pass was already reported stopped by the cleanup.
      if (!controller.signal.aborted) {
        onRunningChangeRef.current?.(false);
        setRunning(false);
        const next = await fetchStatus(teamId);
        if (teamGenerationRef.current === generation) setStatus(next);
      }
    }
  };
  const runPassRef = useRef(runPass);
  useEffect(() => {
    runPassRef.current = runPass;
  });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const next = await fetchStatus(teamId);
      if (cancelled) return;
      setStatus(next);
      // A committed rotation starts the pass.
      if (autoStart && next.kind === "ready" && next.list.pendingCount > 0) {
        await runPassRef.current(next.list.pendingCount);
      }
    })();
    return () => {
      cancelled = true;
      if (abortRef.current) {
        abortRef.current.abort();
        abortRef.current = null;
        onRunningChangeRef.current?.(false);
        // The aborted pass's finally skips these: a re-run for another team
        // (same instance, new teamId) must not stay "running" (round-2 F N1).
        setRunning(false);
        setProgress({ processed: 0, total: 0 });
      }
      // A pass parked on re-authentication resumes, sees the abort and stops.
      reauthWaiterRef.current?.(false);
      reauthWaiterRef.current = null;
    };
  }, [teamId, autoStart]);

  if (status.kind === "hidden") return null;
  if (status.kind === "loading") {
    return <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden="true" />;
  }
  if (status.kind === "error") {
    return <p className="text-sm text-destructive">{t("rekeyLoadFailed")}</p>;
  }

  const { list } = status;
  const counts = list.stateCounts;
  const stopMessage = (r: RekeyPassResult) => {
    switch (r.stop?.reason) {
      case REKEY_STOP_REASON.STEP_UP_DECLINED:
        return t("rekeyStopStepUpDeclined");
      case REKEY_STOP_REASON.CURRENT_KEY_UNAVAILABLE:
        return t("rekeyStopCurrentKeyUnavailable");
      case REKEY_STOP_REASON.RETRY_BUDGET_EXHAUSTED:
        return t("rekeyStopRetryBudget");
      case REKEY_STOP_REASON.REFUSED:
        return null;
      default:
        return t("rekeyStopTransient");
    }
  };
  const stopCodeItems = result?.stop?.reason === REKEY_STOP_REASON.REFUSED && result.stop.code
    ? [{ entryId: result.stop.entryId ?? "", reason: result.stop.code }]
    : [];

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <h3 className="text-sm font-medium">{t("rekeyFinishTitle")}</h3>
        <p className="text-sm text-muted-foreground">{t("rekeyFinishDescription")}</p>
      </div>

      {list.pendingCount === 0 ? (
        <p className="text-sm text-muted-foreground">{t("rekeyNothingPending")}</p>
      ) : (
        <div className="space-y-1 text-sm">
          <p>{t("rekeyPendingCount", { count: list.pendingCount })}</p>
          <ul className="list-disc pl-5 text-muted-foreground">
            {counts[REKEY_ENTRY_STATE.READY] > 0 && (
              <li>{t("rekeyStateReady", { count: counts[REKEY_ENTRY_STATE.READY] })}</li>
            )}
            {counts[REKEY_ENTRY_STATE.NEEDS_REKEYER_HOLDER] > 0 && (
              <li>
                {t("rekeyStateNeedsRekeyerHolder", { count: counts[REKEY_ENTRY_STATE.NEEDS_REKEYER_HOLDER] })}
                {Object.entries(holderNames(list.holders, t("rekeyUnknownHolder"))).map(([version, names]) => (
                  <span key={version} className="block">
                    {t("rekeyOlderKeyHolders", { holders: names.join(", ") })}
                  </span>
                ))}
              </li>
            )}
            {counts[REKEY_ENTRY_STATE.HOLDER_CANNOT_REKEY] > 0 && (
              <li>{t("rekeyStateHolderCannotRekey", { count: counts[REKEY_ENTRY_STATE.HOLDER_CANNOT_REKEY] })}</li>
            )}
            {counts[REKEY_ENTRY_STATE.UNRECOVERABLE] > 0 && (
              <li>{t("rekeyStateUnrecoverable", { count: counts[REKEY_ENTRY_STATE.UNRECOVERABLE] })}</li>
            )}
          </ul>
        </div>
      )}
      {list.retainedHistoryCount > 0 && (
        <p className="text-sm text-muted-foreground">
          {t("rekeyRetainedHistory", { count: list.retainedHistoryCount })}
        </p>
      )}

      <Button
        variant="outline"
        size="sm"
        onClick={() => void runPass(list.pendingCount)}
        disabled={running || list.pendingCount === 0}
      >
        {running ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <KeyRound className="mr-2 h-4 w-4" />}
        {t("rekeyFinishButton", { count: list.pendingCount })}
      </Button>

      {running && (
        <p role="status" className="text-sm text-muted-foreground">
          {t("rekeyRunning", { processed: progress.processed, total: progress.total })}
        </p>
      )}

      {result && !running && (
        <div className="space-y-2">
          <p role="status" className="text-sm">
            {result.status === "completed"
              ? t("rekeyCompleted", { count: result.rekeyed.length })
              : t("rekeyStopped", { count: result.rekeyed.length })}
            {result.status === "stopped" && stopMessage(result) && (
              <span className="block text-muted-foreground">{stopMessage(result)}</span>
            )}
          </p>
          <RekeyReportView
            report={buildRekeyReport({
              ...passReportInput(result, t("rekeyUnknownHolder")),
              skipped: [...result.skipped, ...stopCodeItems],
            })}
          />
        </div>
      )}

      <RecentSessionRequiredDialog
        {...inlineReauth.recentSessionDialogProps}
        onOpenChange={(open) => {
          inlineReauth.recentSessionDialogProps.onOpenChange(open);
          if (!open) settleReauth(false);
        }}
        cancelLabel={t("rotateKeyCancel")}
      />
      <PasskeyReauthDialog
        {...inlineReauth.reauthDialogProps}
        onOpenChange={(open) => {
          inlineReauth.reauthDialogProps.onOpenChange(open);
          if (!open) settleReauth(false);
        }}
        cancelLabel={t("rotateKeyCancel")}
      />
    </div>
  );
}

/** The pass result and the final list counts as report input. */
function passReportInput(result: RekeyPassResult, unknownHolder: string) {
  const list = result.list;
  return {
    undecryptable: result.undecryptable,
    keyInvalid: result.keyInvalid,
    attemptedByVersion: result.attemptedByVersion,
    stateCounts: list?.stateCounts,
    rekeyerHoldersByVersion: list ? holderNames(list.holders, unknownHolder) : undefined,
    ...(list?.versionHolders ? holderInputsFrom(list.versionHolders, unknownHolder) : {}),
  };
}
