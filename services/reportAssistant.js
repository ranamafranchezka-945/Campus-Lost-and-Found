// services/reportAssistant.js - Natural-language report intake.
//
// Turns a sentence like "I lost my black AquaFlask near the library this morning"
// into a validated draft report: type, item name, category, campus location and time.
//
// Two engines, one output shape:
//   rules  - deterministic campus-vocabulary matching. No network, no key, no failure mode.
//   claude - an optional Claude API pass for messy input, used only when ANTHROPIC_API_KEY
//            is set. Its output is re-validated against the same allowlists the rules engine
//            uses, so the model can never introduce a category or office the report form
//            would reject. Any failure (no key, timeout, bad JSON, HTTP error) falls back
//            to the deterministic result.
//
// Nothing here writes data. The caller validates and saves through the normal report route.

const CATEGORIES = [
  'Electronics',
  'Water Bottles/Tumblers',
  'Clothing & Accessories',
  'Books & Documents',
  'Bags & Wallets',
  'Keys',
  'Jewelry',
  'Sports Equipment',
  'School Supplies',
  'ID / Cards',
  'Others',
];

// Keyword -> category. Includes Filipino terms and the brand names students actually type.
// Longer keywords win, so "apple watch" beats "watch" and "water bottle" beats "bottle".
const CATEGORY_KEYWORDS = {
  Electronics: [
    'cellphone',
    'cell phone',
    'mobile phone',
    'phone',
    'smartphone',
    'iphone',
    'android',
    'samsung',
    'oppo',
    'vivo',
    'realme',
    'xiaomi',
    'redmi',
    'infinix',
    'huawei',
    'tecno',
    'laptop',
    'macbook',
    'notebook computer',
    'tablet',
    'ipad',
    'kindle',
    'charger',
    'adapter',
    'power bank',
    'powerbank',
    'usb',
    'flash drive',
    'flashdrive',
    'usb drive',
    'hard drive',
    'memory card',
    'sd card',
    'earphone',
    'earphones',
    'earpods',
    'airpods',
    'earbuds',
    'headset',
    'headphone',
    'headphones',
    'speaker',
    'bluetooth speaker',
    'mouse',
    'keyboard',
    'calculator',
    'scientific calculator',
    'smartwatch',
    'smart watch',
    'apple watch',
    'camera',
    'dslr',
    'e-reader',
  ],
  'Water Bottles/Tumblers': [
    'aquaflask',
    'aqua flask',
    'hydroflask',
    'hydro flask',
    'tumbler',
    'water bottle',
    'waterbottle',
    'water jug',
    'thermos',
    'flask',
    'sipper',
    'drinking bottle',
    'bote',
    'bottle',
  ],
  'Clothing & Accessories': [
    'jacket',
    'hoodie',
    'sweater',
    'cardigan',
    'windbreaker',
    'raincoat',
    'shirt',
    't-shirt',
    'tshirt',
    'polo',
    'blouse',
    'uniform',
    'pe uniform',
    'sando',
    'pants',
    'shorts',
    'jeans',
    'skirt',
    'socks',
    'belt',
    'scarf',
    'handkerchief',
    'cap',
    'hat',
    'bucket hat',
    'shoes',
    'sneakers',
    'rubber shoes',
    'sandals',
    'slippers',
    'tsinelas',
    'flip flops',
    'towel',
    'face mask',
    'umbrella',
    'payong',
    'eyeglasses',
    'eye glasses',
    'glasses',
    'sunglasses',
    'shades',
    'salamin',
  ],
  'Books & Documents': [
    'book',
    'libro',
    'textbook',
    'notebook',
    'note book',
    'journal',
    'module',
    'handout',
    'reviewer',
    'folder',
    'envelope',
    'long envelope',
    'brown envelope',
    'document',
    'documents',
    'papers',
    'thesis',
    'manuscript',
    'transcript',
    'certificate',
    'diploma',
    'receipt',
    'planner',
    'logbook',
    'clearance',
  ],
  'Bags & Wallets': [
    'backpack',
    'back pack',
    'bagpack',
    'bag',
    'shoulder bag',
    'sling bag',
    'slingbag',
    'handbag',
    'tote bag',
    'tote',
    'pouch',
    'luggage',
    'suitcase',
    'duffel',
    'wallet',
    'pitaka',
    'purse',
    'coin purse',
    'card holder',
    'cardholder',
    'jansport',
    'herschel',
    'eastpak',
  ],
  Keys: [
    'keys',
    'key',
    'susi',
    'keychain',
    'key chain',
    'key ring',
    'keyring',
    'motorcycle key',
    'motor key',
    'car key',
    'house key',
    'padlock',
    'padlock key',
  ],
  Jewelry: [
    'ring',
    'singsing',
    'necklace',
    'kwintas',
    'bracelet',
    'pulseras',
    'anklet',
    'earring',
    'earrings',
    'hikaw',
    'pendant',
    'locket',
    'brooch',
    'wristwatch',
    'wrist watch',
    'watch',
    'relo',
  ],
  'Sports Equipment': [
    'basketball',
    'volleyball',
    'football',
    'soccer ball',
    'ball',
    'racket',
    'racquet',
    'badminton racket',
    'shuttlecock',
    'jersey',
    'shin guard',
    'knee pad',
    'boxing gloves',
    'gloves',
    'dumbbell',
    'skipping rope',
    'jump rope',
    'chess set',
    'table tennis',
    'ping pong',
    'cleats',
    'spikes',
  ],
  'School Supplies': [
    'ballpen',
    'ball pen',
    'pen',
    'pencil',
    'lapis',
    'mechanical pencil',
    'eraser',
    'ruler',
    'protractor',
    'compass',
    'highlighter',
    'marker',
    'whiteboard marker',
    'correction tape',
    'sharpener',
    'scissors',
    'stapler',
    'crayons',
    'colored pencils',
    'art materials',
    'sketchpad',
    'sketch pad',
    'drawing board',
    'clipboard',
    'pencil case',
    'lunch box',
    'lunchbox',
    'tupperware',
    'baon',
  ],
  'ID / Cards': [
    'school id',
    'student id',
    'id card',
    'identification card',
    'id',
    'atm card',
    'atm',
    'debit card',
    'credit card',
    'bank card',
    'gcash card',
    "driver's license",
    'drivers license',
    'license',
    'philhealth',
    'sss',
    'pag-ibig',
    'tin id',
    'postal id',
    'voter id',
    'voters id',
    'nbi clearance',
    'library card',
    'pwd id',
    'vaccine card',
    'cor',
  ],
};

