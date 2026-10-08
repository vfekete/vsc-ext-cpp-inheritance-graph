/*
 * Layered (Sugiyama-style) graph layout for inheritance diagrams, dependency free.
 *
 * Input:  nodes [{id, width, height}], edges [{from: derivedId, to: baseId, key?}]
 * Output: { nodes: {id: {x, y, width, height}}, edges: [{from, to, key, points: [{x,y}...]}], width, height }
 *
 * Edges with distinct `key`s may connect the same pair of nodes (e.g. inheritance plus an
 * association); they get separate routes. Without keys, duplicate pairs are merged.
 *
 * Base classes are placed above their derived classes (direction 'TB') or to their
 * left ('LR'). Edge points run from the derived class to the base class.
 *
 * Works both as a browser global (window.InheritanceLayout) and as a CommonJS module.
 */
(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.InheritanceLayout = api;
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const DEFAULTS = { direction: 'TB', nodeGap: 28, rankGap: 70, margin: 40, sweeps: 24, componentGap: 60, aspect: 1.6 };

    /**
     * Lay out every connected component on its own, then pack the components into rows
     * (largest first, singletons last in input order). Without this, many unrelated classes
     * end up in one extremely wide layer.
     */
    function layout(inputNodes, inputEdges, options) {
        const opt = Object.assign({}, DEFAULTS, options || {});
        const ids = new Set(inputNodes.map(n => n.id));
        const edges = inputEdges.filter(e => ids.has(e.from) && ids.has(e.to) && e.from !== e.to);

        // Union-find over the (undirected) edges.
        const parent = new Map(inputNodes.map(n => [n.id, n.id]));
        const find = x => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
        edges.forEach(e => { const a = find(e.from), b = find(e.to); if (a !== b) parent.set(a, b); });
        const groups = new Map();
        inputNodes.forEach((n, i) => {
            const r = find(n.id);
            if (!groups.has(r)) groups.set(r, { nodes: [], edges: [], first: i });
            groups.get(r).nodes.push(n);
        });
        edges.forEach(e => groups.get(find(e.from)).edges.push(e));

        const parts = [...groups.values()].map(g => {
            const res = layoutComponent(g.nodes, g.edges, opt);
            return { res, w: res.width, h: res.height, single: g.nodes.length === 1, first: g.first };
        });
        // Connected hierarchies first (biggest first), then standalone boxes in their given order.
        parts.sort((a, b) => (a.single - b.single) || (a.single ? a.first - b.first : b.w * b.h - a.w * a.h));

        const gap = opt.componentGap;
        const totalArea = parts.reduce((s, p) => s + (p.w + gap) * (p.h + gap), 0);
        const widest = parts.reduce((m, p) => Math.max(m, p.w), 0);
        const rowWidth = Math.max(widest, Math.sqrt(totalArea * opt.aspect));

        // Shelf packing.
        const outNodes = {};
        const outEdges = [];
        let x = 0, y = 0, rowH = 0, maxX = 0;
        for (const p of parts) {
            if (x > 0 && x + p.w > rowWidth) { x = 0; y += rowH + gap; rowH = 0; }
            for (const id in p.res.nodes) {
                const b = p.res.nodes[id];
                outNodes[id] = { x: b.x + x + opt.margin, y: b.y + y + opt.margin, width: b.width, height: b.height };
            }
            for (const e of p.res.edges) {
                outEdges.push({ from: e.from, to: e.to, key: e.key, points: e.points.map(pt => ({ x: pt.x + x + opt.margin, y: pt.y + y + opt.margin })) });
            }
            x += p.w + gap;
            rowH = Math.max(rowH, p.h);
            maxX = Math.max(maxX, x - gap);
        }
        return { nodes: outNodes, edges: outEdges, width: maxX + 2 * opt.margin, height: y + rowH + 2 * opt.margin };
    }

    /** Layered layout of one connected component, origin at (0, 0). */
    function layoutComponent(inputNodes, inputEdges, opt) {
        const lr = opt.direction === 'LR';
        // Lay out top-to-bottom; for LR swap the axes before and after.
        const nodes = inputNodes.map(n => ({ id: n.id, w: lr ? n.height : n.width, h: lr ? n.width : n.height, dummy: false }));
        const byId = new Map(nodes.map(n => [n.id, n]));
        // Graph edges point from base (upper) to derived (lower).
        const edges = [];
        const seen = new Set();
        for (const e of inputEdges) {
            if (!byId.has(e.from) || !byId.has(e.to) || e.from === e.to) continue;
            const key = e.key !== undefined ? String(e.key) : e.to + '\u0000' + e.from;
            if (seen.has(key)) continue;
            seen.add(key);
            edges.push({ src: e.to, dst: e.from, orig: e });
        }

        breakCycles(nodes, edges);
        assignRanks(nodes, edges, byId);
        const { layers, chains } = buildLayers(nodes, edges, byId, opt);
        orderLayers(layers, opt.sweeps);
        assignCoordinates(layers, opt);
        const routed = routeEdges(edges, chains, byId);

        // Normalize and (for LR) transpose.
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const layer of layers) for (const n of layer) {
            minX = Math.min(minX, n.x); minY = Math.min(minY, n.y);
            maxX = Math.max(maxX, n.x + n.w); maxY = Math.max(maxY, n.y + n.h);
        }
        if (!isFinite(minX)) { minX = minY = 0; maxX = maxY = 0; }
        const dx = -minX, dy = -minY;
        const tp = (x, y) => (lr ? { x: y + dy, y: x + dx } : { x: x + dx, y: y + dy });
        const outNodes = {};
        for (const n of nodes) {
            if (n.dummy) continue;
            const p = tp(n.x, n.y);
            outNodes[n.id] = { x: p.x, y: p.y, width: lr ? n.h : n.w, height: lr ? n.w : n.h };
        }
        const outEdges = routed.map(r => ({ from: r.orig.from, to: r.orig.to, key: r.orig.key, points: r.points.map(p => tp(p.x, p.y)) }));
        const w = maxX - minX, h = maxY - minY;
        return { nodes: outNodes, edges: outEdges, width: lr ? h : w, height: lr ? w : h };
    }

    /** Reverse back edges found by DFS so the graph is acyclic (inheritance should be anyway). */
    function breakCycles(nodes, edges) {
        const out = new Map(nodes.map(n => [n.id, []]));
        edges.forEach(e => out.get(e.src).push(e));
        const state = new Map();
        const visit = id => {
            state.set(id, 1);
            for (const e of out.get(id)) {
                const s = state.get(e.dst);
                if (s === 1) { const t = e.src; e.src = e.dst; e.dst = t; e.reversed = true; }
                else if (!s) visit(e.dst);
            }
            state.set(id, 2);
        };
        nodes.forEach(n => { if (!state.get(n.id)) visit(n.id); });
    }

    function assignRanks(nodes, edges, byId) {
        const parents = new Map(nodes.map(n => [n.id, []]));
        const children = new Map(nodes.map(n => [n.id, []]));
        edges.forEach(e => { parents.get(e.dst).push(e.src); children.get(e.src).push(e.dst); });
        // Longest path from the roots.
        const rank = new Map();
        const rankOf = (id, guard) => {
            if (rank.has(id)) return rank.get(id);
            if (guard.has(id)) return 0;
            guard.add(id);
            let r = 0;
            for (const p of parents.get(id)) r = Math.max(r, rankOf(p, guard) + 1);
            rank.set(id, r);
            return r;
        };
        nodes.forEach(n => rankOf(n.id, new Set()));
        // Pull nodes down towards their children (shorter edges; mixins sit next to their users).
        const order = [...nodes].sort((a, b) => rank.get(b.id) - rank.get(a.id));
        for (const n of order) {
            const ch = children.get(n.id);
            if (!ch.length) continue;
            const limit = Math.min(...ch.map(c => rank.get(c))) - 1;
            if (limit > rank.get(n.id)) rank.set(n.id, limit);
        }
        nodes.forEach(n => { n.rank = rank.get(n.id); });
    }

    function buildLayers(nodes, edges, byId, opt) {
        const maxRank = nodes.reduce((m, n) => Math.max(m, n.rank), 0);
        const layers = Array.from({ length: maxRank + 1 }, () => []);
        // Initial order: DFS from roots so related classes start close together.
        const children = new Map(nodes.map(n => [n.id, []]));
        edges.forEach(e => children.get(e.src).push(e.dst));
        const placed = new Set();
        const place = n => {
            if (placed.has(n.id)) return;
            placed.add(n.id);
            layers[n.rank].push(n);
            for (const c of children.get(n.id)) place(byId.get(c));
        };
        nodes.filter(n => n.rank === 0).forEach(place);
        nodes.forEach(place);

        // Long edges get a chain of dummy nodes, one per intermediate layer.
        const chains = new Map();
        edges.forEach((e, idx) => {
            const a = byId.get(e.src), b = byId.get(e.dst);
            const chain = [a];
            for (let r = a.rank + 1; r < b.rank; r++) {
                const d = { id: `\u0000d${idx}_${r}`, w: 8, h: 0, dummy: true, rank: r };
                byId.set(d.id, d);
                layers[r].push(d);
                chain.push(d);
            }
            chain.push(b);
            chains.set(e, chain);
        });
        // Adjacency for ordering.
        layers.forEach(l => l.forEach(n => { n.up = []; n.down = []; }));
        for (const chain of chains.values()) {
            for (let i = 0; i + 1 < chain.length; i++) {
                chain[i].down.push(chain[i + 1]);
                chain[i + 1].up.push(chain[i]);
            }
        }
        return { layers, chains };
    }

    function crossings(layers) {
        let total = 0;
        for (let r = 0; r + 1 < layers.length; r++) {
            const pos = new Map(layers[r + 1].map((n, i) => [n, i]));
            const segs = [];
            layers[r].forEach((n, i) => n.down.forEach(d => segs.push([i, pos.get(d)])));
            segs.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
            for (let i = 0; i < segs.length; i++)
                for (let j = i + 1; j < segs.length; j++)
                    if (segs[j][0] > segs[i][0] && segs[j][1] < segs[i][1]) total++;
        }
        return total;
    }

    function orderLayers(layers, sweeps) {
        const index = () => layers.forEach(l => l.forEach((n, i) => { n.order = i; }));
        index();
        let best = layers.map(l => l.slice());
        let bestCross = crossings(layers);
        for (let s = 0; s < sweeps && bestCross > 0; s++) {
            const down = s % 2 === 0;
            const range = down ? [...layers.keys()].slice(1) : [...layers.keys()].reverse().slice(1);
            for (const r of range) {
                const layer = layers[r];
                const bary = new Map();
                for (const n of layer) {
                    const adj = down ? n.up : n.down;
                    bary.set(n, adj.length ? adj.reduce((sum, a) => sum + a.order, 0) / adj.length : n.order);
                }
                layer.sort((a, b) => bary.get(a) - bary.get(b) || a.order - b.order);
                layer.forEach((n, i) => { n.order = i; });
            }
            transpose(layers);
            const c = crossings(layers);
            if (c < bestCross) {
                bestCross = c;
                best = layers.map(l => l.slice());
            }
        }
        best.forEach((l, r) => { layers[r] = l; });
        index();
    }

    /** Swap neighbours within a layer while that reduces crossings with adjacent layers. */
    function transpose(layers) {
        const pairCross = (u, v) => {
            // crossings between edges of u and v if u is left of v
            let c = 0;
            for (const adj of ['up', 'down']) {
                for (const a of u[adj]) for (const b of v[adj]) if (a.order > b.order) c++;
            }
            return c;
        };
        let improved = true, rounds = 0;
        while (improved && rounds++ < 4) {
            improved = false;
            for (const layer of layers) {
                for (let i = 0; i + 1 < layer.length; i++) {
                    const u = layer[i], v = layer[i + 1];
                    if (pairCross(u, v) > pairCross(v, u)) {
                        layer[i] = v; layer[i + 1] = u;
                        v.order = i; u.order = i + 1;
                        improved = true;
                    }
                }
            }
        }
    }

    function assignCoordinates(layers, opt) {
        // Vertical: stack layers.
        let y = 0;
        for (const layer of layers) {
            const h = layer.reduce((m, n) => Math.max(m, n.h), 0);
            layer.forEach(n => { n.y = y; n.layerH = h; });
            y += h + opt.rankGap;
        }
        // Horizontal: pack, then iteratively move nodes towards their neighbours' centres.
        const gap = n => (n.dummy ? opt.nodeGap / 3 : opt.nodeGap);
        layers.forEach(layer => {
            let x = 0;
            layer.forEach(n => { n.x = x; x += n.w + gap(n); });
        });
        const center = n => n.x + n.w / 2;
        const place = (layer, desired) => {
            // desired: centre positions. Enforce order + spacing; average a left and a right pass.
            const n = layer.length;
            if (!n) return;
            const left = new Array(n), right = new Array(n);
            for (let i = 0; i < n; i++) {
                const want = desired[i] - layer[i].w / 2;
                left[i] = i === 0 ? want : Math.max(want, left[i - 1] + layer[i - 1].w + Math.max(gap(layer[i - 1]), gap(layer[i])));
            }
            for (let i = n - 1; i >= 0; i--) {
                const want = desired[i] - layer[i].w / 2;
                right[i] = i === n - 1 ? want : Math.min(want, right[i + 1] - layer[i].w - Math.max(gap(layer[i]), gap(layer[i + 1])));
            }
            for (let i = 0; i < n; i++) {
                const avg = (left[i] + right[i]) / 2;
                layer[i].x = i === 0 ? avg : Math.max(avg, layer[i - 1].x + layer[i - 1].w + Math.max(gap(layer[i - 1]), gap(layer[i])));
            }
        };
        const iterations = 16;
        for (let it = 0; it < iterations; it++) {
            const down = it % 2 === 0;
            const order = down ? layers : [...layers].reverse();
            for (const layer of order) {
                const desired = layer.map(n => {
                    const primary = down ? n.up : n.down;
                    const secondary = down ? n.down : n.up;
                    const adj = primary.length ? primary : secondary;
                    if (!adj.length) return center(n);
                    // Median is robust against one far-away neighbour.
                    const cs = adj.map(center).sort((a, b) => a - b);
                    const m = cs.length >> 1;
                    const med = cs.length % 2 ? cs[m] : (cs[m - 1] + cs[m]) / 2;
                    // Straighten dummy chains strongly, real nodes a bit softer.
                    return n.dummy ? med : 0.25 * center(n) + 0.75 * med;
                });
                place(layer, desired);
            }
        }
    }

    function routeEdges(edges, chains, byId) {
        // Spread ports along the node border so parallel edges do not overlap.
        const outPorts = new Map(); // derived node -> edges leaving upwards
        const inPorts = new Map();  // base node -> edges arriving from below
        const routes = [];
        for (const e of edges) {
            const chain = chains.get(e);
            // chain runs base(top) ... derived(bottom); output derived -> base
            const pts = chain.slice().reverse();
            const derived = pts[0], base = pts[pts.length - 1];
            const r = { orig: e.orig, derived, base, chain: pts, reversed: !!e.reversed };
            routes.push(r);
            (outPorts.get(derived) || outPorts.set(derived, []).get(derived)).push(r);
            (inPorts.get(base) || inPorts.set(base, []).get(base)).push(r);
        }
        const portX = (node, list, r, neighbour) => {
            const sorted = list.slice().sort((a, b) => neighbour(a).x + neighbour(a).w / 2 - (neighbour(b).x + neighbour(b).w / 2));
            const i = sorted.indexOf(r), k = sorted.length;
            const span = Math.min(node.w * 0.6, 24 * (k - 1));
            return node.x + node.w / 2 + (k > 1 ? -span / 2 + (span * i) / (k - 1) : 0);
        };
        for (const r of routes) {
            const { derived, base, chain } = r;
            const startX = portX(derived, outPorts.get(derived), r, x => x.chain[1]);
            const endX = portX(base, inPorts.get(base), r, x => x.chain[x.chain.length - 2]);
            const points = [{ x: startX, y: derived.y }];
            // chain is ordered bottom (derived) to top (base): enter a dummy at its layer's bottom, leave at the top.
            for (let i = 1; i + 1 < chain.length; i++) {
                const cx = chain[i].x + chain[i].w / 2;
                points.push({ x: cx, y: chain[i].y + chain[i].layerH }, { x: cx, y: chain[i].y });
            }
            points.push({ x: endX, y: base.y + base.h });
            // Edges reversed to break a cycle must still run from `from` to `to`.
            r.points = r.reversed ? points.reverse() : points;
        }
        return routes;
    }

    return { layout };
});
