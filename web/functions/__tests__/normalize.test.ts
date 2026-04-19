import { describe, expect, it } from 'vitest';

import { normalizeGitHub, normalizeGrepApp } from '../api/normalize';

describe('normalizeGrepApp', () => {
  it('maps a plausible grep.app response into DiscoverHit[]', () => {
    // Shape is undocumented — this fixture mirrors what we've observed in the
    // wild: `hits.hits[]` with a `content.snippet.lines` array.
    const fixture = {
      hits: {
        hits: [
          {
            repo: { raw: 'alice/harnesses' },
            branch: 'main',
            path: { raw: 'tasks/video.ts' },
            sha: 'abc123',
            content: {
              lines: [
                { number: 1, text: "import { taskflow } from '@taskflow-corp/cli';" },
                { number: 2, text: 'export default taskflow({})' },
              ],
            },
          },
        ],
      },
    };

    const hits = normalizeGrepApp(fixture);
    expect(hits).toHaveLength(1);
    const [h] = hits;
    expect(h.repo).toBe('alice/harnesses');
    expect(h.branch).toBe('main');
    expect(h.path).toBe('tasks/video.ts');
    expect(h.sha).toBe('abc123');
    expect(h.url).toBe('https://github.com/alice/harnesses/blob/main/tasks/video.ts');
    expect(h.rawUrl).toBe(
      'https://raw.githubusercontent.com/alice/harnesses/main/tasks/video.ts',
    );
    expect(h.matchLines).toEqual([
      { lineNo: 1, content: "import { taskflow } from '@taskflow-corp/cli';" },
      { lineNo: 2, content: 'export default taskflow({})' },
    ]);
  });

  it('also accepts the flat-top-level `hits` array form', () => {
    const fixture = {
      hits: [
        {
          repo: 'bob/pipeline',
          path: 'src/main.ts',
          branch: 'dev',
          content: {
            lines: [{ number: 42, text: "from '@taskflow-corp/cli'" }],
          },
        },
      ],
    };
    const hits = normalizeGrepApp(fixture);
    expect(hits).toHaveLength(1);
    expect(hits[0].repo).toBe('bob/pipeline');
    expect(hits[0].branch).toBe('dev');
    expect(hits[0].matchLines[0]).toEqual({ lineNo: 42, content: "from '@taskflow-corp/cli'" });
  });

  it('falls back to an HTML snippet when lines[] is absent', () => {
    const fixture = {
      hits: [
        {
          repo: 'carol/repo',
          path: 'a.ts',
          content: { snippet: '<span>import</span> <em>taskflow</em>' },
        },
      ],
    };
    const [hit] = normalizeGrepApp(fixture);
    expect(hit.matchLines).toEqual([{ lineNo: 1, content: 'import taskflow' }]);
  });

  it('drops malformed items without throwing', () => {
    expect(normalizeGrepApp({ hits: [{}, null, { repo: 'x' /* no path */ }] })).toEqual([]);
    expect(normalizeGrepApp(null)).toEqual([]);
    expect(normalizeGrepApp('nope')).toEqual([]);
    expect(normalizeGrepApp({ unrelated: 1 })).toEqual([]);
  });
});

describe('normalizeGitHub', () => {
  it('maps api.github.com/search/code results into DiscoverHit[]', () => {
    // Shape from https://docs.github.com/en/rest/search/search#search-code
    const fixture = {
      total_count: 1,
      incomplete_results: false,
      items: [
        {
          name: 'video.ts',
          path: 'tasks/video.ts',
          sha: 'deadbeef',
          url: 'https://api.github.com/...',
          html_url: 'https://github.com/alice/harnesses/blob/abc/tasks/video.ts',
          repository: {
            full_name: 'alice/harnesses',
            default_branch: 'main',
          },
          text_matches: [
            { fragment: "import { taskflow } from '@taskflow-corp/cli';" },
          ],
        },
      ],
    };

    const hits = normalizeGitHub(fixture);
    expect(hits).toHaveLength(1);
    const [h] = hits;
    expect(h.repo).toBe('alice/harnesses');
    // Branch parsed out of html_url takes precedence over default_branch.
    expect(h.branch).toBe('abc');
    expect(h.path).toBe('tasks/video.ts');
    expect(h.sha).toBe('deadbeef');
    expect(h.url).toBe('https://github.com/alice/harnesses/blob/abc/tasks/video.ts');
    expect(h.rawUrl).toBe(
      'https://raw.githubusercontent.com/alice/harnesses/abc/tasks/video.ts',
    );
    expect(h.matchLines).toEqual([
      { lineNo: 1, content: "import { taskflow } from '@taskflow-corp/cli';" },
    ]);
  });

  it('falls back to default_branch when html_url has no /blob/<ref>/', () => {
    const fixture = {
      items: [
        {
          path: 'a.ts',
          repository: { full_name: 'x/y', default_branch: 'trunk' },
        },
      ],
    };
    const [h] = normalizeGitHub(fixture);
    expect(h.branch).toBe('trunk');
    expect(h.url).toBe('https://github.com/x/y/blob/trunk/a.ts');
  });

  it('drops items missing path or repository.full_name', () => {
    const fixture = {
      items: [
        { path: 'only-path.ts' },
        { repository: { full_name: 'only/repo' } },
        null,
        {},
      ],
    };
    expect(normalizeGitHub(fixture)).toEqual([]);
  });

  it('returns [] for non-object / non-array input', () => {
    expect(normalizeGitHub(null)).toEqual([]);
    expect(normalizeGitHub({ items: 'nope' })).toEqual([]);
  });
});
