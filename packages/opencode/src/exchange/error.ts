import { Schema } from "effect"

export class InvalidArgument extends Schema.TaggedErrorClass<InvalidArgument>()("Exchange.InvalidArgument", {
  detail: Schema.String,
}) {
  override get message() {
    return this.detail
  }
}

export class Cancelled extends Schema.TaggedErrorClass<Cancelled>()("Exchange.Cancelled", {
  detail: Schema.String,
}) {
  override get message() {
    return this.detail
  }
}

export class DependencyUnavailable extends Schema.TaggedErrorClass<DependencyUnavailable>()(
  "Exchange.DependencyUnavailable",
  { detail: Schema.String },
) {
  override get message() {
    return this.detail
  }
}

export class NotFound extends Schema.TaggedErrorClass<NotFound>()("Exchange.NotFound", {
  detail: Schema.String,
}) {
  override get message() {
    return this.detail
  }
}

export class Conflict extends Schema.TaggedErrorClass<Conflict>()("Exchange.Conflict", {
  detail: Schema.String,
}) {
  override get message() {
    return this.detail
  }
}

export class AuthorityDenied extends Schema.TaggedErrorClass<AuthorityDenied>()("Exchange.AuthorityDenied", {
  detail: Schema.String,
}) {
  override get message() {
    return this.detail
  }
}

export class PathEscape extends Schema.TaggedErrorClass<PathEscape>()("Exchange.PathEscape", {
  detail: Schema.String,
}) {
  override get message() {
    return this.detail
  }
}

export class AmbiguousCommit extends Schema.TaggedErrorClass<AmbiguousCommit>()("Exchange.AmbiguousCommit", {
  detail: Schema.String,
  targetRef: Schema.optional(Schema.String),
  resultDigest: Schema.optional(Schema.String),
}) {
  override get message() {
    return this.detail
  }
}

export type Error = InvalidArgument | Cancelled | DependencyUnavailable | NotFound | Conflict | AuthorityDenied | PathEscape | AmbiguousCommit

export * as ExchangeError from "./error"
