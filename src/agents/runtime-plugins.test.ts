import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getActivePluginRuntimeSubagentMode: vi.fn(() => "default"),
  resolveGatewayStartupPluginIds: vi.fn((_params: unknown) => ["active-memory", "telegram"]),
  resolveRuntimePluginRegistry: vi.fn((_params: unknown) => undefined),
}));

vi.mock("../plugins/loader.js", () => ({
  resolveRuntimePluginRegistry: (params: unknown) => mocks.resolveRuntimePluginRegistry(params),
}));

vi.mock("../plugins/gateway-startup-plugin-ids.js", () => ({
  resolveGatewayStartupPluginIds: (params: unknown) => mocks.resolveGatewayStartupPluginIds(params),
}));

vi.mock("../plugins/runtime.js", () => ({
  getActivePluginRuntimeSubagentMode: () => mocks.getActivePluginRuntimeSubagentMode(),
}));

import { ensureRuntimePluginsLoaded } from "./runtime-plugins.js";

describe("ensureRuntimePluginsLoaded", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getActivePluginRuntimeSubagentMode.mockReturnValue("default");
    mocks.resolveGatewayStartupPluginIds.mockReturnValue(["active-memory", "telegram"]);
  });

  it("loads only startup-scoped plugins for configured local agent runs", () => {
    const config = { plugins: { allow: ["telegram"] } };

    ensureRuntimePluginsLoaded({
      config,
      workspaceDir: "/workspace",
    });

    expect(mocks.resolveGatewayStartupPluginIds).toHaveBeenCalledWith({
      config,
      workspaceDir: "/workspace",
      env: process.env,
    });
    expect(mocks.resolveRuntimePluginRegistry).toHaveBeenCalledWith({
      config,
      workspaceDir: "/workspace",
      onlyPluginIds: ["active-memory", "telegram"],
      runtimeOptions: undefined,
    });
  });

  it("preserves unscoped loading for callers without config", () => {
    ensureRuntimePluginsLoaded({});

    expect(mocks.resolveGatewayStartupPluginIds).not.toHaveBeenCalled();
    expect(mocks.resolveRuntimePluginRegistry).toHaveBeenCalledWith({
      config: undefined,
      workspaceDir: undefined,
      runtimeOptions: undefined,
    });
  });

  it("keeps gateway subagent binding on scoped loads", () => {
    ensureRuntimePluginsLoaded({
      config: {},
      workspaceDir: "/workspace",
      allowGatewaySubagentBinding: true,
    });

    expect(mocks.resolveRuntimePluginRegistry).toHaveBeenCalledWith({
      config: {},
      workspaceDir: "/workspace",
      onlyPluginIds: ["active-memory", "telegram"],
      runtimeOptions: {
        allowGatewaySubagentBinding: true,
      },
    });
  });
});
