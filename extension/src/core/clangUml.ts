/**
 * Optional compiler-accurate backend based on clang-uml (https://github.com/bkryza/clang-uml).
 *
 * A synthetic translation unit that includes the requested headers is generated together
 * with a matching compile_commands.json and .clang-uml config (JSON is valid YAML), then
 * clang-uml's JSON class diagram is converted to ClassInfo records. Because clang does the
 * work, macro-generated classes, computed includes and template bases are all exact.
 */
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { IncludeConfig } from './includeConfig';
import { Access, BaseSpec, ClassInfo, MemberInfo, SourceLoc } from './model';
import { stripTemplateArgs } from './names';

export interface ClangUmlOptions {
    executable: string;
    timeoutMs: number;
    extraArgs: string[];
    cppStandard?: string;
}

export interface ClangUmlResult {
    classes: ClassInfo[];
    diagnostics: string[];
}

/** Find an executable by absolute path or on PATH. */
export function findExecutable(name: string): string | undefined {
    if (!name) return undefined;
    const candidates = process.platform === 'win32' && !path.extname(name) ? [name + '.exe', name] : [name];
    if (path.isAbsolute(name) || name.includes('/') || name.includes('\\')) {
        return candidates.find(c => isExecutable(c));
    }
    for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
        for (const c of candidates) {
            const full = path.join(dir, c);
            if (isExecutable(full)) return full;
        }
    }
    return undefined;
}

function isExecutable(p: string): boolean {
    try {
        fs.accessSync(p, fs.constants.X_OK);
        return fs.statSync(p).isFile();
    } catch {
        return false;
    }
}

export async function runClangUml(
    seedFiles: string[],
    config: IncludeConfig,
    filterRoots: string[],
    opts: ClangUmlOptions,
    log: (msg: string) => void = () => {},
): Promise<ClangUmlResult> {
    const exe = findExecutable(opts.executable);
    if (!exe) throw new Error(`clang-uml executable not found: ${opts.executable}`);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cpp-inheritance-'));
    try {
        const tu = path.join(tmp, 'inheritance_tu.cpp');
        fs.writeFileSync(tu, seedFiles.map(f => `#include ${JSON.stringify(f)}`).join('\n') + '\n');
        const std = opts.cppStandard || config.cppStandard || 'c++17';
        const args = ['clang++', '-x', 'c++', `-std=${std.replace(/^-std=/, '')}`];
        for (const d of config.includeDirs) {
            if (d.recursive) continue; // compilers do not support recursive include dirs
            args.push(d.system ? '-isystem' : d.quoteOnly ? '-iquote' : '-I', d.dir);
        }
        for (const d of config.defines) args.push(`-D${d}`);
        for (const f of config.forcedIncludes) args.push('-include', f);
        args.push(...opts.extraArgs, '-c', tu);
        fs.writeFileSync(path.join(tmp, 'compile_commands.json'), JSON.stringify([{ directory: tmp, file: tu, arguments: args }], null, 1));
        const outDir = path.join(tmp, 'out');
        const roots = [...new Set(filterRoots.map(r => path.resolve(r)))];
        const umlConfig = {
            relative_to: '/',
            compilation_database_dir: tmp,
            output_directory: outDir,
            diagrams: {
                inheritance: {
                    type: 'class',
                    glob: [tu],
                    include: { paths: roots },
                    generate_method_arguments: 'full',
                },
            },
        };
        const cfgFile = path.join(tmp, '.clang-uml');
        fs.writeFileSync(cfgFile, JSON.stringify(umlConfig, null, 1));
        log(`clang-uml: ${exe} on ${seedFiles.length} header(s), std=${std}`);
        const { stderr } = await execFileAsync(exe, ['-c', cfgFile, '-g', 'json', '-q', '--allow-empty-diagrams', '-t', '0'], tmp, opts.timeoutMs);
        const outFile = path.join(outDir, 'inheritance.json');
        if (!fs.existsSync(outFile)) throw new Error(`clang-uml produced no output. ${stderr.trim().slice(0, 2000)}`);
        const json = JSON.parse(fs.readFileSync(outFile, 'utf8'));
        const diagnostics = stderr.split('\n').filter(l => /error/i.test(l)).slice(0, 10).map(l => `clang-uml: ${l.trim()}`);
        return { classes: convertClangUmlJson(json, '/'), diagnostics };
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
}

function execFileAsync(exe: string, args: string[], cwd: string, timeout: number): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
        execFile(exe, args, { cwd, timeout, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
            if (err && (err as any).killed) reject(new Error(`clang-uml timed out after ${timeout} ms`));
            // clang-uml exits non-zero on compilation errors but may still have written a diagram.
            else resolve({ stdout: String(stdout), stderr: String(stderr) + (err ? `\n${err.message}` : '') });
        });
    });
}

