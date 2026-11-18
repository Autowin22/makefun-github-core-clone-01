import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  repos,
  viewerLogin,
  findRepo,
  mergePullRequestInRepo,
  getNextRepoId,
  getNextObjectId,
  getNextSeq,
  nowIso,
  requestId,
  writeObject,
  readObject,
  parseTree,
  buildTree,
  flattenTree,
  buildTreeFromFlat,
  parseCommit,
  formatCommit,
  findMergeBase,
  diffTrees,
  type Repo,
  type Issue,
  type Pull,
} from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId(),
    ...headers,
  });
  res.end(text);
}

function sendEmpty(res: ServerResponse, status: number, headers: Readonly<Record<string, string>> = {}): void {
  res.writeHead(status, {
    'x-github-request-id': requestId(),
    ...headers,
  });
  res.end();
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 32 * 1024 * 1024) {
      throw new Error('Payload too large');
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function handleRest(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const pathname = url.pathname;
  if (!pathname.startsWith('/api/v3')) {
    return false;
  }

  // Auth check for all /api/v3 requests
  const expectedToken = process.env.MAKEFUN_SHOP_TOKEN;
  if (expectedToken) {
    const authHeader = req.headers.authorization;
    if (!authHeader || authHeader !== `Bearer ${expectedToken}`) {
      sendJson(res, 401, { message: 'Unauthorized' });
      return true;
    }
  }

  const method = req.method ?? 'GET';

  // GET /api/v3 or /api/v3/
  if (method === 'GET' && (pathname === '/api/v3' || pathname === '/api/v3/')) {
    sendJson(res, 200, {
      current_user_url: '/api/v3/user',
      rate_limit_url: '/api/v3/rate_limit',
    }, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }

  // GET /api/v3/meta
  if (method === 'GET' && pathname === '/api/v3/meta') {
    sendJson(res, 200, { installed_version: '1.4.0' });
    return true;
  }

  // POST /api/v3/user/repos
  if (method === 'POST' && pathname === '/api/v3/user/repos') {
    let body: any;
    try {
      const text = await readBody(req);
      body = text ? JSON.parse(text) : {};
    } catch {
      sendJson(res, 400, { message: 'Invalid JSON' });
      return true;
    }

    const name = body.name;
    if (!name || typeof name !== 'string') {
      sendJson(res, 422, { message: 'Repository name is required' });
      return true;
    }

    const key = name.toLowerCase();

    if (repos.has(key)) {
      sendJson(res, 422, { message: 'Repository already exists' });
      return true;
    }

    const repo: Repo = {
      id: getNextRepoId(),
      name,
      description: body.description ?? '',
      private: body.private ?? true,
      defaultBranch: 'main',
      refs: new Map<string, string>(),
      labels: new Map<string, { name: string; color: string; description?: string }>(),
      issues: [],
      pulls: [],
      nextNumber: 1,
      createdSeq: getNextSeq(),
    };
    repos.set(key, repo);

    const displayLogin = viewerLogin ?? 'viewer';
    sendJson(res, 201, formatRepoObject(repo, displayLogin));
    return true;
  }

  // GET /api/v3/user/repos (pagination)
  if (method === 'GET' && pathname === '/api/v3/user/repos') {
    const query = url.searchParams;
    const page = Math.max(1, parseInt(query.get('page') ?? '1', 10));
    const perPage = Math.min(100, Math.max(1, parseInt(query.get('per_page') ?? '30', 10)));

    const allRepos = Array.from(repos.values()).sort((a, b) => a.createdSeq - b.createdSeq);
    const start = (page - 1) * perPage;
    const slice = allRepos.slice(start, start + perPage);

    const login = viewerLogin ?? 'viewer';
    const formatted = slice.map((r) => formatRepoObject(r, login));

    const host = req.headers.host ?? 'localhost';
    const protocol = req.headers['x-forwarded-proto'] ?? 'http';
    const baseUrl = `${protocol}://${host}${pathname}`;

    const headers: Record<string, string> = {};
    const links: string[] = [];
    if (start + perPage < allRepos.length) {
      links.push(`<${baseUrl}?page=${page + 1}&per_page=${perPage}>; rel="next"`);
    }
    const lastPage = Math.ceil(allRepos.length / perPage) || 1;
    if (page < lastPage) {
      links.push(`<${baseUrl}?page=${lastPage}&per_page=${perPage}>; rel="last"`);
    }
    if (links.length > 0) {
      headers['link'] = links.join(', ');
    }

    sendJson(res, 200, formatted, headers);
    return true;
  }

  // Repo-scoped routes: /api/v3/repos/{owner}/{repoName}/...
  const repoMatch = pathname.match(/^\/api\/v3\/repos\/([^/]+)\/([^/]+)(?:\/(.*))?$/);
  if (repoMatch) {
    const owner = repoMatch[1];
    const repoName = repoMatch[2];
    const subPath = repoMatch[3] ?? '';

    const repo = findRepo(owner, repoName);
    if (!repo) {
      sendJson(res, 404, { message: 'Not Found' });
      return true;
    }

    const login = viewerLogin ?? owner;

    // GET /api/v3/repos/{o}/{r}
    if (method === 'GET' && subPath === '') {
      sendJson(res, 200, formatRepoObject(repo, login));
      return true;
    }

    // PATCH /api/v3/repos/{o}/{r}
    if (method === 'PATCH' && subPath === '') {
      let body: any;
      try {
        const text = await readBody(req);
        body = text ? JSON.parse(text) : {};
      } catch {
        sendJson(res, 400, { message: 'Invalid JSON' });
        return true;
      }
      if (body.description !== undefined) repo.description = body.description;
      if (body.name !== undefined && body.name !== repo.name) {
        repos.delete(repo.name.toLowerCase());
        repo.name = body.name;
        repos.set(repo.name.toLowerCase(), repo);
      }
      if (body.private !== undefined) repo.private = body.private;
      sendJson(res, 200, formatRepoObject(repo, login));
      return true;
    }

    // DELETE /api/v3/repos/{o}/{r}
    if (method === 'DELETE' && subPath === '') {
      repos.delete(repo.name.toLowerCase());
      sendEmpty(res, 204);
      return true;
    }

    // POST /api/v3/repos/{o}/{r}/git/refs
    if (method === 'POST' && subPath === 'git/refs') {
      let body: any;
      try {
        const text = await readBody(req);
        body = text ? JSON.parse(text) : {};
      } catch {
        sendJson(res, 400, { message: 'Invalid JSON' });
        return true;
      }
      const ref = body.ref;
      const sha = body.sha;
      if (!ref || !sha) {
        sendJson(res, 422, { message: 'ref and sha are required' });
        return true;
      }
      const fullRef = ref.startsWith('refs/') ? ref : `refs/heads/${ref}`;
      repo.refs.set(fullRef, sha);
      sendJson(res, 201, {
        ref: fullRef,
        object: { sha, type: 'commit' },
      });
      return true;
    }

    // GET /api/v3/repos/{o}/{r}/branches
    if (method === 'GET' && subPath === 'branches') {
      const branches: any[] = [];
      for (const [ref, sha] of repo.refs.entries()) {
        if (ref.startsWith('refs/heads/')) {
          const name = ref.substring(11);
          branches.push({
            name,
            commit: { sha },
          });
        }
      }
      // Ensure default branch is included if it has a tip or refs
      const defaultBranch = repo.defaultBranch;
      const defaultSha = repo.refs.get(`refs/heads/${defaultBranch}`);
      if (defaultSha && !branches.some((b) => b.name === defaultBranch)) {
        branches.push({ name: defaultBranch, commit: { sha: defaultSha } });
      }
      sendJson(res, 200, branches);
      return true;
    }

    // GET /api/v3/repos/{o}/{r}/commits
    if (method === 'GET' && subPath === 'commits') {
      const query = url.searchParams;
      const shaParam = query.get('sha') ?? repo.defaultBranch;
      let tipSha = repo.refs.get(`refs/heads/${shaParam}`) ?? repo.refs.get(shaParam) ?? shaParam;

      const commits: any[] = [];
      if (tipSha && readObject(tipSha)) {
        const visited = new Set<string>();
        const queue = [tipSha];
        while (queue.length > 0) {
          const cur = queue.shift()!;
          if (visited.has(cur)) continue;
          visited.add(cur);
          const obj = readObject(cur);
          if (!obj || obj.type !== 'commit') continue;
          const commitData = parseCommit(obj.data);
          commits.push({
            sha: cur,
            commit: {
              message: commitData.message,
              author: { name: 'Maker', email: 'maker@make.fun', date: nowIso() },
              committer: { name: 'Maker', email: 'maker@make.fun', date: nowIso() },
            },
          });
          for (const p of commitData.parents) {
            if (!visited.has(p)) queue.push(p);
          }
        }
      }
      sendJson(res, 200, commits);
      return true;
    }

    // Contents API: /api/v3/repos/{o}/{r}/contents/{path...}
    if (subPath.startsWith('contents/')) {
      const filePath = subPath.substring(9);
      const branch = url.searchParams.get('ref') ?? repo.defaultBranch;
      const headRef = `refs/heads/${branch}`;
      const currentTip = repo.refs.get(headRef);

      if (method === 'GET') {
        if (!currentTip) {
          sendJson(res, 404, { message: 'Not Found' });
          return true;
        }
        const commitObj = readObject(currentTip);
        if (!commitObj || commitObj.type !== 'commit') {
          sendJson(res, 404, { message: 'Not Found' });
          return true;
        }
        const commitData = parseCommit(commitObj.data);
        const flat = flattenTree(commitData.tree, '');

        if (filePath === '' || filePath === '/') {
          // Root directory listing
          const entries: any[] = [];
          const topDirs = new Set<string>();
          const topFiles = new Set<string>();
          for (const [p, val] of flat.entries()) {
            const slash = p.indexOf('/');
            if (slash === -1) {
              topFiles.add(p);
            } else {
              topDirs.add(p.substring(0, slash));
            }
          }
          for (const d of topDirs) {
            entries.push({
              name: d,
              path: d,
              sha: '',
              size: 0,
              type: 'dir',
            });
          }
          for (const f of topFiles) {
            const val = flat.get(f)!;
            const blob = readObject(val.sha);
            const size = blob ? blob.data.length : 0;
            entries.push({
              name: f,
              path: f,
              sha: val.sha,
              size,
              type: 'file',
            });
          }
          entries.sort((a, b) => a.name.localeCompare(b.name));
          sendJson(res, 200, entries);
          return true;
        }

        // Check if it's a file
        const fileEntry = flat.get(filePath);
        if (fileEntry) {
          const blob = readObject(fileEntry.sha);
          const dataBuf = blob ? blob.data : Buffer.alloc(0);
          const base64Content = dataBuf.toString('base64');
          const name = filePath.substring(filePath.lastIndexOf('/') + 1);
          sendJson(res, 200, {
            type: 'file',
            encoding: 'base64',
            content: base64Content,
            sha: fileEntry.sha,
            size: dataBuf.length,
            name,
            path: filePath,
          });
          return true;
        }

        // Check if it's a directory
        const entries: any[] = [];
        const prefix = filePath.endsWith('/') ? filePath : `${filePath}/`;
        const subDirs = new Set<string>();
        const subFiles = new Set<string>();
        for (const [p] of flat.entries()) {
          if (p.startsWith(prefix)) {
            const rel = p.substring(prefix.length);
            const slash = rel.indexOf('/');
            if (slash === -1) {
              subFiles.add(rel);
            } else {
              subDirs.add(rel.substring(0, slash));
            }
          }
        }

        if (subDirs.size === 0 && subFiles.size === 0) {
          sendJson(res, 404, { message: 'Not Found' });
          return true;
        }

        for (const d of subDirs) {
          entries.push({
            name: d,
            path: `${filePath}/${d}`,
            sha: '',
            size: 0,
            type: 'dir',
          });
        }
        for (const f of subFiles) {
          const fullPath = `${filePath}/${f}`;
          const val = flat.get(fullPath)!;
          const blob = readObject(val.sha);
          const size = blob ? blob.data.length : 0;
          entries.push({
            name: f,
            path: fullPath,
            sha: val.sha,
            size,
            type: 'file',
          });
        }
        entries.sort((a, b) => a.name.localeCompare(b.name));
        sendJson(res, 200, entries);
        return true;
      }

      if (method === 'PUT') {
        let body: any;
        try {
          const text = await readBody(req);
          body = text ? JSON.parse(text) : {};
        } catch {
          sendJson(res, 400, { message: 'Invalid JSON' });
          return true;
        }

        const targetBranch = body.branch ?? branch;
        const targetHeadRef = `refs/heads/${targetBranch}`;
        const parentTip = repo.refs.get(targetHeadRef);

        const contentBase64 = body.content ?? '';
        const contentBuf = Buffer.from(contentBase64, 'base64');
        const blobSha = writeObject('blob', contentBuf);

        let flat = new Map<string, { sha: string; mode: string }>();
        let isUpdate = false;

        if (parentTip) {
          const parentObj = readObject(parentTip);
          if (parentObj && parentObj.type === 'commit') {
            const parentCommit = parseCommit(parentObj.data);
            flat = flattenTree(parentCommit.tree, '');
          }
        }

        const existing = flat.get(filePath);
        if (existing) {
          isUpdate = true;
          if (body.sha && body.sha !== existing.sha) {
            sendJson(res, 409, { message: 'SHA mismatch' });
            return true;
          }
        }

        flat.set(filePath, { sha: blobSha, mode: '100644' });
        const newTreeSha = buildTreeFromFlat(flat);

        const parents = parentTip ? [parentTip] : [];
        const commitMsg = body.message ?? 'Update file';
        const commitBuf = formatCommit({
          tree: newTreeSha,
          parents,
          message: commitMsg,
        });
        const commitSha = writeObject('commit', commitBuf);

        repo.refs.set(targetHeadRef, commitSha);
        if (!repo.refs.get(`refs/heads/${repo.defaultBranch}`)) {
          repo.refs.set(`refs/heads/${repo.defaultBranch}`, commitSha);
        }

        const statusCode = isUpdate ? 200 : 201;
        const name = filePath.substring(filePath.lastIndexOf('/') + 1);
        sendJson(res, statusCode, {
          content: {
            name,
            path: filePath,
            sha: blobSha,
            size: contentBuf.length,
            type: 'file',
            encoding: 'base64',
            content: contentBase64,
          },
          commit: {
            sha: commitSha,
            message: commitMsg,
          },
        });
        return true;
      }

      if (method === 'DELETE') {
        let body: any;
        try {
          const text = await readBody(req);
          body = text ? JSON.parse(text) : {};
        } catch {
          sendJson(res, 400, { message: 'Invalid JSON' });
          return true;
        }

        const targetBranch = body.branch ?? branch;
        const targetHeadRef = `refs/heads/${targetBranch}`;
        const parentTip = repo.refs.get(targetHeadRef);
        if (!parentTip) {
          sendJson(res, 404, { message: 'Not Found' });
          return true;
        }

        const parentObj = readObject(parentTip);
        if (!parentObj || parentObj.type !== 'commit') {
          sendJson(res, 404, { message: 'Not Found' });
          return true;
        }

        const parentCommit = parseCommit(parentObj.data);
        const flat = flattenTree(parentCommit.tree, '');
        const existing = flat.get(filePath);
        if (!existing) {
          sendJson(res, 404, { message: 'Not Found' });
          return true;
        }
        if (body.sha && body.sha !== existing.sha) {
          sendJson(res, 409, { message: 'SHA mismatch' });
          return true;
        }

        flat.delete(filePath);
        const newTreeSha = buildTreeFromFlat(flat);
        const commitMsg = body.message ?? 'Delete file';
        const commitBuf = formatCommit({
          tree: newTreeSha,
          parents: [parentTip],
          message: commitMsg,
        });
        const commitSha = writeObject('commit', commitBuf);
        repo.refs.set(targetHeadRef, commitSha);

        sendJson(res, 200, {
          commit: {
            sha: commitSha,
            message: commitMsg,
          },
        });
        return true;
      }
    }

    // Labels API: /api/v3/repos/{o}/{r}/labels
    if (subPath === 'labels') {
      if (method === 'POST') {
        let body: any;
        try {
          const text = await readBody(req);
          body = text ? JSON.parse(text) : {};
        } catch {
          sendJson(res, 400, { message: 'Invalid JSON' });
          return true;
        }
        const name = body.name;
        if (!name) {
          sendJson(res, 422, { message: 'Label name is required' });
          return true;
        }
        const color = body.color ?? 'ededed';
        const description = body.description;
        repo.labels.set(name, { name, color, description });
        sendJson(res, 201, { name, color, description });
        return true;
      }
      if (method === 'GET') {
        const list = Array.from(repo.labels.values());
        sendJson(res, 200, list);
        return true;
      }
    }

    // Issues API: /api/v3/repos/{o}/{r}/issues
    if (subPath === 'issues' || subPath.startsWith('issues/')) {
      const issueSub = subPath.substring(7); // e.g. "" or "{n}" or "{n}/comments"

      if (issueSub === '' && method === 'GET') {
        const query = url.searchParams;
        const stateFilter = query.get('state') ?? 'open';
        let filtered = repo.issues.filter((iss) => {
          if (stateFilter === 'all') return true;
          return iss.state === stateFilter;
        });

        const sort = query.get('sort');
        const direction = query.get('direction') ?? 'asc';
        if (sort === 'created') {
          filtered.sort((a, b) => {
            return direction === 'desc' ? b.number - a.number : a.number - b.number;
          });
        }

        sendJson(res, 200, filtered.map(formatIssue));
        return true;
      }

      if (issueSub === '' && method === 'POST') {
        let body: any;
        try {
          const text = await readBody(req);
          body = text ? JSON.parse(text) : {};
        } catch {
          sendJson(res, 400, { message: 'Invalid JSON' });
          return true;
        }

        const title = body.title;
        if (!title) {
          sendJson(res, 422, { message: 'Title is required' });
          return true;
        }

        const labelNames: string[] = [];
        if (Array.isArray(body.labels)) {
          for (const l of body.labels) {
            if (typeof l === 'string') labelNames.push(l);
            else if (l && typeof l.name === 'string') labelNames.push(l.name);
          }
        }

        const issueLabels: { name: string; color: string; description?: string }[] = [];
        for (const ln of labelNames) {
          const foundLabel = repo.labels.get(ln);
          if (!foundLabel) {
            sendJson(res, 422, { message: `Label ${ln} not found` });
            return true;
          }
          issueLabels.push(foundLabel);
        }

        const number = repo.nextNumber++;
        const issue: Issue = {
          id: getNextObjectId(),
          number,
          title,
          body: body.body ?? '',
          state: 'open',
          labels: issueLabels,
          user: { login },
          created_at: nowIso(),
          updated_at: nowIso(),
          comments: [],
          createdSeq: getNextSeq(),
          kind: 'issue',
        };
        repo.issues.push(issue);
        sendJson(res, 201, formatIssue(issue));
        return true;
      }

      const issueNumMatch = issueSub.match(/^(\d+)(?:\/(.*))?$/);
      if (issueNumMatch) {
        const issueNum = parseInt(issueNumMatch[1], 10);
        const restIssue = issueNumMatch[2] ?? '';
        const issue = repo.issues.find((i) => i.number === issueNum);

        if (!issue) {
          sendJson(res, 404, { message: 'Not Found' });
          return true;
        }

        if (restIssue === '' && method === 'GET') {
          sendJson(res, 200, formatIssue(issue));
          return true;
        }

        if (restIssue === '' && method === 'PATCH') {
          let body: any;
          try {
            const text = await readBody(req);
            body = text ? JSON.parse(text) : {};
          } catch {
            sendJson(res, 400, { message: 'Invalid JSON' });
            return true;
          }
          if (body.state) issue.state = body.state;
          if (body.title !== undefined) issue.title = body.title;
          if (body.body !== undefined) issue.body = body.body;
          issue.updated_at = nowIso();
          sendJson(res, 200, formatIssue(issue));
          return true;
        }

        if (restIssue === 'comments') {
          if (method === 'GET') {
            sendJson(res, 200, issue.comments);
            return true;
          }
          if (method === 'POST') {
            let body: any;
            try {
              const text = await readBody(req);
              body = text ? JSON.parse(text) : {};
            } catch {
              sendJson(res, 400, { message: 'Invalid JSON' });
              return true;
            }
            const commentBody = body.body ?? '';
            const comment = {
              id: getNextObjectId(),
              body: commentBody,
              user: { login },
              created_at: nowIso(),
            };
            issue.comments.push(comment);
            sendJson(res, 201, comment);
            return true;
          }
        }
      }
    }

    // Pulls API: /api/v3/repos/{o}/{r}/pulls
    if (subPath === 'pulls' || subPath.startsWith('pulls/')) {
      const pullSub = subPath.substring(6); // e.g. "" or "{n}" or "{n}/files" or "{n}/merge"

      if (pullSub === '' && method === 'GET') {
        const query = url.searchParams;
        const stateFilter = query.get('state') ?? 'open';
        const filtered = repo.pulls.filter((p) => {
          if (stateFilter === 'all') return true;
          if (stateFilter === 'open') return p.state === 'open';
          if (stateFilter === 'closed') return p.state === 'closed' || p.merged;
          return p.state === stateFilter;
        });
        sendJson(res, 200, filtered.map(formatPull));
        return true;
      }

      if (pullSub === '' && method === 'POST') {
        let body: any;
        try {
          const text = await readBody(req);
          body = text ? JSON.parse(text) : {};
        } catch {
          sendJson(res, 400, { message: 'Invalid JSON' });
          return true;
        }

        const title = body.title;
        const headRaw = body.head;
        const baseRaw = body.base;

        if (!title || !headRaw || !baseRaw) {
          sendJson(res, 422, { message: 'title, head, and base are required' });
          return true;
        }

        const headBranch = headRaw.includes(':') ? headRaw.split(':')[1] : headRaw;
        const baseBranch = baseRaw.includes(':') ? baseRaw.split(':')[1] : baseRaw;

        const headTip = repo.refs.get(`refs/heads/${headBranch}`);
        const baseTip = repo.refs.get(`refs/heads/${baseBranch}`);

        if (!headTip || !baseTip) {
          sendJson(res, 422, { message: 'Head or base branch not found' });
          return true;
        }

        const number = repo.nextNumber++;
        const pull: Pull = {
          id: getNextObjectId(),
          number,
          title,
          body: body.body ?? '',
          state: 'open',
          merged: false,
          head: { label: headBranch, ref: headBranch, sha: headTip },
          base: { label: baseBranch, ref: baseBranch, sha: baseTip },
          user: { login },
          created_at: nowIso(),
          updated_at: nowIso(),
          createdSeq: getNextSeq(),
          kind: 'pull',
        };
        repo.pulls.push(pull);
        sendJson(res, 201, formatPull(pull));
        return true;
      }

      const pullNumMatch = pullSub.match(/^(\d+)(?:\/(.*))?$/);
      if (pullNumMatch) {
        const pullNum = parseInt(pullNumMatch[1], 10);
        const restPull = pullNumMatch[2] ?? '';
        const pull = repo.pulls.find((p) => p.number === pullNum);

        if (!pull) {
          sendJson(res, 404, { message: 'Not Found' });
          return true;
        }

        if (restPull === '' && method === 'GET') {
          sendJson(res, 200, formatPull(pull));
          return true;
        }

        if (restPull === 'files' && method === 'GET') {
          // Compute diff between base tip tree and head tip tree
          const baseCommitObj = readObject(pull.base.sha);
          const headCommitObj = readObject(pull.head.sha);
          let baseTree = '';
          let headTree = '';
          if (baseCommitObj && baseCommitObj.type === 'commit') {
            baseTree = parseCommit(baseCommitObj.data).tree;
          }
          if (headCommitObj && headCommitObj.type === 'commit') {
            headTree = parseCommit(headCommitObj.data).tree;
          }
          const diffs = diffTrees(baseTree, headTree);
          sendJson(res, 200, diffs);
          return true;
        }

        if (restPull === 'merge' && method === 'PUT') {
          if (pull.state === 'closed' || pull.merged) {
            sendJson(res, 405, { message: 'Pull request already merged or closed' });
            return true;
          }

          const baseBranch = pull.base.ref;
          const baseTip = repo.refs.get(`refs/heads/${baseBranch}`);
          const headTip = pull.head.sha;

          if (!baseTip) {
            sendJson(res, 404, { message: 'Base branch not found' });
            return true;
          }

          const mergeBase = findMergeBase(baseTip, headTip);
          // Simple conflict check: if mergeBase != baseTip, check if baseTip and headTip have conflicting modifications
          if (mergeBase && mergeBase !== baseTip) {
            // Check tree diffs
            const baseCommitObj = readObject(baseTip);
            const headCommitObj = readObject(headTip);
            const mergeBaseCommitObj = readObject(mergeBase);
            if (baseCommitObj && headCommitObj && mergeBaseCommitObj) {
              const baseTree = parseCommit(baseCommitObj.data).tree;
              const headTree = parseCommit(headCommitObj.data).tree;
              const mbTree = parseCommit(mergeBaseCommitObj.data).tree;
              const baseFlat = flattenTree(baseTree, '');
              const headFlat = flattenTree(headTree, '');
              const mbFlat = flattenTree(mbTree, '');

              // Check for path modified in both relative to mb
              for (const [path, headVal] of headFlat.entries()) {
                const mbVal = mbFlat.get(path);
                const baseVal = baseFlat.get(path);
                if (baseVal && mbVal && baseVal.sha !== mbVal.sha && headVal.sha !== mbVal.sha && baseVal.sha !== headVal.sha) {
                  sendJson(res, 405, { message: 'Merge conflict detected' });
                  return true;
                }
              }
            }
          }

          // Perform merge
          const result = mergePullRequestInRepo(repo, pull);

          sendJson(res, 200, {
            sha: result.sha,
            merged: true,
            message: result.message,
          });
          return true;
        }
      }
    }
  }

  sendJson(res, 404, { message: 'Not Found' });
  return true;
}

function formatRepoObject(repo: Repo, login: string): any {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${login}/${repo.name}`,
    owner: {
      login,
      id: 1000,
      type: 'User',
    },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `http://localhost/${login}/${repo.name}`,
    created_at: nowIso(),
    updated_at: nowIso(),
  };
}

function formatIssue(issue: Issue): any {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels,
    user: issue.user,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    comments: issue.comments.length,
    html_url: '',
  };
}

function formatPull(pull: Pull): any {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.merged_at,
    merge_commit_sha: pull.merge_commit_sha,
    head: pull.head,
    base: pull.base,
    user: pull.user,
    created_at: pull.created_at,
    updated_at: pull.updated_at,
    html_url: '',
  };
}
