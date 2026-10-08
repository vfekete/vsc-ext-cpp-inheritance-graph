import * as crypto from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';
import { GraphModel } from '../core/model';
import { PngExport } from './pngExport';

export const VIEW_TYPE = 'cppInheritanceGraph';

export interface PanelTarget {
    target: string;
    mode: 'file' | 'folder';
}

export interface WebviewSettings {
    navigateOn: 'doubleClick' | 'click';
    showMembers: 'all' | 'public' | 'none';
    direction: 'TB' | 'LR';
    standalone: 'namespace' | 'folder' | 'inline' | 'hidden';
    relations: string[];
}

type Builder = (target: PanelTarget, token: vscode.CancellationToken, onPartial?: (g: GraphModel) => void) => Promise<GraphModel>;

/** One webview panel per file / folder. */
export class GraphPanel {
    private static readonly panels = new Map<string, GraphPanel>();
    private cts: vscode.CancellationTokenSource | undefined;
    private ready = false;
    private pending: unknown[] = [];
    private disposables: vscode.Disposable[] = [];
    private pngExport: PngExport | undefined;

    static show(extensionUri: vscode.Uri, target: PanelTarget, builder: Builder, settings: () => WebviewSettings): GraphPanel {
        const key = `${target.mode}:${target.target}`;
        const existing = GraphPanel.panels.get(key);
        if (existing) {
            existing.panel.reveal(undefined, false);
            void existing.refresh(true);
            return existing;
        }
        const panel = vscode.window.createWebviewPanel(
            VIEW_TYPE,
            GraphPanel.titleFor(target),
            { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
            GraphPanel.webviewOptions(extensionUri),
        );
        const gp = new GraphPanel(panel, extensionUri, target, builder, settings);
        void gp.refresh(false);
        return gp;
    }

    /** Re-create a panel after VS Code restarts (WebviewPanelSerializer). */
    static revive(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, target: PanelTarget, builder: Builder, settings: () => WebviewSettings): GraphPanel {
        panel.webview.options = GraphPanel.webviewOptions(extensionUri);
        const gp = new GraphPanel(panel, extensionUri, target, builder, settings);
        void gp.refresh(true);
        return gp;
    }

    static webviewOptions(extensionUri: vscode.Uri): vscode.WebviewPanelOptions & vscode.WebviewOptions {
        return {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
        };
    }

    static titleFor(t: PanelTarget): string {
        return `Inheritance: ${path.basename(t.target)}${t.mode === 'folder' ? '/' : ''}`;
    }

    static refreshAll(): void {
        for (const p of GraphPanel.panels.values()) void p.refresh(true);
    }

    private constructor(
        private readonly panel: vscode.WebviewPanel,
        private readonly extensionUri: vscode.Uri,
        private readonly target: PanelTarget,
        private readonly builder: Builder,
        private readonly settings: () => WebviewSettings,
    ) {
        GraphPanel.panels.set(`${target.mode}:${target.target}`, this);
        panel.webview.html = this.html();
        panel.onDidDispose(() => this.dispose(), null, this.disposables);
        panel.webview.onDidReceiveMessage(m => this.onMessage(m), null, this.disposables);
    }

    private post(msg: unknown): void {
        if (this.ready) void this.panel.webview.postMessage(msg);
        else this.pending.push(msg);
    }

    async refresh(preserveView: boolean): Promise<void> {
        this.cts?.cancel();
        const cts = new vscode.CancellationTokenSource();
        this.cts = cts;
        this.post({ type: 'loading', text: `Analyzing ${path.basename(this.target.target)}…` });
        try {
            const graph = await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Window, title: `C++ inheritance: ${path.basename(this.target.target)}` },
                () => this.builder(this.target, cts.token, partial => {
                    this.post({ type: 'graph', graph: partial, settings: this.settings(), preserveView, partial: true });
                    preserveView = true;
                }),
            );
            if (cts.token.isCancellationRequested) return;
            this.post({ type: 'graph', graph, settings: this.settings(), preserveView });
        } catch (e) {
            if (cts.token.isCancellationRequested) return;
            this.post({ type: 'error', message: `Failed to build the inheritance graph:\n${(e as Error).message}` });
        }
    }

    private async onMessage(msg: any): Promise<void> {
        switch (msg?.type) {
            case 'ready':
                this.ready = true;
                for (const m of this.pending.splice(0)) void this.panel.webview.postMessage(m);
                break;
            case 'refresh':
                await this.refresh(true);
                break;
            case 'navigate':
                await this.navigate(msg.file, msg.line, msg.column, !!msg.preserveFocus);
                break;
            case 'exportRequest': {
                if (this.pngExport) {
                    void vscode.window.showInformationMessage('A PNG export is already running.');
                    this.post({ type: 'exportCancel' });
                    break;
                }
                const ws = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(this.target.target));
                const dir = ws?.uri.fsPath ?? (this.target.mode === 'folder' ? this.target.target : path.dirname(this.target.target));
                const exp = await PngExport.start(msg, dir, m => this.post(m), () => { this.pngExport = undefined; });
                if (exp) this.pngExport = exp;
                else this.post({ type: 'exportCancel' });
                break;
            }
            case 'exportStrip':
                await this.pngExport?.strip(msg);
                break;
            case 'exportDone':
                await this.pngExport?.done();
                break;
            case 'exportError':
                this.pngExport?.fail(String(msg.message));
                break;
        }
    }

    private async navigate(file: string, line: number, column: number, preserveFocus: boolean): Promise<void> {
        try {
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
            const pos = new vscode.Position(line, column);
            // Prefer a visible editor column other than the graph's.
            const graphColumn = this.panel.viewColumn;
            const other = vscode.window.visibleTextEditors.find(e => e.viewColumn !== undefined && e.viewColumn !== graphColumn);
            const viewColumn = other?.viewColumn ?? (graphColumn === vscode.ViewColumn.One ? vscode.ViewColumn.Beside : vscode.ViewColumn.One);
            const editor = await vscode.window.showTextDocument(doc, { viewColumn, preserveFocus, selection: new vscode.Range(pos, pos) });
            const wordRange = doc.getWordRangeAtPosition(pos, /[~A-Za-z_][A-Za-z0-9_]*/);
            if (wordRange) editor.selection = new vscode.Selection(wordRange.start, wordRange.end);
            editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
        } catch (e) {
            void vscode.window.showErrorMessage(`Cannot open ${file}: ${(e as Error).message}`);
        }
    }

    private dispose(): void {
        this.cts?.cancel();
        this.pngExport?.cancel();
        GraphPanel.panels.delete(`${this.target.mode}:${this.target.target}`);
        this.disposables.forEach(d => d.dispose());
    }

    private html(): string {
        const webview = this.panel.webview;
        const media = (f: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', f));
        const nonce = crypto.randomBytes(16).toString('base64');
        const csp = [
            `default-src 'none'`,
            `img-src ${webview.cspSource} data: blob:`,
            `style-src ${webview.cspSource} 'unsafe-inline'`,
            `font-src ${webview.cspSource}`,
            `script-src 'nonce-${nonce}'`,
        ].join('; ');
        return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${media('graph.css')}">
<title>C++ Inheritance Graph</title>
</head>
<body>
<div id="app">
  <div id="toolbar" role="toolbar" aria-label="Graph tools">
    <span class="title" id="title">…</span>
    <button id="fit" title="Fit graph to view (F)">⤢ Fit</button>
    <button id="zoomOut" class="icon" title="Zoom out (-)" aria-label="Zoom out">−</button>
    <button id="zoomIn" class="icon" title="Zoom in (+)" aria-label="Zoom in">+</button>
    <button id="zoomReset" title="Actual size (0)">1:1</button>
    <span class="sep"></span>
    <label class="inline">Layout
      <select id="direction" title="Layout direction: base classes on top, or on the left">
        <option value="TB">Top-down</option>
        <option value="LR">Left-right</option>
      </select>
    </label>
    <label class="inline">Members
      <select id="members" title="Which members to show">
        <option value="all">All</option>
        <option value="public">Public</option>
        <option value="none">Hidden</option>
      </select>
    </label>
    <label class="inline">Highlight
      <select id="highlight" title="What to highlight when a class is selected: direct parents and related classes, all ancestors, or ancestors and descendants (lineage)">
        <option value="parents">Direct</option>
        <option value="ancestors">Ancestors</option>
        <option value="lineage">Lineage</option>
      </select>
    </label>
    <label class="inline">Standalone
      <select id="standalone" title="Classes without any inheritance relation">
        <option value="namespace">By namespace</option>
        <option value="folder">By folder</option>
        <option value="inline">Grid</option>
        <option value="hidden">Hidden</option>
      </select>
    </label>
    <span class="menu-wrap">
      <button id="relationsBtn" aria-haspopup="true" aria-expanded="false" title="Choose which UML relationships to show">Relations ▾</button>
      <div id="relationsMenu" class="menu" hidden role="group" aria-label="Relationships to show">
        <label><input type="checkbox" data-rel="inheritance"><svg class="sample rel-generalization" width="46" height="14"><path class="s-line" d="M2,7 H32"/><path class="s-head" d="M32,2 L42,7 L32,12 Z"/></svg><span>Inheritance</span><span class="count" data-count="inheritance"></span></label>
        <label><input type="checkbox" data-rel="realization"><svg class="sample rel-realization" width="46" height="14"><path class="s-line" d="M2,7 H32"/><path class="s-head" d="M32,2 L42,7 L32,12 Z"/></svg><span>Realization <small>(interface)</small></span><span class="count" data-count="realization"></span></label>
        <label><input type="checkbox" data-rel="composition"><svg class="sample rel-composition" width="46" height="14"><path class="s-head filled" d="M2,7 L10,3 L18,7 L10,11 Z"/><path class="s-line" d="M18,7 H44"/></svg><span>Composition <small>(owns)</small></span><span class="count" data-count="composition"></span></label>
        <label><input type="checkbox" data-rel="aggregation"><svg class="sample rel-aggregation" width="46" height="14"><path class="s-head" d="M2,7 L10,3 L18,7 L10,11 Z"/><path class="s-line" d="M18,7 H44"/></svg><span>Aggregation <small>(shares)</small></span><span class="count" data-count="aggregation"></span></label>
        <label><input type="checkbox" data-rel="association"><svg class="sample rel-association" width="46" height="14"><path class="s-line" d="M2,7 H42"/><path class="s-head open" d="M34,2 L42,7 L34,12"/></svg><span>Association <small>(refers to)</small></span><span class="count" data-count="association"></span></label>
        <label><input type="checkbox" data-rel="dependency"><svg class="sample rel-dependency" width="46" height="14"><path class="s-line" d="M2,7 H42"/><path class="s-head open" d="M34,2 L42,7 L34,12"/></svg><span>Dependency <small>(uses)</small></span><span class="count" data-count="dependency"></span></label>
        <div class="menu-actions"><button id="relationsAll">All</button><button id="relationsNone">Inheritance only</button></div>
      </div>
    </span>
    <input id="search" type="search" placeholder="Find class (/)" aria-label="Find class">
    <span class="spacer"></span>
    <button id="exportPng" title="Download the visible part of the graph as PNG (use Fit first for the whole graph)">⤓ PNG</button>
    <button id="refresh" title="Re-analyze sources">⟳ Refresh</button>
    <button id="info" class="icon" title="Legend, help and notes" aria-label="Legend and help">ⓘ</button>
  </div>
  <div id="stage">
    <svg id="canvas" tabindex="0" aria-label="Inheritance graph">
      <defs>
        <marker id="m-generalization" viewBox="0 0 14 14" refX="13" refY="7" markerWidth="14" markerHeight="14" markerUnits="userSpaceOnUse" orient="auto"><path d="M1,1 L13,7 L1,13 Z"/></marker>
        <marker id="arrow-parent" viewBox="0 0 14 14" refX="13" refY="7" markerWidth="16" markerHeight="16" markerUnits="userSpaceOnUse" orient="auto"><path d="M1,1 L13,7 L1,13 Z"/></marker>
        <marker id="arrow-child" viewBox="0 0 14 14" refX="13" refY="7" markerWidth="16" markerHeight="16" markerUnits="userSpaceOnUse" orient="auto"><path d="M1,1 L13,7 L1,13 Z"/></marker>
        <marker id="m-realization" viewBox="0 0 14 14" refX="13" refY="7" markerWidth="15" markerHeight="15" markerUnits="userSpaceOnUse" orient="auto"><path d="M1,1 L13,7 L1,13 Z"/></marker>
        <marker id="m-composition" viewBox="0 0 20 12" refX="1" refY="6" markerWidth="20" markerHeight="12" markerUnits="userSpaceOnUse" orient="auto"><path d="M1,6 L10,1 L19,6 L10,11 Z"/></marker>
        <marker id="m-aggregation" viewBox="0 0 20 12" refX="1" refY="6" markerWidth="20" markerHeight="12" markerUnits="userSpaceOnUse" orient="auto"><path d="M1,6 L10,1 L19,6 L10,11 Z"/></marker>
        <marker id="m-association" viewBox="0 0 14 14" refX="13" refY="7" markerWidth="14" markerHeight="14" markerUnits="userSpaceOnUse" orient="auto"><path d="M2,2 L13,7 L2,12"/></marker>
        <marker id="m-dependency" viewBox="0 0 14 14" refX="13" refY="7" markerWidth="14" markerHeight="14" markerUnits="userSpaceOnUse" orient="auto"><path d="M2,2 L13,7 L2,12"/></marker>
      </defs>
      <g id="viewport"><g id="groups"></g><g id="edges"></g><g id="nodes"></g></g>
    </svg>
    <div id="overlay" class="overlay"><div class="spinner"></div>Loading…</div>
    <div id="panel" hidden>
      <div style="display:flex;justify-content:space-between;align-items:center">
        <h3>Legend</h3><button id="closePanel" class="icon" title="Close (Esc)" aria-label="Close">✕</button>
      </div>
      <div class="legend">
        <svg width="54" height="22"><rect x="2" y="2" width="50" height="18" rx="3" style="fill:var(--node-bg);stroke:var(--seed-border);stroke-width:2"/></svg><span>Class defined in the selected file / folder</span>
        <svg width="54" height="22"><rect x="2" y="2" width="50" height="18" rx="3" style="fill:var(--node-bg);stroke:var(--node-border)"/></svg><span>Base class found in the project</span>
        <svg width="54" height="22"><rect x="2" y="2" width="50" height="18" rx="3" style="fill:none;stroke:var(--node-border);stroke-dasharray:5 3"/></svg><span>External / unresolved type – traversal stops here</span>
        <svg width="54" height="22"><path d="M4,11 H50" style="stroke:var(--edge);stroke-width:1.4;stroke-dasharray:6 4"/></svg><span>Virtual inheritance</span>
        <svg width="54" height="22"><path d="M4,11 H50" style="stroke:var(--edge-parent);stroke-width:3"/></svg><span>Edge to a parent of the selected class</span>
        <svg width="54" height="22"><path d="M4,11 H50" style="stroke:var(--edge-child);stroke-width:2.5"/></svg><span>Edge to a derived class (lineage mode)</span>
        <svg width="54" height="22"><path d="M4,11 H50" style="stroke:var(--rel-realization);stroke-width:1.6;stroke-dasharray:7 4"/></svg><span>Realization: implements an interface (all methods pure virtual, no data)</span>
        <svg width="54" height="22"><path d="M4,11 L12,7 L20,11 L12,15 Z" style="fill:var(--rel-composition);stroke:var(--rel-composition)"/><path d="M20,11 H50" style="stroke:var(--rel-composition);stroke-width:1.6"/></svg><span>Composition: member by value, <code>unique_ptr</code>, <code>optional</code>, containers of values</span>
        <svg width="54" height="22"><path d="M4,11 L12,7 L20,11 L12,15 Z" style="fill:var(--bg);stroke:var(--rel-aggregation)"/><path d="M20,11 H50" style="stroke:var(--rel-aggregation);stroke-width:1.6"/></svg><span>Aggregation: <code>shared_ptr</code>, containers of pointers</span>
        <svg width="54" height="22"><path d="M4,11 H50 M42,6 L50,11 L42,16" style="fill:none;stroke:var(--rel-association);stroke-width:1.6"/></svg><span>Association: raw pointer / reference member, <code>weak_ptr</code></span>
        <svg width="54" height="22"><path d="M4,11 H50" style="stroke:var(--rel-dependency);stroke-width:1.6;stroke-dasharray:4 4"/><path d="M42,6 L50,11 L42,16" style="fill:none;stroke:var(--rel-dependency);stroke-width:1.6"/></svg><span>Dependency: used only in method parameters / return types</span>
      </div>
      <h3>Interaction</h3>
      <ul>
        <li><b>Click</b> a class to select it and highlight its parents. With more <b>Relations</b> enabled, its direct counterparts in those relationships (both directions) are highlighted too, in the relationship's colour. Edge labels show the member (<code>+</code>/<code>#</code>/<code>-</code> access) and multiplicity.</li>
        <li><b>Double-click</b> (or <b>Ctrl/Cmd+click</b>) the class title, a method or a field to open its declaration.</li>
        <li><b>Drag</b> to pan, <b>wheel</b> / pinch to zoom. Keys: <code>F</code> fit, <code>+</code>/<code>-</code> zoom, <code>0</code> 1:1, arrows pan, <code>C</code> center selection, <code>Enter</code> open selection, <code>/</code> search.</li>
        <li>The ▾ in a class header hides all its members. The ▾ at the top right of the <b>attributes</b> or <b>methods</b> section collapses just that section to a one-line summary (click the summary to expand it again). <b>Alt+click</b> applies it to that section in all classes.</li>
        <li><b>⤓ PNG</b> saves exactly the visible part of the graph. Press <b>Fit</b> first to save the whole graph. The image is scaled so that the smallest text is at least 11 pt (at 96 DPI). Images larger than 16,384 px on a side ask for confirmation.</li>
        <li>Classes without any inheritance relation are collected in <b>standalone groups</b> (by namespace or folder, see <i>Standalone</i>). Click a group header to expand or collapse it, <b>Alt+click</b> for all groups. Large groups start collapsed; search opens them.</li>
        <li>Member prefixes: <code>+</code> public, <code>#</code> protected, <code>-</code> private; <i>italic</i> = virtual, <u>underlined</u> = static. Members are listed by access (public, protected, private), then alphabetically, with constructors and destructors first.</li>
        <li>The three checkboxes in a class title (<code>+</code>&nbsp;public, <code>#</code>&nbsp;protected, <code>-</code>&nbsp;private, with member counts) show or hide that class's members of that access level. <b>Alt+click</b> applies to all classes. Static members are always shown.</li>
      </ul>
      <h3 id="diagTitle">Notes</h3>
      <ul id="diagList"></ul>
    </div>
  </div>
  <div id="statusbar">
    <span id="status"></span>
    <button id="diagButton" hidden title="Show analysis notes"></button>
    <span class="zoom" id="zoom">100%</span>
  </div>
</div>
<script nonce="${nonce}" src="${media('layout.js')}"></script>
<script nonce="${nonce}" src="${media('graph.js')}"></script>
</body>
</html>`;
    }
}
