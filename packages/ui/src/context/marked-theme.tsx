import type { ThemeRegistrationResolved } from "@pierre/diffs"

const codeSyntax = {
  foreground: "var(--syntax-code-foreground, var(--text-base))",
  comment: "var(--syntax-code-comment, var(--syntax-comment))",
  regexp: "var(--syntax-code-regexp, var(--syntax-regexp))",
  keyword: "var(--syntax-code-keyword, var(--syntax-keyword))",
  string: "var(--syntax-code-string, var(--syntax-string))",
  primitive: "var(--syntax-code-primitive, var(--syntax-primitive))",
  operator: "var(--syntax-code-operator, var(--syntax-operator))",
  variable: "var(--syntax-code-variable, var(--syntax-variable))",
  property: "var(--syntax-code-property, var(--syntax-property))",
  type: "var(--syntax-code-type, var(--syntax-type))",
  constant: "var(--syntax-code-constant, var(--syntax-constant))",
  punctuation: "var(--syntax-code-punctuation, var(--syntax-punctuation))",
  object: "var(--syntax-code-object, var(--syntax-code-variable, var(--syntax-object)))",
  function: "var(--syntax-code-function, var(--syntax-function, var(--syntax-primitive)))",
  method: "var(--syntax-code-method, var(--syntax-code-function, var(--syntax-method, var(--syntax-function, var(--syntax-primitive)))))",
  parameter: "var(--syntax-code-parameter, var(--syntax-parameter, var(--syntax-variable)))",
  number: "var(--syntax-code-number, var(--syntax-code-constant, var(--syntax-number, var(--syntax-constant))))",
  decorator: "var(--syntax-code-decorator, var(--syntax-code-type, var(--syntax-decorator, var(--syntax-type))))",
  tag: "var(--syntax-code-tag, var(--syntax-code-keyword, var(--syntax-tag, var(--syntax-keyword))))",
  attribute: "var(--syntax-code-attribute, var(--syntax-code-property, var(--syntax-attribute, var(--syntax-property))))",
  builtin: "var(--syntax-code-builtin, var(--syntax-code-primitive, var(--syntax-builtin, var(--syntax-primitive))))",
  namespace: "var(--syntax-code-namespace, var(--syntax-code-type, var(--syntax-namespace, var(--syntax-type))))",
  label: "var(--syntax-code-label, var(--syntax-code-info, var(--syntax-label, var(--syntax-info))))",
  info: "var(--syntax-code-info, var(--syntax-info))",
  warning: "var(--syntax-code-warning, var(--syntax-warning))",
  critical: "var(--syntax-code-critical, var(--syntax-critical))",
} as const

