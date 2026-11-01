// The plugin's hooks-module ENTRY (Claude Mods; ywr-harness ADR 0117, ywr-harness ADR 0138): `hooks.json` names this file under
// `modules`, which takes exactly one path. It registers each module file's hooks and holds no logic of its
// own, so each file keeps its own contract and its own selftest:
//
// - `delegation-ledger.mjs`: the observe-only delegation ledger (ywr-harness ADR 0117, ywr-harness ADR 0118). Never draws.
// - `prerequisites.mjs`: the pwsh / node / python check, its band and `/ywr-harness:setup` (ywr-harness ADR 0142).
// - `decision-prompts.mjs`: the `/ywr-harness:auto` switch and its stage prompts (ywr-harness ADR 0174, ywr-harness ADR 0175).
//
// `slice-status.mjs` (ywr-harness ADR 0138, ywr-harness ADR 0139) stays in the tree but is NOT registered (ywr-harness ADR 0140): its status
// line is off until a new ADR redesigns it.
import { register as registerLedger } from './delegation-ledger.mjs'
import { register as registerPrerequisites } from './prerequisites.mjs'
import { register as registerDecisionPrompts } from './decision-prompts.mjs'

export function register(on, options) {
  registerLedger(on, options)
  registerPrerequisites(on, options)
  registerDecisionPrompts(on, options)
}
