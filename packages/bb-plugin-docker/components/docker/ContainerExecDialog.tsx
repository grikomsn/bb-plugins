import { useEffect, useId, useRef, useState } from "react";
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
import { Input } from "@/components/ui/input";
import type { DockerContainer, rpcContract } from "@/contract";

const DEFAULT_COMMAND = 'sh -c "ls -la"';

interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ContainerExecDialogProps {
  container: DockerContainer;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Split a command into argv without evaluating it in a shell. Quotes group
 * whitespace and backslashes escape the following character.
 */
export function parseCommandLine(command: string): string[] {
  const argv: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaping = false;
  let tokenStarted = false;

  for (const character of command) {
    if (escaping) {
      current += character;
      escaping = false;
      tokenStarted = true;
      continue;
    }

    if (character === "\\" && quote !== "'") {
      escaping = true;
      tokenStarted = true;
      continue;
    }

    if (quote) {
      if (character === quote) {
        quote = null;
      } else {
        current += character;
      }
      tokenStarted = true;
      continue;
    }

    if (character === "'" || character === '"') {
      quote = character;
      tokenStarted = true;
      continue;
    }

    if (/\s/.test(character)) {
      if (tokenStarted) {
        argv.push(current);
        current = "";
        tokenStarted = false;
      }
      continue;
    }

    current += character;
    tokenStarted = true;
  }

  if (escaping) {
    throw new Error("Command cannot end with an escape character.");
  }
  if (quote) {
    throw new Error(`Command has an unterminated ${quote} quote.`);
  }
  if (tokenStarted) argv.push(current);

  if (argv.length === 0) {
    throw new Error("Enter a command to run.");
  }

  return argv;
}

export function ContainerExecDialog({
  container,
  open,
  onOpenChange,
}: ContainerExecDialogProps) {
  const rpc = useRpc<typeof rpcContract>();
  const containerInputId = useId();
  const commandInputId = useId();
  const requestSequence = useRef(0);
  const [command, setCommand] = useState(DEFAULT_COMMAND);
  const [result, setResult] = useState<ExecResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isRunning, setIsRunning] = useState(false);

  useEffect(() => {
    if (open) {
      setCommand(DEFAULT_COMMAND);
      setResult(null);
      setError(null);
      setIsRunning(false);
    } else {
      requestSequence.current += 1;
    }

    return () => {
      requestSequence.current += 1;
    };
  }, [container.id, open]);

  async function run(): Promise<void> {
    if (isRunning) return;

    let argv: string[];
    try {
      argv = parseCommandLine(command);
    } catch (cause) {
      setError(errorMessage(cause));
      return;
    }

    const requestId = ++requestSequence.current;
    setIsRunning(true);
    setResult(null);
    setError(null);

    try {
      const nextResult = await rpc.call("exec", {
        id: container.id,
        cmd: argv,
      });
      if (requestSequence.current !== requestId) return;
      setResult(nextResult);
    } catch (cause) {
      if (requestSequence.current !== requestId) return;
      setError(errorMessage(cause));
    } finally {
      if (requestSequence.current === requestId) setIsRunning(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Exec · {container.name}</DialogTitle>
          <DialogDescription>
            Run a bounded, non-interactive command in this container.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <label
              className="text-xs font-medium text-muted-foreground"
              htmlFor={containerInputId}
            >
              Container
            </label>
            <Input
              id={containerInputId}
              className="font-mono"
              value={container.name}
              readOnly
            />
          </div>

          <div className="grid gap-1.5">
            <label
              className="text-xs font-medium text-muted-foreground"
              htmlFor={commandInputId}
            >
              Command
            </label>
            <div className="flex gap-2">
              <Input
                id={commandInputId}
                className="font-mono"
                value={command}
                disabled={isRunning}
                onChange={(event) => setCommand(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void run();
                }}
              />
              <Button
                type="button"
                disabled={isRunning || command.trim().length === 0}
                onClick={() => void run()}
              >
                {isRunning ? "Running…" : "Run"}
              </Button>
            </div>
          </div>

          <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            TTY interactive sessions are not supported in the sidebar.
          </p>
        </div>

        {error ? (
          <div
            className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
            role="alert"
          >
            {error}
          </div>
        ) : null}

        <div className="grid gap-3" aria-live="polite">
          <section>
            <h3 className="mb-1 text-xs font-medium text-muted-foreground">
              stdout
            </h3>
            <pre className="max-h-48 min-h-20 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-muted/40 p-3 font-mono text-xs leading-relaxed">
              {result?.stdout || (isRunning ? "Running command…" : "No output.")}
            </pre>
          </section>

          <section>
            <h3 className="mb-1 text-xs font-medium text-muted-foreground">
              stderr
            </h3>
            <pre className="max-h-32 min-h-16 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-muted/40 p-3 font-mono text-xs leading-relaxed">
              {result?.stderr || "No output."}
            </pre>
          </section>

          <p className="font-mono text-xs text-muted-foreground">
            Exit code: {result ? result.exitCode : "—"}
          </p>
        </div>

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
