/**
 * Bridges the graph builder to whatever C++ language server is active in VS Code
 * (Microsoft C/C++ IntelliSense, clangd, ...). The language server knows the real
 * compile configuration, so it can find base classes hidden behind macros or
 * includes the built-in parser could not resolve.
 */
import * as vscode from 'vscode';
import { ExternalResolver, SupertypeInfo } from '../core/graphBuilder';
import { BaseSpec, ClassInfo, SourceLoc } from '../core/model';

function withTimeout<T>(p: Thenable<T>, ms: number): Promise<T | undefined> {
    return new Promise(resolve => {
        const timer = setTimeout(() => resolve(undefined), ms);
        Promise.resolve(p).then(
            v => { clearTimeout(timer); resolve(v); },
            () => { clearTimeout(timer); resolve(undefined); },
        );
    });
}

function toLoc(uri: vscode.Uri, range: vscode.Range): SourceLoc {
    return { file: uri.fsPath, line: range.start.line, column: range.start.character };
}

export class LanguageServerResolver implements ExternalResolver {
    constructor(private readonly timeoutMs: number, private readonly log: (msg: string) => void) {}

    async findDefinition(base: BaseSpec): Promise<SourceLoc | undefined> {
        if (!base.loc) return undefined;
        const uri = vscode.Uri.file(base.loc.file);
        const pos = new vscode.Position(base.loc.line, base.loc.column);
        const result = await withTimeout(
            vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>('vscode.executeDefinitionProvider', uri, pos),
            this.timeoutMs,
        );
        const first = result?.[0];
        if (!first) return undefined;
        const loc = 'targetUri' in first
            ? toLoc(first.targetUri, first.targetSelectionRange ?? first.targetRange)
            : toLoc(first.uri, first.range);
        this.log(`Language server: ${base.name} -> ${loc.file}:${loc.line + 1}`);
        return loc;
    }

    /**
     * Supertypes via the type hierarchy API. Returns undefined when no provider is
     * registered (e.g. Microsoft C/C++ does not implement it, clangd does).
     */
    async supertypes(cls: ClassInfo): Promise<SupertypeInfo[] | undefined> {
        const uri = vscode.Uri.file(cls.loc.file);
        const pos = new vscode.Position(cls.loc.line, cls.loc.column);
        const items = await withTimeout(
            vscode.commands.executeCommand<vscode.TypeHierarchyItem[]>('vscode.prepareTypeHierarchy', uri, pos),
            this.timeoutMs,
        );
        if (!items || !items.length) return undefined;
        const supers = await withTimeout(
            vscode.commands.executeCommand<vscode.TypeHierarchyItem[]>('vscode.provideSupertypes', items[0]),
            this.timeoutMs,
        );
        if (!supers) return undefined;
        return supers.map(s => ({
            name: s.detail && !s.name.includes('::') ? `${s.detail.replace(/\s.*$/, '')}::${s.name}`.replace(/^::/, '') : s.name,
            loc: toLoc(s.uri, s.selectionRange),
        }));
    }
}
