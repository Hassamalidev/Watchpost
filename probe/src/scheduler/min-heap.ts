/* Binary min-heap ordered by a numeric key (next run time). */
export class MinHeap<T> {
  private readonly items: Array<{ key: number; value: T }> = [];

  get size(): number {
    return this.items.length;
  }

  push(key: number, value: T): void {
    this.items.push({ key, value });
    this.up(this.items.length - 1);
  }

  peekKey(): number | undefined {
    return this.items[0]?.key;
  }

  pop(): { key: number; value: T } | undefined {
    const top = this.items[0];
    const last = this.items.pop();
    if (top === undefined || last === undefined) return undefined;
    if (this.items.length > 0) {
      this.items[0] = last;
      this.down(0);
    }
    return top;
  }

  private up(index: number): void {
    let i = index;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.key(parent) <= this.key(i)) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  private down(index: number): void {
    let i = index;
    for (;;) {
      const left = i * 2 + 1;
      const right = left + 1;
      let smallest = i;
      if (left < this.items.length && this.key(left) < this.key(smallest)) smallest = left;
      if (right < this.items.length && this.key(right) < this.key(smallest)) smallest = right;
      if (smallest === i) return;
      this.swap(i, smallest);
      i = smallest;
    }
  }

  private key(i: number): number {
    return this.items[i]?.key ?? Number.POSITIVE_INFINITY;
  }

  private swap(a: number, b: number): void {
    const tmp = this.items[a];
    const other = this.items[b];
    if (tmp === undefined || other === undefined) return;
    this.items[a] = other;
    this.items[b] = tmp;
  }
}
