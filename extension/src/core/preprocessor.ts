/**
 * A pragmatic C preprocessor producing a token stream for the class parser.
 *
 * It supports object- and function-like macros (with #, ## and __VA_ARGS__),
 * conditionals (#if/#ifdef/#elif/#else with expression evaluation, defined(),
 * __has_include) and #include resolution, including computed includes such as
 * `#include CORE_HEADER(object)`. Headers that cannot be found (typically the
 * standard library) are skipped: the parser does not need them.
 *
 * Tokens keep their original file/line/column. Tokens produced by a macro body
 * get the location of the macro invocation; tokens passed as macro arguments
 * keep their own location, so `DECLARE_CLASS(Foo, Bar)` still points at `Foo`.
 */
import * as fs from 'fs';
import * as path from 'path';
import { IncludeResolver } from './includeConfig';
import { Token, stripComments, tokenizeLine } from './tokenizer';

export interface Macro {
    name: string;
    params?: string[];
    variadic?: boolean;
    body: Token[];
}

export interface PreprocessResult {
    tokens: Token[];
    /** Every file that was read, in order. */
    files: string[];
    /** `#include` directives that could not be resolved (file -> names). */
    unresolvedIncludes: Map<string, Set<string>>;
    diagnostics: string[];
}

interface CachedFile { mtimeMs: number; lines: Token[][]; directiveLines: Set<number> }

/** Tokenized files, shared between runs; invalidated on mtime change. */
const fileCache = new Map<string, CachedFile>();

export function clearPreprocessorCache(): void {
    fileCache.clear();
}

/** Contents of open, possibly unsaved editors: file path -> text. */
export type TextOverlay = Map<string, string>;

function loadFile(file: string, overlay?: TextOverlay): CachedFile | undefined {
    const overlayText = overlay?.get(file);
    let mtimeMs = -1;
    if (overlayText === undefined) {
        try { mtimeMs = fs.statSync(file).mtimeMs; } catch { return undefined; }
        const cached = fileCache.get(file);
        if (cached && cached.mtimeMs === mtimeMs) return cached;
    }
    let text: string;
    try { text = overlayText ?? fs.readFileSync(file, 'utf8'); } catch { return undefined; }
    const physical = stripComments(text).split('\n');
    const lines: Token[][] = [];
    const directiveLines = new Set<number>();
    for (let i = 0; i < physical.length; i++) {
        let lineText = physical[i];
        if (/^\s*#/.test(lineText)) {
            // Directive: join backslash continuations onto the first line.
            const startLine = i;
            const parts: Token[] = [];
            let colOffset = 0;
            for (;;) {
                const cont = /\\\s*$/.test(lineText);
                const content = cont ? lineText.replace(/\\\s*$/, '') : lineText;
                for (const t of tokenizeLine(content, file, i, i === startLine ? 0 : colOffset)) parts.push({ ...t, line: i });
                lines[i] = [];
                if (!cont || i + 1 >= physical.length) break;
                lineText = physical[++i];
                colOffset = 0;
            }
            lines[startLine] = parts;
            directiveLines.add(startLine);
        } else {
            lines[i] = tokenizeLine(lineText.replace(/\\\s*$/, ''), file, i);
        }
    }
    const entry = { mtimeMs, lines, directiveLines };
    if (overlayText === undefined) fileCache.set(file, entry);
    return entry;
}

interface CondFrame {
    /** Tokens of this branch are emitted. */
    active: boolean;
    /** Some branch of this #if chain was already taken. */
    taken: boolean;
    /** The enclosing context is active. */
    parentActive: boolean;
}

export interface PreprocessorOptions {
    resolver: IncludeResolver;
    defines?: string[];
    /** Follow includes into system include directories. */
    parseSystemHeaders?: boolean;
    /** Return false to read a file for macros only, without emitting its tokens. */
    emitTokensFor?: (file: string) => boolean;
    overlay?: TextOverlay;
    maxIncludeDepth?: number;
}

export class Preprocessor {
    readonly macros = new Map<string, Macro>();
    private pragmaOnce = new Set<string>();
    private result: PreprocessResult = { tokens: [], files: [], unresolvedIncludes: new Map(), diagnostics: [] };
    private depth = 0;

