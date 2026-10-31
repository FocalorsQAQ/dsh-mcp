import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { apiAddSchema, apiUpdateSchema, apiRemoveSchema, apiMetadataSchema, DEEPSEEK_BASE_URL,
  type ApiEntry, type ApiRegistrySnapshot } from './credential-contract.ts';
import { DshError } from './types.ts';

/** Inject a platform cipher; no decrypt/reveal/export capability in the UI contract. */
export interface CredentialCipher { available(): Promise<boolean>; encrypt(plaintext: string): Promise<Buffer>; decrypt?(ciphertext: Buffer): Promise<string> }
const entrySchema = apiMetadataSchema.extend({ id: z.uuid(), created_at: z.iso.datetime(), updated_at: z.iso.datetime(),
  secret_ciphertext: z.string().min(1).max(22000) }).strict();
const fileSchema = z.object({ version: z.literal(1), revision: z.number().int().nonnegative().safe(),
  entries: z.array(entrySchema).max(100) }).strict();
type Vault = z.infer<typeof fileSchema>;
const publicEntry = (entry: Vault['entries'][number]): ApiEntry => ({ id: entry.id, name: entry.name,
  protocol: entry.protocol, base_url: entry.base_url, created_at: entry.created_at, updated_at: entry.updated_at });
function metadata(value: { name: string; protocol: ApiEntry['protocol']; base_url: string }) {
  return { name: value.name, protocol: value.protocol,
    base_url: value.protocol === 'deepseek' ? DEEPSEEK_BASE_URL : new URL(value.base_url).toString().replace(/\/+$/, '') };
}

/** Framework-independent, single-writer management service. Never part of MCP. */
export class CredentialRegistry {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly path: string, private readonly cipher: CredentialCipher) {}
  private read(): Vault {
    try {
      if (statSync(this.path).size > 2_500_000) throw new Error('File too large');
      const value = fileSchema.parse(JSON.parse(readFileSync(this.path, 'utf8')));
      if (new Set(value.entries.map(entry => entry.id)).size !== value.entries.length) throw new Error('Duplicate IDs');
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, revision: 0, entries: [] };
      throw new DshError('API_STORAGE', 'API configuration could not be read.');
    }
  }
  private async available() { try { return await this.cipher.available(); } catch { return false; } }
  async list(): Promise<ApiRegistrySnapshot> {
    const vault = this.read();
    return { revision: vault.revision, entries: vault.entries.map(publicEntry), encryption_available: await this.available() };
  }
  /** Read-only metadata for the host's synchronous dispatch admission checks. */
  metadata(): ApiEntry[] { return this.read().entries.map(publicEntry); }
  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const result = this.tail.then(action); this.tail = result.catch(() => {}); return result;
  }
  private revision(vault: Vault, expected: number) {
    if (vault.revision !== expected) throw new DshError('API_CONFLICT', 'API configuration changed.');
  }
  private save(vault: Vault, expected: number) {
    this.revision(this.read(), expected);
    const next = fileSchema.parse({ ...vault, revision: expected + 1 });
    const temporary = this.path + '.' + randomUUID() + '.tmp';
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(temporary, JSON.stringify(next), { mode: 0o600, flag: 'wx' });
      renameSync(temporary, this.path);
    } catch { throw new DshError('API_STORAGE', 'API configuration could not be saved.'); }
    finally { try { unlinkSync(temporary); } catch {} }
  }
  add(input: unknown) { return this.serialize(async () => {
    const command = apiAddSchema.parse(input), vault = this.read(); this.revision(vault, command.expected_revision);
    if (vault.entries.length >= 100) throw new DshError('API_CAPACITY', 'API list is full.');
    if (!await this.available()) throw new DshError('API_ENCRYPTION', 'System encryption is unavailable.');
    let encrypted: Buffer;
    try { encrypted = await this.cipher.encrypt(command.api_key); }
    catch { throw new DshError('API_ENCRYPTION', 'System encryption failed.'); }
    const now = new Date().toISOString();
    vault.entries.push({ id: randomUUID(), ...metadata(command), created_at: now, updated_at: now,
      secret_ciphertext: encrypted.toString('base64') });
    this.save(vault, command.expected_revision); return this.list();
  }); }
  update(input: unknown) { return this.serialize(async () => {
    const command = apiUpdateSchema.parse(input), vault = this.read(); this.revision(vault, command.expected_revision);
    const entry = vault.entries.find(item => item.id === command.id);
    if (!entry) throw new DshError('API_NOT_FOUND', 'API configuration was removed.');
    Object.assign(entry, metadata(command), { updated_at: new Date().toISOString() });
    this.save(vault, command.expected_revision); return this.list();
  }); }
  remove(input: unknown) { return this.serialize(async () => {
    const command = apiRemoveSchema.parse(input), vault = this.read(); this.revision(vault, command.expected_revision);
    if (!vault.entries.some(entry => entry.id === command.id)) throw new DshError('API_NOT_FOUND', 'API configuration was removed.');
    vault.entries = vault.entries.filter(entry => entry.id !== command.id);
    this.save(vault, command.expected_revision); return this.list();
  }); }
  /** Trusted host only. No IPC exposes this method or its plaintext argument. */
  withCredential<T>(id: string, expected: { protocol: string; base_url: string }, use: (key: string) => Promise<T>): Promise<T> {
    return this.serialize(async () => {
      const entry = this.read().entries.find(item => item.id === id);
      if (!entry) throw new DshError('API_NOT_FOUND', 'API was removed.');
      if (entry.protocol !== expected.protocol || entry.base_url !== expected.base_url) throw new DshError('API_CONFLICT', 'API endpoint changed.');
      if (!this.cipher.decrypt || !await this.available()) throw new DshError('API_ENCRYPTION', 'System encryption unavailable.');
      let key: string;
      try { key = await this.cipher.decrypt(Buffer.from(entry.secret_ciphertext, 'base64')); }
      catch { throw new DshError('API_ENCRYPTION', 'Cannot unlock API credential.'); }
      try { return await use(key); } finally { key = ''; }
    });
  }
}
