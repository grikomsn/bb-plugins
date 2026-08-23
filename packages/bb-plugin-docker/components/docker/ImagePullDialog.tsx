import { useState, type FormEvent } from "react";
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
import type { rpcContract } from "@/contract";

export interface ImagePullDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPulled: () => void | Promise<void>;
}

export function ImagePullDialog({
  open,
  onOpenChange,
  onPulled,
}: ImagePullDialogProps) {
  const rpc = useRpc<typeof rpcContract>();
  const [imageRef, setImageRef] = useState("");
  const [isPulling, setIsPulling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function setOpen(nextOpen: boolean): void {
    if (isPulling) return;
    onOpenChange(nextOpen);
    if (!nextOpen) {
      setImageRef("");
      setError(null);
    }
  }

  async function pullImage(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const ref = imageRef.trim();
    if (!ref || isPulling) return;

    setIsPulling(true);
    setError(null);
    try {
      const result = await rpc.call("imagePull", { ref });
      if (!result.ok) {
        throw new Error(result.error ?? `Could not pull ${ref}.`);
      }
      await onPulled();
      setImageRef("");
      onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setIsPulling(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent>
        <form className="space-y-4" onSubmit={(event) => void pullImage(event)}>
          <DialogHeader>
            <DialogTitle>Pull image</DialogTitle>
            <DialogDescription>
              Enter an image reference, including a tag when needed.
            </DialogDescription>
          </DialogHeader>

          <Input
            autoFocus
            aria-label="Image reference"
            placeholder="image:tag"
            value={imageRef}
            disabled={isPulling}
            onChange={(event) => setImageRef(event.target.value)}
          />

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
              disabled={isPulling}
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={isPulling || imageRef.trim().length === 0}
            >
              {isPulling ? "Pulling…" : "Pull"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
