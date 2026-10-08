/**
 * Derives UML relationships other than generalization from class declarations:
 *
 *  - composition   member held by value, `unique_ptr`, `optional`, `array`, containers of values
 *  - aggregation   `shared_ptr`, containers of (shared) pointers
 *  - association   raw pointer / reference members, `weak_ptr`, views (`span`)
 *  - dependency    classes used only in method parameters or return types
 *  - realization   inheritance from an interface (only pure virtual methods, no data members)
 *
 * These are heuristics on declarations, in the spirit of clang-uml's defaults.
 */
import { ClassInfo, MemberInfo, RelationKind } from './model';
import { tokenizeLine } from './tokenizer';

export interface TypeNode {
    /** Qualified name without template arguments (`std::vector`, `core::Ref`, `int`). */
    name: string;
    /** Type arguments, if any (non-type arguments are omitted). */
    args: TypeNode[];
    /** Number of `*` declarator operators. */
    pointers: number;
    reference: boolean;
}

const QUALIFIERS = new Set(['const', 'volatile', 'typename', 'struct', 'class', 'union', 'enum', 'mutable', 'constexpr', 'static', 'inline']);
const BUILTIN_WORDS = new Set(['unsigned', 'signed', 'short', 'long', 'int', 'char', 'bool', 'float', 'double', 'void', 'auto', 'wchar_t', 'char8_t', 'char16_t', 'char32_t']);

/** Parse a C++ type string into a small tree. Returns undefined for things that are not plain types. */
export function parseType(text: string): TypeNode | undefined {
    // Split `>>` so nested template argument lists close one level per token.
    const toks = tokenizeLine(text, '', 0).flatMap(t => (t.text === '>>' ? ['>', '>'] : [t.text]));
    let i = 0;
    const parse = (): TypeNode | undefined => {
        while (QUALIFIERS.has(toks[i])) i++;
        let name = '';
        if (BUILTIN_WORDS.has(toks[i])) {
            const words: string[] = [];
            while (BUILTIN_WORDS.has(toks[i]) || toks[i] === 'const') { if (toks[i] !== 'const') words.push(toks[i]); i++; }
            name = words.join(' ');
        }
        let args: TypeNode[] = [];
        if (!name) {
            if (toks[i] === '::') i++;
            if (!/^[A-Za-z_]/.test(toks[i] ?? '')) return undefined;
            for (;;) {
                name += (name ? '::' : '') + toks[i++];
                if (toks[i] === '<') {
                    i++;
                    args = [];
                    while (i < toks.length && toks[i] !== '>') {
                        const start = i;
                        const arg = /^[A-Za-z_:]/.test(toks[i]) ? parse() : undefined;
                        if (arg) args.push(arg);
                        // Skip whatever is left of this argument (expressions, function signatures ...).
                        let depth = 0;
                        while (i < toks.length) {
                            const t = toks[i];
                            if (depth === 0 && (t === ',' || t === '>')) break;
                            if (t === '<' || t === '(' || t === '[') depth++;
                            else if (t === '>' || t === ')' || t === ']') depth--;
                            i++;
                        }
                        if (toks[i] === ',') i++;
                        if (i === start) i++;
                    }
                    i++; // '>'
                }
                if (toks[i] === '::' && /^[A-Za-z_]/.test(toks[i + 1] ?? '')) { i++; continue; }
                break;
            }
        }
        let pointers = 0;
        let reference = false;
        while (i < toks.length) {
            const t = toks[i];
            if (t === '*') pointers++;
            else if (t === '&' || t === '&&') reference = true;
            else if (t !== 'const' && t !== 'volatile') break;
            i++;
        }
        return { name, args, pointers, reference };
    };
    try {
        return parse();
    } catch {
        return undefined;
    }
}

const OWNING = new Map([['std::unique_ptr', '0..1'], ['std::optional', '0..1'], ['boost::optional', '0..1'], ['std::array', '*'], ['std::auto_ptr', '0..1']]);
const SHARED = new Set(['std::shared_ptr', 'boost::shared_ptr', 'QSharedPointer']);
const WEAK = new Set(['std::weak_ptr', 'boost::weak_ptr', 'QWeakPointer', 'QPointer', 'std::reference_wrapper']);
const VIEWS = new Set(['std::span', 'gsl::span']);
const CONTAINERS = new Set([
    'std::vector', 'std::list', 'std::forward_list', 'std::deque', 'std::set', 'std::multiset', 'std::unordered_set',
    'std::unordered_multiset', 'std::map', 'std::multimap', 'std::unordered_map', 'std::unordered_multimap', 'std::stack',
    'std::queue', 'std::priority_queue', 'std::pair', 'std::tuple', 'std::variant',
    'QList', 'QVector', 'QMap', 'QHash', 'QSet', 'boost::container::vector', 'boost::container::flat_map',
]);
/** Wrappers that do not create a relationship to their argument. */
const OPAQUE = new Set(['std::function', 'std::atomic', 'std::basic_string', 'std::string', 'std::hash', 'std::less']);

export interface TypeRelation {
    /** Class name as written. */
    name: string;
    kind: 'composition' | 'aggregation' | 'association';
    multiplicity: string;
}

/**
 * Relationships expressed by a member of this type, e.g.
 * `std::vector<std::shared_ptr<Camera>>` -> aggregation `Camera` `*`.
 */
