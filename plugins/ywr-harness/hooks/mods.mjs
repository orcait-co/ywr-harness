// Hooks-module entry (ywr-harness ADR 0117/0138). `hooks.json` names this file under `modules`, which
// takes exactly one path. It registers each module file's hooks and holds no logic, so each file keeps
// its own contract and selftest:
// - `delegation-ledger.mjs`: the observe-only delegation ledger (ywr-harness ADR 0117/0118).
// - `prerequisites.mjs`: the node check, its band and `/ywr-harness:setup` (ywr-harness ADR 0142).
// - `decision-prompts.mjs`: the `/ywr-harness:auto` switch and its stage prompts (ywr-harness ADR 0174/0175).
// `slice-status.mjs` is not registered (ywr-harness ADR 0140).
import { register as registerLedger } from './delegation-ledger.mjs'
import { register as registerPrerequisites } from './prerequisites.mjs'
import { register as registerDecisionPrompts } from './decision-prompts.mjs'

export function register(on, options) {
  registerLedger(on, options)
  registerPrerequisites(on, options)
  registerDecisionPrompts(on, options)
}
