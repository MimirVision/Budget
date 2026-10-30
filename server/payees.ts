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
  { re: /top-?up\s+by/i, name: 'Revolut påfyll' },
  // Groceries
  { re: /rema\s*1000/i, name: 'Rema 1000', category: 'Dagligvarer' },
  { re: /\bkiwi\b/i, name: 'Kiwi', category: 'Dagligvarer' },
  { re: /coop\s*extra|^extra\s+\S/i, name: 'Coop Extra', category: 'Dagligvarer' },
  { re: /coop\s*mega/i, name: 'Coop Mega', category: 'Dagligvarer' },
  { re: /coop\s*prix/i, name: 'Coop Prix', category: 'Dagligvarer' },
  { re: /coop\s*obs|^obs\s+(?!bygg)\S/i, name: 'Obs', category: 'Dagligvarer' },
  { re: /\bcoop\b/i, name: 'Coop', category: 'Dagligvarer' },
  { re: /\bmeny\b/i, name: 'Meny', category: 'Dagligvarer' },
  { re: /eurospar|^spar\s+(?!til\b|konto\b)\S/i, name: 'Spar', category: 'Dagligvarer' },
  { re: /\bjoker\b/i, name: 'Joker', category: 'Dagligvarer' },
  { re: /bunnpris/i, name: 'Bunnpris', category: 'Dagligvarer' },
  { re: /oda\.com|\boda\b/i, name: 'Oda', category: 'Dagligvarer' },
  { re: /\blidl\b/i, name: 'Lidl', category: 'Dagligvarer' },
  // Eating out
  { re: /\bwolt\b/i, name: 'Wolt', category: 'Spise ute' },
  { re: /foodora/i, name: 'Foodora', category: 'Spise ute' },
  { re: /mcdonald|mc\s*donald/i, name: "McDonald's", category: 'Spise ute' },
  { re: /burger\s*king/i, name: 'Burger King', category: 'Spise ute' },
  { re: /peppes/i, name: 'Peppes Pizza', category: 'Spise ute' },
  { re: /dolly\s*dimple/i, name: "Dolly Dimple's", category: 'Spise ute' },
  { re: /espresso\s*house/i, name: 'Espresso House', category: 'Spise ute' },
  { re: /starbucks/i, name: 'Starbucks', category: 'Spise ute' },
  { re: /narvesen/i, name: 'Narvesen', category: 'Spise ute' },
  { re: /7-?eleven/i, name: '7-Eleven', category: 'Spise ute' },
  { re: /max\s*burger/i, name: 'Max Burgers', category: 'Spise ute' },
  // Transport & fuel
  { re: /circle\s*k/i, name: 'Circle K', category: 'Transport og drivstoff' },
  { re: /uno-?x/i, name: 'Uno-X', category: 'Transport og drivstoff' },
  { re: /\besso\b/i, name: 'Esso', category: 'Transport og drivstoff' },
  { re: /\bshell\b/i, name: 'Shell', category: 'Transport og drivstoff' },
  { re: /\byx\b/i, name: 'YX', category: 'Transport og drivstoff' },
  { re: /\bruter\b/i, name: 'Ruter', category: 'Transport og drivstoff' },
  { re: /\bvy\b/i, name: 'Vy', category: 'Transport og drivstoff' },
  { re: /\bakt\b|agder\s*kollektiv/i, name: 'AKT', category: 'Transport og drivstoff' },
  { re: /easypark/i, name: 'EasyPark', category: 'Transport og drivstoff' },
  { re: /autopass|fjellinjen|ferde|bompenger/i, name: 'Bompenger (AutoPASS)', category: 'Transport og drivstoff' },
  { re: /tesla\s*supercharg/i, name: 'Tesla Supercharger', category: 'Transport og drivstoff' },
  { re: /recharge|mer\s*norway|elton|ionity/i, name: 'Elbillading', category: 'Transport og drivstoff' },
  // Household & pharmacy
  { re: /apotek\s*1/i, name: 'Apotek 1', category: 'Hus og apotek' },
  { re: /vitusapotek/i, name: 'Vitusapotek', category: 'Hus og apotek' },
  { re: /boots\s*apotek/i, name: 'Boots Apotek', category: 'Hus og apotek' },
  { re: /europris/i, name: 'Europris', category: 'Hus og apotek' },
  { re: /^normal\s+\S/i, name: 'Normal', category: 'Hus og apotek' },
  { re: /clas\s*ohlson/i, name: 'Clas Ohlson', category: 'Hus og apotek' },
  { re: /\bikea\b/i, name: 'IKEA', category: 'Hus og apotek' },
  { re: /\bjysk\b/i, name: 'Jysk', category: 'Hus og apotek' },
  { re: /biltema/i, name: 'Biltema', category: 'Hus og apotek' },
  { re: /\bjula\b/i, name: 'Jula', category: 'Hus og apotek' },
  { re: /obs\s*bygg|byggmax|maxbo|monter|montér|byggmakker|xl-bygg/i, name: 'Byggvarehus', category: 'Vedlikehold bolig' },
  // Clothing
  { re: /\bh\s*&\s*m\b|hennes\s*&?\s*mauritz/i, name: 'H&M', category: 'Klær' },
  { re: /cubus/i, name: 'Cubus', category: 'Klær' },
  { re: /dressmann/i, name: 'Dressmann', category: 'Klær' },
  { re: /\bzara\b/i, name: 'Zara', category: 'Klær' },
  { re: /lindex/i, name: 'Lindex', category: 'Klær' },
  { re: /kappahl/i, name: 'KappAhl', category: 'Klær' },
  { re: /zalando/i, name: 'Zalando', category: 'Klær' },
  { re: /\bxxl\b/i, name: 'XXL', category: 'Hobby og sport' },
  { re: /sport\s*1|intersport|g-?sport/i, name: 'Sportsbutikk', category: 'Hobby og sport' },
  // Subscriptions
  { re: /netflix/i, name: 'Netflix', category: 'Abonnementer' },
  { re: /spotify/i, name: 'Spotify', category: 'Abonnementer' },
  { re: /viaplay/i, name: 'Viaplay', category: 'Abonnementer' },
  { re: /hbo|max\.com/i, name: 'Max', category: 'Abonnementer' },
  { re: /disney\s*plus|disney\+|disneyplus/i, name: 'Disney+', category: 'Abonnementer' },
  { re: /tv\s*2\s*play/i, name: 'TV 2 Play', category: 'Abonnementer' },
  { re: /youtube\s*premium|google\s*\*?youtube/i, name: 'YouTube Premium', category: 'Abonnementer' },
  { re: /apple\.com\/bill|itunes/i, name: 'Apple', category: 'Abonnementer' },
  { re: /storytel/i, name: 'Storytel', category: 'Abonnementer' },
  // Phone & internet
  { re: /telenor/i, name: 'Telenor', category: 'Internett og mobil' },
  { re: /telia/i, name: 'Telia', category: 'Internett og mobil' },
  { re: /\bice\b|ice\.no/i, name: 'Ice', category: 'Internett og mobil' },
  { re: /talkmore/i, name: 'Talkmore', category: 'Internett og mobil' },
  { re: /altibox/i, name: 'Altibox', category: 'Internett og mobil' },
  { re: /globalconnect/i, name: 'GlobalConnect', category: 'Internett og mobil' },
  // Electricity
  { re: /tibber/i, name: 'Tibber', category: 'Strøm' },
  { re: /fjordkraft/i, name: 'Fjordkraft', category: 'Strøm' },
  { re: /\blyse\b/i, name: 'Lyse', category: 'Strøm' },
  { re: /agder\s*energi|\ba\s*energi\b|motkraft/i, name: 'Agder Energi', category: 'Strøm' },
  { re: /glitre/i, name: 'Glitre', category: 'Strøm' },
  { re: /\belvia\b/i, name: 'Elvia', category: 'Strøm' },
  { re: /\bnorgesenergi\b/i, name: 'NorgesEnergi', category: 'Strøm' },
  { re: /\bdefault\s*energi|\bgreenpower\b/i, name: 'Power supplier', category: 'Strøm' },
  // Insurance
  { re: /gjensidige/i, name: 'Gjensidige', category: 'Forsikring' },
  { re: /\btryg\b/i, name: 'Tryg', category: 'Forsikring' },
  { re: /fremtind/i, name: 'Fremtind', category: 'Forsikring' },
  { re: /\bfrende\b/i, name: 'Frende', category: 'Forsikring' },
  { re: /\bif\s*skadeforsikring\b|\bif\s*forsikring\b/i, name: 'If', category: 'Forsikring' },
  { re: /storebrand/i, name: 'Storebrand', category: 'Forsikring' },
  // Kids / childcare
  { re: /barnehage/i, name: 'Barnehage', category: 'Barnehage og SFO', generic: true },
  { re: /\bsfo\b|\baks\b/i, name: 'SFO', category: 'Barnehage og SFO', generic: true },
  // Municipal
  { re: /kommune/i, name: 'Kommune', category: 'Kommunale avgifter', generic: true },
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

