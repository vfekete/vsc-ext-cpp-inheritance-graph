import assert from 'node:assert/strict';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { buildGraph } from '../src/core/graphBuilder';
import { IncludeResolver } from '../src/core/includeConfig';
import { parseTokens } from '../src/core/parser';
import { Preprocessor } from '../src/core/preprocessor';
import { DEFAULT_SETTINGS, prepareBuild } from '../src/core/request';

const WS = path.resolve(__dirname, '../../../test/mock');

function parseSnippet(src: string) {
    const resolver = new IncludeResolver({ includeDirs: [], defines: [], forcedIncludes: [], sources: [] }, [], false);
    const pp = new Preprocessor({ resolver, overlay: new Map([['/virtual/enums.h', src]]) });
    return parseTokens(pp.run(['/virtual/enums.h']).tokens);
}

describe('enums', () => {
    it('parses scoped, plain, nested, typedef and opaque enums', () => {
        const { classes } = parseSnippet([
            '#define FLAG(n) (1u << (n))',
            'namespace ns {',
            'enum class Color : unsigned char { Red = 1, Green, Blue = FLAG(3), };',
            'enum Plain { A, B [[deprecated]] = 4 };',
            'enum class Opaque : int;',
            'enum struct Legacy { X };',
            'typedef enum { CA, CB } CStyle;',
            'struct Holder {',
            '    enum class Mode { Off, On } mode;',
            '    enum Kind { K1, K2 };',
            '    Kind kind = K1;',
            '    enum Plain plain;',
            '    void set(Mode m);',
            '};',
            'enum { Anonymous1, Anonymous2 };',
            'class AfterEnums : public Holder {};',
            '}',
        ].join('\n'));
        const byId = new Map(classes.map(c => [c.id, c]));
        const color = byId.get('ns::Color')!;
        assert.equal(color.kind, 'enum');
        assert.equal(color.isScoped, true);
        assert.equal(color.underlyingType, 'unsigned char');
        assert.deepEqual(color.members.map(m => [m.name, m.kind, m.value]), [['Red', 'enumerator', '1'], ['Green', 'enumerator', undefined], ['Blue', 'enumerator', '(1u <<(3))']]);
        assert.deepEqual(byId.get('ns::Plain')!.members.map(m => [m.name, m.value]), [['A', undefined], ['B', '4']]);
        assert.equal(byId.get('ns::Plain')!.isScoped, undefined);
        assert.equal(byId.get('ns::Legacy')!.isScoped, true);
        assert.ok(!byId.has('ns::Opaque'), 'opaque declarations are not definitions');
        assert.deepEqual(byId.get('ns::CStyle')!.members.map(m => m.name), ['CA', 'CB']);
        assert.deepEqual(byId.get('ns::Holder::Mode')!.members.map(m => m.name), ['Off', 'On']);
        assert.ok(byId.has('ns::Holder::Kind'));
        const holder = byId.get('ns::Holder')!;
        assert.deepEqual(holder.members.map(m => [m.name, m.kind, m.type]),
            [['mode', 'field', 'Mode'], ['kind', 'field', 'Kind'], ['plain', 'field', 'enum Plain'], ['set', 'method', 'void']]);
        // Parsing continues normally after enums (including the anonymous one).
        assert.deepEqual(byId.get('ns::AfterEnums')!.bases.map(b => b.name), ['Holder']);
    });

    it('adds enums as nodes and member enums as compositions', async () => {
        const opts = prepareBuild(path.join(WS, 'include/render/renderer.h'), 'file', [WS], { ...DEFAULT_SETTINGS, clangUmlMode: 'never' });
        const g = await buildGraph(opts);
        const kind = g.nodes.find(n => n.id === 'render::BackendKind');
        assert.equal(kind?.isSeed, true);
        assert.equal(kind?.cls?.kind, 'enum');
        assert.equal(kind?.cls?.underlyingType, 'std::uint8_t');
        assert.deepEqual(kind?.cls?.members.map(m => [m.name, m.value]), [['OpenGL', '1'], ['Vulkan', undefined], ['Metal', undefined], ['Software', '0x80']]);
        const comp = g.edges.find(e => e.from === 'render::Renderer' && e.to === 'render::BackendKind');
        assert.equal(comp?.kind, 'composition');
        assert.equal(comp?.label, 'm_kind');
        // The return type of kind() does not add a (weaker) dependency next to the composition.
        assert.ok(!g.edges.some(e => e.kind === 'dependency' && e.to === 'render::BackendKind'));

        const visual = await buildGraph(prepareBuild(path.join(WS, 'include/scene/visual.h'), 'file', [WS], { ...DEFAULT_SETTINGS, clangUmlMode: 'never' }));
        assert.ok(visual.edges.some(e => e.from === 'scene::GeometryInstance' && e.to === 'scene::GeometryInstance::ShadowMode' && e.kind === 'composition'));
    });
});
