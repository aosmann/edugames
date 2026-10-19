# EduGames game contract (v1)

Any game that follows this page shows up in the EduGames portal by itself, can be played solo from the portal, and works in class mode with teacher reports. Lanefall and Stackfall are the reference games.

## 1. Where the game lives

- One public GitHub repository per game under `aosmann`, published with GitHub Pages from the `main` branch root, so the game is at `https://aosmann.github.io/<repo>/`.
- Add the repository topic **`edugame`** (repo page → About → ⚙ → Topics). The portal lists every public repo with that topic. Until the topic is added the game stays hidden.
- No build step: `index.html` at the root, everything works offline after the first visit (service worker), installable on iPhone (manifest + icons).

## 2. Files the portal reads

| File | Purpose |
|---|---|
| `game.json` | Name, pitch and the settings a teacher can choose (below). |
| `questions.js` | The shared question bank, copied **byte-identical** from the latest game. Never edit it inside one game; changes go to every game together. |
| `icon-512.png` | Shown on the portal tile. |

### game.json

```json
{
  "contract": 1,
  "id": "stackfall",
  "name": "Stackfall",
  "pitch": "Answer right. Build to the sky.",
  "description": "One or two sentences for the portal tile.",
  "color": "#ff6b57",
  "icon": "icon-512.png",
  "bank": "EduQ",
  "score": "floors",
  "settings": [
    {"key": "level", "label": "Difficulty", "options": [[1, "Easy"], [2, "Medium"], [3, "Hard"]], "default": "topic"},
    {"key": "time",  "label": "Time limit", "options": [[60, "60 sec"], [90, "90 sec"], [120, "2 min"]], "default": 60}
  ]
}
```

- `id` must equal the repository name.
- `color` is the tile colour. Pick one that is clearly different from the games already in the portal.
- `settings`: every game has `level`. `"default": "topic"` means "use the topic's own difficulty". Add game-specific settings (like `time`) with plain values.
- `score` is the word for the score ("floors", "points").

## 3. Opening the game with fixed settings

The portal opens the game as:

```
https://aosmann.github.io/<repo>/?topic=<topicId>&level=<1-3>&<otherKey>=<value>&lock=1
```

When `topic` is present the game must:

1. Select that topic (find its subject in `EduQ.SUBJECTS`), apply `level` and any other settings from `game.json`, and **start the run straight away**: no subject/topic menu.
2. Not save these settings over the player's own preferences.
3. When `lock=1` (class mode): hide replay and "choose another topic" on the end screen, ignore restart shortcuts, and show "Result sent to your teacher." instead.

Without `topic` the game behaves exactly as on its own.

## 4. Messages to the portal

Post to `window.parent` (only when `window.parent !== window`), target `'*'`:

| When | Message |
|---|---|
| Page loaded | `{type: 'edu-ready', game: '<id>'}` |
| After every answer | `{type: 'edu-progress', game: '<id>', score, right, asked}` |
| Run finished (time up, out of lives, or quit from pause) | `{type: 'edu-result', result}` |

Also append every `result` to `localStorage['edu-results']` (keep the last 200).

### result

```js
{
  game: 'stackfall',          // game.json id
  subject: 'math', topic: 'times', topicName: 'Times tables',
  level: 2,                   // 1-3
  score: 29,                  // the game's main score
  right: 33, asked: 36, bestStreak: 19,
  missed: [{q: '7 × 10 = ?', answer: '70', picked: '63'}],   // flags: q = 'This flag'
  at: '2026-10-19T10:45:25.768Z',
  // optional, game-specific: duration, timeUsed (seconds), peak, hearts, cause, ...
}
```

The portal adds the student's name and session itself. Games never ask for a name.

## 5. Checklist before tagging `edugame`

- [ ] Plays on a 390×844 phone and on a laptop, portrait first.
- [ ] `?topic=times&level=3&lock=1` starts a Hard times-tables run at once, with no replay button at the end.
- [ ] `edu-result` arrives with the fields above (test by opening the game inside the portal).
- [ ] `questions.js` is identical to the other games' copy.
- [ ] Service worker cache name bumped whenever files change.
- [ ] `game.json` is valid JSON and `id` equals the repo name.

The reference code for sections 3 and 4 is the "PORTAL EMBED" block in Stackfall's or Lanefall's `index.html`. Copy that block and adapt the settings line.
