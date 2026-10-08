/**
 * Builds the inheritance graph for a file or folder:
 *
 *  1. Preprocess + parse the target header(s) together with everything they include
 *     (built-in parser; macros and computed includes are expanded).
 *  2. Optionally merge compiler-accurate data from clang-uml.
 *  3. Starting at the classes defined in the target, walk base classes upwards.
 *     Bases that the index cannot resolve are handed to an external resolver
 *     (the VS Code language server: go-to-definition / type hierarchy); the file it
 *     points to is parsed on demand.
 *  4. Traversal stops at builtin / std (configurable) types, template parameters,
 *     unresolvable names, and classes defined outside the traversal scope.
 */
import * as path from 'path';
import { ClangUmlOptions, runClangUml } from './clangUml';
import { IncludeConfig, IncludeResolver } from './includeConfig';
import { BaseSpec, ClassInfo, GraphEdge, GraphModel, GraphNode, RelationKind, SourceLoc } from './model';
import { isBuiltinType, lastComponent, stripTemplateArgs, trailingTemplateArgs } from './names';
import { AliasInfo, parseTokens } from './parser';
import { isInterface, memberRelations } from './relations';
import { Preprocessor, TextOverlay } from './preprocessor';

export interface SupertypeInfo { name: string; loc?: SourceLoc }

/** Hooks into an IDE / language server. All methods are optional and may return undefined. */
export interface ExternalResolver {
    /** Where is the base class named at `base.loc` defined? */
    findDefinition?(base: BaseSpec, cls: ClassInfo): Promise<SourceLoc | undefined>;
    /** Direct supertypes according to the language server's type hierarchy. */
    supertypes?(cls: ClassInfo): Promise<SupertypeInfo[] | undefined>;
}

export interface CancellationFlag { readonly isCancellationRequested: boolean }

export interface BuildOptions {
    mode: 'file' | 'folder';
    /** The file or folder the graph is requested for. */
    target: string;
    /** Files whose classes are the starting points. */
    seedFiles: string[];
    /** Classes defined under these directories are expanded; others become leaves. */
    scopeRoots: string[];
    includeConfig: IncludeConfig;
    /** Roots searched for headers when an include cannot be resolved through include paths. */
    fuzzyRoots: string[];
    fuzzyIncludes: boolean;
    externalNamespaces: string[];
    maxDepth: number;
    resolver?: ExternalResolver;
    clangUml?: ClangUmlOptions & { mode: 'auto' | 'always' | 'never' };
    overlay?: TextOverlay;
    log?: (msg: string) => void;
    cancel?: CancellationFlag;
}

/** Index of known classes and type aliases with C++-like name lookup. */
export class ClassIndex {
    readonly byId = new Map<string, ClassInfo>();
    readonly aliases = new Map<string, AliasInfo>();
    private byShortName = new Map<string, ClassInfo[]>();

    add(cls: ClassInfo): void {
        if (!cls.id || this.byId.has(cls.id)) return;
        this.byId.set(cls.id, cls);
        const short = lastComponent(cls.id);
        const list = this.byShortName.get(short) ?? [];
        list.push(cls);
        this.byShortName.set(short, list);
    }

    replace(cls: ClassInfo): void {
        const old = this.byId.get(cls.id);
        if (old) {
            const list = this.byShortName.get(lastComponent(cls.id)) ?? [];
            const i = list.indexOf(old);
            if (i >= 0) list[i] = cls;
            this.byId.set(cls.id, cls);
        } else {
            this.add(cls);
        }
    }

    addAlias(a: AliasInfo): void {
        if (!this.aliases.has(a.id)) this.aliases.set(a.id, a);
    }

