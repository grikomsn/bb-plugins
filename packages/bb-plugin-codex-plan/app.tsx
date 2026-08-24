// bb-plugin-codex-plan — frontend entry.
//
// Surfaces the active codex plan in three places:
//
//   1. Nav panel "Codex Plan" — fleet picker showing every tracked thread's
//      latest plan + explanation, plus a quick switcher.
//   2. Thread header pill — "Plan ready" badge while a reviewable (not-yet-
//      decided) plan is active for the current thread.
//   3. Thread right-panel tab — full plan, explanation, decide dialog.
//
// Subscribes to `codex-plan/snapshot` (per-thread change) and
// `codex-plan/decided` (so the UI dismisses after the user decides) realtime
// pulses from server.ts.

import { useEffect, useMemo, useState } from "react";
import {
  definePluginApp,
  useBbNavigate,
} from "@get-bb/plugin-sdk/app";
import type { CodexPlanSnapshot } from "@/lib/codex-plan";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { PlanList } from "@/components/PlanList";
import { PlanExplanation } from "@/components/PlanExplanation";
import {
  PlanDecideDialog,
  type DecideKind,
} from "@/components/PlanDecideDialog";
import {
  useDecide,
  usePlansSnapshot,
  useThreadPlan,
} from "@/hooks/useCodexPlan";
import { cn } from "@/lib/utils";

