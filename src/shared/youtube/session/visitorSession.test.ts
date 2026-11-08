import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/web/proxyUrls", () => ({
  innertubeProxyUrl: (url: string) => url,
}));

const VISITOR = "CgtWSVNJVE9SMTIzNDU2Nzg5MEFCQ0RFRg";

function swData(visitor: string): string {
  const tuple = [
    "en",
    "US",
    null,
    "1.2.3.4",
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    "",
    "",
    visitor,
  ];
  return `)]}'\n${JSON.stringify([["yt.sw.adr", null, [[tuple]]]])}`;
}

async function load() {
  vi.resetModules();
  return import("./visitorSession");
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe("getClientVisitorData", () => {
  it("reads the visitor blob from sw.js_data", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(swData(VISITOR)));
    vi.stubGlobal("fetch", fetchMock);
    const session = await load();

    await expect(session.getClientVisitorData()).resolves.toBe(VISITOR);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("mints a visitor when sw.js_data answers without one", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("no visitor here"))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            responseContext: {
              visitorData: encodeURIComponent(VISITOR),
            },
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const session = await load();

    await expect(session.getClientVisitorData()).resolves.toBe(VISITOR);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
