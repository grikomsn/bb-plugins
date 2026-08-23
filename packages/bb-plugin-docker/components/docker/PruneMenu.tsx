import { useRpc } from "@get-bb/plugin-sdk/app";

import { Button } from "@/components/ui/button";
import type { rpcContract } from "@/contract";

import { ConfirmDialog } from "./ConfirmDialog";

type PruneKind = "system" | "images" | "volumes" | "networks";

const PRUNE_OPTIONS: ReadonlyArray<{
  kind: PruneKind;
  label: string;
  description: string;
}> = [
  {
    kind: "system",
    label: "Prune system",
    description:
      "Remove all unused containers, networks, images, and build cache. This action cannot be undone.",
  },
  {
    kind: "images",
    label: "Prune images",
    description:
      "Remove dangling Docker images that are not referenced by a container. This action cannot be undone.",
  },
  {
    kind: "volumes",
    label: "Prune volumes",
    description:
      "Remove unused local Docker volumes and their stored data. This action cannot be undone.",
  },
  {
    kind: "networks",
    label: "Prune networks",
    description:
      "Remove Docker networks that are not used by a container. This action cannot be undone.",
  },
];

export interface PruneMenuProps {
  onRefresh?: () => void | Promise<void>;
}

export function PruneMenu({ onRefresh }: PruneMenuProps) {
  const rpc = useRpc<typeof rpcContract>();

  async function prune(kind: PruneKind): Promise<void> {
    const result = await rpc.call("prune", { kind });
    if (!result.ok) {
      throw new Error(result.stderr || `Could not prune Docker ${kind}.`);
    }
    await onRefresh?.();
  }

  return (
    <details className="group relative">
      <summary className="flex h-8 cursor-pointer list-none items-center justify-center rounded-md border border-input bg-transparent px-3 text-xs font-medium transition-colors hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        Prune…
      </summary>

      <div
        className="absolute right-0 z-20 mt-1 min-w-44 rounded-md border border-border bg-background p-1 shadow-md"
        role="menu"
      >
        {PRUNE_OPTIONS.map((option) => (
          <ConfirmDialog
            key={option.kind}
            title={`${option.label}?`}
            description={option.description}
            confirmLabel={option.label}
            variant="destructive"
            onConfirm={() => prune(option.kind)}
            trigger={
              <Button
                type="button"
                className="w-full justify-start text-destructive hover:text-destructive"
                size="sm"
                variant="ghost"
                role="menuitem"
              >
                {option.label}
              </Button>
            }
          />
        ))}
      </div>
    </details>
  );
}
