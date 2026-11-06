import { Injectable } from '@nestjs/common';
import type { KioskSyncKey } from '@cims/shared';
import { Prisma } from '@prisma/client';
import {
  type KeyObject,
  constants,
  createPrivateKey,
  generateKeyPairSync,
  privateDecrypt,
} from 'node:crypto';
import { EncryptionService } from '../../infrastructure/crypto/encryption.service';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

/**
 * Manages the RSA-OAEP key pair kiosks use to protect credentials captured while offline.
 * Kiosks hold only the public key, so a stolen device cannot read queued PINs. The private key is
 * stored encrypted at rest and decrypted keys are cached in memory per key id.
 */
@Injectable()
export class KioskSyncKeyService {
  private readonly cache = new Map<string, KeyObject>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
  ) {}

  async activeKey(): Promise<KioskSyncKey> {
    const existing = await this.prisma.kioskSyncKey.findFirst({ where: { isActive: true } });
    const key = existing ?? (await this.createKey());
    return { keyId: key.id, publicKeySpki: key.publicKeySpki };
  }

  /** Decrypts a kiosk ciphertext; returns null for an unknown key or undecryptable payload. */
  async decrypt(keyId: string, ciphertextB64: string): Promise<string | null> {
    const key = await this.privateKey(keyId);
    if (!key) return null;
    try {
      return privateDecrypt(
        { key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
        Buffer.from(ciphertextB64, 'base64'),
      ).toString('utf8');
    } catch {
      return null;
    }
  }

  private async privateKey(keyId: string): Promise<KeyObject | null> {
    const cached = this.cache.get(keyId);
    if (cached) return cached;
    // Retired keys still decrypt items queued before a rotation.
    const row = await this.prisma.kioskSyncKey.findUnique({ where: { id: keyId } });
    if (!row) return null;
    const key = createPrivateKey(this.encryption.decrypt(row.privateKeyEnc));
    this.cache.set(keyId, key);
    return key;
  }

  private async createKey() {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 3072 });
    try {
      return await this.prisma.kioskSyncKey.create({
        data: {
          publicKeySpki: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
          privateKeyEnc: this.encryption.encrypt(
            privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
          ),
        },
      });
    } catch (err) {
      // Another request created the active key first (partial unique index): use that one.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return this.prisma.kioskSyncKey.findFirstOrThrow({ where: { isActive: true } });
      }
      throw err;
    }
  }
}