// Keyword -> exactly the <option> value the report form offers, so a parsed location is
// always selectable. Keep these values identical to the location select in public/index.html.
const LOCATION_KEYWORDS = [
  {
    value: 'Learning Resources and Development (Library)',
    keys: ['library', 'aklatan', 'lrdc', 'reading area', 'lib'],
  },
  {
    value: 'Production and Auxiliary Services (Canteen / Commercial)',
    keys: ['canteen', 'cafeteria', 'kantina', 'food court', 'carinderia', 'eatery'],
  },
  {
    value: 'Sports Development Unit (Gymnasium)',
    keys: ['gymnasium', 'gym', 'covered court', 'basketball court', 'court', 'sports complex', 'bleachers'],
  },
  {
    value: 'College of Computer Studies (CCS)',
    keys: [
      'college of computer studies',
      'computer studies',
      'ccs building',
      'ccs',
      'computer laboratory',
      'computer lab',
      'comlab',
      'com lab',
    ],
  },
  {
    value: 'College of Engineering and Architecture (CEA)',
    keys: ['college of engineering', 'engineering building', 'engineering', 'architecture', 'cea'],
  },
  {
    value: 'College of Health Sciences (CHS)',
    keys: ['college of health sciences', 'health sciences', 'nursing building', 'nursing', 'midwifery', 'chs'],
  },
  {
    value: 'College of Tourism, Hospitality and Business Management (CTHBM)',
    keys: ['cthbm', 'tourism', 'hospitality', 'hotel and restaurant', 'hrm', 'business management'],
  },
  {
    value: 'College of Technological and Developmental Education (CTDE)',
    keys: ['ctde', 'developmental education', 'education building', 'teacher education'],
  },
  {
    value: 'College of Arts and Sciences (CAS)',
    keys: ['college of arts and sciences', 'arts and sciences', 'cas building', 'cas'],
  },
  { value: 'Graduate School', keys: ['graduate school', 'grad school'] },
  { value: 'Buhi Campus', keys: ['buhi campus', 'buhi'] },
  { value: 'Student Affairs and Services (SAS)', keys: ['student affairs', 'sas office', 'sas'] },
  {
    value: 'Student Registration and Records (Registrar)',
    keys: ['registrar', 'records office', 'registration office'],
  },
  { value: 'Guidance and Counseling Unit', keys: ['guidance', 'counseling', 'counselling'] },
  {
    value: 'Health Services Unit (Campus Clinic)',
    keys: ['campus clinic', 'clinic', 'infirmary', 'health services', 'nurse station'],
  },
  {
    value: 'General Services Unit (GSU / Security Desk)',
    keys: ['security desk', 'security guard', 'guard house', 'guardhouse', 'guard', 'security office', 'gsu'],
  },
  { value: 'Information and Communications Technology Unit (ICTU)', keys: ['ictu', 'ict office', 'ict unit'] },
  { value: 'Cash Unit', keys: ['cashier', 'cash unit', 'payment window'] },
  { value: 'Accounting Unit', keys: ['accounting'] },
  { value: 'Human Resource Management and Development Unit', keys: ['human resource', 'hr office', 'hrmd'] },
  { value: 'National Service Training Program (NSTP)', keys: ['nstp', 'rotc', 'cwts'] },
  { value: 'Cultural Affairs Unit', keys: ['cultural affairs', 'cultural office'] },
  { value: 'Student Testing and Admission', keys: ['testing center', 'admission office', 'admissions'] },
  { value: 'Training and Assessment Center', keys: ['training center', 'assessment center'] },
  { value: 'Office of the President', keys: ['office of the president', "president's office", 'presidents office'] },
  { value: 'Research Development Services Office', keys: ['research office', 'research development'] },
  { value: 'Extension and Community Services Office', keys: ['extension office', 'community services'] },
  { value: 'Campus Parking Area', keys: ['parking area', 'parking lot', 'parking', 'motor parking', 'bike rack'] },
  { value: 'Campus Main Gate / Entrance', keys: ['main gate', 'entrance gate', 'front gate', 'gate', 'entrance'] },
  {
    value: 'Campus Main Grounds / Quadrangle',
    keys: [
      'quadrangle',
      'quad',
      'campus grounds',
      'grounds',
      'oval',
      'plaza',
      'walkway',
      'corridor',
      'hallway',
      'stairs',
      'comfort room',
      'restroom',
    ],
  },
];

