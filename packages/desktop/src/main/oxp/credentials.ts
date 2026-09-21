import { safeStorage } from "electron"
import { write as writeLog } from "../logging"
import {
  OxpCredentialStore,
  secureStorageCiphertextIsProtected,
  secureStorageStatus as resolveSecureStorageStatus,
  type SecureStorageAdapter,
  type SecureStorageStatus,
} from "./credentials-store"

const storage: SecureStorageAdapter = {
  isAsyncEncryptionAvailable: () => safeStorage.isAsyncEncryptionAvailable(),
  encryptStringAsync: (value) => safeStorage.encryptStringAsync(value),
  decryptStringAsync: (value) => safeStorage.decryptStringAsync(value),
}

export { secureStorageCiphertextIsProtected }
export type { SecureStorageStatus }

export function secureStorageStatus(platform: NodeJS.Platform = process.platform): Promise<SecureStorageStatus> {
  return resolveSecureStorageStatus(storage, platform)
}

export class OxpCredentials extends OxpCredentialStore {
  constructor(userDataPath: string) {
    super(
      userDataPath,
      storage,
      process.platform,
      () => writeLog("oxp", "secure credential store could not be decrypted; ciphertext left untouched", undefined, "warn"),
    )
  }
}
