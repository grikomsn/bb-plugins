import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type { DockerSnapshot } from "@/contract";
import { PruneMenu } from "./PruneMenu";

export interface ConnectionBarProps {
  docker: DockerSnapshot["docker"];
  runningCount: number;
  onRefresh: () => void | Promise<void>;
  compact?: boolean;
}

export function ConnectionBar({
  docker,
  runningCount,
  onRefresh,
  compact = false,
}: ConnectionBarProps) {
  const [isRefreshing, setIsRefreshing] = useState(false);

  async function refresh(): Promise<void> {
    if (isRefreshing) return;

    setIsRefreshing(true);
    try {
      await onRefresh();
    } catch {
      // The owning snapshot hook exposes refresh failures in the page body.
    } finally {
      setIsRefreshing(false);
    }
  }

  if (compact) {
    return (
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={isRefreshing}
        onClick={() => void refresh()}
      >
        {isRefreshing ? "Refreshing…" : "Refresh"}
      </Button>
    );
  }

  const version = docker.serverVersion || docker.version || "Unknown";
  const statusLabel = docker.reachable
    ? `Docker is reachable. ${runningCount} running container${runningCount === 1 ? "" : "s"}.`
    : `Docker is unreachable${docker.error ? `: ${docker.error}` : "."}`;

  return (
    <Card className="flex flex-wrap items-center gap-x-4 gap-y-2 p-3">
      <div className="flex min-w-0 items-center gap-2">
        <span
          aria-label={statusLabel}
          className={`h-2.5 w-2.5 shrink-0 rounded-full ${
            docker.reachable ? "bg-green-500" : "bg-destructive"
          }`}
          role="status"
          title={statusLabel}
        />
        <span className="text-sm font-medium">
          {docker.reachable ? "Connected" : "Unavailable"}
        </span>
        <span className="text-xs text-muted-foreground">
          {runningCount} running
        </span>
      </div>

      <dl className="flex min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        <div className="flex min-w-0 items-center gap-1.5">
          <dt className="text-muted-foreground">Version</dt>
          <dd className="truncate font-mono">{version}</dd>
        </div>
        <div className="flex min-w-0 items-center gap-1.5">
          <dt className="text-muted-foreground">Context</dt>
          <dd className="truncate font-mono">{docker.context || "Unknown"}</dd>
        </div>
      </dl>

      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={isRefreshing}
        onClick={() => void refresh()}
      >
        {isRefreshing ? "Refreshing…" : "Refresh"}
      </Button>

      <PruneMenu onRefresh={onRefresh} />

      {!docker.reachable && docker.error ? (
        <p
          className="w-full truncate text-xs text-destructive"
          title={docker.error}
        >
          {docker.error}
        </p>
      ) : null}
    </Card>
  );
}
