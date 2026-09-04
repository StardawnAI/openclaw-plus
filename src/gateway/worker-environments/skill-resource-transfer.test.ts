import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { loadWorkspaceSkills } from "../../skills/loading/workspace-skill-loader.js";
import { buildSkillSnapshot } from "../../skills/loading/workspace-skill-prompt.js";
import { transferSkillResources } from "./skill-resource-transfer.js";
import {
  createNodeCarrier,
  NODE_WORKER_WORKSPACE_STDIN_MAX_BYTES,
} from "./skill-resource-transfer.test-support.js";
import type { WorkerWorkspaceTunnelHandle } from "./tunnel-contract.js";

const temps = useAutoCleanupTempDirTracker(afterEach);
const tunnel: Pick<WorkerWorkspaceTunnelHandle, "runWorkspaceCommand"> = {
  runWorkspaceCommand: async (command) => {
    command.assertCurrent?.();
    return new Promise((resolve, reject) => {
      const child = spawn(command.argv[0]!, command.argv.slice(1), {
        stdio: "pipe",
        signal: command.signal,
      });
      let stdout = "",
        stderr = "";
      child.stdout.on("data", (bytes) => {
        stdout += bytes;
      });
      child.stderr.on("data", (bytes) => {
        stderr += bytes;
      });
      child.on("error", reject);
      child.on("close", (code) =>
        resolve({ stdout, stderr, code, termination: "exit", signal: null, killed: false }),
      );
      child.stdin.end(command.input);
    });
  },
};

async function createSource() {
  const workspace = await fs.realpath(temps.make("remote-skill-source-"));
  const baseDir = path.join(workspace, "skills", "source");
  await fs.mkdir(path.join(baseDir, "scripts"), { recursive: true });
  const filePath = path.join(baseDir, "SKILL.md");
  await fs.writeFile(
    filePath,
    "---\ndescription: Resource transfer test\n---\n# Resource\nRead data.bin and run scripts/check.sh.\n",
  );
  const binary = Buffer.alloc(150000, 129);
  await fs.writeFile(path.join(baseDir, "data.bin"), binary);
  await fs.writeFile(path.join(baseDir, "scripts/check.sh"), "#!/bin/sh\nprintf ready\n", {
    mode: 0o700,
  });
  return {
    workspace,
    filePath,
    binary,
    snapshot: buildSkillSnapshot(workspace, {
      entries: loadWorkspaceSkills(workspace, { workspaceOnly: true }),
    }),
  };
}

