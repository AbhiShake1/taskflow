import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { lockfileHandle } from './lockfile';
import { runAdd, type AddPipelineResult } from './pipeline';

export interface McpOptions {
  cwd: string;
}

export interface McpHarnessSummary {
  name: string;
  type: string;
  source: string;
}

export interface McpSearchMatch {
  name: string;
  description?: string;
  homepage?: string;
  score: number;
}

export interface McpSearchResult {
  matches: McpSearchMatch[];
  message?: string;
}

interface IndexEntry {
  name: string;
  description?: string;
  homepage?: string;
}

interface Index {
  items?: IndexEntry[];
}

const DEFAULT_REGISTRY_URL = 'https://taskflow.sh/r';

function fuzzyScore(entry: IndexEntry, query: string): number {
  const q = query.toLowerCase();
  let s = 0;
  if (entry.name.toLowerCase().includes(q)) s += 10;
  if (entry.description && entry.description.toLowerCase().includes(q)) s += 3;
  return s;
}

export async function mcpListHarnesses(opts: McpOptions): Promise<McpHarnessSummary[]> {
  const lock = await lockfileHandle(opts.cwd).read();
  return Object.entries(lock.items).map(([name, entry]) => ({
    name,
    type: entry.type,
    source: entry.source,
  }));
}

export async function mcpSearch(
  opts: McpOptions & { query: string },
): Promise<McpSearchResult> {
  const base = process.env.TASKFLOW_REGISTRY_URL ?? process.env.REGISTRY_URL ?? DEFAULT_REGISTRY_URL;
  const url = `${base.replace(/\/$/, '')}/registries.json`;

  let response: Response;
  try {
    response = await fetch(url);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { matches: [], message: `registry index unreachable: ${detail}` };
  }
  if (!response.ok) {
    return { matches: [], message: `registry index unreachable: HTTP ${response.status}` };
  }

  let index: Index;
  try {
    index = JSON.parse(await response.text()) as Index;
  } catch (err) {
    return { matches: [], message: `registry index is malformed: ${(err as Error).message}` };
  }

  const matches: McpSearchMatch[] = (index.items ?? [])
    .map((entry) => ({ entry, score: fuzzyScore(entry, opts.query) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map(({ entry, score }) => ({
      name: entry.name,
      ...(entry.description !== undefined ? { description: entry.description } : {}),
      ...(entry.homepage !== undefined ? { homepage: entry.homepage } : {}),
      score,
    }));

  return { matches };
}

export async function mcpInstall(
  opts: McpOptions & { source: string },
): Promise<AddPipelineResult> {
  return runAdd({
    inputs: [opts.source],
    cwd: opts.cwd,
    yes: true,
    silent: true,
    overwrite: false,
    dryRun: false,
    frozen: false,
    skipAdapterCheck: false,
  });
}

export async function runMcp(opts: McpOptions): Promise<void> {
  const server = new Server(
    { name: 'taskflow', version: '0.1.21' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'list_harnesses',
        description: 'List installed harnesses from taskflow.lock in the current working directory.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      },
      {
        name: 'search',
        description: 'Fuzzy-match a query against the public registry index (registries.json).',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
          additionalProperties: false,
        },
      },
      {
        name: 'install',
        description: 'Install a harness from a registry, URL, git repo, or local file.',
        inputSchema: {
          type: 'object',
          properties: { source: { type: 'string' } },
          required: ['source'],
          additionalProperties: false,
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;

    if (name === 'list_harnesses') {
      const result = await mcpListHarnesses(opts);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
    if (name === 'search') {
      const query = typeof args.query === 'string' ? args.query : '';
      const result = await mcpSearch({ ...opts, query });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
    if (name === 'install') {
      const source = typeof args.source === 'string' ? args.source : '';
      if (source === '') {
        return {
          isError: true,
          content: [{ type: 'text', text: 'install: source is required' }],
        };
      }
      const result = await mcpInstall({ ...opts, source });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
    return {
      isError: true,
      content: [{ type: 'text', text: `unknown tool: ${name}` }],
    };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
