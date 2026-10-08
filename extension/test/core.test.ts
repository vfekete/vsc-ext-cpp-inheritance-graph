import assert from 'node:assert/strict';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { findExecutable } from '../src/core/clangUml';
import { buildGraph, BuildOptions, ExternalResolver } from '../src/core/graphBuilder';
import { IncludeResolver, loadIncludeConfig, splitCommandLine, parseCompilerArgs } from '../src/core/includeConfig';
import { GraphModel } from '../src/core/model';
import { stripTemplateArgs, trailingTemplateArgs } from '../src/core/names';
import { parseTokens } from '../src/core/parser';
import { Preprocessor } from '../src/core/preprocessor';
import { DEFAULT_SETTINGS, GraphSettings, prepareBuild } from '../src/core/request';
import { stripComments, tokenizeLine } from '../src/core/tokenizer';

const WS = path.resolve(__dirname, '../../../test/mock');
const INC = path.join(WS, 'include');

function settings(over: Partial<GraphSettings> = {}): GraphSettings {
    return { ...DEFAULT_SETTINGS, clangUmlMode: 'never', ...over };
}

async function graphFor(target: string, mode: 'file' | 'folder', over: Partial<GraphSettings> = {}, tweak?: (o: BuildOptions) => void): Promise<GraphModel> {
    const opts = prepareBuild(target, mode, [WS], settings(over));
    tweak?.(opts);
    return buildGraph(opts);
}

const isInheritance = (e: GraphModel['edges'][number]) => e.kind === 'generalization' || e.kind === 'realization';

function parentsOf(g: GraphModel, id: string): string[] {
    return g.edges.filter(e => e.from === id && isInheritance(e)).map(e => e.to).sort();
}

function ancestry(g: GraphModel, id: string): string[] {
    const chain: string[] = [];
    let cur: string | undefined = id;
    while (cur) {
        chain.push(cur);
        cur = g.edges.find(e => e.from === cur && isInheritance(e))?.to;
    }
    return chain;
}

/** Parse a snippet without any includes. */
function parseSnippet(src: string) {
    const resolver = new IncludeResolver({ includeDirs: [], defines: [], forcedIncludes: [], sources: [] }, [], false);
    const pp = new Preprocessor({ resolver, overlay: new Map([['/virtual/snippet.h', src]]) });
    return parseTokens(pp.run(['/virtual/snippet.h']).tokens);
}

describe('tokenizer', () => {
    it('strips comments but keeps positions and string contents', () => {
        const src = 'int a; // c1\n/* multi\nline */ int b = "/* not a comment */";';
        const out = stripComments(src);
        assert.equal(out.length, src.length);
        assert.equal(out.split('\n').length, 3);
        assert.match(out, /"\/\* not a comment \*\/"/);
        assert.doesNotMatch(out, /c1|multi/);
    });

    it('tokenizes punctuators and literals', () => {
        const toks = tokenizeLine('a::b<c>> x = 0x1F\'00u; R"(raw)"', 'f', 0).map(t => t.text);
        assert.deepEqual(toks, ['a', '::', 'b', '<', 'c', '>>', 'x', '=', "0x1F'00u", ';', 'R"(raw)"']);
    });
});

describe('preprocessor', () => {
    it('expands function-like macros that hide inheritance', () => {
        const { classes } = parseSnippet('#define DECL(N, B) class N : public B\nDECL(Foo, Bar) { int x; };');
        assert.equal(classes.length, 1);
        assert.equal(classes[0].id, 'Foo');
        assert.equal(classes[0].bases[0].name, 'Bar');
        // Argument tokens keep their own position.
        assert.equal(classes[0].loc.line, 1);
        assert.equal(classes[0].loc.column, 5);
    });

    it('evaluates conditionals', () => {
        const { classes } = parseSnippet([
            '#define LEVEL 3',
            '#if LEVEL > 2 && !defined(NOPE)',
            'class A {};',
            '#elif 1',
            'class B {};',
            '#else',
            'class C {};',
            '#endif',
            '#if 0',
            'class D {};',
            '#endif',
            '#ifdef LEVEL',
            'class E {};',
            '#endif',
        ].join('\n'));
        assert.deepEqual(classes.map(c => c.id), ['A', 'E']);
    });

    it('supports stringize, paste and variadic macros', () => {
        const { classes } = parseSnippet([
            '#define CAT(a, b) a##b',
            '#define MAKE(name, ...) class CAT(name, Impl) : __VA_ARGS__ {}',
            'MAKE(Widget, public Base1, protected Base2);',
        ].join('\n'));
        assert.equal(classes[0].id, 'WidgetImpl');
        assert.deepEqual(classes[0].bases.map(b => [b.name, b.access]), [['Base1', 'public'], ['Base2', 'protected']]);
    });

    it('resolves computed includes through macros', () => {
        const opts = prepareBuild(path.join(INC, 'scene/node.h'), 'file', [WS], settings());
        const resolver = new IncludeResolver(opts.includeConfig, [WS], false);
        const pp = new Preprocessor({ resolver });
        const res = pp.run([path.join(INC, 'scene/node.h')]);
        assert.ok(res.files.includes(path.join(INC, 'core/refcounted.h')), 'CORE_HEADER(refcounted) must be followed');
        assert.ok(res.files.includes(path.join(INC, 'core/observable.h')));
    });
});

