import { describe, expect, it } from 'vitest';

import { normalizeGitHub } from '../api/normalize';

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
