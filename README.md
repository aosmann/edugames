# EduGames

The portal for the educational games: **https://aosmann.github.io/edugames/**

- **Play**: pick a game, topic and settings, and play on your own.
- **Class**: pick a game and settings, show the QR code on the board. Students join from their own phone or tablet with a name, you start the round, and every result comes back to your device live.
- **Reports**: filter results by game, session, day or student and export to Excel (with a "Missed questions" sheet) or CSV.

## How games get here

Games are separate repositories, each with its own GitHub Pages site next to this one (`aosmann.github.io/lanefall/`, `aosmann.github.io/stackfall/`). The portal finds them by itself: every public repo of `aosmann` with the **`edugame`** topic and a `game.json`. `games.json` is a fallback list for when the GitHub API can't be reached.

To build a new game, follow [CONTRACT.md](CONTRACT.md).

## Privacy

There are no accounts and no server database. In class mode the teacher's browser and the students' browsers connect directly (WebRTC, using the free PeerJS service only to introduce them). Results are saved only in the teacher's browser (`localStorage`), and a student's name only in their own browser. Clearing the browser data removes them, so export reports you want to keep.

Class mode needs an internet connection. A few school networks block direct device-to-device connections; if students can't join on one network, try a phone hotspot to check.
