// The Askaway state folder contract (SPEC.md, "State folder"). The CLI writes questions and delivery
// markers; this mod reads them and writes answers only. Field names follow the spec.

// The urgency grade of a question's Urgency line: its colour (look.ts URGENCY_COLOR). Optional in q/<id>.json; absent, the
// grade is read from the words of `urgency` (model.ts urgencyGradeOf).
export type UrgencyGrade = 'low' | 'medium' | 'high'

export type AnswerBy = 'panel' | 'accept_recommended' | 'accept_all' | 'cli' | 'agent'

// `tradeoff` is the one-line cost of choosing this option; absent or blank means no tradeoff line. `does` (what happens
// if it is chosen), `pros` and `cons` are the three lines under the option; an entry from before they existed has none.
export type QuestionOption = {
  key: string
  label: string
  fit: number | null
  tradeoff?: string
  does?: string
  pros?: string
  cons?: string
}

// q/<id>.json, as this mod reads it after validation (see hooks/model.ts parseQuestion). An optional text field
// is undefined when the file leaves it null or blank.
export type Question = {
  id: string
  ts: number
  title: string
  question: string
  what?: string
  problem?: string
  context?: string
  analogy?: string
  why?: string
  how?: string
  gains?: string
  losses?: string
  urgency?: string
  urgency_level?: UrgencyGrade
  undo?: string
  project: string
  session: string | null
  session_title?: string
  // The Claude Desktop root session of the asking session's family ("local_<uuid>") and that root's title. Absent on
  // questions filed before they existed; the tree then groups by project.
  family?: string
  family_title?: string
  options: QuestionOption[]
  recommended: string
  risk: string
}

// a/<id>.json: the first writer wins. This mod writes one only through `askaway.py answer` (its create-once link), never
// directly, and never overwrites one. Legacy key "other" carries its free text in `text`.
export type Answer = {
  id: string
  key: string
  by: AnswerBy
  ts: number
  text?: string
  session?: string
  who?: string
}

// d/<id>.json: the delivery marker. `expired` is true when no session can read the answer; `reason` says why. `ts` is when
// the answer was delivered (the marker written by askaway.py's wait and answer paths); an expired marker carries a ts, which the History line does not show.
export type DeliveryReason = 'session-ended' | 'ttl'

export type Delivery = {
  id: string
  expired: boolean
  reason?: DeliveryReason
  ts?: number
}

// d/<id>.json written by this mod when it hands the answer to its own session's prompt: `via` is "prompt".
export type PromptMarker = {
  id: string
  session: string
  ts: number
  via: 'prompt'
}

// Everything the mod has read from the state folder at the last poll.
export type Board = {
  questions: Question[]
  answers: Answer[]
  delivered: Delivery[]
}

// The drawn state the hooks module reads and writes (see hooks/register.tsx), named in the contract.
// `wizard` mirrors hooks/wizard.ts `Wizard` (see the wizard field below).
// The shape is written out here so the contract stands on its own.
declare module 'claude-code' {
  interface PluginState {
    askaway: {
      board: Board
      away: boolean
      tick: number
      seen: { isPrimed: boolean; ids: string[] }
      // Ids of answers whose History line the person cleared (delivered, ended or expired lines; the plugin's store keeps them under "cleared").
      cleared: string[]
      // The poll time at which the pane first saw each delivery marker (0 when it was there before the session).
      deliveredAt: Record<string, number>
      // The answered cards still fading out (250 ms after the press): question id → press time. Drawn dim, then gone.
      leaving: Record<string, number>
      // Whether this session is inside a model turn of its own (turn.start to turn.complete; subagent turns excluded).
      turn: { isBusy: boolean }
      // Ids of open questions whose asking session has ended (`list --open` marks them `ended`): their card shows a notice.
      ended: string[]
      // The answerer name (store key "who"): null before it was asked, '' after a skip, else the name.
      who: string | null
      // Quiet mode (store key "quiet", /askaway quiet on|off): no toast per new question and no fade after an answer.
      quiet: boolean
      // The language in use: the stored choice, else the environment's. Set at session start and by /askaway lang.
      lang: 'en' | 'pt'
      // The theme family the details block fills by (look.ts themeFamilyOf): "light" for a theme name starting with
      // "light", "dark" for one starting with "dark" or no theme row, "unknown" for any other value (auto, custom:<slug>),
      // which draws no fill. Read from the engine's theme row at session start, and written on each config.set of it.
      theme: 'dark' | 'light' | 'unknown'
      // The question wizard (hooks/wizard.ts `Wizard`): the group on screen, the step, the question on screen and the picks
      // by question id. An Other pick carries its free text in `text`.
      wizard: {
        groupKey: string | null
        step: number
        questionId: string | null
        picks: Record<string, { key: string; text?: string }>
      }
    }
  }
}
