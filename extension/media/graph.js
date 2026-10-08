/* global acquireVsCodeApi, InheritanceLayout */
/*
 * Webview side of the C++ inheritance graph: renders the graph as SVG UML class boxes,
 * handles selection highlighting, zoom / pan, search and navigation requests.
 */
(function () {
    'use strict';

    const vscode = acquireVsCodeApi();
    const SVGNS = 'http://www.w3.org/2000/svg';
    const $ = id => document.getElementById(id);

    const MAX_ROWS = 12;
    const MIN_W = 150;
    const MAX_W = 560;
    const MIN_ZOOM = 0.05;
    const MAX_ZOOM = 5;
    /** Groups of standalone classes up to this size start expanded. */
    const GROUP_AUTO_OPEN = 8;
    const GROUP_PREFIX = '\u0001group:';

    /** Checkbox ids in the Relations menu. `inheritance` covers generalization (and realization when that is off). */
    const REL_KINDS = ['inheritance', 'realization', 'composition', 'aggregation', 'association', 'dependency'];
    const REL_TITLES = {
        generalization: 'inheritance', realization: 'realization (implements interface)', composition: 'composition (owns)',
        aggregation: 'aggregation (shares / collects)', association: 'association (refers to)', dependency: 'dependency (uses in a method)',
    };
    /** Marker per edge style: [marker-start, marker-end]. */
    const REL_MARKERS = {
        generalization: [null, 'm-generalization'], realization: [null, 'm-realization'], composition: ['m-composition', null],
        aggregation: ['m-aggregation', null], association: [null, 'm-association'], dependency: [null, 'm-dependency'],
    };
    const INHERITANCE = new Set(['generalization', 'realization']);

    const saved = vscode.getState() || {};
    const state = {
        graph: null,
        options: Object.assign({ showMembers: 'all', direction: 'TB', highlight: 'parents', navigateOn: 'doubleClick', standalone: 'namespace', relations: { inheritance: true } }, saved.options || {}),
        /** Edges currently drawn (after the Relations filter), keyed by edge.key. */
        edgeByKey: new Map(),
        visibleEdges: [],
        /** Standalone-class group key -> explicitly opened (true) / closed (false). */
        groupOpen: Object.assign({}, saved.groupOpen || {}),
        /** Standalone node id -> group key (only while grouping is active). */
        groupOf: new Map(),
        groups: [],
        /** Absolute boxes of every drawn node (including nodes inside groups). */
        positions: {},
        collapsed: new Set(saved.collapsed || []),
        /** Collapsed member sections: `${nodeId}:fields` / `${nodeId}:methods`. */
        collapsedParts: new Set(saved.collapsedParts || []),
        /** Per class: access levels whose (non-static) members are hidden, e.g. { 'ns::A': ['private'] }. */
        hiddenAccess: Object.assign({}, saved.hiddenAccess || {}),
        expanded: new Set(saved.expanded || []),
        selected: saved.selected || null,
        transform: saved.transform || { x: 0, y: 0, k: 1 },
        target: saved.target || null,
        mode: saved.mode || null,
        layout: null,
        views: new Map(),
        matches: [],
        matchIndex: -1,
    };
    const T = state.transform;

    const svg = $('canvas');
    const viewport = $('viewport');
    const nodesLayer = $('nodes');
    let groupsLayer = $('groups');
    if (!groupsLayer) {
        groupsLayer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        groupsLayer.id = 'groups';
        viewport.insertBefore(groupsLayer, viewport.firstChild);
    }
    const edgesLayer = $('edges');

    // ------------------------------------------------------------------ persistence

    function persist() {
        vscode.setState({
            options: state.options,
            collapsed: [...state.collapsed],
            collapsedParts: [...state.collapsedParts],
            hiddenAccess: state.hiddenAccess,
            expanded: [...state.expanded],
            groupOpen: state.groupOpen,
            selected: state.selected,
            transform: T,
            target: state.target,
            mode: state.mode,
        });
    }

    // ------------------------------------------------------------------ text metrics

    const measureCtx = document.createElement('canvas').getContext('2d');
    let M = readMetrics();

    function readMetrics() {
        const cs = getComputedStyle(document.documentElement);
        const family = cs.getPropertyValue('--vscode-editor-font-family').trim() || 'monospace';
        const size = parseFloat(cs.getPropertyValue('--vscode-editor-font-size')) || 13;
        return { family, size, small: Math.max(9, Math.round(size * 0.85)), row: Math.round(size * 1.6), pad: 10 };
    }

    function textWidth(text, opts) {
        const o = opts || {};
        measureCtx.font = `${o.italic ? 'italic ' : ''}${o.bold ? 'bold ' : ''}${o.size || M.size}px ${M.family}`;
        return measureCtx.measureText(text).width;
    }

    function ellipsize(text, maxWidth, opts) {
        if (textWidth(text, opts) <= maxWidth) return text;
        let lo = 0, hi = text.length;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (textWidth(text.slice(0, mid) + '…', opts) <= maxWidth) lo = mid; else hi = mid - 1;
        }
        return text.slice(0, lo) + '…';
    }

    // ------------------------------------------------------------------ svg helpers

    function el(tag, attrs, parent, text) {
        const e = document.createElementNS(SVGNS, tag);
        if (attrs) for (const k in attrs) if (attrs[k] !== undefined && attrs[k] !== null) e.setAttribute(k, attrs[k]);
        if (text !== undefined) e.textContent = text;
        if (parent) parent.appendChild(e);
        return e;
    }

    function relPath(file) {
        const root = state.graph && state.graph.targetPath;
        if (!file) return '';
        if (root) {
            const dir = state.graph.mode === 'folder' ? root : root.replace(/[\\/][^\\/]*$/, '');
            const parent = dir.replace(/[\\/][^\\/]*$/, '');
            if (file.startsWith(parent + '/') || file.startsWith(parent + '\\')) return file.slice(parent.length + 1);
        }
        return file;
    }

    // ------------------------------------------------------------------ node views

    const VIS = { public: '+', protected: '#', private: '-' };

    function memberLabel(m) {
        if (m.kind === 'field') return { main: m.name, type: m.type ? `: ${m.type}` : '' };
        let main = m.name + (m.params || '()');
        if (m.isConst) main += ' const';
        if (m.isPure) main += ' = 0';
        return { main, type: m.type ? `: ${m.type}` : '' };
    }

    /** Width reserved at the right of member rows for the section's collapse toggle. */
    const PART_TOGGLE_W = 18;
    const PART_NAMES = { fields: ['attribute', 'attributes'], methods: ['method', 'methods'] };

    function partSummary(c) {
        const [one, many] = PART_NAMES[c.key];
        return `${c.count} ${c.count === 1 ? one : many}`;
    }

    const ACCESS_ORDER = { public: 0, protected: 1, private: 2 };
    const ACCESS_LEVELS = ['public', 'protected', 'private'];
    const SPECIAL_ORDER = { constructor: 0, destructor: 1 };

    /** Grouped by access (public, protected, private); constructors/destructors first, then alphabetical. */
    function compareMembers(a, b) {
        return ACCESS_ORDER[a.m.access] - ACCESS_ORDER[b.m.access]
            || (SPECIAL_ORDER[a.m.kind] ?? 2) - (SPECIAL_ORDER[b.m.kind] ?? 2)
            || a.m.name.replace(/^~/, '').localeCompare(b.m.name.replace(/^~/, ''), undefined, { sensitivity: 'base' })
            || a.i - b.i;
    }

    /** Whether a member passes the Members menu and the class's access checkboxes. Static members always do. */
    function memberShown(n, m) {
        if (m.isStatic) return true;
        if (state.options.showMembers === 'public' && m.access !== 'public') return false;
        const hidden = state.hiddenAccess[n.id];
        return !(hidden && hidden.includes(m.access));
    }

    /** Layout of the access checkboxes row in the class title: [{access, count, x, w, label}]. */
    function accessRowItems(n) {
        const counts = { public: 0, protected: 0, private: 0 };
        n.cls.members.forEach(m => { counts[m.access] = (counts[m.access] || 0) + 1; });
        const box = Math.round(M.small * 0.85);
        let x = 0;
        const items = ACCESS_LEVELS.map(access => {
            const label = `${VIS[access]}${counts[access]}`;
            const w = box + 4 + textWidth(label, { size: M.small });
            const item = { access, count: counts[access], x, w, label, box };
            x += w + 12;
            return item;
        });
        return { items, width: x - 12, height: Math.round(M.small * 1.7) };
    }

    function buildView(n) {
        const opt = state.options;
        const cls = n.cls;
        const outside = n.kind === 'class' && !!n.reason;
        const header = [];
        const stereo = [];
        if (n.kind === 'external') stereo.push('external');
        if (n.kind === 'unresolved') stereo.push('unresolved');
        if (n.kind === 'templateParam') stereo.push('template parameter');
        if (cls) {
            if (cls.kind !== 'class') stereo.push(cls.kind);
            if (cls.isAbstract) stereo.push('abstract');
            if (cls.isFinal) stereo.push('final');
            if (outside) stereo.push('external');
        }
        if (cls && cls.templateParams) header.push({ text: `template${cls.templateParams}`, cls: 'stereo', size: M.small });
        if (stereo.length) header.push({ text: `«${stereo.join(', ')}»`, cls: 'stereo', size: M.small });
        header.push({ text: n.label, cls: 'name' + (cls && cls.isAbstract ? ' abstract' : ''), bold: true, italic: !!(cls && cls.isAbstract), size: M.size + 1 });
        const ns = cls ? cls.scope.join('::') : n.qualifiedName.includes('::') ? n.qualifiedName.replace(/::[^:]*$/, '') : '';
        if (ns) header.push({ text: ns, cls: 'ns', size: M.small });
        if (n.reason && n.kind !== 'templateParam') header.push({ text: n.reason, cls: 'reason', size: M.small, italic: true });

        const collapsed = state.collapsed.has(n.id);
        const compartments = [];
        let hasMembers = false;
        if (cls && cls.members.length) {
            hasMembers = opt.showMembers !== 'none';
            if (opt.showMembers !== 'none' && !collapsed) {
                const visible = cls.members
                    .map((m, i) => ({ m, i }))
                    .filter(x => memberShown(n, x.m))
                    .sort(compareMembers);
                const fields = visible.filter(x => x.m.kind === 'field');
                const methods = visible.filter(x => x.m.kind !== 'field');
                for (const [key, list] of [['fields', fields], ['methods', methods]]) {
                    if (!list.length) continue;
                    if (state.collapsedParts.has(n.id + ':' + key)) {
                        compartments.push({ key, rows: [], more: 0, collapsible: false, folded: true, count: list.length });
                        continue;
                    }
                    const expanded = state.expanded.has(n.id + ':' + key);
                    let rows = list;
                    let more = 0;
                    if (list.length > MAX_ROWS && !expanded) {
                        rows = list.slice(0, MAX_ROWS - 1);
                        more = list.length - rows.length;
                    }
                    compartments.push({ key, rows, more, collapsible: list.length > MAX_ROWS && expanded });
                }
            }
        }

        // Access checkboxes in the title, while members are shown.
        const accessRow = hasMembers && !collapsed ? accessRowItems(n) : null;

        // Width (rows keep PART_TOGGLE_W free on the right for the section toggle)
        const iconSpace = 26;
        let w = accessRow ? accessRow.width + 2 * M.pad : 0;
        for (const h of header) w = Math.max(w, textWidth(h.text, h) + 2 * M.pad + (h.cls.startsWith('name') ? 36 : 0));
        for (const c of compartments) {
            if (c.folded) w = Math.max(w, textWidth(partSummary(c), { size: M.small, italic: true }) + iconSpace + 2 * M.pad + PART_TOGGLE_W);
            for (const { m } of c.rows) {
                const l = memberLabel(m);
                w = Math.max(w, textWidth(l.main + ' ' + l.type, { italic: m.isVirtual }) + iconSpace + 2 * M.pad + PART_TOGGLE_W);
            }
        }
        w = Math.ceil(Math.min(MAX_W, Math.max(MIN_W, w)));

        // Height
        const lineH = h => Math.round((h.size || M.size) * 1.45);
        const headerH = header.reduce((s, h) => s + lineH(h), 0) + 2 * 6 + (accessRow ? accessRow.height : 0);
        let hgt = headerH;
        for (const c of compartments) hgt += 6 + (c.folded ? 1 : c.rows.length + (c.more || c.collapsible ? 1 : 0)) * M.row;
        return { id: n.id, node: n, header, headerH, compartments, hasMembers, collapsed, accessRow, w, h: Math.ceil(hgt), iconSpace, outside, lineH };
    }

    // ------------------------------------------------------------------ rendering

    function render(preserveView) {
        const g = state.graph;
        if (!g) return;
        M = readMetrics();
        // Relations filter: which edges are drawn, and which relation-only classes appear.
        state.visibleEdges = g.edges.filter(edgeVisible);
        state.edgeByKey = new Map(state.visibleEdges.map(e => [e.key, e]));
        state.degree = new Map();
        state.visibleEdges.forEach(e => {
            if (e.from === e.to) return;
            state.degree.set(e.from, (state.degree.get(e.from) || 0) + 1);
            state.degree.set(e.to, (state.degree.get(e.to) || 0) + 1);
        });
        const linked = new Set();
        state.visibleEdges.forEach(e => { linked.add(e.from); linked.add(e.to); });
        const nodes = g.nodes.filter(n => !n.relationOnly || linked.has(n.id));
        state.views = new Map(nodes.map(n => [n.id, buildView(n)]));

        // Classes without any (shown) relationship in this graph.
        const standalone = nodes.filter(n => !linked.has(n.id));
        const mode = state.options.standalone;
        const grouping = (mode === 'namespace' || mode === 'folder') && standalone.length > 1;
        const excluded = new Set(grouping || mode === 'hidden' ? standalone.map(n => n.id) : []);
        state.hiddenCount = mode === 'hidden' ? standalone.length : 0;
        state.standaloneCount = standalone.length;
        state.groups = grouping ? buildGroups(standalone, mode) : [];
        state.groupOf = new Map();
        state.groups.forEach(gr => gr.ids.forEach(id => state.groupOf.set(id, gr.key)));

        // Self-relationships are drawn as loops on the right of the box; reserve room for them.
        const loops = new Map();
        state.visibleEdges.filter(e => e.from === e.to).forEach(e => {
            if (!loops.has(e.from)) loops.set(e.from, []);
            loops.get(e.from).push(e);
        });
        const reserveOf = id => {
            const list = loops.get(id);
            if (!list) return 0;
            return 40 + 12 * list.length + Math.max(...list.map(e => textWidth(edgeLabel(e), { size: M.small })));
        };
        const layoutInput = [...state.views.values()].filter(v => !excluded.has(v.id))
            .map(v => ({ id: v.id, width: v.w + 2 * reserveOf(v.id), height: v.h }));
        for (const gr of state.groups) layoutInput.push({ id: GROUP_PREFIX + gr.key, width: gr.w, height: gr.h });
        const layoutEdges = state.visibleEdges.filter(e => e.from !== e.to).map(e => ({ from: e.from, to: e.to, key: e.key }));
        state.layout = InheritanceLayout.layout(layoutInput, layoutEdges, { direction: state.options.direction });

        state.positions = {};
        for (const id in state.layout.nodes) {
            if (id.startsWith(GROUP_PREFIX)) continue;
            const b = state.layout.nodes[id];
            const r = reserveOf(id);
            state.positions[id] = { x: b.x + r, y: b.y, width: b.width - 2 * r, height: b.height };
        }
        for (const gr of state.groups) {
            gr.pos = state.layout.nodes[GROUP_PREFIX + gr.key];
            if (!gr.open) continue;
            for (const id of gr.ids) {
                const o = gr.offsets[id];
                const v = state.views.get(id);
                state.positions[id] = { x: gr.pos.x + o.x, y: gr.pos.y + o.y, width: v.w, height: v.h };
            }
        }

        groupsLayer.textContent = '';
        edgesLayer.textContent = '';
        nodesLayer.textContent = '';
        for (const le of state.layout.edges) drawEdge(le, state.edgeByKey.get(le.key));
        for (const [id, list] of loops) if (state.positions[id]) list.forEach((e, i) => drawSelfLoop(e, state.positions[id], i));
        for (const gr of state.groups) drawGroup(gr);
        for (const v of state.views.values()) if (state.positions[v.id]) drawNode(v, state.positions[v.id]);

        applyHighlight();
        applySearch(false);
        if (preserveView) applyTransform();
        else fitView();
        updateStatus();
    }

    // ------------------------------------------------------------------ standalone groups

    function groupKeyOf(n, mode) {
        if (mode === 'folder') {
            const loc = n.loc || (n.cls && n.cls.loc);
            const rel = loc ? relPath(loc.file) : '';
            return rel.includes('/') ? rel.replace(/\/[^/]*$/, '') : rel ? '.' : '(unknown location)';
        }
        if (n.cls) return n.cls.scope.join('::') || '(global namespace)';
        return n.qualifiedName.includes('::') ? n.qualifiedName.replace(/::[^:]*$/, '') : '(global namespace)';
    }

    function isGroupOpen(key, size) {
        const explicit = state.groupOpen[key];
        return explicit === undefined ? size <= GROUP_AUTO_OPEN : explicit;
    }

    function buildGroups(nodes, mode) {
        const byKey = new Map();
        for (const n of nodes) {
            const key = groupKeyOf(n, mode);
            if (!byKey.has(key)) byKey.set(key, []);
            byKey.get(key).push(n);
        }
        const groups = [...byKey.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([key, list]) => {
            list.sort((a, b) => a.label.localeCompare(b.label));
            return { key, ids: list.map(n => n.id), labels: list.map(n => n.label), open: isGroupOpen(key, list.length) };
        });
        groups.forEach(sizeGroup);
        return groups;
    }

    /** Compute a group's box: header only when collapsed, a packed grid of classes when open. */
    function sizeGroup(gr) {
        const pad = 14;
        gr.title = gr.key;
        gr.count = `${gr.ids.length} standalone class${gr.ids.length === 1 ? '' : 'es'}`;
        const titleW = textWidth(gr.title, { bold: true, size: M.size + 1 }) + textWidth('   ' + gr.count, { size: M.small }) + 2 * pad + 24;
        gr.headerH = M.row + 14;
        gr.offsets = {};
        if (!gr.open) {
            gr.w = Math.ceil(Math.min(640, Math.max(260, titleW)));
            gr.preview = ellipsize(gr.labels.join(', '), gr.w - 2 * pad, { size: M.small });
            gr.h = gr.headerH + M.row + 6;
            return;
        }
        const views = gr.ids.map(id => state.views.get(id));
        const gap = 18;
        const area = views.reduce((a, v) => a + (v.w + gap) * (v.h + gap), 0);
        const widest = views.reduce((m, v) => Math.max(m, v.w), 0);
        const rowWidth = Math.max(widest, Math.sqrt(area * 1.6), titleW - 2 * pad);
        let x = 0, y = 0, rowH = 0, maxX = 0;
        for (const v of views) {
            if (x > 0 && x + v.w > rowWidth) { x = 0; y += rowH + gap; rowH = 0; }
            gr.offsets[v.id] = { x: pad + x, y: gr.headerH + y };
            x += v.w + gap;
            rowH = Math.max(rowH, v.h);
            maxX = Math.max(maxX, x - gap);
        }
        gr.w = Math.ceil(Math.max(maxX + 2 * pad, titleW));
        gr.h = Math.ceil(gr.headerH + y + rowH + pad);
    }

    function drawGroup(gr) {
        const p = gr.pos;
        const g = el('g', { class: `group ${gr.open ? 'open' : 'closed'}`, 'data-group': gr.key, transform: `translate(${p.x},${p.y})` }, groupsLayer);
        el('rect', { class: 'group-frame', width: gr.w, height: gr.h, rx: 6 }, g);
        const hit = el('rect', { class: 'group-header', width: gr.w, height: gr.headerH, rx: 6, 'data-action': 'group-toggle' }, g);
        el('title', null, hit, `${gr.key}: ${gr.count} without inheritance relations\nClick to ${gr.open ? 'collapse' : 'expand'}, Alt+click for all groups`);
        const cy = gr.headerH / 2;
        el('path', {
            class: 'chevron', 'pointer-events': 'none',
            d: gr.open ? `M10,${cy - 3} L20,${cy - 3} L15,${cy + 3} Z` : `M12,${cy - 5} L18,${cy} L12,${cy + 5} Z`,
        }, g);
        const t = el('text', { class: 'group-title', x: 28, y: cy, 'pointer-events': 'none' }, g);
        el('tspan', { 'font-weight': 'bold', 'font-size': M.size + 1 }, t, gr.title);
        el('tspan', { class: 'group-count', 'font-size': M.small, dx: textWidth('   ', { size: M.small }) }, t, gr.count);
        if (!gr.open) {
            el('text', { class: 'group-preview', x: 14, y: gr.headerH + M.row / 2, 'font-size': M.small, 'pointer-events': 'none' }, g, gr.preview);
        } else {
            el('line', { class: 'divider', x1: 0, x2: gr.w, y1: gr.headerH - 4, y2: gr.headerH - 4 }, g);
        }
    }

    function setGroupOpen(key, open) {
        state.groupOpen[key] = open;
        const gr = state.groups.find(x => x.key === key);
        if (gr) gr.open = open;
    }

    function curve(points, lr) {
        let d = `M${points[0].x},${points[0].y}`;
        for (let i = 1; i < points.length; i++) {
            const a = points[i - 1], b = points[i];
            if ((lr ? a.y === b.y : a.x === b.x)) { d += ` L${b.x},${b.y}`; continue; }
            if (lr) {
                const mx = (a.x + b.x) / 2;
                d += ` C${mx},${a.y} ${mx},${b.y} ${b.x},${b.y}`;
            } else {
                const my = (a.y + b.y) / 2;
                d += ` C${a.x},${my} ${b.x},${my} ${b.x},${b.y}`;
            }
        }
        return d;
    }

    function edgeVisible(e) {
        const r = state.options.relations || {};
        if (e.kind === 'generalization') return !!r.inheritance;
        if (e.kind === 'realization') return !!(r.inheritance || r.realization);
        return !!r[e.kind];
    }

    /** How an edge is drawn: realization looks like plain inheritance unless it is selected in the menu. */
    function edgeStyle(e) {
        return e.kind === 'realization' && !(state.options.relations || {}).realization ? 'generalization' : e.kind;
    }

    function edgeLabel(e) {
        if (INHERITANCE.has(e.kind)) {
            return [e.templateArgs, e.access !== 'public' ? e.access : '', e.isVirtual ? 'virtual' : ''].filter(Boolean).join(' ');
        }
        const who = e.kind === 'dependency' ? e.label : `${VIS[e.access] || ''}${e.label || ''}`;
        return ellipsize(`${who || ''}${e.multiplicity ? ` [${e.multiplicity}]` : ''}`, 220, { size: M.small });
    }

    function edgeTitle(e) {
        const fromV = state.views.get(e.from), toV = state.views.get(e.to);
        const a = fromV ? fromV.node.qualifiedName : e.from, b = toV ? toV.node.qualifiedName : e.to;
        if (INHERITANCE.has(e.kind)) {
            return `${a} ⟶ ${b}\n${e.isVirtual ? 'virtual ' : ''}${e.access} ${REL_TITLES[e.kind]}` +
                (e.templateArgs ? `, template arguments ${e.templateArgs}` : '');
        }
        return `${a} ⟶ ${b}\n${REL_TITLES[e.kind]}${e.multiplicity ? `, multiplicity ${e.multiplicity}` : ''}` +
            (e.label ? `\nvia ${e.label}` : '');
    }

    function setMarkers(path, style, highlight) {
        let [start, end] = REL_MARKERS[style];
        if (style === 'generalization' && highlight) end = highlight === 'to-child' ? 'arrow-child' : 'arrow-parent';
        if (start) path.setAttribute('marker-start', `url(#${start})`); else path.removeAttribute('marker-start');
        if (end) path.setAttribute('marker-end', `url(#${end})`); else path.removeAttribute('marker-end');
    }

    function drawEdge(le, e) {
        if (!e) return;
        const lr = state.options.direction === 'LR';
        const style = edgeStyle(e);
        const g = el('g', { class: `edge rel-${style}` + (e.isVirtual ? ' virtual' : ''), 'data-key': e.key, 'data-from': e.from, 'data-to': e.to }, edgesLayer);
        const d = curve(le.points, lr);
        el('title', null, g, edgeTitle(e));
        el('path', { class: 'hit', d }, g);
        setMarkers(el('path', { class: 'line', d }, g), style, null);
        const label = edgeLabel(e);
        if (label) {
            // Place the label towards the end where fewer edges meet: there the edges have
            // fanned out, so labels of edges sharing a class do not collide.
            const fromDeg = state.degree.get(e.from) || 0, toDeg = state.degree.get(e.to) || 0;
            const t = fromDeg > toDeg ? 0.72 : fromDeg < toDeg ? 0.28 : 0.5;
            const p = pointAlong(le.points, t);
            const text = INHERITANCE.has(e.kind) ? ellipsize(label, 220, { size: M.small }) : label;
            el('text', { x: p.x, y: p.y, 'text-anchor': 'middle' }, g, text);
        }
    }

    /** Point at fraction `t` of a polyline's length. */
    function pointAlong(points, t) {
        const seg = [];
        let total = 0;
        for (let i = 1; i < points.length; i++) {
            const l = Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
            seg.push(l);
            total += l;
        }
        let want = total * t;
        for (let i = 1; i < points.length; i++) {
            if (want <= seg[i - 1] || i === points.length - 1) {
                const f = seg[i - 1] ? Math.min(1, want / seg[i - 1]) : 0;
                return { x: points[i - 1].x + (points[i].x - points[i - 1].x) * f, y: points[i - 1].y + (points[i].y - points[i - 1].y) * f };
            }
            want -= seg[i - 1];
        }
        return points[0];
    }

    /** A relationship of a class with itself (e.g. `Node* m_parent`) as a loop on the box's right side. */
    function drawSelfLoop(e, pos, index) {
        const style = edgeStyle(e);
        const g = el('g', { class: `edge self rel-${style}`, 'data-key': e.key, 'data-from': e.from, 'data-to': e.to }, edgesLayer);
        const x = pos.x + pos.width;
        const y1 = pos.y + 14 + index * 26, y2 = y1 + 16;
        const out = 34 + index * 12;
        const d = `M${x},${y1} C${x + out},${y1 - 12} ${x + out},${y2 + 12} ${x},${y2}`;
        el('title', null, g, edgeTitle(e));
        el('path', { class: 'hit', d }, g);
        setMarkers(el('path', { class: 'line', d }, g), style, null);
        const label = edgeLabel(e);
        if (label) el('text', { x: x + out + 4, y: (y1 + y2) / 2, 'text-anchor': 'start' }, g, label);
    }

    function drawNode(v, pos) {
        const n = v.node;
        const classes = ['node', n.kind];
        if (n.isSeed) classes.push('seed');
        if (v.outside) classes.push('outside');
        const g = el('g', { class: classes.join(' '), 'data-id': n.id, transform: `translate(${pos.x},${pos.y})` }, nodesLayer);
        const w = v.w, h = v.h, r = 4;
        el('rect', { class: 'bg', width: w, height: h, rx: r }, g);
        el('path', {
            class: 'header',
            d: `M0.5,${v.headerH} V${r} Q0.5,0.5 ${r},0.5 H${w - r} Q${w - 0.5},0.5 ${w - 0.5},${r} V${v.headerH} Z`,
        }, g);

        // Header (title) area: clicking it targets the class itself.
        const titleHit = el('rect', { class: 'title-hit', width: w, height: v.headerH, 'data-role': 'title' }, g);
        const loc = n.loc || (n.cls && n.cls.loc);
        el('title', null, titleHit, [n.qualifiedName, loc ? `${relPath(loc.file)}:${loc.line + 1}` : '', n.reason || '',
            n.cls ? `source: ${n.cls.sources.join(' + ')}` : ''].filter(Boolean).join('\n'));
        let y = 6;
        for (const line of v.header) {
            const lh = v.lineH(line);
            const maxW = w - 2 * M.pad - (line.cls.startsWith('name') ? 36 : 0);
            el('text', {
                class: line.cls,
                x: w / 2, y: y + lh / 2, 'text-anchor': 'middle',
                'font-size': line.size, 'pointer-events': 'none',
            }, g, ellipsize(line.text, maxW, line));
            y += lh;
        }
        if (v.accessRow) drawAccessRow(g, v, y);
        if (v.hasMembers) {
            const cx = w - 14, cy = 14;
            const hit = el('rect', { class: 'chevron-hit', x: w - 28, y: 0, width: 28, height: 28, 'data-action': 'toggle' }, g);
            el('title', null, hit, v.collapsed ? 'Show members' : 'Hide members');
            el('path', {
                class: 'chevron', 'data-action': 'toggle',
                d: v.collapsed ? `M${cx - 3},${cy - 5} L${cx + 3},${cy} L${cx - 3},${cy + 5} Z` : `M${cx - 5},${cy - 3} L${cx + 5},${cy - 3} L${cx},${cy + 3} Z`,
            }, g);
        }

        // Compartments
        y = v.headerH;
        for (const c of v.compartments) {
            el('line', { class: 'divider', x1: 0, x2: w, y1: y, y2: y }, g);
            y += 3;
            // Section toggle (▾ expanded / ▸ collapsed) at the top right of the section.
            const cx = w - PART_TOGGLE_W / 2 - 3, cy = y + M.row / 2;
            const what = PART_NAMES[c.key][1];
            if (c.folded) {
                const row = el('g', { class: 'row part-summary', 'data-action': 'part-toggle', 'data-key': c.key }, g);
                el('rect', { class: 'row-bg', x: 1, y, width: w - 2, height: M.row }, row);
                el('text', { class: 'more', x: M.pad + v.iconSpace, y: cy, 'font-size': M.small }, row, partSummary(c));
                el('path', { class: 'chevron', d: `M${cx - 3},${cy - 5} L${cx + 3},${cy} L${cx - 3},${cy + 5} Z` }, row);
                el('title', null, row, `Show ${what} (Alt+click: in all classes)`);
                y += M.row + 3;
                continue;
            }
            const topY = y;
            for (const { m, i } of c.rows) {
                drawRow(g, v, m, i, y);
                y += M.row;
            }
            // Drawn after the rows so the rows' hover backgrounds do not cover it.
            const hit = el('rect', { class: 'chevron-hit', x: w - PART_TOGGLE_W - 6, y: topY, width: PART_TOGGLE_W + 6, height: M.row, 'data-action': 'part-toggle', 'data-key': c.key }, g);
            el('title', null, hit, `Hide ${what} (Alt+click: in all classes)`);
            el('path', { class: 'chevron', 'data-action': 'part-toggle', 'data-key': c.key, 'pointer-events': 'none', d: `M${cx - 4},${cy - 2} L${cx + 4},${cy - 2} L${cx},${cy + 3} Z` }, g);
            if (c.more || c.collapsible) {
                const row = el('g', { class: 'row', 'data-action': 'more', 'data-key': c.key }, g);
                el('rect', { class: 'row-bg', x: 1, y, width: w - 2, height: M.row }, row);
                el('text', { class: 'more', x: M.pad + v.iconSpace, y: y + M.row / 2, 'font-size': M.small }, row,
                    c.more ? `… ${c.more} more ${PART_NAMES[c.key][1]}` : `▴ show fewer ${PART_NAMES[c.key][1]}`);
                y += M.row;
            }
            y += 3;
        }
        el('rect', { class: 'box', width: w, height: h, rx: r, fill: 'none' }, g);
    }

    /** Three checkboxes (public / protected / private) centred in the bottom row of the title. */
    function drawAccessRow(g, v, y) {
        const { items, width, height } = v.accessRow;
        const hidden = state.hiddenAccess[v.id] || [];
        const x0 = (v.w - width) / 2;
        const cy = y + height / 2 - 1;
        for (const it of items) {
            const byMenu = state.options.showMembers === 'public' && it.access !== 'public';
            const checked = !hidden.includes(it.access) && !byMenu;
            const cls = ['access-toggle', checked ? 'checked' : '', (!it.count || byMenu) ? 'inactive' : ''].filter(Boolean).join(' ');
            const item = el('g', { class: cls, 'data-action': 'access-toggle', 'data-access': it.access }, g);
            const bx = x0 + it.x, by = cy - it.box / 2;
            el('rect', { class: 'cb-hit', x: bx - 3, y: cy - height / 2, width: it.w + 6, height }, item);
            el('rect', { class: 'cb', x: bx + 0.5, y: by + 0.5, width: it.box - 1, height: it.box - 1, rx: 2 }, item);
            if (checked) {
                const b = it.box;
                el('path', { class: 'cb-check', d: `M${bx + b * 0.22},${by + b * 0.52} L${bx + b * 0.42},${by + b * 0.74} L${bx + b * 0.8},${by + b * 0.28}` }, item);
            }
            el('text', { class: 'cb-label', x: bx + it.box + 4, y: cy + 0.5, 'font-size': M.small }, item, it.label);
            const what = `${it.access} member${it.count === 1 ? '' : 's'}`;
            el('title', null, item, byMenu
                ? `${it.count} ${what} – hidden by the Members menu (Public)`
                : `${checked ? 'Hide' : 'Show'} ${it.count} ${what} (Alt+click: in all classes). Static members are always shown.`);
        }
    }

    function drawRow(g, v, m, index, y) {
        const w = v.w;
        const row = el('g', { class: 'row', 'data-mi': index }, g);
        el('rect', { class: 'row-bg', x: 1, y, width: w - 2, height: M.row }, row);
        const cy = y + M.row / 2;
        const ix = M.pad + 5;
        const kindCls = m.kind === 'field' ? 'field' : m.kind === 'constructor' || m.kind === 'destructor' ? 'ctor' : 'method';
        if (kindCls === 'field') el('rect', { class: `icon ${kindCls}`, x: ix - 4, y: cy - 4, width: 8, height: 8, rx: 1 }, row);
        else el('path', { class: `icon ${kindCls}`, d: `M${ix},${cy - 5} L${ix + 5},${cy} L${ix},${cy + 5} L${ix - 5},${cy} Z` }, row);
        el('text', { class: 'vis', x: ix + 9, y: cy, 'font-size': M.size }, row, VIS[m.access] || ' ');
        const l = memberLabel(m);
        const x0 = M.pad + v.iconSpace;
        const avail = w - x0 - M.pad - PART_TOGGLE_W;
        const textCls = [m.isVirtual ? 'virtual' : '', m.isStatic ? 'static' : ''].filter(Boolean).join(' ');
        const full = `${l.main} ${l.type}`.trim();
        const t = el('text', { x: x0, y: cy, class: textCls || null }, row);
        if (textWidth(full, { italic: m.isVirtual }) <= avail) {
            el('tspan', null, t, l.main);
            if (l.type) el('tspan', { class: 'type', dx: textWidth(' ') }, t, l.type);
        } else {
            el('tspan', null, t, ellipsize(full, avail, { italic: m.isVirtual }));
        }
        const flags = [m.isStatic ? 'static' : '', m.isVirtual ? 'virtual' : '', m.isOverride ? 'override' : '', m.isPure ? 'pure virtual' : ''].filter(Boolean).join(', ');
        el('title', null, row, `${m.access} ${m.kind}${flags ? ` (${flags})` : ''}\n${full}` +
            (m.loc ? `\n${relPath(m.loc.file)}:${m.loc.line + 1}` : ''));
    }

    // ------------------------------------------------------------------ highlight & selection

    const HIGHLIGHT_CLASSES = ['selected', 'parent', 'ancestor', 'child', 'descendant', 'related', 'faded'];
    const EDGE_CLASSES = ['to-parent', 'to-ancestor', 'to-child', 'hi', 'faded'];

    function applyHighlight() {
        const sel = state.selected && state.views.has(state.selected) ? state.selected : null;
        svg.classList.toggle('dim', !!sel);
        const nodeEls = nodesLayer.querySelectorAll('.node');
        const edgeEls = edgesLayer.querySelectorAll('.edge');
        groupsLayer.querySelectorAll('.group').forEach(gEl => gEl.classList.toggle('faded', !!sel && state.groupOf.get(sel) !== gEl.dataset.group));
        nodeEls.forEach(n => {
            n.classList.remove(...HIGHLIGHT_CLASSES);
            [...n.classList].filter(c => c.startsWith('rel-')).forEach(c => n.classList.remove(c));
        });
        edgeEls.forEach(eEl => {
            eEl.classList.remove(...EDGE_CLASSES);
            const e = state.edgeByKey.get(Number(eEl.dataset.key));
            if (e) setMarkers(eEl.querySelector('path.line'), edgeStyle(e), null);
        });
        if (!sel) return;

        const edges = state.visibleEdges;
        const nodeRole = new Map([[sel, ['selected']]]);
        const edgeRole = new Map();
        const setRole = (id, role) => { if (!nodeRole.has(id)) nodeRole.set(id, role); };
        const parentsOf = id => edges.filter(e => e.from === id && INHERITANCE.has(e.kind));
        const childrenOf = id => edges.filter(e => e.to === id && INHERITANCE.has(e.kind));
        const inheritanceRole = (e, role) => (edgeStyle(e) === 'generalization' ? role : 'hi');
        // Direct parents always.
        for (const e of parentsOf(sel)) {
            const r = inheritanceRole(e, 'to-parent');
            edgeRole.set(e, r);
            setRole(e.to, r === 'hi' ? ['related', `rel-${edgeStyle(e)}`] : ['parent']);
        }
        if (state.options.highlight !== 'parents') {
            const queue = parentsOf(sel).map(e => e.to);
            const seen = new Set(queue);
            while (queue.length) {
                const id = queue.shift();
                for (const e of parentsOf(id)) {
                    if (!edgeRole.has(e)) edgeRole.set(e, inheritanceRole(e, 'to-ancestor'));
                    setRole(e.to, ['ancestor']);
                    if (!seen.has(e.to)) { seen.add(e.to); queue.push(e.to); }
                }
            }
        }
        if (state.options.highlight === 'lineage') {
            const queue = [sel];
            const seen = new Set(queue);
            while (queue.length) {
                const id = queue.shift();
                for (const e of childrenOf(id)) {
                    edgeRole.set(e, inheritanceRole(e, 'to-child'));
                    setRole(e.from, [id === sel ? 'child' : 'descendant']);
                    if (!seen.has(e.from)) { seen.add(e.from); queue.push(e.from); }
                }
            }
        }
        // Other relationships: direct counterparts in both directions.
        for (const e of edges) {
            if (INHERITANCE.has(e.kind) || (e.from !== sel && e.to !== sel)) continue;
            edgeRole.set(e, 'hi');
            setRole(e.from === sel ? e.to : e.from, ['related', `rel-${e.kind}`]);
        }
        nodeEls.forEach(n => {
            const role = nodeRole.get(n.dataset.id);
            n.classList.add(...(role || ['faded']));
        });
        edgeEls.forEach(eEl => {
            const e = state.edgeByKey.get(Number(eEl.dataset.key));
            const role = e && edgeRole.get(e);
            eEl.classList.add(role || 'faded');
            if (role) {
                setMarkers(eEl.querySelector('path.line'), edgeStyle(e), role === 'hi' ? null : role);
                // Bring highlighted edges to the front.
                edgesLayer.appendChild(eEl);
            }
        });
        const selEl = nodesLayer.querySelector(`.node[data-id="${cssEscape(sel)}"]`);
        if (selEl) nodesLayer.appendChild(selEl);
    }

    function cssEscape(s) {
        return window.CSS && CSS.escape ? CSS.escape(s) : s.replace(/["\\]/g, '\\$&');
    }

    function select(id) {
        state.selected = id;
        applyHighlight();
        updateStatus();
        persist();
    }

    // ------------------------------------------------------------------ navigation

    function navigate(nodeId, memberIndex, preserveFocus) {
        const v = state.views.get(nodeId);
        if (!v) return;
        const n = v.node;
        let loc = n.loc || (n.cls && n.cls.loc);
        if (memberIndex !== undefined && n.cls && n.cls.members[memberIndex] && n.cls.members[memberIndex].loc) {
            loc = n.cls.members[memberIndex].loc;
        }
        if (!loc) {
            setStatusMessage(`No source location known for ${n.qualifiedName}`);
            return;
        }
        vscode.postMessage({ type: 'navigate', file: loc.file, line: loc.line, column: loc.column, preserveFocus: !!preserveFocus });
    }

    // ------------------------------------------------------------------ view transform

    function applyTransform() {
        viewport.setAttribute('transform', `translate(${T.x},${T.y}) scale(${T.k})`);
        $('zoom').textContent = `${Math.round(T.k * 100)}%`;
    }

    function fitView() {
        if (!state.layout) return;
        const r = svg.getBoundingClientRect();
        const W = r.width || 800, H = r.height || 600;
        const k = Math.min(1.25, Math.max(MIN_ZOOM, Math.min(W / state.layout.width, H / state.layout.height)));
        T.k = k;
        T.x = (W - state.layout.width * k) / 2;
        T.y = (H - state.layout.height * k) / 2;
        applyTransform();
        persist();
    }

    function zoomAt(px, py, factor) {
        const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, T.k * factor));
        T.x = px - (px - T.x) * (k / T.k);
        T.y = py - (py - T.y) * (k / T.k);
        T.k = k;
        applyTransform();
        schedulePersist();
    }

    function zoomCenter(factor) {
        const r = svg.getBoundingClientRect();
        zoomAt(r.width / 2, r.height / 2, factor);
    }

    function centerOn(id) {
        const p = state.positions[id];
        if (!p) return;
        const r = svg.getBoundingClientRect();
        if (T.k < 0.6) T.k = 0.9;
        T.x = r.width / 2 - (p.x + p.width / 2) * T.k;
        T.y = r.height / 2 - (p.y + p.height / 2) * T.k;
        applyTransform();
        persist();
    }

    let persistTimer = 0;
    function schedulePersist() {
        clearTimeout(persistTimer);
        persistTimer = setTimeout(persist, 250);
    }

    // ------------------------------------------------------------------ pointer interaction

    let drag = null;
    let lastClick = null;

    svg.addEventListener('pointerdown', e => {
        if (e.button !== 0 && e.button !== 1) return;
        drag = { x: e.clientX, y: e.clientY, tx: T.x, ty: T.y, moved: false, target: e.target, id: e.pointerId };
        svg.setPointerCapture(e.pointerId);
    });
    svg.addEventListener('pointermove', e => {
        if (!drag || drag.id !== e.pointerId) return;
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        if (!drag.moved && Math.hypot(dx, dy) > 4) {
            drag.moved = true;
            svg.classList.add('panning');
        }
        if (drag.moved) {
            T.x = drag.tx + dx;
            T.y = drag.ty + dy;
            applyTransform();
        }
    });
    const endDrag = e => {
        if (!drag || drag.id !== e.pointerId) return;
        const d = drag;
        drag = null;
        svg.classList.remove('panning');
        if (svg.hasPointerCapture(e.pointerId)) svg.releasePointerCapture(e.pointerId);
        if (d.moved) schedulePersist();
        else if (e.type === 'pointerup' && e.button === 0) handleClick(d.target, e);
    };
    svg.addEventListener('pointerup', endDrag);
    svg.addEventListener('pointercancel', endDrag);

    svg.addEventListener('wheel', e => {
        e.preventDefault();
        const r = svg.getBoundingClientRect();
        const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? r.height : 1;
        // Pinch gestures arrive as ctrl+wheel with small deltas.
        const factor = Math.exp(-e.deltaY * unit * (e.ctrlKey ? 0.01 : 0.0015));
        zoomAt(e.clientX - r.left, e.clientY - r.top, factor);
    }, { passive: false });

    function handleClick(target, e) {
        // Header of any group, or anywhere on a collapsed group.
        const groupHit = target.closest && (target.closest('[data-action="group-toggle"]') || target.closest('.group.closed'));
        if (groupHit) {
            const key = groupHit.closest('.group').dataset.group;
            const gr = state.groups.find(x => x.key === key);
            const open = !(gr && gr.open);
            if (e.altKey) state.groups.forEach(x => setGroupOpen(x.key, open));
            else setGroupOpen(key, open);
            persist();
            render(true);
            return;
        }
        const nodeEl = target.closest && target.closest('.node');
        if (!nodeEl) {
            lastClick = null;
            if (state.selected) select(null);
            return;
        }
        const id = nodeEl.dataset.id;
        const actionEl = target.closest('[data-action]');
        if (actionEl) {
            const action = actionEl.dataset.action;
            if (action === 'toggle') {
                if (state.collapsed.has(id)) state.collapsed.delete(id); else state.collapsed.add(id);
            } else if (action === 'access-toggle') {
                const access = actionEl.dataset.access;
                const hide = !(state.hiddenAccess[id] || []).includes(access);
                // Alt+click: the same access level in every class.
                const ids = e.altKey ? [...state.views.keys()] : [id];
                for (const nid of ids) {
                    const list = (state.hiddenAccess[nid] || []).filter(a => a !== access);
                    if (hide) list.push(access);
                    if (list.length) state.hiddenAccess[nid] = list; else delete state.hiddenAccess[nid];
                }
            } else if (action === 'part-toggle') {
                const key = id + ':' + actionEl.dataset.key;
                const collapse = !state.collapsedParts.has(key);
                // Alt+click: the same section in every class.
                const ids = e.altKey ? [...state.views.keys()] : [id];
                for (const nid of ids) {
                    const k = nid + ':' + actionEl.dataset.key;
                    if (collapse) state.collapsedParts.add(k); else state.collapsedParts.delete(k);
                }
            } else if (action === 'more') {
                const key = id + ':' + actionEl.dataset.key;
                if (state.expanded.has(key)) state.expanded.delete(key); else state.expanded.add(key);
            }
            persist();
            render(true);
            return;
        }
        const rowEl = target.closest('.row');
        const memberIndex = rowEl && rowEl.dataset.mi !== undefined ? Number(rowEl.dataset.mi) : undefined;
        if (state.selected !== id) select(id);
        const now = Date.now();
        const key = `${id}#${memberIndex === undefined ? 'title' : memberIndex}`;
        const isDouble = !!lastClick && lastClick.key === key && now - lastClick.t < 450;
        lastClick = isDouble ? null : { key, t: now };
        const modifier = e.ctrlKey || e.metaKey;
        if (modifier || isDouble) navigate(id, memberIndex, false);
        else if (state.options.navigateOn === 'click') navigate(id, memberIndex, true);
    }

    // ------------------------------------------------------------------ search

    function applySearch(jump) {
        const q = $('search').value.trim().toLowerCase();
        nodesLayer.querySelectorAll('.node.match').forEach(n => n.classList.remove('match'));
        groupsLayer.querySelectorAll('.group.match').forEach(n => n.classList.remove('match'));
        state.matches = [];
        if (!q || !state.graph) { updateStatus(); return; }
        for (const n of state.graph.nodes) {
            if (!state.views.has(n.id)) continue; // hidden by the Relations filter
            if (n.qualifiedName.toLowerCase().includes(q) || n.label.toLowerCase().includes(q)) state.matches.push(n.id);
        }
        state.matches.forEach(id => {
            const nodeEl = nodesLayer.querySelector(`.node[data-id="${cssEscape(id)}"]`);
            if (nodeEl) nodeEl.classList.add('match');
            // Matches inside a collapsed group mark the group.
            const key = state.groupOf.get(id);
            if (!nodeEl && key !== undefined) {
                const gEl = groupsLayer.querySelector(`.group[data-group="${cssEscape(key)}"]`);
                if (gEl) gEl.classList.add('match');
            }
        });
        if (jump && state.matches.length) {
            state.matchIndex = (state.matchIndex + 1) % state.matches.length;
            const id = state.matches[state.matchIndex];
            const key = state.groupOf.get(id);
            const gr = key !== undefined && state.groups.find(x => x.key === key);
            if (gr && !gr.open) {
                setGroupOpen(key, true);
                persist();
                render(true);
            }
            select(id);
            centerOn(id);
        }
        updateStatus();
    }

    // ------------------------------------------------------------------ PNG export

    /** Smallest text in the exported image, in typographic points at 96 DPI. */
    const MIN_EXPORT_PT = 11;
    const PX_PER_PT = 96 / 72;
    const EXPORT_TILE = 4096;
    const STYLE_PROPS = ['fill', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-dasharray', 'stroke-opacity', 'stroke-linejoin',
        'stroke-linecap', 'opacity', 'font-family', 'font-size', 'font-weight', 'font-style', 'text-decoration', 'text-anchor',
        'dominant-baseline', 'paint-order', 'visibility', 'display'];
    let exporting = null;

    function visibleRegion() {
        const r = svg.getBoundingClientRect();
        return { x: -T.x / T.k, y: -T.y / T.k, w: r.width / T.k, h: r.height / T.k, screen: r };
    }

    function intersects(a, b) {
        return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
    }

    /** Top-level graph elements (nodes, edges, groups) that overlap the region. */
    function elementsIn(region) {
        const keep = [];
        groupsLayer.querySelectorAll(':scope > .group').forEach(gEl => {
            const gr = state.groups.find(x => x.key === gEl.dataset.group);
            if (gr && gr.pos && intersects(region, { x: gr.pos.x, y: gr.pos.y, w: gr.w, h: gr.h })) keep.push(gEl);
        });
        edgesLayer.querySelectorAll(':scope > .edge').forEach(eEl => {
            const b = eEl.getBBox();
            if (intersects(region, { x: b.x - 20, y: b.y - 20, w: b.width + 40, h: b.height + 40 })) keep.push(eEl);
        });
        nodesLayer.querySelectorAll(':scope > .node').forEach(nEl => {
            const p = state.positions[nEl.dataset.id];
            if (p && intersects(region, { x: p.x, y: p.y, w: p.width, h: p.height })) keep.push(nEl);
        });
        return keep;
    }

    function smallestFontPx(elements) {
        let min = Infinity;
        for (const root of elements) {
            root.querySelectorAll('text, tspan').forEach(t => {
                if (!t.textContent) return;
                const fs = parseFloat(getComputedStyle(t).fontSize);
                if (fs > 0 && fs < min) min = fs;
            });
        }
        return isFinite(min) ? min : M.size;
    }

    /** Clone `src` with every computed style inlined, so the SVG renders without the page's CSS. */
    function cloneStyled(src) {
        const dst = src.cloneNode(true);
        const a = [src, ...src.querySelectorAll('*')];
        const b = [dst, ...dst.querySelectorAll('*')];
        for (let i = 0; i < a.length; i++) {
            const cs = getComputedStyle(a[i]);
            let style = '';
            for (const p of STYLE_PROPS) {
                const v = cs.getPropertyValue(p);
                if (v) style += `${p}:${v};`;
            }
            b[i].setAttribute('style', style);
            b[i].removeAttribute('class');
        }
        dst.querySelectorAll('title').forEach(t => t.remove());
        return dst;
    }

    /** Snapshot the visible part of the graph as standalone SVG markup (without the outer <svg>). */
    function snapshotSvg(elements) {
        const ser = new XMLSerializer();
        const container = document.createElementNS(SVGNS, 'g');
        container.appendChild(cloneStyled(svg.querySelector('defs')));
        // Keep the original stacking: groups, then edges, then nodes.
        for (const e of elements) container.appendChild(cloneStyled(e));
        return ser.serializeToString(container);
    }

    function startExport() {
        if (!state.graph || exporting) return;
        const region = visibleRegion();
        const elements = elementsIn(region);
        const minFont = smallestFontPx(elements);
        // At least what is on screen, and enough for the smallest text to reach MIN_EXPORT_PT.
        const scale = Math.max(T.k, (MIN_EXPORT_PT * PX_PER_PT) / minFont);
        const width = Math.max(1, Math.round(region.w * scale));
        const height = Math.max(1, Math.round(region.h * scale));
        const bg = getComputedStyle(document.body).backgroundColor || '#ffffff';
        exporting = { region, scale, width, height, bg, body: snapshotSvg(elements), cancelled: false, ack: null };
        $('exportPng').disabled = true;
        setStatusMessage(`Preparing PNG ${width} × ${height} px…`);
        vscode.postMessage({
            type: 'exportRequest', width, height, scale,
            minFontPt: MIN_EXPORT_PT, title: (state.graph && state.graph.title) || 'graph',
        });
    }

    function endExport() {
        if (exporting && exporting.ack) exporting.ack.reject(new Error('cancelled'));
        exporting = null;
        $('exportPng').disabled = false;
    }

    function loadImage(url) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = () => reject(new Error('the browser could not render the graph snapshot'));
            img.src = url;
        });
    }

    function waitAck() {
        return new Promise((resolve, reject) => { exporting.ack = { resolve, reject }; });
    }

    /** Pixels rendered per band (all tiles of a band live in canvases at the same time). */
    const EXPORT_BAND_PIXELS = 64 * 1024 * 1024;

    async function renderTile(job, x, y, tw, th) {
        const { region, scale, bg, body } = job;
        const vx = region.x + x / scale, vy = region.y + y / scale, vw = tw / scale, vh = th / scale;
        const head = `<svg xmlns="${SVGNS}" width="${tw}" height="${th}" viewBox="${vx} ${vy} ${vw} ${vh}">` +
            `<rect x="${vx}" y="${vy}" width="${vw}" height="${vh}" fill="${bg}"/>`;
        const url = URL.createObjectURL(new Blob([head, body, '</svg>'], { type: 'image/svg+xml' }));
        try {
            const img = await loadImage(url);
            const canvas = document.createElement('canvas');
            canvas.width = tw;
            canvas.height = th;
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            ctx.fillStyle = bg;
            ctx.fillRect(0, 0, tw, th);
            ctx.drawImage(img, 0, 0, tw, th);
            return ctx;
        } finally {
            URL.revokeObjectURL(url);
        }
    }

    /**
     * Render the snapshot in horizontal bands (each band = one row of tiles, rendered once),
     * and send it to the extension in strips of `stripHeight` rows, waiting for an ack each time.
     */
    async function runExport(stripHeight) {
        const job = exporting;
        const { width, height } = job;
        const band = Math.max(stripHeight, Math.min(EXPORT_TILE, Math.floor(EXPORT_BAND_PIXELS / width / stripHeight) * stripHeight));
        for (let by = 0; by < height; by += band) {
            const bh = Math.min(band, height - by);
            const tiles = [];
            for (let x = 0; x < width; x += EXPORT_TILE) {
                if (job.cancelled) return;
                const tw = Math.min(EXPORT_TILE, width - x);
                tiles.push({ x, tw, ctx: await renderTile(job, x, by, tw, bh) });
            }
            for (let sy = 0; sy < bh; sy += stripHeight) {
                if (job.cancelled) return;
                const sh = Math.min(stripHeight, bh - sy);
                const strip = new Uint8Array(width * sh * 4);
                for (const t of tiles) {
                    const px = t.ctx.getImageData(0, sy, t.tw, sh).data;
                    for (let r = 0; r < sh; r++) strip.set(px.subarray(r * t.tw * 4, (r + 1) * t.tw * 4), (r * width + t.x) * 4);
                }
                const ack = waitAck();
                vscode.postMessage({ type: 'exportStrip', y: by + sy, height: sh, data: strip.buffer });
                await ack;
            }
        }
        vscode.postMessage({ type: 'exportDone' });
        endExport();
    }

    // ------------------------------------------------------------------ toolbar / status

    function updateStatus() {
        const g = state.graph;
        if (!g) return;
        const shownNodes = g.nodes.filter(n => state.views.has(n.id));
        const classes = shownNodes.filter(n => n.kind === 'class').length;
        const leaves = shownNodes.length - classes;
        const shown = state.visibleEdges.length;
        const hidden = g.edges.length - shown;
        const parts = [
            `${classes} class${classes === 1 ? '' : 'es'}`,
            leaves ? `${leaves} external` : '',
            `${shown} relationship${shown === 1 ? '' : 's'} shown` + (hidden ? ` (${hidden} more under Relations)` : ''),
            `via ${g.backends.join(' + ')}`,
            `${g.stats.files} files, ${g.stats.elapsedMs} ms`,
        ].filter(Boolean);
        if (state.standaloneCount) {
            parts.push(state.hiddenCount ? `${state.hiddenCount} standalone hidden`
                : state.groups.length ? `${state.standaloneCount} standalone in ${state.groups.length} group${state.groups.length === 1 ? '' : 's'}`
                    : `${state.standaloneCount} standalone`);
        }
        if (state.partial) parts.push('refining with clang-uml…');
        if (state.matches.length) parts.push(`${state.matches.length} match${state.matches.length === 1 ? '' : 'es'}`);
        if (state.selected && state.views.has(state.selected)) parts.push(`selected: ${state.views.get(state.selected).node.qualifiedName}`);
        $('status').textContent = parts.join(' · ');
        const diag = $('diagButton');
        diag.hidden = !g.diagnostics.length;
        diag.textContent = `⚠ ${g.diagnostics.length} note${g.diagnostics.length === 1 ? '' : 's'}`;
    }

    let statusTimer = 0;
    function setStatusMessage(msg) {
        $('status').textContent = msg;
        clearTimeout(statusTimer);
        statusTimer = setTimeout(updateStatus, 4000);
    }

    function showOverlay(kind, text) {
        const o = $('overlay');
        o.hidden = !kind;
        o.className = 'overlay' + (kind === 'error' ? ' error' : '');
        o.textContent = '';
        if (kind === 'loading') {
            const s = document.createElement('div');
            s.className = 'spinner';
            o.appendChild(s);
        }
        if (text) o.appendChild(document.createTextNode(text));
    }

    function togglePanel(show) {
        const p = $('panel');
        const visible = show === undefined ? p.hidden : show;
        p.hidden = !visible;
        if (!visible) return;
        const list = $('diagList');
        list.textContent = '';
        const diags = (state.graph && state.graph.diagnostics) || [];
        $('diagTitle').hidden = !diags.length;
        for (const d of diags) {
            const li = document.createElement('li');
            li.textContent = d;
            list.appendChild(li);
        }
    }

    function syncRelationsMenu() {
        const r = state.options.relations || {};
        document.querySelectorAll('#relationsMenu input[data-rel]').forEach(cb => { cb.checked = !!r[cb.dataset.rel]; });
        const extra = REL_KINDS.filter(k => k !== 'inheritance' && r[k]).length;
        $('relationsBtn').textContent = `Relations${extra ? ` (+${extra})` : ''} ▾`;
        // Show how many edges of each kind exist, so empty kinds are recognisable.
        const g = state.graph;
        document.querySelectorAll('#relationsMenu [data-count]').forEach(span => {
            const k = span.dataset.count;
            const n = g ? g.edges.filter(e => (k === 'inheritance' ? INHERITANCE.has(e.kind) : e.kind === k)).length : 0;
            span.textContent = String(n);
        });
    }

    function bindRelationsMenu() {
        const btn = $('relationsBtn'), menu = $('relationsMenu');
        const show = open => {
            menu.hidden = !open;
            btn.setAttribute('aria-expanded', String(open));
            if (open) syncRelationsMenu();
        };
        btn.addEventListener('click', () => show(menu.hidden));
        document.addEventListener('pointerdown', e => {
            if (!menu.hidden && !menu.contains(e.target) && e.target !== btn) show(false);
        });
        menu.addEventListener('keydown', e => { if (e.key === 'Escape') { show(false); btn.focus(); } });
        menu.querySelectorAll('input[data-rel]').forEach(cb => cb.addEventListener('change', () => {
            state.options.relations = Object.assign({}, state.options.relations, { [cb.dataset.rel]: cb.checked });
            persist();
            syncRelationsMenu();
            render(true);
        }));
        $('relationsAll').addEventListener('click', () => {
            state.options.relations = Object.fromEntries(REL_KINDS.map(k => [k, true]));
            persist(); syncRelationsMenu(); render(true);
        });
        $('relationsNone').addEventListener('click', () => {
            state.options.relations = { inheritance: true };
            persist(); syncRelationsMenu(); render(true);
        });
    }

    function bindToolbar() {
        $('fit').addEventListener('click', fitView);
        $('zoomIn').addEventListener('click', () => zoomCenter(1.25));
        $('zoomOut').addEventListener('click', () => zoomCenter(0.8));
        $('zoomReset').addEventListener('click', () => {
            const r = svg.getBoundingClientRect();
            zoomAt(r.width / 2, r.height / 2, 1 / T.k);
        });
        $('refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
        $('exportPng').addEventListener('click', startExport);
        $('info').addEventListener('click', () => togglePanel());
        $('diagButton').addEventListener('click', () => togglePanel(true));
        $('closePanel').addEventListener('click', () => togglePanel(false));
        const bindSelect = (id, key, relayout, fit) => {
            const s = $(id);
            s.value = state.options[key];
            s.addEventListener('change', () => {
                state.options[key] = s.value;
                persist();
                if (relayout) render(!fit);
                else applyHighlight();
            });
        };
        bindSelect('direction', 'direction', true, true);
        bindSelect('members', 'showMembers', true, false);
        bindSelect('highlight', 'highlight', false, false);
        bindSelect('standalone', 'standalone', true, true);
        bindRelationsMenu();
        const search = $('search');
        search.addEventListener('input', () => { state.matchIndex = -1; applySearch(false); });
        search.addEventListener('keydown', e => {
            if (e.key === 'Enter') { e.preventDefault(); applySearch(true); }
            if (e.key === 'Escape') { search.value = ''; applySearch(false); svg.focus(); }
        });
    }

    document.addEventListener('keydown', e => {
        const tag = (e.target && e.target.tagName) || '';
        if (tag === 'INPUT' || tag === 'SELECT') return;
        const step = 60;
        switch (e.key) {
            case '+': case '=': zoomCenter(1.25); break;
            case '-': case '_': zoomCenter(0.8); break;
            case '0': $('zoomReset').click(); break;
            case 'f': case 'F': fitView(); break;
            case 'ArrowLeft': T.x += step; applyTransform(); break;
            case 'ArrowRight': T.x -= step; applyTransform(); break;
            case 'ArrowUp': T.y += step; applyTransform(); break;
            case 'ArrowDown': T.y -= step; applyTransform(); break;
            case 'Enter': if (state.selected) navigate(state.selected, undefined, false); break;
            case 'c': case 'C': if (state.selected) centerOn(state.selected); break;
            case 'Escape':
                if (!$('relationsMenu').hidden) $('relationsMenu').hidden = true;
                else if (!$('panel').hidden) togglePanel(false);
                else select(null);
                break;
            case '/': e.preventDefault(); $('search').focus(); break;
            default:
                if ((e.ctrlKey || e.metaKey) && e.key === 'f') { e.preventDefault(); $('search').focus(); }
                return;
        }
    });

    // Re-measure when the theme (and possibly the font) changes.
    new MutationObserver(() => { if (state.graph) render(true); })
        .observe(document.body, { attributes: true, attributeFilter: ['class'] });
    let resizeTimer = 0;
    window.addEventListener('resize', () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(applyTransform, 50);
    });

    // ------------------------------------------------------------------ messages

    window.addEventListener('message', ev => {
        const msg = ev.data;
        switch (msg.type) {
            case 'exportBegin':
                if (!exporting) break;
                setStatusMessage(`Rendering PNG ${exporting.width} × ${exporting.height} px…`);
                runExport(msg.stripHeight).catch(e => {
                    if (exporting && !exporting.cancelled) vscode.postMessage({ type: 'exportError', message: e.message || String(e) });
                    endExport();
                });
                break;
            case 'exportAck':
                if (exporting && exporting.ack) exporting.ack.resolve();
                break;
            case 'exportCancel':
                if (exporting) exporting.cancelled = true;
                endExport();
                break;
            case 'loading':
                showOverlay('loading', msg.text || 'Analyzing…');
                break;
            case 'error':
                showOverlay('error', msg.message);
                break;
            case 'graph': {
                const sameTarget = state.target === msg.graph.targetPath;
                state.graph = msg.graph;
                state.graph.edges.forEach((e, i) => { e.key = i; });
                state.partial = !!msg.partial;
                state.target = msg.graph.targetPath;
                state.mode = msg.graph.mode;
                if (msg.settings) {
                    state.options.navigateOn = msg.settings.navigateOn;
                    if (!saved.options || !sameTarget) {
                        state.options.showMembers = msg.settings.showMembers;
                        state.options.direction = msg.settings.direction;
                        if (msg.settings.standalone) state.options.standalone = msg.settings.standalone;
                        if (msg.settings.relations) state.options.relations = Object.fromEntries(msg.settings.relations.map(k => [k, true]));
                    }
                }
                if (!sameTarget) {
                    state.collapsed.clear();
                    state.collapsedParts.clear();
                    state.hiddenAccess = {};
                    state.expanded.clear();
                    state.groupOpen = {};
                    state.selected = null;
                }
                $('title').textContent = msg.graph.title;
                $('title').title = msg.graph.targetPath;
                $('direction').value = state.options.direction;
                $('members').value = state.options.showMembers;
                $('highlight').value = state.options.highlight;
                $('standalone').value = state.options.standalone;
                syncRelationsMenu();
                showOverlay(null);
                if (!msg.graph.nodes.length) showOverlay('message', 'No classes found.' + (msg.graph.diagnostics.length ? ' See notes (ⓘ).' : ''));
                const keepView = sameTarget && (msg.preserveView || saved.transform);
                render(!!keepView);
                saved.transform = null;
                persist();
                break;
            }
        }
    });

    bindToolbar();
    applyTransform();
    vscode.postMessage({ type: 'ready', state: { target: state.target, mode: state.mode } });
})();
