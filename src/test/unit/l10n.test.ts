/*
 * Copyright (c) 2026 Herdr Collie Authors
 * Licensed under the MIT License.
 */
import { expect } from 'chai';
import * as path from 'path';
import * as fs from 'fs';
import * as l10n from '@vscode/l10n';

describe('Localization (l10n) Unit Tests', () => {
    const projectRoot = path.resolve(__dirname, '../../../');
    const packageJsonPath = path.join(projectRoot, 'package.json');
    const nlsEnPath = path.join(projectRoot, 'package.nls.json');
    const nlsJaPath = path.join(projectRoot, 'package.nls.ja.json');
    const nlsZhPath = path.join(projectRoot, 'package.nls.zh-cn.json');

    const bundleEnPath = path.join(projectRoot, 'l10n', 'bundle.l10n.json');
    const bundleJaPath = path.join(projectRoot, 'l10n', 'bundle.l10n.ja.json');
    const bundleZhPath = path.join(projectRoot, 'l10n', 'bundle.l10n.zh-cn.json');

    const nlsEn = JSON.parse(fs.readFileSync(nlsEnPath, 'utf8'));
    const nlsJa = JSON.parse(fs.readFileSync(nlsJaPath, 'utf8'));
    const nlsZh = JSON.parse(fs.readFileSync(nlsZhPath, 'utf8'));

    const bundleEn = JSON.parse(fs.readFileSync(bundleEnPath, 'utf8'));
    const bundleJa = JSON.parse(fs.readFileSync(bundleJaPath, 'utf8'));
    const bundleZh = JSON.parse(fs.readFileSync(bundleZhPath, 'utf8'));

    afterEach(() => {
        l10n.config({ contents: {} });
    });

    describe('Package Manifest Localization Parity (package.nls.*.json)', () => {
        it('should have 100% key parity between English and Japanese manifest NLS files', () => {
            const enKeys = Object.keys(nlsEn).sort();
            const jaKeys = Object.keys(nlsJa).sort();

            const missingInJa = enKeys.filter(k => !jaKeys.includes(k));
            const extraInJa = jaKeys.filter(k => !enKeys.includes(k));

            expect(missingInJa, `Keys present in en but missing in ja: ${missingInJa.join(', ')}`).to.be.empty;
            expect(extraInJa, `Keys present in ja but extra: ${extraInJa.join(', ')}`).to.be.empty;
        });

        it('should have 100% key parity between English and Chinese manifest NLS files', () => {
            const enKeys = Object.keys(nlsEn).sort();
            const zhKeys = Object.keys(nlsZh).sort();

            const missingInZh = enKeys.filter(k => !zhKeys.includes(k));
            const extraInZh = zhKeys.filter(k => !enKeys.includes(k));

            expect(missingInZh, `Keys present in en but missing in zh-cn: ${missingInZh.join(', ')}`).to.be.empty;
            expect(extraInZh, `Keys present in zh-cn but extra: ${extraInZh.join(', ')}`).to.be.empty;
        });

        it('should contain non-empty translations for all manifest keys', () => {
            for (const [key, value] of Object.entries(nlsEn)) {
                expect(typeof value).to.equal('string');
                expect((value as string).trim().length, `Empty English value for manifest key "${key}"`).to.be.greaterThan(0);
            }
            for (const [key, value] of Object.entries(nlsJa)) {
                expect(typeof value).to.equal('string');
                expect((value as string).trim().length, `Empty Japanese value for manifest key "${key}"`).to.be.greaterThan(0);
            }
            for (const [key, value] of Object.entries(nlsZh)) {
                expect(typeof value).to.equal('string');
                expect((value as string).trim().length, `Empty Chinese value for manifest key "${key}"`).to.be.greaterThan(0);
            }
        });

        it('should ensure all %...% placeholders in package.json exist in package.nls.json', () => {
            const pkgRaw = fs.readFileSync(packageJsonPath, 'utf8');
            const matches = pkgRaw.match(/%[^%]+%/g) || [];
            const referencedKeys = [...new Set(matches.map(m => m.slice(1, -1)))];

            expect(referencedKeys.length).to.be.greaterThan(0);
            for (const refKey of referencedKeys) {
                expect(nlsEn, `Key "%${refKey}%" in package.json must exist in package.nls.json`).to.have.property(refKey);
            }
        });

        it('should ensure package.json displayName and description remain literal strings (Marketplace Protection)', () => {
            const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
            expect(pkg.displayName).to.not.include('%');
            expect(pkg.description).to.not.include('%');
            expect(pkg.displayName).to.equal('Herdr Collie');
            expect(pkg.description).to.equal('Seamless VS Code bridge for Herdr: launch AI agents in Git worktrees, monitor agent status, and share editor context.');
        });

        it('should specify l10n directory in package.json', () => {
            const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
            expect(pkg.l10n).to.equal('./l10n');
        });
    });

    describe('Runtime Localization Bundle Parity (bundle.l10n.*.json)', () => {
        it('should have 100% key parity between English and Japanese runtime bundles', () => {
            const enKeys = Object.keys(bundleEn).sort();
            const jaKeys = Object.keys(bundleJa).sort();

            const missingInJa = enKeys.filter(k => !jaKeys.includes(k));
            const extraInJa = jaKeys.filter(k => !enKeys.includes(k));

            expect(missingInJa, `Keys present in en but missing in ja: ${missingInJa.join(', ')}`).to.be.empty;
            expect(extraInJa, `Keys present in ja but extra: ${extraInJa.join(', ')}`).to.be.empty;
        });

        it('should have 100% key parity between English and Chinese runtime bundles', () => {
            const enKeys = Object.keys(bundleEn).sort();
            const zhKeys = Object.keys(bundleZh).sort();

            const missingInZh = enKeys.filter(k => !zhKeys.includes(k));
            const extraInZh = zhKeys.filter(k => !enKeys.includes(k));

            expect(missingInZh, `Keys present in en but missing in zh-cn: ${missingInZh.join(', ')}`).to.be.empty;
            expect(extraInZh, `Keys present in zh-cn but extra: ${extraInZh.join(', ')}`).to.be.empty;
        });

        it('should contain non-empty translations for all runtime keys', () => {
            for (const [key, value] of Object.entries(bundleEn)) {
                expect(typeof value).to.equal('string');
                expect((value as string).trim().length, `Empty English value for key "${key}"`).to.be.greaterThan(0);
            }
            for (const [key, value] of Object.entries(bundleJa)) {
                expect(typeof value).to.equal('string');
                expect((value as string).trim().length, `Empty Japanese value for key "${key}"`).to.be.greaterThan(0);
            }
            for (const [key, value] of Object.entries(bundleZh)) {
                expect(typeof value).to.equal('string');
                expect((value as string).trim().length, `Empty Chinese value for key "${key}"`).to.be.greaterThan(0);
            }
        });

        it('should preserve placeholder tokens ({0}, {1}, etc.) across translations', () => {
            for (const [key, enVal] of Object.entries(bundleEn)) {
                const placeholderMatches = (enVal as string).match(/\{\d+\}/g) || [];
                const jaVal = bundleJa[key] as string;
                const zhVal = bundleZh[key] as string;

                for (const ph of placeholderMatches) {
                    expect(jaVal, `Japanese translation for "${key}" should contain placeholder ${ph}`).to.include(ph);
                    expect(zhVal, `Chinese translation for "${key}" should contain placeholder ${ph}`).to.include(ph);
                }
            }
        });
    });

    describe('Runtime Translation and Interpolation (@vscode/l10n)', () => {
        it('returns default English message when no bundle is configured', () => {
            l10n.config({ contents: {} });
            const translated = l10n.t('Approve (y)');
            expect(translated).to.equal('Approve (y)');
        });

        it('interpolates arguments into English fallback message', () => {
            l10n.config({ contents: {} });
            const translated = l10n.t('Session "{0}" deleted.', 'backend');
            expect(translated).to.equal('Session "backend" deleted.');
        });

        it('loads Japanese bundle and translates with argument interpolation', () => {
            l10n.config({ contents: bundleJa });
            expect(l10n.t('Approve (y)')).to.equal('承認 (y)');
            expect(l10n.t('Deny (n)')).to.equal('拒否 (n)');
            expect(l10n.t('Session "{0}" deleted.', 'backend')).to.equal('セッション「backend」を削除しました。');
            expect(l10n.t('Failed to send: {0}', 'socket error')).to.equal('送信に失敗しました: socket error');
        });

        it('loads Simplified Chinese bundle and translates with argument interpolation', () => {
            l10n.config({ contents: bundleZh });
            expect(l10n.t('Approve (y)')).to.equal('批准 (y)');
            expect(l10n.t('Deny (n)')).to.equal('拒绝 (n)');
            expect(l10n.t('Session "{0}" deleted.', 'backend')).to.equal('会话 "backend" 已删除。');
            expect(l10n.t('Failed to send: {0}', 'socket error')).to.equal('发送失败: socket error');
        });
    });
});
