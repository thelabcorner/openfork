// Shape mirror — canonical source is ./contracts (coordinator adjudication:
// "contracts.ts is canonical for the desktop side, types.ts either mirrors it
// or is deleted"). This file re-exports the full contract surface so the
// engine internals (arbitration/control-session/guest/errors/scripts-resolve)
// keep a stable import path. NO divergent shapes live here.

export * from "./contracts"