describe('parser', () => {
    it('handles class heads with attributes, export macros, final and templates', () => {
        const { classes } = parseSnippet([
            'namespace a::b {',
            'template <typename T, int N = 3> class [[nodiscard]] alignas(8) API_EXPORT(x) Vec final : public virtual Base<T, N>, private ::g::Other {',
            '  T data[N];',
            '};',
            'template <> struct Vec<bool, 1> : Bits {};',
            '}',
        ].join('\n'));
        const vec = classes.find(c => c.id === 'a::b::Vec')!;
        assert.ok(vec);
        assert.equal(vec.isFinal, true);
        assert.deepEqual(vec.templateParamNames, ['T', 'N']);
        assert.deepEqual(vec.bases.map(b => [b.name, b.access, b.isVirtual]), [['Base<T, N>', 'public', true], ['::g::Other', 'private', false]]);
        const spec = classes.find(c => c.id === 'a::b::Vec<bool, 1>')!;
        assert.equal(spec.bases[0].name, 'Bits');
        assert.equal(spec.bases[0].access, 'public');
    });

    it('extracts members with access, kinds and flags', () => {
        const { classes } = parseSnippet([
            'class Shape : public Base {',
            '  int hidden;',
            'public:',
            '  Shape(int a) : m_a(a), m_b{a} { body(); }',
            '  virtual ~Shape() = default;',
            '  virtual double area() const = 0;',
            '  static Shape* create(const std::map<int, std::string>& opts, int n = f(1, 2));',
            '  std::function<void(int)> onChange;',
            '  float x = 1.0f, y{2.0f};',
            'protected:',
            '  bool operator<(const Shape& o) const { return false; }',
            '  enum class Kind { A, B } kind;',
            '  struct Nested { int q; } nested;',
            '};',
        ].join('\n'));
        const shape = classes.find(c => c.id === 'Shape')!;
        const m = (name: string) => shape.members.find(x => x.name === name)!;
        assert.equal(m('hidden').access, 'private');
        assert.equal(m('Shape').kind, 'constructor');
        assert.equal(m('~Shape').kind, 'destructor');
        assert.equal(m('area').isPure, true);
        assert.equal(m('area').isConst, true);
        assert.equal(shape.isAbstract, true);
        assert.equal(m('create').isStatic, true);
        assert.equal(m('create').type, 'Shape*');
        assert.equal(m('onChange').kind, 'field');
        assert.equal(m('onChange').type, 'std::function<void(int)>');
        assert.equal(m('x').type, 'float');
        assert.equal(m('y').type, 'float');
        assert.equal(m('operator<').access, 'protected');
        assert.equal(m('kind').type, 'enum');
        assert.equal(m('nested').type, 'Nested');
        assert.ok(classes.find(c => c.id === 'Shape::Nested'), 'nested class is recorded');
    });

    it('records aliases and survives macro lines without semicolons', () => {
        const { classes, aliases } = parseSnippet([
            'namespace n {',
            'using Alias = other::Thing<int>;',
            'typedef Base Td;',
            'class X : public Alias {',
            '  Q_OBJECT',
            'public:',
            '  void f();',
            '};',
            '}',
        ].join('\n'));
        assert.equal(aliases.get('n::Alias')?.target, 'other::Thing<int>');
        assert.equal(aliases.get('n::Td')?.target, 'Base');
        const x = classes.find(c => c.id === 'n::X')!;
        assert.deepEqual(x.members.map(mm => mm.name), ['f']);
    });
});