export const OpenCodeTheme = {
  name: "OpenCode",
  bg: "var(--color-background-stronger)",
  fg: codeSyntax.foreground,
  colors: {
    "editor.background": "var(--color-background-stronger)",
    "editor.foreground": codeSyntax.foreground,
    "gitDecoration.addedResourceForeground": "var(--syntax-diff-add)",
    "gitDecoration.deletedResourceForeground": "var(--syntax-diff-delete)",
    "gitDecoration.modifiedResourceForeground": "var(--syntax-diff-unknown)",
    // "gitDecoration.conflictingResourceForeground": "#ffca00",
    // "gitDecoration.modifiedResourceForeground": "#1a76d4",
    // "gitDecoration.untrackedResourceForeground": "#00cab1",
    // "gitDecoration.ignoredResourceForeground": "#84848A",
    // "terminal.titleForeground": "#adadb1",
    // "terminal.titleInactiveForeground": "#84848A",
    // "terminal.background": "#141415",
    // "terminal.foreground": "#adadb1",
    // "terminal.ansiBlack": "#141415",
    // "terminal.ansiRed": "#ff2e3f",
    // "terminal.ansiGreen": "#0dbe4e",
    // "terminal.ansiYellow": "#ffca00",
    // "terminal.ansiBlue": "#008cff",
    // "terminal.ansiMagenta": "#c635e4",
    // "terminal.ansiCyan": "#08c0ef",
    // "terminal.ansiWhite": "#c6c6c8",
    // "terminal.ansiBrightBlack": "#141415",
    // "terminal.ansiBrightRed": "#ff2e3f",
    // "terminal.ansiBrightGreen": "#0dbe4e",
    // "terminal.ansiBrightYellow": "#ffca00",
    // "terminal.ansiBrightBlue": "#008cff",
    // "terminal.ansiBrightMagenta": "#c635e4",
    // "terminal.ansiBrightCyan": "#08c0ef",
    // "terminal.ansiBrightWhite": "#c6c6c8",
  },
  tokenColors: [
    {
      scope: ["comment", "punctuation.definition.comment", "string.comment"],
      settings: {
        foreground: codeSyntax.comment,
      },
    },
    {
      scope: ["entity.other.attribute-name"],
      settings: {
        foreground: codeSyntax.attribute,
      },
    },
    {
      scope: [
        "meta.decorator",
        "meta.annotation",
        "entity.name.function.decorator",
        "entity.name.type.annotation",
        "punctuation.decorator",
        "storage.type.annotation",
      ],
      settings: {
        foreground: codeSyntax.decorator,
      },
    },
    {
      scope: ["constant.numeric"],
      settings: {
        foreground: codeSyntax.number,
      },
    },
    {
      scope: ["constant.language", "constant.other", "entity.name.constant"],
      settings: {
        foreground: codeSyntax.constant,
      },
    },
    {
      scope: [
        "entity.name.type",
        "entity.name.class",
        "entity.name.struct",
        "entity.name.interface",
        "entity.name.enum",
        "support.type",
        "support.class",
      ],
      settings: {
        foreground: codeSyntax.type,
      },
    },
    {
      scope: ["meta.object.member", "variable.other.property", "variable.other.object.property"],
      settings: {
        foreground: codeSyntax.property,
      },
    },
    {
      scope: ["variable.parameter", "variable.parameter.function"],
      settings: {
        foreground: codeSyntax.parameter,
      },
    },
    {
      scope: ["entity.name.function", "entity.name.function.member", "variable.function"],
      settings: {
        foreground: codeSyntax.function,
      },
    },
    {
      scope: ["support.class.component", "support.type.primitive"],
      settings: {
        foreground: codeSyntax.type,
      },
    },
    {
      scope: "keyword",
      settings: {
        foreground: codeSyntax.keyword,
      },
    },
    {
      scope: [
        "keyword.operator",
        "storage.type.function.arrow",
        "punctuation.separator.key-value.css",
        "punctuation.separator.key-value.mapping.yaml",
      ],
      settings: {
        foreground: codeSyntax.operator,
      },
    },
    {
      scope: ["storage", "storage.type"],
      settings: {
        foreground: codeSyntax.keyword,
      },
    },
    {
      scope: ["storage.modifier.package", "storage.modifier.import", "storage.type.java"],
      settings: {
        foreground: codeSyntax.keyword,
      },
    },
    {
      scope: [
        "string",
        "punctuation.definition.string",
        "string punctuation.section.embedded source",
      ],
      settings: {
        foreground: codeSyntax.string,
      },
    },
    {
      scope: ["entity.name.tag", "punctuation.definition.tag"],
      settings: {
        foreground: codeSyntax.tag,
      },
    },
    {
      scope: ["support.function", "support.function.builtin", "support.variable.magic"],
      settings: {
        foreground: codeSyntax.builtin,
      },
    },
    {
      scope: ["support.type.object.module", "entity.name.namespace", "entity.name.module"],
      settings: {
        foreground: codeSyntax.namespace,
      },
    },
    {
      scope: ["variable.other.object"],
      settings: {
        foreground: codeSyntax.object,
      },
    },
    {
      scope: [
        "meta.property-name",
        "support.type.property-name",
        "support.type.property-name.css",
        "entity.name.tag.yaml",
      ],
      settings: {
        foreground: codeSyntax.property,
      },
    },
    {
      scope: "variable",
      settings: {
        foreground: codeSyntax.variable,
      },
    },
    {
      scope: "variable.other",
      settings: {
        foreground: codeSyntax.variable,
      },
    },
    {
      scope: [
        "invalid.broken",
        "invalid.illegal",
        "invalid.unimplemented",
        "invalid.deprecated",
        "message.error",
        "brackethighlighter.unmatched",
        "token.error-token",
      ],
      settings: {
        foreground: codeSyntax.critical,
      },
    },
    {
      scope: "carriage-return",
      settings: {
        foreground: codeSyntax.keyword,
      },
    },
    {
      scope: "string source",
      settings: {
        foreground: codeSyntax.variable,
      },
    },
    {
      scope: "string variable",
      settings: {
        foreground: codeSyntax.constant,
      },
    },
    {
      scope: [
        "source.regexp",
        "string.regexp",
        "string.regexp.character-class",
        "string.regexp constant.character.escape",
        "string.regexp source.ruby.embedded",
        "string.regexp string.regexp.arbitrary-repitition",
        "string.regexp constant.character.escape",
      ],
      settings: {
        foreground: codeSyntax.regexp,
      },
    },
    {
      scope: ["constant.character.escape", "constant.character.entity"],
      settings: {
        foreground: codeSyntax.decorator,
      },
    },
    {
      scope: ["support.constant", "support.variable", "variable.language"],
      settings: {
        foreground: codeSyntax.builtin,
      },
    },
    {
      scope: "meta.module-reference",
      settings: {
        foreground: codeSyntax.namespace,
      },
    },
    {
      scope: "punctuation.definition.list.begin.markdown",
      settings: {
        foreground: codeSyntax.punctuation,
      },
    },
    {
      scope: ["markup.heading", "markup.heading entity.name"],
      settings: {
        fontStyle: "bold",
        foreground: codeSyntax.info,
      },
    },
    {
      scope: "markup.quote",
      settings: {
        foreground: codeSyntax.info,
      },
    },
    {
      scope: "markup.italic",
      settings: {
        fontStyle: "italic",
        // foreground: "",
      },
    },
    {
      scope: "markup.bold",
      settings: {
        fontStyle: "bold",
        foreground: "var(--text-strong)",
      },
    },
    {
      scope: "markup.raw",
      settings: {
        foreground: codeSyntax.foreground,
      },
    },
    {
      scope: ["markup.inserted", "meta.diff.header.to-file", "punctuation.definition.inserted"],
      settings: {
        foreground: "var(--syntax-diff-add)",
      },
    },
    {
      scope: ["markup.deleted", "meta.diff.header.from-file", "punctuation.definition.deleted"],
      settings: {
        foreground: "var(--syntax-diff-delete)",
      },
    },
    {
      scope: ["markup.changed", "punctuation.definition.changed", "markup.ignored", "markup.untracked"],
      settings: {
        foreground: "var(--syntax-diff-unknown)",
      },
    },
    {
      scope: "meta.diff.range",
      settings: {
        fontStyle: "bold",
        foreground: codeSyntax.info,
      },
    },
    {
      scope: "meta.diff.header",
      settings: {
        foreground: codeSyntax.info,
      },
    },
    {
      scope: "meta.separator",
      settings: {
        fontStyle: "bold",
        foreground: codeSyntax.punctuation,
      },
    },
    {
      scope: "meta.output",
      settings: {
        foreground: codeSyntax.foreground,
      },
    },
    {
      scope: "meta.export.default",
      settings: {
        foreground: codeSyntax.keyword,
      },
    },
    {
      scope: [
        "brackethighlighter.tag",
        "brackethighlighter.curly",
        "brackethighlighter.round",
        "brackethighlighter.square",
        "brackethighlighter.angle",
        "brackethighlighter.quote",
      ],
      settings: {
        foreground: codeSyntax.punctuation,
      },
    },
    {
      scope: ["constant.other.reference.link", "string.other.link"],
      settings: {
        fontStyle: "underline",
        foreground: codeSyntax.info,
      },
    },
    {
      scope: "token.info-token",
      settings: {
        foreground: codeSyntax.info,
      },
    },
    {
      scope: "token.warn-token",
      settings: {
        foreground: codeSyntax.warning,
      },
    },
    {
      scope: "token.debug-token",
      settings: {
        foreground: codeSyntax.info,
      },
    },
  ],
  semanticTokenColors: {
    comment: codeSyntax.comment,
    string: codeSyntax.string,
    number: codeSyntax.number,
    regexp: codeSyntax.regexp,
    keyword: codeSyntax.keyword,
    variable: codeSyntax.variable,
    parameter: codeSyntax.parameter,
    property: codeSyntax.property,
    function: codeSyntax.function,
    method: codeSyntax.method,
    type: codeSyntax.type,
    class: codeSyntax.type,
    interface: codeSyntax.type,
    enum: codeSyntax.type,
    namespace: codeSyntax.namespace,
    decorator: codeSyntax.decorator,
    enumMember: codeSyntax.constant,
    "variable.constant": codeSyntax.constant,
    "variable.defaultLibrary": codeSyntax.builtin,
  },
} as unknown as ThemeRegistrationResolved
