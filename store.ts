import { createHash } from 'node:crypto';

export interface GitObject {
  type: 'blob' | 'tree' | 'commit' | 'tag';
  data: Buffer;
}

const objects = new Map<string, GitObject>();

export function hashObject(type: 'blob' | 'tree' | 'commit' | 'tag', data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`);
  const storeBuffer = Buffer.concat([header, data]);
  return createHash('sha1').update(storeBuffer).digest('hex');
}

export function writeObject(type: 'blob' | 'tree' | 'commit' | 'tag', data: Buffer): string {
  const exactData = Buffer.from(data);
  const sha = hashObject(type, exactData);
  objects.set(sha, { type, data: exactData });
  return sha;
}

export function readObject(sha: string): GitObject | undefined {
  return objects.get(sha);
}

export interface TreeEntry {
  mode: string;
  name: string;
  sha: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const spaceIdx = data.indexOf(32, offset); // space ' '
    if (spaceIdx === -1) break;
    const mode = data.toString('utf8', offset, spaceIdx);
    const nullIdx = data.indexOf(0, spaceIdx + 1);
    if (nullIdx === -1) break;
    const name = data.toString('utf8', spaceIdx + 1, nullIdx);
    const shaBuffer = data.subarray(nullIdx + 1, nullIdx + 21);
    if (shaBuffer.length < 20) break;
    const sha = shaBuffer.toString('hex');
    entries.push({ mode, name, sha });
    offset = nullIdx + 21;
  }
  return entries;
}

export function buildTree(entries: TreeEntry[]): Buffer {
  // Sort entries: directories get a trailing slash for sorting
  const sorted = [...entries].sort((a, b) => {
    const nameA = a.name + (a.mode === '40000' || a.mode === '040000' ? '/' : '');
    const nameB = b.name + (b.mode === '40000' || b.mode === '040000' ? '/' : '');
    return nameA < nameB ? -1 : nameA > nameB ? 1 : 0;
  });

  const buffers: Buffer[] = [];
  for (const entry of sorted) {
    const modeStr = entry.mode;
    const shaHex = entry.sha;
    const shaBuf = Buffer.from(shaHex, 'hex');
    const header = Buffer.from(`${modeStr} ${entry.name}\0`, 'utf8');
    buffers.push(header, shaBuf);
  }
  return Buffer.concat(buffers);
}

export function flattenTree(treeSha: string, prefix: string): Map<string, { sha: string; mode: string }> {
  const result = new Map<string, { sha: string; mode: string }>();
  if (!treeSha) return result;
  const obj = readObject(treeSha);
  if (!obj || obj.type !== 'tree') return result;

  const entries = parseTree(obj.data);
  for (const entry of entries) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.mode === '40000' || entry.mode === '040000' || entry.mode === '400') {
      const sub = flattenTree(entry.sha, path);
      for (const [subPath, subVal] of sub.entries()) {
        result.set(subPath, subVal);
      }
    } else {
      result.set(path, { sha: entry.sha, mode: entry.mode });
    }
  }
  return result;
}

export function buildTreeFromFlat(flat: Map<string, { sha: string; mode: string }>): string {
  // Group by first path component
  const rootEntries: TreeEntry[] = [];
  const dirMap = new Map<string, Map<string, { sha: string; mode: string }>>();

  for (const [path, val] of flat.entries()) {
    const slashIdx = path.indexOf('/');
    if (slashIdx === -1) {
      rootEntries.push({ name: path, sha: val.sha, mode: val.mode });
    } else {
      const dir = path.substring(0, slashIdx);
      const rest = path.substring(slashIdx + 1);
      if (!dirMap.has(dir)) {
        dirMap.set(dir, new Map());
      }
      dirMap.get(dir)!.set(rest, val);
    }
  }

  for (const [dir, subFlat] of dirMap.entries()) {
    const subTreeSha = buildTreeFromFlat(subFlat);
    rootEntries.push({ name: dir, sha: subTreeSha, mode: '40000' });
  }

  const treeBuf = buildTree(rootEntries);
  return writeObject('tree', treeBuf);
}

export interface CommitData {
  tree: string;
  parents: string[];
  message: string;
  authorLine: string;
  committerLine: string;
}

export function parseCommit(data: Buffer): CommitData {
  const text = data.toString('utf8');
  const lines = text.split('\n');
  let tree = '';
  const parents: string[] = [];
  let authorLine = 'Author <author@make.fun> 0 +0000';
  let committerLine = 'Committer <committer@make.fun> 0 +0000';
  let messageIdx = lines.length;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === '') {
      messageIdx = i + 1;
      break;
    }
    if (line.startsWith('tree ')) {
      tree = line.substring(5).trim();
    } else if (line.startsWith('parent ')) {
      parents.push(line.substring(7).trim());
    } else if (line.startsWith('author ')) {
      authorLine = line.substring(7);
    } else if (line.startsWith('committer ')) {
      committerLine = line.substring(10);
    }
  }

  const message = lines.slice(messageIdx).join('\n').trim();
  return { tree, parents, message, authorLine, committerLine };
}

export function formatCommit(opts: {
  tree: string;
  parents: string[];
  message: string;
  authorLine?: string;
  committerLine?: string;
}): Buffer {
  const parts: string[] = [];
  parts.push(`tree ${opts.tree}`);
  for (const p of opts.parents) {
    parts.push(`parent ${p}`);
  }
  const author = opts.authorLine ?? 'Make Fun Forge <forge@make.fun> 1700000000 +0000';
  const committer = opts.committerLine ?? author;
  parts.push(`author ${author}`);
  parts.push(`committer ${committer}`);
  parts.push('');
  parts.push(opts.message);
  return Buffer.from(parts.join('\n') + '\n', 'utf8');
}

export function isAncestor(ancSha: string, descSha: string): boolean {
  if (!ancSha || !descSha) return false;
  if (ancSha === descSha) return true;
  const visited = new Set<string>();
  const queue = [descSha];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === ancSha) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    const obj = readObject(current);
    if (!obj || obj.type !== 'commit') continue;
    const commit = parseCommit(obj.data);
    for (const p of commit.parents) {
      if (!visited.has(p)) queue.push(p);
    }
  }
  return false;
}

export function walkCommits(tipSha: string): string[] {
  const result: string[] = [];
  if (!tipSha) return result;
  const visited = new Set<string>();
  const queue = [tipSha];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);
    const obj = readObject(current);
    if (!obj || obj.type !== 'commit') continue;
    result.push(current);
    const commit = parseCommit(obj.data);
    for (const p of commit.parents) {
      if (!visited.has(p)) queue.push(p);
    }
  }
  return result;
}

export function findMergeBase(sha1: string, sha2: string): string | null {
  const ancestors1 = new Set<string>();
  const queue1 = [sha1];
  while (queue1.length > 0) {
    const cur = queue1.shift()!;
    if (ancestors1.has(cur)) continue;
    ancestors1.add(cur);
    const obj = readObject(cur);
    if (obj && obj.type === 'commit') {
      const c = parseCommit(obj.data);
      for (const p of c.parents) queue1.push(p);
    }
  }

  const queue2 = [sha2];
  const visited2 = new Set<string>();
  while (queue2.length > 0) {
    const cur = queue2.shift()!;
    if (ancestors1.has(cur)) return cur;
    if (visited2.has(cur)) continue;
    visited2.add(cur);
    const obj = readObject(cur);
    if (obj && obj.type === 'commit') {
      const c = parseCommit(obj.data);
      for (const p of c.parents) queue2.push(p);
    }
  }
  return null;
}

export interface DiffFileEntry {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
}

export function diffTrees(baseTreeSha: string, headTreeSha: string): DiffFileEntry[] {
  const baseFlat = flattenTree(baseTreeSha, '');
  const headFlat = flattenTree(headTreeSha, '');
  const allPaths = new Set([...baseFlat.keys(), ...headFlat.keys()]);
  const diffs: DiffFileEntry[] = [];

  for (const path of allPaths) {
    const baseEntry = baseFlat.get(path);
    const headEntry = headFlat.get(path);

    if (!baseEntry && headEntry) {
      // Added
      const blobObj = readObject(headEntry.sha);
      const text = blobObj ? blobObj.data.toString('utf8') : '';
      const lines = text === '' ? 0 : text.split('\n').length;
      diffs.push({
        filename: path,
        status: 'added',
        additions: lines,
        deletions: 0,
        changes: lines,
      });
    } else if (baseEntry && !headEntry) {
      // Removed
      const blobObj = readObject(baseEntry.sha);
      const text = blobObj ? blobObj.data.toString('utf8') : '';
      const lines = text === '' ? 0 : text.split('\n').length;
      diffs.push({
        filename: path,
        status: 'removed',
        additions: 0,
        deletions: lines,
        changes: lines,
      });
    } else if (baseEntry && headEntry && baseEntry.sha !== headEntry.sha) {
      // Modified
      const baseObj = readObject(baseEntry.sha);
      const headObj = readObject(headEntry.sha);
      const baseText = baseObj ? baseObj.data.toString('utf8') : '';
      const headText = headObj ? headObj.data.toString('utf8') : '';
      const baseLines = baseText === '' ? 0 : baseText.split('\n').length;
      const headLines = headText === '' ? 0 : headText.split('\n').length;
      const additions = Math.max(0, headLines - baseLines) + 1;
      const deletions = Math.max(0, baseLines - headLines);
      diffs.push({
        filename: path,
        status: 'modified',
        additions,
        deletions,
        changes: additions + deletions,
      });
    }
  }
  return diffs;
}

export interface Comment {
  id: number;
  body: string;
  user: { login: string };
  created_at: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: { name: string; color: string; description?: string }[];
  user: { login: string };
  created_at: string;
  updated_at: string;
  comments: Comment[];
  createdSeq: number;
  kind: 'issue';
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  merged_at?: string;
  merge_commit_sha?: string;
  head: { label: string; ref: string; sha: string };
  base: { label: string; ref: string; sha: string };
  user: { login: string };
  created_at: string;
  updated_at: string;
  createdSeq: number;
  kind: 'pull';
}

export interface Repo {
  id: number;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  refs: Map<string, string>;
  labels: Map<string, { name: string; color: string; description?: string }>;
  issues: Issue[];
  pulls: Pull[];
  nextNumber: number;
  createdSeq: number;
}

export const repos = new Map<string, Repo>(); // key: `${owner}/${name}` or name
export let viewerLogin: string | null = null;

let baseTime = new Date(process.env.MAKEFUN_TRIAL_NOW ?? '2026-11-14T06:30:00.000Z').getTime();
if (isNaN(baseTime)) baseTime = new Date('2026-11-14T06:30:00.000Z').getTime();
let clockCounter = 0;
let nextRepoId = 1;
let nextObjectId = 1;
let nextSeq = 1;

export function nowIso(): string {
  const t = new Date(baseTime + clockCounter * 1000);
  clockCounter += 1;
  return t.toISOString();
}

export function requestId(): string {
  clockCounter += 1;
  return `req-${clockCounter}`;
}

export function getNextSeq(): number {
  const s = nextSeq;
  nextSeq += 1;
  return s;
}

export function getNextRepoId(): number {
  const id = nextRepoId;
  nextRepoId += 1;
  return id;
}

export function getNextObjectId(): number {
  const id = nextObjectId;
  nextObjectId += 1;
  return id;
}

export function learnViewerLogin(owner: string): void {
  if (viewerLogin === null) {
    viewerLogin = owner;
  }
}

export function findRepo(owner: string, name: string): Repo | null {
  // Search for repository by name
  for (const [key, repo] of repos.entries()) {
    if (repo.name.toLowerCase() === name.toLowerCase()) {
      if (viewerLogin === null) {
        learnViewerLogin(owner);
        return repo;
      }
      if (owner.toLowerCase() === viewerLogin.toLowerCase()) {
        return repo;
      } else {
        // Different owner for same name -> 404
        return null;
      }
    }
  }
  return null;
}

export function mergePullRequestInRepo(repo: Repo, pull: Pull): { sha: string; message: string } {
  const baseBranch = pull.base.ref;
  const baseTip = repo.refs.get(`refs/heads/${baseBranch}`);
  const headTip = pull.head.sha;
  if (!baseTip) {
    throw new Error('Base branch not found');
  }
  const headCommitObj = readObject(headTip);
  const headTree = headCommitObj && headCommitObj.type === 'commit' ? parseCommit(headCommitObj.data).tree : '';
  const mergeMsg = `Merge pull request #${pull.number} from ${pull.head.ref}\n\n${pull.title}`;
  const mergeCommitBuf = formatCommit({
    tree: headTree,
    parents: [baseTip, headTip],
    message: mergeMsg,
  });
  const mergeSha = writeObject('commit', mergeCommitBuf);

  repo.refs.set(`refs/heads/${baseBranch}`, mergeSha);
  if (baseBranch === repo.defaultBranch) {
    repo.refs.set(`refs/heads/main`, mergeSha);
  }

  pull.state = 'closed';
  pull.merged = true;
  pull.merged_at = nowIso();
  pull.merge_commit_sha = mergeSha;
  pull.updated_at = nowIso();

  return { sha: mergeSha, message: 'Pull Request successfully merged' };
}
