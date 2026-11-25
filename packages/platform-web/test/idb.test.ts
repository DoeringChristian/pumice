import { IDBFactory } from 'fake-indexeddb';
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { IdbFs, IdbStorage } from '../src/index';

const open = () =>
  new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('v', 1);
    request.onupgradeneeded = () => {
      for (const s of ['stats', 'data', 'keys']) request.result.createObjectStore(s);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

describe('a vault in the browser', () => {
  let db: IDBDatabase;
  let fs: IdbFs;
  beforeEach(async () => {
    globalThis.indexedDB = new IDBFactory();
    db = await open();
    fs = await IdbFs.load(db);
  });
  const paths = async (f = fs) => (await f.list()).map((s) => s.path).sort();

  it('keeps files, folders and bytes across a reload', async () => {
    await fs.write('a/b/note.md', 'Grüße');
    await fs.write('pic.png', new Uint8Array([0, 255, 7]));
    const again = await IdbFs.load(db);
    expect(await paths(again)).toEqual(['a', 'a/b', 'a/b/note.md', 'pic.png']);
    expect(await again.readText('a/b/note.md')).toBe('Grüße');
    expect([...(await again.readBinary('pic.png'))]).toEqual([0, 255, 7]);
  });

  it('gives every write a later time', async () => {
    const first = await fs.write('n.md', '1');
    expect((await fs.write('n.md', '2')).mtime).toBeGreaterThan(first.mtime);
  });

  it('renames folders with what is in them', async () => {
    await fs.write('old/x.md', 'x');
    await fs.write('older.md', 'stays');
    await fs.rename('old', 'new/place');
    const again = await IdbFs.load(db);
    expect(await paths(again)).toEqual(['new', 'new/place', 'new/place/x.md', 'older.md']);
    expect(await again.readText('new/place/x.md')).toBe('x');
    await expect(fs.rename('older.md', 'new/place/x.md')).rejects.toThrow('EEXIST');
    await expect(fs.rename('new', 'new/inner')).rejects.toThrow('EINVAL');
  });

  it('removes folders whole, and only them', async () => {
    await fs.write('f/x.md', 'x');
    await fs.write('f2.md', 'y');
    await fs.remove('f');
    expect(await paths(await IdbFs.load(db))).toEqual(['f2.md']);
    await expect(fs.readText('f/x.md')).rejects.toThrow('ENOENT');
  });

  it('does not take a file for a folder', async () => {
    await fs.write('x', 'file');
    await expect(fs.write('x/y.md', '')).rejects.toThrow('ENOTDIR');
    await expect(fs.mkdir('x')).rejects.toThrow('ENOTDIR');
  });

  it('refuses a vault that lost contents (its sync would delete them for everyone)', async () => {
    await fs.write('n.md', 'x');
    await new Promise<void>((resolve) => {
      const tx = db.transaction('data', 'readwrite');
      tx.objectStore('data').delete('n.md');
      tx.oncomplete = () => resolve();
    });
    await expect(IdbFs.load(db)).rejects.toThrow('damaged');
  });

  it('stores values by key', async () => {
    const storage = new IdbStorage(db);
    expect(await storage.get('k')).toBeUndefined();
    await storage.set('k', 'v');
    expect(await storage.get('k')).toBe('v');
    await storage.delete('k');
    expect(await storage.get('k')).toBeUndefined();
  });
});
