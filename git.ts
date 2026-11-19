import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import * as zlib from 'node:zlib';
import {
  repos,
  findRepo,
  readObject,
  writeObject,
  hashObject,
  parseTree,
  parseCommit,
  isAncestor,
  type Repo,
} from './store.ts';

const ZERO_OID = '0000000000000000000000000000000000000000';

function pktLine(content: string | Buffer): Buffer {
  const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  const len = buf.length + 4;
  const lenHex = len.toString(16).padStart(4, '0');
  return Buffer.concat([Buffer.from(lenHex, 'ascii'), buf]);
}

const PKT_FLUSH = Buffer.from('0000', 'utf8');
const PKT_DELIM = Buffer.from('0001', 'utf8');

function sendText(res: ServerResponse, status: number, contentType: string, body: Buffer | string): void {
  const buf = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': buf.length,
    'cache-control': 'no-cache',
  });
  res.end(buf);
}

async function readBodyBuffer(req: IncomingMessage): Promise<Buffer> {
  const contentLength = req.headers['content-length'] ? parseInt(req.headers['content-length'] as string, 10) : NaN;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 64 * 1024 * 1024) {
      throw new Error('Payload too large');
    }
    chunks.push(chunk as Buffer);
    if (!isNaN(contentLength) && size >= contentLength) {
      break;
    }
  }
  return Buffer.concat(chunks);
}

function parsePktLines(buf: Buffer): { line: Buffer; flush: boolean; delim: boolean }[] {
  const result: { line: Buffer; flush: boolean; delim: boolean }[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) break;
    const lenHex = buf.toString('utf8', offset, offset + 4);
    if (lenHex === '0000') {
      result.push({ line: Buffer.alloc(0), flush: true, delim: false });
      offset += 4;
      continue;
    }
    if (lenHex === '0001') {
      result.push({ line: Buffer.alloc(0), flush: false, delim: true });
      offset += 4;
      continue;
    }
    const len = parseInt(lenHex, 16);
    if (isNaN(len) || len <= 4) break;
    if (offset + len > buf.length) break;
    const line = buf.subarray(offset + 4, offset + len);
    result.push({ line, flush: false, delim: false });
    offset += len;
  }
  return result;
}

function peel(sha: string): string | null {
  let currentSha = sha;
  for (let i = 0; i < 10; i++) {
    const obj = readObject(currentSha);
    if (!obj) return null;
    if (obj.type !== 'tag') return currentSha;
    const text = obj.data.toString('utf8');
    const match = text.match(/^object ([0-9a-f]{40})/m);
    if (!match) return null;
    currentSha = match[1];
  }
  return null;
}

// Pack generation cache
const packCache = new Map<string, { packBuf: Buffer; shallowShas: Set<string> }>();

