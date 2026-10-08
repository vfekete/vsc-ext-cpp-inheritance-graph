/**
 * A small C/C++ tokenizer working line by line, good enough for a preprocessor
 * and a declaration-level parser. Comments are removed up front while keeping
 * line/column positions intact.
 */

export type TokenKind = 'id' | 'num' | 'str' | 'char' | 'punct';

export interface Token {
    kind: TokenKind;
    text: string;
    file: string;
    /** Zero-based line. */
    line: number;
    /** Zero-based column. */
    col: number;
    /** Name of the macro this token was produced by (absent for tokens written literally). */
    macro?: string;
    /** Whitespace preceded this token (needed for `#define F(x)` vs `#define F (x)`). */
    spaceBefore?: boolean;
}

/**
 * Replace comments with spaces (newlines are preserved, so positions stay the same).
 * String, character and raw string literals are respected.
 */
export function stripComments(src: string): string {
    const out: string[] = [];
    const n = src.length;
    let i = 0;
    let segStart = 0;
    const blank = (from: number, to: number) => {
        out.push(src.slice(segStart, from));
        out.push(src.slice(from, to).replace(/[^\n]/g, ' '));
        segStart = to;
    };
    while (i < n) {
        const c = src[i];
        if (c === '/' && src[i + 1] === '/') {
            let j = i + 2;
            // A line comment continues over backslash-newline.
            while (j < n && src[j] !== '\n') {
                if (src[j] === '\\' && (src[j + 1] === '\n' || (src[j + 1] === '\r' && src[j + 2] === '\n'))) {
                    j += src[j + 1] === '\r' ? 3 : 2;
                    continue;
                }
                j++;
            }
            blank(i, j);
            i = j;
        } else if (c === '/' && src[i + 1] === '*') {
            const end = src.indexOf('*/', i + 2);
            const j = end < 0 ? n : end + 2;
            blank(i, j);
            i = j;
        } else if (c === 'R' && src[i + 1] === '"' && !isIdentChar(src[i - 1])) {
            const open = src.indexOf('(', i + 2);
            if (open < 0) { i++; continue; }
            const delim = ')' + src.slice(i + 2, open) + '"';
            const end = src.indexOf(delim, open);
            i = end < 0 ? n : end + delim.length;
        } else if (c === '"' || c === '\'') {
            // Skip a literal; an unterminated one ends at the line end.
            let j = i + 1;
            while (j < n && src[j] !== c && src[j] !== '\n') {
                j += src[j] === '\\' ? 2 : 1;
            }
            i = j + 1;
        } else {
            i++;
        }
    }
    out.push(src.slice(segStart));
    return out.join('');
}

function isIdentChar(c: string | undefined): boolean {
    return !!c && /[A-Za-z0-9_$]/.test(c);
}

const PUNCTUATORS = [
    '<<=', '>>=', '...', '->*', '<=>',
    '::', '->', '++', '--', '<<', '>>', '<=', '>=', '==', '!=', '&&', '||',
    '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '##', '.*',
];

/** Tokenize a single (comment-free) line. */
export function tokenizeLine(text: string, file: string, line: number, colOffset = 0): Token[] {
    const tokens: Token[] = [];
    const n = text.length;
    let i = 0;
    let space = true;
    while (i < n) {
        const c = text[i];
        if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v') {
            i++;
            space = true;
            continue;
        }
        const start = i;
        let kind: TokenKind;
        if (/[A-Za-z_$]/.test(c) || c.charCodeAt(0) > 127) {
            while (i < n && (isIdentChar(text[i]) || text.charCodeAt(i) > 127)) i++;
            // Encoding prefixes of string / char literals: L"", u8"", R"()" ...
            if (i < n && (text[i] === '"' || text[i] === '\'') && /^(L|u8?|U|R|LR|u8R|uR|UR)$/.test(text.slice(start, i))) {
                i = skipLiteral(text, i, text.slice(start, i).endsWith('R'));
                kind = text[i - 1] === '\'' ? 'char' : 'str';
            } else {
                kind = 'id';
            }
        } else if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(text[i + 1] ?? ''))) {
            // pp-number
            i++;
            while (i < n) {
                const d = text[i];
                if ((d === '+' || d === '-') && /[eEpP]/.test(text[i - 1])) { i++; continue; }
                if (isIdentChar(d) || d === '.' || (d === '\'' && isIdentChar(text[i + 1]))) { i++; continue; }
                break;
            }
            kind = 'num';
        } else if (c === '"' || c === '\'') {
            i = skipLiteral(text, i, false);
            kind = c === '"' ? 'str' : 'char';
        } else {
            const p = PUNCTUATORS.find(op => text.startsWith(op, i));
            i += p ? p.length : 1;
            kind = 'punct';
        }
        tokens.push({ kind, text: text.slice(start, i), file, line, col: start + colOffset, spaceBefore: space });
        space = false;
    }
    return tokens;
}

function skipLiteral(text: string, i: number, raw: boolean): number {
    const q = text[i];
    if (raw && q === '"') {
        const open = text.indexOf('(', i + 1);
        if (open >= 0) {
            const delim = ')' + text.slice(i + 1, open) + '"';
            const end = text.indexOf(delim, open);
            if (end >= 0) return end + delim.length;
        }
        return text.length;
    }
    let j = i + 1;
    while (j < text.length && text[j] !== q) j += text[j] === '\\' ? 2 : 1;
    return Math.min(j + 1, text.length);
}

/** Join tokens back into readable C++ text with sensible spacing. */
export function joinTokens(tokens: readonly Token[]): string {
    let out = '';
    let prev: Token | undefined;
    for (const t of tokens) {
        if (prev && needsSpace(prev, t)) out += ' ';
        out += t.text;
        prev = t;
    }
    return out;
}

function needsSpace(a: Token, b: Token): boolean {
    const wordish = (t: Token) => t.kind === 'id' || t.kind === 'num';
    if (wordish(a) && wordish(b)) return true;
    if (b.text === ',' || b.text === ')' || b.text === ']' || b.text === ';') return false;
    if (a.text === '(' || a.text === '[' || a.text === '::' || b.text === '::') return false;
    if (b.text === '(' ) return false;
    if (a.text === '<' || b.text === '<' || b.text === '>') return false;
    if (a.text === '>' && (b.text === '>' || b.text === '::' || b.text === '(')) return false;
    if (a.text === '~' || b.text === '...' ) return false;
    if (b.text === '*' || b.text === '&' || b.text === '&&') return false;
    if (a.text === '*' || a.text === '&' || a.text === '&&') return wordish(b);
    if (a.text === ',') return true;
    if (a.kind === 'punct' && b.kind === 'punct') return a.text === '=' || b.text === '=';
    return a.text === '=' || b.text === '=' || a.text === ':' || b.text === ':' || a.text === '>' || wordish(a) !== wordish(b);
}
