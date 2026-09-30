type RendererFiber = Record<string, unknown>;

/** Resolve DOM ownership against React's published tree, not an abandoned alternate. */
export function committedReactAncestors(value: unknown): readonly RendererFiber[] {
  // This function is serialized into the Renderer. Keep its dependencies local.
  const asFiber = (candidate: unknown): RendererFiber | null =>
    candidate !== null && typeof candidate === "object" ? (candidate as RendererFiber) : null;
  const start = asFiber(value);
  if (!start) return [];
  const limit = 20_000;
  const path: RendererFiber[] = [];
  const visited = new Set<RendererFiber>();
  for (let node: RendererFiber | null = start; node; node = asFiber(node.return)) {
    if (visited.has(node) || visited.size >= limit) return [];
    visited.add(node);
    path.push(node);
  }
  const owner = asFiber(path.at(-1)?.stateNode);
  if (!owner || !("current" in owner)) return path;
  const published = asFiber(owner.current);
  if (!published) return [];
  const alternate = asFiber(start.alternate);
  type Entry = { node: RendererFiber; parent: Entry | null };
  const pending: Entry[] = [{ node: published, parent: null }];
  visited.clear();
  while (pending.length > 0 && visited.size < limit) {
    const entry = pending.pop();
    if (!entry || visited.has(entry.node)) return [];
    visited.add(entry.node);
    if (entry.node === start || entry.node === alternate) {
      const result: RendererFiber[] = [];
      for (let cursor: Entry | null = entry; cursor; cursor = cursor.parent)
        result.push(cursor.node);
      return result;
    }
    const sibling = entry.parent && asFiber(entry.node.sibling);
    if (sibling) pending.push({ node: sibling, parent: entry.parent });
    const child = asFiber(entry.node.child);
    if (child) pending.push({ node: child, parent: entry });
  }
  return [];
}
