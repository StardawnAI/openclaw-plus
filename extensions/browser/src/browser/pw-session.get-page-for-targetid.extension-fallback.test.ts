import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { connectOverCdpMock, getChromeWebSocketUrlMock } from "./pw-session.mock-setup.js";

let closePlaywrightBrowserConnection: typeof import("./pw-session.js").closePlaywrightBrowserConnection;
let getPageForTargetId: typeof import("./pw-session.js").getPageForTargetId;
let listPagesViaPlaywright: typeof import("./pw-session.js").listPagesViaPlaywright;

type MockPageSpec = {
  targetId?: string;
  url?: string;
  title?: string;
};

type BrowserMockBundle = {
  browser: import("playwright-core").Browser;
  browserClose: ReturnType<typeof vi.fn>;
  pages: import("playwright-core").Page[];
};

function makeBrowser(pages: MockPageSpec[]): BrowserMockBundle {
  let context: import("playwright-core").BrowserContext;
  const browserClose = vi.fn(async () => {});
  const targetIdByPage = new Map<import("playwright-core").Page, string | undefined>();

  const pageObjects = pages.map((spec, index) => {
    const page = {
      on: vi.fn(),
      context: () => context,
      title: vi.fn(async () => spec.title ?? spec.targetId ?? `page-${index + 1}`),
      url: vi.fn(() => spec.url ?? `https://page-${index + 1}.example`),
    } as unknown as import("playwright-core").Page;
    targetIdByPage.set(page, spec.targetId);
    return page;
  });

  context = {
    pages: () => pageObjects,
    on: vi.fn(),
    newCDPSession: vi.fn(async (page: import("playwright-core").Page) => ({
      send: vi.fn(async (method: string) =>
        method === "Target.getTargetInfo"
          ? { targetInfo: { targetId: targetIdByPage.get(page) } }
          : {},
      ),
      detach: vi.fn(async () => {}),
    })),
  } as unknown as import("playwright-core").BrowserContext;

  const browser = {
    contexts: () => [context],
    on: vi.fn(),
    off: vi.fn(),
    close: browserClose,
  } as unknown as import("playwright-core").Browser;

  return { browser, browserClose, pages: pageObjects };
}

beforeAll(async () => {
  ({ closePlaywrightBrowserConnection, getPageForTargetId, listPagesViaPlaywright } =
    await import("./pw-session.js"));
});

afterEach(async () => {
  connectOverCdpMock.mockReset();
  getChromeWebSocketUrlMock.mockReset();
  await closePlaywrightBrowserConnection().catch(() => {});
});

function createExtensionFallbackBrowserHarness(options?: {
  urls?: string[];
  newCDPSessionError?: string;
}) {
  const pageOn = vi.fn();
  const contextOn = vi.fn();
  const browserOn = vi.fn();
  const browserClose = vi.fn(async () => {});
  const newCDPSession = vi.fn(async () => {
    throw new Error(options?.newCDPSessionError ?? "Not allowed");
  });

  const context = {
    pages: () => [],
    on: contextOn,
    newCDPSession,
  } as unknown as import("playwright-core").BrowserContext;

  const pages = (options?.urls ?? [undefined]).map(
    (url) =>
      Object.assign(
        { on: pageOn, context: () => context },
        url ? { url: () => url } : {},
      ) as unknown as import("playwright-core").Page,
  );
  (context as unknown as { pages: () => unknown[] }).pages = () => pages;

  const browser = {
    contexts: () => [context],
    on: browserOn,
    close: browserClose,
  } as unknown as import("playwright-core").Browser;

  connectOverCdpMock.mockResolvedValue(browser);
  getChromeWebSocketUrlMock.mockResolvedValue(null);
  return { browserClose, newCDPSession, pages };
}

