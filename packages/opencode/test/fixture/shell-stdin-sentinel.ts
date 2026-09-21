// Child-process sentinel for shell stdin transport. Emit a byte-level digest,
// not decoded text, so newline/encoding changes cannot hide behind a successful
// exit code or a forgiving decoder.
const input = new Uint8Array(await new Response(Bun.stdin.stream()).arrayBuffer())
process.stdout.write(Buffer.from(input).toString("hex"))
