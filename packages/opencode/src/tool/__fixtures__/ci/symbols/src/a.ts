// symbols fixture: definitions + internal references (design §11)
export function greet(name: string): string {
  return `hello ${name}`
}

export class Greeter {
  name: string
  constructor(name: string) {
    this.name = name
  }
  greet(): string {
    return greet(this.name)
  }
}

export interface Shape {
  area(): number
}

export type ID = string

export const CONFIG = { max: 10 }

export function run(): string {
  const g = new Greeter("world")
  return greet(g.name)
}
