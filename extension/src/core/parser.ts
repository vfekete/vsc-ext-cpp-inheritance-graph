/**
 * Declaration-level C++ parser. It does not try to understand expressions or
 * function bodies; it tracks namespaces / classes, and extracts class heads,
 * base clauses and member declarations. Anything it does not understand is
 * skipped up to the next `;` or balanced `{...}` block.
 */
import { Access, BaseSpec, ClassInfo, ClassKind, MemberInfo, SourceLoc } from './model';
import { Token, joinTokens } from './tokenizer';

export interface AliasInfo {
    /** Fully qualified alias name. */
    id: string;
    /** Aliased type as written. */
    target: string;
    /** Scope in which `target` must be looked up. */
    scope: string[];
    usingNamespaces: string[];
}

export interface ParseResult {
    classes: ClassInfo[];
    aliases: Map<string, AliasInfo>;
}

interface Scope {
    kind: 'namespace' | 'class' | 'block';
    names: string[];
    usings: string[];
    cls?: ClassInfo;
}

interface TemplateHeader { text: string; names: string[] }

const CLASS_KEYS = new Set(['class', 'struct', 'union']);
const ACCESS = new Set(['public', 'protected', 'private']);
const DECL_SPECIFIERS = new Set([
    'virtual', 'static', 'inline', 'explicit', 'constexpr', 'consteval', 'constinit', 'friend', 'mutable',
    'thread_local', 'extern', 'register', 'typename',
]);
const KEYWORDS = new Set([
    'const', 'volatile', 'unsigned', 'signed', 'int', 'long', 'short', 'char', 'bool', 'float', 'double', 'void',
    'auto', 'operator', 'return', 'noexcept', 'override', 'final', 'decltype', 'sizeof', 'template', 'typename',
    'class', 'struct', 'union', 'enum', 'namespace', 'using', 'typedef', 'public', 'protected', 'private',
    'virtual', 'static', 'inline', 'explicit', 'constexpr', 'friend', 'mutable', 'default', 'delete', 'new',
    'this', 'true', 'false', 'nullptr', 'requires', 'concept', 'co_await', 'throw', 'wchar_t', 'char8_t',
    'char16_t', 'char32_t', 'size_t',
]);

export function parseTokens(tokens: Token[]): ParseResult {
    return new Parser(tokens).parse();
}

class Parser {
    private pos = 0;
    private readonly scopes: Scope[] = [{ kind: 'namespace', names: [], usings: [] }];
    private readonly classes: ClassInfo[] = [];
    private readonly aliases = new Map<string, AliasInfo>();
    private guard = 0;

    constructor(private readonly toks: Token[]) {}

    parse(): ParseResult {
        while (this.pos < this.toks.length) {
            const before = this.pos;
            this.parseNamespaceBody();
            // Stray '}' at top level (unbalanced input): skip it.
            if (this.peek() === '}') this.pos++;
            if (this.pos === before) this.pos++;
        }
        return { classes: this.classes, aliases: this.aliases };
    }

    // ---------------------------------------------------------------- helpers

    private peek(k = 0): string | undefined { return this.toks[this.pos + k]?.text; }
    private tok(k = 0): Token | undefined { return this.toks[this.pos + k]; }
    private eof(): boolean { return this.pos >= this.toks.length; }

