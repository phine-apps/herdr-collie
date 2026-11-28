/*
 * Copyright (c) 2026 Herdr Collie Authors
 * Licensed under the MIT License.
 */
import '../helpers/mockVscode'; // Must be first to install global mock
import { expect } from 'chai';
import cp = require('child_process');
import { resetMockState } from '../helpers/mockVscode';
import {
    getWorktreesForCwds,
    invalidateWorktreeCache,
    getWorktreeQueryCacheSizeForTesting,
    resolveGitContextForUri,
    collectBranchLogSummary
} from '../../gitContext';

describe('gitContext Unit Tests', () => {
    let originalExecFile: any;

    beforeEach(() => {
        resetMockState();
        invalidateWorktreeCache();
        originalExecFile = cp.execFile;
        // Stub git calls to return non-repo quickly so cache tests execute deterministically without disk git calls
        (cp as any).execFile = (_file: string, _args: string[], optionsOrCb?: any, cb?: any) => {
            const callback = typeof optionsOrCb === 'function' ? optionsOrCb : cb;
            if (callback) {
                callback(new Error('not a git repository'), '', 'fatal: not a git repository');
            }
            return {} as any;
        };
    });

    afterEach(() => {
        invalidateWorktreeCache();
        (cp as any).execFile = originalExecFile;
    });

    it('evicts expired worktree cache entries even when invalidateWorktreeCache is not called', async () => {
        await getWorktreesForCwds(['/non-repo/project-a']);
        expect(getWorktreeQueryCacheSizeForTesting()).to.equal(1);

        // Wait past WORKTREE_CACHE_TTL_MS (350ms) and trigger a new lookup without calling invalidateWorktreeCache
        await new Promise(resolve => setTimeout(resolve, 380));
        await getWorktreesForCwds(['/non-repo/project-b']);

        // Expired entry for project-a must be evicted, leaving only project-b
        expect(getWorktreeQueryCacheSizeForTesting()).to.equal(1);
    });

    it('caps worktreeQueryCache size to avoid unbounded growth within the TTL window', async () => {
        for (let i = 0; i < 65; i++) {
            await getWorktreesForCwds([`/non-repo/proj-${i}`]);
        }
        expect(getWorktreeQueryCacheSizeForTesting()).to.be.at.most(50);
    });

    it('ignores non-file URIs (such as untitled:) in resolveGitContextForUri without invoking git', async () => {
        let gitCallCount = 0;
        (cp as any).execFile = (_file: string, _args: string[], optionsOrCb?: any, cb?: any) => {
            gitCallCount++;
            const callback = typeof optionsOrCb === 'function' ? optionsOrCb : cb;
            if (callback) {
                callback(null, '/unexpected/extension-host-cwd\n', '');
            }
            return {} as any;
        };

        const untitledUri = { scheme: 'untitled', fsPath: 'Untitled-1', path: 'Untitled-1' } as any;
        const result = await resolveGitContextForUri(untitledUri);
        expect(result).to.be.null;
        expect(gitCallCount).to.equal(0);
    });

    it('falls back to recent 15 commits in collectBranchLogSummary when neither main nor master exists', async () => {
        const invokedGitArgs: string[][] = [];
        (cp as any).execFile = (_file: string, args: string[], optionsOrCb?: any, cb?: any) => {
            invokedGitArgs.push(args);
            const callback = typeof optionsOrCb === 'function' ? optionsOrCb : cb;
            if (!callback) return {} as any;

            if (args[0] === 'branch' && args[1] === '--show-current') {
                callback(null, 'trunk\n', '');
            } else if (args[0] === 'rev-parse' || args[0] === 'symbolic-ref') {
                callback(new Error('unknown revision'), '', 'fatal: needed a single revision');
            } else if (args[0] === 'log' && args[1] === '-n') {
                callback(null, 'abc1234 Initial commit on trunk\n', '');
            } else {
                callback(new Error(`unexpected git args: ${args.join(' ')}`), '', 'error');
            }
            return {} as any;
        };

        const summary = await collectBranchLogSummary('/repo/trunk-project');
        expect(summary.currentBranch).to.equal('trunk');
        expect(summary.logOut).to.include('abc1234 Initial commit on trunk');
        expect(invokedGitArgs.some(a => a[0] === 'log' && String(a[1]).includes('master..HEAD'))).to.be.false;
    });
});
