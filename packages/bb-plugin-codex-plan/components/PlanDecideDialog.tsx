// PlanDecideDialog — modal that asks for confirmation + an optional message
// before synthesising a `<plan_decision>...</plan_decision>` envelope and
// sending it back to the thread. Approve/Reject skip the message; Request
// changes requires one.

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export type DecideKind = "approve" | "reject" | "request-changes";

const HEADLINES: Record<DecideKind, string> = {
  approve: "Approve plan?",
  reject: "Reject plan?",
  "request-changes": "Request changes to plan?",
};

const SUBTITLES: Record<DecideKind, string> = {
  approve:
    "Codex will continue executing from the plan. A short note is optional.",
  reject:
    "Codex will discard this plan. Tell it why so the next attempt knows what to avoid.",
  "request-changes":
    "Codex will revise this plan based on your note. Be specific — step-level guidance helps.",
};

const BUTTON_LABEL: Record<DecideKind, string> = {
  approve: "Approve",
  reject: "Reject",
  "request-changes": "Send request",
};

type Args = {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  kind: DecideKind | null;
  threadId: string;
  onConfirm: (input: { kind: DecideKind; message?: string }) => Promise<void> | void;
};

export function PlanDecideDialog({
  open,
  onOpenChange,
  kind,
  threadId,
  onConfirm,
}: Args) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  if (!kind) return null;

  const requireMessage = kind === "request-changes";
  const canSubmit =
    !busy && (!requireMessage || message.trim().length > 0);

  async function submit(): Promise<void> {
    if (!kind) return;
    if (requireMessage && message.trim().length === 0) return;
    setBusy(true);
    try {
      await onConfirm({
        kind,
        message: message.trim().length > 0 ? message.trim() : undefined,
      });
      onOpenChange(false);
      setMessage("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) setMessage("");
        onOpenChange(v);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{HEADLINES[kind]}</DialogTitle>
          <DialogDescription>
            Thread{" "}
            <span className="font-mono">
              {threadId.slice(-12)}
            </span>{" "}
            • {SUBTITLES[kind]}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <label
            htmlFor="plan-decide-message"
            className="text-xs uppercase tracking-wide text-muted-foreground"
          >
            {requireMessage ? "Message (required)" : "Message (optional)"}
          </label>
          <Input
            id="plan-decide-message"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder={
              kind === "approve"
                ? "e.g. looks good"
                : kind === "reject"
                  ? "e.g. wrong direction entirely"
                  : "e.g. skip the schema rewrite, do it in-step"
            }
            autoFocus={requireMessage}
            disabled={busy}
          />
        </div>
        <DialogFooter>
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={!canSubmit}
            variant={kind === "reject" ? "destructive" : "default"}
          >
            {busy ? "Sending…" : BUTTON_LABEL[kind]}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
