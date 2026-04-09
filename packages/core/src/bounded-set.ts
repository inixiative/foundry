/**
 * A set with bounded capacity that evicts oldest entries when full.
 * Used for message deduplication at harness ingress.
 */
export class BoundedSet<T> {
  private _items: T[] = [];
  private _set: Set<T> = new Set();
  private _capacity: number;

  constructor(capacity: number = 1000) {
    this._capacity = capacity;
  }

  /** Check if item exists in the set. */
  has(item: T): boolean {
    return this._set.has(item);
  }

  /** Add item. Returns true if newly added, false if already present. */
  add(item: T): boolean {
    if (this._set.has(item)) return false;

    this._set.add(item);
    this._items.push(item);

    if (this._items.length > this._capacity) {
      const evicted = this._items.shift()!;
      this._set.delete(evicted);
    }

    return true;
  }

  get size(): number {
    return this._set.size;
  }

  clear(): void {
    this._items = [];
    this._set.clear();
  }
}
