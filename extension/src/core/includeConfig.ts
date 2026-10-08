/**
 * Collects include directories and defines from the places a C++ project
 * usually keeps them, and resolves `#include` directives to files.
 *
 * Sources (all optional, merged in this order):
 *  - explicit settings (cppInheritanceGraph.includePaths / defines)
 *  - .vscode/c_cpp_properties.json (Microsoft C/C++ extension)
 *  - C_Cpp.default.includePath / defines settings
 *  - compile_commands.json (CMake, Bear, Meson, ...)
 */
import * as fs from 'fs';
import * as path from 'path';

export interface IncludeDir {
    dir: string;
    /** `dir/**` in c_cpp_properties.json: search the whole subtree. */
    recursive: boolean;
    system: boolean;
    quoteOnly?: boolean;
}

export interface IncludeConfig {
    includeDirs: IncludeDir[];
    /** NAME or NAME=VALUE */
    defines: string[];
    /** e.g. c++17 */
    cppStandard?: string;
    /** Headers force-included with -include. */
    forcedIncludes: string[];
    /** Where each piece came from, for diagnostics. */
    sources: string[];
}

export interface IncludeConfigOptions {
    workspaceFolders: string[];
    /** cppInheritanceGraph.includePaths */
    extraIncludePaths?: string[];
    /** cppInheritanceGraph.defines */
    extraDefines?: string[];
    /** cppInheritanceGraph.compileCommands or C_Cpp.default.compileCommands */
    compileCommands?: string[];
    /** C_Cpp.default.includePath */
    cppToolsDefaultIncludePath?: string[];
    /** C_Cpp.default.defines */
    cppToolsDefaultDefines?: string[];
    /** File the graph is built for: picks the most specific compile_commands entry. */
    focusFile?: string;
}

/** Parse JSON with comments and trailing commas (c_cpp_properties.json allows both). */
export function parseJsonc(text: string): any {
    let out = '';
    let i = 0;
    while (i < text.length) {
        const c = text[i];
        if (c === '"') {
            let j = i + 1;
            while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
            out += text.slice(i, j + 1);
            i = j + 1;
        } else if (c === '/' && text[i + 1] === '/') {
            while (i < text.length && text[i] !== '\n') i++;
        } else if (c === '/' && text[i + 1] === '*') {
            const end = text.indexOf('*/', i + 2);
            i = end < 0 ? text.length : end + 2;
        } else {
            out += c;
            i++;
        }
    }
    return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

export function expandVars(value: string, workspaceFolder: string | undefined): string {
    return value
        .replace(/\$\{(workspaceFolder|workspaceRoot)(?::[^}]*)?\}/g, workspaceFolder ?? '')
        .replace(/\$\{workspaceFolderBasename\}/g, workspaceFolder ? path.basename(workspaceFolder) : '')
        .replace(/\$\{env:([^}]+)\}/g, (_, name) => process.env[name] ?? '')
        .replace(/^~(?=\/|$)/, process.env.HOME ?? '~');
}

function toIncludeDir(raw: string, base: string, system = false): IncludeDir | undefined {
    let p = raw.trim();
    if (!p) return undefined;
    let recursive = false;
    if (p.endsWith('/**') || p.endsWith('\\**')) {
        recursive = true;
        p = p.slice(0, -3);
    } else if (p.endsWith('**')) {
        recursive = true;
        p = p.slice(0, -2);
    }
    const dir = path.resolve(base, p);
    return { dir, recursive, system };
}

/** Split a shell command line (as found in compile_commands.json "command"). */
export function splitCommandLine(cmd: string): string[] {
    const args: string[] = [];
    let cur = '';
    let quote: string | null = null;
    let has = false;
    for (let i = 0; i < cmd.length; i++) {
        const c = cmd[i];
        if (quote) {
            if (c === quote) quote = null;
            else if (c === '\\' && quote === '"' && i + 1 < cmd.length) cur += cmd[++i];
            else cur += c;
        } else if (c === '"' || c === '\'') {
            quote = c;
            has = true;
        } else if (c === '\\' && i + 1 < cmd.length) {
            cur += cmd[++i];
            has = true;
        } else if (/\s/.test(c)) {
            if (has || cur) args.push(cur);
            cur = '';
            has = false;
        } else {
            cur += c;
        }
    }
    if (has || cur) args.push(cur);
    return args;
}

