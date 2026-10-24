import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseRedirects, pointsAt } from '../src/lib/redirects';

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
