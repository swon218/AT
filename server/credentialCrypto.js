import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { config } from './config.js'

function getEncryptionKey() {
  const raw = config.credentialEncryptionKey.trim()
  const key = /^[a-f\d]{64}$/i.test(raw)
    ? Buffer.from(raw, 'hex')
    : Buffer.from(raw, 'base64')

  if (key.length !== 32) {
    throw new Error('ATLAS_CREDENTIAL_ENCRYPTION_KEY must be a 32-byte Base64 or 64-character hex key.')
  }
  return key
}

export function encryptCredentials(userId, credentials) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', getEncryptionKey(), iv)
  cipher.setAAD(Buffer.from(userId, 'utf8'))
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(credentials), 'utf8'),
    cipher.final(),
  ])

  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
  }
}

export function decryptCredentials(userId, encrypted) {
  if (!encrypted?.ciphertext || !encrypted?.iv || !encrypted?.authTag) return {}
  const decipher = createDecipheriv(
    'aes-256-gcm',
    getEncryptionKey(),
    Buffer.from(encrypted.iv, 'base64'),
  )
  decipher.setAAD(Buffer.from(userId, 'utf8'))
  decipher.setAuthTag(Buffer.from(encrypted.authTag, 'base64'))
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(encrypted.ciphertext, 'base64')),
    decipher.final(),
  ])
  return JSON.parse(plaintext.toString('utf8'))
}
