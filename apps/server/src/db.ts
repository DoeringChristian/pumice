import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';

// Loaded through require: bundlers and test runners don't know the newer `node:sqlite` builtin.
const { DatabaseSync } = createRequire(import.meta.url)(
  'node:sqlite',
) as typeof import('node:sqlite');
import type { Member, PublicUser, Role, SnapshotInfo, VaultInfo } from '@pumice/collab-protocol';

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
export const newToken = () => randomBytes(32).toString('base64url');
export const newId = () => randomBytes(9).toString('base64url');

const COLORS = [
  '#e3825a',
  '#4c9a5c',
  '#2f6fb0',
  '#a34fb0',
  '#d4a72c',
  '#2a8a86',
  '#c43c3c',
  '#6b6bd6',
];

/** SQLite (node:sqlite) storage for accounts, vaults, document updates and snapshots. */
export class Store {
  readonly db: DatabaseSyncType;

  readonly dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(join(dataDir, 'pumice.db'));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL, color TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS login_codes (email TEXT PRIMARY KEY, code_hash TEXT NOT NULL, expires INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, created INTEGER NOT NULL, last_seen INTEGER NOT NULL, device TEXT);
      CREATE TABLE IF NOT EXISTS vaults (id TEXT PRIMARY KEY, name TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS members (vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, role TEXT NOT NULL, PRIMARY KEY (vault_id, user_id));
      CREATE TABLE IF NOT EXISTS invites (token_hash TEXT PRIMARY KEY, vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE, role TEXT NOT NULL, expires INTEGER NOT NULL, created_by TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS updates (id INTEGER PRIMARY KEY AUTOINCREMENT, vault TEXT NOT NULL, doc TEXT NOT NULL, data BLOB NOT NULL, created INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS updates_doc ON updates (vault, doc, id);
      CREATE TABLE IF NOT EXISTS snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, vault TEXT NOT NULL, doc TEXT NOT NULL, data BLOB NOT NULL, created INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS snapshots_doc ON snapshots (vault, doc, id);
      CREATE TABLE IF NOT EXISTS crashes (id INTEGER PRIMARY KEY AUTOINCREMENT, report TEXT NOT NULL, created INTEGER NOT NULL);
    `);
  }

  close(): void {
    this.db.close();
  }

  // ---- users & sessions ------------------------------------------------------------------------

  userByEmail(email: string): PublicUser | undefined {
    return this.db
      .prepare('SELECT id, email, name, color FROM users WHERE email = ?')
      .get(email) as PublicUser | undefined;
  }

  userById(id: string): PublicUser | undefined {
    return this.db.prepare('SELECT id, email, name, color FROM users WHERE id = ?').get(id) as
      PublicUser | undefined;
  }

  createUser(email: string, name: string): PublicUser {
    const count = (this.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
    const user: PublicUser = { id: newId(), email, name, color: COLORS[count % COLORS.length]! };
    this.db
      .prepare('INSERT INTO users (id, email, name, color, created) VALUES (?, ?, ?, ?, ?)')
      .run(user.id, email, name, user.color, Date.now());
    return user;
  }

  setLoginCode(email: string, code: string, ttlMs: number): void {
    this.db
      .prepare(
        'INSERT INTO login_codes (email, code_hash, expires, attempts) VALUES (?, ?, ?, 0) ON CONFLICT(email) DO UPDATE SET code_hash = excluded.code_hash, expires = excluded.expires, attempts = 0',
      )
      .run(email, hashToken(code), Date.now() + ttlMs);
  }

  /** Checks a login code (single use, 5 attempts). */
  consumeLoginCode(email: string, code: string): boolean {
    const row = this.db
      .prepare('SELECT code_hash, expires, attempts FROM login_codes WHERE email = ?')
      .get(email) as { code_hash: string; expires: number; attempts: number } | undefined;
    if (!row || row.expires < Date.now() || row.attempts >= 5) return false;
    if (row.code_hash !== hashToken(code)) {
      this.db.prepare('UPDATE login_codes SET attempts = attempts + 1 WHERE email = ?').run(email);
      return false;
    }
    this.db.prepare('DELETE FROM login_codes WHERE email = ?').run(email);
    return true;
  }

  createSession(userId: string, device: string): string {
    const token = newToken();
    this.db
      .prepare(
        'INSERT INTO sessions (token_hash, user_id, created, last_seen, device) VALUES (?, ?, ?, ?, ?)',
      )
      .run(hashToken(token), userId, Date.now(), Date.now(), device);
    return token;
  }

  userForToken(token: string): PublicUser | undefined {
    const row = this.db
      .prepare('SELECT user_id FROM sessions WHERE token_hash = ?')
      .get(hashToken(token)) as { user_id: string } | undefined;
    if (!row) return undefined;
    this.db
      .prepare('UPDATE sessions SET last_seen = ? WHERE token_hash = ?')
      .run(Date.now(), hashToken(token));
    return this.userById(row.user_id);
  }

  deleteSession(token: string): void {
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
  }

  // ---- vaults, members, invites ------------------------------------------------------------------

  createVault(name: string, ownerId: string): VaultInfo {
    const vault = { id: newId(), name, createdAt: Date.now() };
    this.db
      .prepare('INSERT INTO vaults (id, name, created) VALUES (?, ?, ?)')
      .run(vault.id, name, vault.createdAt);
    this.db
      .prepare('INSERT INTO members (vault_id, user_id, role) VALUES (?, ?, ?)')
      .run(vault.id, ownerId, 'owner');
    return { ...vault, role: 'owner' };
  }

  vaultsOf(userId: string): VaultInfo[] {
    return (
      this.db
        .prepare(
          'SELECT v.id, v.name, v.created AS createdAt, m.role FROM vaults v JOIN members m ON m.vault_id = v.id WHERE m.user_id = ? ORDER BY v.created',
        )
        .all(userId) as unknown as VaultInfo[]
    ).map((v) => ({ ...v }));
  }

  role(vaultId: string, userId: string): Role | undefined {
    const row = this.db
      .prepare('SELECT role FROM members WHERE vault_id = ? AND user_id = ?')
      .get(vaultId, userId) as { role: Role } | undefined;
    return row?.role;
  }

  members(vaultId: string): Member[] {
    const rows = this.db
      .prepare(
        'SELECT u.id, u.email, u.name, u.color, m.role FROM members m JOIN users u ON u.id = m.user_id WHERE m.vault_id = ? ORDER BY u.name',
      )
      .all(vaultId) as unknown as Array<PublicUser & { role: Role }>;
    return rows.map(({ role, ...user }) => ({ user: { ...user }, role }));
  }

  addMember(vaultId: string, userId: string, role: Role): void {
    this.db
      .prepare('INSERT OR IGNORE INTO members (vault_id, user_id, role) VALUES (?, ?, ?)')
      .run(vaultId, userId, role);
  }

  setRole(vaultId: string, userId: string, role: Role): void {
    this.db
      .prepare('UPDATE members SET role = ? WHERE vault_id = ? AND user_id = ?')
      .run(role, vaultId, userId);
  }

  removeMember(vaultId: string, userId: string): void {
    this.db.prepare('DELETE FROM members WHERE vault_id = ? AND user_id = ?').run(vaultId, userId);
  }

  createInvite(
    vaultId: string,
    role: Role,
    createdBy: string,
    ttlMs: number,
  ): { token: string; expiresAt: number } {
    const token = newToken();
    const expiresAt = Date.now() + ttlMs;
    this.db
      .prepare(
        'INSERT INTO invites (token_hash, vault_id, role, expires, created_by) VALUES (?, ?, ?, ?, ?)',
      )
      .run(hashToken(token), vaultId, role, expiresAt, createdBy);
    return { token, expiresAt };
  }

  acceptInvite(token: string, userId: string): VaultInfo | undefined {
    const row = this.db
      .prepare('SELECT vault_id, role, expires FROM invites WHERE token_hash = ?')
      .get(hashToken(token)) as { vault_id: string; role: Role; expires: number } | undefined;
    if (!row || row.expires < Date.now()) return undefined;
    const current = this.role(row.vault_id, userId);
    if (!current)
      this.db
        .prepare('INSERT INTO members (vault_id, user_id, role) VALUES (?, ?, ?)')
        .run(row.vault_id, userId, row.role);
    return this.vaultsOf(userId).find((v) => v.id === row.vault_id);
  }

  addCrash(report: string): void {
    this.db.prepare('INSERT INTO crashes (report, created) VALUES (?, ?)').run(report, Date.now());
    // Keep the newest 10 000.
    this.db.prepare('DELETE FROM crashes WHERE id <= (SELECT MAX(id) FROM crashes) - 10000').run();
  }

  // ---- documents ---------------------------------------------------------------------------------

  updates(vault: string, doc: string): Uint8Array[] {
    return (
      this.db
        .prepare('SELECT data FROM updates WHERE vault = ? AND doc = ? ORDER BY id')
        .all(vault, doc) as Array<{ data: Uint8Array }>
    ).map((r) => new Uint8Array(r.data));
  }

  appendUpdate(vault: string, doc: string, data: Uint8Array): number {
    this.db
      .prepare('INSERT INTO updates (vault, doc, data, created) VALUES (?, ?, ?, ?)')
      .run(vault, doc, data, Date.now());
    return (
      this.db
        .prepare('SELECT COUNT(*) AS n FROM updates WHERE vault = ? AND doc = ?')
        .get(vault, doc) as { n: number }
    ).n;
  }

  /** Replaces all stored updates of a document with one merged state. */
  compact(vault: string, doc: string, state: Uint8Array): void {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM updates WHERE vault = ? AND doc = ?').run(vault, doc);
      this.db
        .prepare('INSERT INTO updates (vault, doc, data, created) VALUES (?, ?, ?, ?)')
        .run(vault, doc, state, Date.now());
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  docIds(vault: string): string[] {
    return (
      this.db.prepare('SELECT DISTINCT doc FROM updates WHERE vault = ?').all(vault) as Array<{
        doc: string;
      }>
    ).map((r) => r.doc);
  }

  addSnapshot(vault: string, doc: string, state: Uint8Array): void {
    this.db
      .prepare('INSERT INTO snapshots (vault, doc, data, created) VALUES (?, ?, ?, ?)')
      .run(vault, doc, state, Date.now());
  }

  lastSnapshotTime(vault: string, doc: string): number {
    const row = this.db
      .prepare('SELECT MAX(created) AS t FROM snapshots WHERE vault = ? AND doc = ?')
      .get(vault, doc) as { t: number | null };
    return row.t ?? 0;
  }

  snapshots(vault: string, doc: string): SnapshotInfo[] {
    return (
      this.db
        .prepare(
          'SELECT id, doc, created AS createdAt, length(data) AS size FROM snapshots WHERE vault = ? AND doc = ? ORDER BY id DESC LIMIT 200',
        )
        .all(vault, doc) as unknown as SnapshotInfo[]
    ).map((s) => ({ ...s }));
  }

  snapshot(vault: string, doc: string, id: number): Uint8Array | undefined {
    const row = this.db
      .prepare('SELECT data FROM snapshots WHERE vault = ? AND doc = ? AND id = ?')
      .get(vault, doc, id) as { data: Uint8Array } | undefined;
    return row ? new Uint8Array(row.data) : undefined;
  }
}