const COLORS = [
  'black',
  'white',
  'blue',
  'navy blue',
  'navy',
  'light blue',
  'sky blue',
  'red',
  'maroon',
  'green',
  'dark green',
  'light green',
  'mint green',
  'yellow',
  'orange',
  'pink',
  'hot pink',
  'violet',
  'purple',
  'lavender',
  'brown',
  'beige',
  'cream',
  'gray',
  'grey',
  'silver',
  'gold',
  'rose gold',
  'gunmetal',
  'transparent',
  'itim',
  'puti',
  'pula',
  'asul',
  'dilaw',
  'berde',
];

const BRANDS = [
  'AquaFlask',
  'Hydro Flask',
  'Hydroflask',
  'Nalgene',
  'Tupperware',
  'Apple',
  'iPhone',
  'Samsung',
  'Oppo',
  'Vivo',
  'Realme',
  'Xiaomi',
  'Redmi',
  'Infinix',
  'Huawei',
  'Tecno',
  'Nokia',
  'Acer',
  'Asus',
  'Lenovo',
  'Dell',
  'MSI',
  'MacBook',
  'Casio',
  'Canon',
  'Nikon',
  'JBL',
  'Anker',
  'Baseus',
  'Oraimo',
  'Romoss',
  'JanSport',
  'Herschel',
  'Eastpak',
  'Nike',
  'Adidas',
  'Puma',
  'Skechers',
  'Converse',
  'Vans',
  'Crocs',
  'Uniqlo',
  'Penshoppe',
  'Bench',
  'Oxygen',
  'Tribal',
  'Titus',
  'Fossil',
  'Seiko',
  'Mongol',
  'Pilot',
  'Stabilo',
  'Faber-Castell',
];

const LOST_PHRASES = [
  'i lost',
  'ive lost',
  'i have lost',
  'lost my',
  'lost a',
  'lost an',
  'lost the',
  'i misplaced',
  'misplaced my',
  'i left',
  'left my',
  'naiwan',
  'nawala',
  'nawawala',
  'nalimutan',
  'hindi ko makita',
  'di ko makita',
  'cant find',
  'can not find',
  'could not find',
  'missing',
  'nalaglag',
];

