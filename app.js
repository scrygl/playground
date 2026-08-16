/* Letter Friends — a typing and reading game for very new readers.
 *
 * Design rules that the code is built around:
 *   1. Nothing is ever "wrong". A key that is not the one we asked for gets a
 *      friendly answer and a hint, never a buzzer or a lost life.
 *   2. No timers, no countdowns, no score that can go down.
 *   3. Every screen works with a real keyboard AND with taps on the drawn
 *      keyboard, because a 4-year-old is as likely to be on a tablet.
 *   4. Speech is a bonus, not a requirement — if the browser has no voices the
 *      game still plays with pictures and chimes.
 */

/* ------------------------------------------------------------------ *
 * Settings
 * ------------------------------------------------------------------ */

const SETTINGS_KEY = 'letterfriends.settings';
const STARS_KEY = 'letterfriends.stars';

const defaultSettings = {
  letterCase: 'upper',
  layout: 'abc',
  phonics: 'both',
  rate: 0.85,
  voiceOn: true,
  keyboardOn: true,
  voiceURI: '',
};

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? { ...defaultSettings, ...JSON.parse(raw) } : { ...defaultSettings };
  } catch {
    return { ...defaultSettings };
  }
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* private mode — settings just won't stick */
  }
}

const settings = loadSettings();

let stars = 0;
try {
  stars = parseInt(localStorage.getItem(STARS_KEY) || '0', 10) || 0;
} catch {
  stars = 0;
}

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

const $ = (id) => document.getElementById(id);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

/* Deals items in a shuffled order and reshuffles when empty, so a child never
 * gets the same letter three times in a row and always sees the whole set. */
function makeBag(items) {
  let pool = [];
  let last = null;
  return function next() {
    if (pool.length === 0) {
      pool = items.slice();
      for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }
      if (pool.length > 1 && pool[pool.length - 1] === last) {
        [pool[0], pool[pool.length - 1]] = [pool[pool.length - 1], pool[0]];
      }
    }
    last = pool.pop();
    return last;
  };
}

function formatLetter(ch) {
  if (ch >= '0' && ch <= '9') return ch;
  if (settings.letterCase === 'lower') return ch.toLowerCase();
  if (settings.letterCase === 'both') return ch.toUpperCase() + ch.toLowerCase();
  return ch.toUpperCase();
}

function letterName(ch) {
  /* Voices read a lone "a" as the word "a"; spelling it out keeps the name. */
  const names = {
    a: 'ay', b: 'bee', c: 'see', d: 'dee', e: 'ee', f: 'eff', g: 'gee',
    h: 'aitch', i: 'eye', j: 'jay', k: 'kay', l: 'ell', m: 'em', n: 'en',
    o: 'oh', p: 'pee', q: 'cue', r: 'ar', s: 'ess', t: 'tee', u: 'you',
    v: 'vee', w: 'double you', x: 'ex', y: 'why', z: 'zee',
  };
  return names[ch] || ch;
}

/* ------------------------------------------------------------------ *
 * Sound (chimes) — works with no voices at all
 * ------------------------------------------------------------------ */

let audioCtx = null;

function unlockAudio() {
  if (!audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx) audioCtx = new Ctx();
  }
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
}

function tone(freq, start, dur, gain = 0.14, type = 'sine') {
  if (!audioCtx) return;
  const t0 = audioCtx.currentTime + start;
  const osc = audioCtx.createOscillator();
  const amp = audioCtx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  amp.gain.setValueAtTime(0.0001, t0);
  amp.gain.exponentialRampToValueAtTime(gain, t0 + 0.02);
  amp.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(amp).connect(audioCtx.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.05);
}

