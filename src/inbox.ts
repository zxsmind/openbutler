/** One agent-facing inbox. Sources own their durable content and handling state. */
export interface InboxItem {
  reference: string;
  receivedAt: string;
  state: 'unread' | 'read';
}

export interface InboxSource {
  name: string;
  list: (sessionId: string) => Promise<{ items: InboxItem[]; remaining?: number }>;
  read: (references: readonly string[], sessionId: string) => Promise<Array<{ reference: string; content: unknown }>>;
  acknowledge: (references: readonly string[], sessionId: string) => Promise<unknown>;
}

export interface InboxRequest {
  action: 'list' | 'read' | 'acknowledge';
  source?: string;
  ids?: readonly string[];
  limit?: number;
  offset?: number;
}

export function inboxId(source: string, reference: string): string {
  return `${encodeURIComponent(source)}:${encodeURIComponent(reference)}`;
}

export function inboxNotice(source: string, count: number): string {
  return `You have ${count} ${JSON.stringify(source)} notification${count === 1 ? '' : 's'}. Use inbox to read.`;
}

export class AgentInbox {
  private readonly sources = new Map<string, InboxSource>();

  register(source: InboxSource): void {
    if (this.sources.has(source.name)) throw new Error(`Inbox source already registered: ${source.name}`);
    this.sources.set(source.name, source);
  }

  async execute(request: InboxRequest, sessionId: string | undefined): Promise<unknown> {
    if (!sessionId) return { status: 'denied', error: 'The reading session could not be identified.' };
    if (request.action === 'acknowledge' && !request.ids?.length)
      return { status: 'invalid', error: 'acknowledge requires notification ids.' };
    if (request.source && !this.sources.has(request.source)) return { status: 'invalid', error: 'Unknown inbox source.' };
    const sources = [...this.sources.values()].filter((source) => !request.source || source.name === request.source);
    const errors: Array<{ source: string; error: string }> = [];
    const limit = request.limit ?? 20;
    const offset = request.offset ?? 0;
    if (request.action === 'list' || !request.ids?.length) {
      const pages = await Promise.all(
        sources.map(async (source) => {
          try {
            const page = await source.list(sessionId);
            return { source: source.name, ...page };
          } catch (error) {
            errors.push({ source: source.name, error: error instanceof Error ? error.message : String(error) });
            return { source: source.name, items: [], remaining: 0 };
          }
        }),
      );
      const items = pages
        .flatMap((page) => page.items.map((item) => ({ ...item, source: page.source, id: inboxId(page.source, item.reference) })))
        .sort((left, right) => left.receivedAt.localeCompare(right.receivedAt) || left.id.localeCompare(right.id));
      const total = items.length + pages.reduce((sum, page) => sum + (page.remaining ?? 0), 0);
      if (request.action === 'list') {
        return {
          type: 'inbox',
          status: errors.length ? 'partial' : 'ok',
          sources: pages.map((page) => ({
            source: page.source,
            count: page.items.length + (page.remaining ?? 0),
            unread: page.items.filter((item) => item.state === 'unread').length,
          })),
          items: items.slice(offset, offset + limit).map(({ reference: _reference, ...item }) => item),
          remaining: Math.max(0, total - offset - limit),
          errors,
        };
      }
      request = {
        ...request,
        ids: items
          .filter((item) => item.state === 'unread')
          .slice(0, limit)
          .map((item) => item.id),
      };
    }
    const grouped = new Map<InboxSource, string[]>();
    for (const id of request.ids ?? []) {
      const separator = id.indexOf(':');
      if (separator < 1) return { status: 'invalid', error: 'Use a notification id returned by inbox.' };
      let name: string;
      let reference: string;
      try {
        name = decodeURIComponent(id.slice(0, separator));
        reference = decodeURIComponent(id.slice(separator + 1));
      } catch {
        return { status: 'invalid', error: 'Invalid notification id.' };
      }
      const source = this.sources.get(name);
      if (!source || !reference || (request.source && request.source !== name))
        return { status: 'invalid', error: 'The notification does not belong to the selected inbox source.' };
      grouped.set(source, [...new Set([...(grouped.get(source) ?? []), reference])]);
    }
    const items: Array<{ id: string; source: string; content: unknown }> = [];
    const acknowledgements: Array<{ source: string; ids: string[]; result: unknown }> = [];
    // Grouped reads keep each source's attachment and transaction limits intact.
    for (const [source, references] of grouped) {
      try {
        if (request.action === 'acknowledge') {
          acknowledgements.push({
            source: source.name,
            ids: references.map((reference) => inboxId(source.name, reference)),
            result: await source.acknowledge(references, sessionId),
          });
        } else {
          const results = await source.read(references, sessionId);
          for (const result of results)
            items.push({ id: inboxId(source.name, result.reference), source: source.name, content: result.content });
        }
      } catch (error) {
        errors.push({ source: source.name, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return { type: 'inbox', status: errors.length ? 'partial' : 'ok', action: request.action, items, acknowledgements, errors };
  }
}
