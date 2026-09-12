const ASCII_CANONICAL = (() => {
  const table = new Uint16Array(128)
  for (let code = 0; code < table.length; code++) {
    if (code === 32 || (code >= 9 && code <= 13)) table[code] = 32
    else if (code >= 65 && code <= 90) table[code] = code + 32
    else table[code] = code
  }
  return table
})()

export class Canonicalizer {
  private previousWasSpace = false

  reset(): void {
    this.previousWasSpace = false
  }

  push(code: number): number {
    if (code < 128) code = ASCII_CANONICAL[code]!
    if (code === 32) {
      if (this.previousWasSpace) return -1
      this.previousWasSpace = true
      return 32
    }
    this.previousWasSpace = false
    return code
  }
}