describe('include configuration', () => {
    it('reads c_cpp_properties.json', () => {
        const cfg = loadIncludeConfig({ workspaceFolders: [WS] });
        const dirs = cfg.includeDirs.map(d => d.dir);
        assert.ok(dirs.includes(INC));
        assert.ok(dirs.includes(path.join(WS, 'third_party/acme/include')));
        assert.equal(cfg.cppStandard, 'c++17');
    });

    it('parses compiler command lines', () => {
        const args = splitCommandLine('g++ -Ifoo -I "bar baz" -isystem /sys -DX=1 -D Y -std=c++20 -include pre.h -c a.cpp');
        const parsed = parseCompilerArgs(args, '/w');
        assert.deepEqual(parsed.includeDirs.map(d => [d.dir, d.system]), [['/w/foo', false], ['/w/bar baz', false], ['/sys', true]]);
        assert.deepEqual(parsed.defines, ['X=1', 'Y']);
        assert.equal(parsed.std, 'c++20');
        assert.deepEqual(parsed.forcedIncludes, ['/w/pre.h']);
    });

    it('falls back to fuzzy header lookup when include paths are missing', () => {
        const empty = { includeDirs: [], defines: [], forcedIncludes: [], sources: [] };
        const resolver = new IncludeResolver(empty, [WS], true);
        const hit = resolver.resolve('acme/allocator.h', true, path.join(INC, 'render/renderer.h'));
        assert.equal(hit.file, path.join(WS, 'third_party/acme/include/acme/allocator.h'));
    });
});

describe('names', () => {
    it('strips and extracts template arguments', () => {
        assert.equal(stripTemplateArgs('a::B<int, C<d>>::E<f>'), 'a::B::E');
        assert.equal(trailingTemplateArgs('ns::Base<std::map<int, X>>'), '<std::map<int, X>>');
        assert.equal(trailingTemplateArgs('Plain'), undefined);
    });
});

describe('graph: file mode', () => {
    it('walks the deep hierarchy of mesh_instance.h to the root', async () => {
        const g = await graphFor(path.join(INC, 'scene/mesh_instance.h'), 'file');
        const seeds = g.nodes.filter(n => n.isSeed).map(n => n.id).sort();
        assert.deepEqual(seeds, ['scene::AnimatedCharacterMesh', 'scene::MeshInstance', 'scene::SkinnedMeshInstance']);
        assert.deepEqual(ancestry(g, 'scene::AnimatedCharacterMesh'), [
            'scene::AnimatedCharacterMesh', 'scene::SkinnedMeshInstance', 'scene::MeshInstance', 'scene::GeometryInstance',
            'scene::VisualInstance', 'scene::Spatial', 'scene::Node', 'core::RefCounted', 'core::Object',
        ]);
        assert.deepEqual(parentsOf(g, 'scene::Node'), ['core::Observable', 'core::RefCounted', 'scene::mixins::ISerializable']);
        assert.equal(g.edges.find(e => e.from === 'scene::Node' && e.to === 'core::Observable')?.templateArgs, '<Node>');
        // Classes that are not ancestors are not pulled in.
        assert.ok(!g.nodes.some(n => n.id === 'scene::Light' && !n.relationOnly));
    });

    it('stops at std types and template parameters', async () => {
        const ex = await graphFor(path.join(INC, 'core/exception.h'), 'file');
        const std = ex.nodes.find(n => n.id === 'ext:std::runtime_error');
        assert.equal(std?.kind, 'external');
        assert.deepEqual(parentsOf(ex, 'core::ShaderCompileError'), ['core::ResourceError']);

        const cam = await graphFor(path.join(INC, 'scene/camera.h'), 'file');
        assert.deepEqual(parentsOf(cam, 'scene::NamedCamera'), ['core::Named']);
        const tparam = cam.nodes.find(n => n.kind === 'templateParam');
        assert.equal(tparam?.label, 'Base');
    });

    it('resolves aliases, namespace aliases and macro decorated classes', async () => {
        const g = await graphFor(path.join(WS, 'edge-cases/edge_cases.h'), 'file');
        assert.deepEqual(parentsOf(g, 'edge::AliasUser'), ['scene::Spatial', 'scene::mixins::ISerializable']);
        assert.equal(g.edges.find(e => e.from === 'edge::AliasUser' && e.to === 'scene::mixins::ISerializable')?.access, 'protected');
        assert.deepEqual(parentsOf(g, 'edge::TypedefUser'), ['scene::Node']);
        assert.ok(g.nodes.some(n => n.id === 'RightBranch'));
        assert.ok(!g.nodes.some(n => n.id === 'DeadCode' || n.id === 'WrongBranch'));
        assert.ok(g.nodes.some(n => n.id === 'CPoint'));
        assert.deepEqual(parentsOf(g, 'Wrapped'), ['edge::Outer']);
        assert.deepEqual(parentsOf(g, 'edge::Outer::Inner'), ['scene::Spatial']);
        assert.equal(g.nodes.find(n => n.id === 'unresolved:sdk::PluginBase')?.kind, 'unresolved');
    });

    it('uses build defines to follow conditional computed includes', async () => {
        const g = await graphFor(path.join(WS, 'edge-cases/edge_cases.h'), 'file', { defines: ['PLUGIN_SDK_HEADER="sdk/plugin_base.h"'] });
        assert.ok(parentsOf(g, 'edge::PluginNode').includes('sdk::PluginBase'));
    });

    it('asks the external resolver (language server) for unresolved bases', async () => {
        const asked: string[] = [];
        const resolver: ExternalResolver = {
            async findDefinition(base) {
                asked.push(base.name);
                if (base.name !== 'sdk::PluginBase') return undefined;
                return { file: path.join(WS, 'edge-cases/sdk/plugin_base.h'), line: 4, column: 6 };
            },
        };
        const g = await graphFor(path.join(WS, 'edge-cases/edge_cases.h'), 'file', {}, o => { o.resolver = resolver; });
        assert.deepEqual(asked, ['sdk::PluginBase']);
        assert.ok(parentsOf(g, 'edge::PluginNode').includes('sdk::PluginBase'));
        assert.ok(g.backends.includes('language server'));
        const base = g.nodes.find(n => n.id === 'sdk::PluginBase');
        assert.equal(base?.cls?.members.find(m => m.name === 'pluginName')?.isPure, true);
    });

    it('adds supertypes reported by a type hierarchy provider', async () => {
        const resolver: ExternalResolver = {
            async supertypes(cls) {
                return cls.id === 'edge::PluginNode'
                    ? [{ name: 'PluginBase', loc: { file: path.join(WS, 'edge-cases/sdk/plugin_base.h'), line: 4, column: 6 } }]
                    : [];
            },
        };
        const g = await graphFor(path.join(WS, 'edge-cases/edge_cases.h'), 'file', {}, o => { o.resolver = resolver; });
        assert.ok(parentsOf(g, 'edge::PluginNode').includes('sdk::PluginBase'));
    });
});