    constructor(private readonly opts: PreprocessorOptions) {
        this.defineFromString('__cplusplus=201703L');
        this.defineFromString('__STDC_HOSTED__=1');
        for (const d of opts.defines ?? []) this.defineFromString(d);
    }

    defineFromString(def: string): void {
        const eq = def.indexOf('=');
        const head = eq < 0 ? def : def.slice(0, eq);
        const value = eq < 0 ? '1' : def.slice(eq + 1);
        const toks = tokenizeLine(`${head} ${value}`, '<command line>', 0);
        this.defineFromTokens(toks);
    }

    /** Preprocess the given files as one translation unit (like a unity build). */
    run(files: string[]): PreprocessResult {
        for (const f of files) this.includeFile(path.resolve(f));
        return this.result;
    }

    private includeFile(file: string): void {
        if (this.pragmaOnce.has(file)) return;
        if (this.depth > (this.opts.maxIncludeDepth ?? 64)) {
            this.result.diagnostics.push(`Include depth limit reached at ${file}`);
            return;
        }
        const content = loadFile(file, this.opts.overlay);
        if (!content) {
            this.result.diagnostics.push(`Cannot read ${file}`);
            return;
        }
        if (!this.result.files.includes(file)) this.result.files.push(file);
        const emit = this.opts.emitTokensFor ? this.opts.emitTokensFor(file) : true;
        this.depth++;
        try {
            this.processLines(file, content, emit);
        } finally {
            this.depth--;
        }
    }

    private processLines(file: string, content: CachedFile, emit: boolean): void {
        const conds: CondFrame[] = [];
        const isActive = () => conds.length === 0 || conds[conds.length - 1].active;
        let pending: Token[] = [];
        const flush = () => {
            if (pending.length) {
                if (emit) for (const t of this.expand(pending, new Set())) this.result.tokens.push(t);
                pending = [];
            }
        };
        const { lines, directiveLines } = content;
        for (let i = 0; i < lines.length; i++) {
            const toks = lines[i];
            if (!toks || !toks.length) continue;
            if (!directiveLines.has(i)) {
                if (isActive()) pending.push(...toks);
                continue;
            }
            // Directive
            const name = toks[1]?.text ?? '';
            const args = toks.slice(2);
            switch (name) {
                case 'if':
                case 'ifdef':
                case 'ifndef': {
                    const parentActive = isActive();
                    let cond = false;
                    if (parentActive) {
                        if (name === 'ifdef') cond = this.macros.has(args[0]?.text ?? '');
                        else if (name === 'ifndef') cond = !this.macros.has(args[0]?.text ?? '');
                        else cond = this.evalCondition(args, file);
                    }
                    conds.push({ active: parentActive && cond, taken: cond, parentActive });
                    break;
                }
                case 'elif':
                case 'elifdef':
                case 'elifndef': {
                    const top = conds[conds.length - 1];
                    if (!top) break;
                    if (top.taken || !top.parentActive) {
                        top.active = false;
                    } else {
                        const cond = name === 'elif' ? this.evalCondition(args, file)
                            : name === 'elifdef' ? this.macros.has(args[0]?.text ?? '')
                                : !this.macros.has(args[0]?.text ?? '');
                        top.active = cond;
                        top.taken = cond;
                    }
                    break;
                }
                case 'else': {
                    const top = conds[conds.length - 1];
                    if (top) {
                        top.active = top.parentActive && !top.taken;
                        top.taken = true;
                    }
                    break;
                }
                case 'endif':
                    conds.pop();
                    break;
                default: {
                    if (!isActive()) break;
                    if (name === 'define') {
                        this.defineFromTokens(args);
                    } else if (name === 'undef') {
                        this.macros.delete(args[0]?.text ?? '');
                    } else if (name === 'include' || name === 'include_next' || name === 'import') {
                        flush();
                        this.handleInclude(args, file);
                    } else if (name === 'pragma' && args[0]?.text === 'once') {
                        this.pragmaOnce.add(file);
                    }
                }
            }
        }
        flush();
    }

