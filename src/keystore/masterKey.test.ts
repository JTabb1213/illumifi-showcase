import { describe, expect, it } from 'vitest';
import { DEFAULT_KDF_ITERATIONS, deriveVaultKeyAndAuth, newKdfSalt } from './masterKey';

// The iteration count comes from the server (prelogin, the Google ticket). A server that has been broken into could
// send 1 instead of 600,000, so the browser would hand it a hash of the password that is cheap to guess against.
// The browser must refuse anything weaker than what it uses for new accounts.
describe('KDF parameters from the server', () => {
  const salt = newKdfSalt();

  it('refuses an iteration count below the floor', async () => {
    await expect(deriveVaultKeyAndAuth('correct horse', salt, 1)).rejects.toThrow(/security settings/);
    await expect(deriveVaultKeyAndAuth('correct horse', salt, DEFAULT_KDF_ITERATIONS - 1)).rejects.toThrow(
      /security settings/,
    );
  });

  it('refuses a non-integer or absurd iteration count', async () => {
    await expect(deriveVaultKeyAndAuth('correct horse', salt, Number.NaN)).rejects.toThrow(/security settings/);
    await expect(deriveVaultKeyAndAuth('correct horse', salt, 600_000.5)).rejects.toThrow(/security settings/);
    await expect(deriveVaultKeyAndAuth('correct horse', salt, 1e12)).rejects.toThrow(/security settings/);
  });

  it('refuses a missing or short salt', async () => {
    await expect(deriveVaultKeyAndAuth('correct horse', '', DEFAULT_KDF_ITERATIONS)).rejects.toThrow(
      /security settings/,
    );
    await expect(deriveVaultKeyAndAuth('correct horse', btoa('abc'), DEFAULT_KDF_ITERATIONS)).rejects.toThrow(
      /security settings/,
    );
  });

  it('derives normally at the default', async () => {
    const a = await deriveVaultKeyAndAuth('correct horse', salt, DEFAULT_KDF_ITERATIONS);
    const b = await deriveVaultKeyAndAuth('correct horse', salt, DEFAULT_KDF_ITERATIONS);
    expect(a.authHash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.authHash).toBe(b.authHash);
  }, 30_000); // two real 600,000-round derivations: slow on purpose, over the 5 s default on a busy machine (2026-11-06)
});
