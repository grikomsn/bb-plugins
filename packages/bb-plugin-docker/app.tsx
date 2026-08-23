import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ConnectionBar } from "@/components/docker/ConnectionBar";
import { ContainersCard } from "@/components/docker/ContainersCard";
import { ImagesCard } from "@/components/docker/ImagesCard";
import { NetworksCard } from "@/components/docker/NetworksCard";
import { VolumesCard } from "@/components/docker/VolumesCard";
import { useDockerSnapshot } from "@/hooks/useDockerSnapshot";

function HeaderRefresh() {
  const { refresh, isLoading } = useDockerSnapshot();
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={isLoading}
      onClick={() => void refresh()}
    >
      Refresh
    </Button>
  );
}

function SidebarAccessory() {
  const { data } = useDockerSnapshot();
  const runningCount =
    data?.containers.filter((container) => container.state === "running").length ?? 0;
  const reachable = data?.docker.reachable ?? false;
  return (
    <span className="flex items-center justify-end gap-1 text-xs text-muted-foreground">
      <span
        aria-label={reachable ? "Docker reachable" : "Docker unreachable"}
        className={`size-2 shrink-0 rounded-full ${reachable ? "bg-green-500" : "bg-red-500"}`}
      />
      {runningCount}
    </span>
  );
}

function DockerPage() {
  const { data, error, isLoading, refresh } = useDockerSnapshot();
  const runningCount =
    data?.containers.filter((container) => container.state === "running").length ?? 0;

  return (
    <div className="h-full overflow-y-auto">
      <main className="p-4 md:p-5 mx-auto w-full max-w-3xl space-y-4">
        <nav aria-label="Docker resources" className="flex flex-wrap gap-2 text-sm">
          {[
            ["containers", "Containers"],
            ["images", "Images"],
            ["volumes", "Volumes"],
            ["networks", "Networks"],
          ].map(([id, label]) => (
            <a
              key={id}
              href={`#${id}`}
              className="rounded-md border border-border px-2.5 py-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              {label}
            </a>
          ))}
        </nav>

        {data ? (
          <ConnectionBar
            docker={data.docker}
            runningCount={runningCount}
            onRefresh={refresh}
          />
        ) : (
          <Card>
            <CardHeader>
              <CardTitle>Docker connection</CardTitle>
              <CardDescription>
                {isLoading ? "Loading Docker snapshot…" : "No snapshot available."}
              </CardDescription>
            </CardHeader>
          </Card>
        )}

        {error ? (
          <Card>
            <CardHeader>
              <CardTitle>Snapshot request failed</CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-destructive">{error}</CardContent>
          </Card>
        ) : null}

        <section id="containers" className="scroll-mt-4">
          <ContainersCard
            containers={data?.containers ?? []}
            onRefresh={refresh}
          />
        </section>

        <section id="images" className="scroll-mt-4">
          <ImagesCard images={data?.images ?? []} onRefresh={refresh} />
        </section>

        <section id="volumes" className="scroll-mt-4">
          <VolumesCard volumes={data?.volumes ?? []} onRefresh={refresh} />
        </section>

        <section id="networks" className="scroll-mt-4">
          <NetworksCard networks={data?.networks ?? []} onRefresh={refresh} />
        </section>
      </main>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "docker",
    title: "Docker",
    icon: "Container",
    path: "docker",
    component: DockerPage,
    headerContent: HeaderRefresh,
    experimental_sidebarAccessory: SidebarAccessory,
  });
});
