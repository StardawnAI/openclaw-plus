import { writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../config/config.js";
import { clearSessionStoreCacheForTest } from "../config/sessions/store.js";
import {
  type DeviceIdentity,
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
  signDevicePayload,
} from "../infra/device-identity.js";
import { rawDataToString } from "../infra/ws.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { getDeterministicFreePortBlock } from "../test-utils/ports.js";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
  type GatewayClientMode,
  type GatewayClientName,
} from "../utils/message-channel.js";
import { GatewayClient } from "./client.js";
import { buildDeviceAuthPayloadV3 } from "./device-auth.js";
import { PROTOCOL_VERSION } from "./protocol/index.js";
import { startGatewayServer } from "./server.js";

export async function getFreeGatewayPort(): Promise<number> {
  return await getDeterministicFreePortBlock({ offsets: [0, 1, 2, 3, 4] });
}

export async function connectGatewayClient(params: {
  url: string;
  token?: string;
  deviceToken?: string;
  clientName?: GatewayClientName;
  clientDisplayName?: string;
  clientVersion?: string;
  mode?: GatewayClientMode;
  platform?: string;
  deviceFamily?: string;
  role?: "operator" | "node";
  scopes?: string[];
  caps?: string[];
  commands?: string[];
  instanceId?: string;
  deviceIdentity?: DeviceIdentity;
  onEvent?: (evt: { event?: string; payload?: unknown }) => void;
  connectChallengeTimeoutMs?: number;
  timeoutMs?: number;
  timeoutMessage?: string;
}) {
  const role = params.role ?? "operator";
  const scopes = params.scopes ?? (role === "node" ? [] : undefined);
  const platform = params.platform ?? process.platform;
  const identityRoot = process.env.OPENCLAW_STATE_DIR ?? process.env.HOME ?? os.tmpdir();
  const deviceIdentity =
    params.deviceIdentity ??
    loadOrCreateDeviceIdentity(
      (() => {
        const safe = normalizeLowercaseStringOrEmpty(
          `${params.clientName ?? GATEWAY_CLIENT_NAMES.TEST}-${params.mode ?? GATEWAY_CLIENT_MODES.TEST}-${platform}-${params.deviceFamily ?? "none"}-${role}`.replace(
            /[^a-zA-Z0-9._-]+/g,
            "_",
          ),
        );
        return path.join(identityRoot, "test-device-identities", `${safe}.json`);
      })(),
    );
  return await new Promise<InstanceType<typeof GatewayClient>>((resolve, reject) => {
    let settled = false;
    const stop = (err?: Error, client?: InstanceType<typeof GatewayClient>) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (err) {
        reject(err);
      } else {
        resolve(client as InstanceType<typeof GatewayClient>);
      }
    };
    const client = new GatewayClient({
      url: params.url,
      token: params.token,
      deviceToken: params.deviceToken,
      connectChallengeTimeoutMs: params.connectChallengeTimeoutMs ?? 0,
      clientName: params.clientName ?? GATEWAY_CLIENT_NAMES.TEST,
      clientDisplayName: params.clientDisplayName ?? "vitest",
      clientVersion: params.clientVersion ?? "dev",
      platform,
      deviceFamily: params.deviceFamily,
      mode: params.mode ?? GATEWAY_CLIENT_MODES.TEST,
      role,
      scopes,
      caps: params.caps,
      commands: params.commands,
      instanceId: params.instanceId,
      deviceIdentity,
      onEvent: params.onEvent,
      onHelloOk: () => stop(undefined, client),
      onConnectError: (err) => stop(err),
      onClose: (code, reason) =>
        stop(new Error(`gateway closed during connect (${code}): ${reason}`)),
    });
    const timer = setTimeout(
      () => stop(new Error(params.timeoutMessage ?? "gateway connect timeout")),
      params.timeoutMs ?? 10_000,
    );
    timer.unref();
    client.start();
  });
}

export async function disconnectGatewayClient(client: GatewayClient): Promise<void> {
  await client.stopAndWait();
}

const DEVICE_AUTH_REQ_TIMEOUT_MS = 10_000;

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForWsOpen(ws: WebSocket, timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      ws.terminate();
      reject(new Error("timeout waiting for ws open"));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      ws.off("open", openHandler);
      ws.off("error", errorHandler);
      ws.off("close", closeHandler);
    };
    const openHandler = () => {
      cleanup();
      resolve();
    };
    const errorHandler = (err: Error) => {
      cleanup();
      reject(err);
    };
    const closeHandler = (code: number, reason: Buffer) => {
      cleanup();
      reject(new Error(`closed before open ${code}: ${rawDataToString(reason)}`));
    };
    ws.once("open", openHandler);
    ws.once("error", errorHandler);
    ws.once("close", closeHandler);
  });
}

async function closeWsGracefully(ws: WebSocket, timeoutMs: number): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) {
    return;
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      cleanup();
      ws.terminate();
      resolve();
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      ws.off("close", closeHandler);
      ws.off("error", errorHandler);
    };
    const closeHandler = () => {
      cleanup();
      resolve();
    };
    const errorHandler = () => {
      cleanup();
      resolve();
    };
    ws.once("close", closeHandler);
    ws.once("error", errorHandler);
    if (ws.readyState === WebSocket.OPEN) {
      ws.close();
    } else if (ws.readyState !== WebSocket.CLOSING) {
      ws.terminate();
    }
  });
}

