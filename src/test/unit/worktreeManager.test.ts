/*
 * Copyright (c) 2026 Herdr Collie Authors
 * Licensed under the MIT License.
 */
import { expect } from 'chai';
import * as path from 'path';
import * as cp from 'child_process';
import { 
    sanitizeBranchSlug, 
    resolveWorktreePath,
    getInstalledAgentOptions,
    SUPPORTED_AGENT_DEFINITIONS,
    quoteForShell,
    buildAgentLaunchCommand,
    validateBranchName
} from '../../worktreeManager';

describe('worktreeManager Unit Tests', () => {
    let originalExecFile: any;

    beforeEach(() => {
        originalExecFile = cp.execFile;
    });

    afterEach(() => {
        (cp as any).execFile = originalExecFile;
    });

    describe('quoteForShell', () => {
        it('quotes empty strings correctly', () => {
            expect(quoteForShell('')).to.equal("''");
        });

        it('wraps standard strings in single quotes', () => {
            expect(quoteForShell('hello world')).to.equal("'hello world'");
        });

        it('escapes embedded single quotes properly', () => {
            expect(quoteForShell("don't stop")).to.equal("'don'\\''t stop'");
        });

        it('preserves newlines and special shell characters literally', () => {
            const complex = 'Line 1\nLine 2 with $VAR and `backticks` and "quotes"';
            expect(quoteForShell(complex)).to.equal("'Line 1\nLine 2 with $VAR and `backticks` and \"quotes\"'");
        });
    });

    describe('buildAgentLaunchCommand', () => {
        it('returns empty string if agentCmd is empty (shell default)', () => {
            expect(buildAgentLaunchCommand('', 'Some prompt')).to.equal('');
        });

        it('returns bare agent command when no prompt is provided', () => {
            expect(buildAgentLaunchCommand('cursor-agent')).to.equal('cursor-agent');
            expect(buildAgentLaunchCommand('claude', '  ')).to.equal('claude');
        });

        it('appends safely quoted prompt to the agent command', () => {
            const cmd = buildAgentLaunchCommand('cursor-agent', 'Fix bug in auth service');
            expect(cmd).to.equal("cursor-agent 'Fix bug in auth service'");
        });

        it('handles custom commands with flags and prompts containing quotes', () => {
            const cmd = buildAgentLaunchCommand('claude --dangerously-skip-permissions', "It's working!");
            expect(cmd).to.equal("claude --dangerously-skip-permissions 'It'\\''s working!'");
        });

        it('normalizes embedded newlines in prompt to spaces to prevent terminal shell breakout', () => {
            const cmd = buildAgentLaunchCommand('claude', 'Line 1\nLine 2\r\nLine 3');
            expect(cmd).to.equal("claude 'Line 1 Line 2 Line 3'");
        });
    });

    describe('sanitizeBranchSlug', () => {
        it('replaces forward slashes and special characters with hyphens', () => {
            expect(sanitizeBranchSlug('feature/login-page')).to.equal('feature-login-page');
            expect(sanitizeBranchSlug('fix/issue#42/sub_task')).to.equal('fix-issue#42-sub_task');
            expect(sanitizeBranchSlug('feat///test///branch')).to.equal('feat-test-branch');
        });

        it('trims leading and trailing hyphens', () => {
            expect(sanitizeBranchSlug('/feature/branch/')).to.equal('feature-branch');
        });
    });

    describe('resolveWorktreePath', () => {
        it('resolves sibling directory path when location preference is sibling', () => {
            const repoRoot = path.join('/Users', 'test', 'apps', 'my-repo');
            const resolved = resolveWorktreePath(repoRoot, 'feat/auth-service', 'sibling');
            expect(resolved).to.equal(path.join('/Users', 'test', 'apps', 'my-repo-feat-auth-service'));
        });

        it('resolves .worktrees subfolder path when location preference is .worktrees', () => {
            const repoRoot = path.join('/Users', 'test', 'apps', 'my-repo');
            const resolved = resolveWorktreePath(repoRoot, 'feat/auth-service', '.worktrees');
            expect(resolved).to.equal(path.join('/Users', 'test', 'apps', 'my-repo', '.worktrees', 'feat-auth-service'));
        });
    });

    describe('getInstalledAgentOptions', () => {
        it('filters agent list to only installed binaries and always includes shell and custom', async () => {
            // Mock cp.execFile to only return success for 'claude' and 'cursor-agent'
            (cp as any).execFile = (file: string, args: string[], optionsOrCallback?: any, callback?: any) => {
                const cb = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;
                const binary = (args && args.length > 0) ? args[0] : file;
                if (binary === 'claude' || binary === 'cursor-agent') {
                    cb(null, '/usr/local/bin/' + binary, '');
                } else {
                    cb(new Error('not found'), '', '');
                }
                return {} as any;
            };

            const options = await getInstalledAgentOptions();
            const commands = options.map(o => o.cmd);

            expect(commands).to.include('claude');
            expect(commands).to.include('cursor-agent');
            expect(commands).to.not.include('agy');
            expect(commands).to.not.include('codex');
            expect(commands).to.not.include('devin');

            // Must always contain default shell and custom
            expect(commands).to.include('');
            expect(commands).to.include('CUSTOM');
        });
    });

    describe('validateBranchName', () => {
        it('returns error if branch name is empty or only whitespace', () => {
            expect(validateBranchName('')).to.equal('Branch name cannot be empty');
            expect(validateBranchName('   ')).to.equal('Branch name cannot be empty');
        });

        it('returns error if branch name starts with hyphen to prevent option injection', () => {
            expect(validateBranchName('-b')).to.equal('Branch name cannot start with a hyphen (-)');
            expect(validateBranchName('--output=evil')).to.equal('Branch name cannot start with a hyphen (-)');
        });

        it('returns error if branch name contains spaces', () => {
            expect(validateBranchName('feat branch')).to.equal('Branch name cannot contain spaces');
        });

        it('returns error if branch name contains invalid git ref characters', () => {
            expect(validateBranchName('feat..branch')).to.equal('Branch name contains invalid Git ref characters');
            expect(validateBranchName('feat~1')).to.equal('Branch name contains invalid Git ref characters');
            expect(validateBranchName('feat^1')).to.equal('Branch name contains invalid Git ref characters');
            expect(validateBranchName('feat:branch')).to.equal('Branch name contains invalid Git ref characters');
            expect(validateBranchName('feat?branch')).to.equal('Branch name contains invalid Git ref characters');
            expect(validateBranchName('feat*branch')).to.equal('Branch name contains invalid Git ref characters');
            expect(validateBranchName('feat[branch')).to.equal('Branch name contains invalid Git ref characters');
            expect(validateBranchName('feat@{1}')).to.equal('Branch name contains invalid Git ref characters');
        });

        it('returns null for valid branch names', () => {
            expect(validateBranchName('feat/user-auth')).to.be.null;
            expect(validateBranchName('fix/issue_42')).to.be.null;
            expect(validateBranchName('main')).to.be.null;
            expect(validateBranchName('release-1.0.0')).to.be.null;
        });
    });
});
