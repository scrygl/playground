/* Content for Letter Friends.
 *
 * `say` strings are written the way a text-to-speech voice needs to read them
 * out loud, not the way a phonics book writes them. "/k/" gets spoken as
 * "slash k slash", so the sound for C is spelled "kuh" instead.
 */

const LETTERS = {
  a: { say: 'ah',   word: 'apple',    emoji: '🍎' },
  b: { say: 'buh',  word: 'ball',     emoji: '⚽' },
  c: { say: 'kuh',  word: 'cat',      emoji: '🐱' },
  d: { say: 'duh',  word: 'dog',      emoji: '🐶' },
  e: { say: 'eh',   word: 'egg',      emoji: '🥚' },
  f: { say: 'fff',  word: 'fish',     emoji: '🐟' },
  g: { say: 'guh',  word: 'goat',     emoji: '🐐' },
  h: { say: 'huh',  word: 'hat',      emoji: '🎩' },
  i: { say: 'ih',   word: 'igloo',    emoji: '🧊' },
  j: { say: 'juh',  word: 'jam',      emoji: '🍯' },
  k: { say: 'kuh',  word: 'kite',     emoji: '🪁' },
  l: { say: 'lll',  word: 'leaf',     emoji: '🍃' },
  m: { say: 'mmm',  word: 'moon',     emoji: '🌙' },
  n: { say: 'nnn',  word: 'nest',     emoji: '🪺' },
  o: { say: 'oh',   word: 'octopus',  emoji: '🐙' },
  p: { say: 'puh',  word: 'pig',      emoji: '🐷' },
  q: { say: 'kwuh', word: 'queen',    emoji: '👑' },
  r: { say: 'rrr',  word: 'rain',     emoji: '🌧️' },
  s: { say: 'sss',  word: 'sun',      emoji: '☀️' },
  t: { say: 'tuh',  word: 'tree',     emoji: '🌳' },
  u: { say: 'uh',   word: 'umbrella', emoji: '☂️' },
  v: { say: 'vvv',  word: 'van',      emoji: '🚐' },
  w: { say: 'wuh',  word: 'worm',     emoji: '🪱' },
  x: { say: 'kss',  word: 'box',      emoji: '📦' },
  y: { say: 'yuh',  word: 'yo-yo',    emoji: '🪀' },
  z: { say: 'zzz',  word: 'zebra',    emoji: '🦓' },
};

/* X almost never starts a word a 4-year-old knows, so Letter Play says
 * "x is at the end of box" instead of pretending box starts with it. */
const LETTER_QUIRKS = {
  x: 'x is at the end of box',
};

const DIGITS = {
  0: { word: 'zero',  emoji: '🕳️', count: 0 },
  1: { word: 'one',   emoji: '🍓', count: 1 },
  2: { word: 'two',   emoji: '🐝', count: 2 },
  3: { word: 'three', emoji: '🎈', count: 3 },
  4: { word: 'four',  emoji: '🐟', count: 4 },
  5: { word: 'five',  emoji: '🌼', count: 5 },
  6: { word: 'six',   emoji: '🍇', count: 6 },
  7: { word: 'seven', emoji: '⭐', count: 7 },
  8: { word: 'eight', emoji: '🐞', count: 8 },
  9: { word: 'nine',  emoji: '🍪', count: 9 },
};

/* Build a Word: short, sound-it-out words. `hint` is how the whole word
 * should be pronounced when the voice reads it back. */
const WORDS = [
  { word: 'cat',  emoji: '🐱' },
  { word: 'dog',  emoji: '🐶' },
  { word: 'sun',  emoji: '☀️' },
  { word: 'bus',  emoji: '🚌' },
  { word: 'hat',  emoji: '🎩' },
  { word: 'pig',  emoji: '🐷' },
  { word: 'cup',  emoji: '🥤' },
  { word: 'bed',  emoji: '🛏️' },
  { word: 'fox',  emoji: '🦊' },
  { word: 'box',  emoji: '📦' },
  { word: 'car',  emoji: '🚗' },
  { word: 'cow',  emoji: '🐮' },
  { word: 'bee',  emoji: '🐝' },
  { word: 'egg',  emoji: '🥚' },
  { word: 'jam',  emoji: '🍯' },
  { word: 'log',  emoji: '🪵' },
  { word: 'map',  emoji: '🗺️' },
  { word: 'pen',  emoji: '🖊️' },
  { word: 'pot',  emoji: '🍲' },
  { word: 'van',  emoji: '🚐' },
  { word: 'bag',  emoji: '🎒' },
  { word: 'key',  emoji: '🔑' },
  { word: 'leg',  emoji: '🦵' },
  { word: 'mug',  emoji: '☕' },
  { word: 'nut',  emoji: '🥜' },
  { word: 'owl',  emoji: '🦉' },
  { word: 'ant',  emoji: '🐜' },
  { word: 'bat',  emoji: '🦇' },
  { word: 'frog', emoji: '🐸' },
  { word: 'star', emoji: '⭐' },
  { word: 'moon', emoji: '🌙' },
  { word: 'fish', emoji: '🐟' },
  { word: 'tree', emoji: '🌳' },
  { word: 'milk', emoji: '🥛' },
  { word: 'cake', emoji: '🍰' },
  { word: 'duck', emoji: '🦆' },
];

/* Read With Me: one picture, one sentence, all sight-word friendly. */
const SENTENCES = [
  { text: 'The cat is on the mat.',  emoji: '🐱' },
  { text: 'I see a big red bus.',    emoji: '🚌' },
  { text: 'The sun is hot today.',   emoji: '☀️' },
  { text: 'My dog can run fast.',    emoji: '🐶' },
  { text: 'A frog sits on a log.',   emoji: '🐸' },
  { text: 'The moon is up at night.', emoji: '🌙' },
  { text: 'I like to eat cake.',     emoji: '🍰' },
  { text: 'Six ducks are in the pond.', emoji: '🦆' },
  { text: 'The bee is on a flower.', emoji: '🐝' },
  { text: 'We can jump and play.',   emoji: '🤸' },
  { text: 'My hat is too big.',      emoji: '🎩' },
  { text: 'The tree has green leaves.', emoji: '🌳' },
];

const PRAISE = [
  'Yes!', 'You did it!', 'Well done!', 'Nice one!', 'Brilliant!',
  'That is it!', 'Super!', 'You found it!', 'Hooray!', 'Clever you!',
];

const KEYBOARD_LAYOUTS = {
  abc: ['abcdefg', 'hijklmn', 'opqrstu', 'vwxyz'],
  qwerty: ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'],
};
