import { useCallback, useState, type KeyboardEvent, type MouseEvent } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";

import type { DockerContainer, rpcContract } from "../../contract";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../ui/card";
import { ConfirmDialog } from "./ConfirmDialog";
import { ContainerExecDialog } from "./ContainerExecDialog";
import { ContainerLogsDialog } from "./ContainerLogsDialog";

type ContainerAction = "start" | "stop" | "restart" | "remove";

interface ContainersCardProps {
  containers: DockerContainer[];
  onRefresh: () => void | Promise<void>;
}

function stateTone(state: string): string {
  switch (state.toLowerCase()) {
    case "running":
      return "bg-green-500/15 text-green-700 dark:text-green-300";
    case "paused":
    case "restarting":
      return "bg-amber-500/15 text-amber-700 dark:text-amber-300";
    case "dead":
    case "removing":
      return "bg-destructive/10 text-destructive";
    default:
      return "bg-muted text-muted-foreground";
  }
}

function stopRowToggle(event: MouseEvent<HTMLElement>): void {
  event.stopPropagation();
}

export function ContainersCard({
  containers,
  onRefresh,
}: ContainersCardProps) {
  const rpc = useRpc<typeof rpcContract>();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [inlineLogs, setInlineLogs] = useState<Record<string, string[]>>({});
  const [logsLoadingId, setLogsLoadingId] = useState<string | null>(null);
  const [logsError, setLogsError] = useState<Record<string, string>>({});
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [logsContainer, setLogsContainer] = useState<DockerContainer | null>(
    null,
  );
  const [execContainer, setExecContainer] = useState<DockerContainer | null>(
    null,
  );

  const loadInlineLogs = useCallback(
    async (container: DockerContainer): Promise<void> => {
      setLogsLoadingId(container.id);
      setLogsError((current) => {
        const next = { ...current };
        delete next[container.id];
        return next;
      });

      try {
        const result = await rpc.call("logs", { id: container.id, tail: 200 });
        setInlineLogs((current) => ({
          ...current,
          [container.id]: result.lines,
        }));
      } catch (error) {
        setLogsError((current) => ({
          ...current,
          [container.id]: error instanceof Error ? error.message : String(error),
        }));
      } finally {
        setLogsLoadingId((current) =>
          current === container.id ? null : current,
        );
      }
    },
    [rpc],
  );

  const toggleContainer = useCallback(
    (container: DockerContainer): void => {
      if (expandedId === container.id) {
        setExpandedId(null);
        return;
      }

      setExpandedId(container.id);
      void loadInlineLogs(container);
    },
    [expandedId, loadInlineLogs],
  );

  async function runAction(
    container: DockerContainer,
    action: ContainerAction,
  ): Promise<void> {
    const actionKey = `${container.id}:${action}`;
    setPendingAction(actionKey);
    setActionError(null);

    try {
      const result = await rpc.call("containerAction", {
        id: container.id,
        action,
        ...(action === "remove" ? { force: false } : {}),
      });
      if (!result.ok) {
        throw new Error(result.error ?? `Could not ${action} ${container.name}.`);
      }
      if (action === "remove") {
        setExpandedId((current) =>
          current === container.id ? null : current,
        );
      }
      await onRefresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setActionError(message);
      if (action === "remove") throw new Error(message);
    } finally {
      setPendingAction((current) => (current === actionKey ? null : current));
    }
  }

  function handleRowKeyDown(
    event: KeyboardEvent<HTMLTableRowElement>,
    container: DockerContainer,
  ): void {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      toggleContainer(container);
    }
  }

  return (
    <>
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center justify-between gap-3">
            <span>Containers</span>
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
              {containers.length}
            </span>
          </CardTitle>
          <CardDescription>
            Start, stop, inspect logs, and manage Docker containers.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          {actionError ? (
            <div
              className="mx-6 mb-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              role="alert"
            >
              {actionError}
            </div>
          ) : null}

          {containers.length === 0 ? (
            <div className="border-t border-border px-6 py-8 text-center text-sm text-muted-foreground">
              No containers found.
            </div>
          ) : (
            <div className="overflow-x-auto border-t border-border">
              <table className="w-full min-w-[760px] text-left text-sm">
                <thead className="bg-muted/40 text-xs text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2.5 font-medium">Name</th>
                    <th className="px-4 py-2.5 font-medium">Image</th>
                    <th className="px-4 py-2.5 font-medium">State</th>
                    <th className="px-4 py-2.5 font-medium">Ports</th>
                    <th className="px-4 py-2.5 font-medium">Uptime</th>
                    <th className="px-4 py-2.5 text-right font-medium">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {containers.map((container) => {
                    const isExpanded = expandedId === container.id;
                    const isRunning = container.state.toLowerCase() === "running";
                    const isBusy = pendingAction?.startsWith(`${container.id}:`);

                    return (
                      <FragmentRow
                        key={container.id}
                        container={container}
                        isExpanded={isExpanded}
                        isRunning={isRunning}
                        isBusy={Boolean(isBusy)}
                        pendingAction={pendingAction}
                        logsLoading={logsLoadingId === container.id}
                        logLines={inlineLogs[container.id]}
                        logsError={logsError[container.id]}
                        onToggle={() => toggleContainer(container)}
                        onKeyDown={(event) =>
                          handleRowKeyDown(event, container)
                        }
                        onAction={(action) => void runAction(container, action)}
                        onOpenLogs={() => setLogsContainer(container)}
                        onOpenExec={() => setExecContainer(container)}
                        onRemove={() => runAction(container, "remove")}
                      />
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {logsContainer ? (
        <ContainerLogsDialog
          container={logsContainer}
          open
          onOpenChange={(open) => {
            if (!open) setLogsContainer(null);
          }}
        />
      ) : null}

      {execContainer ? (
        <ContainerExecDialog
          container={execContainer}
          open
          onOpenChange={(open) => {
            if (!open) setExecContainer(null);
          }}
        />
      ) : null}

    </>
  );
}

interface FragmentRowProps {
  container: DockerContainer;
  isExpanded: boolean;
  isRunning: boolean;
  isBusy: boolean;
  pendingAction: string | null;
  logsLoading: boolean;
  logLines: string[] | undefined;
  logsError: string | undefined;
  onToggle: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLTableRowElement>) => void;
  onAction: (action: Exclude<ContainerAction, "remove">) => void;
  onOpenLogs: () => void;
  onOpenExec: () => void;
  onRemove: () => Promise<void>;
}

function FragmentRow({
  container,
  isExpanded,
  isRunning,
  isBusy,
  pendingAction,
  logsLoading,
  logLines,
  logsError,
  onToggle,
  onKeyDown,
  onAction,
  onOpenLogs,
  onOpenExec,
  onRemove,
}: FragmentRowProps) {
  const actionKey = (action: ContainerAction) =>
    pendingAction === `${container.id}:${action}`;

  return (
    <>
      <tr
        className="cursor-pointer transition-colors hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
        tabIndex={0}
        aria-expanded={isExpanded}
        onClick={onToggle}
        onKeyDown={onKeyDown}
      >
        <td className="max-w-44 px-4 py-3 align-top">
          <div className="truncate font-medium text-foreground">
            {container.name}
          </div>
          <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
            {container.id.slice(0, 12)}
          </div>
        </td>
        <td className="max-w-48 truncate px-4 py-3 align-top text-muted-foreground">
          {container.image}
        </td>
        <td className="px-4 py-3 align-top">
          <span
            className={cn(
              "inline-flex rounded-full px-2 py-0.5 text-xs font-medium capitalize",
              stateTone(container.state),
            )}
          >
            {container.state}
          </span>
          <div className="mt-1 max-w-40 truncate text-xs text-muted-foreground">
            {container.status}
          </div>
        </td>
        <td className="max-w-48 px-4 py-3 align-top text-xs text-muted-foreground">
          <span className="line-clamp-2">{container.ports || "—"}</span>
        </td>
        <td className="whitespace-nowrap px-4 py-3 align-top text-muted-foreground">
          {container.uptime || "—"}
        </td>
        <td
          className="px-4 py-2 align-top"
          onClick={stopRowToggle}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <div className="flex flex-wrap justify-end gap-1">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={isBusy || isRunning}
              aria-label={`Start ${container.name}`}
              onClick={() => onAction("start")}
            >
              {actionKey("start") ? "Starting…" : "Start"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={isBusy || !isRunning}
              aria-label={`Stop ${container.name}`}
              onClick={() => onAction("stop")}
            >
              {actionKey("stop") ? "Stopping…" : "Stop"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={isBusy}
              aria-label={`Restart ${container.name}`}
              onClick={() => onAction("restart")}
            >
              {actionKey("restart") ? "Restarting…" : "Restart"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={isBusy}
              aria-label={`Open logs for ${container.name}`}
              onClick={onOpenLogs}
            >
              Logs
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={isBusy}
              aria-label={`Exec in ${container.name}`}
              onClick={onOpenExec}
            >
              Exec
            </Button>
            <ConfirmDialog
              title="Remove container?"
              description={`Remove ${container.name}? This action cannot be undone.`}
              confirmLabel="Remove"
              variant="destructive"
              onConfirm={onRemove}
              trigger={
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={isBusy}
                  className="text-destructive hover:text-destructive"
                  aria-label={`Remove ${container.name}`}
                >
                  {actionKey("remove") ? "Removing…" : "Remove"}
                </Button>
              }
            />
          </div>
        </td>
      </tr>
      {isExpanded ? (
        <tr className="bg-muted/20">
          <td colSpan={6} className="px-4 py-3">
            <div className="mb-2 flex items-center justify-between gap-3">
              <span className="text-xs font-medium text-foreground">
                Last 200 log lines
              </span>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={onOpenLogs}
              >
                Open log viewer
              </Button>
            </div>
            {logsLoading ? (
              <div className="rounded-md border border-border bg-background px-3 py-6 text-center text-xs text-muted-foreground">
                Loading logs…
              </div>
            ) : logsError ? (
              <div
                className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
                role="alert"
              >
                {logsError}
              </div>
            ) : (
              <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-background p-3 font-mono text-xs leading-relaxed text-foreground">
                {logLines?.join("\n") || "No log output."}
              </pre>
            )}
          </td>
        </tr>
      ) : null}
    </>
  );
}
