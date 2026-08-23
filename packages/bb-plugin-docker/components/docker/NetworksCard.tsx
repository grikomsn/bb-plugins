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

export interface NetworksCardProps {
  networks: DockerSnapshot["networks"];
  onRefresh: () => void | Promise<void>;
}

export function NetworksCard({ networks, onRefresh }: NetworksCardProps) {
  const rpc = useRpc<typeof rpcContract>();
  const [name, setName] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [removingName, setRemovingName] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  async function createNetwork(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const nextName = name.trim();
    if (!nextName || isCreating) return;

    setIsCreating(true);
    setActionError(null);
    try {
      const result = await rpc.call("networkAction", {
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

  async function removeNetwork(networkName: string): Promise<void> {
    setRemovingName(networkName);
    setActionError(null);
    try {
      const result = await rpc.call("networkAction", {
        name: networkName,
        action: "remove",
      });
      if (!result.ok) {
        throw new Error(result.error ?? `Could not remove ${networkName}.`);
      }
      await onRefresh();
    } finally {
      setRemovingName((current) => (current === networkName ? null : current));
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center justify-between gap-3">
          <span>Networks</span>
          <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
            {networks.length}
          </span>
        </CardTitle>
        <CardDescription>
          Create and manage Docker container networks.
        </CardDescription>
      </CardHeader>
      <CardContent className="px-0 pb-0">
        <form
          className="flex flex-col gap-2 px-6 pb-4 sm:flex-row"
          onSubmit={(event) => void createNetwork(event)}
        >
          <Input
            aria-label="Network name"
            placeholder="Network name"
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

        {networks.length === 0 ? (
          <div className="border-t border-border px-6 py-8 text-center text-sm text-muted-foreground">
            No networks found.
          </div>
        ) : (
          <div className="overflow-x-auto border-t border-border">
            <table className="w-full min-w-[560px] text-left text-sm">
              <thead className="bg-muted/40 text-xs text-muted-foreground">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Name</th>
                  <th className="px-4 py-2.5 font-medium">Driver</th>
                  <th className="px-4 py-2.5 font-medium">Scope</th>
                  <th className="px-4 py-2.5 text-right font-medium">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {networks.map((network) => (
                  <tr key={network.id} className="hover:bg-state-hover">
                    <td className="max-w-56 px-4 py-3">
                      <div className="truncate font-medium text-foreground">
                        {network.name}
                      </div>
                      <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
                        {network.id.slice(0, 12)}
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">
                      {network.driver || "—"}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">
                      {network.scope || "—"}
                    </td>
                    <td className="px-4 py-2 text-right">
                      <ConfirmDialog
                        title="Remove network?"
                        description={`Remove ${network.name}? This action cannot be undone.`}
                        confirmLabel="Remove"
                        variant="destructive"
                        onConfirm={() => removeNetwork(network.name)}
                        trigger={
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            className="text-destructive hover:text-destructive"
                            disabled={removingName !== null}
                            aria-label={`Remove ${network.name}`}
                          >
                            {removingName === network.name
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