const FOUND_PHRASES = [
  'i found',
  'ive found',
  'i have found',
  'found a',
  'found an',
  'found this',
  'found someone',
  'someone left',
  'somebody left',
  'i picked up',
  'picked up',
  'nakita ko',
  'nakakita',
  'nahanap ko',
  'nahanap',
  'napulot',
  'nakapulot',
  'nakuha ko',
  'may nakita',
  'turned over',
  'turned in',
  'surrendered',
];

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^a-z0-9'\/:\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Whole-phrase match, so "id" does not fire inside "identify" and "gym" not inside "gymnast".
function containsPhrase(haystack, phrase) {
  const target = String(phrase || '').toLowerCase();
  if (!target) return false;
  let from = 0;
  while (from <= haystack.length) {
    const at = haystack.indexOf(target, from);
    if (at === -1) return false;
    const before = at === 0 ? ' ' : haystack[at - 1];
    const after = at + target.length >= haystack.length ? ' ' : haystack[at + target.length];
    if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)) return true;
    from = at + 1;
  }
  return false;
}

function detectType(text) {
  let lostHit = '';
  let foundHit = '';
  for (const phrase of LOST_PHRASES) {
    if (containsPhrase(text, phrase) && phrase.length > lostHit.length) lostHit = phrase;
  }
  for (const phrase of FOUND_PHRASES) {
    if (containsPhrase(text, phrase) && phrase.length > foundHit.length) foundHit = phrase;
  }
  if (lostHit && !foundHit) return { type: 'lost', confidence: 0.95, evidence: lostHit };
  if (foundHit && !lostHit) return { type: 'found', confidence: 0.95, evidence: foundHit };
  // Both present ("I found a lost wallet") - trust the longer, more specific phrase.
  if (lostHit && foundHit) {
    const type = foundHit.length >= lostHit.length ? 'found' : 'lost';
    return { type, confidence: 0.55, evidence: type === 'found' ? foundHit : lostHit };
  }
  return { type: '', confidence: 0, evidence: '' };
}

function detectCategory(text) {
  let best = { category: '', keyword: '', score: 0 };
  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    for (const keyword of keywords) {
      if (!containsPhrase(text, keyword)) continue;
      // Specificity = keyword length, so "apple watch" (11) outranks "watch" (5).
      if (keyword.length > best.score) best = { category, keyword, score: keyword.length };
    }
  }
  if (!best.category) return { category: '', confidence: 0, evidence: '' };
  const confidence = best.score >= 8 ? 0.92 : best.score >= 5 ? 0.8 : 0.62;
  return { category: best.category, confidence, evidence: best.keyword };
}

function detectLocation(text) {
  let best = { value: '', keyword: '', score: 0 };
  for (const entry of LOCATION_KEYWORDS) {
    for (const keyword of entry.keys) {
      if (!containsPhrase(text, keyword)) continue;
      if (keyword.length > best.score) best = { value: entry.value, keyword, score: keyword.length };
    }
  }
  if (!best.value) return { location: '', confidence: 0, evidence: '' };
  const confidence = best.score >= 7 ? 0.9 : best.score >= 4 ? 0.78 : 0.6;
  return { location: best.value, confidence, evidence: best.keyword };
}

function atHour(date, hour) {
  const copy = new Date(date);
  copy.setHours(hour, 0, 0, 0);
  return copy;
}

