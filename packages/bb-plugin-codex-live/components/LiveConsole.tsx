import type { LiveItemRpc, ThreadSnapshot } from "@/contract";
import { BackgroundTaskBlock } from "@/components/BackgroundTaskBlock";
import { CommandOutputBlock } from "@/components/CommandOutputBlock";
import { FileChangeBlock } from "@/components/FileChangeBlock";
import { ReasoningBlock } from "@/components/ReasoningBlock";
import { ToolProgressBar } from "@/components/ToolProgressBar";

interface Props {
  thread: ThreadSnapshot | null;
  isLoading?: boolean;
  error?: string | null;
  clearAfterSeconds?: number | null;
  onDismiss?: (itemId: string) => void;
}

const LABELS: Record<LiveItemRpc["kind"], string> = {
  reasoning: "Reasoning",
  commandExecution: "Command",
  fileChange: "File change",
  toolCall: "Tool call",
  mcpToolCall: "MCP tool",
  backgroundTask: "Background task",
};

function ItemBody({ item }: { item: LiveItemRpc }) {
  switch (item.kind) {
    case "reasoning":
      return <ReasoningBlock item={item} autoScroll />;
    case "commandExecution":
      return <CommandOutputBlock item={item} autoScroll />;
    case "fileChange":
      return <FileChangeBlock item={item} autoScroll />;
    case "toolCall":
    case "mcpToolCall":
      return <ToolProgressBar item={item} />;
    case "backgroundTask":
      return <BackgroundTaskBlock item={item} />;
  }
}

export function LiveConsole({
  thread,
  isLoading = false,
  error = null,
  clearAfterSeconds = 60,
  onDismiss,
}: Props) {
  if (isLoading && !thread) {
    return <div className="p-4 text-sm text-muted-foreground">Loading live stream…</div>;
  }
  if (error && !thread) {
    return <div className="p-4 text-sm text-destructive">Unable to load the live stream: {error}</div>;
  }
  if (!thread || thread.items.length === 0) {
    return (
      <div className="flex min-h-48 items-center justify-center p-6 text-center text-sm text-muted-foreground">
        No live Codex items for this thread. Reasoning, commands, file changes, and tool progress appear here while Codex is running.
      </div>
    );
  }

  return (
    <div className="space-y-3 p-3">
      {error ? <div className="text-xs text-destructive">Refresh failed: {error}</div> : null}
      {thread.items.map((item) => (
        <section key={item.itemId} className="rounded-lg border border-border bg-card p-3 text-card-foreground">
          <header className="mb-2 flex items-center gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide">{LABELS[item.kind]}</h3>
            {!item.completed ? (
              <span className="size-1.5 animate-pulse rounded-full bg-primary" aria-label="Streaming" />
            ) : (
              <span className="text-[10px] text-muted-foreground">
                kept for {clearAfterSeconds ?? 60}s
              </span>
            )}
            {item.truncated ? <span className="text-[10px] text-muted-foreground">truncated</span> : null}
            {item.completed && onDismiss ? (
              <button
                type="button"
                className="ml-auto rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
                onClick={() => onDismiss(item.itemId)}
                aria-label={`Dismiss ${LABELS[item.kind]}`}
              >
                Dismiss
              </button>
            ) : null}
          </header>
          <ItemBody item={item} />
        </section>
      ))}
    </div>
  );
}
