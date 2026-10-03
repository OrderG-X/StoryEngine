/** Isolate one test command's OS-temp fixtures; never sweep shared temp directories. */
import { spawn } from 'node:child_process';
import { lstat, mkdtemp, realpath, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { constants, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function runWithTestTemp(command, args, options = {}) {
  const env = options.env ?? process.env;
  // macOS's per-user temp path is long enough that an extra run directory breaks
  // Unix-domain socket fixtures (sun_path has a small fixed limit). mkdtemp still
  // gives this invocation a private, unpredictable directory under /private/tmp.
  const base = await realpath(options.tempBase ?? (process.platform === 'darwin' ? '/tmp' : tmpdir()));
  const temporaryDirectory = await mkdtemp(join(base, 'story-engine-tests-'));
  const identity = await lstat(temporaryDirectory);
  const keep = env.STORY_ENGINE_KEEP_TEST_TMP === '1';
  let child;
  let forceTimer;
  let requestedSignal;
  const forward = (signal) => {
    requestedSignal = signal;
    if (!child?.pid) return;
    const stop = (value) => {
      try {
        if (process.platform === 'win32') child.kill(value);
        else process.kill(-child.pid, value); // Only the group created for this command.
      } catch (error) { if (error.code !== 'ESRCH') console.error(error.message); }
    };
    stop(signal);
    forceTimer ??= setTimeout(() => stop('SIGKILL'), 5000).unref();
  };
  const onInt = () => forward('SIGINT');
  const onTerm = () => forward('SIGTERM');
  process.on('SIGINT', onInt);
  process.on('SIGTERM', onTerm);
  try {
    child = spawn(command, args, {
      cwd: options.cwd ?? process.cwd(),
      env: { ...env, TMPDIR: temporaryDirectory, TMP: temporaryDirectory, TEMP: temporaryDirectory },
      stdio: options.stdio ?? 'inherit',
      detached: process.platform !== 'win32',
    });
    const result = await new Promise((done) => {
      child.once('error', (error) => done({ code: 1, error: error.message }));
      child.once('close', (code, signal) => done({
        code: requestedSignal ? 128 + (constants.signals[requestedSignal] ?? 1)
          : code ?? 128 + (constants.signals[signal] ?? 1),
        signal,
      }));
    });
    return { ...result, temporaryDirectory };
  } finally {
    clearTimeout(forceTimer);
    process.off('SIGINT', onInt);
    process.off('SIGTERM', onTerm);
    if (keep) {
      console.error(`[test-temp] kept for debugging: ${temporaryDirectory}`);
    } else {
      const current = await lstat(temporaryDirectory).catch(error => {
        if (error.code !== 'ENOENT') throw error;
      });
      if (current) {
        if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino)
          throw new Error(`Refusing to clean a replaced test directory: ${temporaryDirectory}`);
        await rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      }
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const require = createRequire(join(process.cwd(), 'package.json'));
    const entry = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
    const result = await runWithTestTemp(process.execPath, [entry, ...process.argv.slice(2)]);
    if (result.error) console.error(result.error);
    process.exitCode = result.code;
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
