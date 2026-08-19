export class Canonicalizer {
  private previousWasSpace = false

  reset(): void {
    this.previousWasSpace = false
  }

  push(code: number): number {
    const whitespace = code === 32 || (code >= 9 && code <= 13)
    if (whitespace) {
      if (this.previousWasSpace) return -1
      this.previousWasSpace = true
      return 32
    }
    this.previousWasSpace = false
    if (code >= 65 && code <= 90) code += 32
    return code
  }
}
