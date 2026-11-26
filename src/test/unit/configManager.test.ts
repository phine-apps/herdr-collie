/*
 * Copyright (c) 2026 Herdr Collie Authors
 * Licensed under the MIT License.
 */
import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as toml from 'smol-toml';
import {
    generateEmbeddedConfigContent,
    getOriginalConfigPath,
    setOriginalConfigPathForTesting,
    reloadConfigForSessions,
    syncHerdrConfig,
    setupConfigManager
} from '../../configManager';

describe('configManager Unit Tests', () => {
    describe('generateEmbeddedConfigContent', () => {
        it('should generate valid TOML with sidebar hidden settings for empty content', () => {
            const result = generateEmbeddedConfigContent('', true);
            const parsed: any = toml.parse(result);
            expect(parsed.ui).to.be.an('object');
            expect(parsed.ui.sidebar_width).to.equal(0);
            expect(parsed.ui.sidebar_min_width).to.equal(0);
            expect(parsed.ui.sidebar_start_collapsed).to.equal(true);
            expect(parsed.ui.sidebar_collapsed_mode).to.equal('hidden');
        });

        it('should preserve other configuration fields while injecting ui sidebar properties', () => {
            const original = `
accent = "cyan"

[session]
resume_agents_on_restore = true

[ui]
mouse_capture = false
accent = "#ffffff"
`;
            const result = generateEmbeddedConfigContent(original, true);
            const parsed: any = toml.parse(result);

            expect(parsed.accent).to.equal('cyan');
            expect(parsed.session.resume_agents_on_restore).to.equal(true);
            expect(parsed.ui.mouse_capture).to.equal(false);
            expect(parsed.ui.accent).to.equal('#ffffff');
            expect(parsed.ui.sidebar_width).to.equal(0);
            expect(parsed.ui.sidebar_min_width).to.equal(0);
            expect(parsed.ui.sidebar_start_collapsed).to.equal(true);
            expect(parsed.ui.sidebar_collapsed_mode).to.equal('hidden');
        });

        it('should override existing sidebar settings', () => {
            const original = `
[ui]
sidebar_width = 26
sidebar_min_width = 18
sidebar_start_collapsed = false
sidebar_collapsed_mode = "compact"
`;
            const result = generateEmbeddedConfigContent(original, true);
            const parsed: any = toml.parse(result);

            expect(parsed.ui.sidebar_width).to.equal(0);
            expect(parsed.ui.sidebar_min_width).to.equal(0);
            expect(parsed.ui.sidebar_start_collapsed).to.equal(true);
            expect(parsed.ui.sidebar_collapsed_mode).to.equal('hidden');
        });

        it('should return original content when hideSidebar is false', () => {
            const original = 'accent = "red"\n';
            const result = generateEmbeddedConfigContent(original, false);
            expect(result).to.equal(original);
        });
    });

    describe('syncHerdrConfig', () => {
        let tempStorageDir: string;
        let tempConfigDir: string;
        let mockContext: any;
        let envVars: Map<string, string>;

        beforeEach(() => {
            tempStorageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collie-storage-test-'));
            tempConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collie-config-test-'));
            envVars = new Map();

            mockContext = {
                globalStorageUri: {
                    fsPath: tempStorageDir
                },
                environmentVariableCollection: {
                    replace: (key: string, val: string) => envVars.set(key, val),
                    delete: (key: string) => envVars.delete(key),
                    get: (key: string) => envVars.get(key)
                },
                subscriptions: []
            };
        });

        afterEach(() => {
            setOriginalConfigPathForTesting(null);
            try {
                fs.rmSync(tempStorageDir, { recursive: true, force: true });
                fs.rmSync(tempConfigDir, { recursive: true, force: true });
            } catch (e) {}
        });

        it('should generate embedded config and set environment variable when original file exists', async () => {
            const originalConfigFile = path.join(tempConfigDir, 'config.toml');
            fs.writeFileSync(originalConfigFile, '[ui]\naccent = "magenta"\n', 'utf8');
            setOriginalConfigPathForTesting(originalConfigFile);

            const embeddedPath = await syncHerdrConfig(mockContext, true);
            expect(embeddedPath).to.be.a('string');
            expect(fs.existsSync(embeddedPath!)).to.be.true;

            const content = fs.readFileSync(embeddedPath!, 'utf8');
            const parsed: any = toml.parse(content);
            expect(parsed.ui.accent).to.equal('magenta');
            expect(parsed.ui.sidebar_start_collapsed).to.equal(true);
            expect(parsed.ui.sidebar_collapsed_mode).to.equal('hidden');

            expect(envVars.get('HERDR_CONFIG_PATH')).to.equal(embeddedPath);
            expect(process.env['HERDR_CONFIG_PATH']).to.equal(embeddedPath);
        });

        it('should generate embedded config even when original config file does not exist', async () => {
            const originalConfigFile = path.join(tempConfigDir, 'non_existent_config.toml');
            setOriginalConfigPathForTesting(originalConfigFile);

            const embeddedPath = await syncHerdrConfig(mockContext, true);
            expect(embeddedPath).to.be.a('string');
            expect(fs.existsSync(embeddedPath!)).to.be.true;

            const content = fs.readFileSync(embeddedPath!, 'utf8');
            const parsed: any = toml.parse(content);
            expect(parsed.ui.sidebar_start_collapsed).to.equal(true);
            expect(parsed.ui.sidebar_collapsed_mode).to.equal('hidden');
        });

        it('should delete environment variable when hideSidebar is false', async () => {
            const originalConfigFile = path.join(tempConfigDir, 'config.toml');
            fs.writeFileSync(originalConfigFile, '[ui]\naccent = "cyan"\n', 'utf8');
            setOriginalConfigPathForTesting(originalConfigFile);

            // First enable it
            await syncHerdrConfig(mockContext, true);
            expect(envVars.get('HERDR_CONFIG_PATH')).to.be.a('string');

            // Then disable it
            const result = await syncHerdrConfig(mockContext, false);
            expect(result).to.be.undefined;
            expect(envVars.has('HERDR_CONFIG_PATH')).to.be.false;
            expect(process.env['HERDR_CONFIG_PATH']).to.be.undefined;
        });

        it('should watch and synchronize file changes on original config file', async () => {
            const originalConfigFile = path.join(tempConfigDir, 'config.toml');
            fs.writeFileSync(originalConfigFile, '[ui]\naccent = "cyan"\n', 'utf8');
            setOriginalConfigPathForTesting(originalConfigFile);

            const disposable = setupConfigManager(mockContext);
            await disposable.ready;

            try {
                // Update original config
                await new Promise(resolve => setTimeout(resolve, 50));
                fs.writeFileSync(originalConfigFile, '[ui]\naccent = "yellow"\n', 'utf8');

                await new Promise(resolve => setTimeout(resolve, 350));
                await disposable.whenIdle();

                const embeddedPath = path.join(tempStorageDir, 'herdr_config_embedded.toml');
                const content = fs.readFileSync(embeddedPath, 'utf8');
                const parsed: any = toml.parse(content);
                expect(parsed.ui.accent).to.equal('yellow');
                expect(parsed.ui.sidebar_start_collapsed).to.equal(true);
                expect(parsed.ui.sidebar_collapsed_mode).to.equal('hidden');
            } finally {
                disposable.dispose();
            }
        });

        it('should notify configured and active custom sessions instead of hardcoding vscode on config reload', async () => {
            const executors = require('../../executors');
            const originalExecHerdr = executors.execHerdr;
            const recordedCalls: string[][] = [];
            executors.execHerdr = (args: string[]) => {
                recordedCalls.push(args);
            };

            try {
                const originalConfigFile = path.join(tempConfigDir, 'config.toml');
                fs.writeFileSync(originalConfigFile, '[ui]\naccent = "cyan"\n', 'utf8');
                setOriginalConfigPathForTesting(originalConfigFile);

                let configChangeListener: ((e: any) => void) | undefined;
                let configuredSession = 'custom-team';
                const mockVscode = {
                    workspace: {
                        getConfiguration: () => ({
                            get: (key: string, def: any) => {
                                if (key === 'hideHerdrSidebar') return true;
                                if (key === 'sessionName') return configuredSession;
                                return def;
                            }
                        }),
                        onDidChangeConfiguration: (listener: (e: any) => void) => {
                            configChangeListener = listener;
                            return { dispose: () => {} };
                        }
                    }
                };

                const disposable = setupConfigManager(mockContext, mockVscode, () => 'sidebar-extra');
                await disposable.ready;
                expect(recordedCalls).to.deep.include(['server', 'reload-config']);
                expect(recordedCalls).to.deep.include(['--session', 'custom-team', 'server', 'reload-config']);
                expect(recordedCalls).to.deep.include(['--session', 'sidebar-extra', 'server', 'reload-config']);
                expect(recordedCalls.some(args => args.includes('vscode'))).to.be.false;

                recordedCalls.length = 0;
                configuredSession = 'renamed-session';
                configChangeListener?.({ affectsConfiguration: (section: string) => section === 'herdr-collie.sessionName' });
                await disposable.whenIdle();
                expect(recordedCalls).to.deep.include(['--session', 'renamed-session', 'server', 'reload-config']);

                disposable.dispose();
            } finally {
                executors.execHerdr = originalExecHerdr;
            }
        });

        it('should serialize concurrent syncHerdrConfig calls without losing the latest state', async () => {
            const originalConfigFile = path.join(tempConfigDir, 'config.toml');
            fs.writeFileSync(originalConfigFile, '[ui]\naccent = "first"\n', 'utf8');
            setOriginalConfigPathForTesting(originalConfigFile);

            const firstSync = syncHerdrConfig(mockContext, true);
            fs.writeFileSync(originalConfigFile, '[ui]\naccent = "second"\n', 'utf8');
            const secondSync = syncHerdrConfig(mockContext, true);

            const [, embeddedPath] = await Promise.all([firstSync, secondSync]);
            const content = fs.readFileSync(embeddedPath!, 'utf8');
            const parsed: any = toml.parse(content);
            expect(parsed.ui.accent).to.equal('second');
        });

        it('reloadConfigForSessions falls back to vscode when omitted and skips duplicate --session default', () => {
            const executors = require('../../executors');
            const originalExecHerdr = executors.execHerdr;
            const recordedCalls: string[][] = [];
            executors.execHerdr = (args: string[]) => {
                recordedCalls.push(args);
            };

            try {
                reloadConfigForSessions();
                expect(recordedCalls).to.deep.equal([
                    ['server', 'reload-config'],
                    ['--session', 'vscode', 'server', 'reload-config']
                ]);

                recordedCalls.length = 0;
                reloadConfigForSessions(['default', 'alpha', 'alpha']);
                expect(recordedCalls).to.deep.equal([
                    ['server', 'reload-config'],
                    ['--session', 'alpha', 'server', 'reload-config']
                ]);
            } finally {
                executors.execHerdr = originalExecHerdr;
            }
        });

        it('keeps watcher state isolated per setupConfigManager handle and handles watcher errors safely', async () => {
            const { EventEmitter } = require('events');
            const fsModule = require('fs');
            const originalWatch = fsModule.watch;
            const watchers: Array<{ targetDir: string; emitter: any; closed: boolean }> = [];

            fsModule.watch = (targetDir: string) => {
                const emitter: any = new EventEmitter();
                const entry = { targetDir, emitter, closed: false };
                emitter.close = () => {
                    entry.closed = true;
                };
                watchers.push(entry);
                return emitter;
            };

            const dir1 = fs.mkdtempSync(path.join(os.tmpdir(), 'collie-watch-1-'));
            const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'collie-watch-2-'));

            try {
                const cfg1 = path.join(dir1, 'config.toml');
                const cfg2 = path.join(dir2, 'config.toml');
                fs.writeFileSync(cfg1, '[ui]\naccent = "cyan"\n', 'utf8');
                fs.writeFileSync(cfg2, '[ui]\naccent = "green"\n', 'utf8');

                setOriginalConfigPathForTesting(cfg1);
                const handle1 = setupConfigManager(mockContext);
                await handle1.ready;

                setOriginalConfigPathForTesting(cfg2);
                const handle2 = setupConfigManager(mockContext);
                await handle2.ready;

                expect(watchers).to.have.lengthOf(2);
                const w1 = watchers.find(w => w.targetDir === dir1)!;
                const w2 = watchers.find(w => w.targetDir === dir2)!;
                expect(w1).to.exist;
                expect(w2).to.exist;

                // Disposing handle1 should only close watcher 1, leaving watcher 2 intact
                handle1.dispose();
                expect(w1.closed).to.be.true;
                expect(w2.closed).to.be.false;

                // Watcher error event must not throw unhandled error and should close watcher 2 cleanly
                w2.emitter.emit('error', new Error('ENOENT: dir removed'));
                expect(w2.closed).to.be.true;

                handle2.dispose();
            } finally {
                fsModule.watch = originalWatch;
                fs.rmSync(dir1, { recursive: true, force: true });
                fs.rmSync(dir2, { recursive: true, force: true });
            }
        });
    });
});
