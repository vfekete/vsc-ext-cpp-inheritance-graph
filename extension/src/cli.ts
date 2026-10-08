#!/usr/bin/env node
/**
 * Command line front-end for the graph builder (no VS Code needed).
 *
 *   node out/src/cli.js <file-or-folder> [--root DIR] [--json] [--clang-uml auto|always|never]
 *                       [--scope workspace|includePaths|targetDirectory] [-I DIR]... [-D DEF]...
 */
import * as fs from 'fs';
import * as path from 'path';
import { buildGraph } from './core/graphBuilder';
import { GraphModel } from './core/model';
import { DEFAULT_SETTINGS, GraphSettings, prepareBuild } from './core/request';

function usage(): never {
    console.error('usage: cli <file-or-folder> [--root DIR] [--json] [--clang-uml auto|always|never] [--scope workspace|includePaths|targetDirectory] [-I DIR] [-D DEF] [-v]');
    process.exit(2);
}

function printTree(g: GraphModel): void {
    const byId = new Map(g.nodes.map(n => [n.id, n]));
    const bases = (id: string) => g.edges.filter(e => e.from === id && (e.kind === 'generalization' || e.kind === 'realization'));
    const print = (id: string, indent: string, seen: Set<string>) => {
        for (const e of bases(id)) {
            const n = byId.get(e.to)!;
            const tags = [e.kind === 'realization' ? 'realizes' : '', e.isVirtual ? 'virtual' : '', e.access !== 'public' ? e.access : '', n.kind !== 'class' ? n.kind : '', n.reason ?? ''].filter(Boolean);
            console.log(`${indent}└─ ${n.qualifiedName}${e.templateArgs ?? ''}${tags.length ? `  [${tags.join(', ')}]` : ''}`);
            if (!seen.has(n.id)) print(n.id, indent + '   ', new Set(seen).add(n.id));
        }
    };
    const symbol: Record<string, string> = { composition: '*--', aggregation: 'o--', association: '-->', dependency: '..>' };
    for (const n of g.nodes.filter(x => x.isSeed)) {
        const c = n.cls!;
        console.log(`${n.qualifiedName}  (${path.relative(process.cwd(), c.loc.file)}:${c.loc.line + 1}; ${c.members.length} members; ${c.sources.join('+')})`);
        print(n.id, '  ', new Set([n.id]));
        for (const e of g.edges.filter(x => x.from === n.id && symbol[x.kind])) {
            console.log(`  ${symbol[e.kind]} ${e.to}${e.multiplicity ? ` [${e.multiplicity}]` : ''}  ${e.kind} via ${e.label}`);
        }
    }
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    let target: string | undefined;
    let root: string | undefined;
    let json = false;
    let verbose = false;
    const settings: GraphSettings = { ...DEFAULT_SETTINGS, includePaths: [], defines: [] };
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--root') root = args[++i];
        else if (a === '--json') json = true;
        else if (a === '-v') verbose = true;
        else if (a === '--clang-uml') settings.clangUmlMode = args[++i] as GraphSettings['clangUmlMode'];
        else if (a === '--scope') settings.traversalScope = args[++i] as GraphSettings['traversalScope'];
        else if (a === '-I') settings.includePaths.push(path.resolve(args[++i]));
        else if (a.startsWith('-I')) settings.includePaths.push(path.resolve(a.slice(2)));
        else if (a === '-D') settings.defines.push(args[++i]);
        else if (a.startsWith('-D')) settings.defines.push(a.slice(2));
        else if (a.startsWith('-')) usage();
        else target = a;
    }
    if (!target) usage();
    const resolved = path.resolve(target);
    if (!fs.existsSync(resolved)) {
        console.error(`not found: ${resolved}`);
        process.exit(1);
    }
    const mode = fs.statSync(resolved).isDirectory() ? 'folder' : 'file';
    const opts = prepareBuild(resolved, mode, root ? [path.resolve(root)] : [], settings);
    if (verbose) opts.log = m => console.error(`[log] ${m}`);
    const graph = await buildGraph(opts);
    if (json) {
        console.log(JSON.stringify(graph, null, 2));
        return;
    }
    printTree(graph);
    const kinds = [...new Set(graph.edges.map(e => e.kind))].map(k => `${graph.edges.filter(e => e.kind === k).length} ${k}`).join(', ');
    console.log(`\n${graph.nodes.length} nodes, ${graph.edges.length} edges (${kinds}); backends: ${graph.backends.join(', ')}; ` +
        `${graph.stats.files} files parsed in ${graph.stats.elapsedMs} ms`);
    for (const d of graph.diagnostics) console.log(`note: ${d}`);
}

main().catch(e => {
    console.error(e instanceof Error ? e.stack : e);
    process.exit(1);
});
