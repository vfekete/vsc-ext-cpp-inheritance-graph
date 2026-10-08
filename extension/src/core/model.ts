/** Shared data model. Everything here is plain JSON so it can be posted to the webview. */

/** Zero-based source position. */
export interface SourceLoc {
    file: string;
    line: number;
    column: number;
}

export type Access = 'public' | 'protected' | 'private';

export type MemberKind = 'field' | 'method' | 'constructor' | 'destructor' | 'operator';

export interface MemberInfo {
    name: string;
    kind: MemberKind;
    access: Access;
    /** Type of a field, or return type of a method ('' for constructors/destructors). */
    type: string;
    /** Parameter list text including parentheses, methods only. */
    params?: string;
    isStatic?: boolean;
    isVirtual?: boolean;
    isPure?: boolean;
    isConst?: boolean;
    isOverride?: boolean;
    loc?: SourceLoc;
}

export interface BaseSpec {
    /** Base type as written (macros expanded), e.g. `core::Observable<Node>`. */
    name: string;
    access: Access;
    isVirtual: boolean;
    /** Location of the base class name token; used for go-to-definition fallbacks. */
    loc?: SourceLoc;
    /** Location of the base class definition when a language server already reported it. */
    definition?: SourceLoc;
    /** Pre-resolved id of the base class (filled by compiler-accurate backends). */
    resolvedId?: string;
}

export type ClassKind = 'class' | 'struct' | 'union';

export interface ClassInfo {
    /** Fully qualified name without template arguments, e.g. `ui::widgets::ValueControl`. */
    id: string;
    /** Unqualified name, e.g. `ValueControl` (or `Foo<int>` for an explicit specialization). */
    name: string;
    /** Enclosing namespaces and classes, outermost first. */
    scope: string[];
    kind: ClassKind;
    /** Template parameter list text without the `template` keyword, e.g. `<typename T>`. */
    templateParams?: string;
    /** Names of the template parameters (used to recognise `class X : public T`). */
    templateParamNames?: string[];
    isFinal?: boolean;
    isAbstract?: boolean;
    bases: BaseSpec[];
    members: MemberInfo[];
    loc: SourceLoc;
    /** Namespaces made visible with `using namespace` where the class was defined. */
    usingNamespaces?: string[];
    /** Which backend(s) produced this class. */
    sources: string[];
}

export type NodeKind = 'class' | 'external' | 'templateParam' | 'unresolved';

/**
 * UML relationship kinds. `generalization` and `realization` are inheritance (realization =
 * the base is an interface); the others are derived from member and method declarations.
 */
export type RelationKind = 'generalization' | 'realization' | 'composition' | 'aggregation' | 'association' | 'dependency';

export interface GraphNode {
    id: string;
    kind: NodeKind;
    /** Short label (unqualified name). */
    label: string;
    qualifiedName: string;
    /** True for classes defined in the file / folder the graph was requested for. */
    isSeed: boolean;
    /** Why traversal stopped here (external / unresolved nodes, or classes outside the scope). */
    reason?: string;
    cls?: ClassInfo;
    /** Location to jump to for nodes without full class info. */
    loc?: SourceLoc;
    /** Only present because of a non-inheritance relationship (hidden unless that kind is shown). */
    relationOnly?: boolean;
}

export interface GraphEdge {
    kind: RelationKind;
    /** Derived class (inheritance) or owner / user (other relationships). */
    from: string;
    /** Base class (inheritance) or part / used class (other relationships). */
    to: string;
    /** Inheritance access; for member relationships the member's access. */
    access: Access;
    isVirtual: boolean;
    /** Template arguments used for the base, e.g. `<float>`. */
    templateArgs?: string;
    /** Member names (composition, aggregation, association) or method names (dependency). */
    label?: string;
    /** UML multiplicity at the target end: `1`, `0..1` or `*`. */
    multiplicity?: string;
}

export interface GraphModel {
    title: string;
    targetPath: string;
    mode: 'file' | 'folder';
    nodes: GraphNode[];
    edges: GraphEdge[];
    diagnostics: string[];
    backends: string[];
    stats: { files: number; classes: number; elapsedMs: number };
}
