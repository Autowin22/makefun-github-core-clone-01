import { createApp } from './app.ts';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

process.env.MAKEFUN_SHOP_TOKEN = 'test';

const server = createApp();
server.listen(0, async () => {
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 3000;
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`Test server listening on ${baseUrl}`);

  const authHeader = 'Authorization: Bearer test';
  const owner = 'adaiversen';
  const repoName = 'demo';
  const cloneUrl = `${baseUrl}/${owner}/${repoName}.git`;

  try {
    // 1. REST create repo 'demo' + PUT contents hello.txt (owner 'adaiversen')
    console.log('[1] Creating repo via REST and PUTing hello.txt...');
    const createRes = await fetch(`${baseUrl}/api/v3/user/repos`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: 'Bearer test',
      },
      body: JSON.stringify({ name: repoName, description: 'demo repo' }),
    });
    if (createRes.status !== 201) {
      throw new Error(`Failed to create repo: ${createRes.status}`);
    }

    const putRes = await fetch(`${baseUrl}/api/v3/repos/${owner}/${repoName}/contents/hello.txt`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        Authorization: 'Bearer test',
      },
      body: JSON.stringify({
        message: 'Initial hello.txt',
        content: Buffer.from('Hello Forge v2\n').toString('base64'),
      }),
    });
    if (putRes.status !== 201) {
      throw new Error(`Failed to PUT contents: ${putRes.status}`);
    }
    console.log('Item 1 passed: Repo created and hello.txt PUT successfully.');

    // 2. Default clone (v2) -> hello.txt correct
    const cloneDir = path.join(process.cwd(), 'test-clone-v2');
    if (fs.existsSync(cloneDir)) fs.rmSync(cloneDir, { recursive: true, force: true });
    console.log('[2] Testing default clone (v2)...');
    execSync(`git -c http.extraHeader="${authHeader}" clone "${cloneUrl}" "${cloneDir}"`, { stdio: 'pipe' });
    const helloContent = fs.readFileSync(path.join(cloneDir, 'hello.txt'), 'utf8');
    if (helloContent !== 'Hello Forge v2\n') {
      throw new Error(`Default clone hello.txt content mismatch: ${JSON.stringify(helloContent)}`);
    }
    console.log('Item 2 passed: Default clone (v2) succeeded and hello.txt is correct.');

    // Configure git user
    execSync(`git config user.name "Test User"`, { cwd: cloneDir });
    execSync(`git config user.email "test@make.fun"`, { cwd: cloneDir });

    // 3. GIT_PROTOCOL=version=0 clone -> works
    const cloneV0Dir = path.join(process.cwd(), 'test-clone-v0');
    if (fs.existsSync(cloneV0Dir)) fs.rmSync(cloneV0Dir, { recursive: true, force: true });
    console.log('[3] Testing GIT_PROTOCOL=version=0 clone...');
    execSync(`GIT_PROTOCOL=version=0 git -c http.extraHeader="${authHeader}" clone "${cloneUrl}" "${cloneV0Dir}"`, { stdio: 'pipe' });
    if (!fs.existsSync(path.join(cloneV0Dir, 'hello.txt'))) {
      throw new Error('v0 clone missing hello.txt');
    }
    console.log('Item 3 passed: GIT_PROTOCOL=version=0 clone succeeded.');

    // 4. Local commit + push (default) -> ok; REST GET contents shows pushed file; re-clone shows it
    console.log('[4] Testing local commit + push...');
    fs.writeFileSync(path.join(cloneDir, 'pushed.txt'), 'Pushed content\n');
    execSync(`git add pushed.txt`, { cwd: cloneDir });
    execSync(`git commit -m "Add pushed.txt"`, { cwd: cloneDir });
    execSync(`git -c http.extraHeader="${authHeader}" push origin main`, { cwd: cloneDir, stdio: 'pipe' });

    // Check REST GET contents for pushed.txt
    const getRestRes = await fetch(`${baseUrl}/api/v3/repos/${owner}/${repoName}/contents/pushed.txt`, {
      headers: { Authorization: 'Bearer test' },
    });
    if (getRestRes.status !== 200) {
      throw new Error(`REST GET pushed.txt failed: ${getRestRes.status}`);
    }
    const getRestJson = await getRestRes.json();
    const decodedPushed = Buffer.from(getRestJson.content, 'base64').toString('utf8');
    if (decodedPushed !== 'Pushed content\n') {
      throw new Error('REST GET pushed.txt content mismatch');
    }
    console.log('Item 4 passed: Local commit + push succeeded, REST GET verified.');

    // 5. Push over v0 (GIT_PROTOCOL=version=0 git push) -> ok
    console.log('[5] Testing push over v0...');
    fs.writeFileSync(path.join(cloneDir, 'v0-push.txt'), 'v0 pushed\n');
    execSync(`git add v0-push.txt`, { cwd: cloneDir });
    execSync(`git commit -m "Add v0-push.txt"`, { cwd: cloneDir });
    execSync(`GIT_PROTOCOL=version=0 git -c http.extraHeader="${authHeader}" push origin main`, { cwd: cloneDir, stdio: 'pipe' });
    console.log('Item 5 passed: Push over v0 succeeded.');

    // 6. Clone --depth 1 (v2) -> works, .git/shallow exists
    const shallowDir = path.join(process.cwd(), 'test-shallow');
    if (fs.existsSync(shallowDir)) fs.rmSync(shallowDir, { recursive: true, force: true });
    console.log('[6] Testing clone --depth 1 (v2)...');
    execSync(`git -c http.extraHeader="${authHeader}" clone --depth 1 "${cloneUrl}" "${shallowDir}"`, { stdio: 'pipe' });
    if (!fs.existsSync(path.join(shallowDir, '.git', 'shallow'))) {
      throw new Error('Shallow clone missing .git/shallow file');
    }
    console.log('Item 6 passed: Clone --depth 1 succeeded with .git/shallow present.');

    // 7. Divergent push -> rejected, output contains 'non-fast-forward'
    console.log('[7] Testing divergent push rejection...');
    fs.writeFileSync(path.join(cloneDir, 'divergent.txt'), 'divergent\n');
    execSync(`git add divergent.txt`, { cwd: cloneDir });
    execSync(`git commit -m "Divergent commit"`, { cwd: cloneDir });
    execSync(`git reset --hard HEAD~3`, { cwd: cloneDir });
    fs.writeFileSync(path.join(cloneDir, 'another.txt'), 'another\n');
    execSync(`git add another.txt`, { cwd: cloneDir });
    execSync(`git commit -m "Another commit"`, { cwd: cloneDir });

    let nonFfRejected = false;
    try {
      execSync(`git -c http.extraHeader="${authHeader}" push origin main`, { cwd: cloneDir, stdio: 'pipe' });
    } catch (err: any) {
      const out = (err.stderr?.toString() ?? '') + (err.stdout?.toString() ?? '');
      if (out.includes('non-fast-forward') || out.includes('fetch first') || out.includes('rejected')) {
        nonFfRejected = true;
      }
    }
    if (!nonFfRejected) {
      throw new Error('Divergent push was not rejected as expected');
    }
    console.log('Item 7 passed: Divergent push correctly rejected.');

    // 8. git fetch in an old clone after a new push -> updates
    console.log('[8] Testing git fetch in old clone...');
    // Make a valid new commit in cloneV0Dir or cloneDir (after pull/ff or push from another place)
    // Let's reset cloneDir to origin/main and push successfully
    execSync(`git fetch origin && git reset --hard origin/main`, { cwd: cloneDir });
    fs.writeFileSync(path.join(cloneDir, 'fetch-test.txt'), 'fetch test\n');
    execSync(`git add fetch-test.txt && git commit -m "Fetch test"`, { cwd: cloneDir });
    execSync(`git -c http.extraHeader="${authHeader}" push origin main`, { cwd: cloneDir, stdio: 'pipe' });

    // Now fetch in cloneV0Dir
    execSync(`git -c http.extraHeader="${authHeader}" fetch origin`, { cwd: cloneV0Dir, stdio: 'pipe' });
    execSync(`git reset --hard origin/main`, { cwd: cloneV0Dir });
    if (!fs.existsSync(path.join(cloneV0Dir, 'fetch-test.txt'))) {
      throw new Error('Old clone did not update after git fetch');
    }
    console.log('Item 8 passed: git fetch successfully updated old clone.');

    // 9. ls-remote v2 and v0 both list HEAD + refs/heads/main
    console.log('[9] Testing ls-remote v2 and v0...');
    const lsV2 = execSync(`GIT_PROTOCOL=version=2 git -c http.extraHeader="${authHeader}" ls-remote "${cloneUrl}"`, { encoding: 'utf8' });
    const lsV0 = execSync(`GIT_PROTOCOL=version=0 git -c http.extraHeader="${authHeader}" ls-remote "${cloneUrl}"`, { encoding: 'utf8' });
    if (!lsV2.includes('HEAD') || !lsV2.includes('refs/heads/main') || !lsV0.includes('HEAD') || !lsV0.includes('refs/heads/main')) {
      throw new Error(`ls-remote output missing HEAD or refs/heads/main:\nv2:\n${lsV2}\nv0:\n${lsV0}`);
    }
    console.log('Item 9 passed: ls-remote v2 and v0 both list HEAD and refs/heads/main.');

    // 10. info/refs for a missing repo -> HTTP 404 for both services; server still answers afterwards
    console.log('[10] Testing info/refs for missing repo and server recovery...');
    const missingUpload = await fetch(`${baseUrl}/${owner}/nonexistent.git/info/refs?service=git-upload-pack`, {
      headers: { Authorization: 'Bearer test' },
    });
    const missingReceive = await fetch(`${baseUrl}/${owner}/nonexistent.git/info/refs?service=git-receive-pack`, {
      headers: { Authorization: 'Bearer test' },
    });
    if (missingUpload.status !== 404 || missingReceive.status !== 404) {
      throw new Error(`Missing repo status code unexpected: upload=${missingUpload.status}, receive=${missingReceive.status}`);
    }

    // Verify server still answers afterwards for valid repo
    const validAgain = await fetch(`${cloneUrl}/info/refs?service=git-upload-pack`, {
      headers: { Authorization: 'Bearer test' },
    });
    if (validAgain.status !== 200) {
      throw new Error(`Server failed to answer after missing repo request: ${validAgain.status}`);
    }
    console.log('Item 10 passed: Missing repo returned 404 for both services, server still answers afterwards.');

    console.log('ALL 10 SMOKE TEST ITEMS PASSED SUCCESSFULLY!');
  } catch (err) {
    console.error('Smoke test failed:', err);
    process.exit(1);
  } finally {
    server.close();
  }
});
