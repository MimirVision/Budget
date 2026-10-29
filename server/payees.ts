/**
 * Turns raw bank text like "VISA VARE 123456*1234 12.10 NOK 349,90 REMA 1000 GRIMSTAD Kurs: 1.0000"
 * into a readable payee ("Rema 1000"), and knows which category common Norwegian merchants belong to.
 */

const PREFIXES = [
  /^visa\s+vare\b/i,
  /^visa\b/i,
  /^mastercard\b/i,
  /^varekjøp\b/i,
  /^kortkjøp\b/i,
  /^kjøp\b/i,
  /^reservasjon\b/i,
  /^reservert\b/i,
  /^nettgiro\s+(til|fra)\s*:?/i,
  /^nettgiro\b/i,
  /^avtalegiro\b/i,
  /^efaktura\b/i,
  /^e-faktura\b/i,
  /^straksbetaling\b/i,
  /^overføring\s+(til|fra)\b/i,
  /^giro\b/i,
  /^betaling\b/i,
  /^apple\s*pay\b/i,
  /^google\s*pay\b/i,
  /^vipps\s*\*?/i,
  /^vipps:/i,
  /^til\s*:/i,
  /^fra\s*:/i,
  /^card\s+payment\s+to\b/i,
  /^payment\s+(to|from)\b/i,
];

const NOISE = [
  /\bkurs:?\s*[\d.,]+/gi, // exchange rate
  /\b(nok|eur|usd|sek|dkk|gbp)\s*-?[\d\s.]+,\d{2}\b/gi, // "NOK 349,90"
  /\b(betalt|bokført|dato):?\s*\d{2}\.\d{2}(\.\d{2,4})?/gi,
  /\*+\d{2,}/g, // masked card numbers
  /\b\d{6,}\b/g, // long reference numbers
  /\b\d{2}\.\d{2}(\.\d{2,4})?\b/g, // dates
  /\b\d{2}:\d{2}(:\d{2})?\b/g, // times
  /\bvaluta(dato)?\b/gi,
];

