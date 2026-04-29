import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizeEmbeddedAgentRuntime } from "../pi-embedded-runner/runtime.js";
import { resolveProviderIdForAuth } from "../provider-auth-aliases.js";
import { normalizeProviderId } from "../provider-id.js";
import type { AgentRuntimeAuthPlan } from "./types.js";

const CODEX_HARNESS_AUTH_PROVIDER = "openai-codex";

function resolveHarnessAuthProvider(params: {
  harnessId?: string;
  harnessRuntime?: string;
}): string | undefined {
  const harnessId = normalizeEmbeddedAgentRuntime(params.harnessId);
  const runtime = normalizeEmbeddedAgentRuntime(params.harnessRuntime);
  return harnessId === "codex" || runtime === "codex" ? CODEX_HARNESS_AUTH_PROVIDER : undefined;
}

export function buildAgentRuntimeAuthPlan(params: {
  provider: string;
  authProfileProvider?: string;
  sessionAuthProfileId?: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  harnessId?: string;
  harnessRuntime?: string;
  allowHarnessAuthProfileForwarding?: boolean;
}): AgentRuntimeAuthPlan {
  const normalizedProvider = normalizeProviderId(params.provider);
  const normalizedAuthProfileProvider = normalizeProviderId(
    params.authProfileProvider ?? params.provider,
  );
  const aliasLookupParams = {
    config: params.config,
    workspaceDir: params.workspaceDir,
  };
  const harnessAuthProvider = resolveHarnessAuthProvider(params);
  if (!params.sessionAuthProfileId && !harnessAuthProvider) {
    return {
      providerForAuth: normalizedProvider,
      authProfileProviderForAuth: normalizedAuthProfileProvider,
    };
  }
  const providerForAuth =
    normalizedProvider === normalizedAuthProfileProvider
      ? normalizedProvider
      : resolveProviderIdForAuth(params.provider, aliasLookupParams);
  const authProfileProviderForAuth =
    normalizedProvider === normalizedAuthProfileProvider
      ? normalizedAuthProfileProvider
      : resolveProviderIdForAuth(params.authProfileProvider ?? params.provider, aliasLookupParams);
  const harnessProviderForAuth = harnessAuthProvider
    ? resolveProviderIdForAuth(harnessAuthProvider, aliasLookupParams)
    : undefined;
  const harnessCanForwardProfile =
    params.allowHarnessAuthProfileForwarding !== false &&
    harnessProviderForAuth &&
    harnessProviderForAuth === authProfileProviderForAuth;
  const canForwardProfile =
    providerForAuth === authProfileProviderForAuth || harnessCanForwardProfile;

  return {
    providerForAuth,
    authProfileProviderForAuth,
    ...(harnessProviderForAuth ? { harnessAuthProvider: harnessProviderForAuth } : {}),
    ...(canForwardProfile ? { forwardedAuthProfileId: params.sessionAuthProfileId } : {}),
  };
}
