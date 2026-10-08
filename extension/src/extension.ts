import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { findExecutable } from './core/clangUml';
import { buildGraph } from './core/graphBuilder';
import { GraphModel } from './core/model';
import { clearPreprocessorCache, TextOverlay } from './core/preprocessor';
import { GraphSettings, prepareBuild } from './core/request';
import { GraphPanel, PanelTarget, VIEW_TYPE, WebviewSettings } from './vscode/graphPanel';
import { LanguageServerResolver } from './vscode/languageServerResolver';

let output: vscode.OutputChannel;

function log(msg: string): void {
    output.appendLine(`[${new Date().toLocaleTimeString()}] ${msg}`);
}

function readSettings(scope?: vscode.Uri): GraphSettings & { lsEnabled: boolean; lsTimeout: number } {
    const c = vscode.workspace.getConfiguration('cppInheritanceGraph', scope);
    const cpp = vscode.workspace.getConfiguration('C_Cpp.default', scope);
    const asArray = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === 'string' && v ? [v] : []);
    return {
        headerExtensions: c.get('headerExtensions', ['.h', '.hpp']),
        folderRecursive: c.get('folder.recursive', true),
        traversalScope: c.get('traversalScope', 'workspace'),
        additionalScopeRoots: c.get('additionalScopeRoots', []),
        includePaths: c.get('includePaths', []),
        defines: c.get('defines', []),
        compileCommands: c.get('compileCommands', ''),
        fuzzyIncludeResolution: c.get('fuzzyIncludeResolution', true),
        externalNamespaces: c.get('externalNamespaces', ['std']),
        maxDepth: c.get('maxDepth', 64),
        clangUmlMode: c.get('clangUml.mode', 'auto'),
        clangUmlPath: c.get('clangUml.path', 'clang-uml'),
        clangUmlTimeoutMs: c.get('clangUml.timeoutMs', 120000),
        clangUmlExtraArgs: c.get('clangUml.extraArgs', []),
        cppStandard: c.get('cppStandard', ''),
        cppToolsDefaultIncludePath: asArray(cpp.get('includePath')),
        cppToolsDefaultDefines: asArray(cpp.get('defines')),
        cppToolsCompileCommands: asArray(cpp.get('compileCommands')),
        lsEnabled: c.get('languageServer.enabled', true),
        lsTimeout: c.get('languageServer.timeoutMs', 4000),
    };
}

function webviewSettings(): WebviewSettings {
    const c = vscode.workspace.getConfiguration('cppInheritanceGraph');
    return {
        navigateOn: c.get('navigateOn', 'doubleClick'),
        showMembers: c.get('showMembers', 'all'),
        direction: c.get('layoutDirection', 'TB'),
        standalone: c.get('standaloneClasses', 'namespace'),
        relations: c.get('relations', ['inheritance']),
    };
}

/** Unsaved editor contents, so the graph reflects what the user sees. */
function dirtyOverlay(): TextOverlay {
    const overlay: TextOverlay = new Map();
    for (const doc of vscode.workspace.textDocuments) {
        if (doc.isDirty && doc.uri.scheme === 'file') overlay.set(doc.uri.fsPath, doc.getText());
    }
    return overlay;
}

async function build(target: PanelTarget, token: vscode.CancellationToken, onPartial?: (g: GraphModel) => void): Promise<GraphModel> {
    const uri = vscode.Uri.file(target.target);
    const settings = readSettings(uri);
    const folders = (vscode.workspace.workspaceFolders ?? []).filter(f => f.uri.scheme === 'file').map(f => f.uri.fsPath);
    const opts = prepareBuild(target.target, target.mode, folders, settings);
    opts.overlay = dirtyOverlay();
    opts.log = log;
    opts.cancel = token;
    if (settings.lsEnabled) opts.resolver = new LanguageServerResolver(settings.lsTimeout, log);
    log(`Building graph for ${target.mode} ${target.target} (${opts.seedFiles.length} file(s)); ` +
        `include dirs: ${opts.includeConfig.includeDirs.length} from ${opts.includeConfig.sources.join(', ') || 'none'}; ` +
        `scope: ${opts.scopeRoots.join(', ')}`);
    if (onPartial && opts.clangUml && opts.clangUml.mode !== 'never' && findExecutable(opts.clangUml.executable)) {
        // clang-uml can take a while: show the parser's result first, then refine.
        const quick = await buildGraph({ ...opts, clangUml: { ...opts.clangUml, mode: 'never' }, resolver: undefined, log: undefined });
        if (!token.isCancellationRequested) onPartial(quick);
    }
    const graph = await buildGraph(opts);
    log(`Done: ${graph.nodes.length} nodes, ${graph.edges.length} edges via ${graph.backends.join(' + ')} in ${graph.stats.elapsedMs} ms`);
    graph.diagnostics.forEach(d => log(`  note: ${d}`));
    return graph;
}

function isDirectory(p: string): boolean {
    try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

export function activate(context: vscode.ExtensionContext): void {
    output = vscode.window.createOutputChannel('C++ Inheritance Graph');
    context.subscriptions.push(output);

    const show = (target: PanelTarget) => GraphPanel.show(context.extensionUri, target, build, webviewSettings);

    context.subscriptions.push(
        vscode.commands.registerCommand('cppInheritanceGraph.showForFile', (uri?: vscode.Uri) => {
            const file = uri?.fsPath ?? vscode.window.activeTextEditor?.document.uri.fsPath;
            if (!file) {
                void vscode.window.showWarningMessage('Open a C++ header (or select one in the Explorer) first.');
                return;
            }
            if (isDirectory(file)) show({ target: file, mode: 'folder' });
            else show({ target: file, mode: 'file' });
        }),
        vscode.commands.registerCommand('cppInheritanceGraph.showForFolder', async (uri?: vscode.Uri) => {
            let folder = uri?.fsPath;
            if (!folder) {
                const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: 'Show inheritance graph' });
                folder = picked?.[0]?.fsPath;
            }
            if (!folder) return;
            show({ target: isDirectory(folder) ? folder : path.dirname(folder), mode: 'folder' });
        }),
        vscode.commands.registerCommand('cppInheritanceGraph.clearCache', () => {
            clearPreprocessorCache();
            void vscode.window.showInformationMessage('C++ Inheritance Graph: parser cache cleared.');
        }),
        vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
            async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: any) {
                if (state?.target && (state.mode === 'file' || state.mode === 'folder') && fs.existsSync(state.target)) {
                    GraphPanel.revive(panel, context.extensionUri, { target: state.target, mode: state.mode }, build, webviewSettings);
                } else {
                    panel.dispose();
                }
            },
        }),
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('cppInheritanceGraph')) GraphPanel.refreshAll();
        }),
    );
}

export function deactivate(): void {
    clearPreprocessorCache();
}
