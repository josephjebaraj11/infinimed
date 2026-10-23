import type { Page } from "./types.js";

/**
 * A list call. Await it for one page; call `.autoPagingIterator()` to walk every page. Awaiting the
 * same PageRequest twice shares one network request.
 */
export class PageRequest<T, P extends Page<T> = Page<T>> implements PromiseLike<P> {
  private cached: Promise<P> | null = null;

  constructor(private readonly fetchPage: (startingAfter?: string) => Promise<P>) {}

  private first(): Promise<P> {
    if (!this.cached) this.cached = this.fetchPage(undefined);
    return this.cached;
  }

  then<R1 = P, R2 = never>(onfulfilled?: ((value: P) => R1 | PromiseLike<R1>) | null, onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null): Promise<R1 | R2> {
    return this.first().then(onfulfilled, onrejected);
  }

  async *autoPagingIterator(): AsyncGenerator<T, void, undefined> {
    let page = await this.first();
    for (;;) {
      for (const item of page.data) yield item;
      if (!page.has_more || !page.next_cursor) return;
      page = await this.fetchPage(page.next_cursor);
    }
  }

  /** Collects every item into an array (bounded by `max`, default 10,000). */
  async toArray(max = 10_000): Promise<T[]> {
    const out: T[] = [];
    for await (const item of this.autoPagingIterator()) {
      out.push(item);
      if (out.length >= max) break;
    }
    return out;
  }
}
