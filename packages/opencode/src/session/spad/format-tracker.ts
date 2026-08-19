export class FormatTracker {
  private backticks = 0
  private fenced = false

  reset(): void {
    this.backticks = 0
    this.fenced = false
  }

  push(code: number): void {
    if (code === 96) {
      this.backticks++
      if (this.backticks === 3) {
        this.fenced = !this.fenced
        this.backticks = 0
      }
      return
    }
    this.backticks = 0
  }

  get insideCodeFence(): boolean {
    return this.fenced
  }
}