    /** Skip a balanced group starting at the current opening token; returns the tokens inside. */
    private skipBalanced(): Token[] {
        const open = this.peek();
        const close = open === '(' ? ')' : open === '[' ? ']' : open === '{' ? '}' : '>';
        const inner: Token[] = [];
        let depth = 0;
        while (!this.eof()) {
            const t = this.toks[this.pos++];
            if (t.text === open) {
                if (depth++ > 0) inner.push(t);
            } else if (t.text === close) {
                if (--depth === 0) return inner;
                inner.push(t);
            } else if (open === '<' && t.text === '>>') {
                depth -= 2;
                if (depth <= 0) return inner;
                inner.push(t);
            } else if (open === '<' && (t.text === '(' || t.text === '[' || t.text === '{')) {
                // Nested brackets inside template arguments.
                this.pos--;
                const sub = this.skipBalanced();
                inner.push(t, ...sub, { ...t, text: t.text === '(' ? ')' : t.text === '[' ? ']' : '}' });
            } else if (open === '<' && (t.text === ';' || t.text === '{' || t.text === '}')) {
                // Not template arguments after all (e.g. `a < b;`): stop.
                this.pos--;
                return inner;
            } else {
                inner.push(t);
            }
        }
        return inner;
    }

    private currentScopeNames(): string[] {
        return this.scopes.flatMap(s => s.names);
    }

    private currentUsings(): string[] {
        return this.scopes.flatMap(s => s.usings);
    }

    private loc(t: Token): SourceLoc {
        return { file: t.file, line: t.line, column: t.col };
    }

    // ---------------------------------------------------------------- namespace level

    private parseNamespaceBody(): void {
        let template: TemplateHeader | undefined;
        while (!this.eof()) {
            const t = this.peek()!;
            if (t === '}') return;
            const before = this.pos;
            if (t === ';') {
                this.pos++;
            } else if (t === 'namespace' || (t === 'inline' && this.peek(1) === 'namespace')) {
                this.parseNamespace();
            } else if (t === 'extern' && this.tok(1)?.kind === 'str' && this.peek(2) === '{') {
                this.pos += 3;
                this.parseNamespaceBody();
                if (this.peek() === '}') this.pos++;
            } else if (t === 'using') {
                this.parseUsing();
            } else if (t === 'typedef') {
                this.parseTypedef();
            } else if (t === 'template') {
                template = this.parseTemplateHeader();
                if (template) continue;
                this.skipDeclaration();
            } else if (t === 'export' && this.peek(1) !== '{') {
                this.pos++;
                continue;
            } else if (CLASS_KEYS.has(t)) {
                const cls = this.tryParseClass(template);
                if (cls !== undefined) this.skipDeclaration();
                else { this.pos = before; this.skipDeclaration(); }
            } else {
                this.skipDeclaration();
            }
            template = undefined;
            if (this.pos === before) this.pos++;
            if (++this.guard > this.toks.length * 4) return;
        }
    }

    private parseNamespace(): void {
        if (this.peek() === 'inline') this.pos++;
        this.pos++; // namespace
        const names: string[] = [];
        while (!this.eof()) {
            const t = this.tok()!;
            if (t.text === '[' && this.peek(1) === '[') { this.skipBalanced(); continue; }
            if (t.text === 'inline') { this.pos++; continue; }
            if (t.kind === 'id') { names.push(t.text); this.pos++; continue; }
            if (t.text === '::') { this.pos++; continue; }
            break;
        }
        if (this.peek() === '=') {
            const target: Token[] = [];
            this.pos++;
            while (!this.eof() && this.peek() !== ';') target.push(this.toks[this.pos++]);
            this.pos++;
            const id = [...this.currentScopeNames(), ...names].join('::');
            this.aliases.set(id, { id, target: joinTokens(target), scope: this.currentScopeNames(), usingNamespaces: this.currentUsings() });
            return;
        }
        if (this.peek() !== '{') { this.skipDeclaration(); return; }
        this.pos++;
        this.scopes.push({ kind: 'namespace', names, usings: [] });
        this.parseNamespaceBody();
        this.scopes.pop();
        if (this.peek() === '}') this.pos++;
    }