// Returns an ISO timestamp that is never in the future, plus the phrase it came from.
function detectWhen(text, now = new Date()) {
  const partOfDay = /\b(morning|umaga|dawn)\b/.test(text)
    ? 8
    : /\b(noon|lunch|tanghali|lunchtime)\b/.test(text)
      ? 12
      : /\b(afternoon|hapon)\b/.test(text)
        ? 14
        : /\b(evening|tonight|gabi|night)\b/.test(text)
          ? 19
          : null;

  const relative = text.match(/\b(\d{1,2})\s*(minutes|minute|mins|min|hours|hour|hrs|hr|days|day)\s*ago\b/);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2];
    const ms = /^min/.test(unit) ? 60000 : /^(hour|hr)/.test(unit) ? 3600000 : 86400000;
    return {
      when: new Date(now.getTime() - amount * ms).toISOString(),
      confidence: 0.9,
      evidence: relative[0],
    };
  }

  if (/\b(just now|right now|a while ago|kanina lang|ngayon lang|kanina)\b/.test(text)) {
    return { when: now.toISOString(), confidence: 0.8, evidence: 'just now' };
  }

  const dayBefore = /\b(day before yesterday)\b/.test(text);
  const yesterday = /\b(yesterday|kahapon)\b/.test(text);
  if (dayBefore || yesterday) {
    const base = new Date(now);
    base.setDate(base.getDate() - (dayBefore ? 2 : 1));
    return {
      when: atHour(base, partOfDay === null ? 12 : partOfDay).toISOString(),
      confidence: 0.85,
      evidence: dayBefore ? 'day before yesterday' : 'yesterday',
    };
  }

  // "last friday" / "friday" -> the most recent occurrence that is not in the future.
  const weekdayMatch = text.match(
    /\b(?:last\s+|noong\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/
  );
  if (weekdayMatch) {
    const target = WEEKDAYS.indexOf(weekdayMatch[1]);
    const base = new Date(now);
    let back = (base.getDay() - target + 7) % 7;
    if (back === 0 && /\blast\b/.test(weekdayMatch[0])) back = 7;
    base.setDate(base.getDate() - back);
    return {
      when: atHour(base, partOfDay === null ? 12 : partOfDay).toISOString(),
      confidence: 0.75,
      evidence: weekdayMatch[0].trim(),
    };
  }

  // "november 14" / "nov 14" / "14 november"
  const monthNames =
    'jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december';
  const monthDay =
    text.match(new RegExp(`\\b(${monthNames})\\s+(\\d{1,2})\\b`)) ||
    text.match(new RegExp(`\\b(\\d{1,2})\\s+(${monthNames})\\b`));
  if (monthDay) {
    const monthToken = /^\d/.test(monthDay[1]) ? monthDay[2] : monthDay[1];
    const dayToken = /^\d/.test(monthDay[1]) ? monthDay[1] : monthDay[2];
    const monthIndex = MONTHS.findIndex((name) => name.startsWith(monthToken.slice(0, 3)));
    const day = Number(dayToken);
    if (monthIndex !== -1 && day >= 1 && day <= 31) {
      const hour = partOfDay === null ? 12 : partOfDay;
      let when = new Date(now.getFullYear(), monthIndex, day, hour, 0, 0, 0);
      // A date later in the year than today means the student meant last year.
      if (when.getTime() > now.getTime()) when = new Date(now.getFullYear() - 1, monthIndex, day, hour, 0, 0, 0);
      return { when: when.toISOString(), confidence: 0.8, evidence: monthDay[0] };
    }
  }

  if (/\b(last week|nakaraang linggo)\b/.test(text)) {
    const base = new Date(now);
    base.setDate(base.getDate() - 7);
    return { when: atHour(base, 12).toISOString(), confidence: 0.5, evidence: 'last week' };
  }

  if (partOfDay !== null || /\b(today|ngayong araw)\b/.test(text)) {
    let when = atHour(now, partOfDay === null ? 12 : partOfDay);
    // "this morning" typed at 7am: the named hour has not arrived, so use now instead.
    if (when.getTime() > now.getTime()) when = new Date(now);
    return { when: when.toISOString(), confidence: partOfDay === null ? 0.6 : 0.8, evidence: 'today' };
  }

  return { when: '', confidence: 0, evidence: '' };
}

function detectColor(text) {
  let best = '';
  for (const color of COLORS) {
    if (containsPhrase(text, color) && color.length > best.length) best = color;
  }
  return best;
}

function detectBrand(text) {
  let best = '';
  for (const brand of BRANDS) {
    if (containsPhrase(text, brand.toLowerCase()) && brand.length > best.length) best = brand;
  }
  return best;
}

// Words students write in caps. Without this, "school id" title-cases to "School Id".
const ACRONYMS = new Set([
  'id',
  'ids',
  'atm',
  'usb',
  'sss',
  'tin',
  'cor',
  'nbi',
  'pwd',
  'dslr',
  'sd',
  'pe',
  'tor',
  'cr',
  'ccs',
  'cea',
  'chs',
  'cas',
  'ctde',
  'cthbm',
  'nstp',
  'rotc',
  'cwts',
]);

