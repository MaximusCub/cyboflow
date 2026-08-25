/**
 * Tests for the cyboflow.workspaceFiles tRPC router — slice 2 of the
 * IPC→tRPC migration (docs/CODE-PATTERNS.md), following the `config` PILOT
 * slice's test conventions. Exercises, for a representative subset of
 * procedures:
 *   (a) delegation to ctx.workspaceFileOps and envelope passthrough (the
 *       router does no re-shaping, including a failure envelope).
 *   (b) zod rejection of malformed input, never reaching ctx.workspaceFileOps.
 *   (c) PRECONDITION_FAILED when ctx.workspaceFileOps is absent.
 */
import { describe, it, expect, vi } from 'vitest';
import { TRPCError } from '@trpc/server';
import { appRouter } from '../../router';
import { createContext } from '../../context';
import type { WorkspaceFileOpsLike } from '../../contracts/workspaceFileOps';

function isPrecond(err: unknown): boolean {
  return err instanceof TRPCError && err.code === 'PRECONDITION_FAILED';
}

function isBadRequest(err: unknown): boolean {
  return err instanceof TRPCError && err.code === 'BAD_REQUEST';
}

function makeFakeOps(): WorkspaceFileOpsLike & {
  read: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  search: ReturnType<typeof vi.fn>;
  readAtRevision: ReturnType<typeof vi.fn>;
  readProject: ReturnType<typeof vi.fn>;
  writeProject: ReturnType<typeof vi.fn>;
  gitCommit: ReturnType<typeof vi.fn>;
  gitRevert: ReturnType<typeof vi.fn>;
  gitRestore: ReturnType<typeof vi.fn>;
  gitExecuteProject: ReturnType<typeof vi.fn>;
} {
  return {
    read: vi.fn().mockResolvedValue({ success: true, content: 'hello' }),
    write: vi.fn().mockResolvedValue({ success: true }),
    list: vi.fn().mockResolvedValue({ success: true, files: [] }),
    delete: vi.fn().mockResolvedValue({ success: true }),
    search: vi.fn().mockResolvedValue({ success: true, files: [] }),
    readAtRevision: vi.fn().mockResolvedValue({ success: true, content: '' }),
    readProject: vi.fn().mockResolvedValue({ success: true, data: null }),
    writeProject: vi.fn().mockResolvedValue({ success: true }),
    gitCommit: vi.fn().mockResolvedValue({ success: true }),
    gitRevert: vi.fn().mockResolvedValue({ success: true }),
    gitRestore: vi.fn().mockResolvedValue({ success: true }),
    gitExecuteProject: vi.fn().mockResolvedValue({ success: true, output: '' }),
  };
}

