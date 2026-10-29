// The plugin's hooks-module ENTRY (Claude Mods; ADR 0117, ADR 0138): `hooks.json` names this file under
// `modules`, which takes exactly one path. It registers each module file's hooks and holds no logic of its
// own, so each file keeps its own contract and its own selftest:
//
// - `delegation-ledger.mjs`: the observe-only delegation ledger (ADR 0117, ADR 0118). Never draws.
// - `prerequisites.mjs`: the pwsh / node / python check, its band and `/ywr-harness:setup` (ADR 0142).
// - `decision-prompts.mjs`: the `/ywr-harness:auto` switch and its stage prompts (ADR 0174, ADR 0175).
//
// `slice-status.mjs` (ADR 0138, ADR 0139) stays in the tree but is NOT registered (ADR 0140): its status
// line is off until a new ADR redesigns it.
import { register as registerLedger } from './delegation-ledger.mjs'
import { register as registerPrerequisites } from './prerequisites.mjs'
import { register as registerDecisionPrompts } from './decision-prompts.mjs'

export function register(on, options) {
  registerLedger(on, options)
  registerPrerequisites(on, options)
  registerDecisionPrompts(on, options)
}
