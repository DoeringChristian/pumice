/**
 * Wire format between Pumice clients and the collaboration server (docs/plan/05).
 *
 * Every WebSocket frame is a versioned envelope:
 *
 *   varUint  version            (PROTOCOL_VERSION)
 *   varUint  kind               (MessageKind)
 *   varString vault             vault id
 *   varString doc               document id ('' for vault-level messages)
 *   varUint8Array payload       y-protocols sync / awareness message, or UTF-8 JSON for control
 *
 * The envelope lets encryption (payload = ciphertext) or protocol changes come later without
 * breaking older clients: unknown versions are rejected with a control message.
 */
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';

export const PROTOCOL_VERSION = 1;

/** The vault manifest document: file ids → paths, kinds, blob hashes, tombstones. */
export const MANIFEST_DOC = '__manifest__';

// A plain object, not an enum: the server runs TypeScript through Node's type stripping.
export const MessageKind = {
  /** y-protocols sync message (step 1, step 2 or update) for one document. */
  Sync: 0,
  /** y-protocols awareness update for one document. */
  Awareness: 1,
  /** JSON control message (errors, roles, acknowledgements). */
  Control: 2,
} as const;
export type MessageKind = (typeof MessageKind)[keyof typeof MessageKind];

export interface Envelope {
  version: number;
  kind: MessageKind;
  vault: string;
  doc: string;
  payload: Uint8Array;
}

export function encodeEnvelope(e: Omit<Envelope, 'version'>): Uint8Array {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, PROTOCOL_VERSION);
  encoding.writeVarUint(enc, e.kind);
  encoding.writeVarString(enc, e.vault);
  encoding.writeVarString(enc, e.doc);
  encoding.writeVarUint8Array(enc, e.payload);
  return encoding.toUint8Array(enc);
}

export function decodeEnvelope(data: Uint8Array): Envelope {
  const dec = decoding.createDecoder(data);
  const version = decoding.readVarUint(dec);
  if (version !== PROTOCOL_VERSION) throw new Error(`Unsupported protocol version ${version}`);
  return {
    version,
    kind: decoding.readVarUint(dec) as MessageKind,
    vault: decoding.readVarString(dec),
    doc: decoding.readVarString(dec),
    payload: decoding.readVarUint8Array(dec),
  };
}

export type ControlMessage =
  | { type: 'hello'; user: PublicUser; vaults: Array<{ id: string; name: string; role: Role }> }
  | { type: 'error'; message: string; doc?: string }
  /** The server stored an update (after `flush`, for clients waiting before shutdown). */
  | { type: 'synced'; doc: string }
  | { type: 'readonly'; doc: string };

export function encodeControl(vault: string, doc: string, message: ControlMessage): Uint8Array {
  return encodeEnvelope({
    kind: MessageKind.Control,
    vault,
    doc,
    payload: new TextEncoder().encode(JSON.stringify(message)),
  });
}

export function decodeControl(payload: Uint8Array): ControlMessage {
  return JSON.parse(new TextDecoder().decode(payload)) as ControlMessage;
}

export type Role = 'owner' | 'editor' | 'viewer';

export interface PublicUser {
  id: string;
  name: string;
  email: string;
  color: string;
}

/** An entry of the manifest's `files` map. */
export interface ManifestFile {
  path: string;
  kind: 'note' | 'drawing' | 'attachment' | 'other';
  /** sha256 of an attachment's content (blob store key). */
  blob?: string;
  size?: number;
  /** Tombstone: deletion time (content stays restorable on the server). */
  deleted?: number;
  created: number;
  createdBy?: string;
}

/** REST API shapes. */
export interface VaultInfo {
  id: string;
  name: string;
  role: Role;
  createdAt: number;
}

export interface Member {
  user: PublicUser;
  role: Role;
}

export interface Invite {
  token: string;
  role: Role;
  expiresAt: number;
}

export interface SnapshotInfo {
  id: number;
  doc: string;
  createdAt: number;
  size: number;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function base64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