interface CompileEntry { directory: string; file: string; args: string[] }

/** Extract include dirs / defines / std from compiler arguments. */
export function parseCompilerArgs(args: string[], cwd: string): { includeDirs: IncludeDir[]; defines: string[]; std?: string; forcedIncludes: string[] } {
    const includeDirs: IncludeDir[] = [];
    const defines: string[] = [];
    const forcedIncludes: string[] = [];
    let std: string | undefined;
    const takeValue = (i: number, flag: string): [string | undefined, number] => {
        const a = args[i];
        if (a === flag) return [args[i + 1], i + 1];
        if (a.startsWith(flag)) return [a.slice(flag.length).replace(/^=/, ''), i];
        return [undefined, i];
    };
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        let v: string | undefined;
        if (a.startsWith('-isystem') || a.startsWith('/external:I')) {
            [v, i] = takeValue(i, a.startsWith('-') ? '-isystem' : '/external:I');
            if (v) includeDirs.push({ dir: path.resolve(cwd, v), recursive: false, system: true });
        } else if (a.startsWith('-iquote')) {
            [v, i] = takeValue(i, '-iquote');
            if (v) includeDirs.push({ dir: path.resolve(cwd, v), recursive: false, system: false, quoteOnly: true });
        } else if (a.startsWith('-I') || a.startsWith('/I')) {
            [v, i] = takeValue(i, a.slice(0, 2));
            if (v) includeDirs.push({ dir: path.resolve(cwd, v), recursive: false, system: false });
        } else if (a.startsWith('-D') || a.startsWith('/D')) {
            [v, i] = takeValue(i, a.slice(0, 2));
            if (v) defines.push(v);
        } else if (a.startsWith('-std=') || a.startsWith('/std:')) {
            std = a.slice(5);
        } else if (a === '-include' || a === '/FI') {
            const f = args[++i];
            if (f) forcedIncludes.push(path.resolve(cwd, f));
        }
    }
    return { includeDirs, defines, std, forcedIncludes };
}

function readCompileCommands(file: string): CompileEntry[] {
    try {
        const json = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!Array.isArray(json)) return [];
        return json.map((e: any) => ({
            directory: e.directory ?? path.dirname(file),
            file: path.resolve(e.directory ?? path.dirname(file), e.file ?? ''),
            args: Array.isArray(e.arguments) ? e.arguments : splitCommandLine(e.command ?? ''),
        }));
    } catch {
        return [];
    }
}

/** Locate compile_commands.json files: explicit paths first, then common build dirs. */
export function findCompileCommands(workspaceFolders: string[], explicit: string[] = []): string[] {
    const found: string[] = [];
    const consider = (p: string) => {
        try {
            const st = fs.statSync(p);
            const f = st.isDirectory() ? path.join(p, 'compile_commands.json') : p;
            if (fs.existsSync(f) && !found.includes(f)) found.push(f);
        } catch { /* missing */ }
    };
    for (const e of explicit) if (e) consider(e);
    if (found.length) return found;
    for (const ws of workspaceFolders) {
        consider(path.join(ws, 'compile_commands.json'));
        let entries: string[] = [];
        try { entries = fs.readdirSync(ws); } catch { /* ignore */ }
        for (const d of entries) {
            if (/^(build|out|cmake-build-.*|builddir|_build|\.build)$/i.test(d)) {
                consider(path.join(ws, d, 'compile_commands.json'));
                // build/<preset>/compile_commands.json
                try {
                    for (const sub of fs.readdirSync(path.join(ws, d))) consider(path.join(ws, d, sub, 'compile_commands.json'));
                } catch { /* ignore */ }
            }
        }
    }
    return found;
}

function commonPrefixLength(a: string, b: string): number {
    const pa = a.split(path.sep);
    const pb = b.split(path.sep);
    let i = 0;
    while (i < pa.length && i < pb.length && pa[i] === pb[i]) i++;
    return i;
}

