// The plugin's hooks-module ENTRY (Claude Mods; ADR 0117, ADR 0138): `hooks.json` names this file under
// `modules`, which takes exactly one path. It registers each module file's hooks and holds no logic of its
// own, so each file keeps its own contract and its own selftest:
//
// - `delegation-ledger.mjs`: the observe-only delegation ledger (ADR 0117, ADR 0118). Never draws.
// - `slice-status.mjs`: the observe-only slice status line (ADR 0138). Draws through `$.ui.status` alone.
import { register as registerLedger } from './delegation-ledger.mjs'
import { register as registerSliceStatus } from './slice-status.mjs'

export function register(on, options) {
  registerLedger(on, options)
  registerSliceStatus(on, options)
}
