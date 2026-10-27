# Command Bar keyboard review

Automated coverage: `tests/command-bar-keyboard.cjs` drives synthetic Visual
Viewport events in Chromium. It does **not** emulate a native software keyboard
or establish Safari/iPadOS/Android device certification.

## Native-device checklist

Run on iPhone Safari/Chrome, iPad Safari/Chrome, Android Chrome/installed PWA,
and an Android tablet, in portrait and landscape:

1. Open the center +, then tap the command input. Check that the same bar expands
   slightly, stays 8–16px above the keyboard, and never drags the backdrop.
2. Type `Maya Black Jollibee 1828` (with an existing Maya Black account). Press
   Return/Done. The input must blur immediately; the receipt must stay hidden
   while the keyboard dismisses and enter once visible viewport space settles.
   Confirm records and balances remain unchanged until explicit Log.
3. Tap the original command again: the receipt yields space, the sentence stays
   intact, and the same keyboard-follow behavior resumes. Submit again.
4. Open Edit Transaction. Focus first and last fields, switch fields, open/close
   the account picker, then Done Editing. Only the editor's internal scroller
   should move; Done Editing should dismiss the keyboard before receipt entry.
5. Repeat rapid focus/blur, submit/refocus, close/reopen, and rotate with the
   keyboard both open and closed. Check for stale receipts or old positions.
6. On iPad with a hardware keyboard, focus without opening the software keyboard:
   width may expand but the bar must remain at its normal bottom-nav position.
7. Check different keyboard heights, suggestions, Safari chrome, Home Indicator,
   installed PWA safe areas, and Reduce Motion. Geometry must remain correct.
8. Check microphone transcript-only behavior and Search isolation. Neither may
   write a transaction. Existing manual New Entry behavior must remain intact.

Floating/split keyboards that do not resize Visual Viewport do not expose a
reliable keyboard boundary through that API; they retain the non-occluded anchor.

## Implementation boundaries

- `command-bar.js` owns the shared focus, viewport anchor, one-pending-RAF queue,
  and cancellable keyboard-dismissal gate. No guessed keyboard height.
- `command-bar.css` transitions only width/transform; keyboard events themselves
  supply vertical interpolation. Reduced motion preserves all calculations.
- `smart-log.js` still parses synchronously but defers rendering until dismissal
  settles. Revision guards discard stale reviews. Editing uses the same gate.
- The 100ms geometry quiet window starts only after occlusion clears. One 450ms
  compatibility sample catches an omitted final event; it never forces a receipt
  into a still-occluded viewport and is not a polling loop.
- Parsing semantics, receipt styling, financial handlers, cloud and auth logic
  are outside this change. Earlier uncommitted Phase 2 work remains in place.