function titleCase(value) {
  return String(value || '')
    .split(' ')
    .filter(Boolean)
    .map((word) =>
      ACRONYMS.has(word.toLowerCase()) ? word.toUpperCase() : word.charAt(0).toUpperCase() + word.slice(1)
    )
    .join(' ');
}

// Builds "Black AquaFlask Tumbler" from the colour, brand and the noun the category matched.
function buildTitle({ color, brand, noun }) {
  const parts = [];
  if (color) parts.push(titleCase(color));
  if (brand) parts.push(brand);
  if (noun && (!brand || !brand.toLowerCase().includes(noun.toLowerCase()))) {
    parts.push(titleCase(noun));
  }
  const title = parts.join(' ').replace(/\s+/g, ' ').trim();
  if (title.length < 3) return '';
  return title.slice(0, 100);
}

// Only text that follows an explicit "description is ..." (or "description: ...") cue is
// treated as the free-form description - an open narration like "I lost my black tumbler
// near the library" fills the other fields but must not be dumped word-for-word in here.
function detectDescription(rawText) {
  const match = String(rawText || '').match(/\bdescription\b\s*(?:is|:|-|=)?\s*(.+)/is);
  return match ? match[1].trim() : '';
}

// A location mention is usually "near the library", not a room. Any room-ish detail is kept
// separately so it lands in the optional "Room or Specific Spot" field instead.
function detectLocationDetails(rawText) {
  const room = String(rawText || '').match(
    /\b(?:room|rm\.?|lab|laboratory|bldg\.?|building|floor)\s*#?\s*([a-z]?-?\d{1,4}[a-z]?)\b/i
  );
  if (room) return titleCase(room[0].replace(/\s+/g, ' ').trim()).slice(0, 150);
  return '';
}

/**
 * Deterministic extraction. No network, no key, no failure mode - this is what the live
 * demo falls back to and what the tests assert against.
 */
function parseWithRules(message, now = new Date()) {
  const raw = String(message || '').slice(0, 1000);
  const text = normalize(raw);

  const type = detectType(text);
  const category = detectCategory(text);
  const location = detectLocation(text);
  const when = detectWhen(text, now);
  const color = detectColor(text);
  const brand = detectBrand(text);
  const title = buildTitle({ color, brand, noun: category.evidence });

  return {
    engine: 'rules',
    draft: {
      type: type.type,
      title,
      category: category.category,
      location: location.location,
      locationDetails: detectLocationDetails(raw),
      desc: detectDescription(raw),
      when: when.when,
    },
    confidence: {
      type: type.confidence,
      title: title ? Math.min(0.9, 0.45 + (color ? 0.2 : 0) + (brand ? 0.25 : 0)) : 0,
      category: category.confidence,
      location: location.confidence,
      when: when.confidence,
    },
    evidence: {
      type: type.evidence,
      category: category.evidence,
      location: location.evidence,
      when: when.evidence,
      color,
      brand,
    },
  };
}

const CLAUDE_MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5';
const CLAUDE_TIMEOUT_MS = 8000;

function claudeConfigured() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

function buildPrompt(message) {
  return [
    'Extract a campus lost-and-found report from the student message below.',
    '',
    'Reply with ONLY a JSON object, no prose and no code fence, using these keys:',
    '  "type": "lost" or "found", or "" if unclear',
    '  "title": a short item name, 3-100 characters, like "Black AquaFlask Tumbler"',
    '  "category": EXACTLY one of these, or "":',
    CATEGORIES.map((value) => `    - ${value}`).join('\n'),
    '  "location": EXACTLY one of these campus offices, or "" if none is mentioned:',
    LOCATION_KEYWORDS.map((entry) => `    - ${entry.value}`).join('\n'),
    '  "locationDetails": a room or specific spot if stated, else ""',
    '  "when": an ISO 8601 timestamp if a time is stated, else ""',
    '',
    'Never invent a category or location that is not on those lists; use "" instead.',
    'Never invent details the student did not state.',
    '',
    `Student message: ${JSON.stringify(String(message || '').slice(0, 1000))}`,
  ].join('\n');
}

async function callClaude(message) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CLAUDE_TIMEOUT_MS);
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 512,
        temperature: 0,
        messages: [{ role: 'user', content: buildPrompt(message) }],
      }),
    });
    if (!response.ok) throw new Error(`Claude API responded ${response.status}`);
    const payload = await response.json();
    const text = (payload.content || [])
      .filter((block) => block && block.type === 'text')
      .map((block) => block.text)
      .join('')
      .trim();
    const json = text
      .replace(/^```(?:json)?/i, '')
      .replace(/```$/, '')
      .trim();
    return JSON.parse(json);
  } finally {
    clearTimeout(timer);
  }
}

