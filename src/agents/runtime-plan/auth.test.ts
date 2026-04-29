import { describe, expect, it, vi } from "vitest";
import { buildAgentRuntimeAuthPlan } from "./auth.js";

const resolveProviderIdForAuth = vi.hoisted(() => vi.fn((provider: string) => provider));

vi.mock("../provider-auth-aliases.js", () => ({
  resolveProviderIdForAuth,
}));

describe("buildAgentRuntimeAuthPlan", () => {
  it("does not load plugin auth aliases when no profile can be forwarded", () => {
    const plan = buildAgentRuntimeAuthPlan({
      provider: "OpenAI",
      config: {},
      workspaceDir: "/tmp/openclaw-runtime-plan",
    });

    expect(plan).toEqual({
      providerForAuth: "openai",
      authProfileProviderForAuth: "openai",
    });
    expect(resolveProviderIdForAuth).not.toHaveBeenCalled();
  });

  it("uses plugin auth aliases when profile providers differ", () => {
    resolveProviderIdForAuth.mockImplementation((provider: string) =>
      provider === "codex-cli" ? "openai-codex" : provider,
    );

    const plan = buildAgentRuntimeAuthPlan({
      provider: "openai",
      authProfileProvider: "codex-cli",
      sessionAuthProfileId: "codex-cli:default",
      config: {},
      workspaceDir: "/tmp/openclaw-runtime-plan",
    });

    expect(plan).toMatchObject({
      providerForAuth: "openai",
      authProfileProviderForAuth: "openai-codex",
    });
    expect(resolveProviderIdForAuth).toHaveBeenCalled();
  });
});
