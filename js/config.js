// Default repo used when the site isn't served from <owner>.github.io/<repo>/
export const DEFAULT_REPO = { owner: 'theMonk7', repo: 'Reads', branch: 'main' };

export const BOOKS_DIR = 'Books';
export const LIBRARY_PATH = 'library.json';
export const BOOK_CACHE = 'reads-books';
export const MAX_UPLOAD_BYTES = 95 * 1024 * 1024; // GitHub hard limit is 100 MB per file

export function detectRepo() {
  const host = location.hostname;
  if (host.endsWith('.github.io')) {
    const owner = host.split('.')[0];
    const seg = location.pathname.split('/').filter(Boolean)[0];
    const repo = seg && !seg.includes('.') ? seg : host;
    return { owner, repo, branch: 'main' };
  }
  return { ...DEFAULT_REPO };
}
