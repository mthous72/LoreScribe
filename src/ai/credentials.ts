/**
 * Where the API key lives — [D30](../../docs/10-decisions.md).
 *
 * The key is a credential, a different risk class from the manuscript
 * ([D12](../../docs/10-decisions.md)): the database is not encrypted at rest
 * and the key is. It is encrypted with a **device key** — an AES-GCM key
 * WebCrypto generates non-extractable and the browser stores as an opaque
 * object in IndexedDB — and the ciphertext sits beside it. Neither ever
 * reaches SQLite, the archive export, a log, or `ai_run`; the row that names
 * the account holds only `credential_ref`, a handle into this store.
 *
 * What that protects: the key cannot be read out of a storage dump, a copied
 * profile directory, an exported archive, or the database file, and it does not
 * travel in anything the writer hands to someone else. What it does not
 * protect against: code running as this origin on this device, which can ask
 * the browser to decrypt exactly as the app does. That is the boundary D12
 * already draws — the device's own security — and it is stated in the UI in
 * those words rather than implied by a padlock.
 *
 * Doc 01 sketched a passphrase-derived key instead. That is stronger and costs
 * an unlock screen on every open, the friction D12 rejected for the database.
 * The vault interface leaves the door open: wrapping the device key with a
 * passphrase later, or replacing it with the Android Keystore in Phase 6, is a
 * new `KeyVault`, not a new store.
 */

export interface CredentialStore {
  save(ref: string, secret: string): Promise<void>;
  load(ref: string): Promise<string | null>;
  forget(ref: string): Promise<void>;
}

/** Holds the device key and the ciphertexts. IndexedDB in the browser. */
export interface KeyVault {
  getDeviceKey(): Promise<CryptoKey | null>;
  putDeviceKey(key: CryptoKey): Promise<void>;
  get(ref: string): Promise<Sealed | null>;
  put(ref: string, sealed: Sealed): Promise<void>;
  remove(ref: string): Promise<void>;
}

export interface Sealed {
  iv: Uint8Array<ArrayBuffer>;
  ciphertext: Uint8Array<ArrayBuffer>;
}

const ALGORITHM = 'AES-GCM';

const randomBytes = (n: number): Uint8Array<ArrayBuffer> =>
  globalThis.crypto.getRandomValues(new Uint8Array(n));

export class EncryptedCredentialStore implements CredentialStore {
  constructor(
    private readonly vault: KeyVault,
    private readonly subtle: SubtleCrypto = globalThis.crypto.subtle,
    private readonly random: (n: number) => Uint8Array<ArrayBuffer> = randomBytes,
  ) {}

  async save(ref: string, secret: string): Promise<void> {
    const key = await this.#deviceKey();
    const iv = this.random(12);
    const ciphertext = new Uint8Array(await this.subtle.encrypt(
      { name: ALGORITHM, iv }, key, new TextEncoder().encode(secret)));
    await this.vault.put(ref, { iv, ciphertext });
  }

  async load(ref: string): Promise<string | null> {
    const sealed = await this.vault.get(ref);
    if (!sealed) return null;
    const key = await this.vault.getDeviceKey();
    // A ciphertext with no key to open it is a secret that is gone, not one
    // that is still there. Say so rather than throwing from inside WebCrypto.
    if (!key) return null;
    try {
      const plain = await this.subtle.decrypt({ name: ALGORITHM, iv: sealed.iv }, key, sealed.ciphertext);
      return new TextDecoder().decode(plain);
    } catch {
      return null;
    }
  }

  async forget(ref: string): Promise<void> {
    await this.vault.remove(ref);
  }

  async #deviceKey(): Promise<CryptoKey> {
    const held = await this.vault.getDeviceKey();
    if (held) return held;
    // Non-extractable: the browser will encrypt and decrypt with it, and will
    // not hand the bytes to anybody, this app included.
    const key = await this.subtle.generateKey(
      { name: ALGORITHM, length: 256 }, false, ['encrypt', 'decrypt']);
    await this.vault.putDeviceKey(key);
    return key;
  }
}

/** For tests, and for a session where IndexedDB is refused. Nothing survives a reload. */
export class MemoryVault implements KeyVault {
  #device: CryptoKey | null = null;
  readonly #sealed = new Map<string, Sealed>();
  async getDeviceKey() { return this.#device; }
  async putDeviceKey(key: CryptoKey) { this.#device = key; }
  async get(ref: string) { return this.#sealed.get(ref) ?? null; }
  async put(ref: string, sealed: Sealed) { this.#sealed.set(ref, sealed); }
  async remove(ref: string) { this.#sealed.delete(ref); }
}

const DB_NAME = 'lorescribe-credentials';
const STORE = 'vault';
const DEVICE_KEY = '__device-key';

/**
 * IndexedDB, because it can store a `CryptoKey` as an object — `localStorage`
 * cannot, and exporting the key to store it as bytes would defeat the point.
 */
export class IndexedDbVault implements KeyVault {
  #db: Promise<IDBDatabase> | null = null;

  #open(): Promise<IDBDatabase> {
    this.#db ??= new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => { req.result.createObjectStore(STORE); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('IndexedDB refused to open'));
    });
    return this.#db;
  }

  async #tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await this.#open();
    return new Promise<T>((resolve, reject) => {
      const req = run(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
    });
  }

  async getDeviceKey(): Promise<CryptoKey | null> {
    return (await this.#tx<CryptoKey | undefined>('readonly', (s) => s.get(DEVICE_KEY))) ?? null;
  }
  async putDeviceKey(key: CryptoKey): Promise<void> {
    await this.#tx('readwrite', (s) => s.put(key, DEVICE_KEY));
  }
  async get(ref: string): Promise<Sealed | null> {
    return (await this.#tx<Sealed | undefined>('readonly', (s) => s.get(`cred:${ref}`))) ?? null;
  }
  async put(ref: string, sealed: Sealed): Promise<void> {
    await this.#tx('readwrite', (s) => s.put(sealed, `cred:${ref}`));
  }
  async remove(ref: string): Promise<void> {
    await this.#tx('readwrite', (s) => s.delete(`cred:${ref}`));
  }
}
