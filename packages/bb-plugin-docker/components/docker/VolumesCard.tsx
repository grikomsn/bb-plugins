import { useState, type FormEvent } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";

import type { DockerSnapshot, rpcContract } from "@/contract";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ConfirmDialog } from "./ConfirmDialog";

export interface VolumesCardProps {
  volumes: DockerSnapshot["volumes"];
  onRefresh: () => void | Promise<void>;
}

export function VolumesCard({ volumes, onRefresh }: VolumesCardProps) {
  const rpc = useRpc<typeof rpcContract>();
  const [name, setName] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [removingName, setRemovingName] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  async function createVolume(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const nextName = name.trim();
    if (!nextName || isCreating) return;

    setIsCreating(true);
    setActionError(null);
    try {
      const result = await rpc.call("volumeAction", {
        name: nextName,
        action: "create",
      });
      if (!result.ok) {
        throw new Error(result.error ?? `Could not create ${nextName}.`);
      }
      setName("");
      await onRefresh();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsCreating(false);
    }
  }

  async function removeVolume(volumeName: string): Promise<void> {
    setRemovingName(volumeName);
    setActionError(null);
    try {
      const result = await rpc.call("volumeAction", {
        name: volumeName,
        action: "remove",
      });
      if (!result.ok) {
        throw new Error(result.error ?? `Could not remove ${volumeName}.`);
      }
      await onRefresh();
    } finally {
      setRemovingName((current) => (current === volumeName ? null : current));
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center justify-between gap-3">
          <span>Volumes</span>
          <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
            {volumes.length}
          </span>
        </CardTitle>
        <CardDescription>
          Create and manage persistent Docker volumes.
        </CardDescription>
      </CardHeader>
      <CardContent className="px-0 pb-0">
        <form
          className="flex flex-col gap-2 px-6 pb-4 sm:flex-row"
          onSubmit={(event) => void createVolume(event)}
        >
          <Input
            aria-label="Volume name"
            placeholder="Volume name"
            value={name}
            disabled={isCreating}
            onChange={(event) => setName(event.target.value)}
          />
          <Button
            type="submit"
            size="sm"
            disabled={isCreating || name.trim().length === 0}
          >
            {isCreating ? "Creating…" : "Create"}
          </Button>
        </form>

        {actionError ? (
          <div
            className="mx-6 mb-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            role="alert"
          >
            {actionError}
          </div>
        ) : null}

        {volumes.length === 0 ? (
          <div className="border-t border-border px-6 py-8 text-center text-sm text-muted-foreground">
            No volumes found.
          </div>
        ) : (
          <div className="overflow-x-auto border-t border-border">
            <table className="w-full min-w-[620px] text-left text-sm">
              <thead className="bg-muted/40 text-xs text-muted-foreground">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Name</th>
                  <th className="px-4 py-2.5 font-medium">Driver</th>
                  <th className="px-4 py-2.5 font-medium">Mountpoint</th>
                  <th className="px-4 py-2.5 text-right font-medium">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {volumes.map((volume) => (
                  <tr key={volume.name} className="hover:bg-state-hover">
                    <td className="max-w-48 truncate px-4 py-3 font-medium text-foreground">
                      {volume.name}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">
                      {volume.driver || "—"}
                    </td>
                    <td
                      className="max-w-72 truncate px-4 py-3 font-mono text-xs text-muted-foreground"
                      title={volume.mountpoint || undefined}
                    >
                      {volume.mountpoint || "—"}
                    </td>
                    <td className="px-4 py-2 text-right">
                      <ConfirmDialog
                        title="Remove volume?"
                        description={`Remove ${volume.name}? This action cannot be undone.`}
                        confirmLabel="Remove"
                        variant="destructive"
                        onConfirm={() => removeVolume(volume.name)}
                        trigger={
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            className="text-destructive hover:text-destructive"
                            disabled={removingName !== null}
                            aria-label={`Remove ${volume.name}`}
                          >
                            {removingName === volume.name
                              ? "Removing…"
                              : "Remove"}
                          </Button>
                        }
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