    /**
     * Look up `name` (template arguments already stripped) as written in `scope`.
     * Returns undefined when nothing matches.
     */
    lookup(name: string, scope: string[], usings: string[] = [], depth = 0): ClassInfo | undefined {
        if (depth > 8 || !name) return undefined;
        const absolute = name.startsWith('::');
        const n = name.replace(/^::/, '');
        const tryId = (id: string): ClassInfo | undefined => {
            const c = this.byId.get(id);
            if (c) return c;
            const a = this.aliases.get(id);
            if (a) {
                const target = stripTemplateArgs(a.target).replace(/^(typename|class|struct)\s+/, '');
                if (target && target !== id) return this.lookup(target, a.scope, a.usingNamespaces, depth + 1);
            }
            // A namespace alias in the first component: `namespace fs = foo::bar; fs::X`
            const first = id.split('::')[0];
            const nsAlias = this.aliases.get(first);
            if (nsAlias && id.includes('::')) {
                return this.lookup(stripTemplateArgs(nsAlias.target) + id.slice(first.length), [], [], depth + 1);
            }
            return undefined;
        };
        if (absolute) return tryId(n);
        for (let i = scope.length; i >= 0; i--) {
            const hit = tryId([...scope.slice(0, i), n].join('::'));
            if (hit) return hit;
        }
        for (const u of usings) {
            for (let i = scope.length; i >= 0; i--) {
                const hit = tryId([...scope.slice(0, i), u, n].join('::'));
                if (hit) return hit;
            }
        }
        // Namespace alias at an inner scope: `namespace ns = ...;` inside a namespace.
        const firstComp = n.split('::')[0];
        for (let i = scope.length; i > 0 && n.includes('::'); i--) {
            const a = this.aliases.get([...scope.slice(0, i), firstComp].join('::'));
            if (a) return this.lookup(stripTemplateArgs(a.target) + n.slice(firstComp.length), [], [], depth + 1);
        }
        return undefined;
    }

    /** Last resort: a unique class whose qualified name ends with `name`, preferring scope proximity. */
    fuzzyLookup(name: string, scope: string[]): ClassInfo | undefined {
        const n = name.replace(/^::/, '');
        const candidates = (this.byShortName.get(lastComponent(n)) ?? []).filter(c => c.id === n || c.id.endsWith('::' + n));
        if (candidates.length <= 1) return candidates[0];
        const score = (c: ClassInfo) => {
            let k = 0;
            while (k < scope.length && k < c.scope.length && scope[k] === c.scope[k]) k++;
            return k;
        };
        candidates.sort((a, b) => score(b) - score(a));
        return score(candidates[0]) > score(candidates[1]) ? candidates[0] : undefined;
    }

    classesInFile(file: string): ClassInfo[] {
        return [...this.byId.values()].filter(c => c.loc.file === file);
    }
}

