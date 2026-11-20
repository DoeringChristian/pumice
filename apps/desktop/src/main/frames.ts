import { net } from 'electron';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { extname, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Serves the files of a frame (an HTML file shown inside a note) to its sandboxed frame.
 * Each frame gets its own host name, `app://frame.<token>/<vault path>`, and can read only its
 * own folder and the files its note passed to it. Unless the user allows it, the page cannot
 * reach the network, so a frame cannot send notes anywhere.
 */

export interface FrameGrant {
  /** Window the frame belongs to. */
  owner: number;
  /** Absolute folder the HTML file lives in; everything below it is served. */
  folder: string;
  /** Other absolute files the frame may read (its data). */
  files: Set<string>;
  /** HTML put in front of every HTML file's own content (theme and helpers). */
  inject: string;
  network: boolean;
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.woff2': 'font/woff2',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
};

/** A file's HTML with `inject` right after `<head>`, or else at the very start. */
export function injectHtml(html: string, inject: string): string {
  const head = /<head[^>]*>/i.exec(html);
  if (head) {
    const at = head.index + head[0].length;
    return html.slice(0, at) + inject + html.slice(at);
  }
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  const at = doctype ? doctype[0].length : 0;
  return html.slice(0, at) + inject + html.slice(at);
}

/** What a frame's page may load: itself, inline code, and data it builds; nothing remote. */
export function frameCsp(host: string): string {
  const self = `'self' app://${host}`;
  return [
    `default-src ${self} data: blob: 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'`,
    `connect-src ${self} data: blob:`,
    `worker-src ${self} blob:`,
    `form-action 'none'`,
    `base-uri 'none'`,
  ].join('; ');
}

export class FrameServer {
  private readonly grants = new Map<string, FrameGrant>();

  open(grant: FrameGrant): string {
    const token = randomBytes(12).toString('hex');
    this.grants.set(token, grant);
    return token;
  }

  close(token: string, owner: number): void {
    if (this.grants.get(token)?.owner === owner) this.grants.delete(token);
  }

  /** A window closed: its frames are gone. */
  closeAll(owner: number): void {
    for (const [token, grant] of this.grants) if (grant.owner === owner) this.grants.delete(token);
  }

  static isFrameHost(host: string): boolean {
    return host.startsWith('frame.');
  }

  /**
   * Answers `app://frame.<token>/<vault path>`. `resolve` maps a vault path to an absolute one
   * for the frame's window (and throws for paths outside the vault).
   */
  async respond(
    request: Request,
    resolve: (owner: number, vaultPath: string) => string,
  ): Promise<Response> {
    const url = new URL(request.url);
    const grant = this.grants.get(url.host.slice('frame.'.length));
    const refuse = (status: number) =>
      new Response(status === 404 ? 'Not found' : 'Not allowed', {
        status,
        headers: { 'Access-Control-Allow-Origin': '*' },
      });
    if (!grant) return refuse(404);
    let file: string;
    try {
      file = resolve(grant.owner, decodeURIComponent(url.pathname).replace(/^\/+/, ''));
    } catch {
      return refuse(403);
    }
    if (!(file.startsWith(grant.folder + sep) || grant.files.has(file))) return refuse(403);
    const ext = extname(file).toLowerCase();
    const headers: Record<string, string> = {
      'Access-Control-Allow-Origin': '*',
      // Frames are edited while they are open; never show a stale copy.
      'Cache-Control': 'no-store',
    };
    if (TYPES[ext]) headers['Content-Type'] = TYPES[ext];
    try {
      if (ext === '.html' || ext === '.htm') {
        if (!grant.network) headers['Content-Security-Policy'] = frameCsp(url.host);
        return new Response(injectHtml(await fs.readFile(file, 'utf8'), grant.inject), { headers });
      }
      // Streams, and answers range requests (video).
      const res = await net.fetch(pathToFileURL(file).href, {
        headers: request.headers,
        bypassCustomProtocolHandlers: true,
      });
      for (const name of ['Content-Length', 'Content-Range', 'Accept-Ranges']) {
        const value = res.headers.get(name);
        if (value) headers[name] = value;
      }
      if (!headers['Content-Type']) {
        headers['Content-Type'] = res.headers.get('Content-Type') ?? 'application/octet-stream';
      }
      return new Response(res.body, { status: res.status, headers });
    } catch {
      return refuse(404);
    }
  }
}