function generatePackAndShallows(repo: Repo, wants: string[], haves: string[], shallowDepth?: number, clientShallows: string[] = []): { packBuf: Buffer; shallowShas: Set<string> } {
  const cacheKey = `${repo.name}:${[...wants].sort().join(',')}:${[...haves].sort().join(',')}:${shallowDepth ?? 0}:${clientShallows.sort().join(',')}`;
  if (packCache.has(cacheKey)) {
    return packCache.get(cacheKey)!;
  }

  const haveCommits = new Set<string>();
  const clientShallowSet = new Set(clientShallows);

  for (const h of haves) {
    const queue = [h];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      if (haveCommits.has(cur)) continue;
      haveCommits.add(cur);
      if (clientShallowSet.has(cur)) continue;
      const obj = readObject(cur);
      if (obj && obj.type === 'commit') {
        const c = parseCommit(obj.data);
        for (const p of c.parents) queue.push(p);
      }
    }
  }

  const haveObjects = new Set<string>();
  for (const cSha of haveCommits) {
    const obj = readObject(cSha);
    if (!obj || obj.type !== 'commit') continue;
    const c = parseCommit(obj.data);
    if (c.tree) {
      collectTreeAndBlobs(c.tree, haveObjects);
    }
  }

  const wantCommits = new Set<string>();
  const shallowShas = new Set<string>();
  const queue: { sha: string; depth: number }[] = wants.map((w) => ({ sha: w, depth: 0 }));

  while (queue.length > 0) {
    const { sha, depth } = queue.shift()!;
    if (haveCommits.has(sha)) continue;
    if (wantCommits.has(sha)) continue;

    const obj = readObject(sha);
    if (!obj || obj.type !== 'commit') continue;

    if (shallowDepth !== undefined && depth >= shallowDepth) {
      shallowShas.add(sha);
      continue;
    }
    wantCommits.add(sha);

    const c = parseCommit(obj.data);
    for (const p of c.parents) {
      queue.push({ sha: p, depth: depth + 1 });
    }
  }

  const objectShas = new Set<string>();
  for (const cSha of wantCommits) {
    objectShas.add(cSha);
    const obj = readObject(cSha);
    if (!obj || obj.type !== 'commit') continue;
    const c = parseCommit(obj.data);
    if (c.tree) {
      collectTreeAndBlobs(c.tree, objectShas);
    }
  }

  for (const s of haveObjects) {
    objectShas.delete(s);
  }

  function collectTreeAndBlobs(treeSha: string, set: Set<string>) {
    if (set.has(treeSha)) return;
    set.add(treeSha);
    const obj = readObject(treeSha);
    if (!obj || obj.type !== 'tree') return;
    const entries = parseTree(obj.data);
    for (const entry of entries) {
      if (entry.mode === '40000' || entry.mode === '040000' || entry.mode === '400') {
        collectTreeAndBlobs(entry.sha, set);
      } else {
        set.add(entry.sha);
      }
    }
  }

  for (const sha of [...objectShas]) {
    if (!readObject(sha)) objectShas.delete(sha);
  }

  const packParts: Buffer[] = [];
  // Pack header: 'PACK' (4 bytes) + version 2 (uint32be) + count (uint32be)
  const headerBuf = Buffer.alloc(12);
  headerBuf.write('PACK', 0, 4, 'ascii');
  headerBuf.writeUInt32BE(2, 4);
  headerBuf.writeUInt32BE(objectShas.size, 8);
  packParts.push(headerBuf);

  for (const sha of objectShas) {
    const obj = readObject(sha);
    if (!obj) continue;

    let typeNum = 1; // commit
    if (obj.type === 'tree') typeNum = 2;
    else if (obj.type === 'blob') typeNum = 3;
    else if (obj.type === 'tag') typeNum = 4;

    const compressed = zlib.deflateSync(obj.data);
    const objHeader = encodeObjectHeader(typeNum, obj.data.length);
    packParts.push(objHeader, compressed);
  }

  const packWithoutTrailer = Buffer.concat(packParts);
  const trailer = createHash('sha1').update(packWithoutTrailer).digest();
  const finalPack = Buffer.concat([packWithoutTrailer, trailer]);

  const result = { packBuf: finalPack, shallowShas };
  packCache.set(cacheKey, result);
  return result;
}

function generatePack(repo: Repo, wants: string[], haves: string[], shallowDepth?: number): Buffer {
  return generatePackAndShallows(repo, wants, haves, shallowDepth).packBuf;
}

function encodeObjectHeader(typeNum: number, size: number): Buffer {
  const bytes: number[] = [];
  let b = ((typeNum & 7) << 4) | (size & 15);
  size >>= 4;
  if (size > 0) {
    b |= 0x80;
    bytes.push(b);
    while (size > 0) {
      let nextB = size & 0x7f;
      size >>= 7;
      if (size > 0) nextB |= 0x80;
      bytes.push(nextB);
    }
  } else {
    bytes.push(b);
  }
  return Buffer.from(bytes);
}

function findInflateEnd(buf: Buffer, off: number): number {
  let lo = 1;
  let hi = buf.length - off;
  let best = hi;
  while (lo <= hi) {
    let mid = (lo + hi) >> 1;
    try {
      zlib.inflateSync(buf.subarray(off, off + mid));
      best = mid;
      hi = mid - 1;
    } catch {
      lo = mid + 1;
    }
  }
  return best;
}