async function expectRejectedResourceRequest(
  carrier: string,
  mutate: (input: string) => string,
  message = "Skill resource transfer failed",
) {
  const { snapshot } = await createSource();
  const transport =
    carrier === "node" ? await createNodeCarrier(temps.make("skill-resource-node-")) : tunnel;
  let initializedRoot: string | undefined;
  let injected = false;
  try {
    await expect(
      transferSkillResources({
        snapshot,
        assertCurrent: () => {},
        tunnel: {
          runWorkspaceCommand: async (command) => {
            const operation = JSON.parse(command.input!);
            let dispatched = command;
            if (operation.op === "write" && !injected) {
              dispatched = { ...command, input: mutate(command.input!) };
              injected = true;
            }
            const result = await transport.runWorkspaceCommand(dispatched);
            if (operation.op === "init") {
              initializedRoot = JSON.parse(result.stdout).root;
            }
            return result;
          },
        },
      }),
    ).rejects.toThrow(message);
    expect(injected).toBe(true);
    await expect(fs.stat(initializedRoot!)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    if (initializedRoot) {
      await fs.rm(initializedRoot, { recursive: true, force: true });
    }
  }
}

describe("remote-exec skill resources", () => {
  it("transfers resources through the node workspace boundary despite a project path collision", async () => {
    const { snapshot, binary } = await createSource();
    const carrier = await createNodeCarrier(temps.make("skill-resource-node-"));
    const outside = await fs.realpath(temps.make("skill-resource-project-link-"));
    await fs.writeFile(path.join(outside, "SKILL.md"), "project marker");
    await fs.symlink(outside, path.join(carrier.workspace, "0"));
    let initializedRoot: string | undefined;
    const requestSizes: number[] = [];
    try {
      const resources = await transferSkillResources({
        snapshot,
        assertCurrent: () => {},
        tunnel: {
          runWorkspaceCommand: async (command) => {
            requestSizes.push(Buffer.byteLength(command.input!));
            const result = await carrier.runWorkspaceCommand(command);
            initializedRoot ??= JSON.parse(result.stdout).root;
            return result;
          },
        },
      });
      const remote = resources!.mounts[0]!.containerPath;
      expect(remote.startsWith(carrier.workspace)).toBe(false);
      expect(await fs.readFile(path.join(remote, "data.bin"))).toEqual(binary);
      expect(await fs.readFile(path.join(outside, "SKILL.md"), "utf8")).toBe("project marker");
      const largestRequest = Math.max(...requestSizes);
      expect(largestRequest).toBeLessThanOrEqual(NODE_WORKER_WORKSPACE_STDIN_MAX_BYTES);
      expect(NODE_WORKER_WORKSPACE_STDIN_MAX_BYTES - largestRequest).toBeLessThan(4);
      await resources!.cleanup();
      await expect(fs.stat(initializedRoot!)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (initializedRoot) {
        await fs.rm(initializedRoot, { recursive: true, force: true });
      }
    }
  });

  it.each([
    { name: "forged path id", patch: { id: "../outside" } },
    { name: "unallocated id", patch: { id: randomUUID().replaceAll("-", "") } },
    { name: "wrong inode", patch: { identity: "0:0" } },
    { name: "absolute root input", patch: { root: "/tmp" } },
    { name: "digest mismatch", patch: { hash: "0".repeat(64) } },
  ])("rejects $name and cleans only the allocated resources", async ({ patch }) => {
    await expectRejectedResourceRequest("node", (input) =>
      JSON.stringify({ ...JSON.parse(input), ...patch }),
    );
  });

  it("rejects resource-relative traversal without writing outside its owned directory", async () => {
    const outside = await fs.realpath(temps.make("skill-resource-escape-"));
    await expectRejectedResourceRequest("node", (input) =>
      JSON.stringify({ ...JSON.parse(input), name: `../${path.basename(outside)}/marker` }),
    );
    expect(await fs.readdir(outside)).toEqual([]);
  });

  it.each(["direct", "node"])(
    "rejects an oversized typed resource request over %s",
    async (carrier) => {
      await expectRejectedResourceRequest(
        carrier,
        (input) =>
          input + " ".repeat(NODE_WORKER_WORKSPACE_STDIN_MAX_BYTES + 1 - Buffer.byteLength(input)),
        carrier === "node"
          ? "workspace command input exceeds its bound"
          : "Skill resource transfer failed",
      );
    },
  );

  it("cleans the accepted node resource directory when cancellation arrives with initialization", async () => {
    const { snapshot } = await createSource();
    const transport = await createNodeCarrier(temps.make("skill-resource-node-"));
    const controller = new AbortController();
    let initializedRoot: string | undefined;
    try {
      await expect(
        transferSkillResources({
          snapshot,
          signal: controller.signal,
          assertCurrent: () => {},
          tunnel: {
            runWorkspaceCommand: async (command) => {
              const result = await transport.runWorkspaceCommand(command);
              if (!initializedRoot) {
                const initialized: { root: string } = JSON.parse(result.stdout);
                initializedRoot = initialized.root;
                controller.abort();
              }
              return result;
            },
          },
        }),
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(initializedRoot).toBeDefined();
      await expect(fs.stat(initializedRoot!)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (initializedRoot) {
        await fs.rm(initializedRoot, { recursive: true, force: true });
      }
    }
  });

  it("rejects remote directory identities that collide when rounded to numbers", async () => {
    const { snapshot } = await createSource();
    let initializedRoot: string | undefined;
    try {
      await expect(
        transferSkillResources({
          snapshot,
          assertCurrent: () => {},
          tunnel: {
            runWorkspaceCommand: async (command) => {
              const initializing = JSON.parse(command.input!).op === "init";
              // Model adjacent Windows file indexes while retaining the real filesystem flow.
              const identityShim = `{
                const fs = require('node:fs');
                for (const method of ['lstatSync', 'statSync']) {
                  const original = fs[method];
                  fs[method] = (...args) => {
                    const stat = original(...args);
                    const ino = 9007199254740992n + ${initializing ? 0 : 1}n;
                    stat.ino = typeof stat.ino === 'bigint' ? ino : Number(ino);
                    return stat;
                  };
                }
              }`;
              const result = await tunnel.runWorkspaceCommand({
                ...command,
                argv: [...command.argv.slice(0, 2), identityShim + command.argv[2]],
              });
              if (initializing) {
                initializedRoot = JSON.parse(result.stdout).root;
              }
              return result;
            },
          },
        }),
      ).rejects.toThrow("Skill resource transfer failed");
      expect(initializedRoot).toBeDefined();
      await expect(fs.readdir(initializedRoot!)).resolves.toEqual([]);
    } finally {
      if (initializedRoot) {
        await fs.rm(initializedRoot, { recursive: true, force: true });
      }
    }
  });

  it.each(
    ["direct", "node"].flatMap((carrier) =>
      ["complete", "cancelled", "retired"].map((outcome) => ({ carrier, outcome })),
    ),
  )(
    "preserves complete resources outside the project and cleans up only its current owner ($carrier, $outcome)",
    async ({ carrier, outcome }) => {
      const { workspace, filePath, binary, snapshot } = await createSource();
      const controller = new AbortController();
      let current = true;
      const resources = await transferSkillResources({
        tunnel:
          carrier === "node" ? await createNodeCarrier(temps.make("skill-resource-node-")) : tunnel,
        signal: controller.signal,
        assertCurrent: () => {
          if (!current) {
            throw new Error("placement retired");
          }
        },
        snapshot,
      });
      expect(resources).toBeDefined();
      const remote = resources!.mounts[0]!.containerPath;
      try {
        expect(remote.startsWith(workspace)).toBe(false);
        expect(await fs.readFile(path.join(remote, "SKILL.md"))).toEqual(
          await fs.readFile(filePath),
        );
        expect(resources!.snapshot.resolvedSkills![0]!.name).toBe("source");
        expect(await fs.readFile(path.join(remote, "data.bin"))).toEqual(binary);
        expect((await fs.stat(path.join(remote, "scripts/check.sh"))).mode & 0o777).toBe(0o500);
        expect((await fs.stat(path.join(remote, "data.bin"))).mode & 0o777).toBe(0o400);
        expect(resources!.snapshot.prompt).toContain(remote);
        expect(resources!.snapshot.resolvedSkills![0]!.filePath).toBe(filePath);
        if (outcome === "cancelled") {
          controller.abort();
        } else if (outcome === "retired") {
          current = false;
        }
        if (outcome === "retired") {
          await expect(resources!.cleanup()).rejects.toThrow("placement retired");
          expect(await fs.readFile(path.join(remote, "data.bin"))).toEqual(binary);
        } else {
          await expect(resources!.cleanup()).resolves.toBeUndefined();
          await expect(fs.stat(remote)).rejects.toMatchObject({ code: "ENOENT" });
        }
      } finally {
        await fs.rm(path.dirname(remote), { recursive: true, force: true });
      }
    },
  );

  it("cleans the accepted remote directory when cancellation arrives with initialization", async () => {
    const { snapshot } = await createSource();
    const controller = new AbortController();
    let initializedRoot: string | undefined;
    try {
      await expect(
        transferSkillResources({
          snapshot,
          signal: controller.signal,
          assertCurrent: () => {},
          tunnel: {
            runWorkspaceCommand: async (command) => {
              const result = await tunnel.runWorkspaceCommand(command);
              if (!initializedRoot) {
                const initialized: { root: string } = JSON.parse(result.stdout);
                initializedRoot = initialized.root;
                controller.abort();
              }
              return result;
            },
          },
        }),
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(initializedRoot).toBeDefined();
      await expect(fs.stat(initializedRoot!)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (initializedRoot) {
        await fs.rm(initializedRoot, { recursive: true, force: true });
      }
    }
  });
});