const sfx = {
  tap() { tone(520, 0, 0.12, 0.09, 'triangle'); },
  pop() { tone(660, 0, 0.14, 0.11, 'triangle'); tone(990, 0.05, 0.14, 0.06); },
  /* Deliberately not a buzzer: two soft notes that read as "hmm, try again". */
  nudge() { tone(392, 0, 0.16, 0.08, 'sine'); tone(349, 0.12, 0.2, 0.07, 'sine'); },
  chime() { [523, 659, 784].forEach((f, i) => tone(f, i * 0.08, 0.35, 0.13)); },
  fanfare() {
    [523, 659, 784, 1046].forEach((f, i) => tone(f, i * 0.1, 0.5, 0.14));
    tone(1318, 0.45, 0.7, 0.1);
  },
  sparkle() { tone(1174, 0, 0.2, 0.08); tone(1568, 0.07, 0.25, 0.06); },
};

/* ------------------------------------------------------------------ *
 * Speech
 * ------------------------------------------------------------------ */

const synth = window.speechSynthesis || null;
let voices = [];
let speechToken = 0;

function refreshVoices() {
  if (!synth) return;
  voices = synth.getVoices().filter((v) => /^en/i.test(v.lang));
  if (voices.length === 0) voices = synth.getVoices();
  renderVoiceOptions();
  $('speech-warning').hidden = voices.length > 0;
}

if (synth) {
  refreshVoices();
  synth.addEventListener('voiceschanged', refreshVoices);
}

function chosenVoice() {
  if (!voices.length) return null;
  const saved = voices.find((v) => v.voiceURI === settings.voiceURI);
  if (saved) return saved;
  const preferred = ['samantha', 'google us english', 'karen', 'moira', 'zira', 'daniel'];
  for (const name of preferred) {
    const hit = voices.find((v) => v.name.toLowerCase().includes(name));
    if (hit) return hit;
  }
  return voices.find((v) => v.localService) || voices[0];
}

function speechAvailable() {
  return Boolean(synth && settings.voiceOn && voices.length);
}

function stopSpeech() {
  speechToken++;
  if (synth) synth.cancel();
}

function utter(text, { rate = 1, pitch = 1.15 } = {}) {
  return new Promise((resolve) => {
    if (!synth || !settings.voiceOn || !voices.length) return resolve();
    const u = new SpeechSynthesisUtterance(text);
    const voice = chosenVoice();
    if (voice) {
      u.voice = voice;
      u.lang = voice.lang;
    }
    u.rate = Math.max(0.5, Math.min(1.4, settings.rate * rate));
    u.pitch = pitch;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(guard);
      resolve();
    };
    /* Some browsers never fire `end` (especially after a cancel), so a
     * length-based guard keeps a sequence from stalling forever. */
    const guard = setTimeout(finish, 1200 + text.length * 130);
    u.onend = finish;
    u.onerror = finish;
    synth.speak(u);
  });
}

/* Speaks a list of strings (or {pause: ms} gaps) in order.
 * Returns false if a newer request interrupted this one. */
async function say(parts) {
  const token = ++speechToken;
  if (synth) synth.cancel();
  for (const part of parts) {
    if (token !== speechToken) return false;
    if (typeof part === 'object' && part && part.pause) {
      await wait(part.pause);
      continue;
    }
    if (typeof part === 'object' && part) {
      await utter(part.text, part);
    } else if (part) {
      await utter(String(part));
    }
  }
  return token === speechToken;
}

/* How a letter should be announced, following the phonics setting. */
function letterParts(ch) {
  const info = LETTERS[ch];
  if (!info) {
    const d = DIGITS[ch];
    return d ? [d.word] : [ch];
  }
  if (settings.phonics === 'name') return [letterName(ch)];
  if (settings.phonics === 'sound') return [info.say];
  return [letterName(ch), { pause: 220 }, info.say];
}

/* ------------------------------------------------------------------ *
 * Stars and celebrations
 * ------------------------------------------------------------------ */

function renderStars() {
  $('star-count').textContent = String(stars);
}

function awardStar() {
  stars += 1;
  try {
    localStorage.setItem(STARS_KEY, String(stars));
  } catch { /* ignore */ }
  renderStars();
  const tray = $('star-tray');
  tray.classList.remove('pop');
  void tray.offsetWidth;
  tray.classList.add('pop');
  sfx.sparkle();
  return stars % 5 === 0;
}

