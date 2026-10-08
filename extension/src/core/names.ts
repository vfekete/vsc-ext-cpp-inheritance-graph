/** Helpers for C++ qualified names. */

/** Remove all template argument lists: `a::B<int>::C<T>` -> `a::B::C`. */
export function stripTemplateArgs(name: string): string {
    let out = '';
    let depth = 0;
    for (const c of name) {
        if (c === '<') depth++;
        else if (c === '>') depth = Math.max(0, depth - 1);
        else if (depth === 0) out += c;
    }
    return out.replace(/\s+/g, ' ').trim();
}

/** Template arguments of the last component: `a::B<int, X<y>>` -> `<int, X<y>>`. */
export function trailingTemplateArgs(name: string): string | undefined {
    const n = name.trim();
    if (!n.endsWith('>')) return undefined;
    let depth = 0;
    for (let i = n.length - 1; i >= 0; i--) {
        if (n[i] === '>') depth++;
        else if (n[i] === '<' && --depth === 0) return n.slice(i);
    }
    return undefined;
}

export function lastComponent(id: string): string {
    const parts = stripTemplateArgs(id).split('::');
    return parts[parts.length - 1];
}

const BUILTIN_TYPES = new Set([
    'void', 'bool', 'char', 'wchar_t', 'char8_t', 'char16_t', 'char32_t', 'short', 'int', 'long', 'signed',
    'unsigned', 'float', 'double', 'auto', 'size_t', 'ptrdiff_t', 'int8_t', 'int16_t', 'int32_t', 'int64_t',
    'uint8_t', 'uint16_t', 'uint32_t', 'uint64_t',
]);

export function isBuiltinType(name: string): boolean {
    return stripTemplateArgs(name).split(/\s+/).every(w => BUILTIN_TYPES.has(w.replace(/^(std|::)+:*/, '')));
}
