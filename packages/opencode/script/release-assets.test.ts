import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import {
  CLI_TARGETS,
  DESKTOP_REQUIREMENTS,
  MANIFEST_NAME,
  bunCompileTarget,
  buildManifest,
  checkReleaseInventory,
  cliArchiveName,
  cliTargetSlug,
  expectedCliAssets,
  parseManifest,
  parseReleaseClass,
  planRelease,
  renderManifest,
  satisfiesDesktopInstaller,
  satisfiesDesktopRequirement,
  verifyManifest,
  verifyManifestFile,
} from "./release-assets.ts"

const temps: string[] = []

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "openfork-release-assets-"))
  temps.push(dir)
  return dir
}

afterEach(async () => {
  while (temps.length) {
    const dir = temps.pop()!
    await rm(dir, { recursive: true, force: true })
  }
})

function sha256Of(contents: string): string {
  return new Bun.CryptoHasher("sha256").update(contents).digest("hex")
}

const MAC_X64 = "openfork-desktop-mac-x64.dmg"
const MAC_X64_ZIP = "openfork-desktop-mac-x64.zip"
const MAC_ARM_DMG = "openfork-desktop-mac-arm64.dmg"
const MAC_ARM_ZIP = "openfork-desktop-mac-arm64.zip"
const WIN_EXE = "openfork-desktop-win-x64.exe"
const LINUX_APPIMAGE = "openfork-desktop-linux-x64.AppImage"
const LINUX_DEB = "openfork-desktop-linux-x64.deb"
const LINUX_RPM = "openfork-desktop-linux-x64.rpm"

const COMPLETE_DESKTOP = [MAC_X64, MAC_X64_ZIP, MAC_ARM_DMG, MAC_ARM_ZIP, WIN_EXE, LINUX_APPIMAGE, LINUX_DEB, LINUX_RPM]

describe("release class", () => {
  test("parses only the two documented classes and preserves intentional cli-only default", () => {
    expect(parseReleaseClass(undefined)).toBe("cli-only")
    expect(parseReleaseClass("")).toBe("cli-only")
    expect(parseReleaseClass("desktop")).toBe("desktop")
    expect(parseReleaseClass("CLI-Only")).toBe("cli-only")
    expect(() => parseReleaseClass("nightly")).toThrow(/unknown release class/)
  })

  test("cli-only class expects no desktop platform", () => {
    const plan = planRelease("cli-only")
    expect(plan.releaseClass).toBe("cli-only")
    expect(plan.desktopLabels).toEqual([])
    expect(plan.requiredDesktop).toEqual([])
  })

  test("desktop class refuses an unknown or empty platform set", () => {
    expect(() => planRelease("desktop", ["Windows on ARM"])).toThrow(/unknown desktop platform/)
    expect(() => planRelease("desktop", [])).not.toThrow()
    expect(planRelease("desktop").desktopLabels).toEqual(DESKTOP_REQUIREMENTS.map((r) => r.label))
  })
})

describe("cli inventory", () => {
  test("expected inventory matches the build matrix exactly", () => {
    const built = CLI_TARGETS.map((target) => cliArchiveName(target)).sort()
    expect(expectedCliAssets()).toEqual(built)
    expect(built).toEqual([
      "openfork-darwin-arm64.zip",
      "openfork-darwin-x64-baseline.zip",
      "openfork-darwin-x64.zip",
      "openfork-linux-arm64-musl.tar.gz",
      "openfork-linux-arm64.tar.gz",
      // `baseline` is the avx2 modifier and `musl` the ABI, so the baseline-musl
      // leg is `linux-x64-baseline-musl` -- not `linux-x64-musl-baseline`.
      "openfork-linux-x64-baseline-musl.tar.gz",
      "openfork-linux-x64-baseline.tar.gz",
      "openfork-linux-x64-musl.tar.gz",
      "openfork-linux-x64.tar.gz",
      "openfork-windows-arm64.zip",
      "openfork-windows-x64-baseline.zip",
      "openfork-windows-x64.zip",
    ])
  })

  test("target slugs and bun compile targets stay derived from one definition", () => {
    expect(cliTargetSlug({ os: "win32", arch: "x64" })).toBe("openfork-windows-x64")
    expect(cliTargetSlug({ os: "linux", arch: "x64", abi: "musl", avx2: false })).toBe(
      "openfork-linux-x64-baseline-musl",
    )
    expect(bunCompileTarget({ os: "win32", arch: "x64", avx2: false })).toBe("bun-windows-x64-baseline")
    expect(bunCompileTarget({ os: "darwin", arch: "arm64" })).toBe("bun-darwin-arm64")
  })
})

