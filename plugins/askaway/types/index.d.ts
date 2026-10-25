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
  // The Claude Desktop sessionId ("local_<uuid>") of the asking session itself: the card's "See session" link. Absent
  // when the asking session has no Desktop record (a terminal, or a question filed before the field existed).
  desktop_session?: string
  // The Claude Desktop root session of the asking session's family ("local_<uuid>") and that root's title. Absent on
  // questions filed before they existed; the tree then groups by project.
  family?: string
  family_title?: string
  // The Desktop sidebar group of the asking session (its id and name), set by the pane from the Desktop config (withDesktopGroup);
  // the question file never holds it. Absent when the config names no group for the session or its family.
  desktop_group?: { id: string; name: string }
  options: QuestionOption[]
  recommended: string
  risk: string
  // The optional translations of the agent-written text (beta.34), by the pane's language tag; absent when the file has none.
  translations?: QuestionTranslations
}

// The text fields a translation may replace: the agent-written text of a question (never key, risk, fit or session).
export type TranslatedFields = Partial<
  Pick<Question, 'title' | 'question' | 'what' | 'problem' | 'context' | 'analogy' | 'why' | 'how' | 'gains' | 'losses' | 'urgency' | 'undo'>
>

// The text an option's translation may replace: its label, does, pros, cons and tradeoff (never key or fit).
export type TranslatedOption = Partial<Pick<QuestionOption, 'label' | 'does' | 'pros' | 'cons' | 'tradeoff'>>

// One language of a question's translations: its translated fields, and its options keyed by the option key.
export type QuestionTranslation = TranslatedFields & { options?: Record<string, TranslatedOption> }

// The pane's two languages by tag (pt is pt-BR, en is en); a key of any other tag is ignored.
export type QuestionTranslations = Partial<Record<'en' | 'pt-BR', QuestionTranslation>>

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
      // The answered cards still fading out (until their reply is written): question id → press time. Drawn dim, then gone.
      leaving: Record<string, number>
      // The move lock (350 ms after a pick, Next or Back): the option, Other, Next and Back buttons are drawn disabled and presses do nothing.
      moveLock: boolean
      // The question a pick just moved the card to (1.5 s): that card draws its arrival line. Null otherwise.
      arrival: string | null
      // Whether the review of every chosen answer is drawn in place of the card (set by the pick that completes the group).
      review: boolean
      // Whether this session is inside a model turn of its own (turn.start to turn.complete; subagent turns excluded).
      turn: { isBusy: boolean }
      // Ids of open questions whose asking session has ended (`list --open` marks them `ended`): their card shows a notice.
      ended: string[]
      // Ids of damaged q/ files that pause their session (they name a session and are open): the pane draws a notice and Dismiss.
      damagedPauses: string[]
      // The answerer name (store key "who"): null before it was asked, '' after a skip, else the name.
      who: string | null
      // Quiet mode (store key "quiet", /askaway quiet on|off): no toast per new question and no fade after an answer.
      quiet: boolean
      // The language in use: the stored choice, else the environment's. Set at session start and by /askaway lang.
      lang: 'en' | 'pt'
      // The question wizard (hooks/wizard.ts `Wizard`): the group on screen, the step, the question on screen and the picks
      // by question id. An Other pick carries its free text in `text`.
      wizard: {
        groupKey: string | null
        step: number
        questionId: string | null
        picks: Record<string, { key: string; text?: string }>
        // The kept Other labels by question id: the text the Other button draws (draft.json `labels`).
        labels: Record<string, string>
        // The Other field round: Keep moves on to a new one, so the field empties.
        fieldRound: number
      }
    }
  }
}
