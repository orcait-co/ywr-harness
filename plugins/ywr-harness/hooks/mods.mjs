// The plugin's hooks-module ENTRY (Claude Mods; ADR 0117, ADR 0138): `hooks.json` names this file under
// `modules`, which takes exactly one path. It registers each module file's hooks and holds no logic of its
// own, so each file keeps its own contract and its own selftest:
//
// - `delegation-ledger.mjs`: the observe-only delegation ledger (ADR 0117, ADR 0118). Never draws.
//
// `slice-status.mjs` (ADR 0138, ADR 0139) stays in the tree but is NOT registered (ADR 0140): its status
// line is off until a new ADR redesigns it.
import { register as registerLedger } from './delegation-ledger.mjs'

export function register(on, options) {
  registerLedger(on, options)
}
