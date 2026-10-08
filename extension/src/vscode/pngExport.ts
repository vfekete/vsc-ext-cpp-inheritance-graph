/**
 * Extension side of "download as PNG": confirms very large images, asks where to save,
 * and streams the RGBA strips rendered by the webview into a PNG file.
 */
import * as path from 'path';
import * as vscode from 'vscode';
import { PngStreamWriter } from '../core/png';

/** Images with a side longer than this need explicit confirmation. */
export const LARGE_IMAGE_PX = 16384;
/** Upper bound for the size of one strip sent by the webview. */
const STRIP_BYTES = 24 * 1024 * 1024;

export interface ExportRequest {
    width: number;
    height: number;
    scale: number;
    minFontPt: number;
    title: string;
}

function toBytes(d: unknown): Uint8Array {
    if (d instanceof Uint8Array) return d;
    if (d instanceof ArrayBuffer) return new Uint8Array(d);
    if (ArrayBuffer.isView(d)) return new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
    if (typeof d === 'string') return Buffer.from(d, 'base64');
    throw new Error('unexpected strip payload');
}

function fmt(n: number): string {
    return n.toLocaleString('en-US');
}

export class PngExport {
    private writer: PngStreamWriter | undefined;
    private finished!: () => void;
    private progress: vscode.Progress<{ message?: string; increment?: number }> | undefined;
    private reported = 0;
    private cancelled = false;

    private constructor(
        private readonly post: (msg: unknown) => void,
        private readonly uri: vscode.Uri,
        private readonly req: ExportRequest,
        private readonly onEnd: () => void,
    ) {}

    /** Confirm (if huge), pick a file and start the export. Returns undefined when the user backs out. */
    static async start(req: ExportRequest, defaultDir: string, post: (msg: unknown) => void, onEnd: () => void): Promise<PngExport | undefined> {
        const { width, height } = req;
        if (Math.max(width, height) > LARGE_IMAGE_PX) {
            const mp = (width * height) / 1e6;
            const choice = await vscode.window.showWarningMessage(
                `The PNG would be ${fmt(width)} × ${fmt(height)} px (${mp.toFixed(0)} megapixels).`,
                {
                    modal: true,
                    detail: `That is larger than ${fmt(LARGE_IMAGE_PX)} px on a side, which is needed to keep the smallest text at ` +
                        `${req.minFontPt} pt. Creating it may take a while, and many image viewers cannot open images this large.\n\n` +
                        'To get a smaller image, zoom in and export only the part you need.',
                },
                'Export Anyway',
            );
            if (choice !== 'Export Anyway') return undefined;
        }
        const safeTitle = req.title.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'graph';
        const uri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(path.join(defaultDir, `${safeTitle}-inheritance.png`)),
            filters: { 'PNG image': ['png'] },
            saveLabel: 'Save PNG',
        });
        if (!uri) return undefined;
        const exp = new PngExport(post, uri, req, onEnd);
        exp.begin();
        return exp;
    }

    private begin(): void {
        const { width, height } = this.req;
        this.writer = new PngStreamWriter(this.uri.fsPath, width, height, 96);
        const stripHeight = Math.max(1, Math.min(2048, Math.floor(STRIP_BYTES / (width * 4))));
        void vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Exporting ${path.basename(this.uri.fsPath)}`, cancellable: true },
            (progress, token) => {
                this.progress = progress;
                token.onCancellationRequested(() => this.cancel());
                return new Promise<void>(resolve => { this.finished = resolve; });
            },
        );
        this.post({ type: 'exportBegin', stripHeight });
    }

    async strip(msg: { y: number; height: number; data: unknown }): Promise<void> {
        if (this.cancelled || !this.writer) return;
        try {
            await this.writer.writeRgbaRows(toBytes(msg.data), msg.height);
            const pct = Math.floor(this.writer.progress * 100);
            this.progress?.report({ increment: pct - this.reported, message: `${pct}%` });
            this.reported = pct;
            this.post({ type: 'exportAck' });
        } catch (e) {
            this.fail((e as Error).message);
        }
    }

    async done(): Promise<void> {
        if (this.cancelled || !this.writer) return;
        try {
            await this.writer.finish();
        } catch (e) {
            this.fail((e as Error).message);
            return;
        }
        this.end();
        const { width, height } = this.req;
        const action = await vscode.window.showInformationMessage(
            `Saved ${path.basename(this.uri.fsPath)} (${fmt(width)} × ${fmt(height)} px).`, 'Open', 'Reveal in File Manager');
        if (action === 'Open') await vscode.commands.executeCommand('vscode.open', this.uri);
        else if (action === 'Reveal in File Manager') await vscode.commands.executeCommand('revealFileInOS', this.uri);
    }

    fail(message: string): void {
        if (this.cancelled) return;
        this.cancel();
        void vscode.window.showErrorMessage(`PNG export failed: ${message}`);
    }

    cancel(): void {
        if (this.cancelled) return;
        this.cancelled = true;
        this.writer?.abort();
        this.post({ type: 'exportCancel' });
        this.end();
    }

    private end(): void {
        this.finished?.();
        this.onEnd();
    }
}
