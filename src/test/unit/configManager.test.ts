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

        it('should generate embedded config and set environment variable when original file exists', () => {
            const originalConfigFile = path.join(tempConfigDir, 'config.toml');
            fs.writeFileSync(originalConfigFile, '[ui]\naccent = "magenta"\n', 'utf8');
            setOriginalConfigPathForTesting(originalConfigFile);

            const embeddedPath = syncHerdrConfig(mockContext, true);
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

        it('should generate embedded config even when original config file does not exist', () => {
            const originalConfigFile = path.join(tempConfigDir, 'non_existent_config.toml');
            setOriginalConfigPathForTesting(originalConfigFile);

            const embeddedPath = syncHerdrConfig(mockContext, true);
            expect(embeddedPath).to.be.a('string');
            expect(fs.existsSync(embeddedPath!)).to.be.true;

            const content = fs.readFileSync(embeddedPath!, 'utf8');
            const parsed: any = toml.parse(content);
            expect(parsed.ui.sidebar_start_collapsed).to.equal(true);
            expect(parsed.ui.sidebar_collapsed_mode).to.equal('hidden');
        });

        it('should delete environment variable when hideSidebar is false', () => {
            const originalConfigFile = path.join(tempConfigDir, 'config.toml');
            fs.writeFileSync(originalConfigFile, '[ui]\naccent = "cyan"\n', 'utf8');
            setOriginalConfigPathForTesting(originalConfigFile);

            // First enable it
            syncHerdrConfig(mockContext, true);
            expect(envVars.get('HERDR_CONFIG_PATH')).to.be.a('string');

            // Then disable it
            const result = syncHerdrConfig(mockContext, false);
            expect(result).to.be.undefined;
            expect(envVars.has('HERDR_CONFIG_PATH')).to.be.false;
            expect(process.env['HERDR_CONFIG_PATH']).to.be.undefined;
        });

        it('should watch and synchronize file changes on original config file', (done) => {
            const originalConfigFile = path.join(tempConfigDir, 'config.toml');
            fs.writeFileSync(originalConfigFile, '[ui]\naccent = "cyan"\n', 'utf8');
            setOriginalConfigPathForTesting(originalConfigFile);

            const disposable = setupConfigManager(mockContext);

            // Update original config
            setTimeout(() => {
                fs.writeFileSync(originalConfigFile, '[ui]\naccent = "yellow"\n', 'utf8');

                setTimeout(() => {
                    const embeddedPath = path.join(tempStorageDir, 'herdr_config_embedded.toml');
                    const content = fs.readFileSync(embeddedPath, 'utf8');
                    const parsed: any = toml.parse(content);
                    expect(parsed.ui.accent).to.equal('yellow');
                    expect(parsed.ui.sidebar_start_collapsed).to.equal(true);
                    expect(parsed.ui.sidebar_collapsed_mode).to.equal('hidden');

                    disposable.dispose();
                    done();
                }, 350);
            }, 50);
        });
    });
});
