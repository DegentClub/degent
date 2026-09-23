/**
 * In-memory ord for tests and `CERTIFY_ORD=fake` dev runs. Deterministic; records calls so tests
 * can assert paging behaviour.
 */
import { OrdError, type OrdChildrenPage, type OrdInscription, type OrdPort } from '../ports/ord.js';

export interface FakeInscription {
  id: string;
  number: number;
  height: number;
  content: Uint8Array | null;
  contentType?: string | null;
  parents?: string[];
}

export class FakeOrd implements OrdPort {
  height: number;
  readonly pageSize: number;
  readonly calls: string[] = [];
  private readonly inscriptions = new Map<string, FakeInscription>();
  /** Children listing per parent as ord would return it (may include ids whose record lacks the link). */
  private readonly childLists = new Map<string, string[]>();
  readonly vsizes = new Map<string, number>();
  /** Set to make every call fail (health / 502 tests). */
  down = false;

  constructor(opts: { height?: number; pageSize?: number } = {}) {
    this.height = opts.height ?? 900_000;
    this.pageSize = opts.pageSize ?? 100;
  }

  add(i: FakeInscription): this {
    this.inscriptions.set(i.id, { ...i, parents: i.parents ?? [] });
    return this;
  }

  /** Makes `childId` appear in `parentId`'s children listing (independently of its own record). */
  listChild(parentId: string, childId: string): this {
    const l = this.childLists.get(parentId) ?? [];
    l.push(childId);
    this.childLists.set(parentId, l);
    return this;
  }

  private check(call: string): void {
    this.calls.push(call);
    if (this.down) throw new OrdError('fake ord is down');
  }

  async blockHeight(): Promise<number> {
    this.check('blockheight');
    return this.height;
  }

  async inscription(id: string): Promise<OrdInscription | null> {
    this.check(`inscription ${id}`);
    const i = this.inscriptions.get(id);
    if (!i) return null;
    return {
      id: i.id,
      number: i.number,
      height: i.height,
      contentLength: i.content ? i.content.length : null,
      contentType: i.contentType ?? (i.content ? 'image/webp' : null),
      parents: [...(i.parents ?? [])],
    };
  }

  async children(parentId: string, page: number): Promise<OrdChildrenPage> {
    this.check(`children ${parentId} ${page}`);
    if (!this.inscriptions.has(parentId)) throw new OrdError('parent not found', 404);
    const all = this.childLists.get(parentId) ?? [];
    const ids = all.slice(page * this.pageSize, (page + 1) * this.pageSize);
    return { ids, more: (page + 1) * this.pageSize < all.length, page };
  }

  async content(id: string): Promise<Uint8Array | null> {
    this.check(`content ${id}`);
    const c = this.inscriptions.get(id)?.content;
    return c ? Uint8Array.from(c) : null;
  }

  async txVsize(txid: string): Promise<number | null> {
    this.check(`tx ${txid}`);
    return this.vsizes.get(txid) ?? null;
  }
}
