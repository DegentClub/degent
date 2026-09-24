/**
 * Prompt scaffold. The user supplies a short style brief ("DJ at a rooftop party", "pharaoh") plus an
 * optional palette and mood; the scaffold wraps it in the fixed collection requirements so that the
 * generated image already contains the things the compositor cannot add (the character, the tuxedo,
 * the bowtie, portrait framing) and does NOT contain the things the compositor adds itself (the frame,
 * the placard, any text). Pure: no I/O.
 */
export interface PromptInput {
  brief: string;
  palette?: string | undefined;
  mood?: string | undefined;
}

export interface ScaffoldedPrompt {
  /** The positive prompt sent to the provider. */
  prompt: string;
  /** Things the image must not contain; providers without a negative-prompt field get them inline. */
  negative: string[];
  /** Normalised user inputs actually used (after trimming / whitespace collapse). */
  brief: string;
  palette: string | null;
  mood: string | null;
}

export const BRIEF_MAX_CHARS = 200;
export const PALETTE_MAX_CHARS = 80;
export const MOOD_MAX_CHARS = 60;

/**
 * Terms that never belong in a collection piece. Matched as whole words, case-insensitive, after
 * normalisation. Kept deliberately short: the provider has its own safety system and the vision
 * review runs afterwards; this list is the cheap first gate, not the last.
 */
export const BANNED_TERMS: readonly string[] = Object.freeze([
  'nude', 'naked', 'nsfw', 'sex', 'sexual', 'porn', 'erotic', 'topless', 'genitals',
  'gore', 'blood', 'bloody', 'beheaded', 'decapitated', 'corpse', 'mutilated', 'torture',
  'nazi', 'swastika', 'hitler', 'kkk', 'klan', 'lynching', 'genocide',
  'child', 'children', 'kid', 'kids', 'minor', 'toddler', 'loli', 'shota',
  'suicide', 'self-harm', 'overdose',
  'seed phrase', 'private key', 'qr code',
]);

/** Instruction-like phrases that try to escape the scaffold. */
const INJECTION_PATTERNS: readonly RegExp[] = [
  /ignore (all |the |any )?(previous|prior|above) (instructions|rules|prompts?)/i,
  /disregard (the |all |any )?(previous|prior|above)/i,
  /\bsystem prompt\b/i,
  /\b(do not|don't|never) (draw|include|add) (a |the )?(tuxedo|bow ?tie|frog|pepe)\b/i,
  /\bwithout (a |the )?(tuxedo|bow ?tie)\b/i,
  /\b(no|remove the|drop the) (tuxedo|bow ?tie)\b/i,
];

export interface BriefValidation {
  ok: boolean;
  problems: string[];
}

function normalise(s: string): string {
  return s
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\ufeff]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function hasBanned(s: string): string[] {
  const text = ` ${s.toLowerCase().replace(/[^a-z0-9' -]+/g, ' ').replace(/\s+/g, ' ')} `;
  return BANNED_TERMS.filter((t) => text.includes(` ${t} `));
}

export function validateBrief(input: PromptInput): BriefValidation {
  const problems: string[] = [];
  const brief = normalise(input.brief ?? '');
  if (brief.length < 3) problems.push('brief must be at least 3 characters');
  if (brief.length > BRIEF_MAX_CHARS) problems.push(`brief must be at most ${BRIEF_MAX_CHARS} characters`);
  const palette = input.palette ? normalise(input.palette) : '';
  const mood = input.mood ? normalise(input.mood) : '';
  if (palette.length > PALETTE_MAX_CHARS) problems.push(`palette must be at most ${PALETTE_MAX_CHARS} characters`);
  if (mood.length > MOOD_MAX_CHARS) problems.push(`mood must be at most ${MOOD_MAX_CHARS} characters`);
  for (const [field, value] of [
    ['brief', brief],
    ['palette', palette],
    ['mood', mood],
  ] as const) {
    if (!value) continue;
    const banned = hasBanned(value);
    if (banned.length) problems.push(`${field} contains disallowed terms: ${[...new Set(banned)].join(', ')}`);
    if (INJECTION_PATTERNS.some((re) => re.test(value))) problems.push(`${field} tries to override the collection rules`);
    if (/https?:\/\/|www\./i.test(value)) problems.push(`${field} must not contain links`);
  }
  return { ok: problems.length === 0, problems };
}

/** Fixed requirements. Ordered so the most important constraints come first (providers weight early tokens more). */
const REQUIRED = [
  'Pepe the Frog, the green cartoon frog character, as a distinguished gentleman',
  'wearing a black tuxedo with a crisp white dress shirt',
  'and a large, clearly visible bow tie at the collar',
];

const FRAMING = [
  'head-and-shoulders portrait, subject centred and facing the viewer, filling most of the square canvas',
  'square 1:1 composition with generous margin on all sides so nothing important touches the edges',
  'a painted, gallery-portrait feel with clean edges',
];

const NEGATIVE = [
  'text',
  'letters',
  'words',
  'captions',
  'watermarks',
  'signatures',
  'logos',
  'a picture frame or border',
  'a name plate or placard',
  'multiple characters',
  'realistic humans',
  'weapons',
  'nudity',
  'gore',
];

/**
 * Compose the full prompt. Throws on an invalid brief: callers validate first with `validateBrief`
 * to get the full problem list for the API response.
 */
export function scaffoldPrompt(input: PromptInput): ScaffoldedPrompt {
  const v = validateBrief(input);
  if (!v.ok) throw new Error(`invalid prompt input: ${v.problems.join('; ')}`);
  const brief = normalise(input.brief);
  const palette = input.palette ? normalise(input.palette) : null;
  const mood = input.mood ? normalise(input.mood) : null;

  const parts: string[] = [];
  parts.push(`A portrait of ${REQUIRED.join(', ')}.`);
  parts.push(`Theme: ${brief}. Keep the tuxedo and bow tie fully visible whatever the theme adds.`);
  if (mood) parts.push(`Mood: ${mood}.`);
  if (palette) parts.push(`Colour palette: ${palette}.`);
  parts.push(`Composition: ${FRAMING.join('; ')}.`);
  parts.push(`The image must contain no ${NEGATIVE.slice(0, 7).join(', no ')}: the collection adds its own frame and name plate afterwards.`);
  parts.push('Family-friendly, no real people, no brands.');
  return { prompt: parts.join(' '), negative: [...NEGATIVE], brief, palette, mood };
}
