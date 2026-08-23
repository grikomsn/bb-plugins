import { useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

export interface ConfirmDialogProps {
  title: string;
  description: string;
  confirmLabel?: string;
  variant?: "default" | "destructive";
  onConfirm: () => Promise<void>;
  trigger: ReactNode;
}

export function ConfirmDialog({
  title,
  description,
  confirmLabel = "Confirm",
  variant = "default",
  onConfirm,
  trigger,
}: ConfirmDialogProps) {
  const [open, setOpen] = useState(false);
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm(): Promise<void> {
    if (isPending) return;

    setIsPending(true);
    setError(null);
    try {
      await onConfirm();
      setOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setIsPending(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (isPending) return;
        setOpen(nextOpen);
        if (!nextOpen) setError(null);
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        {error ? (
          <div
            className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            role="alert"
          >
            {error}
          </div>
        ) : null}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={isPending}
            onClick={() => setOpen(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant={variant}
            disabled={isPending}
            onClick={() => void confirm()}
          >
            {isPending ? `${confirmLabel}…` : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
