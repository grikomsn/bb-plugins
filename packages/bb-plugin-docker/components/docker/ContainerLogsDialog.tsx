import { useCallback, useEffect, useRef, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { DockerContainer, rpcContract } from "@/contract";

const TAIL_CHOICES = [100, 500, 2_000] as const;
type TailChoice = (typeof TAIL_CHOICES)[number];

export interface ContainerLogsDialogProps {
  container: DockerContainer;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function ContainerLogsDialog({
  container,
  open,
  onOpenChange,
}: ContainerLogsDialogProps) {
  const rpc = useRpc<typeof rpcContract>();
  const [tail, setTail] = useState<TailChoice>(100);
  const [lines, setLines] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const requestSequence = useRef(0);

  const refresh = useCallback(async (): Promise<void> => {
    if (!open) return;

    const requestId = ++requestSequence.current;
    setIsLoading(true);
    setError(null);

    try {
      const result = await rpc.call("logs", { id: container.id, tail });
      if (requestSequence.current !== requestId) return;
      setLines(result.lines);
    } catch (cause) {
      if (requestSequence.current !== requestId) return;
      setError(errorMessage(cause));
    } finally {
      if (requestSequence.current === requestId) setIsLoading(false);
    }
  }, [container.id, open, rpc, tail]);

  useEffect(() => {
    if (!open) {
      requestSequence.current += 1;
      setIsLoading(false);
      return;
    }

    void refresh();
    return () => {
      requestSequence.current += 1;
    };
  }, [open, refresh]);

  const output = lines.join("\n");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Logs · {container.name}</DialogTitle>
          <DialogDescription>
            Showing the latest {tail.toLocaleString()} lines from{" "}
            {container.image}.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-muted-foreground">Tail</span>
          <div aria-label="Log tail size" className="flex gap-1" role="group">
            {TAIL_CHOICES.map((choice) => (
              <Button
                key={choice}
                type="button"
                size="sm"
                variant={tail === choice ? "secondary" : "outline"}
                aria-pressed={tail === choice}
                disabled={isLoading && tail === choice}
                onClick={() => setTail(choice)}
              >
                {choice.toLocaleString()}
              </Button>
            ))}
          </div>
          <Button
            className="ml-auto"
            type="button"
            size="sm"
            variant="outline"
            disabled={isLoading}
            onClick={() => void refresh()}
          >
            {isLoading ? "Refreshing…" : "Refresh"}
          </Button>
        </div>

        {error ? (
          <div
            className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
            role="alert"
          >
            {error}
          </div>
        ) : null}

        <pre
          aria-busy={isLoading}
          aria-live="polite"
          className="max-h-96 min-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-muted/40 p-3 font-mono text-xs leading-relaxed"
        >
          {output || (isLoading ? "Loading logs…" : "No log lines returned.")}
        </pre>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
