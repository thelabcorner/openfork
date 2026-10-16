/**
 * Loss-averse Goal intent preprocessing. These are lexical *evidence* helpers,
 * not an authorization source: the Goal creation policy still requires trusted
 * current human provenance and a concrete creation directive.
 *
 * Preserve discourse boundaries rather than flattening the full message:
 * "How does Goal Mode work? Now create a Goal" contains two different acts.
 * Code samples, Markdown quotes and quoted strings are data, not directives.
 * No network/model inference, filesystem, or mutation.
 */
export function clauses(value: string | undefined): readonly string[] {
  const text = (value ?? "")
    .replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g, " ")
    .replace(/^\s*>[^\n]*(?:\n|$)/gm, "\n")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/["“][^"”\n]{0,512}["”]/g, " ")
    .replace(/(^|[\s(])'[^'\n]{1,256}'(?=[\s).!?]|$)/gm, "$1 ")
    .replace(/(^|[\s([{'"“])@goal\b/gi, "$1goal")
    // Remove bounded spoken fillers only after masking quotes/code. Never
    // remove negators or content words such as "like" indiscriminately.
    .replace(/\b(?:um+|uh+|erm|you\s+know)\b\s*,?\s*/gi, " ")
    .replace(/^\s*(?:okay|ok|hey|so|well|i\s+mean)\s*,\s*/gi, "")
    .replace(/,\s*(?=(?:a|an|the)\s+(?:(?:new|durable|tracked|persistent|draft)\s+)?goal\b)/gi, " ")
    .replace(/,\s*(?=(?:need|want|don['’]?t|do\s+not)\b)/gi, " ")
    .replace(/\bgoal\s+mode,\s+please\b/gi, "goal mode please")

  return text
    .split(/[.!?;\n]+|,?\s+but\s+(?=(?:please|do|don['’]?t|never|create|make|set|start|activate|launch|hold|wait)\b)/i)
    .map((segment) => segment.replace(/\s+/g, " ").trim())
    .filter(Boolean)
}

const informational = [
  /^\s*(?:how|what|why|when|where|which|who)\b/i,
  /^\s*(?:should|can|could|would|do|did|will)\s+(?:i|we)\b/i,
  /^\s*shouldn['’]?t\s+we\b/i,
  /^\s*(?:is|are|does)\b/i,
  /^\s*(?:please\s+)?(?:explain|describe|define|compare|tell\s+me\s+(?:about|how|what|why|when))\b/i,
  /^\s*(?:could|can|would|will)\s+you\s+(?:please\s+)?(?:explain|show|describe|teach|tell|walk\s+me\s+through)\b/i,
  /^\s*(?:i|we)\s+(?:want|need|would\s+like|['’]d\s+like)\s+to\s+(?:learn|understand|know|discuss|hear)\b/i,
  /^\s*(?:let['’]?s|please)\s+(?:think\s+about|talk\s+about|discuss|consider|compare)\b/i,
  /^\s*(?:please\s+)?(?:write|draft|summarize|quote)\b[^.!?\n]{0,96}\b(?:guide|phrase|documentation|docs?|example|tutorial|article|text)\b/i,
  /^\s*(?:here\s+is|here['’]?s|the\s+docs?\s+(?:say|says)|the\s+documentation\s+says|(?:someone|he|she|they)\s+(?:said|says|told\s+me))\b/i,
  /^\s*(?:if|when|suppose|assuming|imagine|for\s+example|for\s+instance|e\.g\.)\b/i,
  /^\s*(?:would|could|can)\s+(?:a|the)\s+goal\b/i,
  /^\s*(?:i|we)\s+(?:can|could|might|may)\s+(?:create|make|start|use|enable|run)\b/i,
  /^\s*(?:i(?:['’]m|\s+am)|we(?:['’]re|\s+are))\s+(?:designing|planning|documenting|writing)\b/i,
  /^\s*(?:please\s+)?(?:write|build|implement|test|review|document)\b[^.!?\n]{0,96}\b(?:function|script|tests?|button|command|documentation|guide|label)\b/i,
  /^\s*(?:please\s+)?(?:give\s+me|show\s+me|list)\b[^.!?\n]{0,64}\bexamples?\b/i,
  /^\s*(?:the\s+)?(?:meeting\s+agenda|documentation|tutorial|reference|manual)\s+(?:says?|reads?|mentions?)\b/i,
]

export function isExplanatory(clause: string) {
  // "How about using Goal Mode" is a suggestion; "how does..." is a question.
  if (/^\s*(?:how\s+about|why\s+don['’]?t\s+you|would\s+you\s+mind)\b/i.test(clause)) return false
  return informational.some((pattern) => pattern.test(clause))
}
