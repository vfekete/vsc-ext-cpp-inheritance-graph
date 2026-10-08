/**
 * Smoke test of the VS Code integration against a minimal stub of the `vscode` module:
 * activation registers the commands, and showing a graph posts a complete model to the webview.
 */
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { describe, it } from 'node:test';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const Module = require('node:module');

const WS = path.resolve(__dirname, '../../../test/mock');

function makeVscodeStub() {
    const commands = new Map<string, (...a: any[]) => any>();
    const posted: any[] = [];
    let onMessage: ((m: any) => void) | undefined;
    let html = '';
    const disposable = { dispose() {} };
    class Uri {
        constructor(public fsPath: string, public scheme = 'file') {}
        static file(p: string) { return new Uri(p); }
        static joinPath(u: Uri, ...parts: string[]) { return new Uri(path.join(u.fsPath, ...parts)); }
        toString() { return `file://${this.fsPath}`; }
    }
    const stub = {
        Uri,
        ViewColumn: { One: 1, Beside: -2 },
        ProgressLocation: { Window: 10 },
        Position: class { constructor(public line: number, public character: number) {} },
        Range: class { constructor(public start: any, public end: any) {} },
        Selection: class { constructor(public anchor: any, public active: any) {} },
        TextEditorRevealType: { InCenterIfOutsideViewport: 2 },
        CancellationTokenSource: class { token = { isCancellationRequested: false }; cancel() { this.token.isCancellationRequested = true; } },
        window: {
            createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
            createWebviewPanel: () => ({
                webview: {
                    get html() { return html; },
                    set html(v: string) { html = v; },
                    cspSource: 'vscode-resource:',
                    asWebviewUri: (u: Uri) => u.toString(),
                    postMessage: async (m: any) => { posted.push(m); return true; },
                    onDidReceiveMessage: (cb: any) => { onMessage = cb; return disposable; },
                    options: {},
                },
                onDidDispose: () => disposable,
                reveal() {},
                viewColumn: 2,
            }),
            withProgress: (_o: any, task: () => Promise<any>) => task(),
            registerWebviewPanelSerializer: () => disposable,
            showWarningMessage() {}, showErrorMessage() {}, showInformationMessage() {},
            activeTextEditor: undefined,
            visibleTextEditors: [],
        },
        workspace: {
            workspaceFolders: [{ uri: Uri.file(WS) }],
            textDocuments: [],
            // Return defaults, except: no language server and no clang-uml in this test.
            getConfiguration: () => ({ get: (key: string, def: any) => (key === 'languageServer.enabled' ? false : key === 'clangUml.mode' ? 'never' : def) }),
            onDidChangeConfiguration: () => disposable,
        },
        commands: {
            registerCommand: (id: string, fn: any) => { commands.set(id, fn); return disposable; },
            executeCommand: async () => undefined,
        },
    };
    return { stub, commands, posted, getHtml: () => html, send: (m: any) => onMessage?.(m) };
}

describe('extension (stubbed vscode)', () => {
    it('registers commands and renders a graph into the webview', async () => {
        const env = makeVscodeStub();
        const origLoad = Module._load;
        Module._load = function (request: string, ...rest: any[]) {
            if (request === 'vscode') return env.stub;
            return origLoad.call(this, request, ...rest);
        };
        try {
            const ext = require('../src/extension');
            const subscriptions: any[] = [];
            ext.activate({ subscriptions, extensionUri: env.stub.Uri.file(path.resolve(__dirname, '../..')) });
            assert.deepEqual([...env.commands.keys()].sort(), [
                'cppInheritanceGraph.clearCache', 'cppInheritanceGraph.showForFile', 'cppInheritanceGraph.showForFolder',
            ]);
            env.commands.get('cppInheritanceGraph.showForFolder')!(env.stub.Uri.file(path.join(WS, 'include/scene')));
            assert.match(env.getHtml(), /Content-Security-Policy/);
            assert.match(env.getHtml(), /layout\.js/);
            env.send({ type: 'ready' });
            for (let i = 0; i < 100 && !env.posted.some(m => m.type === 'graph'); i++) await new Promise(r => setTimeout(r, 20));
            const msg = env.posted.find(m => m.type === 'graph');
            assert.ok(msg, `graph posted (got ${env.posted.map(m => m.type).join(', ')})`);
            assert.equal(msg.graph.mode, 'folder');
            assert.ok(msg.graph.nodes.some((n: any) => n.id === 'scene::AnimatedCharacterMesh' && n.isSeed));
            assert.equal(msg.settings.navigateOn, 'doubleClick');
        } finally {
            Module._load = origLoad;
        }
    });
});
