import { describe, expect, it } from 'vitest';
import { parseSource } from '../parser';

describe('parseSource', () => {
  describe('local file', () => {
    it('recognizes relative .json path', () => {
      expect(parseSource('./foo.json')).toEqual({ kind: 'local', path: './foo.json' });
    });

    it('recognizes ~/ prefixed .json path as local', () => {
      expect(parseSource('~/r.json')).toEqual({ kind: 'local', path: '~/r.json' });
    });
  });

  describe('qualified (Tier 3)', () => {
    it('parses git:: with url, subpath, ref, depth', () => {
      expect(
        parseSource('git::https://host/x.git//sub?ref=v1&depth=1'),
      ).toEqual({
        kind: 'qualified',
        type: 'git',
        url: 'https://host/x.git',
        subpath: 'sub',
        ref: 'v1',
        depth: 1,
      });
    });

    it('throws on unknown query params', () => {
      expect(() => parseSource('https::https://x?weird=1')).toThrow(/Unknown query parameter/);
    });
  });

  describe('url', () => {
    it('recognizes raw URLs', () => {
      expect(parseSource('https://r.sh/x.json')).toEqual({
        kind: 'url',
        url: 'https://r.sh/x.json',
      });
    });
  });

  describe('namespace', () => {
    it('parses @ns/item', () => {
      expect(parseSource('@acme/btn')).toEqual({
        kind: 'namespace',
        namespace: '@acme',
        item: 'btn',
      });
    });

    it('parses @ns/item@version', () => {
      expect(parseSource('@acme/btn@^1.0.0')).toEqual({
        kind: 'namespace',
        namespace: '@acme',
        item: 'btn',
        version: '^1.0.0',
      });
    });
  });

  describe('shortcut', () => {
    it('parses explicit gitlab: host shortcut', () => {
      expect(parseSource('gitlab:u/r')).toEqual({
        kind: 'shortcut',
        host: 'gitlab',
        user: 'u',
        repo: 'r',
      });
    });

    it('parses explicit github: host shortcut with ref and subpath', () => {
      expect(parseSource('github:u/r/path#v2')).toEqual({
        kind: 'shortcut',
        host: 'github',
        user: 'u',
        repo: 'r',
        subpath: 'path',
        ref: 'v2',
      });
    });

    it('parses explicit bitbucket: host shortcut', () => {
      expect(parseSource('bitbucket:u/r')).toEqual({
        kind: 'shortcut',
        host: 'bitbucket',
        user: 'u',
        repo: 'r',
      });
    });

    it('defaults bare user/repo to github with ref', () => {
      expect(parseSource('u/r#v1')).toEqual({
        kind: 'shortcut',
        host: 'github',
        user: 'u',
        repo: 'r',
        ref: 'v1',
      });
    });

    it('captures subpath and ref from bare shortcut', () => {
      expect(parseSource('u/r/path/to/x#v1')).toEqual({
        kind: 'shortcut',
        host: 'github',
        user: 'u',
        repo: 'r',
        subpath: 'path/to/x',
        ref: 'v1',
      });
    });
  });

  describe('named', () => {
    it('falls through to named for a bare word', () => {
      expect(parseSource('button')).toEqual({ kind: 'named', name: 'button' });
    });
  });
});
