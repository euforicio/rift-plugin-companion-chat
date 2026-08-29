import {
  defineRpcContract,
  type BbPluginApi,
  type NewThreadRequest,
} from "@get-bb/plugin-sdk";
import { z } from "zod";

const instanceIdSchema = z.string().min(1).max(100);

const environmentSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("reuse"), environmentId: z.string() }).strict(),
  z
    .object({
      type: z.literal("host"),
      hostId: z.string().optional(),
      workspace: z.discriminatedUnion("type", [
        z
          .object({
            type: z.literal("unmanaged"),
            path: z.string().nullable(),
            branch: z
              .discriminatedUnion("kind", [
                z.object({ kind: z.literal("existing"), name: z.string() }).strict(),
                z.object({ kind: z.literal("new"), baseBranch: z.string() }).strict(),
              ])
              .optional(),
          })
          .strict(),
        z
          .object({
            type: z.literal("managed-worktree"),
            baseBranch: z.discriminatedUnion("kind", [
              z.object({ kind: z.literal("named"), name: z.string() }).strict(),
              z.object({ kind: z.literal("default") }).strict(),
            ]),
          })
          .strict(),
        z.object({ type: z.literal("personal") }).strict(),
      ]),
    })
    .strict(),
  z.object({ type: z.literal("project-default") }).strict(),
]);

const promptInputSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("text"),
      text: z.string(),
      mentions: z.array(z.unknown()).optional(),
      visibility: z.literal("agent-only").optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("image"),
      url: z.string(),
      visibility: z.literal("agent-only").optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("localImage"),
      path: z.string(),
      visibility: z.literal("agent-only").optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("localFile"),
      path: z.string(),
      mimeType: z.string().optional(),
      name: z.string().optional(),
      sizeBytes: z.number().optional(),
      visibility: z.literal("agent-only").optional(),
    })
    .strict(),
]);

const inputSourceSchema = z.enum(["client-preference", "explicit"]);
const newThreadRequestSchema = z
  .object({
    projectId: z.string(),
    providerId: z.string(),
    model: z.string(),
    reasoningLevel: z.enum([
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
      "ultracode",
    ]),
    permissionMode: z.enum(["accept-edits", "auto", "full"]),
    serviceTier: z.enum(["default", "fast"]).optional(),
    executionInputSources: z
      .object({
        providerId: inputSourceSchema.optional(),
        model: inputSourceSchema.optional(),
        reasoningLevel: inputSourceSchema.optional(),
        permissionMode: inputSourceSchema.optional(),
        serviceTier: inputSourceSchema.optional(),
      })
      .strict(),
    environment: environmentSchema,
    input: z.array(promptInputSchema),
  })
  .strict();

const companionRecordSchema = z
  .object({ sourceThreadId: z.string(), companionThreadId: z.string() })
  .strict();

export const rpcContract = defineRpcContract({
  getCompanion: {
    input: z
      .object({ sourceThreadId: z.string(), instanceId: instanceIdSchema })
      .strict(),
    output: z
      .object({
        projectId: z.string(),
        environment: z
          .object({ type: z.literal("reuse"), environmentId: z.string() })
          .strict(),
        companionThreadId: z.string().nullable(),
      })
      .strict(),
  },
  createCompanion: {
    input: z
      .object({
        sourceThreadId: z.string(),
        instanceId: instanceIdSchema,
        request: newThreadRequestSchema,
      })
      .strict(),
    output: z.object({ threadId: z.string() }).strict(),
  },
});

function recordKey(instanceId: string) {
  return `companion:${instanceId}`;
}

const permissionModeRank = {
  "accept-edits": 0,
  auto: 1,
  full: 2,
} as const;

function providerRouting(request: NewThreadRequest) {
  if (request.environment.type === "reuse") {
    return { environmentId: request.environment.environmentId };
  }
  if (request.environment.type === "host" && request.environment.hostId !== undefined) {
    return { hostId: request.environment.hostId };
  }
  return {};
}