    private parseUsing(): void {
        this.pos++; // using
        if (this.peek() === 'namespace') {
            this.pos++;
            const parts: Token[] = [];
            while (!this.eof() && this.peek() !== ';') parts.push(this.toks[this.pos++]);
            this.pos++;
            this.scopes[this.scopes.length - 1].usings.push(joinTokens(parts).replace(/^::/, ''));
            return;
        }
        const decl: Token[] = [];
        while (!this.eof() && this.peek() !== ';' && this.peek() !== '}') {
            if (this.peek() === '{' || this.peek() === '(') { decl.push(...this.skipBalanced()); continue; }
            decl.push(this.toks[this.pos++]);
        }
        if (this.peek() === ';') this.pos++;
        const eq = decl.findIndex(t => t.text === '=');
        const scope = this.currentScopeNames();
        if (eq === 1 && decl[0].kind === 'id') {
            // using Name = Type;
            const id = [...scope, decl[0].text].join('::');
            this.aliases.set(id, { id, target: joinTokens(decl.slice(eq + 1)), scope, usingNamespaces: this.currentUsings() });
        } else if (eq < 0 && decl.length >= 3 && decl[decl.length - 1].kind === 'id') {
            // using ns::Name;
            const name = decl[decl.length - 1].text;
            const id = [...scope, name].join('::');
            if (this.scopes[this.scopes.length - 1].kind === 'namespace') {
                this.aliases.set(id, { id, target: joinTokens(decl).replace(/^typename\s+/, ''), scope, usingNamespaces: this.currentUsings() });
            }
        }
    }

    private parseTypedef(): void {
        this.pos++; // typedef
        const scope = this.currentScopeNames();
        if (CLASS_KEYS.has(this.peek() ?? '')) {
            const start = this.pos;
            const cls = this.tryParseClass(undefined, true);
            if (cls !== undefined) {
                // typedef struct [Tag] {...} Name, *PName;
                const decl: Token[] = [];
                while (!this.eof() && this.peek() !== ';' && this.peek() !== '}') decl.push(this.toks[this.pos++]);
                if (this.peek() === ';') this.pos++;
                const nameTok = decl.find(t => t.kind === 'id');
                if (nameTok) {
                    if (cls && !cls.name) {
                        cls.name = nameTok.text;
                        cls.id = [...cls.scope, cls.name].join('::');
                        cls.loc = this.loc(nameTok);
                        this.classes.push(cls);
                    } else if (cls) {
                        const id = [...scope, nameTok.text].join('::');
                        if (id !== cls.id) this.aliases.set(id, { id, target: cls.id, scope: [], usingNamespaces: [] });
                    }
                }
                return;
            }
            this.pos = start;
        }
        const decl: Token[] = [];
        while (!this.eof() && this.peek() !== ';' && this.peek() !== '}') {
            if (this.peek() === '(' || this.peek() === '[' || this.peek() === '{') { this.skipBalanced(); decl.push({ ...this.toks[this.pos - 1], text: '()' }); continue; }
            decl.push(this.toks[this.pos++]);
        }
        if (this.peek() === ';') this.pos++;
        const last = decl[decl.length - 1];
        if (last && last.kind === 'id' && decl.length >= 2) {
            const id = [...scope, last.text].join('::');
            const target = decl.slice(0, -1).filter(t => !/^(const|volatile)$/.test(t.text));
            if (!target.some(t => t.text === '*' || t.text === '&' || t.text === '()')) {
                this.aliases.set(id, { id, target: joinTokens(target), scope, usingNamespaces: this.currentUsings() });
            }
        }
    }

    private parseTemplateHeader(): TemplateHeader | undefined {
        if (this.peek(1) !== '<') return undefined; // explicit instantiation
        this.pos++; // template
        const inner = this.skipBalanced();
        const names: string[] = [];
        // Split at top-level commas.
        let depth = 0;
        let current: Token[] = [];
        const finish = () => {
            const eq = current.findIndex(t => t.text === '=');
            const head = eq < 0 ? current : current.slice(0, eq);
            const name = [...head].reverse().find(t => t.kind === 'id' && !KEYWORDS.has(t.text));
            if (name && head.length > 1) names.push(name.text);
            current = [];
        };
        for (const t of inner) {
            if (t.text === '<' || t.text === '(') depth++;
            else if (t.text === '>' || t.text === ')') depth--;
            if (t.text === ',' && depth === 0) finish();
            else current.push(t);
        }
        if (current.length) finish();
        return { text: `<${joinTokens(inner)}>`, names };
    }

