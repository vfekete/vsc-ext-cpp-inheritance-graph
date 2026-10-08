/** Turns a "graph for this file / folder" request plus settings into BuildOptions. */
import * as fs from 'fs';
import * as path from 'path';
import { BuildOptions } from './graphBuilder';
import { expandVars, listFiles, loadIncludeConfig } from './includeConfig';

export interface GraphSettings {
    headerExtensions: string[];
    folderRecursive: boolean;
    traversalScope: 'workspace' | 'includePaths' | 'targetDirectory';
    additionalScopeRoots: string[];
    includePaths: string[];
    defines: string[];
    compileCommands: string;
    fuzzyIncludeResolution: boolean;
    externalNamespaces: string[];
    maxDepth: number;
    clangUmlMode: 'auto' | 'always' | 'never';
    clangUmlPath: string;
    clangUmlTimeoutMs: number;
    clangUmlExtraArgs: string[];
    cppStandard: string;
    /** C_Cpp.default.* values, for ${default} in c_cpp_properties.json. */
    cppToolsDefaultIncludePath: string[];
    cppToolsDefaultDefines: string[];
    cppToolsCompileCommands: string[];
}

export const DEFAULT_SETTINGS: GraphSettings = {
    headerExtensions: ['.h', '.hh', '.hpp', '.hxx', '.h++', '.inl', '.ipp', '.tpp', '.cuh'],
    folderRecursive: true,
    traversalScope: 'workspace',
    additionalScopeRoots: [],
    includePaths: [],
    defines: [],
    compileCommands: '',
    fuzzyIncludeResolution: true,
    externalNamespaces: ['std', 'boost', '__gnu_cxx', 'Qt'],
    maxDepth: 64,
    clangUmlMode: 'auto',
    clangUmlPath: 'clang-uml',
    clangUmlTimeoutMs: 120000,
    clangUmlExtraArgs: [],
    cppStandard: '',
    cppToolsDefaultIncludePath: [],
    cppToolsDefaultDefines: [],
    cppToolsCompileCommands: [],
};

export function prepareBuild(
    target: string,
    mode: 'file' | 'folder',
    workspaceFolders: string[],
    settings: GraphSettings,
): BuildOptions {
    target = path.resolve(target);
    // Without a workspace (e.g. CLI), use the closest ancestor that looks like a project root.
    if (!workspaceFolders.length) workspaceFolders = [guessProjectRoot(target)];
    const ws = workspaceFolders.find(w => target === w || target.startsWith(w + path.sep)) ?? workspaceFolders[0];

    const seedFiles = mode === 'file'
        ? [target]
        : listFiles(target, settings.headerExtensions, settings.folderRecursive);

    const includeConfig = loadIncludeConfig({
        workspaceFolders,
        extraIncludePaths: settings.includePaths,
        extraDefines: settings.defines,
        compileCommands: [settings.compileCommands, ...settings.cppToolsCompileCommands].filter(Boolean).map(c => expandVars(c, ws)),
        cppToolsDefaultIncludePath: settings.cppToolsDefaultIncludePath,
        cppToolsDefaultDefines: settings.cppToolsDefaultDefines,
        focusFile: mode === 'file' ? target : seedFiles[0],
    });

    const extraRoots = settings.additionalScopeRoots.map(r => path.resolve(ws, expandVars(r, ws)));
    let scopeRoots: string[];
    switch (settings.traversalScope) {
        case 'targetDirectory':
            scopeRoots = [mode === 'file' ? path.dirname(target) : target];
            break;
        case 'includePaths':
            scopeRoots = [...workspaceFolders, ...extraRoots, ...includeConfig.includeDirs.filter(d => !d.system).map(d => d.dir)];
            break;
        default:
            scopeRoots = [...workspaceFolders, ...extraRoots];
    }

    return {
        mode,
        target,
        seedFiles,
        scopeRoots,
        includeConfig,
        fuzzyRoots: [...new Set([...workspaceFolders, ...extraRoots])],
        fuzzyIncludes: settings.fuzzyIncludeResolution,
        externalNamespaces: settings.externalNamespaces,
        maxDepth: settings.maxDepth,
        clangUml: {
            mode: settings.clangUmlMode,
            executable: settings.clangUmlPath,
            timeoutMs: settings.clangUmlTimeoutMs,
            extraArgs: settings.clangUmlExtraArgs,
            cppStandard: settings.cppStandard || undefined,
        },
    };
}

/** Nearest ancestor containing a typical project marker, else the target's directory. */
export function guessProjectRoot(target: string): string {
    const markers = ['.git', '.vscode', 'compile_commands.json', 'CMakeLists.txt', 'meson.build', '.clang-uml'];
    let dir = fs.existsSync(target) && fs.statSync(target).isDirectory() ? target : path.dirname(target);
    let best: string | undefined;
    for (;;) {
        if (markers.some(m => fs.existsSync(path.join(dir, m)))) {
            best = dir;
            if (fs.existsSync(path.join(dir, '.git')) || fs.existsSync(path.join(dir, '.vscode'))) return dir;
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return best ?? (fs.existsSync(target) && fs.statSync(target).isDirectory() ? target : path.dirname(target));
}
