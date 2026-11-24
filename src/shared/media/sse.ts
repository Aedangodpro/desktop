/**
 * A small, spec-shaped Server-Sent Events reader.
 *
 * The lyrics endpoint streams one JSON object per `data:` frame, but frames can
 * arrive split across chunks, use CRLF line endings, or carry comments and
 * multi-line data. This parser handles those cases and keeps the event name, so
 * callers can switch on `metadata` / `provider` / `done` without re-parsing the
 * whole stream themselves.
 */

export interface SseEvent {
  /** Value of `event:`, or "message" when the stream omits it. */
  event: string;
  /** All `data:` lines of the frame, joined with newlines. */
  data: string;
  id?: string;
  retry?: number;
}

const EVENT_BOUNDARY = /\r\n\r\n|\n\n|\r\r/;
const LINE_BREAK = /\r\n|\n|\r/;

function parseBlock(block: string): SseEvent | null {
  let event = "message";
  let id: string | undefined;
  let retry: number | undefined;
  const data: string[] = [];

  for (const line of block.split(LINE_BREAK)) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");

    switch (field) {
      case "event":
        if (value) event = value;
        break;
      case "data":
        data.push(value);
        break;
      case "id":
        id = value;
        break;
      case "retry": {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) retry = parsed;
        break;
      }
      default:
        break;
    }
  }

  // the spec only dispatches a frame that carried data
  if (data.length === 0) return null;

  return {
    event,
    data: data.join("\n"),
    ...(id !== undefined ? { id } : {}),
    ...(retry !== undefined ? { retry } : {}),
  };
}

export interface SseParser {
  /** Feed decoded text; returns every frame completed by this chunk. */
  push: (chunk: string) => SseEvent[];
  /** Flush a final frame that closed without its blank-line terminator. */
  flush: () => SseEvent | null;
}

export function createSseParser(): SseParser {
  let buffer = "";

  return {
    push(chunk: string): SseEvent[] {
      buffer += chunk;
      const events: SseEvent[] = [];
      let match = EVENT_BOUNDARY.exec(buffer);
      while (match) {
        const block = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const event = parseBlock(block);
        if (event) events.push(event);
        match = EVENT_BOUNDARY.exec(buffer);
      }
      return events;
    },

    flush(): SseEvent | null {
      if (!buffer.trim()) {
        buffer = "";
        return null;
      }
      const event = parseBlock(buffer);
      buffer = "";
      return event;
    },
  };
}

function abortReason(signal: AbortSignal): unknown {
  return (
    signal.reason ?? new DOMException("The stream was aborted.", "AbortError")
  );
}

export async function* parseSseStream(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SseEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const parser = createSseParser();

  try {
    while (true) {
      if (signal?.aborted) throw abortReason(signal);
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      for (const event of parser.push(chunk)) yield event;
    }

    for (const event of parser.push(decoder.decode())) yield event;
    const last = parser.flush();
    if (last) yield last;
  } finally {
    reader.releaseLock();
  }
}