    /**
     * Generic skip: up to and including the next top-level `;`, or up to the end of a
     * function body. Never consumes a `}` that closes the enclosing scope.
     */
    private skipDeclaration(): void {
        let prev: Token | undefined;
        let sawParenGroup = false;
        while (!this.eof()) {
            const t = this.tok()!;
            if (t.text === ';') { this.pos++; return; }
            if (t.text === '}') return;
            if (t.text === '(' || t.text === '[') {
                this.skipBalanced();
                sawParenGroup = sawParenGroup || t.text === '(';
                prev = this.toks[this.pos - 1];
                continue;
            }
            if (t.text === '{') {
                const initializer = prev?.text === '=' || prev?.text === ',' || prev?.text === 'return';
                this.skipBalanced();
                if (!initializer && (sawParenGroup || prev?.kind === 'id' || prev?.text === '>')) {
                    // Function body, or a braced declaration such as `enum E {...}`.
                    if (this.peek() === ';') this.pos++;
                    return;
                }
                prev = this.toks[this.pos - 1];
                continue;
            }
            // A macro invocation without trailing ';' followed by a new declaration.
            if (prev?.text === ')' && (CLASS_KEYS.has(t.text) || t.text === 'namespace' || t.text === 'template')
                && this.scopes[this.scopes.length - 1].kind === 'namespace') {
                return;
            }
            prev = t;
            this.pos++;
        }
    }

    // ---------------------------------------------------------------- classes

    /**
     * Parse `class-key [attrs] name [final] [: bases] { body }` at the current position.
     * Returns the class (or null for an anonymous class) when a definition was consumed, or
     * undefined when this is not a class definition (position is then unspecified).
     */
    private tryParseClass(template: TemplateHeader | undefined, allowAnonymous = false): ClassInfo | null | undefined {
        const keyTok = this.toks[this.pos++];
        const kind = keyTok.text as ClassKind;
        let nameParts: string[] = [];
        let nameTok: Token | undefined;
        let specArgs = '';
        let isFinal = false;
        for (;;) {
            const t = this.tok();
            if (!t) return undefined;
            if (t.text === '[' && this.peek(1) === '[') { this.skipBalanced(); continue; }
            if (t.kind === 'id') {
                if ((t.text === 'final' || t.text === 'sealed') && nameParts.length && (this.peek(1) === ':' || this.peek(1) === '{')) {
                    isFinal = true;
                    this.pos++;
                    continue;
                }
                if (this.peek(1) === '(') {
                    // alignas(...), __declspec(...), __attribute__((...)), EXPORT_MACRO(...)
                    this.pos++;
                    this.skipBalanced();
                    continue;
                }
                nameParts = [t.text];
                nameTok = t;
                specArgs = '';
                this.pos++;
                while (this.peek() === '::' && this.tok(1)?.kind === 'id') {
                    nameParts.push(this.tok(1)!.text);
                    nameTok = this.tok(1);
                    this.pos += 2;
                }
                continue;
            }
            if (t.text === '::') { this.pos++; continue; }
            if (t.text === '<' && nameParts.length) {
                specArgs = `<${joinTokens(this.skipBalanced())}>`;
                continue;
            }
            if (t.text === ':' || t.text === '{') break;
            return undefined;
        }
        if (!nameParts.length && !allowAnonymous && this.peek() !== '{') return undefined;

        const bases: BaseSpec[] = [];
        if (this.peek() === ':') {
            this.pos++;
            if (!this.parseBaseClause(kind, bases)) return undefined;
        }
        if (this.peek() !== '{') return undefined;
        this.pos++;

        const outer = this.currentScopeNames();
        const scope = [...outer, ...nameParts.slice(0, -1)];
        const name = nameParts.length ? nameParts[nameParts.length - 1] + specArgs : '';
        const cls: ClassInfo = {
            id: name ? [...scope, name].join('::') : '',
            name,
            scope,
            kind,
            templateParams: template?.text,
            templateParamNames: template?.names.length ? template.names : undefined,
            isFinal: isFinal || undefined,
            bases,
            members: [],
            loc: this.loc(nameTok ?? keyTok),
            usingNamespaces: this.currentUsings(),
            sources: ['parser'],
        };
        this.scopes.push({ kind: 'class', names: name ? [...nameParts.slice(0, -1), name] : [], usings: [], cls });
        this.parseClassBody(cls);
        this.scopes.pop();
        if (this.peek() === '}') this.pos++;
        if (cls.members.some(m => m.isPure)) cls.isAbstract = true;
        if (!name) return allowAnonymous ? cls : null;
        this.classes.push(cls);
        return cls;
    }

