import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';

describe('Keybindings & Command Configuration in package.json', () => {
    let pkg: any;

    before(() => {
        const pkgPath = path.resolve(__dirname, '../../../package.json');
        const content = fs.readFileSync(pkgPath, 'utf8');
        pkg = JSON.parse(content);
    });

    it('should have selectAgent and selectWorkspace commands registered', () => {
        const commandIds = pkg.contributes.commands.map((c: any) => c.command);
        expect(commandIds).to.include('herdr-collie.selectAgent');
        expect(commandIds).to.include('herdr-collie.selectWorkspace');
        expect(commandIds).to.include('herdr-collie.sendContext');
        expect(commandIds).to.include('herdr-collie.attachWorkspace');
        expect(commandIds).to.include('herdr-collie.showAgentHUD');
    });

    it('should define keybindings with 2-stroke ctrl+alt+h prefix chords', () => {
        const keybindings = pkg.contributes.keybindings;
        expect(keybindings).to.be.an('array');

        const shortcutMap: { [cmd: string]: string } = {};
        const macMap: { [cmd: string]: string } = {};
        keybindings.forEach((kb: any) => {
            shortcutMap[kb.command] = kb.key;
            macMap[kb.command] = kb.mac;
        });

        expect(shortcutMap['herdr-collie.sendContext']).to.equal('ctrl+alt+h s');
        expect(shortcutMap['herdr-collie.selectAgent']).to.equal('ctrl+alt+h a');
        expect(shortcutMap['herdr-collie.selectWorkspace']).to.equal('ctrl+alt+h w');
        expect(shortcutMap['herdr-collie.attachWorkspace']).to.equal('ctrl+alt+h t');
        expect(shortcutMap['herdr-collie.sendDiagnostics']).to.equal('ctrl+alt+h d');
        expect(shortcutMap['herdr-collie.showAgentHUD']).to.equal('ctrl+alt+h h');
        expect(shortcutMap['herdr-collie.launchWorktreeAgent']).to.equal('ctrl+alt+h l');

        expect(macMap['herdr-collie.selectAgent']).to.equal('ctrl+alt+h a');
        expect(macMap['herdr-collie.selectWorkspace']).to.equal('ctrl+alt+h w');
    });

    it('should NOT include mergeWorktree in keybindings', () => {
        const keybindings = pkg.contributes.keybindings;
        const mergeKb = keybindings.find((kb: any) => kb.command === 'herdr-collie.mergeWorktree');
        expect(mergeKb).to.be.undefined;
    });

    it('should set editorTextFocus condition for editor-scoped commands', () => {
        const keybindings = pkg.contributes.keybindings;
        const sendContextKb = keybindings.find((kb: any) => kb.command === 'herdr-collie.sendContext');
        const sendDiagnosticsKb = keybindings.find((kb: any) => kb.command === 'herdr-collie.sendDiagnostics');

        expect(sendContextKb?.when).to.equal('editorTextFocus');
        expect(sendDiagnosticsKb?.when).to.equal('editorTextFocus');
    });
});
