// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { loadPluginApp } from "@get-bb/plugin-sdk/testing/app";

describe("Companion Chat panel action", () => {
  it("opens a distinct panel instance for each new companion", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const action = app.threadPanelActions[0];
    const openPanel = vi.fn(() => true);

    expect(action).toMatchObject({
      id: "new-companion-chat",
      title: "Companion chat",
      layout: "flush",
    });

    await action!.run?.({ threadId: "source-1", openPanel });
    await action!.run?.({ threadId: "source-1", openPanel });

    expect(openPanel).toHaveBeenCalledTimes(2);
    const first = openPanel.mock.calls[0]![0].params as { instanceId: string };
    const second = openPanel.mock.calls[1]![0].params as { instanceId: string };
    expect(first.instanceId).toBeTruthy();
    expect(second.instanceId).toBeTruthy();
    expect(first.instanceId).not.toBe(second.instanceId);
  });
});
