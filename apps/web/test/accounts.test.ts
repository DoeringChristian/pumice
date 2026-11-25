import { describe, expect, it } from 'vitest';
import { serverAddress, vaultKey } from '../src/accounts';

describe('server addresses', () => {
  it('takes what people type', () => {
    expect(serverAddress(' notes.example.com/ ', true)).toEqual({
      server: 'https://notes.example.com',
    });
    expect(serverAddress('localhost:8787', true)).toEqual({ server: 'http://localhost:8787' });
    expect(serverAddress('https://x.org/pumice/', true)).toEqual({
      server: 'https://x.org/pumice',
    });
  });
  it('says why one will not work', () => {
    expect(serverAddress('', true)).toHaveProperty('error');
    expect(serverAddress('ftp://x.org', true)).toHaveProperty('error');
    expect(serverAddress('http://x.org', true)).toHaveProperty('error');
    expect(serverAddress('http://x.org', false)).toEqual({ server: 'http://x.org' });
    // Only the computer itself, not a name that begins like it.
    expect(serverAddress('http://localhost.evil.org', true)).toHaveProperty('error');
  });
  it('keeps vaults of different servers apart', () => {
    expect(vaultKey({ server: 'https://a', id: '1' })).not.toBe(
      vaultKey({ server: 'https://b', id: '1' }),
    );
  });
});
