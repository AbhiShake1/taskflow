export type SourceSpec =
  | { kind: 'local'; path: string }
  | { kind: 'url'; url: string }
  | {
      kind: 'qualified';
      type: 'git' | 'https' | 'file';
      url: string;
      subpath?: string;
      ref?: string;
      sha256?: string;
      depth?: number;
    }
  | { kind: 'namespace'; namespace: string; item: string; version?: string }
  | {
      kind: 'shortcut';
      host: 'github' | 'gitlab' | 'bitbucket';
      user: string;
      repo: string;
      subpath?: string;
      ref?: string;
    }
  | { kind: 'named'; name: string };

const QUALIFIED_RE = /^(git|https|file)::/;
const NAMESPACE_RE = /^(@[a-zA-Z0-9](?:[a-zA-Z0-9-_]*[a-zA-Z0-9])?)\/(.+)$/;
const HOST_SHORTCUT_RE = /^(github|gitlab|bitbucket):([^/]+)\/(.+)$/;
const BARE_SHORTCUT_RE = /^([^/@:]+)\/([^/@:]+)(?:\/(.+))?$/;

const QUALIFIED_PARAM_KEYS = new Set(['ref', 'sha256', 'depth']);

function tryParseUrl(input: string): URL | null {
  try {
    return new URL(input);
  } catch {
    return null;
  }
}

function parseQualified(input: string): SourceSpec {
  const schemeEnd = input.indexOf('::');
  const scheme = input.slice(0, schemeEnd) as 'git' | 'https' | 'file';
  const rest = input.slice(schemeEnd + 2);

  const qIndex = rest.indexOf('?');
  const beforeQuery = qIndex === -1 ? rest : rest.slice(0, qIndex);
  const queryString = qIndex === -1 ? '' : rest.slice(qIndex + 1);

  const subpathIndex = beforeQuery.indexOf('//', findSchemeTerminator(beforeQuery));
  let url: string;
  let subpath: string | undefined;
  if (subpathIndex === -1) {
    url = beforeQuery;
  } else {
    url = beforeQuery.slice(0, subpathIndex);
    subpath = beforeQuery.slice(subpathIndex + 2);
  }

  let ref: string | undefined;
  let sha256: string | undefined;
  let depth: number | undefined;
  if (queryString) {
    const params = new URLSearchParams(queryString);
    for (const key of params.keys()) {
      if (!QUALIFIED_PARAM_KEYS.has(key)) {
        throw new Error(
          `Unknown query parameter "${key}" in qualified source. Allowed keys: ref, sha256, depth.`,
        );
      }
    }
    const refParam = params.get('ref');
    if (refParam !== null) ref = refParam;
    const shaParam = params.get('sha256');
    if (shaParam !== null) sha256 = shaParam;
    const depthParam = params.get('depth');
    if (depthParam !== null) {
      const n = Number(depthParam);
      if (!Number.isFinite(n)) throw new Error(`Invalid depth "${depthParam}" — must be a number.`);
      depth = n;
    }
  }

  const out: SourceSpec = { kind: 'qualified', type: scheme, url };
  if (subpath !== undefined) out.subpath = subpath;
  if (ref !== undefined) out.ref = ref;
  if (sha256 !== undefined) out.sha256 = sha256;
  if (depth !== undefined) out.depth = depth;
  return out;
}

// Skip past the `://` of a scheme inside a qualified source so that `//` after
// the authority can delimit the subpath (Terraform semantics).
function findSchemeTerminator(s: string): number {
  const proto = s.indexOf('://');
  return proto === -1 ? 0 : proto + 3;
}

function parseNamespace(input: string, match: RegExpMatchArray): SourceSpec {
  void input;
  const namespace = match[1];
  const remainder = match[2];
  const versionIdx = remainder.lastIndexOf('@');
  if (versionIdx > 0) {
    const item = remainder.slice(0, versionIdx);
    const version = remainder.slice(versionIdx + 1);
    return { kind: 'namespace', namespace, item, version };
  }
  return { kind: 'namespace', namespace, item: remainder };
}

function splitRef(s: string): { value: string; ref?: string } {
  const hashIdx = s.indexOf('#');
  if (hashIdx === -1) return { value: s };
  return { value: s.slice(0, hashIdx), ref: s.slice(hashIdx + 1) };
}

function parseHostShortcut(match: RegExpMatchArray): SourceSpec {
  const host = match[1] as 'github' | 'gitlab' | 'bitbucket';
  const user = match[2];
  const tail = match[3];
  const { value, ref } = splitRef(tail);
  const firstSlash = value.indexOf('/');
  let repo: string;
  let subpath: string | undefined;
  if (firstSlash === -1) {
    repo = value;
  } else {
    repo = value.slice(0, firstSlash);
    subpath = value.slice(firstSlash + 1);
  }
  const out: SourceSpec = { kind: 'shortcut', host, user, repo };
  if (subpath !== undefined) out.subpath = subpath;
  if (ref !== undefined) out.ref = ref;
  return out;
}

function parseBareShortcut(input: string): SourceSpec | null {
  const { value, ref } = splitRef(input);
  const m = value.match(BARE_SHORTCUT_RE);
  if (!m) return null;
  const user = m[1];
  const repo = m[2];
  const subpath = m[3];
  const out: SourceSpec = { kind: 'shortcut', host: 'github', user, repo };
  if (subpath !== undefined) out.subpath = subpath;
  if (ref !== undefined) out.ref = ref;
  return out;
}

export function parseSource(input: string): SourceSpec {
  if (!input || typeof input !== 'string') {
    throw new Error('Source string is empty.');
  }

  const looksLikeUrl = tryParseUrl(input) !== null;

  if (input.endsWith('.json') && !looksLikeUrl) {
    return { kind: 'local', path: input };
  }

  if (QUALIFIED_RE.test(input)) {
    return parseQualified(input);
  }

  const hostMatch = input.match(HOST_SHORTCUT_RE);
  if (hostMatch) {
    return parseHostShortcut(hostMatch);
  }

  if (looksLikeUrl) {
    return { kind: 'url', url: input };
  }

  const nsMatch = input.match(NAMESPACE_RE);
  if (nsMatch) {
    return parseNamespace(input, nsMatch);
  }

  const bare = parseBareShortcut(input);
  if (bare) return bare;

  return { kind: 'named', name: input };
}

export function parseRegistryAndItemFromString(
  s: string,
): { registry: string | null; item: string; version?: string } {
  const m = s.match(/^(@[a-zA-Z0-9](?:[a-zA-Z0-9-_]*[a-zA-Z0-9])?)\/([^@]+)(?:@(.+))?$/);
  if (m) {
    const out: { registry: string | null; item: string; version?: string } = {
      registry: m[1],
      item: m[2],
    };
    if (m[3] !== undefined) out.version = m[3];
    return out;
  }
  const versionIdx = s.lastIndexOf('@');
  if (versionIdx > 0) {
    return { registry: null, item: s.slice(0, versionIdx), version: s.slice(versionIdx + 1) };
  }
  return { registry: null, item: s };
}
