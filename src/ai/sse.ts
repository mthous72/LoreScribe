/**
 * An incremental server-sent-events parser.
 *
 * Exists for the same reason the sanitiser has a streaming state machine: what
 * arrives from `fetch` is bytes cut wherever the network cut them, and an SSE
 * event is a run of lines ended by a blank line. A chunk can end mid-line,
 * mid-event, or mid-UTF-8 sequence — the decoder handles the last; this handles
 * the other two. Feed it whatever arrived and it returns only the events that
 * are complete.
 *
 * The spec's essentials and nothing else: `data:` lines (several concatenate
 * with newlines), `event:` and `id:`, comment lines beginning with `:` (which
 * OpenRouter sends as keep-alives while a request is queued), and either line
 * ending.
 */

export interface SseEvent {
  event: string | null;
  id: string | null;
  data: string;
}

export class SseParser {
  #buffer = '';
  #data: string[] = [];
  #event: string | null = null;
  #id: string | null = null;

  /** Text decoded from the next chunk. Returns every event completed by it. */
  feed(chunk: string): SseEvent[] {
    this.#buffer += chunk;
    const out: SseEvent[] = [];
    for (;;) {
      const nl = this.#buffer.search(/\r\n|\r|\n/);
      if (nl < 0) break;
      const line = this.#buffer.slice(0, nl);
      const ending = this.#buffer.startsWith('\r\n', nl) ? 2 : 1;
      this.#buffer = this.#buffer.slice(nl + ending);
      const done = this.#line(line);
      if (done) out.push(done);
    }
    return out;
  }

  /** The stream closed. A final event without a trailing blank line still counts. */
  end(): SseEvent[] {
    const out = this.#buffer ? this.feed('\n\n') : [];
    const last = this.#dispatch();
    if (last) out.push(last);
    this.#buffer = '';
    return out;
  }

  #line(line: string): SseEvent | null {
    if (line === '') return this.#dispatch();
    if (line.startsWith(':')) return null;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    switch (field) {
      case 'data': this.#data.push(value); break;
      case 'event': this.#event = value; break;
      case 'id': this.#id = value; break;
      default: break; // `retry` and unknown fields: ignored, per the spec
    }
    return null;
  }

  #dispatch(): SseEvent | null {
    if (this.#data.length === 0 && this.#event === null) return null;
    const event: SseEvent = { event: this.#event, id: this.#id, data: this.#data.join('\n') };
    this.#data = [];
    this.#event = null;
    return event;
  }
}
