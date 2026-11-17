import { createApp } from './app.ts';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';

process.env.MAKEFUN_SHOP_TOKEN = 'test';

const server = createApp();
server.listen(0, async () => {
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 3000;
  const baseUrl = `http://127.0.0.1:${port}`;
  const owner = 'adaiversen';
  const repoName = 'demo';
  const authHeader = 'Authorization: Bearer test';

  // 1. Create repo & PUT a.txt
  await fetch(`${baseUrl}/api/v3/user/repos`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: 'Bearer test' },
    body: JSON.stringify({ name: repoName }),
  });
  await fetch(`${baseUrl}/api/v3/repos/${owner}/${repoName}/contents/a.txt`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', Authorization: 'Bearer test' },
    body: JSON.stringify({ message: 'c1', content: Buffer.from('a\n').toString('base64') }),
  });

  // 2. Clone, commit 3 files, push feature
  const cloneDir = path.join(process.cwd(), 'test-clone-inspect');
  if (fs.existsSync(cloneDir)) fs.rmSync(cloneDir, { recursive: true, force: true });
  execSync(`git -c http.extraHeader="${authHeader}" clone "${baseUrl}/${owner}/${repoName}.git" "${cloneDir}"`, { stdio: 'pipe' });
  execSync(`git config user.name "Test" && git config user.email "t@b.c"`, { cwd: cloneDir });
  execSync(`git checkout -b feature`, { cwd: cloneDir });
  for (let i = 1; i <= 3; i++) {
    fs.writeFileSync(path.join(cloneDir, `f${i}.txt`), `content-${i}\n`);
    execSync(`git add f${i}.txt && git commit -m "feat${i}"`, { cwd: cloneDir });
  }
  execSync(`git -c http.extraHeader="${authHeader}" push origin feature`, { cwd: cloneDir, stdio: 'pipe' });

  const tip = execSync(`git rev-parse feature`, { cwd: cloneDir, encoding: 'utf8' }).trim();
  const base = execSync(`git rev-parse main`, { cwd: cloneDir, encoding: 'utf8' }).trim();
  console.log(`Tip: ${tip}, Base: ${base}`);

  // 3. Manual v2 fetch request
  const body = Buffer.concat([
    pktLine('command=fetch\n'),
    pktLine('object-format=sha1\n'),
    Buffer.from('0001', 'ascii'),
    pktLine('ofs-delta\n'),
    pktLine(`want ${tip}\n`),
    pktLine(`have ${base}\n`),
    pktLine('done\n'),
    Buffer.from('0000', 'ascii'),
  ]);

  const fetchRes = await fetch(`${baseUrl}/${owner}/${repoName}.git/git-upload-pack`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test',
      'Git-Protocol': 'version=2',
      'Content-Type': 'application/x-git-upload-pack-request',
    },
    body,
  });

  const arrayBuf = await fetchRes.arrayBuffer();
  const data = Buffer.from(arrayBuf);

  // Parse response pkt-lines to extract packfile
  let i = 0;
  let packBuf = Buffer.alloc(0);
  let section: string | null = null;
  while (i < data.length) {
    if (i + 4 > data.length) break;
    const lenHex = data.toString('utf8', i, i + 4);
    if (lenHex === '0000') { break; }
    if (lenHex === '0001') { i += 4; section = null; continue; }
    const len = parseInt(lenHex, 16);
    if (isNaN(len) || len <= 4) break;
    const payload = data.subarray(i + 4, i + len);
    i += len;
    if (section === null) {
      section = payload.toString('utf8').trim();
    } else if (section === 'packfile') {
      if (payload.length > 0 && payload[0] === 1) {
        packBuf = Buffer.concat([packBuf, payload.subarray(1)]);
      }
    }
  }

  console.log('Extracted pack size:', packBuf.length);
  fs.writeFileSync('debug.pack', packBuf);

  // Walk pack entries
  if (packBuf.length >= 12 && packBuf.toString('ascii', 0, 4) === 'PACK') {
    const objCount = packBuf.readUInt32BE(8);
    console.log('Object count in pack header:', objCount);
    let offset = 12;
    for (let idx = 0; idx < objCount; idx++) {
      if (offset >= packBuf.length - 20) break;
      const entryStart = offset;
      const b0 = packBuf[offset++];
      const typeNum = (b0 >> 4) & 7;
      let size = b0 & 15;
      let shift = 4;
      let b = b0;
      while (b & 0x80) {
        b = packBuf[offset++];
        size |= (b & 0x7f) << shift;
        shift += 7;
      }
      // If delta
      let deltaInfo = '';
      if (typeNum === 6) {
        let negOff = 0, shiftOff = 0;
        while (offset < packBuf.length) {
          const ob = packBuf[offset++];
          negOff |= (ob & 0x7f) << shiftOff;
          if (!(ob & 0x80)) break;
          shiftOff += 7;
          negOff += 1 << shiftOff;
        }
        deltaInfo = `ofs-delta baseOffset=${entryStart - negOff}`;
      } else if (typeNum === 7) {
        const baseSha = packBuf.subarray(offset, offset + 20).toString('hex');
        offset += 20;
        deltaInfo = `ref-delta baseSha=${baseSha}`;
      }

      const compStart = offset;
      // Let's find inflate end or try zlib inflate
      let compressedLen = 0;
      try {
        // try inflating from compStart to end
        const rem = packBuf.subarray(compStart);
        const inflated = zlib.inflateSync(rem);
        // find how many bytes were consumed by zlib inflate
        // Wait, zlib doesn't tell us how many input bytes were consumed unless we use zlib.inflateSync or streaming.
        // Wait, can we use findInflateEnd?
      } catch (e) {}

      // Let's use findInflateEnd or check
      const infLen = findInflateEnd(packBuf, compStart);
      offset += infLen;
      let infSize = -1;
      try {
        const inf = zlib.inflateSync(packBuf.subarray(compStart, compStart + infLen));
        infSize = inf.length;
      } catch (e) {
        infSize = -999;
      }

      console.log(`Entry ${idx}: type=${typeNum} statedSize=${size} infLen=${infLen} infSize=${infSize} ${deltaInfo}`);
    }
  }

  server.close();
});

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

function pktLine(content: string): Buffer {
  const buf = Buffer.from(content, 'utf8');
  const len = buf.length + 4;
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'ascii'), buf]);
}
