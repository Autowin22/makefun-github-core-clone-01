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

const TOOLS = [
  {
    name: "create_repo",
    description: "Create a new repository",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        description: { type: "string" }
      },
      required: ["name"]
    }
  },
  {
    name: "get_repo",
    description: "Get repository details",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        name: { type: "string" },
        repo: { type: "string" }
      }
    }
  },
  {
    name: "create_issue",
    description: "Create a new issue",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string" },
        repository: { type: "string" },
        owner: { type: "string" },
        name: { type: "string" },
        title: { type: "string" },
        body: { type: "string" },
        labels: { type: "array", items: { type: "string" } }
      },
      required: ["title"]
    }
  },
  {
    name: "list_issues",
    description: "List issues in a repository",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string" },
        state: { type: "string" }
      },
      required: ["repo"]
    }
  },
  {
    name: "create_pull_request",
    description: "Create a new pull request",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string" },
        title: { type: "string" },
        head: { type: "string" },
        headRefName: { type: "string" },
        base: { type: "string" },
        baseRefName: { type: "string" },
        body: { type: "string" }
      },
      required: ["repo", "title"]
    }
  },
  {
    name: "merge_pull_request",
    description: "Merge a pull request",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string" },
        number: { type: "integer" },
        pull_number: { type: "integer" },
        merge_method: { type: "string" }
      },
      required: ["repo"]
    }
  }
];