    private handleInclude(args: Token[], fromFile: string): void {
        const spec = this.includeSpec(args);
        if (!spec) return;
        const { file, system } = this.opts.resolver.resolve(spec.name, spec.angled, fromFile);
        if (!file || (system && !this.opts.parseSystemHeaders)) {
            if (!file) {
                const set = this.result.unresolvedIncludes.get(fromFile) ?? new Set<string>();
                set.add(spec.angled ? `<${spec.name}>` : `"${spec.name}"`);
                this.result.unresolvedIncludes.set(fromFile, set);
            }
            return;
        }
        this.includeFile(file);
    }

    /** Interpret the operand of #include, expanding macros when needed. */
    includeSpec(args: Token[]): { name: string; angled: boolean } | undefined {
        let toks = args;
        if (toks[0]?.kind !== 'str' && toks[0]?.text !== '<') toks = this.expand(args, new Set());
        if (!toks.length) return undefined;
        if (toks[0].kind === 'str') return { name: toks[0].text.slice(1, -1), angled: false };
        if (toks[0].text === '<') {
            let name = '';
            for (let i = 1; i < toks.length && toks[i].text !== '>'; i++) {
                // Spaces inside <...> are only kept where the source had them between words.
                if (i > 1 && toks[i].spaceBefore && toks[i].kind === 'id' && toks[i - 1].kind === 'id') name += ' ';
                name += toks[i].text;
            }
            return { name, angled: true };
        }
        return undefined;
    }

    private defineFromTokens(args: Token[]): void {
        const nameTok = args[0];
        if (!nameTok || nameTok.kind !== 'id') return;
        const macro: Macro = { name: nameTok.text, body: [] };
        let i = 1;
        if (args[1]?.text === '(' && !args[1].spaceBefore) {
            macro.params = [];
            i = 2;
            while (i < args.length && args[i].text !== ')') {
                const t = args[i];
                if (t.text === '...') {
                    macro.variadic = true;
                    macro.params.push('__VA_ARGS__');
                } else if (t.kind === 'id') {
                    if (args[i + 1]?.text === '...') { macro.variadic = true; i++; }
                    macro.params.push(t.text);
                }
                i++;
            }
            i++; // ')'
        }
        macro.body = args.slice(i);
        this.macros.set(macro.name, macro);
    }

    /** Expand macros in a token sequence. `disabled` holds macros currently being expanded. */
    expand(tokens: Token[], disabled: Set<string>, inIfExpr = false): Token[] {
        const out: Token[] = [];
        let i = 0;
        while (i < tokens.length) {
            const t = tokens[i];
            if (t.kind !== 'id' || disabled.has(t.text)) { out.push(t); i++; continue; }
            if (inIfExpr && t.text === 'defined') {
                // Copy `defined X` / `defined(X)` verbatim.
                out.push(t);
                i++;
                if (tokens[i]?.text === '(') { out.push(...tokens.slice(i, i + 3)); i += 3; }
                else if (tokens[i]) { out.push(tokens[i]); i++; }
                continue;
            }
            const m = this.macros.get(t.text);
            if (!m) { out.push(t); i++; continue; }
            if (!m.params) {
                const body = m.body.map(b => relocate(b, t, m.name));
                const next = new Set(disabled).add(m.name);
                // Rescan together with the rest so an object-like macro can name a function-like one.
                const expanded = this.expand(body, next, inIfExpr);
                const last = expanded[expanded.length - 1];
                if (last && last.kind === 'id' && this.macros.get(last.text)?.params && tokens[i + 1]?.text === '(') {
                    tokens = [...tokens.slice(0, i), ...expanded, ...tokens.slice(i + 1)];
                    i += expanded.length - 1;
                    out.push(...expanded.slice(0, -1));
                    // `last` is now at tokens[i]; let the loop handle it (macro is not disabled for it).
                    continue;
                }
                out.push(...expanded);
                i++;
                continue;
            }
            // Function-like: needs '(' next.
            if (tokens[i + 1]?.text !== '(') { out.push(t); i++; continue; }
            const collected = collectArgs(tokens, i + 1);
            if (!collected) { out.push(t); i++; continue; }
            const { args, end } = collected;
            const substituted = this.substitute(m, args, t, disabled, inIfExpr);
            out.push(...this.expand(substituted, new Set(disabled).add(m.name), inIfExpr));
            i = end + 1;
        }
        return out;
    }

