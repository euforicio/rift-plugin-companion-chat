import { describe, expect, it } from "vitest";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin from "./server";

const request = {
  projectId: "project-1",
  providerId: "pi",
  model: "anthropic/claude-opus-4-8",
  reasoningLevel: "high" as const,
  permissionMode: "full" as const,
  executionInputSources: {
    providerId: "explicit" as const,
    model: "explicit" as const,
    reasoningLevel: "explicit" as const,
    permissionMode: "explicit" as const,
  },
  environment: { type: "reuse" as const, environmentId: "environment-1" },
  input: [{ type: "text" as const, text: "Review this work", mentions: [] }],
};

function host({
  environmentId = "environment-1",
  companionDeletedAt = null,
  companionVisibility = "hidden",
  permissionCeiling = "full",
}: {
  environmentId?: string | null;
  companionDeletedAt?: number | null;
  companionVisibility?: "visible" | "hidden";
  permissionCeiling?: "accept-edits" | "auto" | "full";
} = {}) {
  const source = makeThreadResponse({
    id: "source-1",
    projectId: "project-1",
    environmentId,
    providerId: "codex",
  });
  const companion = makeThreadResponse({
    id: "companion-1",
    projectId: "project-1",
    environmentId: "environment-1",
    providerId: "pi",
    visibility: companionVisibility,
    deletedAt: companionDeletedAt,
  });
  return createFakePluginHost({
    pluginId: "companion-chat",
    sdk: {
      threads: {
        get: async ({ threadId }) =>
          threadId === source.id ? source : companion,
        spawn: async () => companion,
        update: async () => companion,
      },
      providers: {
        list: async () => [
          {
            id: "pi",
            displayName: "Pi",
            available: true,
            logoUrl: null,
            capabilities: {
              permissionModes: ["full"],
              supportsFork: true,
              supportsNativeUserQuestion: false,
              supportsServiceTier: false,
              supportsSessionRewind: true,
              supportsThreadArchive: false,
              supportsThreadRename: false,
            },
            composerActions: [{ kind: "skills", trigger: "/" }],
          },
        ],
        models: async () => ({
          modelLoadError: null,
          models: [
            {
              id: "anthropic/claude-opus-4-8",
              model: "anthropic/claude-opus-4-8",
              displayName: "Claude Opus 4.8",
              description: "Anthropic model via Pi",
              supportedReasoningEfforts: [
                { reasoningEffort: "medium", description: "Medium" },
                { reasoningEffort: "high", description: "High" },
              ],
              defaultReasoningEffort: "medium",
              isDefault: true,
            },
          ],
          permissionCeiling,
          providers: [],
          selectedOnlyModels: [],
        }),
      },
    },
  });
}