function applyDelta(baseData: Buffer, deltaData: Buffer): Buffer {
  let offset = 0;
  function readVarint(): number {
    let res = 0;
    let shift = 0;
    while (offset < deltaData.length) {
      const b = deltaData[offset++];
      res |= (b & 0x7f) << shift;
      if (!(b & 0x80)) break;
      shift += 7;
    }
    return res;
  }

  const baseSize = readVarint();
  const targetSize = readVarint();
  const target = Buffer.alloc(targetSize);
  let targetOffset = 0;

  while (offset < deltaData.length) {
    const cmd = deltaData[offset++];
    if (cmd & 0x80) {
      let cpOff = 0;
      let cpSize = 0;
      if (cmd & 0x01) cpOff |= deltaData[offset++] << 0;
      if (cmd & 0x02) cpOff |= deltaData[offset++] << 8;
      if (cmd & 0x04) cpOff |= deltaData[offset++] << 16;
      if (cmd & 0x08) cpOff |= deltaData[offset++] << 24;

      if (cmd & 0x10) cpSize |= deltaData[offset++] << 0;
      if (cmd & 0x20) cpSize |= deltaData[offset++] << 8;
      if (cmd & 0x40) cpSize |= deltaData[offset++] << 16;
      if (cpSize === 0) cpSize = 0x10000;

      baseData.copy(target, targetOffset, cpOff, cpOff + cpSize);
      targetOffset += cpSize;
    } else if (cmd > 0) {
      deltaData.copy(target, targetOffset, offset, offset + cmd);
      targetOffset += cmd;
      offset += cmd;
    } else {
      break;
    }
  }
  return target;
}

