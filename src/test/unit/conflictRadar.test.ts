/*
 * Copyright (c) 2026 Herdr Collie Authors
 * Licensed under the MIT License.
 */
import '../helpers/mockVscode'; // Must be first to install global mock
import { mockState, resetMockState, mockVscode } from '../helpers/mockVscode';
import { expect } from 'chai';
import {
    detectOverlappingFileTouches,
    formatConflictRadarWarningPrompt,
    normalizeRepoRelativePath,
    WorktreeConflictRadar
} from '../../conflictRadar';

describe('conflictRadar Unit Tests', () => {
    beforeEach(() => {
        resetMockState();
    });

    describe('normalizeRepoRelativePath & detectOverlappingFileTouches', () => {
        it('normalizes separators and detects files edited across 2+ distinct worktrees', () => {
            const clusters = detectOverlappingFileTouches([
                {
                    worktreePath: '/repo',
                    branchName: 'main',
                    isMain: true,
                    files: [
                        { filePath: './src\\extension.ts', status: 'M', dirty: true },
                        { filePath: 'src/extension.ts', status: 'M', dirty: true },
                        { filePath: 'README.md', status: 'M', dirty: true }
                    ]
                },
                {
                    worktreePath: '/repo-wt-a',
                    branchName: 'feat/auth',
                    isMain: false,
                    agentId: 'ag-1',
                    agentName: 'claude-auth',
                    files: [
                        { filePath: 'src/extension.ts', status: 'M', dirty: true },
                        { filePath: 'src/shared.ts', status: 'M', dirty: false },
                        { filePath: 'src/authOnly.ts', status: 'A', dirty: true }
                    ]
                },
                {
                    worktreePath: '/repo-wt-b',
                    branchName: 'feat/ui',
                    isMain: false,
                    agentId: 'ag-2',
                    agentName: 'codex-ui',
                    files: [
                        { filePath: 'src/shared.ts', status: 'M', dirty: false },
                        { filePath: 'src/uiOnly.ts', status: 'A', dirty: false }
                    ]
                }
            ]);

            expect(clusters).to.have.lengthOf(2);
            // High severity comes first (dirty overlap on main + feat/auth)
            expect(clusters[0].filePath).to.equal('src/extension.ts');
            expect(clusters[0].severity).to.equal('high');
            expect(clusters[0].touches).to.have.lengthOf(2);
            expect(clusters[0].touches.map(t => t.branchName)).to.deep.equal(['main', 'feat/auth']);

            // Committed-only divergence across 2 linked worktrees is medium severity
            expect(clusters[1].filePath).to.equal('src/shared.ts');
            expect(clusters[1].severity).to.equal('medium');
            expect(clusters[1].touches.map(t => t.branchName)).to.deep.equal(['feat/auth', 'feat/ui']);
        });

        it('promotes 3+ worktrees touching a committed file to high severity', () => {
            const clusters = detectOverlappingFileTouches([
                {
                    worktreePath: '/wt-1',
                    branchName: 'feat/1',
                    isMain: false,
                    files: [{ filePath: 'package.json', status: 'M', dirty: false }]
                },
                {
                    worktreePath: '/wt-2',
                    branchName: 'feat/2',
                    isMain: false,
                    files: [{ filePath: 'package.json', status: 'M', dirty: false }]
                },
                {
                    worktreePath: '/wt-3',
                    branchName: 'feat/3',
                    isMain: false,
                    files: [{ filePath: 'package.json', status: 'M', dirty: false }]
                }
            ]);

            expect(clusters).to.have.lengthOf(1);
            expect(clusters[0].severity).to.equal('high');
            expect(clusters[0].touches).to.have.lengthOf(3);
            expect(normalizeRepoRelativePath('/foo\\bar.ts')).to.equal('foo/bar.ts');
        });
    });

    describe('formatConflictRadarWarningPrompt', () => {
        it('formats coordination prompt highlighting target branch and parallel worktrees', () => {
            const prompt = formatConflictRadarWarningPrompt(
                {
                    filePath: 'src/extension.ts',
                    severity: 'high',
                    touches: [
                        {
                            worktreePath: '/repo-wt-a',
                            branchName: 'feat/auth',
                            isMain: false,
                            status: 'M',
                            dirty: true,
                            agentName: 'claude'
                        },
                        {
                            worktreePath: '/repo-wt-b',
                            branchName: 'feat/ui',
                            isMain: false,
                            status: 'M',
                            dirty: false,
                            agentName: 'agy'
                        }
                    ]
                },
                'feat/auth'
            );

            expect(prompt).to.include('`src/extension.ts`');
            expect(prompt).to.include('`feat/auth` **(your branch)** (uncommitted, M, agent: claude)');
            expect(prompt).to.include('`feat/ui` (committed, M, agent: agy)');
            expect(prompt).to.include('Coordination Request');
        });
    });

    describe('WorktreeConflictRadar FileDecorationProvider & Config', () => {
        it('returns compact 2-char FileDecoration badge for overlapping files and disables when configured off', () => {
            const radar = new WorktreeConflictRadar({
                getRepoRoot: async () => '/repo',
                getActiveAgents: () => [],
                dispatchPrompt: async () => true
            });

            try {
                // Inject latest scan result via private state check by triggering applyScanResult equivalent
                (radar as any).applyScanResult({
                    repoRoot: '/repo',
                    worktreeCount: 2,
                    worktreePaths: ['/repo', '/repo-wt-a'],
                    conflicts: [
                        {
                            filePath: 'src/extension.ts',
                            severity: 'high',
                            touches: [
                                { worktreePath: '/repo', branchName: 'main', isMain: true, status: 'M', dirty: true },
                                { worktreePath: '/repo-wt-a', branchName: 'feat/a', isMain: false, status: 'M', dirty: true }
                            ]
                        }
                    ],
                    scannedAt: Date.now()
                }, false);

                const sb = mockState.statusBarItems.find(i => i.id === 'herdr-collie.conflictRadar');
                expect(sb?.visible).to.be.true;
                expect(sb?.text).to.include('Overlap: 1');

                const dec = radar.provideFileDecoration(mockVscode.Uri.file('/repo/src/extension.ts') as any);
                expect(dec).to.exist;
                expect(dec?.badge).to.equal('!2');
                expect(dec?.badge?.length).to.be.at.most(2);
                expect((dec?.color as any)?.id).to.equal('charts.red');
                expect(dec?.propagate).to.be.false;

                // Non-overlapping file returns undefined
                expect(radar.provideFileDecoration(mockVscode.Uri.file('/repo/src/clean.ts') as any)).to.be.undefined;

                // Disabling setting suppresses FileDecoration
                mockState.configurations.set('herdr-collie.worktree.conflictRadar', false);
                expect(radar.provideFileDecoration(mockVscode.Uri.file('/repo/src/extension.ts') as any)).to.be.undefined;
            } finally {
                radar.dispose();
            }
        });
    });
});