function cheer(text) {
  const el = $('cheer');
  el.textContent = text;
  el.classList.remove('show');
  void el.offsetWidth;
  el.classList.add('show');
}

/* --- confetti ----------------------------------------------------- */

const confettiCanvas = $('confetti');
const cctx = confettiCanvas.getContext('2d');
let confetti = [];
let confettiRunning = false;
const CONFETTI_COLORS = ['#f2542d', '#f5a623', '#ffd23f', '#3fa34d', '#2d9cdb', '#e5487a'];

function sizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  confettiCanvas.width = window.innerWidth * dpr;
  confettiCanvas.height = window.innerHeight * dpr;
  cctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', sizeCanvas);
sizeCanvas();

function burstConfetti(count = 60) {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const w = window.innerWidth;
  for (let i = 0; i < count; i++) {
    confetti.push({
      x: w / 2 + (Math.random() - 0.5) * w * 0.5,
      y: window.innerHeight * 0.35 + (Math.random() - 0.5) * 80,
      vx: (Math.random() - 0.5) * 7,
      vy: -6 - Math.random() * 7,
      size: 7 + Math.random() * 9,
      spin: (Math.random() - 0.5) * 0.3,
      angle: Math.random() * Math.PI,
      color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
      life: 1,
    });
  }
  if (!confettiRunning) {
    confettiRunning = true;
    requestAnimationFrame(stepConfetti);
  }
}

function stepConfetti() {
  cctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  confetti = confetti.filter((p) => p.life > 0 && p.y < window.innerHeight + 40);
  for (const p of confetti) {
    p.vy += 0.28;
    p.x += p.vx;
    p.y += p.vy;
    p.angle += p.spin;
    p.life -= 0.004;
    cctx.save();
    cctx.translate(p.x, p.y);
    cctx.rotate(p.angle);
    cctx.globalAlpha = Math.max(0, Math.min(1, p.life));
    cctx.fillStyle = p.color;
    cctx.fillRect(-p.size / 2, -p.size / 3, p.size, p.size * 0.66);
    cctx.restore();
  }
  if (confetti.length) {
    requestAnimationFrame(stepConfetti);
  } else {
    confettiRunning = false;
    cctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  }
}

/* ------------------------------------------------------------------ *
 * On-screen keyboard
 * ------------------------------------------------------------------ */

const keyboardEl = $('keyboard');
let keyboardWantsDigits = false;

function renderKeyboard() {
  keyboardEl.innerHTML = '';
  const rows = KEYBOARD_LAYOUTS[settings.layout] || KEYBOARD_LAYOUTS.abc;
  if (keyboardWantsDigits) {
    keyboardEl.appendChild(buildRow('0123456789'.split(''), 'digit'));
  }
  rows.forEach((row) => keyboardEl.appendChild(buildRow(row.split(''), 'letter')));
}

function buildRow(chars, kind) {
  const rowEl = document.createElement('div');
  rowEl.className = 'kb-row';
  chars.forEach((ch) => {
    const key = document.createElement('button');
    key.className = `kb-key kb-key-${kind}`;
    key.type = 'button';
    key.dataset.key = ch;
    key.textContent = formatLetter(ch);
    key.setAttribute('aria-label', ch);
    rowEl.appendChild(key);
  });
  return rowEl;
}

keyboardEl.addEventListener('pointerdown', (e) => {
  const key = e.target.closest('.kb-key');
  if (!key) return;
  e.preventDefault();
  flashKey(key.dataset.key);
  handleInput(key.dataset.key);
});
keyboardEl.addEventListener('contextmenu', (e) => e.preventDefault());

function flashKey(ch) {
  const key = keyboardEl.querySelector(`.kb-key[data-key="${ch}"]`);
  if (!key) return;
  key.classList.remove('pressed');
  void key.offsetWidth;
  key.classList.add('pressed');
  setTimeout(() => key.classList.remove('pressed'), 220);
}

