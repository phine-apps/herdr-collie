/*
 * Copyright (c) 2026 Herdr Collie Authors
 * Licensed under the MIT License.
 */
import { expect } from 'chai';
import { 
    parseWorkspaces, 
    parseAgents, 
    parsePanes,
    parseSnapshotWorkspaces,
    parseSnapshotAgents,
    parseSessions,
    parseGitWorktrees
} from '../../parsers';

describe('parsers Unit Tests', () => {
    describe('parsePanes', () => {
        it('returns empty array on invalid json', () => {
            expect(parsePanes('invalid json')).to.deep.equal([]);
        });

        it('parses valid panes list correctly', () => {
            const raw = JSON.stringify({
                result: {
                    panes: [
                        {
                            pane_id: 'pane-1',
                            name: 'bash',
                            command: 'npm run dev',
                            workspace_id: 'ws-100',
                            foreground_cwd: '/home/user/project'
                        }
                    ]
                }
            });

            const result = parsePanes(raw);
            expect(result).to.have.lengthOf(1);
            expect(result[0]).to.deep.equal({
                id: 'pane-1',
                name: 'bash',
                command: 'npm run dev',
                workspaceId: 'ws-100',
                cwd: '/home/user/project'
            });
        });
    });

    describe('parseWorkspaces', () => {
        it('returns empty array on invalid json', () => {
            expect(parseWorkspaces('invalid json')).to.deep.equal([]);
        });

        it('parses workspaces and resolves labels and cwds from panes', () => {
            const raw = JSON.stringify({
                result: {
                    workspaces: [
                        {
                            workspace_id: 'ws-1',
                            label: 'Custom Label',
                            focused: true
                        },
                        {
                            workspace_id: 'ws-2',
                            focused: false
                        },
                        {
                            workspace_id: 'ws-3',
                            focused: false
                        }
                    ]
                }
            });

            const panes = [
                {
                    id: 'p-1',
                    name: 'p1',
                    command: '',
                    workspaceId: 'ws-2',
                    cwd: '/Users/test/my-app'
                },
                {
                    id: 'p-2',
                    name: 'p2',
                    command: '',
                    workspaceId: 'ws-3',
                    cwd: '/Users/test'
                }
            ];

            const result = parseWorkspaces(raw, panes, '/Users/test');
            expect(result).to.have.lengthOf(3);
            
            // Item 1 has explicit label
            expect(result[0].id).to.equal('ws-1');
            expect(result[0].label).to.equal('Custom Label');
            expect(result[0].focused).to.be.true;

            // Item 2 resolves directory basename
            expect(result[1].id).to.equal('ws-2');
            expect(result[1].label).to.equal('my-app');
            expect(result[1].cwd).to.equal('/Users/test/my-app');

            // Item 3 matches homedir -> '~'
            expect(result[2].id).to.equal('ws-3');
            expect(result[2].label).to.equal('~');
        });
    });

    describe('parseAgents', () => {
        it('returns empty array on invalid json', () => {
            expect(parseAgents('invalid json')).to.deep.equal([]);
        });

        it('parses agents and assigns correct status icons', () => {
            const raw = JSON.stringify({
                result: {
                    agents: [
                        {
                            id: 'agent-1',
                            name: 'Code Reviewer',
                            status: 'running'
                        },
                        {
                            id: 'agent-2',
                            name: 'Architect',
                            status: 'idle'
                        },
                        {
                            id: 'agent-3',
                            name: 'Fixer',
                            status: 'blocked'
                        }
                    ]
                }
            });

            const result = parseAgents(raw);
            expect(result).to.have.lengthOf(3);
            expect(result[0].id).to.equal('agent-1');
            expect(result[0].status).to.equal('running');
            expect(result[0].statusType).to.equal('working');
            expect(result[0].statusIcon).to.equal('🟢');
            expect(result[0].isWorking).to.be.true;
            expect(result[0].isBlocked).to.be.false;

            expect(result[1].id).to.equal('agent-2');
            expect(result[1].status).to.equal('idle');
            expect(result[1].statusType).to.equal('idle');
            expect(result[1].statusIcon).to.equal('🟡');
            expect(result[1].isWorking).to.be.false;
            expect(result[1].isBlocked).to.be.false;

            expect(result[2].id).to.equal('agent-3');
            expect(result[2].status).to.equal('blocked');
            expect(result[2].statusType).to.equal('blocked');
            expect(result[2].statusIcon).to.equal('🔴');
            expect(result[2].isWorking).to.be.false;
            expect(result[2].isBlocked).to.be.true;
        });

        it('parses real Herdr agent format with pane_id and agent_status', () => {
            const raw = JSON.stringify({
                result: {
                    agents: [
                        {
                            pane_id: 'w1:p2',
                            agent: 'agy',
                            agent_status: 'working'
                        },
                        {
                            pane_id: 'w1:p3',
                            agent: 'claude',
                            agent_status: 'done'
                        },
                        {
                            pane_id: 'w1:p4',
                            agent: 'copilot',
                            agent_status: 'waiting'
                        }
                    ]
                }
            });

            const result = parseAgents(raw);
            expect(result).to.have.lengthOf(3);
            expect(result[0].id).to.equal('w1:p2');
            expect(result[0].name).to.equal('agy');
            expect(result[0].status).to.equal('working');
            expect(result[0].statusType).to.equal('working');
            expect(result[0].statusIcon).to.equal('🟢');
            expect(result[0].isWorking).to.be.true;

            expect(result[1].id).to.equal('w1:p3');
            expect(result[1].name).to.equal('claude');
            expect(result[1].status).to.equal('done');
            expect(result[1].statusType).to.equal('done');
            expect(result[1].statusIcon).to.equal('⚪');
            expect(result[1].isWorking).to.be.false;

            expect(result[2].id).to.equal('w1:p4');
            expect(result[2].name).to.equal('copilot');
            expect(result[2].status).to.equal('waiting');
            expect(result[2].statusType).to.equal('blocked');
            expect(result[2].statusIcon).to.equal('🔴');
            expect(result[2].isBlocked).to.be.true;
        });

        it('resolves workspaceLabel and workspaceCwd from provided workspaces array', () => {
            const raw = JSON.stringify({
                result: {
                    agents: [
                        { pane_id: 'w1:p1', name: 'claude', agent_status: 'working' },
                        { pane_id: 'w2:p1', name: 'cursor-agent', agent_status: 'idle' }
                    ]
                }
            });

            const workspaces = [
                { id: 'w1', label: '🌲 feat/auth', cwd: '/app/wt-auth', focused: true },
                { id: 'w2', label: 'api-server', cwd: '/app/api', focused: false }
            ];

            const result = parseAgents(raw, workspaces);
            expect(result).to.have.lengthOf(2);
            expect(result[0].workspaceId).to.equal('w1');
            expect(result[0].workspaceLabel).to.equal('🌲 feat/auth');
            expect(result[0].workspaceCwd).to.equal('/app/wt-auth');

            expect(result[1].workspaceId).to.equal('w2');
            expect(result[1].workspaceLabel).to.equal('api-server');
            expect(result[1].workspaceCwd).to.equal('/app/api');
        });
    });

    describe('parseSnapshotWorkspaces', () => {
        it('returns empty array for null/undefined snapshot', () => {
            expect(parseSnapshotWorkspaces(null)).to.deep.equal([]);
            expect(parseSnapshotWorkspaces({})).to.deep.equal([]);
        });

        it('parses structured snapshot workspaces and resolves focus & cwd', () => {
            const snapshot = {
                focused_workspace_id: 'ws-snap-1',
                workspaces: [
                    { workspace_id: 'ws-snap-1', label: 'Primary' },
                    { workspace_id: 'ws-snap-2' }
                ],
                panes: [
                    { workspace_id: 'ws-snap-2', foreground_cwd: '/Users/test/api' }
                ]
            };

            const result = parseSnapshotWorkspaces(snapshot, '/Users/test');
            expect(result).to.have.lengthOf(2);
            expect(result[0].id).to.equal('ws-snap-1');
            expect(result[0].label).to.equal('Primary');
            expect(result[0].focused).to.be.true;

            expect(result[1].id).to.equal('ws-snap-2');
            expect(result[1].label).to.equal('api');
            expect(result[1].cwd).to.equal('/Users/test/api');
            expect(result[1].focused).to.be.false;
        });
    });

    describe('parseSnapshotAgents', () => {
        it('returns empty array for null snapshot', () => {
            expect(parseSnapshotAgents(null)).to.deep.equal([]);
        });

        it('parses agents from snapshot.agents', () => {
            const snapshot = {
                agents: [
                    { id: 'ag-1', name: 'Tester', status: 'working' }
                ]
            };
            const result = parseSnapshotAgents(snapshot);
            expect(result).to.have.lengthOf(1);
            expect(result[0].id).to.equal('ag-1');
            expect(result[0].isWorking).to.be.true;
            expect(result[0].statusIcon).to.equal('🟢');
        });

        it('parses real Herdr snapshot agents with pane_id and agent_status', () => {
            const snapshot = {
                agents: [
                    {
                        agent: 'agy',
                        agent_status: 'working',
                        pane_id: 'w1:p2',
                        workspace_id: 'w1'
                    }
                ]
            };
            const result = parseSnapshotAgents(snapshot);
            expect(result).to.have.lengthOf(1);
            expect(result[0].id).to.equal('w1:p2');
            expect(result[0].name).to.equal('agy');
            expect(result[0].status).to.equal('working');
            expect(result[0].statusIcon).to.equal('🟢');
            expect(result[0].isWorking).to.be.true;
        });

        it('extracts agents from panes when snapshot.agents is empty', () => {
            const snapshot = {
                agents: [],
                panes: [
                    { pane_id: 'p-1', name: 'Worker', agent_status: 'idle' },
                    { pane_id: 'p-2', agent_status: 'unknown' }
                ]
            };
            const result = parseSnapshotAgents(snapshot);
            expect(result).to.have.lengthOf(1);
            expect(result[0].id).to.equal('p-1');
            expect(result[0].status).to.equal('idle');
            expect(result[0].statusIcon).to.equal('🟡');
        });

        it('resolves workspaceLabel and workspaceCwd in snapshot agents from snapshot.workspaces', () => {
            const snapshot = {
                workspaces: [
                    { workspace_id: 'w1', label: 'frontend-app' },
                    { workspace_id: 'w2', label: '🌲 fix/auth' }
                ],
                agents: [
                    { pane_id: 'w1:p1', agent: 'claude', agent_status: 'working' },
                    { pane_id: 'w2:p1', agent: 'cursor-agent', agent_status: 'idle' }
                ]
            };

            const result = parseSnapshotAgents(snapshot);
            expect(result).to.have.lengthOf(2);
            expect(result[0].workspaceId).to.equal('w1');
            expect(result[0].workspaceLabel).to.equal('frontend-app');
            expect(result[1].workspaceId).to.equal('w2');
            expect(result[1].workspaceLabel).to.equal('🌲 fix/auth');
        });
    });

    describe('parseSessions', () => {
        it('returns empty array on invalid json', () => {
            expect(parseSessions('invalid json')).to.deep.equal([]);
        });

        it('parses session list correctly', () => {
            const raw = JSON.stringify({
                sessions: [
                    {
                        name: 'default',
                        default: true,
                        running: true,
                        session_dir: '/home/user/.config/herdr',
                        socket_path: '/home/user/.config/herdr/herdr.sock'
                    },
                    {
                        name: 'vscode',
                        default: false,
                        running: true,
                        session_dir: '/home/user/.config/herdr/sessions/vscode',
                        socket_path: '/home/user/.config/herdr/sessions/vscode/herdr.sock'
                    }
                ]
            });

            const result = parseSessions(raw);
            expect(result).to.have.lengthOf(2);
            expect(result[0].name).to.equal('default');
            expect(result[0].isDefault).to.be.true;
            expect(result[0].running).to.be.true;
            expect(result[1].name).to.equal('vscode');
            expect(result[1].isDefault).to.be.false;
            expect(result[1].running).to.be.true;
        });
    });

    describe('parseGitWorktrees', () => {
        it('returns empty array on empty string', () => {
            expect(parseGitWorktrees('')).to.deep.equal([]);
            expect(parseGitWorktrees('   ')).to.deep.equal([]);
        });

        it('parses porcelain worktree output correctly', () => {
            const raw = `worktree /path/to/herdr-collie
HEAD a1b2c3d4e5f6
branch refs/heads/main

worktree /path/to/herdr-collie-feat-auth
HEAD 123456789abc
branch refs/heads/feat/auth
locked

worktree /path/to/herdr-collie-detached
HEAD 987654321def
detached
`;

            const result = parseGitWorktrees(raw);
            expect(result).to.have.lengthOf(3);
            expect(result[0]).to.deep.equal({
                worktree: '/path/to/herdr-collie',
                head: 'a1b2c3d4e5f6',
                branch: 'main'
            });
            expect(result[1]).to.deep.equal({
                worktree: '/path/to/herdr-collie-feat-auth',
                head: '123456789abc',
                branch: 'feat/auth',
                locked: true
            });
            expect(result[2]).to.deep.equal({
                worktree: '/path/to/herdr-collie-detached',
                head: '987654321def',
                detached: true
            });
        });
    });
});


