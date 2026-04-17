function literalPrefix(glob: string): string {
  const i = glob.search(/[*?[{!]/);
  return i === -1 ? glob : glob.slice(0, i);
}

export function claimsOverlap(a: string[] = [], b: string[] = []): boolean {
  for (const ga of a) for (const gb of b) {
    const pa = literalPrefix(ga), pb = literalPrefix(gb);
    if (pa.startsWith(pb) || pb.startsWith(pa)) return true;
  }
  return false;
}

export function assertNoOverlaps(leaves: Array<{ id: string; claims?: string[] }>): void {
  for (let i = 0; i < leaves.length; i++)
    for (let j = i + 1; j < leaves.length; j++)
      if (claimsOverlap(leaves[i].claims, leaves[j].claims))
        throw new Error(`claim conflict: "${leaves[i].id}" vs "${leaves[j].id}"`);
}

export { literalPrefix };
