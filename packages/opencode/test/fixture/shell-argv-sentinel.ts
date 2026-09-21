// Executed as a child by shell transport tests. Keep this intentionally tiny:
// stdout must represent only the argv bytes that crossed the shell/native
// boundary so a successful exit cannot hide quote or backslash corruption.
process.stdout.write(JSON.stringify(process.argv.slice(2)))
