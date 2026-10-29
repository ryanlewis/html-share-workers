import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseRewrites } from '../src/lib/rewrites';

afterEach(() => vi.restoreAllMocks());

describe('parseRewrites', () => {
  it('keys targets by decoded path without trailing slashes', () => {
    const r = parseRewrites('{"/lhv/":"/lhv/index/","/caf%C3%A9":"/x/y/"}');
    expect([...r]).toEqual([
      ['/lhv', '/lhv/index/'],
      ['/café', '/x/y/'],
    ]);
  });

  it.each([undefined, '', 'not json', '[]', 'null'])('gives no rewrites for %j', (text) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(parseRewrites(text).size).toBe(0);
  });

  it.each([
    ['{"lhv":"/lhv/index/"}', 'not a path'],
    ['{"/":"/x/"}', 'cannot be rewritten'],
    ['{"/%zz/":"/x/"}', 'does not percent-decode'],
    ['{"/lhv//":"/lhv/index/"}', 'more than one slash'],
    ['{"/lhv/":5}', 'not a folder path'],
    ['{"/lhv/":"/lhv/index"}', 'not a folder path'],
    ['{"/lhv/":"https://other.example/x/"}', 'not a folder path'],
    ['{"/lhv/":"//other.example/x/"}', 'not a folder path'],
    ['{"/lhv/":"/lhv//x/"}', 'not a folder path'],
    ['{"/lhv/":"/lhv/index/?a=1"}', 'not a folder path'],
    ['{"/lhv/":"/lhv/index/#top"}', 'not a folder path'],
    ['{"/lhv/":"/a%2Fb/"}', 'not a folder path'],
    ['{"/lhv/":"/_/secret/"}', 'secured target'],
    ['{"/lhv/":"/lhv/"}', 'rewrites to itself'],
  ])('drops and logs %s', (text, message) => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(parseRewrites(text).size).toBe(0);
    expect(log).toHaveBeenCalledOnce();
    expect(log.mock.calls[0]![0]).toContain(message);
  });
});
