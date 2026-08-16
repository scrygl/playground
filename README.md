# Letter Friends

A typing and reading game for 4-year-olds. Open `index.html` in a browser —
no build step, no install, no network, no accounts.

## The four games

| Game | What the child does |
| --- | --- |
| **Letter Play** | Presses any key. The letter fills the screen, says its name and its sound, and shows a picture word ("M… mmm… moon 🌙"). Digits count things. |
| **Find the Letter** | The game asks for a letter out loud; the child finds it. After a couple of tries the right key lights up. |
| **Build a Word** | A picture and empty slots. Typing the letters in order fills the word in. |
| **Read With Me** | A short sentence with a picture. It reads word by word, highlighting each one, and any word can be tapped to hear it again. |

## Design rules

These are enforced throughout, because the audience is four:

- **Nothing is ever wrong.** A key that isn't the one we asked for gets a
  friendly answer ("That is B — we want A") and a hint. No buzzers, no lives,
  no red.
- **No timers and no score that can go down.** Stars only ever go up, and
  every fifth one sets off confetti.
- **Works by keyboard or by finger.** Every game accepts a real keyboard and
  taps on the drawn keyboard, so a laptop and a tablet play the same.
- **Speech is a bonus, not a requirement.** If the browser has no voices,
  the game still plays with pictures, chimes and highlighting.
- **The exit is child-proof-ish.** Settings need a 1.2-second press-and-hold
  on the gear, which is past a toddler's patience but not a parent's.

## Grown-up settings

Press and hold the ⚙️ button in the corner.

- **Letters look like** — `ABC`, `abc`, or `Aa` together. Match whatever the
  child is being taught.
- **Keyboard order** — A-B-C order (default, easier to search) or QWERTY
  (matches a real keyboard).
- **Letter sounds** — letter name, phonic sound, or both.
- **Talking speed**, **voice on/off**, and which system voice to use.
- **Show on-screen keyboard** — turn it off when a real keyboard is in use.

Settings and stars are stored in `localStorage` on that device only. Nothing
is sent anywhere.

## Files

```
index.html   markup for all four games and the settings panel
styles.css   the whole look: paper background, chunky pressable everything
data.js      letters, picture words, spellable words, sentences
app.js       games, speech, sound, keyboard, stars, confetti
```

Two notes on choices that look odd out of context:

- The font stack leads with **Comic Sans MS / Chalkboard / Andika** because
  those faces have a single-storey `a` and `g` — the letterforms a 4-year-old
  is taught to write. A double-storey `a` in a phonics game is genuinely
  confusing.
- Letter sounds in `data.js` are spelled the way a speech synthesiser needs to
  read them (`kuh`, not `/k/`), which is why they look wrong to an adult
  reader.

## Testing it

There is no test runner. It was checked by driving a real browser — all four
games, both layouts, mouse and touch, desktop and phone widths, plus several
hundred random keypresses to confirm that mashing the keyboard never breaks
anything or leaves the app stuck.
