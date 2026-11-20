import {
  MessageKind,
  decodeEnvelope,
  encodeControl,
  encodeEnvelope,
  type PublicUser,
  type Role,
} from '@pumice/collab-protocol';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import type { WebSocket } from 'ws';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import type { Store } from './db.ts';

/** Compact a document's update log once it has this many entries. */
const COMPACT_AFTER = 200;
/** Keep a history snapshot at most this often per document while it is being edited. */
const SNAPSHOT_EVERY = 10 * 60 * 1000;
/** Unload documents nobody has used for this long. */
const IDLE_UNLOAD = 5 * 60 * 1000;

export interface Connection {
  socket: WebSocket;
  user: PublicUser;
  /** Awareness client ids this connection announced, per document. */
  awarenessIds: Map<string, Set<number>>;
}

class ServerDoc {
  readonly doc = new Y.Doc({ gc: true });
  readonly awareness: awarenessProtocol.Awareness;
  readonly conns = new Set<Connection>();
  changedSinceSnapshot = false;
  lastUsed = Date.now();

  readonly vault: string;
  readonly name: string;
  private readonly store: Store;

  constructor(vault: string, name: string, store: Store) {
    this.vault = vault;
    this.name = name;
    this.store = store;
    this.awareness = new awarenessProtocol.Awareness(this.doc);
    this.awareness.setLocalState(null);
    for (const update of store.updates(vault, name)) Y.applyUpdate(this.doc, update, 'load');

    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === 'load') return;
      this.changedSinceSnapshot = true;
      const count = store.appendUpdate(vault, name, update);
      if (count > COMPACT_AFTER) store.compact(vault, name, Y.encodeStateAsUpdate(this.doc));
      if (Date.now() - store.lastSnapshotTime(vault, name) > SNAPSHOT_EVERY) this.snapshot();
      const enc = encoding.createEncoder();
      syncProtocol.writeUpdate(enc, update);
      const msg = encodeEnvelope({
        kind: MessageKind.Sync,
        vault,
        doc: name,
        payload: encoding.toUint8Array(enc),
      });
      for (const c of this.conns) if (c !== origin) send(c, msg);
    });

    this.awareness.on(
      'update',
      (
        { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
        origin: unknown,
      ) => {
        const changed = [...added, ...updated, ...removed];
        if (origin && typeof origin === 'object' && 'awarenessIds' in origin) {
          const conn = origin as Connection;
          const ids = conn.awarenessIds.get(name) ?? new Set<number>();
          for (const id of added) ids.add(id);
          for (const id of removed) ids.delete(id);
          conn.awarenessIds.set(name, ids);
        }
        const payload = awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed);
        const msg = encodeEnvelope({ kind: MessageKind.Awareness, vault, doc: name, payload });
        for (const c of this.conns) if (c !== origin) send(c, msg);
      },
    );
  }

  snapshot(): void {
    this.store.addSnapshot(this.vault, this.name, Y.encodeStateAsUpdate(this.doc));
    this.changedSinceSnapshot = false;
  }
}

function send(conn: Connection, data: Uint8Array): void {
  if (conn.socket.readyState === conn.socket.OPEN) conn.socket.send(data);
}

/** Holds documents in memory while in use and relays sync and awareness between clients. */
export class SyncHub {
  private readonly docs = new Map<string, ServerDoc>();
  private readonly timer: ReturnType<typeof setInterval>;

  private readonly store: Store;

  constructor(store: Store) {
    this.store = store;
    this.timer = setInterval(() => this.unloadIdle(), 60_000);
    this.timer.unref?.();
  }

  private key(vault: string, doc: string): string {
    return `${vault}\u0000${doc}`;
  }

  private get(vault: string, doc: string): ServerDoc {
    const key = this.key(vault, doc);
    let d = this.docs.get(key);
    if (!d) this.docs.set(key, (d = new ServerDoc(vault, doc, this.store)));
    d.lastUsed = Date.now();
    return d;
  }

  /** Server-side state of a document (for REST: export, history restore). */
  state(vault: string, doc: string): Uint8Array {
    return Y.encodeStateAsUpdate(this.get(vault, doc).doc);
  }

  handleMessage(
    conn: Connection,
    data: Uint8Array,
    roleOf: (vault: string) => Role | undefined,
  ): void {
    let env;
    try {
      env = decodeEnvelope(data);
    } catch (e) {
      send(
        conn,
        encodeControl('', '', {
          type: 'error',
          message: e instanceof Error ? e.message : String(e),
        }),
      );
      return;
    }
    const role = roleOf(env.vault);
    if (!role) {
      send(
        conn,
        encodeControl(env.vault, env.doc, {
          type: 'error',
          message: 'Not a member of this vault',
          doc: env.doc,
        }),
      );
      return;
    }
    if (!env.doc) return;
    const sd = this.get(env.vault, env.doc);
    sd.conns.add(conn);
    if (env.kind === MessageKind.Sync) {
      const decoder = decoding.createDecoder(env.payload);
      const type = decoding.peekVarUint(decoder);
      if (role === 'viewer' && type !== syncProtocol.messageYjsSyncStep1) {
        // Viewers read; their writes are dropped and they're told so (the client goes read-only).
        send(conn, encodeControl(env.vault, env.doc, { type: 'readonly', doc: env.doc }));
        return;
      }
      const encoder = encoding.createEncoder();
      syncProtocol.readSyncMessage(decoder, encoder, sd.doc, conn);
      if (encoding.length(encoder) > 0) {
        send(
          conn,
          encodeEnvelope({
            kind: MessageKind.Sync,
            vault: env.vault,
            doc: env.doc,
            payload: encoding.toUint8Array(encoder),
          }),
        );
      }
      if (type === syncProtocol.messageYjsSyncStep1) {
        // Ask the client for what it has that we don't.
        const enc = encoding.createEncoder();
        syncProtocol.writeSyncStep1(enc, sd.doc);
        send(
          conn,
          encodeEnvelope({
            kind: MessageKind.Sync,
            vault: env.vault,
            doc: env.doc,
            payload: encoding.toUint8Array(enc),
          }),
        );
        // And tell it who is around.
        const states = [...sd.awareness.getStates().keys()];
        if (states.length) {
          send(
            conn,
            encodeEnvelope({
              kind: MessageKind.Awareness,
              vault: env.vault,
              doc: env.doc,
              payload: awarenessProtocol.encodeAwarenessUpdate(sd.awareness, states),
            }),
          );
        }
      }
    } else if (env.kind === MessageKind.Awareness) {
      awarenessProtocol.applyAwarenessUpdate(sd.awareness, env.payload, conn);
    }
  }

  disconnect(conn: Connection): void {
    for (const sd of this.docs.values()) {
      if (!sd.conns.delete(conn)) continue;
      const ids = conn.awarenessIds.get(sd.name);
      if (ids?.size) awarenessProtocol.removeAwarenessStates(sd.awareness, [...ids], null);
    }
  }

  private unloadIdle(): void {
    const now = Date.now();
    for (const [key, sd] of this.docs) {
      if (sd.conns.size || now - sd.lastUsed < IDLE_UNLOAD) continue;
      if (sd.changedSinceSnapshot) sd.snapshot();
      sd.doc.destroy();
      this.docs.delete(key);
    }
  }

  close(): void {
    clearInterval(this.timer);
    for (const sd of this.docs.values()) {
      if (sd.changedSinceSnapshot) sd.snapshot();
      sd.doc.destroy();
    }
    this.docs.clear();
  }
}