describe("desktop requirement matching", () => {
  test("per-extension matching is not satisfied by another allowed extension", () => {
    const linux = DESKTOP_REQUIREMENTS.find((r) => r.label === "Linux x64")!
    // The platform matches for both, but only AppImage is an AppImage.
    expect(satisfiesDesktopRequirement(LINUX_DEB, linux)).toBe(true)
    expect(satisfiesDesktopInstaller(LINUX_DEB, linux, "AppImage")).toBe(false)
    expect(satisfiesDesktopInstaller(LINUX_DEB, linux, "deb")).toBe(true)
    expect(satisfiesDesktopInstaller(LINUX_DEB, linux, "rpm")).toBe(false)
    expect(satisfiesDesktopInstaller(LINUX_RPM, linux, "rpm")).toBe(true)
  })

  test("matches installer names regardless of the electron-builder os token spelling", () => {
    const windows = DESKTOP_REQUIREMENTS.find((r) => r.label === "Windows x64")!
    expect(satisfiesDesktopRequirement(WIN_EXE, windows)).toBe(true)
    expect(satisfiesDesktopRequirement("openfork-desktop-win32-x64.exe", windows)).toBe(true)

    const linux = DESKTOP_REQUIREMENTS.find((r) => r.label === "Linux x64")!
    expect(satisfiesDesktopRequirement(LINUX_APPIMAGE, linux)).toBe(true)
    expect(satisfiesDesktopRequirement(LINUX_DEB, linux)).toBe(true)
    // deb alone does not satisfy a linux-x64 installer requirement.
    expect(satisfiesDesktopRequirement(LINUX_DEB, DESKTOP_REQUIREMENTS.find((r) => r.label === "macOS x64")!)).toBe(
      false,
    )
  })

  test("does not treat CLI archives or updater metadata as desktop installers", () => {
    const windows = DESKTOP_REQUIREMENTS.find((r) => r.label === "Windows x64")!
    expect(satisfiesDesktopRequirement("openfork-windows-x64.zip", windows)).toBe(false)
    expect(satisfiesDesktopRequirement("openfork-desktop-win-x64.exe.blockmap", windows)).toBe(false)
  })
})

describe("cli-only release inventory", () => {
  test("a complete CLI payload is valid", () => {
    const report = checkReleaseInventory(planRelease("cli-only"), expectedCliAssets())
    expect(report.ok).toBe(true)
    expect(report.findings).toEqual([])
  })

  test("a missing CLI archive fails closed", () => {
    const assets = expectedCliAssets().filter((name) => name !== "openfork-linux-x64-musl.tar.gz")
    const report = checkReleaseInventory(planRelease("cli-only"), assets)
    expect(report.ok).toBe(false)
    expect(report.missingCli).toEqual(["openfork-linux-x64-musl.tar.gz"])
    expect(report.findings.some((f) => f.code === "missing-cli-asset" && f.severity === "error")).toBe(true)
  })

  test("an empty release fails closed", () => {
    const report = checkReleaseInventory(planRelease("cli-only"), [])
    expect(report.ok).toBe(false)
    expect(report.findings.map((f) => f.code)).toContain("empty-release")
  })

  test("best-effort desktop extras stay valid but a partial desktop set is reported", () => {
    const partial = checkReleaseInventory(planRelease("cli-only"), [...expectedCliAssets(), MAC_X64])
    expect(partial.ok).toBe(true)
    expect(partial.findings.map((f) => f.code)).toEqual(["partial-desktop-extras"])

    const complete = checkReleaseInventory(planRelease("cli-only"), [...expectedCliAssets(), ...COMPLETE_DESKTOP])
    expect(complete.ok).toBe(true)
    expect(complete.findings).toEqual([])
  })
})

