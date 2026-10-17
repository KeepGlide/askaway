// Buttons that keep their press handle across redraws.
//
// The engine names a Button's handler by a handle, and a redraw hands out a new one unless the very same element object
// comes back. A press is matched by that handle alone (an Input or a Select falls back to its key). On the desktop, a
// click that moves the focus redraws the pane just before its press arrives, so a Button made afresh lost the first click.
// A table hands back the element it made last time for a key when nothing drawn on it changed; a press then runs the
// handler of the latest draw.
import type { RenderElement } from 'claude-code'

export type HeldButtons = {
  // Opens a draw. The Buttons not held again before `end` are let go.
  begin: () => void
  end: () => void
  // `look` is everything the Button draws (any JSON value); `make` builds it with the press it is handed.
  hold: (key: string, look: unknown, onPress: () => void, make: (press: () => void) => RenderElement) => RenderElement
}

export function heldButtons(): HeldButtons {
  const made = new Map<string, { look: string; element: RenderElement }>()
  const handlers = new Map<string, () => void>()
  const drawn = new Set<string>()
  return {
    begin: () => drawn.clear(),
    end: () => {
      for (const key of [...made.keys()]) {
        if (drawn.has(key)) continue
        made.delete(key)
        handlers.delete(key)
      }
    },
    hold: (key, look, onPress, make) => {
      drawn.add(key)
      handlers.set(key, onPress)
      const text = JSON.stringify(look)
      const last = made.get(key)
      if (last !== undefined && last.look === text) return last.element
      const element = make(() => handlers.get(key)?.())
      made.set(key, { look: text, element })
      return element
    },
  }
}
