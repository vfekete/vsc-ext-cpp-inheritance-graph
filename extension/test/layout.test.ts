import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { layout } = require('../../media/layout.js');

interface Box { x: number; y: number; width: number; height: number }

function overlaps(a: Box, b: Box): boolean {
    return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

const nodes = ['Object', 'RefCounted', 'Observable', 'Node', 'Spatial', 'Visual', 'Mesh', 'Skinnable', 'Skinned', 'Widget', 'Focusable', 'Control']
    .map((id, i) => ({ id, width: 120 + (i % 3) * 40, height: 60 + (i % 4) * 25 }));
const edges = [
    ['RefCounted', 'Object'], ['Node', 'RefCounted'], ['Node', 'Observable'], ['Spatial', 'Node'], ['Visual', 'Spatial'],
    ['Mesh', 'Visual'], ['Skinned', 'Mesh'], ['Skinned', 'Skinnable'], ['Widget', 'Node'], ['Focusable', 'Node'],
    ['Control', 'Widget'], ['Control', 'Focusable'],
].map(([from, to]) => ({ from, to }));

describe('layout', () => {
    for (const direction of ['TB', 'LR']) {
        it(`places bases before derived classes without overlaps (${direction})`, () => {
            const res = layout(nodes, edges, { direction });
            const boxes: Box[] = nodes.map(n => res.nodes[n.id]);
            for (let i = 0; i < boxes.length; i++) {
                for (let j = i + 1; j < boxes.length; j++) {
                    assert.ok(!overlaps(boxes[i], boxes[j]), `${nodes[i].id} overlaps ${nodes[j].id}`);
                }
            }
            for (const e of edges) {
                const d = res.nodes[e.from], b = res.nodes[e.to];
                if (direction === 'TB') assert.ok(b.y + b.height <= d.y, `${e.to} above ${e.from}`);
                else assert.ok(b.x + b.width <= d.x, `${e.to} left of ${e.from}`);
            }
            assert.equal(res.edges.length, edges.length);
            for (const e of res.edges) assert.ok(e.points.length >= 2);
        });
    }

    it('packs many unrelated classes into a compact block instead of one row', () => {
        const many = [...nodes];
        for (let i = 0; i < 500; i++) many.push({ id: `pod${i}`, width: 140, height: 50 });
        const res = layout(many, edges, { direction: 'TB' });
        const ratio = res.width / res.height;
        assert.ok(ratio < 3 && ratio > 0.3, `aspect ratio ${ratio.toFixed(2)} (${Math.round(res.width)}x${Math.round(res.height)})`);
        // The hierarchy is placed first (top-left), standalone boxes after it.
        assert.ok(res.nodes.Object.y < res.nodes.pod0.y || res.nodes.Object.x < res.nodes.pod0.x);
        const boxes: Box[] = many.map(n => res.nodes[n.id]);
        for (let i = 0; i < boxes.length; i++) {
            for (let j = i + 1; j < boxes.length; j++) assert.ok(!overlaps(boxes[i], boxes[j]), `${many[i].id} overlaps ${many[j].id}`);
        }
    });

    it('routes parallel and opposite edges separately when keyed', () => {
        const res = layout([{ id: 'a', width: 60, height: 30 }, { id: 'b', width: 60, height: 30 }],
            [{ from: 'a', to: 'b', key: 0 }, { from: 'a', to: 'b', key: 1 }, { from: 'b', to: 'a', key: 2 }]);
        assert.deepEqual(res.edges.map((e: any) => e.key).sort(), [0, 1, 2]);
        const byKey = new Map(res.edges.map((e: any) => [e.key, e]));
        const start = (k: number) => (byKey.get(k) as any).points[0];
        assert.notDeepEqual(start(0), start(1), 'parallel edges get distinct ports');
        // Every edge runs from its `from` node to its `to` node.
        for (const e of res.edges as any[]) {
            const p0 = e.points[0], p1 = e.points[e.points.length - 1];
            const near = (p: any, id: string) => { const n = res.nodes[id]; return Math.abs(p.y - n.y) < 1 || Math.abs(p.y - (n.y + n.height)) < 1; };
            assert.ok(near(p0, e.from) && near(p1, e.to), `edge ${e.key} direction`);
        }
    });

    it('tolerates cycles, self loops and unknown ids', () => {
        const res = layout([{ id: 'a', width: 10, height: 10 }, { id: 'b', width: 10, height: 10 }],
            [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }, { from: 'a', to: 'a' }, { from: 'a', to: 'zzz' }]);
        assert.ok(res.nodes.a && res.nodes.b);
    });
});
