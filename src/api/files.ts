import { DEFAULT_PAGE, InvalidKeyError, objectKey, type Scope, validatePath } from '../lib/artifacts';

/** Most files one upload may hold, index.html included. */
export const MAX_FILES = 200;

const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json',
  map: 'application/json',
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  xml: 'application/xml',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  pdf: 'application/pdf',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  wasm: 'application/wasm',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
};

/** Content type from the file extension, then the part's own type. */
export function contentTypeFor(key: string, partType = ''): string {
  const ext = /\.([a-z0-9]+)$/i.exec(key)?.[1]?.toLowerCase();
  return (ext && TYPES[ext]) || partType || 'application/octet-stream';
}

export interface Asset {
  key: string;
  body: ArrayBuffer;
  contentType: string;
}

export interface ParsedUpload {
  /** Root index.html. Written with the artifact's metadata. */
  index: ArrayBuffer;
  /** Every other file. Written without metadata. */
  assets: Asset[];
}

export type ParseResult = { ok: true; upload: ParsedUpload } | { ok: false; error: string };

/**
 * Turns multipart fields into files. Each field name is a path relative to
 * the artifact root and each value must be a file. The root index.html is
 * required and kept apart so it is only written with metadata.
 */
export async function parseMultipart(
  form: FormData,
  scope: Scope,
  slug: string,
): Promise<ParseResult> {
  const indexKey = objectKey(scope, slug);
  const seen = new Set<string>();
  let index: ArrayBuffer | undefined;
  const assets: Asset[] = [];
  for (const [path, value] of form.entries()) {
    if (typeof value === 'string') {
      return { ok: false, error: `field "${path}" must be a file, not text` };
    }
    if (path === '') return { ok: false, error: 'a field has an empty path' };
    const check = validatePath(path);
    if (!check.ok) return { ok: false, error: `"${path}": ${check.error}` };
    let key: string;
    try {
      key = objectKey(scope, slug, path);
    } catch (err) {
      if (err instanceof InvalidKeyError) return { ok: false, error: `"${path}": ${err.message}` };
      throw err;
    }
    if (seen.has(key)) return { ok: false, error: `"${path}" appears more than once` };
    seen.add(key);
    if (seen.size > MAX_FILES) return { ok: false, error: `more than ${MAX_FILES} files` };
    const body = await value.arrayBuffer();
    if (key === indexKey) index = body;
    else assets.push({ key, body, contentType: contentTypeFor(key, value.type) });
  }
  if (index === undefined) return { ok: false, error: `multipart upload must include ${DEFAULT_PAGE}` };
  if (index.byteLength === 0) return { ok: false, error: `${DEFAULT_PAGE} is empty` };
  return { ok: true, upload: { index, assets } };
}
