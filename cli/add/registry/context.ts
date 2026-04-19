const registryHeaders = new Map<string, Record<string, string>>();

export function setRegistryHeaders(map: Record<string, Record<string, string>>): void {
  for (const [url, headers] of Object.entries(map)) {
    const existing = registryHeaders.get(url) ?? {};
    registryHeaders.set(url, { ...existing, ...headers });
  }
}

export function getRegistryHeadersFromContext(url: string): Record<string, string> {
  let bestPrefix = '';
  let bestHeaders: Record<string, string> | undefined;
  for (const [prefix, headers] of registryHeaders) {
    if (url.startsWith(prefix) && prefix.length > bestPrefix.length) {
      bestPrefix = prefix;
      bestHeaders = headers;
    }
  }
  return bestHeaders ? { ...bestHeaders } : {};
}

export function clearRegistryContext(): void {
  registryHeaders.clear();
}