function isInstantiation(e: any): boolean {
    return Array.isArray(e.template_parameters) && e.template_parameters.some((p: any) => p.kind === 'argument');
}

function toLoc(sl: any, relativeTo: string): SourceLoc | undefined {
    if (!sl || !sl.file) return undefined;
    const file = path.isAbsolute(sl.file) ? sl.file : path.resolve(relativeTo, sl.file);
    return { file, line: Math.max(0, (sl.line ?? 1) - 1), column: Math.max(0, (sl.column ?? 1) - 1) };
}

/** Convert clang-uml's JSON class diagram into ClassInfo records. */
export function convertClangUmlJson(json: any, relativeTo: string): ClassInfo[] {
    const elements: any[] = json?.elements ?? [];
    const byId = new Map<string, any>();
    for (const e of elements) byId.set(String(e.id), e);
    const classes: ClassInfo[] = [];
    for (const e of elements) {
        if (e.type !== 'class' || isInstantiation(e)) continue;
        const loc = toLoc(e.source_location, relativeTo);
        if (!loc) continue;
        const id = stripTemplateArgs(String(e.display_name));
        const parts = id.split('::');
        const tparams: any[] = (e.template_parameters ?? []).filter((p: any) => p.kind !== 'argument');
        const bases: BaseSpec[] = (e.bases ?? []).map((b: any) => {
            const target = byId.get(String(b.id));
            const display = target ? String(target.display_name) : '';
            return {
                name: display,
                resolvedId: display ? stripTemplateArgs(display) : undefined,
                access: (b.access ?? 'public') as Access,
                isVirtual: !!b.is_virtual,
            };
        });
        const members: MemberInfo[] = [];
        for (const m of e.members ?? []) {
            members.push({
                name: m.name, kind: 'field', access: m.access ?? 'public', type: m.type ?? '',
                isStatic: m.is_static || undefined, loc: toLoc(m.source_location, relativeTo),
            });
        }
        for (const m of e.methods ?? []) {
            const kind: MemberInfo['kind'] = m.is_constructor ? 'constructor'
                : String(m.name).startsWith('~') ? 'destructor' : m.is_operator ? 'operator' : 'method';
            const params = (m.parameters ?? []).map((p: any) =>
                `${p.type ?? ''}${p.name ? ' ' + p.name : ''}${p.default_value ? ' = ' + p.default_value : ''}`).join(', ');
            members.push({
                name: m.name, kind, access: m.access ?? 'public',
                type: kind === 'constructor' || kind === 'destructor' ? '' : (m.type ?? ''),
                params: `(${params})`,
                isStatic: m.is_static || undefined,
                isVirtual: m.is_virtual || undefined,
                isPure: m.is_pure_virtual || undefined,
                isConst: m.is_const || undefined,
                loc: toLoc(m.source_location, relativeTo),
            });
        }
        classes.push({
            id,
            name: parts[parts.length - 1],
            scope: parts.slice(0, -1),
            kind: e.is_union ? 'union' : e.is_struct ? 'struct' : 'class',
            templateParams: tparams.length ? `<${tparams.map((p: any) => `typename${p.is_variadic ? '...' : ''} ${p.name ?? ''}`.trim()).join(', ')}>` : undefined,
            templateParamNames: tparams.length ? tparams.map((p: any) => p.name).filter(Boolean) : undefined,
            isAbstract: e.is_abstract || undefined,
            bases,
            members,
            loc,
            sources: ['clang-uml'],
        });
    }
    return classes;
}