    private substitute(m: Macro, args: Token[][], invocation: Token, disabled: Set<string>, inIfExpr: boolean): Token[] {
        const params = m.params ?? [];
        const argFor = (name: string): Token[] | undefined => {
            const idx = params.indexOf(name);
            if (idx < 0) return undefined;
            if (name === '__VA_ARGS__' && m.variadic) {
                // Variadic part: remaining arguments joined with commas.
                const rest = args.slice(idx);
                const joined: Token[] = [];
                rest.forEach((a, k) => {
                    if (k) joined.push({ ...invocation, kind: 'punct', text: ',', macro: m.name });
                    joined.push(...a);
                });
                return joined;
            }
            return args[idx] ?? [];
        };
        const body = m.body;
        const out: Token[] = [];
        for (let k = 0; k < body.length; k++) {
            const b = body[k];
            if (b.text === '#' && k + 1 < body.length && params.includes(body[k + 1].text)) {
                const arg = argFor(body[k + 1].text) ?? [];
                const text = JSON.stringify(arg.map((a, idx) => (idx && a.spaceBefore ? ' ' : '') + a.text).join(''));
                out.push({ ...invocation, kind: 'str', text, macro: m.name });
                k++;
                continue;
            }
            if (b.text === '##') {
                // Paste the previous output token with the next body token (or its argument).
                const prev = out.pop();
                const nextTok = body[k + 1];
                k++;
                if (!nextTok) { if (prev) out.push(prev); continue; }
                const rhs = params.includes(nextTok.text) ? (argFor(nextTok.text) ?? []) : [relocate(nextTok, invocation, m.name)];
                if (!prev) { out.push(...rhs); continue; }
                if (!rhs.length) { out.push(prev); continue; }
                const pasted = tokenizeLine(prev.text + rhs[0].text, prev.file, prev.line, prev.col)[0];
                out.push({ ...prev, kind: pasted?.kind ?? prev.kind, text: prev.text + rhs[0].text });
                out.push(...rhs.slice(1));
                continue;
            }
            const arg = b.kind === 'id' ? argFor(b.text) : undefined;
            if (arg) {
                const pastedNext = body[k + 1]?.text === '##';
                // Arguments are fully expanded before substitution, unless used with ##.
                out.push(...(pastedNext ? arg : this.expand(arg, disabled, inIfExpr)));
                continue;
            }
            out.push(relocate(b, invocation, m.name));
        }
        return out;
    }

    evalCondition(args: Token[], file: string): boolean {
        // Resolve __has_include(...) before macro expansion (its operand must not be expanded).
        const pre: Token[] = [];
        for (let i = 0; i < args.length; i++) {
            const t = args[i];
            if ((t.text === '__has_include' || t.text === '__has_include_next') && args[i + 1]?.text === '(') {
                const collected = collectArgs(args, i + 1);
                if (collected) {
                    const spec = this.includeSpec(collected.args[0] ?? []);
                    const found = spec ? !!this.opts.resolver.resolve(spec.name, spec.angled, file).file : false;
                    pre.push({ ...t, kind: 'num', text: found ? '1' : '0' });
                    i = collected.end;
                    continue;
                }
            }
            pre.push(t);
        }
        const toks = this.expand(pre, new Set(), true);
        try {
            const v = new ExprEvaluator(toks, this.macros).evaluate();
            return v !== 0;
        } catch {
            // An expression we cannot evaluate: assume the branch is taken (see more code rather than less).
            return true;
        }
    }
}

function relocate(b: Token, at: Token, macro: string): Token {
    return { ...b, file: at.file, line: at.line, col: at.col, macro };
}

/** Collect macro arguments starting at the '(' at `open`. */
function collectArgs(tokens: Token[], open: number): { args: Token[][]; end: number } | undefined {
    const args: Token[][] = [[]];
    let depth = 0;
    for (let j = open; j < tokens.length; j++) {
        const t = tokens[j];
        if (t.text === '(') {
            if (depth++ > 0) args[args.length - 1].push(t);
        } else if (t.text === ')') {
            if (--depth === 0) {
                if (args.length === 1 && args[0].length === 0) return { args: [], end: j };
                return { args, end: j };
            }
            args[args.length - 1].push(t);
        } else if (t.text === ',' && depth === 1) {
            args.push([]);
        } else {
            args[args.length - 1].push(t);
        }
    }
    return undefined;
}

