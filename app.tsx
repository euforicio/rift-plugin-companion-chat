import { useEffect, useState } from "react";
import {
  definePluginApp,
  experimental_NewThreadComposer as NewThreadComposer,
  ThreadChat,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type {
  JsonValue,
  NewThreadRequest,
  PluginThreadPanelProps,
} from "@get-bb/plugin-sdk";
import type { rpcContract } from "./server";

type CompanionContext = {
  projectId: string;
  environment: { type: "reuse"; environmentId: string };
  companionThreadId: string | null;
};

function readInstanceId(params: JsonValue | undefined) {
  if (
    typeof params === "object" &&
    params !== null &&
    !Array.isArray(params) &&
    typeof params.instanceId === "string"
  ) {
    return params.instanceId;
  }
  return null;
}

function CompanionChatPanel({ threadId: sourceThreadId, params }: PluginThreadPanelProps) {
  const rpc = useRpc<typeof rpcContract>();
  const instanceId = readInstanceId(params);
  const [context, setContext] = useState<CompanionContext | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (instanceId === null) return;
    let cancelled = false;
    void rpc
      .call("getCompanion", { sourceThreadId, instanceId })
      .then((result) => {
        if (!cancelled) setContext(result);
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [instanceId, rpc, sourceThreadId]);

  if (instanceId === null) {
    return <p className="p-4 text-sm text-destructive">Invalid companion chat tab.</p>;
  }
  if (error !== null) {
    return <p className="p-4 text-sm text-destructive">{error}</p>;
  }
  if (context === null) {
    return <p className="p-4 text-sm text-muted-foreground">Preparing companion chat…</p>;
  }
  if (context.companionThreadId !== null) {
    return (
      <ThreadChat
        threadId={context.companionThreadId}
        variant="compact"
        layout="contained"
        permissionPolicy="editable"
        className="h-full"
      />
    );
  }

  return (
    <NewThreadComposer
      defaultProjectId={context.projectId}
      defaultEnvironment={context.environment}
      placeholder="Start a fresh companion chat…"
      layout="contained"
      draftKey={`companion-chat:${instanceId}`}
      className="h-full"
      onSubmit={async (request: NewThreadRequest) => {
        const result = await rpc.call("createCompanion", {
          sourceThreadId,
          instanceId,
          request,
        });
        setContext((current) =>
          current === null
            ? current
            : { ...current, companionThreadId: result.threadId },
        );
      }}
    />
  );
}

export default definePluginApp((app) => {
  app.slots.threadPanelAction({
    id: "new-companion-chat",
    title: "Companion chat",
    icon: "SideChat",
    component: CompanionChatPanel,
    layout: "flush",
    run({ openPanel }) {
      openPanel({ params: { instanceId: crypto.randomUUID() } });
    },
  });
});
