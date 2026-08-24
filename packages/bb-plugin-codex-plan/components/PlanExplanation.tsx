import { Markdown } from "@get-bb/plugin-sdk/app";

export function PlanExplanation({ text }: { text: string | null }) {
  if (!text) {
    return (
      <p className="text-sm text-muted-foreground">
        No explanation provided by Codex.
      </p>
    );
  }

  return <Markdown content={text} className="text-sm" />;
}