    private parseBaseClause(kind: ClassKind, bases: BaseSpec[]): boolean {
        for (;;) {
            let access: Access = kind === 'class' ? 'private' : 'public';
            let isVirtual = false;
            while (this.peek() && (ACCESS.has(this.peek()!) || this.peek() === 'virtual')) {
                const w = this.toks[this.pos++].text;
                if (w === 'virtual') isVirtual = true;
                else access = w as Access;
            }
            const typeToks: Token[] = [];
            let nameTok: Token | undefined;
            while (!this.eof()) {
                const t = this.tok()!;
                if (t.text === ',' || t.text === '{') break;
                if (t.text === ';' || t.text === '}') return false;
                if (t.text === '<') {
                    const inner = this.skipBalanced();
                    typeToks.push(t, ...inner, { ...t, text: '>' });
                    continue;
                }
                if (t.text === '(') {
                    // decltype(...) or a macro with arguments
                    const inner = this.skipBalanced();
                    typeToks.push(t, ...inner, { ...t, text: ')' });
                    continue;
                }
                if (t.kind === 'id' && t.text !== 'typename' && t.text !== 'template') nameTok = t;
                if (t.text !== '...' && t.text !== 'typename') typeToks.push(t);
                this.pos++;
            }
            if (typeToks.length) {
                bases.push({ name: joinTokens(typeToks), access, isVirtual, loc: nameTok ? this.loc(nameTok) : undefined });
            }
            if (this.peek() === ',') { this.pos++; continue; }
            return this.peek() === '{';
        }
    }

    private parseClassBody(cls: ClassInfo): void {
        let access: Access = cls.kind === 'class' ? 'private' : 'public';
        let template: TemplateHeader | undefined;
        while (!this.eof() && this.peek() !== '}') {
            const before = this.pos;
            const t = this.peek()!;
            if (ACCESS.has(t) && this.peek(1) === ':') {
                access = t as Access;
                this.pos += 2;
                continue;
            }
            if (ACCESS.has(t) && this.tok(1)?.kind === 'id' && this.peek(2) === ':') {
                // Qt: `public slots:`
                access = t as Access;
                this.pos += 3;
                continue;
            }
            if (/^(signals|Q_SIGNALS|slots|Q_SLOTS)$/.test(t) && this.peek(1) === ':') {
                this.pos += 2;
                continue;
            }
            if (t === ';') { this.pos++; continue; }
            if (t === 'template') {
                template = this.parseTemplateHeader();
                if (template) continue;
                this.skipDeclaration();
            } else if (CLASS_KEYS.has(t)) {
                const nested = this.tryParseClass(template);
                if (nested !== undefined) {
                    // Declarators after the body become fields: `struct Style {...} style;`
                    this.parseMember(cls, access, nested?.name ?? '');
                } else {
                    this.pos = before;
                    this.parseMember(cls, access);
                }
            } else if (t === 'enum') {
                while (!this.eof() && this.peek() !== '{' && this.peek() !== ';' && this.peek() !== '}') this.pos++;
                if (this.peek() === '{') this.skipBalanced();
                this.parseMember(cls, access, 'enum');
            } else if (t === 'friend' || t === 'using' || t === 'typedef' || t === 'static_assert') {
                this.skipDeclaration();
            } else {
                this.parseMember(cls, access);
            }
            template = undefined;
            if (this.pos === before) this.pos++;
        }
    }