export async function handleGit(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/);
  if (!match) return false;

  const owner = match[1];
  const repoName = match[2];
  const action = match[3];

  console.log('[handleGit] req:', req.method, url.pathname, url.search, 'git-protocol:', req.headers['git-protocol']);

  const repo = findRepo(owner, repoName);
  if (!repo) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not Found\n');
    return true;
  }

  const expectedToken = process.env.MAKEFUN_SHOP_TOKEN;
  if (expectedToken) {
    const authHeader = req.headers.authorization;
    if (!authHeader || authHeader !== `Bearer ${expectedToken}`) {
      res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Unauthorized\n');
      return true;
    }
  }

  const method = req.method ?? 'GET';

  // 1) GET /info/refs
  if (action === 'info/refs') {
    const service = url.searchParams.get('service');
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Missing or invalid service\n');
      return true;
    }

    const gitProtocol = req.headers['git-protocol'] ?? '';
    const isV2 = service === 'git-upload-pack' && String(gitProtocol).includes('version=2');

    if (isV2) {
      const lines: Buffer[] = [];
      lines.push(pktLine('version 2\n'));
      lines.push(pktLine('agent=ada-forge/1.0\n'));
      lines.push(pktLine('ls-refs=unborn\n'));
      lines.push(pktLine('fetch=shallow wait-for-done\n'));
      lines.push(pktLine('server-option\n'));
      lines.push(pktLine('object-format=sha1\n'));
      lines.push(PKT_FLUSH);
      sendText(res, 200, 'application/x-git-upload-pack-advertisement', Buffer.concat(lines));
      return true;
    }

    // v0 advertisement
    const lines: Buffer[] = [];
    lines.push(pktLine(`# service=${service}\n`));
    lines.push(PKT_FLUSH);

    const refEntries = Array.from(repo.refs.entries());
    refEntries.sort((a, b) => a[0].localeCompare(b[0]));

    const defaultBranchRef = `refs/heads/${repo.defaultBranch}`;
    const defaultSha = repo.refs.get(defaultBranchRef) ?? (refEntries.length > 0 ? refEntries[0][1] : ZERO_OID);
    const headTip = refEntries.length > 0 ? defaultSha : ZERO_OID;

    if (service === 'git-upload-pack') {
      const caps = 'multi_ack_detailed side-band-64k ofs-delta';
      if (refEntries.length === 0) {
        lines.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
      } else {
        lines.push(pktLine(`${headTip} HEAD\0${caps}\n`));
        for (const [refName, sha] of refEntries) {
          lines.push(pktLine(`${sha} ${refName}\n`));
          if (refName.startsWith('refs/tags/')) {
            const peeled = peel(sha);
            if (peeled && peeled !== sha) {
              lines.push(pktLine(`${peeled} ${refName}^{}\n`));
            }
          }
        }
      }
    } else {
      // receive-pack
      const caps = 'report-status delete-refs side-band-64k ofs-delta quiet';
      if (refEntries.length === 0) {
        lines.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
      } else {
        lines.push(pktLine(`${headTip} HEAD\0${caps}\n`));
        for (const [refName, sha] of refEntries) {
          lines.push(pktLine(`${sha} ${refName}\n`));
          if (refName.startsWith('refs/tags/')) {
            const peeled = peel(sha);
            if (peeled && peeled !== sha) {
              lines.push(pktLine(`${peeled} ${refName}^{}\n`));
            }
          }
        }
      }
    }
    lines.push(PKT_FLUSH);

    const contentType =
      service === 'git-upload-pack'
        ? 'application/x-git-upload-pack-advertisement'
        : 'application/x-git-receive-pack-advertisement';

    sendText(res, 200, contentType, Buffer.concat(lines));
    return true;
  }

  // 2) POST /git-upload-pack
  if (action === 'git-upload-pack') {
    const bodyBuf = await readBodyBuffer(req);
    const gitProtocol = req.headers['git-protocol'] ?? '';
    const isV2 = String(gitProtocol).includes('version=2');

    if (isV2) {
      const pktList = parsePktLines(bodyBuf);
      let command = '';
      const args: string[] = [];
      let pastDelim = false;

      for (const p of pktList) {
        if (p.delim) {
          pastDelim = true;
          continue;
        }
        if (p.flush) {
          break;
        }
        const text = p.line.toString('utf8').trim();
        if (!command && text.startsWith('command=')) {
          command = text.substring(8);
        } else if (pastDelim || command) {
          args.push(text);
        }
      }

      if (command === 'ls-refs') {
        const refPrefixes: string[] = [];
        let wantSymrefs = false;
        let wantPeel = false;
        let wantUnborn = false;

        for (const arg of args) {
          if (arg.startsWith('ref-prefix ')) {
            refPrefixes.push(arg.substring(11).trim());
          } else if (arg === 'symrefs') {
            wantSymrefs = true;
          } else if (arg === 'peel') {
            wantPeel = true;
          } else if (arg === 'unborn') {
            wantUnborn = true;
          }
        }

        const outLines: Buffer[] = [];
        const defaultRef = `refs/heads/${repo.defaultBranch}`;
        const defaultSha = repo.refs.get(defaultRef);

        const headMatches = refPrefixes.length === 0 || refPrefixes.some((p) => 'HEAD'.startsWith(p));
        if (headMatches) {
          if (defaultSha) {
            let line = `${defaultSha} HEAD`;
            if (wantSymrefs) line += ` symref-target:${defaultRef}`;
            outLines.push(pktLine(`${line}\n`));
          } else if (wantUnborn) {
            outLines.push(pktLine(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
          }
        }

        const refEntries = Array.from(repo.refs.entries()).sort((a, b) => a[0].localeCompare(b[0]));
        for (const [refName, sha] of refEntries) {
          if (refPrefixes.length > 0) {
            const matches = refPrefixes.some((p) => refName.startsWith(p));
            if (!matches) continue;
          }
          let line = `${sha} ${refName}`;
          if (wantPeel) {
            const peeled = peel(sha);
            if (peeled && peeled !== sha) {
              line += ` peeled:${peeled}`;
            }
          }
          outLines.push(pktLine(`${line}\n`));
        }

        outLines.push(PKT_FLUSH);
        sendText(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(outLines));
        return true;
      }

      if (command === 'fetch') {
        const wants: string[] = [];
        const haves: string[] = [];
        const clientShallows: string[] = [];
        let shallowDepth: number | undefined = undefined;
        let hasDone = false;
        let hasWaitForDone = false;
        let hasShallowArg = false;

        console.log('[DEBUG v2 fetch] args:', args);

        for (const arg of args) {
          if (arg === 'done') {
            hasDone = true;
          } else if (arg === 'wait-for-done') {
            hasWaitForDone = true;
          } else if (arg.startsWith('want ')) {
            wants.push(arg.substring(5).trim());
          } else if (arg.startsWith('have ')) {
            haves.push(arg.substring(5).trim());
          } else if (arg.startsWith('deepen ')) {
            shallowDepth = parseInt(arg.substring(7), 10);
            hasShallowArg = true;
          } else if (arg.startsWith('shallow ')) {
            clientShallows.push(arg.substring(8).trim());
            hasShallowArg = true;
          } else if (arg === 'deepen-since' || arg === 'deepen-not') {
            hasShallowArg = true;
          }
        }

        const outLines: Buffer[] = [];

        if (!hasDone) {
          outLines.push(pktLine('acknowledgments\n'));
          const matchedHaves = haves.filter((h) => readObject(h));
          if (matchedHaves.length > 0) {
            for (const h of matchedHaves) {
              outLines.push(pktLine(`ACK ${h}\n`));
            }
          } else if (haves.length > 0) {
            outLines.push(pktLine(`ACK ${haves[0]}\n`));
          } else {
            outLines.push(pktLine('NAK\n'));
          }
          if (hasWaitForDone) {
            outLines.push(pktLine('ready\n'));
          }
          outLines.push(PKT_FLUSH);
          sendText(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(outLines));
          return true;
        }

        const { packBuf, shallowShas } = generatePackAndShallows(repo, wants, haves, shallowDepth, clientShallows);

        if (hasShallowArg) {
          outLines.push(pktLine('shallow-info\n'));
          for (const sSha of shallowShas) {
            outLines.push(pktLine(`shallow ${sSha}\n`));
          }
          for (const cShallow of clientShallows) {
            if (!shallowShas.has(cShallow) && !haves.includes(cShallow)) {
              outLines.push(pktLine(`unshallow ${cShallow}\n`));
            }
          }
          outLines.push(PKT_DELIM);
        }

        outLines.push(pktLine('packfile\n'));
        const maxChunk = 65515;
        for (let off = 0; off < packBuf.length; off += maxChunk) {
          const chunk = packBuf.subarray(off, off + maxChunk);
          const sideChunk = Buffer.concat([Buffer.from([1]), chunk]);
          outLines.push(pktLine(sideChunk));
        }
        outLines.push(PKT_FLUSH);

        sendText(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(outLines));
        return true;
      }
    }

    // v0 fetch
    const pktList = parsePktLines(bodyBuf);
    const wants: string[] = [];
    const haves: string[] = [];
    const clientShallows: string[] = [];
    let shallowDepth: number | undefined = undefined;

    for (const p of pktList) {
      if (p.flush) continue;
      const text = p.line.toString('utf8').trim();
      if (text.startsWith('want ')) {
        const parts = text.substring(5).split(' ');
        wants.push(parts[0]);
      } else if (text.startsWith('have ')) {
        haves.push(text.substring(5).trim());
      } else if (text.startsWith('deepen ')) {
        shallowDepth = parseInt(text.substring(7), 10);
      } else if (text.startsWith('shallow ')) {
        clientShallows.push(text.substring(8).trim());
      }
    }

    const outLines: Buffer[] = [];
    const { packBuf, shallowShas } = generatePackAndShallows(repo, wants, haves, shallowDepth, clientShallows);

    for (const sSha of shallowShas) {
      outLines.push(pktLine(`shallow ${sSha}\n`));
    }
    for (const cSha of clientShallows) {
      if (!shallowShas.has(cSha) && !haves.includes(cSha)) {
        outLines.push(pktLine(`unshallow ${cSha}\n`));
      }
    }

    outLines.push(pktLine('NAK\n'));

    const maxChunk = 65515;
    for (let off = 0; off < packBuf.length; off += maxChunk) {
      const chunk = packBuf.subarray(off, off + maxChunk);
      const payload = Buffer.concat([Buffer.from([1]), chunk]);
      outLines.push(pktLine(payload));
    }
    outLines.push(PKT_FLUSH);

    sendText(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(outLines));
    return true;
  }

  // 3) POST /git-receive-pack
  if (action === 'git-receive-pack') {
    const bodyBuf = await readBodyBuffer(req);
    // Parse pkt lines until flush, rest is packfile
    let offset = 0;
    const commands: { oldSha: string; newSha: string; refname: string }[] = [];
    let capsReceived = '';

    while (offset < bodyBuf.length) {
      if (offset + 4 > bodyBuf.length) break;
      const lenHex = bodyBuf.toString('utf8', offset, offset + 4);
      if (lenHex === '0000') {
        offset += 4;
        break;
      }
      const len = parseInt(lenHex, 16);
      if (isNaN(len) || len <= 4) break;
      const line = bodyBuf.subarray(offset + 4, offset + len).toString('utf8').trimEnd();
      offset += len;

      const parts = line.split(' ');
      if (parts.length >= 3) {
        const oldSha = parts[0];
        let newSha = parts[1];
        let refname = parts[2];

        const nullIdx = refname.indexOf('\0');
        if (nullIdx !== -1) {
          capsReceived = refname.substring(nullIdx + 1);
          refname = refname.substring(0, nullIdx);
        }
        commands.push({ oldSha, newSha, refname });
      }
    }

    const packData = bodyBuf.subarray(offset);
    const unpackedObjects = new Map<string, { type: 'blob' | 'tree' | 'commit' | 'tag'; data: Buffer }>();
    let unpackSuccess = true;

    if (packData.length > 12 && packData.toString('ascii', 0, 4) === 'PACK') {
      const objCount = packData.readUInt32BE(8);
      let packOffset = 12;

      // First pass: parse objects in pack (handling non-delta and delta objects)
      const parsedEntries: { typeNum: number; data: Buffer; baseSha?: string; baseOffset?: number; packOffset: number }[] = [];

      for (let i = 0; i < objCount; i++) {
        if (packOffset >= packData.length - 20) break;
        const entryOffset = packOffset;
        const b0 = packData[packOffset++];
        let typeNum = (b0 >> 4) & 7;
        let size = b0 & 15;
        let shift = 4;
        let b = b0;

        while (b & 0x80) {
          if (packOffset >= packData.length) break;
          b = packData[packOffset++];
          size |= (b & 0x7f) << shift;
          shift += 7;
        }

        let baseSha: string | undefined = undefined;
        let baseOffset: number | undefined = undefined;

        if (typeNum === 6) {
          // OBJ_OFS_DELTA
          let byte = packData[packOffset++];
          let offset = byte & 0x7f;
          while (byte & 0x80) {
            byte = packData[packOffset++];
            offset = ((offset + 1) << 7) | (byte & 0x7f);
          }
          baseOffset = entryOffset - offset;
        } else if (typeNum === 7) {
          // OBJ_REF_DELTA
          if (packOffset + 20 > packData.length) break;
          baseSha = packData.subarray(packOffset, packOffset + 20).toString('hex');
          packOffset += 20;
        }

        const deflateLen = findInflateEnd(packData, packOffset);
        const compressed = packData.subarray(packOffset, packOffset + deflateLen);
        packOffset += deflateLen;

        let rawData: Buffer;
        try {
          rawData = zlib.inflateSync(compressed);
        } catch {
          rawData = Buffer.alloc(0);
        }

        parsedEntries.push({ typeNum, data: rawData, baseSha, baseOffset, packOffset: entryOffset });
      }

      // Build sha->entry map for non-delta entries in pack
      const packShaMap = new Map<string, number>();
      for (let i = 0; i < parsedEntries.length; i++) {
        const entry = parsedEntries[i];
        if (entry.typeNum !== 6 && entry.typeNum !== 7) {
          let objType: 'blob' | 'tree' | 'commit' | 'tag' = 'blob';
          if (entry.typeNum === 1) objType = 'commit';
          else if (entry.typeNum === 2) objType = 'tree';
          else if (entry.typeNum === 3) objType = 'blob';
          else if (entry.typeNum === 4) objType = 'tag';
          const sha = hashObject(objType, entry.data);
          packShaMap.set(sha, i);
        }
      }

      // Resolve deltas and store objects
      const resolvedObjects = new Map<number, { type: 'blob' | 'tree' | 'commit' | 'tag'; data: Buffer; sha: string }>();

      // Helper to resolve an entry by index or offset
      function getResolved(idx: number): { type: 'blob' | 'tree' | 'commit' | 'tag'; data: Buffer; sha: string } | null {
        if (resolvedObjects.has(idx)) return resolvedObjects.get(idx)!;
        const entry = parsedEntries[idx];
        if (!entry) return null;

        let objType: 'blob' | 'tree' | 'commit' | 'tag' = 'blob';
        if (entry.typeNum === 1) objType = 'commit';
        else if (entry.typeNum === 2) objType = 'tree';
        else if (entry.typeNum === 3) objType = 'blob';
        else if (entry.typeNum === 4) objType = 'tag';

        if (entry.typeNum === 6 || entry.typeNum === 7) {
          let baseData: Buffer | undefined = undefined;
          let baseType: 'blob' | 'tree' | 'commit' | 'tag' | undefined = undefined;

          if (entry.baseSha) {
            const baseObj = readObject(entry.baseSha);
            if (baseObj) {
              baseData = baseObj.data;
              baseType = baseObj.type;
            } else if (packShaMap.has(entry.baseSha)) {
              const baseRes = getResolved(packShaMap.get(entry.baseSha)!);
              if (baseRes) {
                baseData = baseRes.data;
                baseType = baseRes.type;
              }
            } else {
              for (const [, res] of resolvedObjects) {
                if (res.sha === entry.baseSha) {
                  baseData = res.data;
                  baseType = res.type;
                  break;
                }
              }
            }
          } else if (entry.baseOffset !== undefined) {
            const baseIdx = parsedEntries.findIndex((e) => e.packOffset === entry.baseOffset);
            if (baseIdx !== -1) {
              const baseRes = getResolved(baseIdx);
              if (baseRes) {
                baseData = baseRes.data;
                baseType = baseRes.type;
              }
            }
          }

          if (!baseData || !baseType) {
            unpackSuccess = false;
            return null;
          }

          objType = baseType;
          const targetData = applyDelta(baseData, entry.data);
          const sha = writeObject(objType, targetData);
          const res = { type: objType, data: targetData, sha };
          resolvedObjects.set(idx, res);
          return res;
        } else {
          const sha = writeObject(objType, entry.data);
          const res = { type: objType, data: entry.data, sha };
          resolvedObjects.set(idx, res);
          return res;
        }
      }

      for (let i = 0; i < parsedEntries.length; i++) {
        getResolved(i);
      }
    }

    const reportLines: Buffer[] = [];
    if (!unpackSuccess) {
      reportLines.push(pktLine('unpack error unresolvable delta base\n'));
      for (const cmd of commands) {
        reportLines.push(pktLine(`ng ${cmd.refname} unpack failed\n`));
      }
    } else {
      // Validate and apply ref updates
      const refResults: { refname: string; ok: boolean; reason?: string }[] = [];

      for (const cmd of commands) {
        const { oldSha, newSha, refname } = cmd;
        const isCreate = oldSha === ZERO_OID;
        const isDelete = newSha === ZERO_OID;

        if (isDelete) {
          if (!repo.refs.has(refname)) {
            refResults.push({ refname, ok: false, reason: 'no such ref' });
          } else {
            repo.refs.delete(refname);
            refResults.push({ refname, ok: true });
          }
          continue;
        }

        const newObj = readObject(newSha);
        if (!newObj) {
          refResults.push({ refname, ok: false, reason: 'missing object' });
          continue;
        }

        if (isCreate) {
          if (repo.refs.has(refname) && repo.refs.get(refname) !== ZERO_OID) {
            refResults.push({ refname, ok: false, reason: 'already exists' });
          } else if (refname.startsWith('refs/heads/') && newObj.type !== 'commit') {
            refResults.push({ refname, ok: false, reason: 'not a commit' });
          } else {
            repo.refs.set(refname, newSha);
            if (refname === `refs/heads/${repo.defaultBranch}` || repo.refs.size === 1) {
              repo.defaultBranch = refname.startsWith('refs/heads/') ? refname.substring(11) : repo.defaultBranch;
            }
            refResults.push({ refname, ok: true });
          }
        } else {
          // Update
          const currentSha = repo.refs.get(refname);
          if (currentSha !== oldSha) {
            refResults.push({ refname, ok: false, reason: 'stale ref' });
          } else if (newObj.type !== 'commit') {
            refResults.push({ refname, ok: false, reason: 'not a commit' });
          } else if (!isAncestor(oldSha, newSha)) {
            refResults.push({ refname, ok: false, reason: 'non-fast-forward' });
          } else {
            repo.refs.set(refname, newSha);
            refResults.push({ refname, ok: true });
          }
        }
      }

      reportLines.push(pktLine('unpack ok\n'));
      for (const r of refResults) {
        if (r.ok) {
          reportLines.push(pktLine(`ok ${r.refname}\n`));
          packCache.clear();
        } else {
          reportLines.push(pktLine(`ng ${r.refname} ${r.reason ?? 'failed'}\n`));
        }
      }
    }
    reportLines.push(PKT_FLUSH);
    const reportBuf = Buffer.concat(reportLines);

    // Frame reportBuf into sideband-64k if requested
    const respChunks: Buffer[] = [];
    const maxChunk = 65515;
    for (let off = 0; off < reportBuf.length; off += maxChunk) {
      const chunk = reportBuf.subarray(off, off + maxChunk);
      const payload = Buffer.concat([Buffer.from([1]), chunk]);
      respChunks.push(pktLine(payload));
    }
    respChunks.push(PKT_FLUSH);

    sendText(res, 200, 'application/x-git-receive-pack-result', Buffer.concat(respChunks));
    return true;
  }

  return false;
}