function formatRepoObject(repo: Repo, login: string): any {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${login}/${repo.name}`,
    owner: { login, id: 1000, type: 'User' },
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

function resolveRepo(args: any): Repo | null {
  const repoName = args.repo || args.name || args.repository;
  const owner = args.owner || (args.repo && args.repo.includes('/') ? args.repo.split('/')[0] : (viewerLogin || 'viewer'));
  const name = (args.repo && args.repo.includes('/') ? args.repo.split('/')[1] : repoName);
  
  if (!name) return null;
  return findRepo(owner, name);
}

async function handleCall(name: string, args: any): Promise<{ content: any[], isError?: boolean } | { code: number, message: string }> {
  const toolName = name.split('/').pop()?.toLowerCase() || '';

  if (toolName === 'create_repo') {
    if (!args.name) return { isError: true, content: [{ type: 'text', text: 'Missing name' }] };
    const key = args.name.toLowerCase();
    if (repos.has(key)) return { isError: true, content: [{ type: 'text', text: 'Repository already exists' }] };
    const repo: Repo = {
      id: getNextRepoId(),
      name: args.name,
      description: args.description || '',
      private: false,
      defaultBranch: 'main',
      refs: new Map(),
      labels: new Map(),
      issues: [],
      pulls: [],
      nextNumber: 1,
      createdSeq: getNextSeq(),
    };
    repos.set(key, repo);
    const result = formatRepoObject(repo, viewerLogin || 'viewer');
    return { content: [{ type: 'text', text: JSON.stringify(result) }], isError: false };
  }

  if (toolName === 'get_repo') {
    const repo = resolveRepo(args);
    if (!repo) return { isError: true, content: [{ type: 'text', text: 'Repository not found' }] };
    const result = formatRepoObject(repo, viewerLogin || 'viewer');
    return { content: [{ type: 'text', text: JSON.stringify(result) }], isError: false };
  }

  if (toolName === 'create_issue') {
    const repo = resolveRepo(args);
    if (!repo) return { isError: true, content: [{ type: 'text', text: 'Repository not found' }] };
    if (!args.title) return { isError: true, content: [{ type: 'text', text: 'Missing title' }] };
    const issue: Issue = {
      id: getNextObjectId(),
      number: repo.nextNumber++,
      title: args.title,
      body: args.body || '',
      state: 'open',
      labels: (args.labels || []).map((l: string) => ({ name: l, color: 'cccccc' })),
      user: { login: viewerLogin || 'viewer' },
      created_at: nowIso(),
      updated_at: nowIso(),
      comments: [],
      createdSeq: getNextSeq(),
      kind: 'issue',
    };
    repo.issues.push(issue);
    const result = formatIssue(issue);
    return { content: [{ type: 'text', text: JSON.stringify(result) }], isError: false };
  }

  if (toolName === 'list_issues') {
    const repo = resolveRepo(args);
    if (!repo) return { isError: true, content: [{ type: 'text', text: 'Repository not found' }] };
    let filtered = repo.issues;
    if (args.state === 'open' || args.state === 'closed') {
      filtered = filtered.filter(i => i.state === args.state);
    }
    const result = filtered.map(formatIssue);
    return { content: [{ type: 'text', text: JSON.stringify(result) }], isError: false };
  }

  if (toolName === 'create_pull_request') {
    const repo = resolveRepo(args);
    if (!repo) return { isError: true, content: [{ type: 'text', text: 'Repository not found' }] };
    const title = args.title;
    const head = args.head || args.headRefName;
    const base = args.base || args.baseRefName;
    if (!title || !head || !base) return { isError: true, content: [{ type: 'text', text: 'Missing title, head, or base' }] };
    
    const headSha = repo.refs.get(`refs/heads/${head}`) || '0000000000000000000000000000000000000000';
    const baseSha = repo.refs.get(`refs/heads/${base}`) || '0000000000000000000000000000000000000000';

    const pull: Pull = {
      id: getNextObjectId(),
      number: repo.nextNumber++,
      title,
      body: args.body || '',
      state: 'open',
      merged: false,
      head: { label: head, ref: head, sha: headSha },
      base: { label: base, ref: base, sha: baseSha },
      user: { login: viewerLogin || 'viewer' },
      created_at: nowIso(),
      updated_at: nowIso(),
      createdSeq: getNextSeq(),
      kind: 'pull',
    };
    repo.pulls.push(pull);
    const result = formatPull(pull);
    return { content: [{ type: 'text', text: JSON.stringify(result) }], isError: false };
  }

  if (toolName === 'merge_pull_request') {
    const repo = resolveRepo(args);
    if (!repo) return { isError: true, content: [{ type: 'text', text: 'Repository not found' }] };
    const num = args.number || args.pull_number;
    const pull = repo.pulls.find(p => p.number === num);
    if (!pull) return { isError: true, content: [{ type: 'text', text: 'Pull request not found' }] };
    
    try {
      const mergeRes = mergePullRequestInRepo(repo, pull);
      const result = {
        sha: mergeRes.sha,
        merged: true,
        message: mergeRes.message,
      };
      return { content: [{ type: 'text', text: JSON.stringify(result) }], isError: false };
    } catch (err: any) {
      return { isError: true, content: [{ type: 'text', text: err.message }] };
    }
  }

  return { code: -32601, message: `Method not found: ${name}` };
}

export async function handleMcp(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname !== '/mcp' || req.method !== 'POST') return false;

  const expectedToken = process.env.MAKEFUN_SHOP_TOKEN;
  if (expectedToken) {
    const authHeader = req.headers.authorization;
    if (!authHeader || authHeader !== `Bearer ${expectedToken}`) {
      sendJson(res, 401, { message: 'Unauthorized' });
      return true;
    }
  }

  let bodyText: string;
  try {
    bodyText = await readBody(req);
  } catch {
    sendJson(res, 400, { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null });
    return true;
  }

  let requests: any;
  try {
    requests = JSON.parse(bodyText);
  } catch {
    sendJson(res, 400, { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null });
    return true;
  }

  const isBatch = Array.isArray(requests);
  const reqArray = isBatch ? requests : [requests];
  const results = [];

  for (const r of reqArray) {
    if (typeof r !== 'object' || r === null) {
      results.push({ jsonrpc: "2.0", error: { code: -32600, message: "Invalid Request" }, id: null });
      continue;
    }

    const { method, params, id } = r;

    if (method === 'server/discover') {
      results.push({ jsonrpc: "2.0", result: { supportedVersions: ["2026-07-28", "2025-11-25"] }, id });
    } else if (method === 'initialize') {
      const version = params?.protocolVersion === "2026-07-28" ? "2026-07-28" : "2025-11-25";
      results.push({
        jsonrpc: "2.0",
        result: {
          protocolVersion: version,
          capabilities: { tools: {} },
          serverInfo: { name: "makefun-forge", version: "1.0.0" }
        },
        id
      });
    } else if (method === 'notifications/initialized') {
      if (id !== undefined) {
        results.push({ jsonrpc: "2.0", result: null, id });
      } else {
        // Notification: answer 202/204. But if it's in a batch, we just skip it or push nothing.
        // The contract says "Notifications (no id) -> 202/204 empty".
      }
    } else if (method === 'tools/list') {
      results.push({ jsonrpc: "2.0", result: { tools: TOOLS }, id });
    } else if (method === 'tools/call') {
      const callRes = await handleCall(params?.name, params?.arguments || {});
      if ('code' in callRes) {
        results.push({ jsonrpc: "2.0", error: callRes, id });
      } else {
        results.push({ jsonrpc: "2.0", result: callRes, id });
      }
    } else {
      if (id !== undefined) {
        results.push({ jsonrpc: "2.0", error: { code: -32601, message: "Method not found" }, id });
      }
    }
  }

  if (!isBatch && reqArray[0]?.id === undefined && reqArray[0]?.method?.startsWith('notifications/')) {
    res.writeHead(202);
    res.end();
    return true;
  }

  if (isBatch) {
    sendJson(res, 200, results.filter(r => r !== undefined));
  } else {
    if (results.length > 0) {
      sendJson(res, 200, results[0]);
    } else {
      res.writeHead(202);
      res.end();
    }
  }

  return true;
}
