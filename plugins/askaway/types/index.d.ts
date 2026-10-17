// The Askaway state folder contract (SPEC.md, "State folder"). The CLI writes questions and delivery
// markers; this mod reads them and writes answers only. Field names follow the spec.

export type AnswerBy = 'panel' | 'accept_recommended' | 'accept_all' | 'cli'

// `tradeoff` is the one-line cost of choosing this option; absent or blank means no tradeoff line.
export type QuestionOption = {
  key: string
  label: string
  fit: number | null
  tradeoff?: string
}

// q/<id>.json, as this mod reads it after validation (see hooks/model.ts parseQuestion). An optional text field
// is undefined when the file leaves it null or blank.
export type Question = {
  id: string
  ts: number
  title: string
  question: string
  context?: string
  analogy?: string
  why?: string
  how?: string
  gains?: string
  losses?: string
  urgency?: string
  undo?: string
  project: string
  session: string | null
  session_title?: string
  options: QuestionOption[]
  recommended: string
  risk: string
}

// a/<id>.json: the first writer wins; this mod never overwrites one. Legacy key "other" carries its free text in `text`.
export type Answer = {
  id: string
  key: string
  by: AnswerBy
  ts: number
  text?: string
}

// d/<id>.json: the delivery marker. `expired` is true when no session can read the answer; `reason` says why.
export type DeliveryReason = 'session-ended' | 'ttl'

export type Delivery = {
  id: string
  expired: boolean
  reason?: DeliveryReason
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
// `wizard` mirrors hooks/wizard.ts `Wizard`: the window on screen, the step, the picks, the open "Other…" field
// and the explanations shown. The shape is written out here so the contract stands on its own.
declare module 'claude-code' {
  interface PluginState {
    askaway: {
      board: Board
      away: boolean
      tick: number
      seen: { isPrimed: boolean; ids: string[] }
      // Ids of expired answers whose status line the person dismissed (the plugin's own store keeps them under "cleared").
      cleared: string[]
      // The poll time at which the pane first saw each delivery marker (0 when it was there before the session).
      deliveredAt: Record<string, number>
      // The answered cards still fading out (250 ms after the press): question id → press time. Drawn dim, then gone.
      leaving: Record<string, number>
      // Whether this session is inside a model turn of its own (turn.start to turn.complete; subagent turns excluded).
      turn: { isBusy: boolean }
      // The language in use: the stored choice, else the environment's. Set at session start and by /askaway lang.
      lang: 'en' | 'pt'
      // The question wizard: window key, step (0..total, total = review), picks by question id, the open "Other…"
      // field and the explanations shown per question.
      wizard: {
        windowKey: string | null
        step: number
        picks: Record<string, { key: string; text?: string }>
        other: { id: string; text: string } | null
        expanded: Record<string, boolean>
      }
    }
  }
}