function isUnder(file: string, root: string): boolean {
    return file === root || file.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

/** Headers that are almost certainly from the standard library / OS and not worth reporting. */
function looksLikeSystemHeader(name: string): boolean {
    const n = name.replace(/^[<"]|[>"]$/g, '');
    if (!/\.[a-z+]+$/i.test(n)) return true; // <vector>, <QtCore/QObject> ...
    return /^(std|sys\/|bits\/|linux\/|asm|windows|win|unistd|pthread|stdio|stdlib|string|math|time|assert|errno|limits|float|signal|setjmp|locale|ctype|wchar|wctype|fcntl|dirent|dlfcn|malloc|memory|intrin|immintrin|xmmintrin|emmintrin|arm_neon)/i.test(n);
}

export class GraphBuilder {
    private readonly index = new ClassIndex();
    private readonly parsedFiles = new Set<string>();
    private readonly diagnostics: string[] = [];
    private readonly backends = new Set<string>(['parser']);
    private readonly nodes = new Map<string, GraphNode>();
    private readonly edges: GraphEdge[] = [];
    private readonly resolver: IncludeResolver;
    private readonly seedFiles: Set<string>;
    private supertypesUnsupported = false;
    private definitionUnsupported = false;
    /** Language-server lookups are slow; cap them so a broken setup cannot stall the build. */
    private lspBudget = 40;
    private lspMisses = 0;

    constructor(private readonly opts: BuildOptions) {
        this.resolver = new IncludeResolver(opts.includeConfig, opts.fuzzyRoots, opts.fuzzyIncludes);
        this.seedFiles = new Set(opts.seedFiles.map(f => path.resolve(f)));
    }

    private log(msg: string): void {
        this.opts.log?.(msg);
    }

    private checkCancelled(): void {
        if (this.opts.cancel?.isCancellationRequested) throw new Error('Cancelled');
    }

    /** Preprocess and parse `files` as one translation unit and add everything to the index. */
    private parseUnit(files: string[]): void {
        const pp = new Preprocessor({
            resolver: this.resolver,
            defines: this.opts.includeConfig.defines,
            overlay: this.opts.overlay,
        });
        const forced = this.opts.includeConfig.forcedIncludes;
        const result = pp.run([...forced, ...files]);
        result.files.forEach(f => this.parsedFiles.add(f));
        const parsed = parseTokens(result.tokens);
        parsed.classes.forEach(c => this.index.add(c));
        parsed.aliases.forEach(a => this.index.addAlias(a));
        let reported = 0;
        for (const [from, names] of result.unresolvedIncludes) {
            const interesting = [...names].filter(n => !looksLikeSystemHeader(n));
            if (!interesting.length) continue;
            if (reported++ < 15) this.diagnostics.push(`Unresolved include ${interesting.join(', ')} in ${from}`);
        }
        this.diagnostics.push(...result.diagnostics.slice(0, 10));
        this.log(`Parsed ${result.files.length} file(s), ${result.tokens.length} tokens, ${parsed.classes.length} class(es)`);
    }

    private async mergeClangUml(): Promise<void> {
        const cu = this.opts.clangUml;
        if (!cu || cu.mode === 'never') return;
        const roots = [...this.opts.scopeRoots, ...this.resolver.userIncludeDirs, ...this.seedFiles].map(p => path.resolve(p));
        try {
            const { classes, diagnostics } = await runClangUml([...this.seedFiles], this.opts.includeConfig, roots, cu, m => this.log(m));
            this.diagnostics.push(...diagnostics);
            let added = 0;
            let updated = 0;
            for (const c of classes) {
                // clang-uml also reports library templates used in project headers (std::function ...).
                if (this.isExternalName(c.id)) continue;
                const existing = this.index.byId.get(c.id);
                if (!existing) {
                    this.index.add(c);
                    added++;
                    continue;
                }
                // clang knows better about bases; keep the parser's base-name locations when names match.
                const bases = c.bases.map((b, i) => {
                    const sameName = existing.bases.find(eb => lastComponent(eb.name) === lastComponent(b.name || '?'));
                    if (!b.name) {
                        // Base outside clang-uml's filter (e.g. std::runtime_error): take the parser's name.
                        const fallback = existing.bases[i];
                        return fallback ? { ...fallback } : { ...b, name: '(external base)' };
                    }
                    return { ...b, loc: sameName?.loc ?? b.loc };
                });
                // clang-uml omits dependent bases (`template <class B> class X : public B`): keep the parser's.
                const dependent = existing.bases.filter(b =>
                    existing.templateParamNames?.includes(stripTemplateArgs(b.name).split('::')[0]));
                const merged: ClassInfo = {
                    ...existing,
                    bases: [...bases, ...dependent.filter(d => !bases.some(b => b.name === d.name))],
                    isAbstract: c.isAbstract ?? existing.isAbstract,
                    members: existing.members.length ? existing.members : c.members,
                    templateParamNames: existing.templateParamNames ?? c.templateParamNames,
                    sources: [...new Set([...existing.sources, 'clang-uml'])],
                };
                this.index.replace(merged);
                updated++;
            }
            this.backends.add('clang-uml');
            this.log(`clang-uml: ${classes.length} class(es), ${added} new, ${updated} merged`);
        } catch (e) {
            const msg = `clang-uml failed: ${(e as Error).message}`;
            this.log(msg);
            if (cu.mode === 'always') throw new Error(msg);
            this.diagnostics.push(msg + ' (falling back to the built-in parser)');
        }
    }

    private inScope(file: string): boolean {
        if (this.seedFiles.has(file)) return true;
        return this.opts.scopeRoots.some(r => isUnder(file, r));
    }

    private isExternalName(name: string): boolean {
        const n = stripTemplateArgs(name).replace(/^::/, '');
        if (isBuiltinType(n)) return true;
        return this.opts.externalNamespaces.some(ns => n === ns || n.startsWith(ns + '::'));
    }

    private addClassNode(cls: ClassInfo, isSeed: boolean): GraphNode {
        let node = this.nodes.get(cls.id);
        if (!node) {
            node = {
                id: cls.id,
                kind: 'class',
                label: cls.name,
                qualifiedName: cls.id,
                isSeed,
                cls,
                loc: cls.loc,
            };
            this.nodes.set(cls.id, node);
        } else if (isSeed) {
            node.isSeed = true;
        }
        return node;
    }

    private addLeaf(id: string, kind: GraphNode['kind'], name: string, reason: string, loc?: SourceLoc): GraphNode {
        let node = this.nodes.get(id);
        if (!node) {
            node = { id, kind, label: lastComponent(name) + (trailingTemplateArgs(name) ?? ''), qualifiedName: name, isSeed: false, reason, loc };
            this.nodes.set(id, node);
        }
        return node;
    }

    /** Find the class defined at (or near) a location, parsing that file if needed. */
    private classAtLocation(loc: SourceLoc, shortName: string): ClassInfo | undefined {
        const file = path.resolve(loc.file);
        if (!this.parsedFiles.has(file)) {
            this.log(`Parsing ${file} (found through the language server)`);
            this.parseUnit([file]);
        }
        const inFile = this.index.classesInFile(file);
        return inFile.find(c => c.loc.line === loc.line && lastComponent(c.id) === shortName)
            ?? inFile.find(c => c.loc.line === loc.line)
            ?? inFile.find(c => lastComponent(c.id) === shortName);
    }

    private async resolveBase(cls: ClassInfo, base: BaseSpec): Promise<GraphNode> {
        const written = base.name.replace(/^(typename|class|struct)\s+/, '').trim();
        const lookupName = stripTemplateArgs(written);
        if (base.resolvedId) {
            const c = this.index.byId.get(base.resolvedId);
            if (c) return this.addClassNode(c, false);
        }
        const firstWord = lookupName.split('::')[0];
        if (cls.templateParamNames?.includes(firstWord)) {
            return this.addLeaf(`tparam:${cls.id}:${written}`, 'templateParam', written, `template parameter of ${cls.id}`);
        }
        const scope = cls.scope;
        const found = this.index.lookup(lookupName, scope, cls.usingNamespaces ?? [])
            ?? (this.isExternalName(lookupName) ? undefined : this.index.fuzzyLookup(lookupName, scope));
        if (found) return this.addClassNode(found, false);

        if (this.isExternalName(lookupName)) {
            return this.addLeaf(`ext:${lookupName}`, 'external', base.resolvedId ?? lookupName, 'external type (stop list)');
        }

        // Definition already reported by the type hierarchy provider.
        if (base.definition) {
            const c = this.classAtLocation(base.definition, lastComponent(lookupName));
            if (c) {
                this.backends.add('type hierarchy');
                return this.addClassNode(c, false);
            }
        }

        // Ask the language server.
        if (this.opts.resolver?.findDefinition && base.loc && !this.definitionUnsupported && this.lspBudget > 0 && this.lspMisses < 8) {
            this.lspBudget--;
            try {
                const loc = await this.opts.resolver.findDefinition(base, cls);
                if (!loc) this.lspMisses++;
                if (loc) {
                    this.lspMisses = 0;
                    const c = this.classAtLocation(loc, lastComponent(lookupName));
                    if (c) {
                        this.backends.add('language server');
                        return this.addClassNode(c, false);
                    }
                    return this.addLeaf(`ext:${lookupName}`, 'external', written, 'defined outside the parsed sources', loc);
                }
            } catch (e) {
                this.log(`Language server lookup failed: ${(e as Error).message}`);
                this.definitionUnsupported = true;
            }
        }
        return this.addLeaf(`unresolved:${lookupName}`, 'unresolved', written, 'definition not found (check include paths)', base.loc);
    }

    /** Add supertypes reported by the language server that the parser did not see. */
    private async augmentFromTypeHierarchy(cls: ClassInfo): Promise<BaseSpec[]> {
        if (!this.opts.resolver?.supertypes || this.supertypesUnsupported) return cls.bases;
        let supers: SupertypeInfo[] | undefined;
        try {
            supers = await this.opts.resolver.supertypes(cls);
        } catch {
            supers = undefined;
        }
        if (supers === undefined) {
            this.supertypesUnsupported = true; // provider not available: do not ask again
            return cls.bases;
        }
        const byShort = new Map(supers.map(s => [lastComponent(s.name), s]));
        // Bases the parser saw: remember where the language server says they are defined.
        const bases = cls.bases.map(b => {
            const s = byShort.get(lastComponent(b.name));
            return s?.loc ? { ...b, definition: s.loc } : b;
        });
        const known = new Set(cls.bases.map(b => lastComponent(b.name)));
        const extra = supers.filter(s => !known.has(lastComponent(s.name)));
        if (extra.length) this.backends.add('type hierarchy');
        return [...bases, ...extra.map(s => ({ name: s.name, access: 'public' as const, isVirtual: false, definition: s.loc }))];
    }

    /** Resolve a type name used inside `cls` to a known class. */
    private resolveUsedClass(name: string, cls: ClassInfo): ClassInfo | undefined {
        const n = stripTemplateArgs(name).replace(/^(struct|class|union)\s+/, '');
        if (!n || this.isExternalName(n)) return undefined;
        if (cls.templateParamNames?.includes(n.split('::')[0])) return undefined;
        // Inside the class, its own nested types are visible.
        const scope = stripTemplateArgs(cls.id).split('::');
        return this.index.lookup(n, scope, cls.usingNamespaces ?? []) ?? this.index.fuzzyLookup(n, scope);
    }

    /**
     * Realization (inheritance from interfaces) and the member-based relationships of every
     * expanded class. Classes only reachable through such a relationship are added as
     * `relationOnly` nodes (one hop, not expanded further).
     */
    private addRelations(): void {
        for (const e of this.edges) {
            const base = this.nodes.get(e.to)?.cls;
            if (base && isInterface(base)) e.kind = 'realization';
        }
        const inherits = new Set(this.edges.map(e => `${e.from}\u0000${e.to}`));
        const sources = [...this.nodes.values()].filter(n => n.kind === 'class' && n.cls && !n.reason);
        const byKey = new Map<string, GraphEdge>();
        const add = (from: ClassInfo, to: ClassInfo, kind: RelationKind, via: string, access: GraphEdge['access'], multiplicity?: string) => {
            const key = `${from.id}\u0000${to.id}\u0000${kind}`;
            const existing = byKey.get(key);
            if (existing) {
                const labels = existing.label ? existing.label.split(', ') : [];
                if (!labels.includes(via)) existing.label = [...labels, via].join(', ');
                if (multiplicity && existing.multiplicity !== multiplicity) existing.multiplicity = '*';
                return;
            }
            if (!this.nodes.has(to.id)) {
                const node = this.addClassNode(to, false);
                node.relationOnly = true;
            }
            byKey.set(key, { kind, from: from.id, to: to.id, access, isVirtual: false, label: via, multiplicity });
        };
        const deps: [ClassInfo, ClassInfo, string, GraphEdge['access']][] = [];
        for (const n of sources) {
            const cls = n.cls!;
            for (const r of memberRelations(cls)) {
                const target = this.resolveUsedClass(r.targetName, cls);
                if (!target) continue;
                if (r.kind === 'dependency') deps.push([cls, target, r.via, r.member.access]);
                else add(cls, target, r.kind, r.via, r.member.access, r.multiplicity);
            }
        }
        // Dependencies only where no stronger relationship (or inheritance) exists, and not on itself.
        const strong = new Set([...byKey.values()].map(e => `${e.from}\u0000${e.to}`));
        for (const [from, to, via, access] of deps) {
            const pair = `${from.id}\u0000${to.id}`;
            if (from.id === to.id || strong.has(pair) || inherits.has(pair)) continue;
            add(from, to, 'dependency', via, access);
        }
        this.edges.push(...byKey.values());
    }

    async build(): Promise<GraphModel> {
        const started = Date.now();
        const seeds = [...this.seedFiles];
        this.parseUnit(seeds);
        this.checkCancelled();
        await this.mergeClangUml();
        this.checkCancelled();

        const seedClasses = [...this.index.byId.values()].filter(c => this.seedFiles.has(c.loc.file));
        if (!seedClasses.length) this.diagnostics.push('No class definitions found in the selected file(s).');
        seedClasses.sort((a, b) => a.loc.file.localeCompare(b.loc.file) || a.loc.line - b.loc.line);

        const visited = new Set<string>();
        let frontier: ClassInfo[] = seedClasses;
        seedClasses.forEach(c => this.addClassNode(c, true));
        for (let depth = 0; frontier.length; depth++) {
            const next: ClassInfo[] = [];
            for (const cls of frontier) {
                this.checkCancelled();
                if (visited.has(cls.id)) continue;
                visited.add(cls.id);
                const node = this.addClassNode(cls, this.seedFiles.has(cls.loc.file));
                if (!this.inScope(cls.loc.file)) {
                    node.reason = 'defined outside the traversal scope';
                    continue;
                }
                if (depth >= this.opts.maxDepth) {
                    node.reason = 'maximum depth reached';
                    continue;
                }
                const bases = await this.augmentFromTypeHierarchy(cls);
                for (const base of bases) {
                    const target = await this.resolveBase(cls, base);
                    if (target.id === cls.id) continue;
                    if (!this.edges.some(e => e.from === cls.id && e.to === target.id)) {
                        this.edges.push({
                            kind: 'generalization',
                            from: cls.id,
                            to: target.id,
                            access: base.access,
                            isVirtual: base.isVirtual,
                            templateArgs: target.kind === 'class' ? trailingTemplateArgs(base.name) : undefined,
                        });
                    }
                    if (target.cls && !visited.has(target.id)) next.push(target.cls);
                }
            }
            frontier = next;
        }
        this.addRelations();

        const name = path.basename(this.opts.target);
        return {
            title: name,
            targetPath: this.opts.target,
            mode: this.opts.mode,
            nodes: [...this.nodes.values()],
            edges: this.edges,
            diagnostics: [...new Set(this.diagnostics)],
            backends: [...this.backends],
            stats: { files: this.parsedFiles.size, classes: this.index.byId.size, elapsedMs: Date.now() - started },
        };
    }
}

export function buildGraph(opts: BuildOptions): Promise<GraphModel> {
    return new GraphBuilder(opts).build();
}