function hintKey(ch) {
  clearHints();
  const key = keyboardEl.querySelector(`.kb-key[data-key="${ch}"]`);
  if (key) key.classList.add('hint');
}

function clearHints() {
  keyboardEl.querySelectorAll('.kb-key.hint').forEach((k) => k.classList.remove('hint'));
}

function showKeyboard(show, withDigits = false) {
  keyboardWantsDigits = withDigits;
  const visible = show && settings.keyboardOn;
  keyboardEl.hidden = !visible;
  document.body.classList.toggle('has-keyboard', visible);
  if (visible) renderKeyboard();
}

/* ------------------------------------------------------------------ *
 * Screens
 * ------------------------------------------------------------------ */

const SCREENS = {
  menu: 'menu',
  play: 'screen-play',
  hunt: 'screen-hunt',
  build: 'screen-build',
  read: 'screen-read',
};

let currentMode = null;

function showScreen(name) {
  Object.values(SCREENS).forEach((id) => { $(id).hidden = true; });
  $(SCREENS[name]).hidden = false;
}

/* Confetti and praise from the last game should not follow you to the next. */
function clearCelebration() {
  $('cheer').classList.remove('show');
  confetti = [];
}

function goToMenu() {
  if (currentMode && modes[currentMode].exit) modes[currentMode].exit();
  currentMode = null;
  stopSpeech();
  clearTimers();
  clearCelebration();
  showScreen('menu');
  showKeyboard(false);
  $('back-btn').hidden = true;
  $('mode-title').textContent = 'Letter Friends';
}

function startMode(name) {
  if (currentMode && modes[currentMode].exit) modes[currentMode].exit();
  clearTimers();
  clearCelebration();
  currentMode = name;
  showScreen(name);
  $('back-btn').hidden = false;
  modes[name].enter();
}

/* Timers are tracked so leaving a game never leaves a callback running. */
let timers = [];
function later(fn, ms) {
  const id = setTimeout(fn, ms);
  timers.push(id);
  return id;
}
function clearTimers() {
  timers.forEach(clearTimeout);
  timers = [];
}

/* ------------------------------------------------------------------ *
 * Input funnel — physical keys and screen taps land here
 * ------------------------------------------------------------------ */

function handleInput(ch) {
  if (!currentMode) return;
  unlockAudio();
  const mode = modes[currentMode];
  if (mode.input) mode.input(ch.toLowerCase());
}