export async function connectDeviceAuthReq(params: {
  url: string;
  token?: string;
  timeoutMs?: number;
}) {
  const timeoutMs = params.timeoutMs ?? DEVICE_AUTH_REQ_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  let lastError: Error | undefined;
  while (Date.now() < deadline) {
    const attemptTimeoutMs = Math.max(250, Math.min(5000, deadline - Date.now()));
    try {
      return await connectDeviceAuthReqOnce({ ...params, timeoutMs: attemptTimeoutMs });
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      await sleep(Math.min(100, Math.max(0, deadline - Date.now())));
    }
  }
  throw new Error(
    `device auth request failed after ${timeoutMs}ms: ${lastError?.message ?? "unknown error"}`,
  );
}

async function connectDeviceAuthReqOnce(params: {
  url: string;
  token?: string;
  timeoutMs: number;
}) {
  const ws = new WebSocket(params.url);
  const connectNoncePromise = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("timeout waiting for connect challenge"));
    }, params.timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      ws.off("message", handler);
      ws.off("close", closeHandler);
      ws.off("error", errorHandler);
    };
    const closeHandler = (code: number, reason: Buffer) => {
      cleanup();
      reject(new Error(`closed ${code}: ${rawDataToString(reason)}`));
    };
    const errorHandler = (err: Error) => {
      cleanup();
      reject(err);
    };
    const handler = (data: WebSocket.RawData) => {
      try {
        const obj = JSON.parse(rawDataToString(data)) as {
          type?: unknown;
          event?: unknown;
          payload?: { nonce?: unknown } | null;
        };
        if (obj.type !== "event" || obj.event !== "connect.challenge") {
          return;
        }
        const nonce = obj.payload?.nonce;
        if (typeof nonce !== "string" || nonce.trim().length === 0) {
          return;
        }
        cleanup();
        resolve(nonce.trim());
      } catch {
        // ignore parse errors while waiting for challenge
      }
    };
    ws.on("message", handler);
    ws.once("close", closeHandler);
    ws.once("error", errorHandler);
  });
  try {
    await waitForWsOpen(ws, params.timeoutMs);
  } catch (err) {
    ws.terminate();
    throw err;
  }
  const connectNonce = await connectNoncePromise.catch((err: unknown) => {
    ws.terminate();
    throw err;
  });
  const identity = loadOrCreateDeviceIdentity();
  const signedAtMs = Date.now();
  const platform = process.platform;
  const payload = buildDeviceAuthPayloadV3({
    deviceId: identity.deviceId,
    clientId: GATEWAY_CLIENT_NAMES.TEST,
    clientMode: GATEWAY_CLIENT_MODES.TEST,
    role: "operator",
    scopes: [],
    signedAtMs,
    token: params.token ?? null,
    nonce: connectNonce,
    platform,
  });
  const device = {
    id: identity.deviceId,
    publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
    signature: signDevicePayload(identity.privateKeyPem, payload),
    signedAt: signedAtMs,
    nonce: connectNonce,
  };
  const responsePromise = new Promise<{
    type: "res";
    id: string;
    ok: boolean;
    error?: { message?: string };
  }>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("timeout waiting for connect response"));
    }, params.timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      ws.off("message", handler);
      ws.off("close", closeHandler);
      ws.off("error", errorHandler);
    };
    const closeHandler = (code: number, reason: Buffer) => {
      cleanup();
      reject(new Error(`closed ${code}: ${rawDataToString(reason)}`));
    };
    const errorHandler = (err: Error) => {
      cleanup();
      reject(err);
    };
    const handler = (data: WebSocket.RawData) => {
      const obj = JSON.parse(rawDataToString(data)) as { type?: unknown; id?: unknown };
      if (obj?.type !== "res" || obj?.id !== "c1") {
        return;
      }
      cleanup();
      resolve(
        obj as {
          type: "res";
          id: string;
          ok: boolean;
          error?: { message?: string };
        },
      );
    };
    ws.on("message", handler);
    ws.once("close", closeHandler);
    ws.once("error", errorHandler);
  });
  ws.send(
    JSON.stringify({
      type: "req",
      id: "c1",
      method: "connect",
      params: {
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
        client: {
          id: GATEWAY_CLIENT_NAMES.TEST,
          displayName: "vitest",
          version: "dev",
          platform,
          mode: GATEWAY_CLIENT_MODES.TEST,
        },
        caps: [],
        auth: params.token ? { token: params.token } : undefined,
        device,
      },
    }),
  );
  const res = await responsePromise.catch((err: unknown) => {
    ws.terminate();
    throw err;
  });
  await closeWsGracefully(ws, Math.min(1000, params.timeoutMs));
  return res;
}

export async function startGatewayWithClient(params: {
  cfg: unknown;
  configPath: string;
  token: string;
  clientDisplayName?: string;
}) {
  await writeFile(params.configPath, `${JSON.stringify(params.cfg, null, 2)}\n`);
  process.env.OPENCLAW_CONFIG_PATH = params.configPath;
  clearRuntimeConfigSnapshot();
  clearConfigCache();
  clearSessionStoreCacheForTest();

  const port = await getFreeGatewayPort();
  const server = await startGatewayServer(port, {
    bind: "loopback",
    auth: { mode: "token", token: params.token },
    controlUiEnabled: false,
  });
  const client = await connectGatewayClient({
    url: `ws://127.0.0.1:${port}`,
    token: params.token,
    clientDisplayName: params.clientDisplayName,
  });

  return { port, server, client };
}
