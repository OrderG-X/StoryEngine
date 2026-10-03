import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { runWithTestTemp } from './run-vitest.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'story-test-runner-check-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('isolates temp env, passes args/env, and cleans only its own run', async (t) => {
  const root = await fixture(t);
  const report = join(root, 'report.json');
  const sentinel = join(root, 'keep.txt');
  await writeFile(sentinel, 'keep');
  const code = `const fs=require('fs'),os=require('os'),p=require('path');
    fs.writeFileSync(p.join(os.tmpdir(),'generated'),'fixture');
    fs.symlinkSync(process.env.SENTINEL,p.join(os.tmpdir(),'outside-link'));
    fs.writeFileSync(process.env.REPORT,JSON.stringify({tmp:os.tmpdir(),tmp2:process.env.TMP,temp:process.env.TEMP,arg:process.argv[1],value:process.env.PASSTHROUGH}));`;
  const result = await runWithTestTemp(process.execPath, ['-e', code, 'arg value'], {
    tempBase: root, env: { ...process.env, STORY_ENGINE_KEEP_TEST_TMP: '', REPORT: report, SENTINEL: sentinel, PASSTHROUGH: 'yes' },
  });
  assert.equal(result.code, 0);
  const data = JSON.parse(await readFile(report, 'utf8'));
  assert.equal(data.tmp, result.temporaryDirectory);
  assert.equal(data.tmp2, data.tmp);
  assert.equal(data.temp, data.tmp);
  assert.equal(data.arg, 'arg value');
  assert.equal(data.value, 'yes');
  assert.equal(existsSync(result.temporaryDirectory), false);
  assert.equal(await readFile(sentinel, 'utf8'), 'keep');
});

test('failed commands preserve their exit code and still clean', async (t) => {
  const root = await fixture(t);
  const result = await runWithTestTemp(process.execPath, ['-e', 'process.exitCode=7'], {
    tempBase: root, env: { ...process.env, STORY_ENGINE_KEEP_TEST_TMP: '' },
  });
  assert.equal(result.code, 7);
  assert.equal(existsSync(result.temporaryDirectory), false);
});

test('spawn errors clean the new directory', async (t) => {
  const root = await fixture(t);
  const result = await runWithTestTemp(join(root, 'missing-command'), [], { tempBase: root, env: {} });
  assert.equal(result.code, 1);
  assert.match(result.error, /ENOENT/);
  assert.equal(existsSync(result.temporaryDirectory), false);
});

test('default temp root supports nested Unix socket fixtures', { skip: process.platform === 'win32' }, async () => {
  const code = `const fs=require('fs'),os=require('os'),p=require('path'),net=require('net');
    const root=fs.mkdtempSync(p.join(os.tmpdir(),'memory-read-runtime-'));
    fs.mkdirSync(p.join(root,'memory'));
    const server=net.createServer();
    server.once('error',()=>{process.exitCode=1});
    server.listen(p.join(root,'memory/socket.txt'),()=>server.close());`;
  const result = await runWithTestTemp(process.execPath, ['-e', code], {
    env: { ...process.env, STORY_ENGINE_KEEP_TEST_TMP: '' },
  });
  assert.equal(result.code, 0);
  assert.equal(existsSync(result.temporaryDirectory), false);
});

test('explicit debugging opt-in keeps only that run', async (t) => {
  const root = await fixture(t);
  const result = await runWithTestTemp(process.execPath, ['-e', ''], {
    tempBase: root, env: { ...process.env, STORY_ENGINE_KEEP_TEST_TMP: '1' },
  });
  assert.equal(result.code, 0);
  assert.equal(existsSync(result.temporaryDirectory), true);
});

test('parallel runs own different directories', async (t) => {
  const root = await fixture(t);
  const runs = await Promise.all([0, 1].map(() => runWithTestTemp(process.execPath, ['-e', 'setTimeout(()=>{},30)'], {
    tempBase: root, env: { ...process.env, STORY_ENGINE_KEEP_TEST_TMP: '' },
  })));
  assert.notEqual(runs[0].temporaryDirectory, runs[1].temporaryDirectory);
  assert.deepEqual(await readdir(root), []);
});

test('SIGTERM stops its test child before cleanup', { skip: process.platform === 'win32' }, async (t) => {
  const root = await fixture(t);
  const ready = join(root, 'ready');
  const childCode = `require('fs').writeFileSync(${JSON.stringify(ready)},require('os').tmpdir());setInterval(()=>{},1000)`;
  const wrapper = `import {runWithTestTemp} from ${JSON.stringify(new URL('./run-vitest.mjs', import.meta.url).href)};
    const r=await runWithTestTemp(process.execPath,['-e',${JSON.stringify(childCode)}],{tempBase:${JSON.stringify(root)},env:{...process.env,STORY_ENGINE_KEEP_TEST_TMP:''}});process.exitCode=r.code;`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', wrapper], { stdio: 'ignore' });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  const completion = once(child, 'close');
  for (let i = 0; i < 200 && !existsSync(ready); i++) await delay(25);
  assert.equal(existsSync(ready), true);
  const temporaryDirectory = await readFile(ready, 'utf8');
  child.kill('SIGTERM');
  const [code] = await completion;
  assert.equal(code, 143);
  assert.equal(existsSync(temporaryDirectory), false);
});
