/**
 * pathBasename / parentPath — separator-agnostic path segment helpers.
 *
 * The matrix below is the specification: every path shape the renderer is
 * actually fed (posix workspace-relative, native Windows relative, Windows
 * absolute drive paths, mixed-separator joins, trailing-separator directory
 * paths) plus the empty/root sentinels FileEditor relies on.
 */
import { describe, it, expect } from 'vitest';
import { pathBasename, parentPath } from '../pathBasename';

describe('pathBasename', () => {
  it('reads the last segment of a posix relative path', () => {
    expect(pathBasename('src/utils/x.ts')).toBe('x.ts');
  });

  it('reads the last segment of a native Windows relative path', () => {
    expect(pathBasename('src\\utils\\x.ts')).toBe('x.ts');
  });

  it('reads the last segment of a Windows absolute drive path', () => {
    expect(pathBasename('C:\\repo\\src\\x.ts')).toBe('x.ts');
  });

  it('handles mixed separators (renderer-built posix subpath on a native root)', () => {
    expect(pathBasename('C:\\repo\\src/utils\\x.ts')).toBe('x.ts');
    expect(pathBasename('a/b\\c.md')).toBe('c.md');
  });

  it('strips trailing separators, so a directory path yields its own name', () => {
    expect(pathBasename('a/b/')).toBe('b');
    expect(pathBasename('a\\b\\')).toBe('b');
    expect(pathBasename('a/b//')).toBe('b');
  });

  it('reads a drive root as the drive label', () => {
    expect(pathBasename('C:\\')).toBe('C:');
    expect(pathBasename('/')).toBe('');
  });

  it('returns the whole input when it has no separator', () => {
    expect(pathBasename('foo.ts')).toBe('foo.ts');
  });

  it('returns "" for empty and all-separator input', () => {
    expect(pathBasename('')).toBe('');
    expect(pathBasename('///')).toBe('');
    expect(pathBasename('\\\\')).toBe('');
  });
});

describe('parentPath', () => {
  it('returns the posix parent, preserving its separators', () => {
    expect(parentPath('src/utils/x.ts')).toBe('src/utils');
  });

  it('returns the native Windows parent, preserving its separators', () => {
    expect(parentPath('src\\utils\\x.ts')).toBe('src\\utils');
    expect(parentPath('C:\\repo\\src\\x.ts')).toBe('C:\\repo\\src');
  });

  it('strips trailing separators before the split (directory input)', () => {
    expect(parentPath('a/b/')).toBe('a');
    expect(parentPath('C:\\wt\\src\\')).toBe('C:\\wt');
  });

  it('returns "" for a root-level file — the loadFiles("") root sentinel', () => {
    expect(parentPath('foo.ts')).toBe('');
    expect(parentPath('')).toBe('');
    expect(parentPath('/')).toBe('');
    expect(parentPath('///')).toBe('');
  });

  it('returns the drive root as the parent of a top-level drive entry', () => {
    expect(parentPath('C:\\x')).toBe('C:');
  });

  it('handles mixed separators', () => {
    expect(parentPath('C:\\repo\\src/utils/x.ts')).toBe('C:\\repo\\src/utils');
  });
});

describe('round-trip with the FileEditor delete flow', () => {
  it('recomputes the refresh dir for a native-separator path (the fixed bug)', () => {
    // Old code: 'src\\ui\\Button.tsx'.split('/').slice(0, -1).join('/') === ''
    // → reloaded the root and the deleted file lingered in the tree.
    expect(parentPath('src\\ui\\Button.tsx')).toBe('src\\ui');
    expect(parentPath('src/ui/Button.tsx')).toBe('src/ui');
  });
});