export function loadIncludeConfig(opts: IncludeConfigOptions): IncludeConfig {
    const cfg: IncludeConfig = { includeDirs: [], defines: [], forcedIncludes: [], sources: [] };
    const ws0 = opts.workspaceFolders[0];
    const wsFor = (file?: string) =>
        (file && opts.workspaceFolders.find(w => file.startsWith(w + path.sep))) || ws0;
    const addDir = (d: IncludeDir | undefined) => {
        if (!d) return;
        const existing = cfg.includeDirs.find(x => x.dir === d.dir);
        if (existing) {
            existing.recursive ||= d.recursive;
            return;
        }
        cfg.includeDirs.push(d);
    };

    for (const p of opts.extraIncludePaths ?? []) addDir(toIncludeDir(expandVars(p, wsFor(opts.focusFile)), wsFor(opts.focusFile) ?? process.cwd()));
    cfg.defines.push(...(opts.extraDefines ?? []));
    if (opts.extraIncludePaths?.length) cfg.sources.push('settings');

    // c_cpp_properties.json
    for (const ws of opts.workspaceFolders) {
        const propsFile = path.join(ws, '.vscode', 'c_cpp_properties.json');
        if (!fs.existsSync(propsFile)) continue;
        try {
            const props = parseJsonc(fs.readFileSync(propsFile, 'utf8'));
            const configs: any[] = props.configurations ?? [];
            const platformName = process.platform === 'win32' ? 'Win32' : process.platform === 'darwin' ? 'Mac' : 'Linux';
            const conf = configs.find(c => c.name === platformName) ?? configs[0];
            if (!conf) continue;
            for (const p of conf.includePath ?? []) {
                if (p === '${default}') {
                    for (const d of opts.cppToolsDefaultIncludePath ?? []) addDir(toIncludeDir(expandVars(d, ws), ws));
                } else {
                    addDir(toIncludeDir(expandVars(p, ws), ws));
                }
            }
            for (const d of conf.defines ?? []) {
                if (d === '${default}') cfg.defines.push(...(opts.cppToolsDefaultDefines ?? []));
                else cfg.defines.push(d);
            }
            if (conf.cppStandard && !/^(gnu)?c\+\+\d+$/.test(cfg.cppStandard ?? '')) {
                cfg.cppStandard = String(conf.cppStandard).replace(/^gnu\+\+/, 'gnu++');
            }
            for (const f of conf.forcedInclude ?? []) cfg.forcedIncludes.push(path.resolve(ws, expandVars(f, ws)));
            if (conf.compileCommands) {
                const cc = Array.isArray(conf.compileCommands) ? conf.compileCommands : [conf.compileCommands];
                opts.compileCommands = [...(opts.compileCommands ?? []), ...cc.map((c: string) => expandVars(c, ws))];
            }
            cfg.sources.push(path.relative(ws, propsFile) || propsFile);
        } catch (e) {
            cfg.sources.push(`c_cpp_properties.json unreadable: ${(e as Error).message}`);
        }
    }

    for (const p of opts.cppToolsDefaultIncludePath ?? []) addDir(toIncludeDir(expandVars(p, ws0), ws0 ?? process.cwd()));
    cfg.defines.push(...(opts.cppToolsDefaultDefines ?? []));

    // compile_commands.json
    for (const ccFile of findCompileCommands(opts.workspaceFolders, opts.compileCommands)) {
        const entries = readCompileCommands(ccFile);
        if (!entries.length) continue;
        cfg.sources.push(ccFile);
        // The entry closest to the focus file goes first so its flags win.
        const focus = opts.focusFile;
        const sorted = focus
            ? [...entries].sort((a, b) => commonPrefixLength(b.file, focus) - commonPrefixLength(a.file, focus))
            : entries;
        const definesSeen = new Set(cfg.defines);
        sorted.forEach((entry, idx) => {
            const parsed = parseCompilerArgs(entry.args, entry.directory);
            parsed.includeDirs.forEach(addDir);
            if (idx === 0) {
                for (const d of parsed.defines) if (!definesSeen.has(d)) { cfg.defines.push(d); definesSeen.add(d); }
                if (parsed.std && !cfg.cppStandard) cfg.cppStandard = parsed.std;
                cfg.forcedIncludes.push(...parsed.forcedIncludes);
            }
        });
    }
    return cfg;
}

/** Directory names never descended into when scanning for headers. */
const SKIP_DIRS = new Set(['.git', '.svn', '.hg', 'node_modules', '.vscode', '.idea', '.cache', '__pycache__']);