/** Evaluates #if expressions (C integer arithmetic on JS numbers). */
class ExprEvaluator {
    private i = 0;
    constructor(private readonly toks: Token[], private readonly macros: Map<string, Macro>) {}

    evaluate(): number {
        const v = this.ternary();
        if (this.i < this.toks.length) throw new Error('trailing tokens');
        return v;
    }

    private peek(): string | undefined { return this.toks[this.i]?.text; }
    private next(): Token {
        const t = this.toks[this.i++];
        if (!t) throw new Error('unexpected end');
        return t;
    }
    private accept(op: string): boolean {
        if (this.peek() === op) { this.i++; return true; }
        return false;
    }

    private ternary(): number {
        const c = this.binary(0);
        if (this.accept('?')) {
            const a = this.ternary();
            if (!this.accept(':')) throw new Error('expected :');
            const b = this.ternary();
            return c ? a : b;
        }
        return c;
    }

    private static readonly LEVELS: string[][] = [
        ['||'], ['&&'], ['|'], ['^'], ['&'], ['==', '!='], ['<', '>', '<=', '>='], ['<<', '>>'], ['+', '-'], ['*', '/', '%'],
    ];

    private binary(level: number): number {
        if (level >= ExprEvaluator.LEVELS.length) return this.unary();
        let left = this.binary(level + 1);
        for (;;) {
            const op = this.peek();
            if (!op || !ExprEvaluator.LEVELS[level].includes(op)) return left;
            this.i++;
            const right = this.binary(level + 1);
            left = applyOp(op, left, right);
        }
    }

    private unary(): number {
        const t = this.peek();
        if (t === '!') { this.i++; return this.unary() ? 0 : 1; }
        if (t === '-') { this.i++; return -this.unary(); }
        if (t === '+') { this.i++; return this.unary(); }
        if (t === '~') { this.i++; return ~this.unary(); }
        return this.primary();
    }

    private primary(): number {
        const t = this.next();
        if (t.text === '(') {
            const v = this.ternary();
            if (!this.accept(')')) throw new Error('expected )');
            return v;
        }
        if (t.text === 'defined') {
            const paren = this.accept('(');
            const name = this.next().text;
            if (paren && !this.accept(')')) throw new Error('expected )');
            return this.macros.has(name) ? 1 : 0;
        }
        if (t.kind === 'num') return parseCNumber(t.text);
        if (t.kind === 'char') return t.text.replace(/^[LuU8]*'/, '').charCodeAt(0) || 0;
        if (t.kind === 'id') {
            if (t.text === 'true') return 1;
            // Unknown function-like macro: we cannot evaluate it.
            if (this.peek() === '(') throw new Error(`unknown macro ${t.text}`);
            return 0;
        }
        throw new Error(`unexpected ${t.text}`);
    }
}

function applyOp(op: string, a: number, b: number): number {
    switch (op) {
        case '||': return a || b ? 1 : 0;
        case '&&': return a && b ? 1 : 0;
        case '|': return a | b;
        case '^': return a ^ b;
        case '&': return a & b;
        case '==': return a === b ? 1 : 0;
        case '!=': return a !== b ? 1 : 0;
        case '<': return a < b ? 1 : 0;
        case '>': return a > b ? 1 : 0;
        case '<=': return a <= b ? 1 : 0;
        case '>=': return a >= b ? 1 : 0;
        case '<<': return a * Math.pow(2, b);
        case '>>': return Math.floor(a / Math.pow(2, b));
        case '+': return a + b;
        case '-': return a - b;
        case '*': return a * b;
        case '/': if (!b) throw new Error('division by zero'); return Math.trunc(a / b);
        case '%': if (!b) throw new Error('division by zero'); return a % b;
    }
    throw new Error(`bad operator ${op}`);
}

export function parseCNumber(text: string): number {
    const s = text.replace(/'/g, '').replace(/[uUlLzZ]+$/, '');
    if (/^0[xX]/.test(s)) return parseInt(s.slice(2), 16);
    if (/^0[bB]/.test(s)) return parseInt(s.slice(2), 2);
    if (/^0[0-7]+$/.test(s)) return parseInt(s, 8);
    const v = Number(s);
    if (Number.isNaN(v)) throw new Error(`bad number ${text}`);
    return v;
}