// Order matters: first match wins. `name` is the display name, `category` the default category name.
const MERCHANTS: Array<{ re: RegExp; name: string; category?: string; generic?: boolean }> = [
  // Not a merchant, just tidier names
  { re: /top-?up\s+by/i, name: 'Revolut top-up' },
  // Groceries
  { re: /rema\s*1000/i, name: 'Rema 1000', category: 'Groceries' },
  { re: /\bkiwi\b/i, name: 'Kiwi', category: 'Groceries' },
  { re: /coop\s*extra|\bextra\b/i, name: 'Coop Extra', category: 'Groceries' },
  { re: /coop\s*mega/i, name: 'Coop Mega', category: 'Groceries' },
  { re: /coop\s*prix/i, name: 'Coop Prix', category: 'Groceries' },
  { re: /coop\s*obs|\bobs\b(?!\s*bygg)/i, name: 'Obs', category: 'Groceries' },
  { re: /\bcoop\b/i, name: 'Coop', category: 'Groceries' },
  { re: /\bmeny\b/i, name: 'Meny', category: 'Groceries' },
  { re: /\bspar\b/i, name: 'Spar', category: 'Groceries' },
  { re: /\bjoker\b/i, name: 'Joker', category: 'Groceries' },
  { re: /bunnpris/i, name: 'Bunnpris', category: 'Groceries' },
  { re: /oda\.com|\boda\b/i, name: 'Oda', category: 'Groceries' },
  { re: /\blidl\b/i, name: 'Lidl', category: 'Groceries' },
  // Eating out
  { re: /\bwolt\b/i, name: 'Wolt', category: 'Eating out' },
  { re: /foodora/i, name: 'Foodora', category: 'Eating out' },
  { re: /mcdonald|mc\s*donald/i, name: "McDonald's", category: 'Eating out' },
  { re: /burger\s*king/i, name: 'Burger King', category: 'Eating out' },
  { re: /peppes/i, name: 'Peppes Pizza', category: 'Eating out' },
  { re: /dolly\s*dimple/i, name: "Dolly Dimple's", category: 'Eating out' },
  { re: /espresso\s*house/i, name: 'Espresso House', category: 'Eating out' },
  { re: /starbucks/i, name: 'Starbucks', category: 'Eating out' },
  { re: /narvesen/i, name: 'Narvesen', category: 'Eating out' },
  { re: /7-?eleven/i, name: '7-Eleven', category: 'Eating out' },
  { re: /max\s*burger/i, name: 'Max Burgers', category: 'Eating out' },
  // Transport & fuel
  { re: /circle\s*k/i, name: 'Circle K', category: 'Transport & Fuel' },
  { re: /uno-?x/i, name: 'Uno-X', category: 'Transport & Fuel' },
  { re: /\besso\b/i, name: 'Esso', category: 'Transport & Fuel' },
  { re: /\bshell\b/i, name: 'Shell', category: 'Transport & Fuel' },
  { re: /\byx\b/i, name: 'YX', category: 'Transport & Fuel' },
  { re: /\bruter\b/i, name: 'Ruter', category: 'Transport & Fuel' },
  { re: /\bvy\b/i, name: 'Vy', category: 'Transport & Fuel' },
  { re: /\bakt\b|agder\s*kollektiv/i, name: 'AKT', category: 'Transport & Fuel' },
  { re: /easypark/i, name: 'EasyPark', category: 'Transport & Fuel' },
  { re: /autopass|fjellinjen|ferde|bompenger/i, name: 'Tolls (AutoPASS)', category: 'Transport & Fuel' },
  { re: /tesla\s*supercharg/i, name: 'Tesla Supercharger', category: 'Transport & Fuel' },
  { re: /recharge|mer\s*norway|elton|ionity/i, name: 'EV charging', category: 'Transport & Fuel' },
  // Household & pharmacy
  { re: /apotek\s*1/i, name: 'Apotek 1', category: 'Household & Pharmacy' },
  { re: /vitusapotek/i, name: 'Vitusapotek', category: 'Household & Pharmacy' },
  { re: /boots\s*apotek/i, name: 'Boots Apotek', category: 'Household & Pharmacy' },
  { re: /europris/i, name: 'Europris', category: 'Household & Pharmacy' },
  { re: /\bnormal\b/i, name: 'Normal', category: 'Household & Pharmacy' },
  { re: /clas\s*ohlson/i, name: 'Clas Ohlson', category: 'Household & Pharmacy' },
  { re: /\bikea\b/i, name: 'IKEA', category: 'Household & Pharmacy' },
  { re: /\bjysk\b/i, name: 'Jysk', category: 'Household & Pharmacy' },
  { re: /biltema/i, name: 'Biltema', category: 'Household & Pharmacy' },
  { re: /\bjula\b/i, name: 'Jula', category: 'Household & Pharmacy' },
  { re: /obs\s*bygg|byggmax|maxbo|monter|montér|byggmakker|xl-bygg/i, name: 'Hardware store', category: 'Home maintenance' },
  // Clothing
  { re: /\bh\s*&\s*m\b|hennes\s*&?\s*mauritz/i, name: 'H&M', category: 'Clothing' },
  { re: /cubus/i, name: 'Cubus', category: 'Clothing' },
  { re: /dressmann/i, name: 'Dressmann', category: 'Clothing' },
  { re: /\bzara\b/i, name: 'Zara', category: 'Clothing' },
  { re: /lindex/i, name: 'Lindex', category: 'Clothing' },
  { re: /kappahl/i, name: 'KappAhl', category: 'Clothing' },
  { re: /zalando/i, name: 'Zalando', category: 'Clothing' },
  { re: /\bxxl\b/i, name: 'XXL', category: 'Hobbies & Sport' },
  { re: /sport\s*1|intersport|g-?sport/i, name: 'Sports store', category: 'Hobbies & Sport' },
  // Subscriptions
  { re: /netflix/i, name: 'Netflix', category: 'Subscriptions' },
  { re: /spotify/i, name: 'Spotify', category: 'Subscriptions' },
  { re: /viaplay/i, name: 'Viaplay', category: 'Subscriptions' },
  { re: /hbo|max\.com/i, name: 'Max', category: 'Subscriptions' },
  { re: /disney\s*plus|disney\+|disneyplus/i, name: 'Disney+', category: 'Subscriptions' },
  { re: /tv\s*2\s*play/i, name: 'TV 2 Play', category: 'Subscriptions' },
  { re: /youtube\s*premium|google\s*\*?youtube/i, name: 'YouTube Premium', category: 'Subscriptions' },
  { re: /apple\.com\/bill|itunes/i, name: 'Apple', category: 'Subscriptions' },
  { re: /storytel/i, name: 'Storytel', category: 'Subscriptions' },
  // Phone & internet
  { re: /telenor/i, name: 'Telenor', category: 'Internet & Phone' },
  { re: /telia/i, name: 'Telia', category: 'Internet & Phone' },
  { re: /\bice\b|ice\.no/i, name: 'Ice', category: 'Internet & Phone' },
  { re: /talkmore/i, name: 'Talkmore', category: 'Internet & Phone' },
  { re: /altibox/i, name: 'Altibox', category: 'Internet & Phone' },
  { re: /globalconnect/i, name: 'GlobalConnect', category: 'Internet & Phone' },
  // Electricity
  { re: /tibber/i, name: 'Tibber', category: 'Electricity' },
  { re: /fjordkraft/i, name: 'Fjordkraft', category: 'Electricity' },
  { re: /\blyse\b/i, name: 'Lyse', category: 'Electricity' },
  { re: /agder\s*energi|\ba\s*energi\b|motkraft/i, name: 'Agder Energi', category: 'Electricity' },
  { re: /glitre/i, name: 'Glitre', category: 'Electricity' },
  { re: /\belvia\b/i, name: 'Elvia', category: 'Electricity' },
  { re: /\bnorgesenergi\b/i, name: 'NorgesEnergi', category: 'Electricity' },
  { re: /\bdefault\s*energi|\bgreenpower\b/i, name: 'Power supplier', category: 'Electricity' },
  // Insurance
  { re: /gjensidige/i, name: 'Gjensidige', category: 'Insurance' },
  { re: /\btryg\b/i, name: 'Tryg', category: 'Insurance' },
  { re: /fremtind/i, name: 'Fremtind', category: 'Insurance' },
  { re: /\bfrende\b/i, name: 'Frende', category: 'Insurance' },
  { re: /\bif\s*skadeforsikring\b|\bif\s*forsikring\b/i, name: 'If', category: 'Insurance' },
  { re: /storebrand/i, name: 'Storebrand', category: 'Insurance' },
  // Kids / childcare
  { re: /barnehage/i, name: 'Barnehage', category: 'Childcare', generic: true },
  { re: /\bsfo\b|\baks\b/i, name: 'SFO', category: 'Childcare', generic: true },
  // Municipal
  { re: /kommune/i, name: 'Kommune', category: 'Municipal fees', generic: true },
];