// Money moving between accounts is never a shop, even if it mentions one ("Overføring til spar").
const TRANSFER_TEXT = /overføring|overfør|transfer|innbetaling|egen konto|own account/i;

export function matchMerchant(raw: string): { name: string; category?: string; generic?: boolean } | undefined {
  if (TRANSFER_TEXT.test(raw)) return undefined;
  // Short words like "Spar" or "Extra" only count as the shop when they lead the cleaned-up text
  // ("VISA VARE *1234 SPAR KVADRATUREN" → "SPAR KVADRATUREN"), so ordinary words don't trigger them.
  const cleaned = stripNoise(raw);
  const m = MERCHANTS.find((x) => x.re.test(raw) || x.re.test(cleaned));
  return m && { name: m.name, category: m.category, generic: m.generic };
}

function titleCase(s: string): string {
  // Only rewrite text that is SHOUTING; leave "iPhone" or "McDonald's" alone.
  if (s !== s.toUpperCase()) return s;
  return s
    .toLowerCase()
    .replace(/(^|[\s\-/&(])([a-zæøå])/g, (_m, sep, ch) => sep + ch.toUpperCase())
    .replace(/\b(As|Asa|Ab|Sa|Da|Ba|Ltd|Inc|Dnb|Tf|Sas|Nav|Bsu|Ikea|Xxl)\b/g, (w) => w.toUpperCase())
    // Norwegian small words stay lowercase mid-name: "Lønn fra Arbeidsgiver AS".
    .replace(/(?<=\S )(Fra|Til|Og|I|På|Av|For|Med)\b/g, (w) => w.toLowerCase());
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
