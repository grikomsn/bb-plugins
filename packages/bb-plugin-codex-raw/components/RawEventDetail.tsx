// RawEventDetail — side panel that renders the full original JSON-RPC
// params envelope plus classification + rawType + ts + provider/parent
// context. Just JSON.stringify with caret-aware formatting; v1 doesn't
// ship type-specific decoders (deferred).

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { CodexRawEvent } from "../contract";

function safeStringify(value: unknown, indentOrSpace: string | number = 2): string {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(
      value,
      (key, v) => {
        if (typeof v === "bigint") return `${v.toString()}n`;
        if (typeof v === "function") return `[function ${(v as { name?: string }).name ?? "anonymous"}]`;
        if (v !== null && typeof v === "object") {
          if (seen.has(v as object)) return "[cyclic]";
          seen.add(v as object);
        }
        return v;
      },
      indentOrSpace,
    ) ?? "null";
  } catch {
    return "<unserializable>";
  }
}

type Props = {
  event: CodexRawEvent | null;
};

export function RawEventDetail({ event }: Props): React.ReactNode {
  const [copied, setCopied] = useState<"params" | "row" | null>(null);

  const paramsJson = useMemo(
    () => (event ? safeStringify(event.params ?? null) : ""),
    [event],
  );

  const rowJson = useMemo(
    () => (event ? safeStringify(event) : ""),
    [event],
  );

  if (!event) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Raw event detail</CardTitle>
          <CardDescription>
            Pick a row on the left to inspect its full payload, classification, and provider
            context. The detail panel renders the host-preserved JSON-RPC params verbatim.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  async function copy(text: string, key: "params" | "row"): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied(null), 1_500);
    } catch {
      // ignore — clipboard API may be denied
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="break-all font-mono text-sm" title={event.rawType}>
          {event.rawType}
          <span className="ml-2 text-xs font-normal text-muted-foreground">
            #{event.seq} · {event.classification}
          </span>
        </CardTitle>
        <CardDescription>
          {new Date(event.ts).toLocaleString()} · thread{" "}
          <span className="font-mono">{event.threadId}</span> · providerThread{" "}
          <span className="font-mono">{event.providerThreadId ?? "—"}</span>
          {event.parentToolCallId ? (
            <>
              {" "}· parent tool call <span className="font-mono">{event.parentToolCallId}</span>
            </>
          ) : null}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              params
            </h4>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void copy(paramsJson, "params")}
            >
              {copied === "params" ? "Copied" : "Copy"}
            </Button>
          </div>
          <pre className="max-h-[40vh] overflow-auto rounded bg-muted/40 p-2 text-[11px] leading-snug">
            <code>{paramsJson}</code>
          </pre>
        </div>
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              full row
            </h4>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void copy(rowJson, "row")}
            >
              {copied === "row" ? "Copied" : "Copy"}
            </Button>
          </div>
          <pre className="max-h-[28vh] overflow-auto rounded bg-muted/40 p-2 text-[11px] leading-snug">
            <code>{rowJson}</code>
          </pre>
        </div>
      </CardContent>
    </Card>
  );
}
