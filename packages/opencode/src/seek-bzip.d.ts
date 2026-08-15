declare module "seek-bzip" {
  export function decode(input: Uint8Array | Buffer, opts?: { offset?: number }): Buffer
}