describe("desktop release inventory", () => {
  test("a complete desktop payload is valid", () => {
    const report = checkReleaseInventory(planRelease("desktop"), [...expectedCliAssets(), ...COMPLETE_DESKTOP])
    expect(report.ok).toBe(true)
    expect(report.findings).toEqual([])
  })

  test("fails closed when a platform leg uploaded nothing", () => {
    // The desktop upload step exits 0 when a leg produced no artifact, so a
    // successful desktop job can still publish an incomplete release.
    const assets = [...expectedCliAssets(), ...COMPLETE_DESKTOP.filter((n) => !n.startsWith("openfork-desktop-win"))]
    const report = checkReleaseInventory(planRelease("desktop"), assets)
    expect(report.ok).toBe(false)
    expect(report.missingDesktop).toEqual(["Windows x64 installer is absent: openfork-desktop-*.exe"])
    expect(report.findings.some((f) => f.code === "missing-desktop-asset")).toBe(true)
  })

  test("fails closed when a single required installer extension is missing", () => {
    const assets = [...expectedCliAssets(), ...COMPLETE_DESKTOP.filter((name) => name !== LINUX_RPM)]
    const report = checkReleaseInventory(planRelease("desktop"), assets)
    expect(report.ok).toBe(false)
    expect(report.missingDesktop).toEqual(["Linux x64 installer is absent: openfork-desktop-*.rpm"])
  })

  test("a narrower declared platform set is honored and unknown legs are warned", () => {
    const plan = planRelease("desktop", ["macOS arm64", "Linux x64"])
    const assets = [...expectedCliAssets(), MAC_ARM_DMG, MAC_ARM_ZIP, LINUX_APPIMAGE, LINUX_DEB, LINUX_RPM]
    const report = checkReleaseInventory(plan, assets)
    expect(report.ok).toBe(true)
    expect(report.findings).toEqual([])

    const extra = checkReleaseInventory(plan, [...assets, WIN_EXE])
    expect(extra.ok).toBe(true)
    expect(extra.findings.map((f) => f.code)).toEqual(["undeclared-desktop-asset"])
  })
})

describe("release workflow wiring", () => {
  const workflowUrl = new URL("../../../.github/workflows/dev-pre-release.yml", import.meta.url)
  const workflow = async () => await Bun.file(workflowUrl).text()

  test("the release workflow wires the inventory gate, manifest, and verification before undraft", async () => {
    const text = await workflow()
    // A cli-only default preserves the historical dev pre-release shape, and
    // desktop must be an explicit opt-in promise rather than a silent upgrade.
    expect(text).toContain("release_class:")
    expect(text).toMatch(/default:\s*cli-only/)

    const check = text.indexOf("release-assets.ts check")
    const manifest = text.indexOf("release-assets.ts manifest --dir")
    // Two distinct verify points: one before publication (so a corrupt upload
    // never becomes visible) and one after (so what consumers download is
    // proven to match the same manifest).
    const preverify = text.indexOf("release-assets.ts verify --dir release-verify")
    // Anchor on the real publish command, not the explanatory permissions
    // comment that also spells `--draft=false`.
    const undraft = text.indexOf('gh release edit "${{ needs.notes.outputs.tag }}"')
    const postverify = text.indexOf("release-assets.ts verify --dir release-postverify")
    for (const [index, what] of [
      [check, "check"],
      [manifest, "manifest"],
      [preverify, "pre-undraft verify"],
      [undraft, "undraft"],
      [postverify, "post-publish verify"],
    ] as const)
      expect(index).toBeGreaterThan(-1)
    // Order is load-bearing: publication happens only after the pre-gate, and
    // post-publish verification is not optional bookkeeping.
    expect(check).toBeLessThan(manifest)
    expect(manifest).toBeLessThan(preverify)
    expect(preverify).toBeLessThan(undraft)
    expect(undraft).toBeLessThan(postverify)
    // Separate fresh download directories, so the post-publish check cannot pass
    // by reusing pre-publish bytes.
    expect(preverify).not.toBe(postverify)
  })

  test("the integrity gate runs in the release job and cannot be skipped", async () => {
    const text = await workflow()
    const releaseJob = text.slice(text.indexOf("\n  release:\n"))
    expect(releaseJob).toContain("gh release download")
    expect(releaseJob).toContain("gh release view")
    // The gate must fail the run, not merely warn: it leaves the release draft.
    expect(releaseJob).toContain("stays a draft")
    expect(releaseJob).toContain("release-assets.ts")
    expect(releaseJob).not.toMatch(/continue-on-error:\s*true/)
  })
})

