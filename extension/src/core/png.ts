/**
 * Streaming PNG writer: rows are compressed and written as they arrive, so images far
 * larger than what fits in memory (or in a browser canvas) can be produced strip by strip.
 */
import * as fs from 'fs';
import * as zlib from 'zlib';

const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();

export function crc32(buf: Uint8Array, crc = 0xffffffff): number {
    for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
    return crc;
}

function chunk(type: string, data: Buffer): Buffer {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE((crc32(data, crc32(head.subarray(4))) ^ 0xffffffff) >>> 0, 0);
    return Buffer.concat([head, data, crc]);
}

export class PngStreamWriter {
    private readonly out: fs.WriteStream;
    private readonly deflate: zlib.Deflate;
    private rowsWritten = 0;
    private failed: Error | undefined;

    /** Writes an opaque 8-bit RGB image; `dpi` is stored in the pHYs chunk. */
    constructor(readonly file: string, readonly width: number, readonly height: number, dpi = 96) {
        if (!(width > 0 && height > 0 && width < 2 ** 31 && height < 2 ** 31)) throw new Error(`invalid PNG size ${width}x${height}`);
        this.out = fs.createWriteStream(file);
        this.out.on('error', e => { this.failed = e; });
        this.out.write(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
        const ihdr = Buffer.alloc(13);
        ihdr.writeUInt32BE(width, 0);
        ihdr.writeUInt32BE(height, 4);
        ihdr[8] = 8;   // bit depth
        ihdr[9] = 2;   // colour type: RGB
        ihdr[10] = 0;  // deflate
        ihdr[11] = 0;  // adaptive filtering
        ihdr[12] = 0;  // no interlace
        this.out.write(chunk('IHDR', ihdr));
        const phys = Buffer.alloc(9);
        const ppm = Math.round(dpi / 0.0254);
        phys.writeUInt32BE(ppm, 0);
        phys.writeUInt32BE(ppm, 4);
        phys[8] = 1; // unit: metre
        this.out.write(chunk('pHYs', phys));
        this.deflate = zlib.createDeflate({ level: 6, memLevel: 9 });
        this.deflate.on('data', (d: Buffer) => this.out.write(chunk('IDAT', d)));
        this.deflate.on('error', e => { this.failed = e; });
    }

    get progress(): number {
        return this.rowsWritten / this.height;
    }

    /** Append `rows` full-width rows of RGBA pixels (alpha is dropped). */
    async writeRgbaRows(rgba: Uint8Array, rows: number): Promise<void> {
        if (this.failed) throw this.failed;
        const w = this.width;
        if (rgba.length < rows * w * 4) throw new Error(`strip too short: ${rgba.length} bytes for ${rows} rows`);
        if (this.rowsWritten + rows > this.height) throw new Error('more rows than the image height');
        const block = Buffer.alloc(rows * (1 + w * 3));
        let o = 0;
        for (let r = 0; r < rows; r++) {
            block[o++] = 0; // filter: none (diagrams compress well without filtering)
            let i = r * w * 4;
            for (let x = 0; x < w; x++, i += 4) {
                block[o++] = rgba[i];
                block[o++] = rgba[i + 1];
                block[o++] = rgba[i + 2];
            }
        }
        this.rowsWritten += rows;
        if (!this.deflate.write(block)) await new Promise<void>(res => this.deflate.once('drain', () => res()));
        if (this.out.writableNeedDrain) await new Promise<void>(res => this.out.once('drain', () => res()));
    }

    async finish(): Promise<void> {
        if (this.rowsWritten !== this.height) throw new Error(`only ${this.rowsWritten} of ${this.height} rows written`);
        await new Promise<void>((res, rej) => {
            this.deflate.once('end', () => res());
            this.deflate.once('error', rej);
            this.deflate.end();
        });
        this.out.write(chunk('IEND', Buffer.alloc(0)));
        await new Promise<void>((res, rej) => this.out.end((e?: Error | null) => (e ? rej(e) : res())));
        if (this.failed) throw this.failed;
    }

    /** Stop and delete the partial file. */
    abort(): void {
        this.deflate.destroy();
        this.out.destroy();
        fs.rm(this.file, { force: true }, () => {});
    }
}