    /**
     * Parse one member declaration (field(s), method or method definition).
     * `typePrefix` is used for declarators that follow a nested class / enum body.
     */
    private parseMember(cls: ClassInfo, access: Access, typePrefix?: string): void {
        const decl: Token[] = [];
        let paramsSeen = false;
        let ended = false;
        while (!this.eof()) {
            const t = this.tok()!;
            if (t.text === ';') { this.pos++; ended = true; break; }
            if (t.text === '}') break;
            if (ACCESS.has(t.text) && this.peek(1) === ':') {
                // Previous "declaration" was a macro such as Q_OBJECT without ';'.
                return;
            }
            if (t.text === '(') {
                decl.push(t, ...this.skipBalanced(), { ...t, text: ')' });
                paramsSeen = true;
                continue;
            }
            if (t.text === '[') {
                decl.push(t, ...this.skipBalanced(), { ...t, text: ']' });
                continue;
            }
            if (t.text === '{') {
                const prev = decl[decl.length - 1];
                const trailingReturn = decl.some(d => d.text === '->');
                const isInit = !paramsSeen || prev?.text === '='
                    || (prev?.kind === 'id' && !isTrailingQualifier(prev.text) && !trailingReturn);
                this.skipBalanced();
                if (isInit) {
                    decl.push({ ...t, text: '{}' });
                    continue;
                }
                // Function body.
                if (this.peek() === ';') this.pos++;
                ended = true;
                break;
            }
            if (t.text === ':' && paramsSeen && decl[decl.length - 1]?.text === ')' ) {
                // Constructor initializer list: skip to the body.
                this.pos++;
                this.skipCtorInitializers();
                ended = true;
                break;
            }
            decl.push(t);
            this.pos++;
        }
        if (!ended && !decl.length) return;
        this.analyzeMember(cls, access, decl, typePrefix);
    }

    private skipCtorInitializers(): void {
        let prev: Token | undefined;
        while (!this.eof()) {
            const t = this.tok()!;
            if (t.text === '(' ) { this.skipBalanced(); prev = this.toks[this.pos - 1]; continue; }
            if (t.text === '{') {
                const isBody = prev && (prev.text === ')' || prev.text === '}' || prev.text === '...');
                this.skipBalanced();
                prev = this.toks[this.pos - 1];
                if (isBody) return;
                continue;
            }
            if (t.text === ';' || t.text === '}') return;
            prev = t;
            this.pos++;
        }
    }