describe("sha256 manifest", () => {
  async function seed(dir: string, files: Record<string, string>): Promise<void> {
    for (const [name, contents] of Object.entries(files)) {
      const target = path.join(dir, ...name.split("/"))
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, contents)
    }
  }

  test("is deterministic, sorted, and excludes the manifest itself", async () => {
    const dir = await tempDir()
    await seed(dir, { "b.txt": "bbb", "nested/a.txt": "aaa", "a.zip": "zzz" })

    const first = await buildManifest(dir)
    const second = await buildManifest(dir)
    expect(first).toEqual(second)
    expect(first.map((entry) => entry.name)).toEqual(["a.zip", "b.txt", "nested/a.txt"])

    const rendered = renderManifest(first)
    expect(rendered.endsWith("\n")).toBe(true)
    expect(rendered).toContain(`${first[0].sha256}  a.zip`)
    expect(rendered.includes(MANIFEST_NAME)).toBe(false)
    expect(first[0].sha256).toBe(sha256Of("zzz"))
    expect(parseManifest(rendered).map((entry) => entry.name)).toEqual(["a.zip", "b.txt", "nested/a.txt"])
  })

  test("verifies a matching download directory", async () => {
    const dir = await tempDir()
    await seed(dir, { "a.zip": "alpha", "b.txt": "beta" })
    const entries = await buildManifest(dir)
    expect(await verifyManifest(dir, entries)).toEqual([])
  })

  test("detects a checksum mismatch after re-download", async () => {
    const dir = await tempDir()
    await seed(dir, { "a.zip": "alpha", "b.txt": "beta" })
    const entries = await buildManifest(dir)

    // Simulate a truncated/corrupted published asset.
    await writeFile(path.join(dir, "b.txt"), "corrupted")
    const findings = await verifyManifest(dir, entries)
    expect(findings).toHaveLength(1)
    expect(findings[0].code).toBe("checksum-mismatch")
    expect(findings[0].detail).toContain("b.txt")
  })

  test("detects missing and unlisted files", async () => {
    const dir = await tempDir()
    await seed(dir, { "a.zip": "alpha", "b.txt": "beta" })
    const entries = await buildManifest(dir)

    await rm(path.join(dir, "b.txt"))
    await writeFile(path.join(dir, "surprise.txt"), "unexpected")

    const findings = await verifyManifest(dir, entries)
    expect(findings.map((f) => f.code).sort()).toEqual(["missing-file", "unlisted-file"])
  })

  test("reports a missing or malformed manifest instead of silently passing", async () => {
    const dir = await tempDir()
    await seed(dir, { "a.zip": "alpha" })
    expect((await verifyManifestFile(dir, path.join(dir, MANIFEST_NAME)))[0].code).toBe("manifest-missing")

    await writeFile(path.join(dir, MANIFEST_NAME), "not-a-manifest-line\n")
    const malformed = await verifyManifestFile(dir, path.join(dir, MANIFEST_NAME))
    expect(malformed).toHaveLength(1)
    expect(malformed[0].code).toBe("malformed-manifest")
  })

  test("rejects a manifest line that is not a sha256sum record", () => {
    expect(() => parseManifest("deadbeef  a.zip\n")).toThrow(/malformed SHA256 manifest line/)
  })

  test("the manifest covers the same inventory the release check requires", async () => {
    const dir = await tempDir()
    const assets = [...expectedCliAssets(), ...COMPLETE_DESKTOP]
    await seed(dir, Object.fromEntries(assets.map((name, index) => [name, `payload-${index}`])))

    const entries = await buildManifest(dir)
    expect(entries.map((entry) => entry.name)).toEqual([...assets].sort())

    const report = checkReleaseInventory(
      planRelease("desktop"),
      entries.map((entry) => entry.name),
    )
    expect(report.ok).toBe(true)
    expect(await verifyManifest(dir, entries)).toEqual([])
  })
})