describe('graph: folder mode and scope', () => {
    it('collects all headers of a folder', async () => {
        const g = await graphFor(path.join(INC, 'ui'), 'folder');
        const seeds = g.nodes.filter(n => n.isSeed).map(n => n.id).sort();
        assert.deepEqual(seeds, ['ui::Button', 'ui::CheckBox', 'ui::Control', 'ui::Focusable', 'ui::RadioButton', 'ui::Widget',
            'ui::widgets::Slider', 'ui::widgets::Slider::Style', 'ui::widgets::SpinBox', 'ui::widgets::ValueControl']);
        const virt = g.edges.filter(e => e.isVirtual && isInheritance(e)).map(e => e.from).sort();
        assert.deepEqual(virt, ['ui::Focusable', 'ui::Widget']);
        assert.equal(g.edges.find(e => e.from === 'ui::widgets::Slider')?.templateArgs, '<float>');
    });

    it('stops at classes outside the target directory with traversalScope=targetDirectory', async () => {
        const g = await graphFor(path.join(INC, 'render'), 'folder', { traversalScope: 'targetDirectory' });
        const rc = g.nodes.find(n => n.id === 'core::RefCounted');
        assert.ok(rc, 'the out-of-scope base is still shown');
        assert.match(rc!.reason ?? '', /outside/);
        assert.deepEqual(parentsOf(g, 'core::RefCounted'), [], 'but not expanded');
        assert.deepEqual(parentsOf(g, 'render::vk::MoltenVkRenderer'), ['render::vk::VulkanRenderer']);
    });
});

describe('graph: clang-uml backend', { skip: !findExecutable('clang-uml') && 'clang-uml not installed' }, () => {
    it('produces the same hierarchy as the parser', async () => {
        const g = await graphFor(path.join(INC, 'scene/mesh_instance.h'), 'file', { clangUmlMode: 'always' });
        assert.ok(g.backends.includes('clang-uml'));
        assert.deepEqual(ancestry(g, 'scene::AnimatedCharacterMesh').slice(-3), ['scene::Node', 'core::RefCounted', 'core::Object']);
        assert.equal(g.nodes.find(n => n.id === 'scene::AnimatedCharacterMesh')?.cls?.sources.includes('clang-uml'), true);
        assert.ok(!g.nodes.some(n => n.id.startsWith('std::')));
    });
});
