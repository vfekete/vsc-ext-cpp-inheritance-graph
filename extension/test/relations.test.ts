import assert from 'node:assert/strict';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { buildGraph } from '../src/core/graphBuilder';
import { GraphModel, RelationKind } from '../src/core/model';
import { isInterface, parameterTypes, parseType, relationsOfType } from '../src/core/relations';
import { DEFAULT_SETTINGS, prepareBuild } from '../src/core/request';

const WS = path.resolve(__dirname, '../../../test/mock');
const INC = path.join(WS, 'include');

function rel(type: string) {
    return relationsOfType(parseType(type)!).map(r => `${r.kind}:${r.name}:${r.multiplicity}`);
}

async function graph(file: string): Promise<GraphModel> {
    return buildGraph(prepareBuild(path.join(INC, file), 'file', [WS], { ...DEFAULT_SETTINGS, clangUmlMode: 'never' }));
}

function edge(g: GraphModel, from: string, to: string, kind: RelationKind) {
    return g.edges.find(e => e.from === from && e.to === to && e.kind === kind);
}

describe('relationship heuristics', () => {
    it('classifies member types', () => {
        assert.deepEqual(rel('Transform'), ['composition:Transform:1']);
        assert.deepEqual(rel('std::unique_ptr<scene::Node>'), ['composition:scene::Node:0..1']);
        assert.deepEqual(rel('std::optional<Style>'), ['composition:Style:0..1']);
        assert.deepEqual(rel('std::array<Vec3, 4>'), ['composition:Vec3:*']);
        assert.deepEqual(rel('std::vector<Item>'), ['composition:Item:*']);
        assert.deepEqual(rel('std::vector<std::unique_ptr<Item>>'), ['composition:Item:*']);
        assert.deepEqual(rel('std::shared_ptr<Mesh>'), ['aggregation:Mesh:0..1']);
        assert.deepEqual(rel('std::vector<std::shared_ptr<Camera>>'), ['aggregation:Camera:*']);
        assert.deepEqual(rel('std::map<std::string, Node*>'), ['aggregation:Node:*']);
        assert.deepEqual(rel('Node*'), ['association:Node:0..1']);
        assert.deepEqual(rel('const Renderer&'), ['association:Renderer:1']);
        assert.deepEqual(rel('std::weak_ptr<Light>'), ['association:Light:0..1']);
        assert.deepEqual(rel('core::Ref<Mesh>'), ['composition:core::Ref:1', 'association:Mesh:*']);
        for (const t of ['int', 'unsigned long long', 'std::string', 'std::function<void(Derived&)>', 'std::atomic<int>', 'const char*']) {
            assert.deepEqual(rel(t), [], t);
        }
    });

    it('splits parameter lists', () => {
        assert.deepEqual(parameterTypes('(const std::map<int, std::string>& opts, int n = f(1, 2), Camera& cam, float)'),
            ['const std::map<int, std::string>&', 'int', 'Camera&', 'float']);
        assert.deepEqual(parameterTypes('()'), []);
        assert.deepEqual(parameterTypes('(void)'), []);
    });

    it('recognises interfaces', () => {
        const base = { id: 'I', name: 'I', scope: [], kind: 'class' as const, bases: [], loc: { file: '', line: 0, column: 0 }, sources: [] };
        const pure = { name: 'f', kind: 'method' as const, access: 'public' as const, type: 'void', isPure: true };
        const dtor = { name: '~I', kind: 'destructor' as const, access: 'public' as const, type: '', isVirtual: true };
        assert.equal(isInterface({ ...base, members: [dtor, pure] }), true);
        assert.equal(isInterface({ ...base, members: [pure, { name: 'x', kind: 'field', access: 'private', type: 'int' }] }), false);
        assert.equal(isInterface({ ...base, members: [pure, { ...pure, name: 'g', isPure: undefined }] }), false);
        assert.equal(isInterface({ ...base, members: [dtor] }), false);
    });
});

describe('graph: UML relationships', () => {
    it('derives all relationship kinds for scene_tree.h', async () => {
        const g = await graph('scene/scene_tree.h');
        const T = 'scene::SceneTree';
        assert.equal(edge(g, T, 'scene::ISceneVisitor', 'realization')?.access, 'public');
        assert.ok(edge(g, T, 'core::RefCounted', 'generalization'));
        assert.equal(edge(g, T, 'scene::Node', 'composition')?.label, 'm_root');
        assert.equal(edge(g, T, 'scene::Node', 'composition')?.multiplicity, '0..1');
        assert.equal(edge(g, T, 'scene::SceneStats', 'composition')?.multiplicity, '1');
        assert.ok(edge(g, T, 'scene::Transform', 'composition'));
        assert.equal(edge(g, T, 'scene::Camera', 'aggregation')?.multiplicity, '*');
        assert.equal(edge(g, T, 'scene::Node', 'aggregation')?.label, 'm_index');
        assert.equal(edge(g, T, 'scene::Light', 'association')?.label, 'm_sun');
        assert.equal(edge(g, T, 'render::Renderer', 'association')?.access, 'private');
        assert.equal(edge(g, T, 'scene::Spatial', 'dependency')?.label, 'collectVisible()');
        // No dependency where a stronger relationship exists, none on itself.
        assert.ok(!edge(g, T, 'scene::Light', 'dependency'));
        assert.ok(!edge(g, T, 'scene::Camera', 'dependency'));
        assert.ok(!g.edges.some(e => e.kind === 'dependency' && e.from === e.to));
        // Classes reachable only through relationships are marked as such and not expanded.
        const light = g.nodes.find(n => n.id === 'scene::Light');
        assert.equal(light?.relationOnly, true);
        assert.ok(!g.edges.some(e => e.from === 'scene::Light' && e.kind === 'generalization'));
        assert.ok(!g.nodes.find(n => n.id === 'core::RefCounted')?.relationOnly);
    });

    it('finds self relationships and nested types', async () => {
        const node = await graph('scene/node.h');
        assert.equal(edge(node, 'scene::Node', 'scene::Node', 'association')?.label, 'm_parent');
        assert.equal(edge(node, 'scene::Node', 'scene::Node', 'aggregation')?.label, 'm_children');
        assert.ok(edge(node, 'scene::Node', 'scene::mixins::ISerializable', 'realization'));

        const ui = await graph('ui/button.h');
        assert.equal(edge(ui, 'ui::widgets::Slider', 'ui::widgets::Slider::Style', 'composition')?.label, 'style');
        // Template parameters are not classes.
        assert.ok(!ui.edges.some(e => e.from === 'ui::widgets::ValueControl' && e.kind === 'composition'));
    });
});
