import { useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { DockerSnapshot, rpcContract } from "@/contract";
import { ConfirmDialog } from "./ConfirmDialog";
import { ImagePullDialog } from "./ImagePullDialog";

export interface ImagesCardProps {
  images: DockerSnapshot["images"];
  onRefresh: () => void | Promise<void>;
}

function imageReference(image: DockerSnapshot["images"][number]): string {
  if (image.repository === "<none>" || image.tag === "<none>") {
    return image.id;
  }
  return `${image.repository}:${image.tag}`;
}

function shortImageId(id: string): string {
  const digest = id.startsWith("sha256:") ? id.slice("sha256:".length) : id;
  return digest.slice(0, 12);
}

export function ImagesCard({ images, onRefresh }: ImagesCardProps) {
  const rpc = useRpc<typeof rpcContract>();
  const [pullOpen, setPullOpen] = useState(false);

  async function removeImage(
    image: DockerSnapshot["images"][number],
  ): Promise<void> {
    const ref = imageReference(image);
    const result = await rpc.call("imageAction", {
      ref,
      action: "remove",
    });
    if (!result.ok) {
      throw new Error(result.error ?? `Could not remove ${ref}.`);
    }
    await onRefresh();
  }

  return (
    <>
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-1.5">
              <CardTitle className="flex items-center gap-2">
                <span>Images</span>
                <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                  {images.length}
                </span>
              </CardTitle>
              <CardDescription>
                Pull and remove images available to this Docker engine.
              </CardDescription>
            </div>
            <Button type="button" size="sm" onClick={() => setPullOpen(true)}>
              Pull image
            </Button>
          </div>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          {images.length === 0 ? (
            <div className="border-t border-border px-6 py-8 text-center text-sm text-muted-foreground">
              No images found.
            </div>
          ) : (
            <div className="overflow-x-auto border-t border-border">
              <table className="w-full min-w-[680px] text-left text-sm">
                <thead className="bg-muted/40 text-xs text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2.5 font-medium">Repository</th>
                    <th className="px-4 py-2.5 font-medium">Tag</th>
                    <th className="px-4 py-2.5 font-medium">ID</th>
                    <th className="px-4 py-2.5 font-medium">Size</th>
                    <th className="px-4 py-2.5 font-medium">Created</th>
                    <th className="px-4 py-2.5 text-right font-medium">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {images.map((image) => {
                    const ref = imageReference(image);
                    return (
                      <tr
                        key={`${image.id}:${image.repository}:${image.tag}`}
                        className="transition-colors hover:bg-state-hover"
                      >
                        <td className="max-w-52 truncate px-4 py-3 font-medium text-foreground">
                          {image.repository}
                        </td>
                        <td className="max-w-40 truncate px-4 py-3 text-muted-foreground">
                          {image.tag}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 font-mono text-xs text-muted-foreground">
                          {shortImageId(image.id)}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">
                          {image.size}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">
                          {image.created}
                        </td>
                        <td className="px-4 py-2 text-right">
                          <ConfirmDialog
                            title="Remove image?"
                            description={`Remove ${ref}? This action cannot be undone.`}
                            confirmLabel="Remove"
                            variant="destructive"
                            onConfirm={() => removeImage(image)}
                            trigger={
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                className="text-destructive hover:text-destructive"
                                aria-label={`Remove ${ref}`}
                              >
                                Remove
                              </Button>
                            }
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <ImagePullDialog
        open={pullOpen}
        onOpenChange={setPullOpen}
        onPulled={onRefresh}
      />
    </>
  );
}