export function relationsOfType(type: TypeNode, multiplicity = '1'): TypeRelation[] {
    const out: TypeRelation[] = [];
    const strip = (n: string) => n.replace(/^::/, '');
    const visit = (t: TypeNode, mult: string, inContainer: boolean) => {
        const name = strip(t.name);
        if (!name || BUILTIN_WORDS.has(name.split(' ')[0]) || OPAQUE.has(name)) return;
        if (t.pointers > 0 || t.reference) {
            // Pointers inside containers are usually managed collections: aggregation.
            const pointee: TypeNode = { ...t, pointers: 0, reference: false };
            for (const r of relationsOfType(pointee, inContainer ? '*' : '0..1')) {
                out.push({ ...r, kind: inContainer ? 'aggregation' : 'association', multiplicity: inContainer ? '*' : (t.reference ? '1' : '0..1') });
            }
            return;
        }
        if (OWNING.has(name)) { t.args.slice(0, 1).forEach(a => visit(a, inContainer ? '*' : OWNING.get(name)!, inContainer)); return; }
        if (SHARED.has(name)) {
            for (const a of t.args.slice(0, 1)) {
                for (const r of relationsOfType({ ...a, pointers: 0, reference: false })) out.push({ ...r, kind: 'aggregation', multiplicity: inContainer ? '*' : '0..1' });
            }
            return;
        }
        if (WEAK.has(name) || VIEWS.has(name)) {
            for (const a of t.args.slice(0, 1)) {
                for (const r of relationsOfType({ ...a, pointers: 0, reference: false })) out.push({ ...r, kind: 'association', multiplicity: VIEWS.has(name) || inContainer ? '*' : '0..1' });
            }
            return;
        }
        if (CONTAINERS.has(name)) {
            const many = !/^std::(pair|tuple|variant)$/.test(name);
            t.args.forEach(a => visit(a, many ? '*' : mult, inContainer || many));
            return;
        }
        if (name.startsWith('std::')) return;
        // A (project) class by value. Arguments of user templates are treated as associations.
        out.push({ name: t.name, kind: 'composition', multiplicity: mult });
        for (const a of t.args) {
            for (const r of relationsOfType({ ...a, pointers: 0, reference: false })) out.push({ ...r, kind: 'association', multiplicity: '*' });
        }
    };
    visit(type, multiplicity, false);
    return out;
}

/** Class names used anywhere in a type (for dependencies), outer and inner. */
export function classNamesInType(type: TypeNode): string[] {
    const names: string[] = [];
    const visit = (t: TypeNode) => {
        const n = t.name.replace(/^::/, '');
        if (n && !BUILTIN_WORDS.has(n.split(' ')[0]) && !n.startsWith('std::')) names.push(t.name);
        t.args.forEach(visit);
    };
    visit(type);
    return names;
}

/** Split a parameter list `(int a, const Foo& b = {})` into parameter types. */
export function parameterTypes(params: string): string[] {
    const inner = params.trim().replace(/^\(/, '').replace(/\)$/, '');
    if (!inner.trim() || inner.trim() === 'void') return [];
    const parts: string[] = [];
    let depth = 0;
    let cur = '';
    for (const c of inner) {
        if (c === '<' || c === '(' || c === '[' || c === '{') depth++;
        else if (c === '>' || c === ')' || c === ']' || c === '}') depth--;
        if (c === ',' && depth === 0) { parts.push(cur); cur = ''; } else cur += c;
    }
    parts.push(cur);
    return parts.map(p => {
        const noDefault = p.replace(/=.*$/s, '').trim();
        // Drop the parameter name (last identifier after the type), if there is one.
        const m = /^(.*?[\w>*&\]])\s+([A-Za-z_]\w*)$/.exec(noDefault);
        return (m ? m[1] : noDefault).trim();
    }).filter(Boolean);
}

/** An interface: has methods, all non-special methods are pure virtual, no non-static data members. */
export function isInterface(cls: ClassInfo): boolean {
    const methods = cls.members.filter(m => m.kind === 'method' || m.kind === 'operator');
    if (!methods.length) return false;
    if (cls.members.some(m => m.kind === 'field' && !m.isStatic)) return false;
    return methods.every(m => m.isPure);
}

export interface MemberRelation {
    targetName: string;
    kind: Exclude<RelationKind, 'generalization' | 'realization'>;
    multiplicity?: string;
    /** Member (or method) name that creates the relationship. */
    via: string;
    member: MemberInfo;
}

/** All composition / aggregation / association / dependency candidates of a class (names unresolved). */
export function memberRelations(cls: ClassInfo): MemberRelation[] {
    const out: MemberRelation[] = [];
    for (const m of cls.members) {
        if (m.kind === 'field') {
            const t = parseType(m.type);
            if (!t) continue;
            for (const r of relationsOfType(t)) out.push({ targetName: r.name, kind: r.kind, multiplicity: r.multiplicity, via: m.name, member: m });
        } else {
            const types = [...(m.params ? parameterTypes(m.params) : []), ...(m.type ? [m.type] : [])];
            for (const ts of types) {
                const t = parseType(ts);
                if (!t) continue;
                for (const n of classNamesInType(t)) out.push({ targetName: n, kind: 'dependency', via: `${m.name}()`, member: m });
            }
        }
    }
    return out;
}
