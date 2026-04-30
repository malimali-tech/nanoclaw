import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { makePathGuard } from './path-guard.js';
import { GROUPS_DIR } from '../config.js';

const ALICE = 'alice_test';
const BOB = 'bob_test';

describe('path-guard', () => {
  const aliceDir = path.join(GROUPS_DIR, ALICE);
  const bobDir = path.join(GROUPS_DIR, BOB);
  const globalDir = path.join(GROUPS_DIR, 'global');

  beforeEach(() => {
    fs.mkdirSync(aliceDir, { recursive: true });
    fs.mkdirSync(bobDir, { recursive: true });
    fs.mkdirSync(globalDir, { recursive: true });
    fs.writeFileSync(path.join(aliceDir, 'notes.md'), 'alice');
    fs.writeFileSync(path.join(bobDir, 'notes.md'), 'bob');
    fs.writeFileSync(path.join(globalDir, 'shared.md'), 'shared');
  });

  afterEach(() => {
    fs.rmSync(aliceDir, { recursive: true, force: true });
    fs.rmSync(bobDir, { recursive: true, force: true });
  });

  it('allows reads inside own group folder', () => {
    const guard = makePathGuard(ALICE, false);
    expect(() => guard.assertReadable('notes.md')).not.toThrow();
    expect(() =>
      guard.assertReadable(path.join(aliceDir, 'notes.md')),
    ).not.toThrow();
  });

  it('blocks reads of sibling group folders', () => {
    const guard = makePathGuard(ALICE, false);
    expect(() => guard.assertReadable(path.join(bobDir, 'notes.md'))).toThrow(
      /outside chat workspace/,
    );
  });

  it('blocks reads of host-level secrets via absolute path', () => {
    const guard = makePathGuard(ALICE, false);
    expect(() => guard.assertReadable('/etc/passwd')).toThrow(
      /outside chat workspace/,
    );
    expect(() =>
      guard.assertReadable(`${process.env.HOME}/.ssh/id_rsa`),
    ).toThrow(/outside chat workspace/);
  });

  it('blocks .. traversal', () => {
    const guard = makePathGuard(ALICE, false);
    expect(() => guard.assertReadable(`../${BOB}/notes.md`)).toThrow(
      /outside chat workspace/,
    );
  });

  it('non-main can read global but not write to it', () => {
    const guard = makePathGuard(ALICE, false);
    expect(() =>
      guard.assertReadable(path.join(globalDir, 'shared.md')),
    ).not.toThrow();
    expect(() =>
      guard.assertWritable(path.join(globalDir, 'shared.md')),
    ).toThrow(/read-only/);
  });

  it('main can write to global', () => {
    const guard = makePathGuard('main', true);
    fs.mkdirSync(path.join(GROUPS_DIR, 'main'), { recursive: true });
    expect(() =>
      guard.assertWritable(path.join(globalDir, 'shared.md')),
    ).not.toThrow();
    fs.rmSync(path.join(GROUPS_DIR, 'main'), { recursive: true, force: true });
  });

  it('main can read project root but not write to it', () => {
    const mainDir = path.join(GROUPS_DIR, 'main');
    fs.mkdirSync(mainDir, { recursive: true });
    const guard = makePathGuard('main', true);
    expect(() => guard.assertReadable('package.json')).not.toThrow();
    expect(() =>
      guard.assertReadable(path.join(process.cwd(), 'package.json')),
    ).not.toThrow();
    expect(() =>
      guard.assertWritable(path.join(process.cwd(), 'package.json')),
    ).toThrow(/read-only/);
    fs.rmSync(mainDir, { recursive: true, force: true });
  });

  it('writes to not-yet-existing files inside workspace pass', () => {
    const guard = makePathGuard(ALICE, false);
    expect(() => guard.assertWritable('subdir/new.md')).not.toThrow();
  });
});