async function normalizeExecutionOptions(
  bb: BbPluginApi,
  request: NewThreadRequest,
): Promise<NewThreadRequest> {
  const routing = providerRouting(request);
  const providers = await bb.sdk.providers.list(routing);
  const provider = providers.find(({ id }) => id === request.providerId);
  if (provider === undefined || !provider.available) {
    throw new Error(`Provider "${request.providerId}" is not available.`);
  }

  const catalog = await bb.sdk.providers.models({
    ...routing,
    providerId: provider.id,
  });
  const requestedModel = catalog.models.find(
    ({ id, model }) => id === request.model || model === request.model,
  );
  if (
    requestedModel === undefined &&
    request.executionInputSources.model === "explicit"
  ) {
    throw new Error(
      `Model "${request.model}" is not available for provider "${request.providerId}".`,
    );
  }
  const model =
    requestedModel ??
    catalog.models.find(({ isDefault }) => isDefault) ??
    catalog.models[0];
  if (model === undefined) {
    throw new Error(`Provider "${provider.id}" has no available models.`);
  }

  const supportsReasoningLevel = model.supportedReasoningEfforts.some(
    ({ reasoningEffort }) => reasoningEffort === request.reasoningLevel,
  );
  if (
    !supportsReasoningLevel &&
    request.executionInputSources.reasoningLevel === "explicit"
  ) {
    throw new Error(
      `Model "${model.model}" does not support reasoning level "${request.reasoningLevel}".`,
    );
  }
  if (
    !provider.capabilities.permissionModes.includes(request.permissionMode) ||
    permissionModeRank[request.permissionMode] >
      permissionModeRank[catalog.permissionCeiling]
  ) {
    throw new Error(
      `Provider "${provider.id}" cannot use permission mode "${request.permissionMode}" in this environment.`,
    );
  }

  const executionInputSources = { ...request.executionInputSources };
  if (executionInputSources.providerId === undefined) {
    // BB ignores a provided field when executionInputSources contains no
    // source for it. The composer can omit this source after switching away
    // from the main thread's provider, which otherwise restores that provider.
    executionInputSources.providerId =
      request.executionInputSources.model ?? "explicit";
  }
  if (requestedModel === undefined) {
    executionInputSources.model = "client-preference";
  }
  if (!supportsReasoningLevel) {
    executionInputSources.reasoningLevel = "client-preference";
  }
  if (!provider.capabilities.supportsServiceTier) {
    // Omitting this field lets BB reuse a stored project preference such as
    // "fast". Explicitly select the neutral tier so non-tier providers start
    // with the host-supported "default" value instead.
    executionInputSources.serviceTier = "client-preference";
  }
  return {
    ...request,
    providerId: provider.id,
    model: model.model,
    reasoningLevel: supportsReasoningLevel
      ? request.reasoningLevel
      : model.defaultReasoningEffort,
    serviceTier: provider.capabilities.supportsServiceTier
      ? request.serviceTier
      : "default",
    executionInputSources,
  };
}

export default async function plugin(bb: BbPluginApi) {
  const pendingCreates = new Map<string, Promise<{ threadId: string }>>();

  async function readRecord(instanceId: string) {
    const value = await bb.storage.kv.get<unknown>(recordKey(instanceId));
    return value === undefined ? null : companionRecordSchema.parse(value);
  }

  async function assertInstanceSource(instanceId: string, sourceThreadId: string) {
    const record = await readRecord(instanceId);
    if (record !== null && record.sourceThreadId !== sourceThreadId) {
      throw new Error("Companion chat instance belongs to a different source thread.");
    }
    return record;
  }

  bb.rpc.register(rpcContract, {
    async getCompanion({ sourceThreadId, instanceId }) {
      const source = await bb.sdk.threads.get({ threadId: sourceThreadId });
      if (source.environmentId === null) {
        throw new Error("Source thread must have a ready environment.");
      }
      let record = await assertInstanceSource(instanceId, sourceThreadId);
      if (record !== null) {
        const companion = await bb.sdk.threads.get({
          threadId: record.companionThreadId,
        });
        if (companion.deletedAt !== null) {
          await bb.storage.kv.delete(recordKey(instanceId));
          record = null;
        }
      }
      return {
        projectId: source.projectId,
        environment: { type: "reuse" as const, environmentId: source.environmentId },
        companionThreadId: record?.companionThreadId ?? null,
      };
    },

    async createCompanion({ sourceThreadId, instanceId, request }) {
      const existing = await assertInstanceSource(instanceId, sourceThreadId);
      if (existing !== null) return { threadId: existing.companionThreadId };

      const pending = pendingCreates.get(instanceId);
      if (pending !== undefined) return pending;

      const create = (async () => {
        await bb.sdk.threads.get({ threadId: sourceThreadId });
        const normalizedRequest = await normalizeExecutionOptions(
          bb,
          request as NewThreadRequest,
        );
        const thread = await bb.sdk.threads.spawn({
          ...normalizedRequest,
          visibility: "hidden",
        });
        await bb.storage.kv.set(recordKey(instanceId), {
          sourceThreadId,
          companionThreadId: thread.id,
        });
        return { threadId: thread.id };
      })();

      pendingCreates.set(instanceId, create);
      try {
        return await create;
      } finally {
        pendingCreates.delete(instanceId);
      }
    },
  });
}
