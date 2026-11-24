import { describe, expect, it } from "vitest";
import { createSseParser, parseSseStream } from "./sse";

function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

describe("createSseParser", () => {
  it("reads the event name and JSON data of each frame", () => {
    const parser = createSseParser();
    const events = parser.push(
      'event: metadata\ndata: {"track":{"id":"t1"}}\n\n' +
        'event: provider\ndata: {"provider":"Atlas"}\n\n',
    );

    expect(events).toEqual([
      { event: "metadata", data: '{"track":{"id":"t1"}}' },
      { event: "provider", data: '{"provider":"Atlas"}' },
    ]);
  });

  it("waits for the blank line before emitting a frame", () => {
    const parser = createSseParser();
    expect(parser.push("event: done\ndata: {}\n")).toEqual([]);
    expect(parser.push("\n")).toEqual([{ event: "done", data: "{}" }]);
  });

  it("reassembles a frame split across chunks", () => {
    const parser = createSseParser();
    expect(parser.push('event: provider\ndata: {"pro')).toEqual([]);
    expect(parser.push('vider":"Polaris"}\n\n')).toEqual([
      { event: "provider", data: '{"provider":"Polaris"}' },
    ]);
  });

  it("accepts CRLF endings and comments", () => {
    const parser = createSseParser();
    const events = parser.push(
      ': keep-alive\r\nevent: done\r\ndata: {"best":1}\r\n\r\n',
    );
    expect(events).toEqual([{ event: "done", data: '{"best":1}' }]);
  });

  it("joins multi-line data and forwards id/retry", () => {
    const parser = createSseParser();
    const events = parser.push(
      "id: 42\nretry: 1500\nevent: note\ndata: first\ndata:second\n\n",
    );
    expect(events).toEqual([
      { event: "note", data: "first\nsecond", id: "42", retry: 1500 },
    ]);
  });

  it("ignores a frame with no data", () => {
    const parser = createSseParser();
    expect(parser.push("event: ping\n\n")).toEqual([]);
  });

  it("flushes a trailing frame that never got its blank line", () => {
    const parser = createSseParser();
    parser.push("event: done\ndata: {}");
    expect(parser.flush()).toEqual({ event: "done", data: "{}" });
    expect(parser.flush()).toBeNull();
  });
});

describe("parseSseStream", () => {
  it("streams frames from a byte stream", async () => {
    const received = [];
    for await (const event of parseSseStream(
      streamOf("event: a\ndata: 1\n\n", "event: b\ndata: 2\n\n"),
    )) {
      received.push(event);
    }

    expect(received).toEqual([
      { event: "a", data: "1" },
      { event: "b", data: "2" },
    ]);
  });

  it("yields the last frame when the stream ends without a terminator", async () => {
    const received = [];
    for await (const event of parseSseStream(streamOf("data: tail"))) {
      received.push(event);
    }
    expect(received).toEqual([{ event: "message", data: "tail" }]);
  });

  it("stops on an already aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const consume = async () => {
      for await (const _event of parseSseStream(
        streamOf("data: 1\n\n"),
        controller.signal,
      )) {
        // draining
      }
    };
    await expect(consume()).rejects.toMatchObject({ name: "AbortError" });
  });
});