describe('cyboflow.workspaceFiles', () => {
  // -------------------------------------------------------------------------
  // (a) Delegation + envelope passthrough for a representative subset.
  // -------------------------------------------------------------------------
  describe('(a) delegates to ctx.workspaceFileOps and returns its envelope untouched', () => {
    it('read', async () => {
      const workspaceFileOps = makeFakeOps();
      const caller = appRouter.createCaller(createContext({ workspaceFileOps }));
      const result = await caller.cyboflow.workspaceFiles.read({ sessionId: 's1', filePath: 'a.ts' });
      expect(workspaceFileOps.read).toHaveBeenCalledWith({ sessionId: 's1', filePath: 'a.ts' });
      expect(result).toEqual({ success: true, content: 'hello' });
    });

    it('write', async () => {
      const workspaceFileOps = makeFakeOps();
      const caller = appRouter.createCaller(createContext({ workspaceFileOps }));
      const result = await caller.cyboflow.workspaceFiles.write({
        sessionId: 's1',
        filePath: 'a.ts',
        content: 'new content',
      });
      expect(workspaceFileOps.write).toHaveBeenCalledWith({
        sessionId: 's1',
        filePath: 'a.ts',
        content: 'new content',
      });
      expect(result).toEqual({ success: true });
    });

    it('search', async () => {
      const workspaceFileOps = makeFakeOps();
      const caller = appRouter.createCaller(createContext({ workspaceFileOps }));
      const result = await caller.cyboflow.workspaceFiles.search({ projectId: 1, pattern: 'foo', limit: 10 });
      expect(workspaceFileOps.search).toHaveBeenCalledWith({ projectId: 1, pattern: 'foo', limit: 10 });
      expect(result).toEqual({ success: true, files: [] });
    });

    it('gitExecuteProject', async () => {
      const workspaceFileOps = makeFakeOps();
      const caller = appRouter.createCaller(createContext({ workspaceFileOps }));
      const result = await caller.cyboflow.workspaceFiles.gitExecuteProject({
        projectId: 1,
        args: ['add', '.gitignore'],
      });
      expect(workspaceFileOps.gitExecuteProject).toHaveBeenCalledWith({
        projectId: 1,
        args: ['add', '.gitignore'],
      });
      expect(result).toEqual({ success: true, output: '' });
    });

    it('a failure envelope from ctx.workspaceFileOps also passes through untouched', async () => {
      const workspaceFileOps = makeFakeOps();
      workspaceFileOps.read.mockResolvedValue({ success: false, error: 'boom' });
      const caller = appRouter.createCaller(createContext({ workspaceFileOps }));
      const result = await caller.cyboflow.workspaceFiles.read({ sessionId: 's1', filePath: 'a.ts' });
      expect(result).toEqual({ success: false, error: 'boom' });
    });

    it("search's failure envelope carries files: [] through untouched", async () => {
      const workspaceFileOps = makeFakeOps();
      workspaceFileOps.search.mockResolvedValue({ success: false, error: 'boom', files: [] });
      const caller = appRouter.createCaller(createContext({ workspaceFileOps }));
      const result = await caller.cyboflow.workspaceFiles.search({ projectId: 1, pattern: 'foo' });
      expect(result).toEqual({ success: false, error: 'boom', files: [] });
    });
  });

  // -------------------------------------------------------------------------
  // (b) zod rejection of malformed input, never delegated.
  // -------------------------------------------------------------------------
  describe('(b) rejects malformed input before it reaches workspaceFileOps', () => {
    it('read rejects a missing sessionId', async () => {
      const workspaceFileOps = makeFakeOps();
      const caller = appRouter.createCaller(createContext({ workspaceFileOps }));
      await expect(
        caller.cyboflow.workspaceFiles.read({ filePath: 'a.ts' } as never),
      ).rejects.toSatisfy(isBadRequest);
      expect(workspaceFileOps.read).not.toHaveBeenCalled();
    });

    it('read rejects an empty sessionId (min length 1)', async () => {
      const workspaceFileOps = makeFakeOps();
      const caller = appRouter.createCaller(createContext({ workspaceFileOps }));
      await expect(
        caller.cyboflow.workspaceFiles.read({ sessionId: '', filePath: 'a.ts' }),
      ).rejects.toSatisfy(isBadRequest);
      expect(workspaceFileOps.read).not.toHaveBeenCalled();
    });

    it('gitExecuteProject rejects a non-array args', async () => {
      const workspaceFileOps = makeFakeOps();
      const caller = appRouter.createCaller(createContext({ workspaceFileOps }));
      await expect(
        caller.cyboflow.workspaceFiles.gitExecuteProject({ projectId: 1, args: 'add' as never }),
      ).rejects.toSatisfy(isBadRequest);
      expect(workspaceFileOps.gitExecuteProject).not.toHaveBeenCalled();
    });

    it('gitExecuteProject rejects an empty args array (.min(1))', async () => {
      const workspaceFileOps = makeFakeOps();
      const caller = appRouter.createCaller(createContext({ workspaceFileOps }));
      await expect(
        caller.cyboflow.workspaceFiles.gitExecuteProject({ projectId: 1, args: [] }),
      ).rejects.toSatisfy(isBadRequest);
      expect(workspaceFileOps.gitExecuteProject).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // (c) Missing ctx.workspaceFileOps → PRECONDITION_FAILED.
  // -------------------------------------------------------------------------
  describe('(c) missing ctx.workspaceFileOps → PRECONDITION_FAILED', () => {
    it('read', async () => {
      const caller = appRouter.createCaller(createContext());
      await expect(
        caller.cyboflow.workspaceFiles.read({ sessionId: 's1', filePath: 'a.ts' }),
      ).rejects.toSatisfy(isPrecond);
    });

    it('write', async () => {
      const caller = appRouter.createCaller(createContext());
      await expect(
        caller.cyboflow.workspaceFiles.write({ sessionId: 's1', filePath: 'a.ts', content: 'x' }),
      ).rejects.toSatisfy(isPrecond);
    });

    it('search', async () => {
      const caller = appRouter.createCaller(createContext());
      await expect(
        caller.cyboflow.workspaceFiles.search({ projectId: 1, pattern: 'foo' }),
      ).rejects.toSatisfy(isPrecond);
    });

    it('gitExecuteProject', async () => {
      const caller = appRouter.createCaller(createContext());
      await expect(
        caller.cyboflow.workspaceFiles.gitExecuteProject({ projectId: 1, args: ['add', '.'] }),
      ).rejects.toSatisfy(isPrecond);
    });
  });
});
