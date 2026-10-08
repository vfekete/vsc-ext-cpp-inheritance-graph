import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import * as zlib from 'node:zlib';
import { PngStreamWriter } from '../src/core/png';

interface Chunk { type: string; data: Buffer; crcOk: boolean }

function readChunks(file: string): Chunk[] {
    const d = fs.readFileSync(file);
    assert.deepEqual([...d.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const chunks: Chunk[] = [];
    for (let i = 8; i < d.length;) {
        const n = d.readUInt32BE(i);
        const type = d.toString('ascii', i + 4, i + 8);
        const data = d.subarray(i + 8, i + 8 + n);
        const crc = d.readUInt32BE(i + 8 + n);
        chunks.push({ type, data, crcOk: (zlib.crc32 ? zlib.crc32(d.subarray(i + 4, i + 8 + n)) : crc) === crc });
        i += 12 + n;
    }
    return chunks;
}

describe('PngStreamWriter', () => {
    it('writes a valid RGB PNG strip by strip, with DPI', async () => {
        const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'png-test-')), 'out.png');
        const w = 37, h = 23;
        const writer = new PngStreamWriter(file, w, h, 96);
        const pixel = (x: number, y: number) => [(x * 7) & 255, (y * 11) & 255, (x + y) & 255];
        for (let y = 0; y < h; y += 5) {
            const rows = Math.min(5, h - y);
            const rgba = new Uint8Array(w * rows * 4);
            for (let r = 0; r < rows; r++) for (let x = 0; x < w; x++) rgba.set([...pixel(x, y + r), 255], (r * w + x) * 4);
            await writer.writeRgbaRows(rgba, rows);
        }
        await writer.finish();

        const chunks = readChunks(file);
        assert.deepEqual(chunks.map(c => c.type), ['IHDR', 'pHYs', ...chunks.slice(2, -1).map(() => 'IDAT'), 'IEND']);
        assert.ok(chunks.every(c => c.crcOk), 'all CRCs valid');
        const ihdr = chunks[0].data;
        assert.equal(ihdr.readUInt32BE(0), w);
        assert.equal(ihdr.readUInt32BE(4), h);
        assert.equal(ihdr[9], 2, 'RGB');
        assert.equal(Math.round(chunks[1].data.readUInt32BE(0) * 0.0254), 96);
        const raw = zlib.inflateSync(Buffer.concat(chunks.filter(c => c.type === 'IDAT').map(c => c.data)));
        assert.equal(raw.length, h * (1 + w * 3));
        for (const [x, y] of [[0, 0], [36, 22], [10, 7]]) {
            const o = y * (1 + w * 3) + 1 + x * 3;
            assert.deepEqual([...raw.subarray(o, o + 3)], pixel(x, y));
        }
    });

    it('rejects incomplete images and deletes aborted files', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'png-test-'));
        const writer = new PngStreamWriter(path.join(dir, 'a.png'), 4, 4);
        await writer.writeRgbaRows(new Uint8Array(4 * 2 * 4), 2);
        await assert.rejects(writer.finish(), /only 2 of 4 rows/);
        const aborted = new PngStreamWriter(path.join(dir, 'b.png'), 4, 4);
        aborted.abort();
        await new Promise(r => setTimeout(r, 50));
        assert.ok(!fs.existsSync(path.join(dir, 'b.png')));
    });
});
