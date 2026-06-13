// tests/sandbox-isolation.mjs — verify that WorktreeExecutor blocks out-of-boundary paths (U-62).
//
// Tests the key acceptance criteria:
//   1. WorktreeExecutor rejects paths that resolve outside the sandbox root
//   2. Rejection message is 'Operation blocked: path is outside worktree'
//   3. WorktreeExecutor allows paths within the sandbox root
//   4. PassthroughExecutor allows any path (no isolation when sandbox.enabled=false)
//   5. createSandbox() returns WorktreeExecutor when enabled, PassthroughExecutor otherwise

import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';

import {
  IsolationViolationError,
  SandboxExecutor,
  WorktreeExecutor,
  PassthroughExecutor,
  createSandbox,
} from '../core/sandbox.mjs';

// ── helper ──────────────────────────────────────────────────────────────────

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sandbox-test-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// ── 1. IsolationViolationError ───────────────────────────────────────────────

test('IsolationViolationError has correct code and name', () => {
  const err = new IsolationViolationError('test message', { path: '/etc/passwd', sandboxRoot: '/tmp/work' });
  assert.equal(err.name, 'IsolationViolationError');
  assert.equal(err.code, 'SANDBOX_ISOLATION_VIOLATION');
  assert.equal(err.blockedPath, '/etc/passwd');
  assert.equal(err.sandboxRoot, '/tmp/work');
});

// ── 2. SandboxExecutor is abstract ──────────────────────────────────────────

test('SandboxExecutor methods throw "abstract" errors', async () => {
  const base = new SandboxExecutor();
  await assert.rejects(() => base.execShell('ls'), /abstract/);
  await assert.rejects(() => base.gitCommand(['status']), /abstract/);
  await assert.rejects(() => base.readFile('/tmp/x'), /abstract/);
  await assert.rejects(() => base.writeFile('/tmp/x', 'y'), /abstract/);
  await assert.rejects(() => base.globFiles('**/*'), /abstract/);
});

// ── 3. WorktreeExecutor path validation ─────────────────────────────────────

test('WorktreeExecutor._assertPath blocks paths outside the boundary', async () => {
  await withTempDir(async (dir) => {
    const executor = new WorktreeExecutor(dir);

    // ../.. escape attempt
    const err1 = assert.throws(
      () => executor._assertPath('../escape'),
      IsolationViolationError
    );

    // Absolute path to system file (simulates reading /etc/passwd or C:\Windows\System32)
    const systemPath = process.platform === 'win32'
      ? 'C:\\Windows\\System32\\notepad.exe'
      : '/etc/passwd';
    assert.throws(
      () => executor._assertPath(systemPath),
      IsolationViolationError,
      'absolute system path must be rejected'
    );
  });
});

test('WorktreeExecutor._assertPath error message contains the required phrase', async () => {
  await withTempDir(async (dir) => {
    const executor = new WorktreeExecutor(dir);
    try {
      executor._assertPath('../outside');
      assert.fail('should have thrown');
    } catch (err) {
      assert.ok(
        err.message.includes('Operation blocked: path is outside worktree'),
        `Expected "Operation blocked: path is outside worktree" in: ${err.message}`
      );
    }
  });
});

test('WorktreeExecutor._assertPath allows paths within the boundary', async () => {
  await withTempDir(async (dir) => {
    const executor = new WorktreeExecutor(dir);
    // These should NOT throw
    const resolved1 = executor._assertPath('subdir/file.txt');
    assert.ok(resolved1.startsWith(dir), `${resolved1} should start with ${dir}`);

    const resolved2 = executor._assertPath('./another/nested/path');
    assert.ok(resolved2.startsWith(dir));

    // The root itself is allowed
    const resolved3 = executor._assertPath('.');
    assert.equal(resolved3, dir);
  });
});

test('WorktreeExecutor.readFile blocks out-of-boundary paths', async () => {
  await withTempDir(async (dir) => {
    const executor = new WorktreeExecutor(dir);
    const systemPath = process.platform === 'win32'
      ? 'C:\\Windows\\System32\\notepad.exe'
      : '/etc/passwd';
    await assert.rejects(
      () => executor.readFile(systemPath),
      IsolationViolationError,
      'readFile must block system paths'
    );
  });
});