    private analyzeMember(cls: ClassInfo, access: Access, decl: Token[], typePrefix?: string): void {
        // Drop attributes.
        decl = stripAttributes(decl);
        if (!decl.length) {
            return;
        }
        const plainName = cls.name.replace(/<.*$/, '');

        // Find the function declarator's '(' at top level, before any top-level '='.
        let angle = 0;
        let fnParen = -1;
        let opIdx = -1;
        for (let i = 0; i < decl.length; i++) {
            const t = decl[i];
            if (t.text === 'operator') { opIdx = i; break; }
            if (t.text === '=' && angle === 0) break;
            if (t.text === '<' && i > 0 && decl[i - 1].kind === 'id') angle++;
            else if (t.text === '>' && angle > 0) angle--;
            else if (t.text === '>>' && angle > 0) angle = Math.max(0, angle - 2);
            else if (t.text === '(' && angle === 0) {
                // Function pointer / reference field: `void (*cb)(int)`
                if (decl[i + 1]?.text === '*' || decl[i + 1]?.text === '&' || decl[i + 1]?.text === '^') break;
                fnParen = i;
                break;
            }
        }
        if (opIdx >= 0) {
            // operator X ( ... )
            let j = opIdx + 1;
            if (decl[j]?.text === '(' && decl[j + 1]?.text === ')') j += 2;
            while (j < decl.length && decl[j].text !== '(') j++;
            if (j >= decl.length) return;
            const nameToks = decl.slice(opIdx, j);
            const name = 'operator' + joinTokens(nameToks.slice(1)).replace(/^(?=[a-zA-Z_])/, ' ');
            this.addMethod(cls, access, decl, opIdx, j, name, 'operator');
            return;
        }
        if (fnParen > 0) {
            const nameTok = decl[fnParen - 1];
            if (nameTok.kind !== 'id') return;
            let nameStart = fnParen - 1;
            let kind: MemberInfo['kind'] = 'method';
            let name = nameTok.text;
            if (decl[fnParen - 2]?.text === '~') {
                kind = 'destructor';
                name = '~' + name;
                nameStart--;
            } else if (name === plainName && (fnParen === 1 || decl.slice(0, fnParen - 1).every(t => DECL_SPECIFIERS.has(t.text) || t.text === 'constexpr'))) {
                kind = 'constructor';
            }
            const typeToks = decl.slice(0, nameStart).filter(t => !DECL_SPECIFIERS.has(t.text));
            if (kind === 'method' && !typeToks.length && !hasTrailingReturn(decl, fnParen)) {
                // Looks like a macro invocation (Q_PROPERTY(...), DECLARE_SOMETHING(x)): ignore.
                return;
            }
            this.addMethod(cls, access, decl, nameStart, fnParen, name, kind);
            return;
        }
        // Fields: split declarators at top-level commas.
        const declarators: Token[][] = [[]];
        let depth = 0;
        angle = 0;
        for (let i = 0; i < decl.length; i++) {
            const t = decl[i];
            if (t.text === '(' || t.text === '[') depth++;
            else if (t.text === ')' || t.text === ']') depth--;
            else if (t.text === '<' && i > 0 && decl[i - 1].kind === 'id') angle++;
            else if (t.text === '>' && angle > 0) angle--;
            else if (t.text === '>>' && angle > 0) angle = Math.max(0, angle - 2);
            if (t.text === ',' && depth === 0 && angle === 0) declarators.push([]);
            else declarators[declarators.length - 1].push(t);
        }
        let baseType: Token[] | undefined;
        for (const d of declarators) {
            const cut = d.findIndex(t => t.text === '=' || t.text === '{}' || t.text === ':');
            let head = cut < 0 ? d : d.slice(0, cut);
            while (head.length && head[head.length - 1].text === ']') {
                const open = lastIndexOf(head, '[');
                if (open < 0) break;
                head = head.slice(0, open);
            }
            let nameIdx = head.length - 1;
            // Function pointer declarator: (*name)(args)
            const fpOpen = head.findIndex((t, i) => t.text === '(' && (head[i + 1]?.text === '*' || head[i + 1]?.text === '&'));
            if (fpOpen >= 0) {
                nameIdx = head.findIndex((t, i) => i > fpOpen && t.kind === 'id');
            }
            const nameTok = head[nameIdx];
            if (!nameTok || nameTok.kind !== 'id' || KEYWORDS.has(nameTok.text)) continue;
            const specifiers = head.slice(0, nameIdx).filter(t => DECL_SPECIFIERS.has(t.text));
            let typeToks = fpOpen >= 0 ? head.filter((_, i) => i !== nameIdx) : head.slice(0, nameIdx);
            typeToks = typeToks.filter(t => !DECL_SPECIFIERS.has(t.text));
            if (!baseType) {
                baseType = typeToks.filter(t => t.text !== '*' && t.text !== '&' && t.text !== '&&');
            } else {
                typeToks = [...baseType, ...typeToks];
            }
            let type = joinTokens(typeToks);
            if (typePrefix) type = type ? `${typePrefix} ${type}` : typePrefix;
            if (!type) continue; // e.g. a lone macro such as Q_OBJECT
            cls.members.push({
                name: nameTok.text,
                kind: 'field',
                access,
                type,
                isStatic: specifiers.some(s => s.text === 'static') || undefined,
                loc: this.loc(nameTok),
            });
        }
    }

