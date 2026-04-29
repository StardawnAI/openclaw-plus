import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveGatewayStartupPluginIds } from "../plugins/gateway-startup-plugin-ids.js";
import { resolveRuntimePluginRegistry } from "../plugins/loader.js";
import { getActivePluginRuntimeSubagentMode } from "../plugins/runtime.js";
import { resolveUserPath } from "../utils.js";

function resolveRuntimePluginIds(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
}): readonly string[] | undefined {
  if (!params.config) {
    return undefined;
  }
  return resolveGatewayStartupPluginIds({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: process.env,
  });
}

export function ensureRuntimePluginsLoaded(params: {
  config?: OpenClawConfig;
  workspaceDir?: string | null;
  allowGatewaySubagentBinding?: boolean;
}): void {
  const workspaceDir =
    typeof params.workspaceDir === "string" && params.workspaceDir.trim()
      ? resolveUserPath(params.workspaceDir)
      : undefined;
  const allowGatewaySubagentBinding =
    params.allowGatewaySubagentBinding === true ||
    getActivePluginRuntimeSubagentMode() === "gateway-bindable";
  const loadOptions = {
    config: params.config,
    workspaceDir,
    ...(params.config
      ? {
          onlyPluginIds: [
            ...(resolveRuntimePluginIds({
              config: params.config,
              workspaceDir,
            }) ?? []),
          ],
        }
      : {}),
    runtimeOptions: allowGatewaySubagentBinding
      ? {
          allowGatewaySubagentBinding: true,
        }
      : undefined,
  };
  resolveRuntimePluginRegistry(loadOptions);
}