/** Recursively list files with one of the given extensions. */
export function listFiles(root: string, extensions: string[], recursive = true, limit = 20000): string[] {
    const exts = new Set(extensions.map(e => e.toLowerCase()));
    const result: string[] = [];
    const walk = (dir: string) => {
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        entries.sort((a, b) => a.name.localeCompare(b.name));
        for (const e of entries) {
            if (result.length >= limit) return;
            const full = path.join(dir, e.name);
            if (e.isDirectory()) {
                if (recursive && !SKIP_DIRS.has(e.name)) walk(full);
            } else if (e.isFile() && exts.has(path.extname(e.name).toLowerCase())) {
                result.push(full);
            }
        }
    };
    walk(root);
    return result;
}

const HEADER_EXTS = ['.h', '.hh', '.hpp', '.hxx', '.h++', '.inl', '.ipp', '.tpp', '.cuh', '.def', '.inc', ''];

/**
 * Resolves `#include` names to files. Lookups are cached; a lazily built index of all
 * headers under the scope roots serves as a last resort ("fuzzy" resolution), so
 * headers are found even when the include paths are not configured.
 */
export class IncludeResolver {
    private cache = new Map<string, string | null>();
    private recursiveIndex = new Map<string, string[]>();
    private fuzzyIndex: Map<string, string[]> | undefined;

    constructor(
        public readonly config: IncludeConfig,
        private readonly fuzzyRoots: string[],
        private readonly fuzzy: boolean,
    ) {}

    /** Directories (non-system) that were configured, for scope computation. */
    get userIncludeDirs(): string[] {
        return this.config.includeDirs.filter(d => !d.system).map(d => d.dir);
    }

    resolve(name: string, angled: boolean, fromFile: string): { file?: string; system: boolean } {
        const key = `${angled ? '<' : '"'}${name}|${angled ? '' : path.dirname(fromFile)}`;
        if (this.cache.has(key)) {
            const f = this.cache.get(key);
            return { file: f ?? undefined, system: f ? this.isSystemFile(f) : false };
        }
        const file = this.lookup(name, angled, fromFile);
        this.cache.set(key, file ?? null);
        return { file, system: file ? this.isSystemFile(file) : false };
    }

    isSystemFile(file: string): boolean {
        return this.config.includeDirs.some(d => d.system && file.startsWith(d.dir + path.sep));
    }

    private lookup(name: string, angled: boolean, fromFile: string): string | undefined {
        if (path.isAbsolute(name)) return isFile(name) ? name : undefined;
        if (!angled) {
            const local = path.resolve(path.dirname(fromFile), name);
            if (isFile(local)) return local;
        }
        for (const d of this.config.includeDirs) {
            if (d.quoteOnly && angled) continue;
            const candidate = path.join(d.dir, name);
            if (isFile(candidate)) return candidate;
        }
        for (const d of this.config.includeDirs) {
            if (!d.recursive) continue;
            const hit = this.findInSubtree(d.dir, name);
            if (hit) return hit;
        }
        if (this.fuzzy) return this.fuzzyLookup(name, fromFile);
        return undefined;
    }

    private findInSubtree(root: string, name: string): string | undefined {
        let files = this.recursiveIndex.get(root);
        if (!files) {
            files = listFiles(root, HEADER_EXTS);
            this.recursiveIndex.set(root, files);
        }
        const suffix = path.sep + path.normalize(name);
        return files.find(f => f.endsWith(suffix));
    }

    private fuzzyLookup(name: string, fromFile: string): string | undefined {
        if (!this.fuzzyIndex) {
            this.fuzzyIndex = new Map();
            for (const root of this.fuzzyRoots) {
                for (const f of listFiles(root, HEADER_EXTS)) {
                    const base = path.basename(f);
                    const arr = this.fuzzyIndex.get(base) ?? [];
                    arr.push(f);
                    this.fuzzyIndex.set(base, arr);
                }
            }
        }
        const norm = path.normalize(name);
        const candidates = (this.fuzzyIndex.get(path.basename(norm)) ?? [])
            .filter(f => f === norm || f.endsWith(path.sep + norm));
        if (!candidates.length) return undefined;
        // Prefer the candidate closest to the including file.
        candidates.sort((a, b) => commonPrefixLength(b, fromFile) - commonPrefixLength(a, fromFile));
        return candidates[0];
    }
}

function isFile(p: string): boolean {
    try { return fs.statSync(p).isFile(); } catch { return false; }
}