describe("Companion Chat backend", () => {
  it("defaults a new companion to the source thread's project and environment", async () => {
    const { bb, harness } = host();
    await plugin(bb);

    await expect(
      harness.behavior.callRpc("getCompanion", {
        sourceThreadId: "source-1",
        instanceId: "instance-1",
      }),
    ).resolves.toEqual({
      projectId: "project-1",
      environment: { type: "reuse", environmentId: "environment-1" },
      companionThreadId: null,
    });
  });

  it("normalizes stale execution options to the selected provider's capabilities", async () => {
    const { bb, harness } = host();
    await plugin(bb);

    await harness.behavior.callRpc("createCompanion", {
      sourceThreadId: "source-1",
      instanceId: "instance-1",
      request: {
        ...request,
        model: "cursor-grok-4.6-medium",
        reasoningLevel: "ultra",
        serviceTier: "fast",
        executionInputSources: {
          ...request.executionInputSources,
          model: "client-preference",
          reasoningLevel: "client-preference",
          serviceTier: "client-preference",
        },
      },
    });

    expect(harness.inspection.sdk.callsTo("threads.spawn")).toEqual([
      [
        {
          ...request,
          model: "anthropic/claude-opus-4-8",
          reasoningLevel: "medium",
          executionInputSources: {
            ...request.executionInputSources,
            model: "client-preference",
            reasoningLevel: "client-preference",
          },
          visibility: "hidden",
          origin: "plugin",
          originPluginId: "companion-chat",
        },
      ],
    ]);
  });

  it("rejects an unavailable model that the user selected explicitly", async () => {
    const { bb, harness } = host();
    await plugin(bb);

    await expect(
      harness.behavior.callRpc("createCompanion", {
        sourceThreadId: "source-1",
        instanceId: "instance-1",
        request: { ...request, model: "cursor-grok-4.6-medium" },
      }),
    ).rejects.toThrow("not available");

    expect(harness.inspection.sdk.callsTo("threads.spawn")).toEqual([]);
  });

  it("rejects an unsupported reasoning level that the user selected explicitly", async () => {
    const { bb, harness } = host();
    await plugin(bb);

    await expect(
      harness.behavior.callRpc("createCompanion", {
        sourceThreadId: "source-1",
        instanceId: "instance-1",
        request: { ...request, reasoningLevel: "ultra" },
      }),
    ).rejects.toThrow("does not support reasoning level");

    expect(harness.inspection.sdk.callsTo("threads.spawn")).toEqual([]);
  });

  it("rejects permission modes above the environment ceiling", async () => {
    const { bb, harness } = host({ permissionCeiling: "auto" });
    await plugin(bb);

    await expect(
      harness.behavior.callRpc("createCompanion", {
        sourceThreadId: "source-1",
        instanceId: "instance-1",
        request,
      }),
    ).rejects.toThrow("cannot use permission mode");

    expect(harness.inspection.sdk.callsTo("threads.spawn")).toEqual([]);
  });

  it("creates one hidden fresh thread and remembers it for the panel", async () => {
    const { bb, harness } = host();
    await plugin(bb);

    const input = {
      sourceThreadId: "source-1",
      instanceId: "instance-1",
      request,
    };
    await expect(harness.behavior.callRpc("createCompanion", input)).resolves.toEqual({
      threadId: "companion-1",
    });
    await expect(harness.behavior.callRpc("createCompanion", input)).resolves.toEqual({
      threadId: "companion-1",
    });

    expect(harness.inspection.sdk.callsTo("threads.spawn")).toEqual([
      [
        {
          ...request,
          visibility: "hidden",
          origin: "plugin",
          originPluginId: "companion-chat",
        },
      ],
    ]);
    await expect(
      harness.behavior.callRpc("getCompanion", {
        sourceThreadId: "source-1",
        instanceId: "instance-1",
      }),
    ).resolves.toMatchObject({ companionThreadId: "companion-1" });
  });

  it("preserves a user's decision to make a companion visible", async () => {
    const { bb, harness } = host({ companionVisibility: "visible" });
    await bb.storage.kv.set("companion:instance-1", {
      sourceThreadId: "source-1",
      companionThreadId: "companion-1",
    });
    await plugin(bb);

    await expect(
      harness.behavior.callRpc("getCompanion", {
        sourceThreadId: "source-1",
        instanceId: "instance-1",
      }),
    ).resolves.toMatchObject({ companionThreadId: "companion-1" });

    expect(harness.inspection.sdk.callsTo("threads.update")).toEqual([]);
  });

  it("refuses to open before the source thread has a ready environment", async () => {
    const { bb, harness } = host({ environmentId: null });
    await plugin(bb);

    await expect(
      harness.behavior.callRpc("getCompanion", {
        sourceThreadId: "source-1",
        instanceId: "instance-1",
      }),
    ).rejects.toThrow("ready environment");
  });

  it("forgets a deleted companion so the panel can create another", async () => {
    const { bb, harness } = host({ companionDeletedAt: Date.now() });
    await bb.storage.kv.set("companion:instance-1", {
      sourceThreadId: "source-1",
      companionThreadId: "companion-1",
    });
    await plugin(bb);

    await expect(
      harness.behavior.callRpc("getCompanion", {
        sourceThreadId: "source-1",
        instanceId: "instance-1",
      }),
    ).resolves.toMatchObject({ companionThreadId: null });

    await expect(
      harness.behavior.callRpc("createCompanion", {
        sourceThreadId: "source-1",
        instanceId: "instance-1",
        request,
      }),
    ).resolves.toEqual({ threadId: "companion-1" });
    expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
  });
});