// The model's output is advisory: every field is re-checked against the same allowlists the
// form enforces, so a hallucinated office or category is dropped rather than shown.
function mergeModelResult(base, model, now = new Date()) {
  const merged = {
    engine: 'claude',
    draft: { ...base.draft },
    confidence: { ...base.confidence },
    evidence: { ...base.evidence },
  };

  if (model.type === 'lost' || model.type === 'found') {
    merged.draft.type = model.type;
    merged.confidence.type = Math.max(base.confidence.type, 0.9);
  }

  const title = typeof model.title === 'string' ? model.title.trim().slice(0, 100) : '';
  if (title.length >= 3) {
    merged.draft.title = title;
    merged.confidence.title = 0.9;
  }

  if (CATEGORIES.includes(model.category)) {
    merged.draft.category = model.category;
    merged.confidence.category = Math.max(base.confidence.category, 0.9);
  }

  if (LOCATION_KEYWORDS.some((entry) => entry.value === model.location)) {
    merged.draft.location = model.location;
    merged.confidence.location = Math.max(base.confidence.location, 0.9);
  }

  const details = typeof model.locationDetails === 'string' ? model.locationDetails.trim().slice(0, 150) : '';
  if (details) merged.draft.locationDetails = details;

  if (typeof model.when === 'string' && model.when) {
    const parsed = Date.parse(model.when);
    // Reject unparseable or future timestamps; a report cannot be about tomorrow.
    if (Number.isFinite(parsed) && parsed <= now.getTime() + 60000) {
      merged.draft.when = new Date(parsed).toISOString();
      merged.confidence.when = Math.max(base.confidence.when, 0.88);
    }
  }

  return merged;
}

/**
 * Parse a student's sentence into a draft report.
 * Always resolves: Claude when a key is configured, rules otherwise or on any failure.
 */
async function parseReportMessage(message, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const base = parseWithRules(message, now);
  if (!claudeConfigured() || options.engine === 'rules') return base;

  try {
    const model = await callClaude(message);
    if (!model || typeof model !== 'object') return base;
    return mergeModelResult(base, model, now);
  } catch (error) {
    // Offline, rate-limited, bad key or malformed reply: the deterministic result stands.
    console.warn('Report assistant fell back to the rules engine:', error.message);
    return { ...base, engine: 'rules', fallback: true };
  }
}

const FIELD_QUESTIONS = {
  type: 'Did you lose this item, or did you find it?',
  title: 'What is the item? A short name is enough, like "black AquaFlask tumbler".',
  category: 'Which category fits it best?',
  location: 'Which CSPC office or campus area was it lost or found at?',
  desc: 'Can you describe it in a sentence or two?',
};

const FIELD_ORDER = ['type', 'title', 'category', 'location', 'desc'];

/**
 * Which required fields are still empty, and the one question to ask next. Low-confidence
 * fields are filled in but flagged, so the student can correct them before submitting.
 */
function reviewDraft(result) {
  const draft = (result && result.draft) || {};
  const confidence = (result && result.confidence) || {};

  const missing = FIELD_ORDER.filter((field) => {
    const value = String(draft[field] || '').trim();
    if (field === 'desc') return value.length < 5;
    if (field === 'title') return value.length < 3;
    return !value;
  });

  const uncertain = FIELD_ORDER.filter(
    (field) =>
      !missing.includes(field) &&
      typeof confidence[field] === 'number' &&
      confidence[field] > 0 &&
      confidence[field] < 0.7
  );

  return {
    missing,
    uncertain,
    question: missing.length ? FIELD_QUESTIONS[missing[0]] : '',
    ready: missing.length === 0,
  };
}

module.exports = {
  parseReportMessage,
  parseWithRules,
  reviewDraft,
  claudeConfigured,
  CATEGORIES,
  LOCATION_KEYWORDS,
  // Exported for the tests.
  __internals: {
    normalize,
    containsPhrase,
    detectType,
    detectCategory,
    detectLocation,
    detectWhen,
    detectDescription,
    buildTitle,
    mergeModelResult,
  },
};