document.addEventListener('keydown', (e) => {
  if (!$('parent-panel').hidden) {
    if (e.key === 'Escape') closeParentPanel();
    return;
  }
  if (e.key === 'Escape') {
    if (currentMode) goToMenu();
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;

  if (e.key === ' ' || e.key === 'Enter') {
    if (currentMode) {
      e.preventDefault();
      const mode = modes[currentMode];
      if (mode.repeat) mode.repeat();
    }
    return;
  }
  if (e.key.length === 1 && /[a-z0-9]/i.test(e.key)) {
    if (!currentMode) return;
    e.preventDefault();
    flashKey(e.key.toLowerCase());
    handleInput(e.key);
  }
});

/* Stop the page from scrolling under small fingers. */
document.addEventListener('touchmove', (e) => {
  if (e.target.closest('.parent-card')) return;
  e.preventDefault();
}, { passive: false });

/* ------------------------------------------------------------------ *
 * Game: Letter Play — press anything, something lovely happens
 * ------------------------------------------------------------------ */

const seenLetters = new Set();

const playMode = {
  enter() {
    $('mode-title').textContent = 'Letter Play';
    showKeyboard(true, true);
    $('play-card').hidden = true;
    $('play-hint').hidden = false;
    renderTrack();
    say(['Press any letter!']);
  },
  exit() {
    seenLetters.clear();
  },
  input(ch) {
    const isDigit = ch >= '0' && ch <= '9';
    const info = isDigit ? DIGITS[ch] : LETTERS[ch];
    if (!info) return;

    $('play-hint').hidden = true;
    const card = $('play-card');
    card.hidden = false;
    card.className = `letter-card tone-${colorFor(ch)}`;
    void card.offsetWidth;
    card.classList.add('drop-in');

    $('play-glyph').textContent = formatLetter(ch);
    $('play-word').textContent = info.word;
    $('play-emoji').textContent = isDigit
      ? info.emoji.repeat(Math.min(info.count, 5)) || '🕳️'
      : info.emoji;

    sfx.pop();

    if (isDigit) {
      say([info.word, { pause: 150 }, `${info.count} ${info.count === 1 ? 'thing' : 'things'}`]);
    } else {
      const quirk = LETTER_QUIRKS[ch];
      say([...letterParts(ch), { pause: 250 }, quirk || `${info.word}`]);
    }

    if (!isDigit && !seenLetters.has(ch)) {
      seenLetters.add(ch);
      renderTrack();
      if (awardStar()) bigCelebration();
    }
  },
  repeat() {
    const glyph = $('play-glyph').textContent.trim().toLowerCase();
    if (glyph) this.input(glyph[0]);
  },
};

function colorFor(ch) {
  const tones = ['tomato', 'mango', 'grass', 'sky', 'berry', 'grape'];
  return tones[(ch.charCodeAt(0) - 97 + 26) % tones.length];
}

function renderTrack() {
  const track = $('play-track');
  track.innerHTML = '';
  'abcdefghijklmnopqrstuvwxyz'.split('').forEach((ch) => {
    const dot = document.createElement('span');
    dot.className = 'track-letter' + (seenLetters.has(ch) ? ' found' : '');
    dot.textContent = formatLetter(ch)[0];
    track.appendChild(dot);
  });
}

/* ------------------------------------------------------------------ *
 * Game: Find the Letter
 * ------------------------------------------------------------------ */

const huntMode = {
  target: null,
  busy: false,
  misses: 0,
  nextLetter: makeBag('abcdefghijklmnopqrstuvwxyz'.split('')),

  enter() {
    $('mode-title').textContent = 'Find the Letter';
    showKeyboard(true, false);
    this.newRound(600);
  },
  exit() {
    clearHints();
    this.busy = false;
  },
  newRound(delay = 0) {
    this.target = this.nextLetter();
    this.misses = 0;
    this.busy = false;
    clearHints();

    const info = LETTERS[this.target];
    const card = $('hunt-card');
    card.className = `letter-card letter-card-target tone-${colorFor(this.target)}`;
    void card.offsetWidth;
    card.classList.add('drop-in');
    $('hunt-glyph').textContent = formatLetter(this.target);
    $('hunt-word').textContent = info.word;
    $('hunt-emoji').textContent = info.emoji;

    later(() => this.prompt(), delay);
    /* If nothing has been pressed for a while, light up the right key. */
    later(() => { if (!this.busy) hintKey(this.target); }, delay + 9000);
  },
  prompt() {
    const info = LETTERS[this.target];
    say([
      'Can you find',
      { pause: 120 },
      ...letterParts(this.target),
      { pause: 250 },
      `like ${info.word}`,
    ]);
  },
  repeat() {
    if (!this.busy) this.prompt();
  },
  input(ch) {
    if (this.busy || !LETTERS[ch]) return;
    if (ch === this.target) {
      this.busy = true;
      clearHints();
      sfx.chime();
      burstConfetti(50);
      cheer(pick(PRAISE));
      const info = LETTERS[this.target];
      const big = awardStar();
      say([pick(PRAISE), { pause: 150 }, `${letterName(this.target)} for ${info.word}`]);
      if (big) later(() => bigCelebration(), 900);
      later(() => this.newRound(200), big ? 2600 : 1700);
    } else {
      this.misses += 1;
      sfx.nudge();
      wiggle($('hunt-card'));
      const found = LETTERS[ch];
      say([
        `That is ${letterName(ch)}`,
        { pause: 200 },
        'we want',
        ...letterParts(this.target),
      ]);
      if (this.misses >= 2) hintKey(this.target);
    }
  },
};

function wiggle(el) {
  el.classList.remove('wiggle');
  void el.offsetWidth;
  el.classList.add('wiggle');
}

/* ------------------------------------------------------------------ *
 * Game: Build a Word
 * ------------------------------------------------------------------ */

const buildMode = {
  entry: null,
  index: 0,
  misses: 0,
  busy: false,
  nextWord: makeBag(WORDS),

  enter() {
    $('mode-title').textContent = 'Build a Word';
    showKeyboard(true, false);
    this.newRound(500);
  },
  exit() {
    clearHints();
    this.busy = false;
  },
  newRound(delay = 0) {
    this.entry = this.nextWord();
    this.index = 0;
    this.misses = 0;
    this.busy = false;
    clearHints();

    $('build-emoji').textContent = this.entry.emoji;
    const slots = $('build-slots');
    slots.innerHTML = '';
    this.entry.word.split('').forEach((ch, i) => {
      const slot = document.createElement('span');
      slot.className = 'slot';
      slot.dataset.index = String(i);
      slot.textContent = formatLetter(ch);
      slots.appendChild(slot);
    });
    later(() => this.prompt(), delay);
    later(() => { if (this.index === 0) hintKey(this.entry.word[0]); }, delay + 9000);
  },
  prompt() {
    const spelled = this.entry.word.split('').map(letterName).join(', ');
    say([
      this.entry.word,
      { pause: 250 },
      `Can you type ${this.entry.word}?`,
      { pause: 250 },
      spelled,
    ]);
  },
  repeat() {
    if (!this.busy) this.prompt();
  },
  input(ch) {
    if (this.busy || !this.entry) return;
    const wanted = this.entry.word[this.index];
    const slot = $('build-slots').querySelector(`.slot[data-index="${this.index}"]`);

    if (ch === wanted) {
      this.misses = 0;
      clearHints();
      slot.classList.add('filled');
      sfx.pop();
      this.index += 1;
      if (this.index >= this.entry.word.length) {
        this.finish();
      } else {
        say(letterParts(ch));
        later(() => { if (this.index && !this.busy) hintKey(this.entry.word[this.index]); }, 9000);
      }
    } else {
      this.misses += 1;
      sfx.nudge();
      wiggle(slot);
      if (this.misses >= 2) {
        hintKey(wanted);
        say(['Try', ...letterParts(wanted)]);
      } else {
        say([`That is ${letterName(ch)}`, { pause: 150 }, 'we need', ...letterParts(wanted)]);
      }
    }
  },
  finish() {
    this.busy = true;
    clearHints();
    sfx.fanfare();
    burstConfetti(70);
    cheer(pick(PRAISE));
    $('build-slots').classList.add('done');
    const big = awardStar();
    say([pick(PRAISE), { pause: 200 }, `You spelled ${this.entry.word}`]);
    if (big) later(() => bigCelebration(), 1000);
    later(() => {
      $('build-slots').classList.remove('done');
      this.newRound(200);
    }, big ? 3000 : 2200);
  },
};

/* ------------------------------------------------------------------ *
 * Game: Read With Me
 * ------------------------------------------------------------------ */

const readMode = {
  entry: null,
  reading: false,
  nextSentence: makeBag(SENTENCES),

  enter() {
    $('mode-title').textContent = 'Read With Me';
    showKeyboard(false);
    this.newPage();
  },
  exit() {
    this.reading = false;
  },
  newPage() {
    this.entry = this.nextSentence();
    this.reading = false;
    $('read-emoji').textContent = this.entry.emoji;

    const holder = $('read-sentence');
    holder.innerHTML = '';
    this.entry.text.split(' ').forEach((word, i) => {
      const span = document.createElement('span');
      span.className = 'read-word';
      span.dataset.index = String(i);
      span.textContent = word;
      holder.appendChild(span);
      holder.appendChild(document.createTextNode(' '));
    });
    later(() => this.readAll(), 500);
  },
  words() {
    return Array.from($('read-sentence').querySelectorAll('.read-word'));
  },
  async readAll() {
    if (this.reading) return;
    this.reading = true;
    const words = this.words();
    /* Word by word, highlighting as we go — the same thing a grown-up finger
     * does under the line. Sequential utterances keep sound and highlight
     * in step without relying on boundary events, which are patchy. With no
     * voice available the highlight still walks the line at reading pace. */
    const gap = speechAvailable() ? 60 : 520;
    for (const span of words) {
      if (!this.reading || currentMode !== 'read') break;
      words.forEach((w) => w.classList.remove('speaking'));
      span.classList.add('speaking');
      sfx.tap();
      const ok = await say([cleanWord(span.textContent)]);
      if (!ok) break;
      await wait(gap);
    }
    words.forEach((w) => w.classList.remove('speaking'));
    if (this.reading && currentMode === 'read') {
      this.reading = false;
      if (awardStar()) bigCelebration();
    }
    this.reading = false;
  },
  repeat() {
    this.readAll();
  },
  input() { /* letters do nothing here — this page is for looking and listening */ },
};

function cleanWord(text) {
  return text.replace(/[^a-z0-9' ]/gi, '').trim();
}

$('read-sentence').addEventListener('pointerdown', (e) => {
  const span = e.target.closest('.read-word');
  if (!span) return;
  e.preventDefault();
  unlockAudio();
  readMode.reading = false;
  readMode.words().forEach((w) => w.classList.remove('speaking'));
  span.classList.add('speaking');
  sfx.tap();
  say([cleanWord(span.textContent)]);
  setTimeout(() => span.classList.remove('speaking'), 900);
});

$('read-play').addEventListener('click', () => {
  unlockAudio();
  readMode.readAll();
});
$('read-next').addEventListener('click', () => {
  unlockAudio();
  stopSpeech();
  readMode.reading = false;
  sfx.pop();
  readMode.newPage();
});

const modes = { play: playMode, hunt: huntMode, build: buildMode, read: readMode };

function bigCelebration() {
  burstConfetti(140);
  sfx.fanfare();
  cheer(`${stars} stars! 🎉`);
  say([`Wow! ${stars} stars!`]);
}

/* ------------------------------------------------------------------ *
 * Menu, top bar, parent gate
 * ------------------------------------------------------------------ */

document.querySelectorAll('.game-card').forEach((card) => {
  card.addEventListener('click', () => {
    unlockAudio();
    sfx.pop();
    startMode(card.dataset.mode);
  });
});

$('back-btn').addEventListener('click', () => {
  sfx.tap();
  goToMenu();
});

$('hunt-repeat').addEventListener('click', () => { unlockAudio(); huntMode.repeat(); });
$('build-repeat').addEventListener('click', () => { unlockAudio(); buildMode.repeat(); });

$('full-btn').addEventListener('click', () => {
  if (document.fullscreenElement) {
    document.exitFullscreen?.();
  } else {
    document.documentElement.requestFullscreen?.().catch(() => {});
  }
});

/* The settings button needs a deliberate press-and-hold, which is just enough
 * to keep small hands out without putting a maths puzzle in front of a parent. */
const HOLD_MS = 1200;
let holdTimer = null;

function startHold(e) {
  e.preventDefault();
  $('parent-btn').classList.add('holding');
  holdTimer = setTimeout(openParentPanel, HOLD_MS);
}
function cancelHold() {
  $('parent-btn').classList.remove('holding');
  clearTimeout(holdTimer);
}
$('parent-btn').addEventListener('pointerdown', startHold);
['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) =>
  $('parent-btn').addEventListener(ev, cancelHold));

function openParentPanel() {
  cancelHold();
  stopSpeech();
  syncPanel();
  $('parent-panel').hidden = false;
}
function closeParentPanel() {
  $('parent-panel').hidden = true;
}
$('parent-close').addEventListener('click', closeParentPanel);
$('parent-panel').addEventListener('pointerdown', (e) => {
  if (e.target === $('parent-panel')) closeParentPanel();
});

$('reset-stars').addEventListener('click', () => {
  stars = 0;
  try {
    localStorage.setItem(STARS_KEY, '0');
  } catch { /* ignore */ }
  renderStars();
});

function renderVoiceOptions() {
  const select = $('set-voice');
  if (!select) return;
  $('voice-setting').hidden = voices.length === 0;
  select.innerHTML = '';
  const auto = document.createElement('option');
  auto.value = '';
  auto.textContent = 'Choose for me';
  select.appendChild(auto);
  voices.forEach((v) => {
    const opt = document.createElement('option');
    opt.value = v.voiceURI;
    opt.textContent = `${v.name} (${v.lang})`;
    select.appendChild(opt);
  });
  select.value = settings.voiceURI;
}

function syncPanel() {
  $('set-case').value = settings.letterCase;
  $('set-layout').value = settings.layout;
  $('set-phonics').value = settings.phonics;
  $('set-rate').value = String(settings.rate);
  $('set-rate-out').textContent = rateLabel(settings.rate);
  $('set-voice-on').checked = settings.voiceOn;
  $('set-kb-on').checked = settings.keyboardOn;
  renderVoiceOptions();
}

function rateLabel(rate) {
  if (rate <= 0.72) return 'very slow';
  if (rate <= 0.85) return 'slow';
  if (rate <= 0.97) return 'normal';
  return 'quick';
}

function applySettings() {
  saveSettings();
  if (!keyboardEl.hidden) renderKeyboard();
  if (currentMode === 'play') renderTrack();
  refreshCurrentGlyphs();
}

/* Letter case can change mid-game; redraw whatever is on screen. */
function refreshCurrentGlyphs() {
  if (currentMode === 'hunt' && huntMode.target) {
    $('hunt-glyph').textContent = formatLetter(huntMode.target);
  }
  if (currentMode === 'build' && buildMode.entry) {
    $('build-slots').querySelectorAll('.slot').forEach((slot, i) => {
      slot.textContent = formatLetter(buildMode.entry.word[i]);
    });
  }
}

$('set-case').addEventListener('change', (e) => {
  settings.letterCase = e.target.value;
  applySettings();
});
$('set-layout').addEventListener('change', (e) => {
  settings.layout = e.target.value;
  applySettings();
});
$('set-phonics').addEventListener('change', (e) => {
  settings.phonics = e.target.value;
  saveSettings();
});
$('set-rate').addEventListener('input', (e) => {
  settings.rate = parseFloat(e.target.value);
  $('set-rate-out').textContent = rateLabel(settings.rate);
  saveSettings();
});
$('set-rate').addEventListener('change', () => {
  say(['This is how fast I will talk.']);
});
$('set-voice-on').addEventListener('change', (e) => {
  settings.voiceOn = e.target.checked;
  if (!settings.voiceOn) stopSpeech();
  saveSettings();
});
$('set-kb-on').addEventListener('change', (e) => {
  settings.keyboardOn = e.target.checked;
  saveSettings();
  if (currentMode && currentMode !== 'read') showKeyboard(true, currentMode === 'play');
  else showKeyboard(false);
});
$('set-voice').addEventListener('change', (e) => {
  settings.voiceURI = e.target.value;
  saveSettings();
  say(['Hello! I am your reading friend.']);
});

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

$('start-btn').addEventListener('click', () => {
  unlockAudio();
  refreshVoices();
  $('start-screen').hidden = true;
  $('app').hidden = false;
  renderStars();
  goToMenu();
  sfx.chime();
  say(['Hello! What shall we play?']);
});

renderStars();
