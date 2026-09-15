import { describe, it, expect } from 'vitest';
import { EncryptedCredentialStore, MemoryVault } from './credentials';

/**
 * D30 in tests. The vault is in memory here; what is under test is that the
 * store never writes the secret anywhere in the clear, that it comes back, and
 * that a vault without its device key yields nothing rather than an exception.
 */

describe('EncryptedCredentialStore', () => {
  it('round-trips a secret and stores only ciphertext', async () => {
    const vault = new MemoryVault();
    const store = new EncryptedCredentialStore(vault);
    await store.save('acct-1', 'sk-or-v1-verysecret');
    expect(await store.load('acct-1')).toBe('sk-or-v1-verysecret');

    const sealed = await vault.get('acct-1');
    const bytes = new TextDecoder().decode(sealed!.ciphertext);
    expect(bytes).not.toContain('verysecret');
    expect(sealed!.iv).toHaveLength(12);
  });

  it('seals the same secret differently each time', async () => {
    const vault = new MemoryVault();
    const store = new EncryptedCredentialStore(vault);
    await store.save('a', 'same');
    const first = await vault.get('a');
    await store.save('a', 'same');
    const second = await vault.get('a');
    expect(Buffer.from(first!.ciphertext).equals(Buffer.from(second!.ciphertext))).toBe(false);
  });

  it('generates a device key the browser will not hand back', async () => {
    const vault = new MemoryVault();
    await new EncryptedCredentialStore(vault).save('a', 'x');
    const key = await vault.getDeviceKey();
    expect(key?.extractable).toBe(false);
    expect(key?.usages).toEqual(['encrypt', 'decrypt']);
  });

  it('answers null for a handle it has never seen, and after forgetting', async () => {
    const store = new EncryptedCredentialStore(new MemoryVault());
    expect(await store.load('nothing')).toBeNull();
    await store.save('a', 'x');
    await store.forget('a');
    expect(await store.load('a')).toBeNull();
  });

  it('treats a ciphertext with no key to open it as gone, not as an error', async () => {
    const vault = new MemoryVault();
    await new EncryptedCredentialStore(vault).save('a', 'x');
    // A fresh vault with the same ciphertext and a different device key — a
    // copied profile, or a cleared IndexedDB that kept the row somehow.
    const other = new MemoryVault();
    await other.put('a', (await vault.get('a'))!);
    expect(await new EncryptedCredentialStore(other).load('a')).toBeNull();
    await new EncryptedCredentialStore(other).save('b', 'y');
    expect(await new EncryptedCredentialStore(other).load('a')).toBeNull();
  });
});