    private addMethod(cls: ClassInfo, access: Access, decl: Token[], nameStart: number, parenIdx: number, name: string, kind: MemberInfo['kind']): void {
        const prefix = decl.slice(0, nameStart);
        // Matching ')' of the parameter list.
        let depth = 0;
        let close = parenIdx;
        for (let i = parenIdx; i < decl.length; i++) {
            if (decl[i].text === '(') depth++;
            else if (decl[i].text === ')' && --depth === 0) { close = i; break; }
        }
        const params = decl.slice(parenIdx + 1, close);
        const suffix = decl.slice(close + 1);
        let type = joinTokens(prefix.filter(t => !DECL_SPECIFIERS.has(t.text)));
        const arrow = suffix.findIndex(t => t.text === '->');
        if (arrow >= 0) {
            const end = suffix.findIndex((t, i) => i > arrow && (t.text === '=' || t.text === 'override' || t.text === 'final' || t.text === 'requires'));
            type = joinTokens(suffix.slice(arrow + 1, end < 0 ? undefined : end));
        }
        const eq = suffix.findIndex(t => t.text === '=');
        const nameTok = decl[kind === 'destructor' ? nameStart + 1 : nameStart];
        cls.members.push({
            name,
            kind,
            access,
            type: kind === 'constructor' || kind === 'destructor' ? '' : type,
            params: `(${joinTokens(params)})`,
            isStatic: prefix.some(t => t.text === 'static') || undefined,
            isVirtual: prefix.some(t => t.text === 'virtual') || suffix.some(t => t.text === 'override' || t.text === 'final') || undefined,
            isPure: (eq >= 0 && suffix[eq + 1]?.text === '0') || undefined,
            isConst: suffix.slice(0, arrow < 0 ? undefined : arrow).some(t => t.text === 'const') || undefined,
            isOverride: suffix.some(t => t.text === 'override') || undefined,
            loc: this.loc(nameTok),
        });
    }
}

function isTrailingQualifier(text: string): boolean {
    return text === 'const' || text === 'override' || text === 'final' || text === 'noexcept' || text === 'volatile';
}

function hasTrailingReturn(decl: Token[], paren: number): boolean {
    return decl.slice(paren).some(t => t.text === '->');
}

function lastIndexOf(toks: Token[], text: string): number {
    for (let i = toks.length - 1; i >= 0; i--) if (toks[i].text === text) return i;
    return -1;
}

function stripAttributes(decl: Token[]): Token[] {
    const out: Token[] = [];
    for (let i = 0; i < decl.length; i++) {
        if (decl[i].text === '[' && decl[i + 1]?.text === '[') {
            let depth = 0;
            for (; i < decl.length; i++) {
                if (decl[i].text === '[') depth++;
                else if (decl[i].text === ']' && --depth === 0) break;
            }
            continue;
        }
        if ((decl[i].text === '__attribute__' || decl[i].text === '__declspec' || decl[i].text === 'alignas') && decl[i + 1]?.text === '(') {
            let depth = 0;
            for (i = i + 1; i < decl.length; i++) {
                if (decl[i].text === '(') depth++;
                else if (decl[i].text === ')' && --depth === 0) break;
            }
            continue;
        }
        out.push(decl[i]);
    }
    return out;
}