describe("pw-session getPageForTargetId", () => {
  it("falls back to the only page when Playwright cannot resolve target ids", async () => {
    const { browserClose, pages } = createExtensionFallbackBrowserHarness();
    const [page] = pages;

    const resolved = await getPageForTargetId({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "NOT_A_TAB",
    });
    expect(resolved).toBe(page);

    await closePlaywrightBrowserConnection();
    expect(browserClose).toHaveBeenCalled();
  });

  it("uses the shared HTTP-base normalization when falling back to /json/list for direct WebSocket CDP URLs", async () => {
    const [, pageB] = createExtensionFallbackBrowserHarness({
      urls: ["https://alpha.example", "https://beta.example"],
    }).pages;

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => [
        { id: "TARGET_A", url: "https://alpha.example" },
        { id: "TARGET_B", url: "https://beta.example" },
      ],
    } as Response);

    try {
      const resolved = await getPageForTargetId({
        cdpUrl: "ws://127.0.0.1:18792/devtools/browser/SESSION?token=abc",
        targetId: "TARGET_B",
      });
      expect(resolved).toBe(pageB);
      expect(fetchSpy).toHaveBeenCalledWith(
        "http://127.0.0.1:18792/json/list?token=abc",
        expect.any(Object),
      );
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("resolves pages from /json/list when page CDP probing fails", async () => {
    const { newCDPSession, pages } = createExtensionFallbackBrowserHarness({
      urls: ["https://alpha.example", "https://beta.example"],
      newCDPSessionError: "Target.attachToBrowserTarget: Not allowed",
    });
    const [, pageB] = pages;

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => [
        { id: "TARGET_A", url: "https://alpha.example" },
        { id: "TARGET_B", url: "https://beta.example" },
      ],
    } as Response);

    try {
      const resolved = await getPageForTargetId({
        cdpUrl: "http://127.0.0.1:19993",
        targetId: "TARGET_B",
      });
      expect(resolved).toBe(pageB);
      expect(newCDPSession).toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("evicts a stale cached page-less browser once and succeeds on a fresh reconnect", async () => {
    const stale = makeBrowser([]);
    const fresh = makeBrowser([{ targetId: "TARGET_OK", url: "https://fresh.example" }]);

    connectOverCdpMock.mockResolvedValueOnce(stale.browser).mockResolvedValueOnce(fresh.browser);
    getChromeWebSocketUrlMock.mockResolvedValue(null);

    await listPagesViaPlaywright({ cdpUrl: "http://127.0.0.1:9222" });

    const resolved = await getPageForTargetId({ cdpUrl: "http://127.0.0.1:9222" });

    expect(resolved).toBe(fresh.pages[0]);
    expect(connectOverCdpMock).toHaveBeenCalledTimes(2);
    expect(stale.browserClose).toHaveBeenCalledTimes(1);
  });

  it("evicts a stale cached tab-selection miss once and succeeds on a fresh reconnect", async () => {
    const stale = makeBrowser([
      { targetId: "TARGET_A", url: "https://alpha.example" },
      { targetId: "TARGET_C", url: "https://charlie.example" },
    ]);
    const fresh = makeBrowser([
      { targetId: "TARGET_A", url: "https://alpha.example" },
      { targetId: "TARGET_B", url: "https://beta.example" },
    ]);

    connectOverCdpMock.mockResolvedValueOnce(stale.browser).mockResolvedValueOnce(fresh.browser);
    getChromeWebSocketUrlMock.mockResolvedValue(null);

    await getPageForTargetId({ cdpUrl: "http://127.0.0.1:9333" });

    const resolved = await getPageForTargetId({
      cdpUrl: "http://127.0.0.1:9333",
      targetId: "TARGET_B",
    });

    expect(resolved).toBe(fresh.pages[1]);
    expect(connectOverCdpMock).toHaveBeenCalledTimes(2);
    expect(stale.browserClose).toHaveBeenCalledTimes(1);
  });

  it("fails after a single reconnect when the refreshed browser is still page-less", async () => {
    const stale = makeBrowser([]);
    const stillBroken = makeBrowser([]);

    connectOverCdpMock
      .mockResolvedValueOnce(stale.browser)
      .mockResolvedValueOnce(stillBroken.browser);
    getChromeWebSocketUrlMock.mockResolvedValue(null);

    await listPagesViaPlaywright({ cdpUrl: "http://127.0.0.1:9444" });

    await expect(getPageForTargetId({ cdpUrl: "http://127.0.0.1:9444" })).rejects.toThrow(
      "No pages available in the connected browser.",
    );
    expect(connectOverCdpMock).toHaveBeenCalledTimes(2);
    expect(stale.browserClose).toHaveBeenCalledTimes(1);
  });

  it("does not add an extra top-level retry for non-recoverable connect failures", async () => {
    connectOverCdpMock.mockRejectedValue(new Error("connectOverCDP exploded"));
    getChromeWebSocketUrlMock.mockResolvedValue(null);

    await expect(getPageForTargetId({ cdpUrl: "http://127.0.0.1:9555" })).rejects.toThrow(
      "connectOverCDP exploded",
    );
    expect(connectOverCdpMock).toHaveBeenCalledTimes(3);
  });
});
