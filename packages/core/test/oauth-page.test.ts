import { describe, expect, test } from "bun:test"
import { OauthCallbackPage } from "../src/oauth/page"

describe("OauthCallbackPage", () => {
  test("uses OpenFork branding in callback copy and wordmark", () => {
    const success = OauthCallbackPage.success({ provider: "ChatGPT", autoClose: false })
    const failure = OauthCallbackPage.error("nope", { provider: "ChatGPT" })

    expect(success).toContain("OpenFork is now connected to ChatGPT.")
    expect(success).toContain("aria-label=\"OpenFork\"")
    expect(success).toContain("Authorization successful · OpenFork")
    expect(failure).toContain("OpenFork couldn't finish connecting to ChatGPT.")
    expect(failure).toContain("try again from OpenFork")
    expect(success).not.toContain("aria-label=\"OpenCode\"")
    expect(failure).not.toContain("try again from OpenCode")
  })

  test("escapes bootstrap options embedded in the inline script", () => {
    const html = OauthCallbackPage.bootstrap({
      provider: `xAI</script><script>alert("provider")</script>`,
      tokenPath: `/token</script><script>alert("path")</script>`,
    })

    expect(html.match(/<\/script>/g)).toHaveLength(1)
    expect(html).toContain(`xAI\\u003c/script>\\u003cscript>alert(\\\"provider\\\")\\u003c/script>`)
    expect(html).toContain(`/token\\u003c/script>\\u003cscript>alert(\\\"path\\\")\\u003c/script>`)
  })
})
