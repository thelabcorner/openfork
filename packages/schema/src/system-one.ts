export * as SystemOne from "./system-one"

import { Schema } from "effect"
import { optional } from "./schema"
import { Model } from "./model"
import { Provider } from "./provider"

/** Non-null TypeSafe content used by state and question instructions. */
export const Content = Schema.Union([
  Schema.String,
  Schema.Record(Schema.String, Schema.Json),
  Schema.Array(Schema.Json),
]).annotate({ identifier: "SystemOne.Content" })
export type Content = typeof Content.Type

/** Criteria descriptions may intentionally be omitted with JSON null. */
export const Criterion = Schema.NullOr(Content).annotate({ identifier: "SystemOne.Criterion" })
export type Criterion = typeof Criterion.Type

export interface NoulCriteria extends Schema.Schema.Type<typeof NoulCriteria> {}
export const NoulCriteria = Schema.Struct({
  true: Criterion.pipe(optional),
  false: Criterion.pipe(optional),
}).annotate({ identifier: "SystemOne.NoulCriteria" })

export interface NoulQuestion extends Schema.Schema.Type<typeof NoulQuestion> {}
export const NoulQuestion = Schema.Struct({
  type: Schema.Literal("noul"),
  instructions: Content,
  criteria: Schema.NullOr(NoulCriteria).pipe(optional),
}).annotate({ identifier: "SystemOne.NoulQuestion" })

export interface ChoiceQuestion extends Schema.Schema.Type<typeof ChoiceQuestion> {}
export const ChoiceQuestion = Schema.Struct({
  type: Schema.Literal("choice"),
  instructions: Content,
  criteria: Schema.Record(Schema.String, Criterion),
}).annotate({ identifier: "SystemOne.ChoiceQuestion" })

export interface ScoreQuestion extends Schema.Schema.Type<typeof ScoreQuestion> {}
export const ScoreQuestion = Schema.Struct({
  type: Schema.Literal("score"),
  instructions: Content,
  criteria: Schema.Array(Criterion),
}).annotate({ identifier: "SystemOne.ScoreQuestion" })

export const Question = Schema.Union([NoulQuestion, ChoiceQuestion, ScoreQuestion])
  .pipe(Schema.toTaggedUnion("type"))
  .annotate({ identifier: "SystemOne.Question" })
export type Question = typeof Question.Type

export const Questions = Schema.Record(Schema.String, Question).annotate({ identifier: "SystemOne.Questions" })
export type Questions = typeof Questions.Type

export interface InferInput extends Schema.Schema.Type<typeof InferInput> {}
export const InferInput = Schema.Struct({
  providerID: Provider.ID,
  modelID: Model.ID,
  accountID: Schema.String.pipe(optional),
  /**
   * Optional caller-owned routing/cache affinity key. This is not a persisted
   * OpenFork Session id and is never sent in the System One JSON payload.
   */
  affinityID: Schema.String.pipe(optional),
  state: Content,
  questions: Questions,
  timeoutMs: Schema.Int.pipe(optional),
}).annotate({ identifier: "SystemOne.InferInput" })

export interface NoulAnswer extends Schema.Schema.Type<typeof NoulAnswer> {}
export const NoulAnswer = Schema.Struct({
  type: Schema.Literal("noul"),
  noul: Schema.Finite,
}).annotate({ identifier: "SystemOne.NoulAnswer" })

export interface ChoiceAnswer extends Schema.Schema.Type<typeof ChoiceAnswer> {}
export const ChoiceAnswer = Schema.Struct({
  type: Schema.Literal("choice"),
  choice: Schema.String,
  confidence: Schema.Finite,
  probabilities: Schema.Record(Schema.String, Schema.Finite),
}).annotate({ identifier: "SystemOne.ChoiceAnswer" })

export interface ScoreAnswer extends Schema.Schema.Type<typeof ScoreAnswer> {}
export const ScoreAnswer = Schema.Struct({
  type: Schema.Literal("score"),
  score: Schema.Finite,
  confidence: Schema.Finite,
  legend: Schema.Record(Schema.String, Criterion),
  probabilities: Schema.Record(Schema.String, Schema.Finite),
}).annotate({ identifier: "SystemOne.ScoreAnswer" })

export const Answer = Schema.Union([NoulAnswer, ChoiceAnswer, ScoreAnswer])
  .pipe(Schema.toTaggedUnion("type"))
  .annotate({ identifier: "SystemOne.Answer" })
export type Answer = typeof Answer.Type

export interface Usage extends Schema.Schema.Type<typeof Usage> {}
export const Usage = Schema.Struct({
  input_tokens: Schema.Int,
  output_tokens: Schema.Int,
}).annotate({ identifier: "SystemOne.Usage" })

export interface Cost extends Schema.Schema.Type<typeof Cost> {}
export const Cost = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  total: Schema.Finite,
}).annotate({ identifier: "SystemOne.Cost" })

export interface InferResult extends Schema.Schema.Type<typeof InferResult> {}
export const InferResult = Schema.Struct({
  model: Schema.String,
  answers: Schema.Record(Schema.String, Answer),
  usage: Usage,
  /** Estimated USD cost from the selected catalog model and returned usage. */
  cost: Cost,
  /** Complete successful upstream payload, preserved without probability normalization. */
  raw: Schema.Json,
}).annotate({ identifier: "SystemOne.InferResult" })
