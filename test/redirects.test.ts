import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseRedirects, pointsAt, redirectLocation } from '../src/lib/redirects';

afterEach(() => vi.restoreAllMocks());

describe('parseRedirects', () => {
  it('splits exact-path keys from slug keys', () => {
    const r = parseRedirects('{"/lhv/":"/lhv/index/","/a/b":"/c/","old":"/acme/old/"}');
    expect([...r.exact]).toEqual([
      ['/lhv', '/lhv/index/'],
      ['/a/b', '/c/'],
    ]);
    expect([...r.slugs]).toEqual([['old', '/acme/old/']]);
  });

  it.each([undefined, '', 'not json', '[]', 'null'])('gives no redirects for %j', (text) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = parseRedirects(text);
    expect(r.exact.size + r.slugs.size).toBe(0);
  });

  it.each([
    ['{"/":"/x/"}', 'cannot be redirected'],
    ['{"/lhv//":"/lhv/index/"}', 'more than one slash'],
    ['{"old":5}', 'has no target'],
    ['{"old":""}', 'has no target'],
    ['{"/lhv/":"/lhv"}', 'redirects to itself'],
    ['{"/lhv/":"/lhv/?a=1"}', 'redirects to itself'],
    ['{"/lhv/":"/lhv/#top"}', 'redirects to itself'],
    ['{"/lhv/":"."}', 'redirects to itself'],
    ['{"/café/":"/caf%C3%A9/"}', 'redirects to itself'],
    ['{"old":"/old/"}', 'redirects to itself'],
  ])('drops and logs %s', (text, message) => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = parseRedirects(text);
    expect(r.exact.size + r.slugs.size).toBe(0);
    expect(log).toHaveBeenCalledOnce();
    expect(log.mock.calls[0]![0]).toContain(message);
  });

  it.each([
    ['{"old/":"/acme/old/"}', 'slug key with a "/"'],
    ['{"a/b":"/c/"}', 'slug key with a "/"'],
    ['{"old":"acme/old/"}', 'not "/..." or a full URL'],
    ['{"/lhv/":"index/"}', 'not "/..." or a full URL'],
    ['{"old":"//evil.example/"}', 'not "/..." or a full URL'],
    ['{"old":"https://"}', 'not "/..." or a full URL'],
    ['{"old":"/\\\\evil.example/"}', 'not "/..." or a full URL'],
    ['{"/caf%E9/":"/x/"}', 'does not percent-decode'],
  ])('drops and logs %s', (text, message) => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = parseRedirects(text);
    expect(r.exact.size + r.slugs.size).toBe(0);
    expect(log.mock.calls[0]![0]).toContain(message);
  });

  it('accepts a full URL target', () => {
    expect([...parseRedirects('{"old":"https://example.com/x/"}').slugs]).toEqual([['old', 'https://example.com/x/']]);
  });

  it('decodes percent-encoded exact keys', () => {
    expect([...parseRedirects('{"/caf%C3%A9/":"/x/"}').exact]).toEqual([['/café', '/x/']]);
  });

  it.each([
    ['{"/lhv/":"/lhv/index/","/lhv/index":"/lhv/"}', ['/lhv/', '/lhv/index']],
    ['{"/a":"/b/?x=1","/b":"/c#top","/c/":"/a/","/d":"/a"}', ['/a', '/b', '/c/']],
  ])('drops every exact key in a loop in %s', (text, looped) => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = parseRedirects(text);
    for (const key of looped) expect(log.mock.calls[0]![0]).toContain(`"${key}" is in a redirect loop`);
    expect(r.exact.size).toBe(text.includes('"/d"') ? 1 : 0);
  });

  it('does not see a loop through an encoded slash', () => {
    expect(parseRedirects('{"/a/b/":"/c/","/c/":"/a%2Fb"}').exact.size).toBe(2);
  });

  it('keeps a chain that ends', () => {
    expect(parseRedirects('{"/a":"/b/","/b":"/c/"}').exact.size).toBe(2);
  });

  it('keeps the good entries next to a bad one', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = parseRedirects('{"/":"/x/","old":"/acme/old/"}');
    expect([...r.slugs]).toEqual([['old', '/acme/old/']]);
  });
});

describe('pointsAt', () => {
  it.each([
    ['https://share.test/lhv/', true],
    ['https://share.test/lhv/#top', true],
    ['https://other.test/lhv/', false],
    ['/lhv/index/', false],
  ])('%s from /lhv/ is %s', (target, expected) => {
    expect(pointsAt(target, 'https://share.test/lhv/', '/lhv')).toBe(expected);
  });
});

describe('redirectLocation', () => {
  it.each([
    ['/acme/old/', '/page', '?a=1', '/acme/old/page?a=1'],
    ['/acme/old/?ref=x', '/page', '?a=1', '/acme/old/page?ref=x&a=1'],
    ['/acme/old/?ref=x#top', '', '', '/acme/old/?ref=x#top'],
    ['/acme/old/#top', '/page', '?a=1', '/acme/old/page?a=1#top'],
    ['https://example.com/x/?ref=x', '/p', '?a=1', 'https://example.com/x/p?ref=x&a=1'],
    ['/', '//evil.example/x', '', '/evil.example/x'],
  ])('slug target %s + %s%s -> %s', (target, sub, search, expected) => {
    expect(redirectLocation(target, sub, search)).toBe(expected);
  });

  it.each([
    ['/lhv/index/', '', '/lhv/index/'],
    ['/lhv/index/', '?utm=x', '/lhv/index/?utm=x'],
    ['/lhv/index/#latest', '?utm=x', '/lhv/index/?utm=x#latest'],
    ['/lhv/index/?view=list#latest', '?utm=x', '/lhv/index/?view=list&utm=x#latest'],
  ])('exact target %s + %s -> %s', (target, search, expected) => {
    expect(redirectLocation(target, null, search)).toBe(expected);
  });
});
