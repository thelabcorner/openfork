// symbols-js fixture: JS with require() + dynamic import (design §11)
const { helper } = require("./dep")
const lazy = import("./lazy")

export function run() {
  return helper() + lazy
}

export const VALUE = "constant"
