import { AwsV4Signer } from "aws4fetch"
import { Effect } from "effect"
import { Headers } from "effect/unstable/http"
import { Auth, type AuthInput } from "../../route/auth"
import { ProviderShared } from "../shared"
import type { LLMError } from "../../schema"

/**
 * AWS credentials for SigV4 signing. Bedrock also supports Bearer API key auth,
 * which provider facades configure as route auth instead of SigV4. STS-vended
 * credentials should be refreshed by the consumer (rebuild the model) before
 * they expire; the route does not refresh.
 */
export interface Credentials {
  readonly region: string
  readonly accessKeyId: string
  readonly secretAccessKey: string
  readonly sessionToken?: string
}

/** Static credentials or an effect resolved before every request (e.g. STS refresh). */
export type CredentialSource = Credentials | Effect.Effect<Credentials, LLMError>

const signRequest = (input: {
  readonly url: string
  readonly body: string
  readonly headers: Headers.Headers
  readonly credentials: Credentials
  readonly service: string
  readonly name: string
}) =>
  Effect.tryPromise({
    try: async () => {
      const signed = await new AwsV4Signer({
        url: input.url,
        method: "POST",
        headers: Object.entries(input.headers),
        body: input.body,
        region: input.credentials.region,
        accessKeyId: input.credentials.accessKeyId,
        secretAccessKey: input.credentials.secretAccessKey,
        sessionToken: input.credentials.sessionToken,
        service: input.service,
      }).sign()
      return Object.fromEntries(signed.headers.entries())
    },
    catch: (error) =>
      ProviderShared.invalidRequest(
        `${input.name} SigV4 signing failed: ${error instanceof Error ? error.message : String(error)}`,
      ),
  })

/** Sign the exact JSON bytes with SigV4 using credentials configured on the route. */
export const sigV4 = (
  source: CredentialSource | undefined,
  options: { readonly service?: string; readonly name?: string } = {},
) =>
  Auth.custom((input: AuthInput) => {
    return Effect.gen(function* () {
      if (!source) {
        return yield* ProviderShared.invalidRequest(
          `${options.name ?? "Bedrock Converse"} requires either route bearer auth or AWS credentials configured on the route`,
        )
      }
      const credentials = Effect.isEffect(source) ? yield* source : source
      const headersForSigning = Headers.set(input.headers, "content-type", "application/json")
      const signed = yield* signRequest({
        url: input.url,
        body: input.body,
        headers: headersForSigning,
        credentials,
        service: options.service ?? "bedrock",
        name: options.name ?? "Bedrock Converse",
      })
      return Headers.setAll(headersForSigning, signed)
    })
  })

/** Bedrock route auth defaults to SigV4 and expects credentials from route configuration. */
export const auth = sigV4(undefined)

export const resolveRegion = (input: { readonly region?: string; readonly credentials?: { readonly region: string } }) =>
  input.region ?? input.credentials?.region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1"

export interface ResolveAuthInput {
  readonly apiKey?: string
  readonly credentials?: Credentials
}

export interface ResolveAuthOptions {
  readonly service?: string
  readonly name?: string
  /** `sigv4` ignores an ambient `AWS_BEARER_TOKEN_BEDROCK`. */
  readonly mode?: "bearer" | "sigv4"
}

/**
 * Bearer wins over SigV4 and explicit static credentials win over ambient
 * resolution, matching the AWS SDK's own precedence for
 * `AWS_BEARER_TOKEN_BEDROCK`. The region is applied to the SigV4 scope so it
 * always matches the endpoint host. The full AWS default chain
 * (env/shared/SSO/web-identity/process) is intentionally not ported: it needs
 * `@aws-sdk/credential-providers`, which this package does not depend on.
 */
export const resolveAuth = (input: ResolveAuthInput, region: string, options: ResolveAuthOptions = {}) => {
  const apiKey = options.mode === "sigv4" ? undefined : (input.apiKey ?? process.env.AWS_BEARER_TOKEN_BEDROCK)
  if (apiKey !== undefined) return Auth.bearer(apiKey)
  if (input.credentials !== undefined) return sigV4({ ...input.credentials, region }, options)
  return sigV4(undefined, options)
}

export * as BedrockAuth from "./bedrock-auth"
