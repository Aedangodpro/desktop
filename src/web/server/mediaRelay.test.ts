import { Readable, Writable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMediaRelay } from "./mediaRelay";

interface MockResponse {
  res: ServerResponse;
  status: () => number;
  headers: () => Record<string, string>;
  body: () => string;
  finished: Promise<void>;
}

function mockResponse(): MockResponse {
  const chunks: Buffer[] = [];
  let status = 0;
  let headers: Record<string, string> = {};

  const res = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk as Buffer));
      callback();
    },
  }) as unknown as ServerResponse;

  (res as unknown as { writeHead: unknown }).writeHead = (
    nextStatus: number,
    nextHeaders: Record<string, string>,
  ) => {
    status = nextStatus;
    headers = nextHeaders ?? {};
    return res;
  };

  const finished = new Promise<void>((resolve) => res.on("finish", resolve));

  return {
    res,
    status: () => status,
    headers: () => headers,
    body: () => Buffer.concat(chunks).toString(),
    finished,
  };
}

function mockRequest(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): IncomingMessage {
  const req = Readable.from(
    init.body ? [Buffer.from(init.body)] : [],
  ) as unknown as IncomingMessage;
  req.method = init.method ?? "GET";
  req.url = url;
  req.headers = init.headers ?? {};
  return req;
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("media relay", () => {
  it("leaves unrelated paths to the rest of the server", async () => {
    const handle = createMediaRelay();
    const response = mockResponse();
    const handled = await handle(mockRequest("/v1/me"), response.res);
    expect(handled).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a host that the desktop CORS list does not trust", async () => {
    const handle = createMediaRelay();
    const response = mockResponse();
    await handle(
      mockRequest(`/__media?url=${encodeURIComponent("https://evil.test/a.mp3")}`),
      response.res,
    );
    expect(response.status()).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("relays a ranged media request and adds CORS headers", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(new Uint8Array([0]), {
          status: 206,
          headers: { "content-range": "bytes 0-0/100" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(new Uint8Array([1, 2, 3]), {
          status: 206,
          headers: {
            "content-type": "audio/webm",
            "content-range": "bytes 0-2/100",
          },
        }),
      );
    const target = "https://rr1---sn-abc.googlevideo.com/videoplayback?id=1";
    const handle = createMediaRelay();
    const response = mockResponse();

    await handle(
      mockRequest(`/__media?url=${encodeURIComponent(target)}`, {
        headers: { range: "bytes=0-2" },
      }),
      response.res,
    );
    await response.finished;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[1]!;
    expect(url.toString()).toBe(target);
    // a 256 KiB window: googlevideo refuses anything larger
    expect(init.headers.range).toBe("bytes=0-98");
    expect(response.status()).toBe(206);
    expect(response.headers()["access-control-allow-origin"]).toBe("*");
    expect(response.headers()["content-type"]).toBe("audio/webm");
    expect(response.body()).toBe("\u0001\u0002\u0003");
  });

  it("probes the total and asks for bytes when the caller sent no range", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(new Uint8Array([0]), {
          status: 206,
          headers: { "content-range": "bytes 0-0/100" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(new Uint8Array([1]), {
          status: 206,
          headers: { "content-type": "audio/mp4" },
        }),
      );
    const target = "https://rr1---sn-abc.googlevideo.com/videoplayback?id=1";
    const handle = createMediaRelay();
    const response = mockResponse();

    await handle(
      mockRequest(`/__media?url=${encodeURIComponent(target)}`),
      response.res,
    );
    await response.finished;

    // a range-less or over-long range is refused with 403 upstream
    expect(fetchMock.mock.calls[0]![1].headers.range).toBe("bytes=0-0");
    expect(fetchMock.mock.calls[1]![1].headers.range).toBe("bytes=0-98");
    expect(response.status()).toBe(206);
  });

  it("resolves an open-ended media element range against the real size", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(new Uint8Array([0]), {
          status: 206,
          headers: { "content-range": "bytes 0-0/100" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(new Uint8Array([1]), {
          status: 206,
          headers: { "content-type": "audio/mp4" },
        }),
      );
    const target = "https://rr1---sn-abc.googlevideo.com/videoplayback?id=1";
    const handle = createMediaRelay();
    const response = mockResponse();

    await handle(
      mockRequest(`/__media?url=${encodeURIComponent(target)}`, {
        headers: { range: "bytes=0-" },
      }),
      response.res,
    );
    await response.finished;

    expect(fetchMock.mock.calls[1]![1].headers.range).toBe("bytes=0-98");
  });

  it("forwards an explicit start/end window from the chunked downloader", async () => {
    fetchMock.mockResolvedValue(
      new Response(new Uint8Array([1]), {
        status: 206,
        headers: { "content-type": "audio/mp4" },
      }),
    );
    const target = "https://rr1---sn-abc.googlevideo.com/videoplayback?id=1";
    const handle = createMediaRelay();
    const response = mockResponse();

    await handle(
      mockRequest(
        `/__media?url=${encodeURIComponent(target)}&start=1048576&end=2097151`,
      ),
      response.res,
    );
    await response.finished;

    expect(fetchMock.mock.calls[0]![1].headers.range).toBe(
      "bytes=1048576-2097151",
    );
  });

  it("relays Innertube posts from the site that owns the endpoint", async () => {
    fetchMock.mockResolvedValue(
      new Response('{"playabilityStatus":{"status":"OK"}}', {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const handle = createMediaRelay();
    const response = mockResponse();

    await handle(
      mockRequest("/__yt/music.youtube.com/youtubei/v1/player?prettyPrint=false", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: "secret=1",
          origin: "http://localhost:3000",
          "x-youtube-client-name": "67",
        },
        body: '{"videoId":"abc"}',
      }),
      response.res,
    );
    await response.finished;

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      "https://music.youtube.com/youtubei/v1/player?prettyPrint=false",
    );
    expect(init.method).toBe("POST");
    expect(init.headers.origin).toBe("https://music.youtube.com");
    expect(init.headers.cookie).toBeUndefined();
    expect(init.headers["x-youtube-client-name"]).toBe("67");
    expect(Buffer.from(init.body).toString()).toBe('{"videoId":"abc"}');
    expect(response.status()).toBe(200);
    expect(response.headers()["access-control-allow-origin"]).toBe("*");
  });

  it("does not relay Innertube to a host outside the allowlist", async () => {
    const handle = createMediaRelay();
    const response = mockResponse();
    await handle(
      mockRequest("/__yt/example.com/youtubei/v1/player"),
      response.res,
    );
    expect(response.status()).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
