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
  permissionMode: "auto" as const,
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
}: {
  environmentId?: string | null;
  companionDeletedAt?: number | null;
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
    visibility: "visible",
    deletedAt: companionDeletedAt,
  });
  return createFakePluginHost({
    pluginId: "companion-chat",
    sdk: {
      threads: {
        get: async ({ threadId }) =>
          threadId === source.id ? source : companion,
        spawn: async () => companion,
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

  it("creates one visible fresh thread and remembers it for the panel", async () => {
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
          visibility: "visible",
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