test('WorktreeExecutor.writeFile blocks out-of-boundary paths', async () => {
  await withTempDir(async (dir) => {
    const executor = new WorktreeExecutor(dir);
    await assert.rejects(
      () => executor.writeFile('../escape.txt', 'malicious content'),
      IsolationViolationError,
      'writeFile must block path escape attempts'
    );
  });
});

test('WorktreeExecutor.readFile allows in-boundary paths', async () => {
  await withTempDir(async (dir) => {
    const executor = new WorktreeExecutor(dir);
    const testFile = path.join(dir, 'test.txt');
    await writeFile(testFile, 'hello sandbox');

    const content = await executor.readFile('test.txt', 'utf8');
    assert.equal(content, 'hello sandbox');
  });
});

test('WorktreeExecutor.writeFile allows in-boundary paths', async () => {
  await withTempDir(async (dir) => {
    const executor = new WorktreeExecutor(dir);
    await executor.writeFile('output.txt', 'safe content', 'utf8');

    const { readFile: fsRead } = await import('node:fs/promises');
    const content = await fsRead(path.join(dir, 'output.txt'), 'utf8');
    assert.equal(content, 'safe content');
  });
});

// ── 4. PassthroughExecutor (no isolation) ───────────────────────────────────

test('PassthroughExecutor.readFile passes through without path validation', async () => {
  await withTempDir(async (dir) => {
    const executor = new PassthroughExecutor();
    const testFile = path.join(dir, 'passthrough.txt');
    await writeFile(testFile, 'passthrough ok');

    // Absolute path outside any sandbox — PassthroughExecutor allows it
    const content = await executor.readFile(testFile, 'utf8');
    assert.equal(content, 'passthrough ok');
  });
});

// ── 5. createSandbox factory ─────────────────────────────────────────────────

test('createSandbox returns PassthroughExecutor when disabled', () => {
  const executor = createSandbox({ enabled: false }, '/some/root');
  assert.ok(executor instanceof PassthroughExecutor);
});

test('createSandbox returns PassthroughExecutor when config is null', () => {
  const executor = createSandbox(null, '/some/root');
  assert.ok(executor instanceof PassthroughExecutor);
});

test('createSandbox returns WorktreeExecutor when enabled', async () => {
  await withTempDir(async (dir) => {
    const executor = createSandbox({ enabled: true, path: dir });
    assert.ok(executor instanceof WorktreeExecutor);
    assert.equal(executor.sandboxRoot, path.resolve(dir));
  });
});

test('createSandbox WorktreeExecutor uses fallbackRoot when path is not set', async () => {
  await withTempDir(async (dir) => {
    const executor = createSandbox({ enabled: true }, dir);
    assert.ok(executor instanceof WorktreeExecutor);
    assert.equal(executor.sandboxRoot, path.resolve(dir));
  });
});

// ── 6. Tenant malicious config simulation (successSignal) ────────────────────

test('WorktreeExecutor blocks simulated malicious tenant reading system files', async () => {
  await withTempDir(async (dir) => {
    // Simulate a tenant config that tries to read /etc/passwd (or Windows equivalent)
    const maliciousConfig = {
      enabled: true,
      path: dir,  // tenant is sandboxed to their worktree
    };
    const executor = createSandbox(maliciousConfig, dir);

    const systemTarget = process.platform === 'win32'
      ? 'C:\\Windows\\System32\\notepad.exe'
      : '/etc/passwd';

    let caught = null;
    try {
      await executor.readFile(systemTarget);
    } catch (err) {
      caught = err;
    }

    assert.ok(caught !== null, 'Expected an error to be thrown');
    assert.ok(
      caught instanceof IsolationViolationError,
      `Expected IsolationViolationError, got: ${caught?.constructor?.name}`
    );
    assert.ok(
      caught.message.includes('Operation blocked: path is outside worktree'),
      `Error message must include isolation phrase, got: ${caught.message}`
    );
    // Verify no host file was accessed (the error was thrown BEFORE any I/O)
    assert.equal(caught.code, 'SANDBOX_ISOLATION_VIOLATION');
  });
});