function relative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 1_000) return "now";
  if (ms < 60_000) return `${Math.round(ms / 1_000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  return new Date(iso).toLocaleTimeString();
}

function decisionLabel(decision: CodexPlanSnapshot["decision"]): string | null {
  if (!decision) return null;
  if (decision.kind === "approved") return "approved";
  if (decision.kind === "rejected") return "rejected";
  return "changes requested";
}

function decisionTone(decision: CodexPlanSnapshot["decision"]): string {
  if (!decision) return "bg-primary/10 text-primary";
  if (decision.kind === "approved") return "bg-success/10 text-success";
  if (decision.kind === "rejected") {
    return "bg-destructive/10 text-destructive";
  }
  return "bg-secondary text-secondary-foreground";
}

// ─── Nav panel — fleet-level overview + per-thread detail ─────────────

function PlanCard({
  snapshot,
  active,
  onOpen,
}: {
  snapshot: CodexPlanSnapshot;
  active: boolean;
  onOpen: () => void;
}) {
  const totals = useMemo(
    () =>
      snapshot.plan.reduce(
        (acc, s) => {
          if (s.status === "completed") acc.completed += 1;
          else if (s.status === "in_progress") acc.inProgress += 1;
          else if (s.status === "pending") acc.pending += 1;
          else if (s.status === "failed") acc.failed += 1;
          return acc;
        },
        { completed: 0, inProgress: 0, pending: 0, failed: 0 },
      ),
    [snapshot.plan],
  );
  const label = decisionLabel(snapshot.decision);

  return (
    <Card
      className={cn(
        "cursor-pointer transition-colors hover:bg-muted/30",
        active && "ring-2 ring-primary/30",
      )}
      onClick={onOpen}
    >
      <CardHeader>
        <CardTitle className="flex items-baseline gap-2 text-sm">
          <span className="font-mono text-xs text-muted-foreground">
            {snapshot.threadId.slice(-12)}
          </span>
          {label && (
            <span
              className={cn(
                "rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide",
                decisionTone(snapshot.decision),
              )}
            >
              {label}
            </span>
          )}
        </CardTitle>
        <CardDescription>
          Updated {relative(snapshot.ts)} •{" "}
          <span className="font-mono">
            {totals.completed}/{snapshot.plan.length}
          </span>{" "}
          steps done
          {totals.inProgress > 0 ? (
            <>
              {" • "}
              <span className="font-mono">{totals.inProgress}</span>{" "}
              in progress
            </>
          ) : null}
        </CardDescription>
      </CardHeader>
      {snapshot.explanation && (
        <CardContent>
          <p className="line-clamp-3 text-sm text-muted-foreground">
            {snapshot.explanation.slice(0, 320)}
          </p>
        </CardContent>
      )}
    </Card>
  );
}

function CodexPlanPage() {
  const snapshot = usePlansSnapshot();
  const navigate = useBbNavigate();
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);

  // Default-select first thread (newest plan) when one shows up.
  useEffect(() => {
    if (!snapshot) return;
    if (
      activeThreadId &&
      snapshot.snapshots.some((s) => s.threadId === activeThreadId)
    )
      return;
    const next = snapshot.snapshots[0]?.threadId ?? null;
    if (next) setActiveThreadId(next);
  }, [snapshot, activeThreadId]);

  if (!snapshot) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Codex Plan</CardTitle>
          <CardDescription>
            Polling <code className="font-mono">codex-events-bridge</code>…
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  if (snapshot.snapshots.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Codex Plan</CardTitle>
          <CardDescription>
            No codex thread has published a <code>turn/plan/updated</code>{" "}
            yet. Trigger a plan in codex (a long task with multiple steps)
            and it will appear here within the next poll tick.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const active =
    snapshot.snapshots.find((s) => s.threadId === activeThreadId) ?? null;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Codex Plan · fleet</CardTitle>
          <CardDescription>
            {snapshot.snapshots.length} tracked thread
            {snapshot.snapshots.length === 1 ? "" : "s"} • chokepoint{" "}
            <code className="font-mono">{snapshot.chokepoint}</code>
          </CardDescription>
        </CardHeader>
      </Card>

      {active && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-baseline gap-2">
              <span className="font-mono text-xs text-muted-foreground">
                {active.threadId}
              </span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  navigate.toThread(active.threadId);
                }}
              >
                Open thread
              </Button>
            </CardTitle>
            <CardDescription>
              Updated {relative(active.ts)}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <PlanActionsRow threadId={active.threadId} snapshot={active} />
          </CardContent>
          <CardContent className="space-y-4">
            <div>
              <h3 className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">
                Steps
              </h3>
              <PlanList snapshot={active} />
            </div>
            <div>
              <h3 className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">
                Explanation
              </h3>
              <PlanExplanation text={active.explanation} />
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-3">
        {snapshot.snapshots.map((s) => (
          <PlanCard
            key={s.threadId}
            snapshot={s}
            active={s.threadId === activeThreadId}
            onOpen={() => setActiveThreadId(s.threadId)}
          />
        ))}
      </div>
    </div>
  );
}

function CodexPlanNavPanel() {
  return (
    <div className="p-4 md:p-5">
      <div className="mx-auto w-full max-w-3xl">
        <CodexPlanPage />
      </div>
    </div>
  );
}

function PlanActionsRow({
  threadId,
  snapshot,
}: {
  threadId: string;
  snapshot: CodexPlanSnapshot;
}) {
  const decide = useDecide(threadId);
  const [busy, setBusy] = useState<DecideKind | null>(null);
  const [dialog, setDialog] = useState<DecideKind | null>(null);
  const alreadyDecided = snapshot.decision !== null;

  return (
    <div className="flex flex-wrap gap-2">
      {alreadyDecided ? (
        <span
          className={cn(
            "rounded px-2 py-1 text-xs",
            decisionTone(snapshot.decision),
          )}
        >
          {decisionLabel(snapshot.decision)} •{" "}
          {snapshot.decision && relative(snapshot.decision.at)}
        </span>
      ) : (
        <>
          <Button
            size="sm"
            variant="default"
            disabled={busy !== null}
            onClick={() => setDialog("approve")}
          >
            Approve
          </Button>
          <Button
            size="sm"
            variant="destructive"
            disabled={busy !== null}
            onClick={() => setDialog("reject")}
          >
            Reject
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy !== null}
            onClick={() => setDialog("request-changes")}
          >
            Request changes
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy !== null}
            onClick={async () => {
              setBusy("approve");
              try {
                await decide({ decision: "approve" });
              } finally {
                setBusy(null);
              }
            }}
          >
            {busy === "approve" ? "Sending…" : "Approve without note"}
          </Button>
        </>
      )}
      <PlanDecideDialog
        open={dialog !== null}
        onOpenChange={(v) => setDialog(v ? dialog : null)}
        kind={dialog}
        threadId={threadId}
        onConfirm={async ({ kind, message }) => {
          setBusy(kind);
          try {
            await decide({ decision: kind, message });
          } finally {
            setBusy(null);
          }
        }}
      />
    </div>
  );
}

// ─── Thread header pill ──────────────────────────────────────────────

function ThreadPlanPill({ threadId }: { threadId: string }) {
  const navigate = useBbNavigate();
  const { snapshot } = useThreadPlan(threadId);
  if (!snapshot) return null;
  if (snapshot.plan.length === 0 && snapshot.explanation === null) return null;
  if (snapshot.decision !== null) return null;

  return (
    <button
      type="button"
      onClick={() =>
        navigate.openThreadPanel({
          actionId: "codex-plan-overview",
          title: "Codex Plan",
        })
      }
      className={cn(
        "flex items-center gap-1.5 rounded border border-border/60 bg-background/40 px-1.5 py-0.5 text-[10px] uppercase tracking-wide transition-colors hover:bg-muted/60",
        decisionTone(null),
      )}
      title={`Plan ready: ${snapshot.plan.length} step(s)`}
    >
      <span aria-hidden="true">📋</span>
      <span>Plan ready</span>
    </button>
  );
}

// ─── Thread right-panel tab ──────────────────────────────────────────

function PlanThreadPanel({ threadId }: { threadId: string }) {
  const { snapshot, providerThreadId } = useThreadPlan(threadId);

  if (!snapshot) {
    return (
      <div className="space-y-3 p-3">
        <p className="text-sm text-muted-foreground">
          No plan published for this thread yet. Codex emits{" "}
          <code className="font-mono">turn/plan/updated</code> once its plan
          is ready for review.
        </p>
        {providerThreadId ? (
          <p className="text-xs text-muted-foreground">
            Provider session:{" "}
            <code className="font-mono">{providerThreadId}</code>
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-4 p-3">
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-xs text-muted-foreground">
          {snapshot.threadId}
        </span>
        {snapshot.decision && (
          <span
            className={cn(
              "rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide",
              decisionTone(snapshot.decision),
            )}
          >
            {decisionLabel(snapshot.decision)}
          </span>
        )}
        <span className="ml-auto text-xs text-muted-foreground">
          {relative(snapshot.ts)}
        </span>
      </div>

      <PlanActionsRow threadId={threadId} snapshot={snapshot} />

      <div>
        <h3 className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">
          Steps
        </h3>
        <PlanList snapshot={snapshot} />
      </div>

      <div>
        <h3 className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">
          Explanation
        </h3>
        <PlanExplanation text={snapshot.explanation} />
      </div>
    </div>
  );
}

// ─── Settings section (history inspector) ────────────────────────────

function SettingsHistoryPanel() {
  const snapshot = usePlansSnapshot();

  if (!snapshot) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Codex Plan</CardTitle>
          <CardDescription>Loading…</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Codex Plan</CardTitle>
        <CardDescription>
          {snapshot.snapshots.length} tracked thread
          {snapshot.snapshots.length === 1 ? "" : "s"}. Plans are stored
          in-memory per thread; the chokepoint keeps the source-of-truth ring
          (see Codex Events Bridge → settings).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {snapshot.snapshots.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No plans tracked. Trigger a codex plan to start populating this
            view.
          </p>
        ) : (
          snapshot.snapshots.map((s) => (
            <div
              key={s.threadId}
              className="space-y-3 rounded border border-border p-3"
            >
              <div className="flex items-center justify-between gap-2">
                <code className="truncate text-xs text-muted-foreground">
                  {s.threadId}
                </code>
                <span className="text-xs text-muted-foreground">
                  {relative(s.ts)}
                </span>
              </div>
              <PlanList snapshot={s} />
              <PlanExplanation text={s.explanation} />
              <PlanActionsRow threadId={s.threadId} snapshot={s} />
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}

export default definePluginApp((app) => {
  // Nav panel: day-to-day affordance — plans are reviewed often enough that
  // they deserve a dedicated entry rather than being tucked into the
  // settings page (matches the docker-thread decision).
  app.slots.navPanel({
    id: "codex-plan",
    title: "Codex Plan",
    icon: "ListChecks",
    path: "codex-plan",
    component: CodexPlanNavPanel,
  });

  // Thread header — compact "Plan ready" pill while an undecided plan is
  // active. Hidden once the user approves / rejects / requests changes.
  app.slots.experimental_threadHeaderAction({
    id: "codex-plan-header",
    title: "Active plan",
    component: ThreadPlanPill,
  });

  // Right-panel: full plan + explanation + decide actions.
  app.slots.threadPanelAction({
    id: "codex-plan-overview",
    title: "Codex Plan",
    icon: "ListChecks",
    component: PlanThreadPanel,
  });

  // Settings section — quick history panel for cross-thread review.
  app.slots.settingsSection({
    id: "codex-plan",
    title: "Codex Plan",
    description:
      "Per-thread plan inspector and decide actions. Powered by codex-events-bridge; visit Codex Events Bridge to tune poll cadence or ring capacity.",
    component: SettingsHistoryPanel,
  });
});
