// Minimal GitHub REST client. Commits go through the Git Data API so a PDF and
// the updated library.json land in a single atomic commit.
const API = 'https://api.github.com';

export class GitHubError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

export class GitHub {
  constructor({ owner, repo, branch, token }) {
    Object.assign(this, { owner, repo, branch, token });
  }

  get repoPath() { return `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}`; }

  async req(path, { method = 'GET', body, accept = 'application/vnd.github+json', raw = false } = {}) {
    const res = await fetch(API + path, {
      method,
      cache: 'no-store',
      headers: {
        Accept: accept,
        Authorization: `Bearer ${this.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      let msg = res.statusText;
      try { msg = (await res.json()).message || msg; } catch { /* non-JSON */ }
      if (res.status === 401) msg = 'Token rejected (401). Check it has not expired.';
      if (res.status === 403 || res.status === 404) msg += ` — token needs Contents: read & write on ${this.owner}/${this.repo}.`;
      if (res.status === 409) msg = 'Repository is empty — push an initial commit first.';
      throw new GitHubError(msg, res.status);
    }
    if (raw) return res;
    return res.status === 204 ? null : res.json();
  }

  async check() {
    const r = await this.req(this.repoPath);
    if (!r.permissions?.push) throw new GitHubError('Token can read but not write to this repo.', 403);
    return r;
  }

  user() { return this.req('/user'); }

  async headCommit() {
    const ref = await this.req(`${this.repoPath}/git/ref/heads/${encodeURIComponent(this.branch)}`);
    const commit = await this.req(`${this.repoPath}/git/commits/${ref.object.sha}`);
    return { sha: ref.object.sha, tree: commit.tree.sha };
  }

  async readFile(path, as = 'text') {
    try {
      const res = await this.req(`${this.repoPath}/contents/${encodePath(path)}?ref=${encodeURIComponent(this.branch)}`, {
        accept: 'application/vnd.github.raw', raw: true,
      });
      return as === 'blob' ? res.blob() : res.text();
    } catch (e) {
      if (e.status === 404) return null;
      throw e;
    }
  }

  async createBlob(blob) {
    const r = await this.req(`${this.repoPath}/git/blobs`, {
      method: 'POST', body: { content: await toBase64(blob), encoding: 'base64' },
    });
    return r.sha;
  }

  // entries: [{ path, sha } | { path, content } | { path, delete: true }]
  async commit(entries, message, parent) {
    const tree = await this.req(`${this.repoPath}/git/trees`, {
      method: 'POST',
      body: {
        base_tree: parent.tree,
        tree: entries.map((e) => ({
          path: e.path, mode: '100644', type: 'blob',
          ...(e.delete ? { sha: null } : e.sha ? { sha: e.sha } : { content: e.content }),
        })),
      },
    });
    const commit = await this.req(`${this.repoPath}/git/commits`, {
      method: 'POST', body: { message, tree: tree.sha, parents: [parent.sha] },
    });
    await this.req(`${this.repoPath}/git/refs/heads/${encodeURIComponent(this.branch)}`, {
      method: 'PATCH', body: { sha: commit.sha, force: false },
    });
    return commit.sha;
  }
}

function encodePath(p) { return p.split('/').map(encodeURIComponent).join('/'); }

function toBase64(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(',')[1] || '');
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}
