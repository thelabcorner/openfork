import { describe, expect, test } from "bun:test"
import type { PermissionRequest, QuestionRequest, Session } from "@opencode-ai/sdk/v2/client"
import { sessionPermissionRequest, sessionQuestionRequest } from "./session-request-tree"

const permission = (id: string) => ({ id } as PermissionRequest)
const question = (id: string) => ({ id } as QuestionRequest)

describe("session request tree traversal", () => {
  test("preserves breadth-first root, sibling, descendant precedence", () => {
    const children = new Map([
      ["root", ["a", "b"]],
      ["a", ["a1"]],
      ["b", ["b1"]],
    ])
    const requests = {
      root: [permission("root")],
      a: [permission("a")],
      b: [permission("b")],
      a1: [permission("a1")],
    }
    expect(sessionPermissionRequest(children, requests, "root")?.id).toBe("root")
    expect(sessionPermissionRequest(children, requests, "root", (item) => item.id !== "root")?.id).toBe("a")
    expect(sessionPermissionRequest(children, requests, "root", (item) => !["root", "a"].includes(item.id))?.id).toBe("b")
    expect(sessionPermissionRequest(children, requests, "root", (item) => item.id === "a1")?.id).toBe("a1")
  })

  test("stops immediately when the root has a matching request", () => {
    let readCount = 0
    const children = new Map([["root", ["child"]]])
    const originalGet = children.get.bind(children)
    children.get = (id: string) => {
      readCount++
      return originalGet(id)
    }
    expect(sessionQuestionRequest(children, { root: [question("ready")] }, "root")?.id).toBe("ready")
    expect(readCount).toBe(0)
  })

  test("handles cycles, excluded requests and unknown sessions", () => {
    const children = new Map([["root", ["child"]], ["child", ["root"]]])
    expect(sessionQuestionRequest(children, { child: [question("child")] }, "root")?.id).toBe("child")
    expect(sessionQuestionRequest(children, { child: [question("child")] }, "root", () => false)).toBeUndefined()
    expect(sessionQuestionRequest(children, { child: [question("child")] }, undefined)).toBeUndefined()
  })

  test("keeps array-input parent indexing compatible with map input", () => {
    const sessions = [
      { id: "root" },
      { id: "child", parentID: "root" },
    ] as Session[]
    const requests = { child: [permission("child")] }
    expect(sessionPermissionRequest(sessions, requests, "root")?.id).toBe("child")
    expect(sessionPermissionRequest(new Map([["root", ["child"]]]), requests, "root")?.id).toBe("child")
  })
})