import {
  MANAGED_ERROR_CODES,
  MANAGED_LIMITS,
  ManagedRequestInvalid,
  managedCreateInitializeRequestDocument,
  managedProtocolVersionRequestDocument,
  managedStatusRequestDocument,
  type ManagedCreateInitializeRequest,
  type ManagedCreateInitializeRequestDocument,
  type ManagedProtocolVersionRequestDocument,
  type ManagedStatusRequestDocument,
} from "./protocol"

export interface ManagedCreateInitializeInput {
  readonly worktreeId: string
  readonly repositoryId: string
  readonly repositoryPath?: string
  readonly storageVolumeId: string
  readonly targetPath: string
  readonly branchName: string
  readonly commitish: string
  readonly storagePolicy: ManagedCreateInitializeRequest["storagePolicy"]
  readonly storageProbe: ManagedCreateInitializeRequest["storageProbe"]
  readonly dedupe: ManagedCreateInitializeRequest["dedupe"]
}

export function createInitializeRequestDocument(input: ManagedCreateInitializeInput): ManagedCreateInitializeRequestDocument {
  if (input.branchName.startsWith("refs/")) {
    throw new ManagedRequestInvalid({
      code: MANAGED_ERROR_CODES.requestInvalid,
      message: "request.branchName must be a short branch name; the managed manager composes refs/heads/<branchName>.",
    })
  }
  return managedCreateInitializeRequestDocument({
    worktreeId: input.worktreeId,
    repositoryId: input.repositoryId,
    ...(input.repositoryPath === undefined ? {} : { repositoryPath: input.repositoryPath }),
    storageVolumeId: input.storageVolumeId,
    targetPath: input.targetPath,
    branchName: input.branchName,
    commitish: input.commitish,
    storagePolicy: input.storagePolicy,
    storageProbe: input.storageProbe,
    dedupe: input.dedupe,
  })
}

export function statusRequestDocument(worktreeId: string): ManagedStatusRequestDocument {
  return managedStatusRequestDocument(worktreeId)
}

export function protocolVersionRequestDocument(): ManagedProtocolVersionRequestDocument {
  return managedProtocolVersionRequestDocument()
}

export function serializeRequestDocument(document: unknown): string {
  const text = JSON.stringify(document)
  if (typeof text !== "string") {
    throw new ManagedRequestInvalid({
      code: MANAGED_ERROR_CODES.requestInvalid,
      message: "request document is not JSON-serializable.",
    })
  }
  if (Buffer.byteLength(text, "utf8") > MANAGED_LIMITS.maxRequestBytes) {
    throw new ManagedRequestInvalid({
      code: MANAGED_ERROR_CODES.requestInvalid,
      message: `request document exceeds ${MANAGED_LIMITS.maxRequestBytes} bytes.`,
    })
  }
  return text
}

export * as ManagedRequest from "./request"