/** Removes card/date/reference noise and common Norwegian bank prefixes. */
export function stripNoise(raw: string): string {
  let s = raw.replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 3; i++) {
    const before = s;
    for (const p of PREFIXES) s = s.replace(p, '').trim();
    if (s === before) break;
  }
  for (const n of NOISE) s = s.replace(n, ' ');
  return s.replace(/[*:#]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export function matchMerchant(raw: string): { name: string; category?: string; generic?: boolean } | undefined {
  const m = MERCHANTS.find((x) => x.re.test(raw));
  return m && { name: m.name, category: m.category, generic: m.generic };
}

function titleCase(s: string): string {
  // Only rewrite text that is SHOUTING; leave "iPhone" or "McDonald's" alone.
  if (s !== s.toUpperCase()) return s;
  return s
    .toLowerCase()
    .replace(/(^|[\s\-/&(])([a-zæøå])/g, (_m, sep, ch) => sep + ch.toUpperCase())
    .replace(/\b(As|Asa|Ab|Sa|Da|Ba|Ltd|Inc|Dnb|Tf|Sas|Nav|Bsu|Ikea|Xxl)\b/g, (w) => w.toUpperCase());
}

export function cleanPayee(raw: string): string {
  if (!raw) return '';
  const merchant = matchMerchant(raw);
  // Generic words ("kommune", "barnehage") hint at a category but say too little to replace the name.
  if (merchant && !merchant.generic) return merchant.name;
  const stripped = stripNoise(raw);
  return titleCase(stripped || raw.trim()).slice(0, 80);
}

/** Key used to learn from history: "REMA 1000 GRIMSTAD" and "Rema 1000 Lyngdal" are the same payee. */
export function payeeKey(payee: string): string {
  return payee
    .toLowerCase()
    .replace(/[^a-z0-9æøå ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
