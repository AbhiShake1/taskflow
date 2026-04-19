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

function firstOverlappingPair(a: string[] = [], b: string[] = []): [string, string] | null {
  for (const ga of a) for (const gb of b) {
    const pa = literalPrefix(ga), pb = literalPrefix(gb);
    if (pa.startsWith(pb) || pb.startsWith(pa)) return [ga, gb];
  }
  return null;
}

export function assertNoOverlaps(leaves: Array<{ id: string; claims?: string[] }>): void {
  for (let i = 0; i < leaves.length; i++)
    for (let j = i + 1; j < leaves.length; j++) {
      const pair = firstOverlappingPair(leaves[i].claims, leaves[j].claims);
      if (pair)
        throw new Error(
          `claim conflict: "${leaves[i].id}" vs "${leaves[j].id}" — write glob "${pair[0]}" overlaps "${pair[1]}"`,
        );
    }
}

export { literalPrefix };
