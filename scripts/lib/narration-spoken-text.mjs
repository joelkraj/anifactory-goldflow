export const PROVIDER_SAFE_SPOKEN_COMPILER_ID =
  "goldflow_provider_safe_spoken_text_v1";

export const KNOWN_PRODUCTION_TAG_PATTERN =
  /\[(?:(?:SFX|SOUND|MUSIC|AMBIENCE|PAUSE|BREATH|LAUGH|WHISPER|SHOUT|EMOTION|TONE|PACE|DELIVERY|NARRATION|STAGE)(?:\s*:[^\]]*)?)\]/gi;

function numberWord(value) {
  const lookup = {
    0: "zero",
    1: "one",
    2: "two",
    3: "three",
    4: "four",
    5: "five",
    6: "six",
    7: "seven",
    8: "eight",
    9: "nine",
    10: "ten",
    11: "eleven",
    12: "twelve",
    13: "thirteen",
    14: "fourteen",
    15: "fifteen",
    16: "sixteen",
    17: "seventeen",
    18: "eighteen",
    19: "nineteen",
    20: "twenty",
  };
  return lookup[Number(value)] ?? String(value);
}

function integerToSpokenWords(value) {
  const number = Number(String(value ?? "").replace(/,/g, ""));
  if (!Number.isSafeInteger(number) || number < 0) return String(value ?? "");
  if (number < 21) return numberWord(number);
  const ones = ["", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
  const teens = ["ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
  const tens = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
  const underThousand = (amount) => {
    if (amount < 10) return ones[amount];
    if (amount < 20) return teens[amount - 10];
    if (amount < 100) return `${tens[Math.floor(amount / 10)]}${amount % 10 ? `-${ones[amount % 10]}` : ""}`;
    const remainder = amount % 100;
    return `${ones[Math.floor(amount / 100)]} hundred${remainder ? ` and ${underThousand(remainder)}` : ""}`;
  };
  if (number < 1_000) return underThousand(number);
  const scales = [[1_000_000_000, "billion"], [1_000_000, "million"], [1_000, "thousand"]];
  const parts = [];
  let remainder = number;
  for (const [scale, label] of scales) {
    if (remainder < scale) continue;
    const count = Math.floor(remainder / scale);
    parts.push(`${integerToSpokenWords(count)} ${label}`);
    remainder %= scale;
  }
  if (remainder) parts.push(underThousand(remainder));
  return parts.join(" ");
}

function numberToSpokenWords(value) {
  const normalized = String(value ?? "").replace(/,/g, "");
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) return String(value ?? "");
  const [whole, decimal] = normalized.split(".");
  const wholeWords = integerToSpokenWords(whole);
  if (!decimal) return wholeWords;
  return `${wholeWords} point ${[...decimal].map((digit) => numberWord(digit)).join(" ")}`;
}

function clockTimeToSpokenWords(hour, minute, meridiem) {
  const hourWords = integerToSpokenWords(hour);
  const minuteNumber = Number(minute);
  const minuteWords = minuteNumber === 0
    ? ""
    : minuteNumber < 10
      ? `oh ${numberWord(minuteNumber)}`
      : integerToSpokenWords(minuteNumber);
  const meridiemWords = String(meridiem ?? "").toUpperCase() === "AM" ? "A M" : "P M";
  return [hourWords, minuteWords, meridiemWords].filter(Boolean).join(" ");
}

function normalizeOrdinaryAllCapsForTts(value) {
  return String(value ?? "").replace(/\b[A-Z][A-Z0-9']+\b/g, (token) => (
    `${token[0]}${token.slice(1).toLowerCase()}`
  ));
}

export function stripBalancedOuterDialogueQuotes(value) {
  const text = String(value ?? "").trim();
  const pairs = new Map([['"', '"'], ["“", "”"]]);
  return pairs.get(text[0]) === text.at(-1) ? text.slice(1, -1).trim() : text;
}

export function removeKnownProductionTags(value) {
  const text = String(value ?? "");
  const removedTags = [...text.matchAll(KNOWN_PRODUCTION_TAG_PATTERN)]
    .map((match) => match[0]);
  return {
    text: text.replace(KNOWN_PRODUCTION_TAG_PATTERN, " "),
    removed_tags: removedTags,
  };
}

export function compileProviderSafeSpokenText(value) {
  const normalized = String(value ?? "")
    .replace(/\b(\d{1,2}):([0-5]\d)\s*([AP])\.?M\.?(?=\s|[,;!?]|$)/gi, (_match, hour, minute, marker) => (
      clockTimeToSpokenWords(hour, minute, `${marker}M`)
    ))
    .replace(/\b(\d{1,2})([0-5]\d)\s*([AP])\.?M\.?(?=\s|[,;!?]|$)/gi, (_match, hour, minute, marker) => (
      Number(hour) >= 1 && Number(hour) <= 12
        ? clockTimeToSpokenWords(hour, minute, `${marker}M`)
        : _match
    ))
    .replace(/\bTRUE\s+LEVEL\s*:\s*-\s*(\d{1,2})\b/gi, (_match, level) => `True level, negative ${numberWord(level)}`)
    .replace(/\bUNALLOCATED\s+STAT\s+POINTS\s*:\s*-\s*(\d{1,2})\b/gi, (_match, points) => `Unallocated stat points, negative ${numberWord(points)}`)
    .replace(/\bSSS(?:\s*[- ]\s*rank)?\b/gi, (match) => /rank/i.test(match) ? "S S S rank" : "S S S")
    .replace(/\bSS(?:\s*[- ]\s*rank)?\b/gi, (match) => /rank/i.test(match) ? "S S rank" : "S S")
    .replace(/\bS\s*[- ]\s*rank\b/gi, "S rank")
    .replace(/\b([A-Z])\s*[- ]\s*rank\b/g, "$1 rank")
    .replace(/\bXP\b/g, "X P")
    .replace(/\bHP\b/g, "H P")
    .replace(/\bMP\b/g, "M P")
    .replace(/\bDPS\b/g, "D P S")
    .replace(/\bAOE\b/g, "A O E")
    .replace(/\bCEO\b/g, "C E O")
    .replace(/\bCFO\b/g, "C F O")
    .replace(/\bCOO\b/g, "C O O")
    .replace(/\bCTO\b/g, "C T O")
    .replace(/\bCIO\b/g, "C I O")
    .replace(/\bCMO\b/g, "C M O")
    .replace(/\bHR\b/g, "H R")
    .replace(/\bPR\b/g, "P R")
    .replace(/\bAI\b/g, "A I")
    .replace(/\bUI\b/g, "U I")
    .replace(/\bUX\b/g, "U X")
    .replace(/\bAPI\b/g, "A P I")
    .replace(/\bFBI\b/g, "F B I")
    .replace(/\bNYPD\b/g, "N Y P D")
    .replace(/\bIRS\b/g, "I R S")
    .replace(/\bSEC\b/g, "S E C")
    .replace(/\bNDA\b/g, "N D A")
    .replace(/\bLLC\b/g, "L L C")
    .replace(/\bIPO\b/g, "I P O")
    .replace(/\bIT(?=\s+(?:DEPARTMENT|TEAM|STAFF|SUPPORT|INFRASTRUCTURE|SYSTEMS?|NETWORK|SECURITY|OPERATIONS?|ADMIN(?:ISTRATOR)?|TECHNICIAN|DIRECTOR|MANAGER|SPECIALIST|SERVICES?)\b)/gi, (match) => match === "IT" ? "I T" : match)
    .replace(/\b(?:WORKS?|WORKED|CAREER|JOB)\s+(?:IN|WITH)\s+IT\b/gi, (match) => match.replace(/\bIT\b/g, "I T"))
    .replace(/\bDNA\b/g, "D N A")
    .replace(/\bGPS\b/g, "G P S")
    .replace(/\bUSB\b/g, "U S B")
    .replace(/\bPDF\b/g, "P D F")
    .replace(/\bURL\b/g, "U R L")
    .replace(/\bVIP\b/g, "V I P")
    .replace(/\bID\b/g, "I D")
    .replace(/\bMC\b/g, "M C")
    .replace(/\bLevel\s*[-:]\s*-\s*(\d{1,2})\b/gi, (_match, level) => `Level negative ${numberWord(level)}`)
    .replace(/\bLevel\s+-\s*(\d{1,2})\b/gi, (_match, level) => `Level negative ${numberWord(level)}`)
    .replace(/:\s*-\s*(\d{1,2})\b/g, (_match, amount) => `, negative ${numberWord(amount)}`)
    .replace(/\b(\d[\d,]*)\s*x\b/gi, (_match, multiplier) => (
      Number(String(multiplier).replace(/,/g, "")) === 0
        ? "zero times"
        : `${integerToSpokenWords(multiplier)} times`
    ))
    .replace(/\b(\d[\d,]*(?:\.\d+)?)\s*\/\s*(\d[\d,]*(?:\.\d+)?)\b/g, (_match, left, right) => `${numberToSpokenWords(left)} out of ${numberToSpokenWords(right)}`)
    .replace(/\b(\d[\d,]*(?:\.\d+)?)%/g, (_match, number) => `${numberToSpokenWords(number)} percent`)
    .replace(/\b\d[\d,]*(?:\.\d+)?\b/g, (number) => numberToSpokenWords(number))
    .replace(/\s+/g, " ")
    .trim();
  return normalizeOrdinaryAllCapsForTts(normalized);
}
