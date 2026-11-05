// SpendWise India — bank statement reader and spending analyser.
// Everything here runs on the user's phone. Nothing from the statement is uploaded.

/* ---------- small parsers ---------- */
const MONTHS = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, SEPT: 9, OCT: 10, NOV: 11, DEC: 12 };
const pad = n => String(n).padStart(2, '0');
function median(a) { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }

// Accepts 05-11-2026, 05/11/2026, 05-11-26, 05 Nov 2026, 05-Nov-2026, 2026-11-05. Returns 'YYYY-MM-DD' or null.
export function parseDate(s) {
  s = String(s || '').trim();
  let m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/);
  if (m) return mk(+m[3], +m[2], +m[1]);
  m = s.match(/^(\d{1,2})[-\s/]([A-Za-z]{3,4})[-\s/,]*(\d{2}|\d{4})$/);
  if (m && MONTHS[m[2].toUpperCase()]) return mk(+m[3], MONTHS[m[2].toUpperCase()], +m[1]);
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s].*)?$/);
  if (m) return mk(+m[1], +m[2], +m[3]);
  return null;
}
function mk(y, mo, d) {
  if (y < 100) y += 2000;
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 2000 || y > 2100) return null;
  return `${y}-${pad(mo)}-${pad(d)}`;
}
// A money amount as statements print it: 1,23,456.78 (optionally Cr/Dr). Integers are rejected,
// so cheque numbers and branch codes are never mistaken for amounts.
const AMT_RE = /^-?₹?\s?[\d,]*\d\.\d{2}\s?(cr|dr)?$/i;
export function parseAmount(s) {
  const t = String(s ?? '').trim();
  if (!AMT_RE.test(t)) return null;
  const v = parseFloat(t.replace(/[₹,\s]|cr|dr/gi, ''));
  return Number.isFinite(v) ? { v: Math.abs(v), tag: (t.match(/(cr|dr)$/i) || [])[1]?.toLowerCase() || null, neg: v < 0 } : null;
}
// Looser number parsing for spreadsheet cells (1234, 1,234.5, (1,234.00)).
function cellNumber(s) {
  if (typeof s === 'number') return s;
  const t = String(s ?? '').replace(/[₹,\s]/g, '').replace(/^\((.*)\)$/, '-$1').replace(/(cr|dr)$/i, '');
  if (!t || !/^-?\d+(\.\d+)?$/.test(t)) return null;
  return parseFloat(t);
}

/* ---------- PDF: rebuild the table rows from positioned text ---------- */
// Returns one { cells, y, page } per visual line, in reading order across all pages.
export async function linesFromPdf(pdf) {
  const lines = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const tc = await page.getTextContent();
    const items = tc.items.filter(i => i.str && i.str.trim()).map(i => ({ s: i.str.trim(), x: i.transform[4], y: i.transform[5], w: i.width || 0 }));
    items.sort((a, b) => b.y - a.y || a.x - b.x);
    let row = [], y0 = null;
    const flush = () => {
      if (!row.length) return;
      row.sort((a, b) => a.x - b.x);
      const cells = [];
      for (const it of row) {
        const last = cells[cells.length - 1];
        if (last && it.x - last.end < 2.5 && !parseAmount(it.s) && !parseAmount(last.s)) { last.s += (it.x - last.end > 0.8 ? ' ' : '') + it.s; last.end = it.x + it.w; }
        else cells.push({ s: it.s, x: it.x, end: it.x + it.w });
      }
      lines.push({ cells: cells.map(c => c.s), y: y0, page: p });
      row = [];
    };
    for (const it of items) {
      if (y0 === null || Math.abs(it.y - y0) > 3) { flush(); y0 = it.y; }
      row.push(it);
    }
    flush();
  }
  return lines;
}

/* ---------- account holder (to spot transfers to your own accounts) ---------- */
export function holderFrom(textLines) {
  for (const l of textLines.slice(0, 60)) {
    const m = String(l).match(/\b(?:customer name|account name|a\/c name|name of (?:the )?customer|name)\s*[:\-]+\s*(?:mr\.?|mrs\.?|ms\.?)?\s*([A-Za-z][A-Za-z .]{2,60})/i);
    if (m && !/joint|nominee|branch|bank/i.test(m[1])) return m[1].replace(/\s+/g, ' ').trim().toUpperCase();
  }
  return '';
}
// "SAITEJAJUPUDI", "JUPUDI SAITEJA" or just "SAITEJA" all count as the holder.
const isHolder = (cp, holders) => { const c = cp.replace(/[^A-Z]/g, ''), words = cp.split(/\s+/); return holders.some(h => { const tk = h.split(/\s+/).filter(w => w.length >= 3); return tk.length >= 1 && (tk.every(w => c.includes(w)) || (words.length === 1 && tk.some(w => w.length >= 5 && w === words[0]))); }); };

/* ---------- turn rows of cells into transactions ---------- */
const SKIP_RE = /opening balance|closing balance|transaction total|page \d+ of|statement of account|^total\b|brought forward|carried forward/i;

// Generic: a transaction row starts with a date. The last two money amounts on the row are
// (transaction amount, running balance). Direction comes from how the balance moved.
// Lines can be plain cell arrays (spreadsheets) or { cells, y, page } from a PDF.
export function txnsFromLines(lines) {
  if (lines.length && !Array.isArray(lines[0])) return txnsFromPositioned(lines);
  const rows = []; let opening = null, cur = null;
  for (const cells of lines) {
    const joined = cells.join(' ');
    if (/opening balance/i.test(joined)) {
      const a = cells.map(parseAmount).filter(Boolean).pop();
      if (a) opening = a.neg ? -a.v : a.v;
      cur = null; continue;
    }
    const first = cells[0] || '';
    let date = parseDate(first);
    // Some PDFs put "05-11-2026 UPI/..." in one cell.
    if (!date) { const m = first.match(/^(\S+)\s+(.*)$/); if (m && parseDate(m[1])) { date = parseDate(m[1]); cells.splice(0, 1, m[1], m[2]); } }
    if (date && !SKIP_RE.test(joined)) {
      const amts = [], text = [];
      cells.slice(1).forEach(c => { const a = parseAmount(c); if (a) amts.push(a); else if (!parseDate(c) && !/^\d{1,6}$/.test(c)) text.push(c); });
      if (!amts.length) { cur = null; continue; }
      const bal = amts.length >= 2 ? amts[amts.length - 1] : null, amt = amts.length >= 2 ? amts[amts.length - 2] : amts[0];
      cur = { date, desc: text.join(' '), amount: amt.v, tag: amt.tag, balance: bal ? (bal.neg || bal.tag === 'dr' ? -bal.v : bal.v) : null };
      rows.push(cur);
    } else if (cur && !SKIP_RE.test(joined) && !cells.some(c => parseAmount(c)) && joined.length < 140 && !parseDate(first)) {
      cur.desc += ' ' + joined; // wrapped narration line
    } else if (!date) cur = cur && joined.length < 140 && !cells.some(c => parseAmount(c)) ? cur : null;
  }
  return finishTxns(rows, opening);
}

// A column-header line has at least two of these words (a payee name may contain one).
function isHeader(text) {
  const words = ['tran date', 'txn date', 'date', 'particulars', 'narration', 'description', 'chq', 'cheque', 'ref no', 'debit', 'withdrawal', 'credit', 'deposit', 'balance', 'value date', 'init. br'];
  const t = text.toLowerCase(); return words.filter(w => t.includes(w)).length >= 2;
}

// Reads one dated row: amounts, text and date. Returns null if it isn't a transaction row.
function readRow(cellsIn) {
  const cells = [...cellsIn], joined = cells.join(' '), first = cells[0] || '';
  let date = parseDate(first);
  if (!date) { const m = first.match(/^(\S+)\s+(.*)$/); if (m && parseDate(m[1])) { date = parseDate(m[1]); cells.splice(0, 1, m[1], m[2]); } }
  if (!date || SKIP_RE.test(joined)) return null;
  const amts = [], text = [];
  cells.slice(1).forEach(c => { const a = parseAmount(c); if (a) amts.push(a); else if (!parseDate(c) && !/^\d{1,6}$/.test(c)) text.push(c); });
  if (!amts.length) return null;
  const bal = amts.length >= 2 ? amts[amts.length - 1] : null, amt = amts.length >= 2 ? amts[amts.length - 2] : amts[0];
  return { date, desc: text.join(' '), amount: amt.v, tag: amt.tag, balance: bal ? (bal.neg || bal.tag === 'dr' ? -bal.v : bal.v) : null };
}

// PDF lines with positions. Description text often wraps onto extra lines, which some banks print
// above the date row (Axis) and others below. Work out which, then attach each loose text line
// to its transaction on the same page.
function txnsFromPositioned(lines) {
  let opening = null;
  const items = [];
  for (const l of lines) {
    const joined = l.cells.join(' ');
    if (/opening balance/i.test(joined)) { const a = l.cells.map(parseAmount).filter(Boolean).pop(); if (a) opening = a.neg ? -a.v : a.v; items.push({ ...l, kind: 'stop' }); continue; }
    const r = readRow(l.cells);
    if (r) { items.push({ ...l, kind: 'txn', row: r }); continue; }
    const loose = !SKIP_RE.test(joined) && !l.cells.some(c => parseAmount(c)) && joined.length < 160 && !isHeader(joined);
    items.push({ ...l, kind: loose ? 'text' : 'stop' });
  }
  // Typical gap between consecutive transaction rows, and which side loose lines sit closer to.
  const txIdx = items.map((it, i) => (it.kind === 'txn' ? i : -1)).filter(i => i >= 0);
  const gaps = [];
  for (let k = 1; k < txIdx.length; k++) { const a = items[txIdx[k - 1]], b = items[txIdx[k]]; if (a.page === b.page) gaps.push(a.y - b.y); }
  const rowGap = median(gaps) || 20;
  let votesUp = 0, votesDown = 0;
  items.forEach((it, i) => {
    if (it.kind !== 'text') return;
    const prev = items.slice(0, i).reverse().find(x => x.kind !== 'text'), next = items.slice(i + 1).find(x => x.kind !== 'text');
    const dPrev = prev && prev.kind === 'txn' && prev.page === it.page ? prev.y - it.y : Infinity;
    const dNext = next && next.kind === 'txn' && next.page === it.page ? it.y - next.y : Infinity;
    if (dNext < dPrev) votesDown++; else if (dPrev < dNext) votesUp++;
  });
  const attachToNext = votesDown >= votesUp; // text printed above its date row
  const rows = [];
  items.forEach((it, i) => {
    if (it.kind === 'txn') { rows.push(it.row); it.row._extra = it.row._extra || []; }
  });
  items.forEach((it, i) => {
    if (it.kind !== 'text') return;
    if (attachToNext) {
      // Walk down past other loose lines to the next transaction row on this page.
      let j = i + 1; while (j < items.length && items[j].kind === 'text' && items[j].page === it.page) j++;
      const t = items[j];
      if (t && t.kind === 'txn' && t.page === it.page && it.y - t.y <= rowGap * 2.2) t.row._pre = (t.row._pre || []).concat(it.cells.join(' '));
    } else {
      let j = i - 1; while (j >= 0 && items[j].kind === 'text' && items[j].page === it.page) j--;
      const t = items[j];
      if (t && t.kind === 'txn' && t.page === it.page && t.y - it.y <= rowGap * 2.2) t.row._extra.push(it.cells.join(' '));
    }
  });
  for (const r of rows) { r.desc = [...(r._pre || []), r.desc, ...(r._extra || [])].join(' ').replace(/\s*\/\s*/g, '/'); delete r._pre; delete r._extra; }
  return finishTxns(rows, opening);
}

// Decide debit/credit for each row, using the running balance where possible.
function finishTxns(rows, opening) {
  if (!rows.length) return [];
  // Newest-first statements: put them in date order (stable for same-day rows).
  if (rows.length > 1 && rows[0].date > rows[rows.length - 1].date) rows.reverse();
  let prev = opening;
  for (const r of rows) {
    let dir = null;
    if (r.balance != null && prev != null) {
      const d = Math.round((r.balance - prev) * 100) / 100;
      if (Math.abs(Math.abs(d) - r.amount) < 0.011) dir = d < 0 ? 'out' : 'in';
    }
    if (!dir && r.tag) dir = r.tag === 'dr' ? 'out' : 'in';
    if (!dir) dir = guessDirection(r.desc);
    r.dir = dir;
    if (r.balance != null) prev = r.balance;
  }
  return rows.filter(r => r.amount > 0).map(r => ({ date: r.date, desc: r.desc.replace(/\s+/g, ' ').trim(), amount: r.amount, dir: r.dir }));
}
function guessDirection(desc) {
  return /\b(salary|sal\b|interest|int\.?pd|refund|reversal|cashback|by transfer|credit|neft cr|imps cr|deposit)\b/i.test(desc) ? 'in' : 'out';
}

/* ---------- spreadsheets (Excel / CSV) ---------- */
export function txnsFromTable(rows) {
  const norm = v => String(v ?? '').trim();
  let hi = -1, map = null;
  for (let i = 0; i < Math.min(rows.length, 60); i++) {
    const h = rows[i].map(c => norm(c).toLowerCase());
    const find = re => h.findIndex(c => re.test(c));
    const date = (() => { let k = h.findIndex(c => /(tran|txn|transaction)\s*\.?\s*date|^date$|posting date/.test(c)); return k >= 0 ? k : h.findIndex(c => /date/.test(c) && !/value/.test(c)); })();
    const desc = find(/particular|narration|description|remark|details/);
    const debit = find(/debit|withdraw|^dr\.?$/);
    const credit = find(/credit|deposit|^cr\.?$/);
    const amount = find(/^amount|amount\s*\(|txn amount|transaction amount/);
    const drcr = find(/dr\s*\/\s*cr|cr\s*\/\s*dr|^type$|debit\s*\/\s*credit/);
    const balance = find(/balance/);
    if (date >= 0 && desc >= 0 && ((debit >= 0 && credit >= 0) || amount >= 0)) { hi = i; map = { date, desc, debit, credit, amount, drcr, balance }; break; }
  }
  if (hi < 0) return txnsFromLines(rows.map(r => r.map(norm).filter(Boolean))); // no header: treat like PDF lines
  const out = []; let opening = null;
  for (const r of rows.slice(hi + 1)) {
    const raw = r[map.date];
    const date = raw instanceof Date ? `${raw.getFullYear()}-${pad(raw.getMonth() + 1)}-${pad(raw.getDate())}` : parseDate(norm(raw));
    const desc = norm(r[map.desc]);
    if (/opening balance/i.test(desc)) { const b = cellNumber(r[map.balance]); if (b != null) opening = b; continue; }
    if (!date) continue;
    let amount = null, dir = null;
    const dv = map.debit >= 0 ? cellNumber(r[map.debit]) : null, cv = map.credit >= 0 ? cellNumber(r[map.credit]) : null;
    if (dv) { amount = Math.abs(dv); dir = 'out'; }
    else if (cv) { amount = Math.abs(cv); dir = 'in'; }
    else if (map.amount >= 0) {
      const a = cellNumber(r[map.amount]); if (a == null) continue;
      amount = Math.abs(a);
      const t = map.drcr >= 0 ? norm(r[map.drcr]).toLowerCase() : '';
      dir = /^(dr|d|debit)/.test(t) ? 'out' : /^(cr|c|credit)/.test(t) ? 'in' : (a < 0 ? 'out' : null);
    }
    if (!amount) continue;
    const bal = map.balance >= 0 ? cellNumber(r[map.balance]) : null;
    out.push({ date, desc, amount, tag: dir === 'out' ? 'dr' : dir === 'in' ? 'cr' : null, balance: bal });
  }
  return finishTxns(out, opening);
}

/* ---------- who was paid, and what for ---------- */
// Pull a readable payee out of narrations like "UPI/P2M/412345678901/SWIGGY LIMITED/Payment/YES BANK".
export function counterparty(desc) {
  const d = String(desc || '').toUpperCase();
  let name = '';
  if (/^(UPI|IMPS|NEFT|RTGS|ACH|NACH|ECS|MMT|BIL|POS|ECOM|INF|IFT)[\/\-\s:]/.test(d) || d.includes('/')) {
    const parts = d.split(/[\/\-:]+/).map(s => s.trim()).filter(Boolean);
    name = parts.find(p => /[A-Z]{3,}/.test(p) && !/\d{5,}/.test(p) && !/^(UPI|P2M|P2A|IMPS|NEFT|RTGS|ACH|NACH|ECS|DR|CR|MMT|BIL|POS|ECOM|INF|IFT|ONL|PAYMENT|PAY|SENT|USING|TO|FROM|NA|AXIS|AXIS BANK|BANK|YES BANK LTD|HDFC BANK|ICICI BANK|STATE BANK OF INDIA|SBI|KOTAK|IDFC FIRST|PAYMENT FR|PAYMENT FROM|COLLECT|REQUEST|UPIINTENT|UPI PAYMENT|NO REMARKS|INB|VPS|XXXX)$/.test(p) && !/^\d/.test(p));
  }
  if (!name) name = d;
  return name.replace(/[^A-Z0-9&. ]/g, ' ').replace(/\b\d{4,}\b/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 32) || 'UNKNOWN';
}

// Category rules, checked in order (first match wins). Each rule has two word lists:
//   loose: brand names matched anywhere, even run together with other text (ZEPTONOW, BBNOW, BLINKITCOMMERCE)
//   whole: short or common words matched only as whole words (TEA must not match STEAM).
const esc = w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, ' ?');
const rule = (loose = [], whole = []) => new RegExp([loose.length ? `(${loose.map(esc).join('|')})` : '', whole.length ? `\\b(${whole.map(esc).join('|')})\\b` : ''].filter(Boolean).join('|'));
export const CATEGORIES = [
  { key: 'cash', name: 'Cash withdrawals', type: 'spend', re: /^(ATM|ATM-CASH)|\b(ATM-CASH|ATM WDL|CASH ?WDL|CASH ?WITHDRAWAL|NWD|ATW|CDM)\b/ },
  { key: 'self', name: 'To my other accounts', type: 'save', re: /(SELFFT|SELF ?TRANSFER|SELF ?FT|TO ?SELF|OWN ?A\/?C|OWN ?ACCOUNT)/ },
  { key: 'wallet', name: 'Wallet top-ups', type: 'spend', re: rule(['AMAZON PAY BALANCE', 'AMAZONPAYBALANCE', 'ADD MONEY', 'ADDMONEY', 'LOAD MONEY', 'WALLET TOPUP', 'WALLET LOAD', 'PAYTM WALLET', 'PHONEPE WALLET', 'MOBIKWIK', 'FREECHARGE'], ['WALLET']) },
  { key: 'savings', name: 'Savings & investments', type: 'save', re: /\b(SIP|MUTUAL ?FUND|MF\b|ZERODHA|GROWW|KUVERA|UPSTOX|ANGEL ?ONE|INDMONEY|ET ?MONEY|PAYTM ?MONEY|COIN BY|BSE STAR|ICCL|NSE CLEARING|CAMS|KFIN|NPS|PPF|RECURRING DEP|\bRD\b|FIXED DEP|\bFD\b|CHIT|CHITS|CHITTI|SAFEGOLD|AUGMONT|DIGITAL GOLD|SUKANYA)\b/ },
  { key: 'card', name: 'Credit card bills', type: 'spend', re: /\b(CRED\b|CRED CLUB|CREDIT ?CARD|CC ?PAYMENT|CARD ?PAYMENT|CCPAY|AUTOPAY CC|BILLDESK.*CARD|BHARAT ?CONNECT ?CRED)/ },
  { key: 'taxes', name: 'Taxes & government', type: 'spend', re: rule(['CBDT', 'INCOME TAX', 'INCOMETAX', 'CENTRAL BOARD OF DIR', 'TIN-NSDL', 'TIN NSDL', 'PROTEAN', 'PROPERTY TAX', 'PROPERTYTAX', 'GHMC', 'BBMP', 'CHALLAN', 'PARIVAHAN', 'PASSPORT', 'VFS GLOBAL', 'VFSGLOBAL', 'MEESEVA', 'BANGALORE ONE', 'MUNICIPAL', 'E-STAMP', 'ESTAMP', 'REGISTRATION DEPT'], ['GST', 'RTO', 'TAX']) },
  { key: 'rent', name: 'Rent', type: 'spend', re: /\b(RENT|NOBROKER|HOUSE ?RENT|MAINTENANCE|SOCIETY|MYGATE|NOBROKERHOOD)\b/ },
  { key: 'emi', name: 'Loan EMIs', type: 'spend', re: /\b(EMI|LOAN|BAJAJ ?FIN|HOME ?FIN|HDFC ?LTD|LIC ?HFL|TATA ?CAPITAL|FULLERTON|NACH|ACH[ -]?DR|ECS)\b/ },
  { key: 'insurance', name: 'Insurance', type: 'spend', re: /\b(INSURANCE|\bLIC\b|LIFE ?INS|HDFC ?LIFE|ICICI ?PRU|SBI ?LIFE|MAX ?LIFE|STAR ?HEALTH|NIVA|CARE ?HEALTH|POLICYBAZ\w*|ACKO|DIGIT|PREMIUM)\b/ },
  { key: 'jewellery', name: 'Jewellery & gold', type: 'spend', re: rule(['JEWEL', 'TANISHQ', 'CARATLANE', 'CARAT LANE', 'KALYAN JEW', 'MALABAR GOLD', 'JOYALUKKAS', 'GRT JEW', 'LALITHAA', 'MANEPALLY', 'PC JEWEL', 'BHIMA', 'SENCO', 'BLUESTONE', 'GIVA'], ['GOLD', 'SILVER', 'ORNAMENTS']) },
  { key: 'groceries', name: 'Groceries', type: 'spend', re: rule(
    ['AMAZON NOW', 'AMAZONNOW', 'AMAZON FRESH', 'AMAZONFRESH', 'AMAZON PAY GROCER', 'BBNOW', 'BB NOW', 'BIGBASKET', 'BIG BASKET', 'BLINKIT', 'GROFERS', 'ZEPTO', 'INSTAMART', 'FLIPKART MINUTES', 'FLIPKARTMINUTES', 'FLIPKART GROCERY', 'JIOMART', 'DUNZO', 'SWIGGY GENIE', 'KPN FRESH', 'KPNFRESH', 'COUNTRY DELIGHT', 'COUNTRYDELIGHT', 'MILKBASKET', 'FRESHTOHOME', 'LICIOUS', 'DMART', 'D MART', 'AVENUE SUPERMARTS', 'RATNADEEP', 'VIJETHA', 'HERITAGE FRESH', 'HERITAGE FOODS', 'NILGIRIS', 'MORE RETAIL', 'MORE SUPERMARKET', 'SPENCER', 'STAR BAZAAR', 'NATURES BASKET', 'RELIANCE FRESH', 'RELIANCE SMART', 'SMART BAZAAR', 'SMARTBAZAAR', 'INNOVATIVE RETAIL', 'KIRANA', 'SUPERMARKET', 'SUPER MARKET', 'HYPERMARKET', 'GROCER', 'PROVISION', 'GENERAL STORE', 'VEGETABLE', 'FRUITS', 'DAIRY', 'MUTTON', 'CHICKEN'],
    ['LULU', 'MART', 'FRESH', 'MILK', 'EGG', 'EGGS', 'MEAT', 'FISH', 'FRUIT', 'STORES', 'TRADERS']) },
  { key: 'eating', name: 'Eating out', type: 'spend', re: rule(
    ['SWIGGY', 'ZOMATO', 'EATSURE', 'EATCLUB', 'DINEOUT', 'DOMINO', 'PIZZA', 'MCDONALD', 'BURGER', 'SUBWAY', 'STARBUCKS', 'THIRD WAVE', 'BLUE TOKAI', 'CHAI POINT', 'CHAAYOS', 'HALDIRAM', 'PARADISE BIRYANI', 'PARADISE FOOD', 'MEHFIL', 'SHAH GHOUSE', 'CREAM STONE', 'CREAMSTONE', 'KARACHI BAKERY', 'BEHROUZ', 'FAASOS', 'BOX8', 'BIRYANI', 'TIFFIN', 'RESTAURANT', 'BAKERY', 'BAKERS', 'SWEETS', 'ICE CREAM', 'ICECREAM', 'DHABA', 'DARSHINI', 'BHAVAN', 'BHAWAN', 'CANTEEN', 'FOOD COURT', 'KITCHEN', 'CAFE', 'CAFFE', 'COFFEE', 'JUICE', 'CHAAT', 'SNACK', 'FOOD'],
    ['KFC', 'HOTEL', 'MESS', 'CHAI', 'TEA', 'IDLI', 'DOSA', 'DINER', 'DINERS']) },
  { key: 'health', name: 'Health', type: 'spend', re: rule(
    ['APOLLO', 'MEDPLUS', '1MG', 'PHARMEASY', 'NETMEDS', 'PRACTO', 'RAINBOW CHILDREN', 'RAINBOW HOSPITAL', 'MOTHERHOOD', 'MOTHER HOOD', 'FERNANDEZ', 'CLOUDNINE', 'CLOUD NINE', 'MANIPAL HOSP', 'MANIPALHEALTH', 'MANIPAL HEALTH', 'NARAYANA HEALTH', 'NARAYANA HRUDAY', 'YASHODA', 'CARE HOSPITAL', 'ASTER', 'HOSPITAL', 'CLINIC', 'MEDICAL', 'PHARMA', 'CHEMIST', 'DIAGNOSTIC', 'HEALTHCARE', 'HEALTH CARE', 'DENTAL', 'OPTICAL', 'EYE CARE', 'EYE HOSP', 'EYE CLINIC', 'PHYSIO', 'LENSKART'],
    ['KIMS', 'LAB', 'LABS', 'DRUG', 'DRUGS']) },
  { key: 'personal', name: 'Personal care', type: 'spend', re: rule(['SALON', 'PARLOUR', 'PARLOR', 'BEAUTY', 'UNISEX', 'BARBER', 'GREEN TRENDS', 'NATURALS SALON', 'LAKME SALON', 'BODYCRAFT', 'CULT FIT', 'CULTFIT', 'FITNESS', 'GYM'], ['SPA', 'HAIR']) },
  { key: 'household', name: 'Household', type: 'spend', re: /(URBAN ?COMPANY|URBANCOMPANY|URBANCLAP|HARDWARE|ELECTRICAL|PLUMB|CARPENT|PAINTS?\b|SANITARY|LAUNDRY|DRY ?CLEAN|PEST ?CONTROL|FURNITURE|HOME ?CENTRE|UTENSIL|STEEL|PLASTIC|\bMAID\b|\bCOOK\b)/ },
  { key: 'transport', name: 'Fuel & vehicle', type: 'spend', re: rule(
    ['PETROL', 'DIESEL', 'FILLING', 'HPCL', 'BPCL', 'IOCL', 'INDIAN OIL', 'INDIANOIL', 'HP PAY', 'NAYARA', 'RELIANCE BP', 'JIO-BP', 'JIO BP', 'JIOBP', 'FASTAG', 'NHAI', 'PARKING', 'SERVICE CENTRE', 'SERVICE CENTER', 'AUTOMOBILE', 'MOTORS', 'TYRE', 'BATTERI', 'BATTERY', 'BATTE', 'STATE ROAD', 'ROAD TRANSPORT', 'CAR WASH', 'HONDA', 'HERO MOTO', 'BAJAJ AUTO', 'MARUTI', 'HYUNDAI', 'TATA MOTORS', 'ATHER', 'OLA ELECTRIC', 'AMPERE', 'RAPIDO', 'NAMMA YATRI', 'BLUSMART', 'UBER', 'YULU', 'BMTC', 'TSRTC', 'TGSRTC', 'KSRTC', 'APSRTC', 'METRO RAIL', 'HYDERABAD METRO', 'BMRCL'],
    ['FUEL', 'SHELL', 'OLA', 'TVS', 'NETC', 'METRO']) },
  { key: 'bills', name: 'Bills & utilities', type: 'spend', re: /\b(ELECTRICITY|BESCOM|TSSPDCL|TGSPDCL|APSPDCL|APEPDCL|MSEDCL|TATA ?POWER|ADANI ?(ELEC|GAS)|BWSSB|HMWSSB|WATER|INDANE|BHARAT ?GAS|HP ?GAS|GAS ?BILL|PIPED ?GAS|AIRTEL|\bJIO\b|RELIANCE ?JIO|VODAFONE|\bVI\b|BSNL|ACT ?FIBERNET|ACT ?BROADBAND|HATHWAY|BROADBAND|RECHARGE|DTH|TATA ?PLAY|BBPS|BILLDESK|ELEC)\b|AIRTEL ?XSTREAM|GAS ?CYLINDER/ },
  { key: 'subs', name: 'Entertainment & subscriptions', type: 'spend', re: /\b(NETFLIX|HOTSTAR|DISNEY|PRIME ?VIDEO|AMAZON ?PRIME|SPOTIFY|YOUTUBE|BOOKMYSHOW|PVR|INOX|SONYLIV|ZEE5|JIOCINEMA|APPLE\.COM|APPLE ?SERVICES|GOOGLE ?PLAY|AUDIBLE)\b/ },
  { key: 'travel', name: 'Travel', type: 'spend', re: rule(['MAKEMYTRIP', 'GOIBIBO', 'CLEARTRIP', 'EASEMYTRIP', 'IXIGO', 'IRCTC', 'REDBUS', 'ABHIBUS', 'INTERGLOBE', 'INDIGO', 'AIR INDIA', 'AIRINDIA', 'VISTARA', 'AKASA', 'SPICEJET', 'AIRBNB', 'TREEBO', 'FAB HOTELS', 'FABHOTELS', 'AGODA', 'BOOKING.COM', 'THOMAS COOK', 'PAYTM TRAVEL', 'AIRPORT', 'AIRLINES'], ['YATRA', 'OYO']) },
  { key: 'education', name: 'Education', type: 'spend', re: rule(['SCHOOL', 'COLLEGE', 'UNIVERSITY', 'TUITION', 'COACHING', 'ACADEMY', 'BYJU', 'UNACADEMY', 'COURSERA', 'UDEMY', 'VEDANTU', 'PHYSICS WALLAH', 'PHYSICSWALLAH'], ['FEES', 'FEE']) },
  { key: 'shopping', name: 'Shopping', type: 'spend', re: rule(
    ['AMAZON', 'AMZN', 'FLIPKART', 'MYNTRA', 'AJIO', 'MEESHO', 'NYKAA', 'TATA CLIQ', 'TATACLIQ', 'CROMA', 'RELIANCE DIGITAL', 'VIJAY SALES', 'DIGITAL AGE RETAIL', 'DECATHLON', 'IKEA', 'ZUDIO', 'WESTSIDE', 'PANTALOONS', 'LIFESTYLE', 'MAX FASHION', 'SHOPPERS STOP', 'FIRSTCRY', 'PEPPERFRY', 'URBAN LADDER', 'SNAPDEAL', 'TEXTILE', 'SAREE', 'SILKS', 'GARMENT', 'FASHION', 'BOUTIQUE', 'FOOTWEAR', 'FANCY', 'GIFT', 'TOYS', 'MOBILES', 'ELECTRONICS', 'STATIONER', 'BOOK'],
    ['TRENDS', 'H&M', 'SHOES']) },
];
export const OTHER_CATS = [
  { key: 'people', name: 'Transfers to people', type: 'spend' },
  { key: 'misc', name: 'Miscellaneous', type: 'spend' },
  { key: 'oneoff', name: 'Big one-off payments', type: 'save' },
  { key: 'partner', name: 'My partner / spouse', type: 'save' },
];
export const ALL_CATS = [...CATEGORIES, ...OTHER_CATS];
// What a fixed monthly payment can be. Saving kinds become savings envelopes.
export const FIXED_KINDS = [
  { kind: 'Rent', type: 'spend' }, { kind: 'Maintenance', type: 'spend' }, { kind: 'Loan EMI', type: 'spend' },
  { kind: 'Chit', type: 'save' }, { kind: 'Gold scheme', type: 'save' }, { kind: 'SIP / savings', type: 'save' },
  { kind: 'Insurance', type: 'spend' }, { kind: 'Fees', type: 'spend' }, { kind: 'Household help', type: 'spend' },
  { kind: 'Family support', type: 'spend' }, { kind: 'Other fixed', type: 'spend' },
];
const kindType = k => (FIXED_KINDS.find(x => x.kind === k) || { type: 'spend' }).type;
const INRf = n => '₹' + Math.round(n).toLocaleString('en-IN');

export function categorise(t, learned = {}) {
  const cp = counterparty(t.desc);
  if (learned[cp] && ALL_CATS.some(c => c.key === learned[cp])) return learned[cp];
  const d = t.desc.toUpperCase();
  for (const c of CATEGORIES) if (c.re.test(d)) return c.key;
  if (/UPI\/P2A|IMPS|NEFT|RTGS|\bMMT\b|TRANSFER/.test(d)) return 'people';
  return 'misc';
}

/* ---------- the analysis ---------- */
const roundUp = (v, step = 500) => v <= 0 ? 0 : Math.ceil(v / step) * step;
const monthsBetween = (a, b) => { const out = []; let [y, m] = a.split('-').map(Number); const [y2, m2] = b.split('-').map(Number); while (y < y2 || (y === y2 && m <= m2)) { out.push(`${y}-${pad(m)}`); if (++m > 12) { m = 1; y++; } } return out; };

// holders: account-holder names from the statements. partners: the partner's name(s) in the app.
// Money sent to and received from a partner is household money moving around, so it is netted and kept out of limits.
const isPartner = (cp, partners) => { const words = cp.split(/\s+/); return partners.some(p => p.toUpperCase().split(/\s+/).filter(w => w.length >= 4).some(w => words.includes(w))); };
export function analyse(txns, learned = {}, holders = [], partners = []) {
  if (!txns.length) return null;
  const sorted = [...txns].sort((a, b) => a.date.localeCompare(b.date));
  const first = sorted[0].date, last = sorted[sorted.length - 1].date;
  let months = monthsBetween(first.slice(0, 7), last.slice(0, 7));
  // Leave out a partly covered first or last month when there are enough whole ones.
  if (months.length > 4) {
    if (+first.slice(8) > 5) months = months.slice(1);
    if (+last.slice(8) < 25) months = months.slice(0, -1);
  }
  // Months with no entries at all (a gap between two statements) are left out, not counted as zero.
  const seenM = new Set(sorted.map(t => t.date.slice(0, 7)));
  months = months.filter(m => seenM.has(m));
  const inRange = new Set(months);
  const use = sorted.filter(t => inRange.has(t.date.slice(0, 7)));
  const out = use.filter(t => t.dir === 'out'), inc = use.filter(t => t.dir === 'in');
  for (const t of out) { t.cp = counterparty(t.desc); t.cat = categorise(t, learned); if (!learned[t.cp] && holders.length && isHolder(t.cp, holders)) t.cat = 'self'; if (!learned[t.cp] && partners.length && isPartner(t.cp, partners)) t.cat = 'partner'; }
  // Income: salary-like credits.
  const incByMonth = Object.fromEntries(months.map(m => [m, 0]));
  for (const t of inc) incByMonth[t.date.slice(0, 7)] += t.amount;
  for (const t of inc) { t.cp = counterparty(t.desc); t.fromPartner = learned[t.cp] === 'partner' || (!learned[t.cp] && partners.length && isPartner(t.cp, partners)); }
  for (const t of inc) if (t.fromPartner) incByMonth[t.date.slice(0, 7)] -= t.amount;
  // Salary: group credits by payer and take the largest one that looks like an employer
  // (says SALARY, is a company, or pays in most months).
  const byPayer = {};
  for (const t of inc) { if (t.fromPartner) continue; if (/INT\.?PD|INTEREST|REFUND|REVERSAL|CASHBACK|SELFFT|SELF ?TRANSFER|BY CASH|CASH DEP/i.test(t.desc)) continue; (byPayer[t.cp] = byPayer[t.cp] || []).push(t); }
  const cand = Object.entries(byPayer).map(([cp, l]) => ({ cp, l, total: l.reduce((a, t) => a + t.amount, 0), months: new Set(l.map(t => t.date.slice(0, 7))).size, kw: l.some(t => /\b(SALARY|SAL|PAYROLL)\b|-SAL\b/i.test(t.desc)) }))
    .filter(c => c.kw || /\b(LLP|LTD|LIMITED|PVT|PRIVATE|INC|CORP|TECHNOLOGIES|SOLUTIONS|SERVICES|INDIA)\b/.test(c.cp) || c.months >= Math.max(3, Math.ceil(months.length * 0.6)))
    .sort((a, b) => b.total - a.total)[0];
  // Employers often pay some months by NEFT and others by ACH ("ACH-CR-SAL-..."), which read as different payers.
  const salaryTx = cand ? [...cand.l, ...inc.filter(t => !cand.l.includes(t) && /\bSALARY\b|-SAL-|\bSAL\b/i.test(t.desc))] : [], salaryFrom = cand ? cand.cp : '';
  const salByMonth = Object.fromEntries(months.map(m => [m, 0]));
  for (const t of salaryTx) salByMonth[t.date.slice(0, 7)] += t.amount;
  const salaryMonths = Object.values(salByMonth).filter(v => v > 0);
  const salary = salaryMonths.length >= Math.min(3, months.length) ? median(salaryMonths) : 0;

  // Big one-off payments (a house deposit, a wedding) would distort monthly limits, so they are set apart:
  // anything over half a month's salary (or ₹50,000) to a payee not paid in 3 or more months.
  const cpMonths = {};
  for (const t of out) (cpMonths[t.cp] = cpMonths[t.cp] || new Set()).add(t.date.slice(0, 7));
  const bigLine = salary ? Math.max(20000, salary * 0.5) : 50000;
  // A payment over twice the monthly salary is a one-off even if the same payee was paid that way a few times (property instalments).
  const hugeLine = salary ? salary * 2 : 200000;
  for (const t of out) if (t.amount >= bigLine && (cpMonths[t.cp].size < 3 || t.amount >= hugeLine) && !learned[t.cp] && !['rent', 'emi', 'savings', 'self', 'insurance', 'education'].includes(t.cat)) t.cat = 'oneoff';

  // Fixed commitments: the same amount every month (loan EMIs, chits, rent, maintenance, schemes, SIPs).
  // Each becomes its own envelope instead of being mixed into a category.
  const fixed = [], ord = t => t.date.slice(0, 7);
  const toPerson = t => /P2A|IMPS|NEFT|RTGS|MMT|INB/.test(t.desc.toUpperCase());
  const dayDist = (a, b) => { const d = Math.abs(a - b); return Math.min(d, 31 - d); };
  const free = t => !['self', 'oneoff', 'partner'].includes(t.cat) && !String(t.cat).startsWith('fixed:');
  const userKind = cp => String(learned[cp] || '').startsWith('fixed:') ? learned[cp].slice(6) : null;
  const guessKind = (t, amt) => {
    const d = t.desc.toUpperCase(), round = amt % 500 === 0;
    if (t.cat === 'savings') return 'SIP / savings';
    if (/JEWELL|GOLD/.test(d)) return 'Gold scheme';
    if (t.cat === 'insurance') return 'Insurance';
    if (t.cat === 'rent') return 'Rent';
    if (t.cat === 'emi' || /ACH-DR|NACH|ECS/.test(d) || !round) return 'Loan EMI';
    if (toPerson(t)) return amt <= 5000 ? 'Maintenance' : 'Chit';
    return 'Other fixed';
  };
  const addFixed = (cp, amt, near, label) => {
    const day = Math.round(median(near.map(t => +t.date.slice(8))));
    const kind = userKind(cp) || guessKind(near[0], amt);
    // Chit runners sometimes ask for the month's amount to go to another account: same amount, near the usual date.
    const have = new Set(near.map(ord));
    const span = monthsBetween(ord(near[0]), months[months.length - 1]);
    const others = new Set();
    const personRound = amt % 500 === 0 && near.every(toPerson);
    for (const m of personRound ? span : []) {
      if (have.has(m)) continue;
      const alt = out.find(t => ord(t) === m && free(t) && t.cp !== cp && toPerson(t) && Math.abs(t.amount - amt) <= 1 && dayDist(+t.date.slice(8), day) <= 5);
      if (alt) { near.push(alt); have.add(m); others.add(alt.cp); }
    }
    near.sort((a, b) => a.date.localeCompare(b.date));
    const key = 'fixed:' + cp;
    for (const t of near) t.cat = key;
    const mlist = [...have].sort();
    const allLast = sorted.filter(t => t.dir === 'out' && (t.cp || counterparty(t.desc)) === cp && Math.abs(t.amount - amt) <= amt * 0.5).pop();
    const lastSeen = [allLast ? allLast.date : '', near[near.length - 1].date].sort().pop();
    const ended = monthsBetween(lastSeen.slice(0, 7), last.slice(0, 7)).length > 2;
    fixed.push({ key, cp, label, name: `${kind} · ${label}`, kind, guessed: !userKind(cp), type: kindType(kind), amount: amt, months: mlist.length,
      since: mlist[0], last: mlist[mlist.length - 1], ended, day, otherAccounts: others.size, paidTo: [...new Set(near.map(t => t.cp))].length });
  };
  const titleCase = s => s.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());

  // 1. Same payee, same amount in 5 or more months.
  const byPayeeOut = {};
  for (const t of out) if (free(t)) (byPayeeOut[t.cp] = byPayeeOut[t.cp] || []).push(t);
  const payeeCands = [];
  for (const [cp, l] of Object.entries(byPayeeOut)) {
    if (learned[cp] && !userKind(cp)) continue; // the user said this payee is not a fixed payment
    const counts = {};
    for (const t of l) { const k = Math.round(t.amount); (counts[k] = counts[k] || new Set()).add(ord(t)); }
    const [amtS, mset] = Object.entries(counts).sort((a, b) => b[1].size - a[1].size)[0];
    const amt = +amtS;
    if (mset.size < 5 || amt < 1000) continue;
    payeeCands.push({ cp, amt, near: l.filter(t => Math.abs(t.amount - amt) <= Math.max(1, amt * 0.02) || (t.amount % 500 === 0 && amt % 500 === 0 && t.amount > amt && t.amount <= amt * 1.5)) });
  }
  payeeCands.sort((a, b) => b.near.length - a.near.length);
  for (const c of payeeCands) addFixed(c.cp, c.amt, c.near.filter(free), titleCase(c.cp));

  // 2. Same amount around the same date every month, but to different accounts (chits collected by whoever won that month).
  const byAmt = {};
  for (const t of out) if (free(t) && toPerson(t) && t.amount >= 2000 && t.amount % 100 === 0) (byAmt[t.amount] = byAmt[t.amount] || []).push(t);
  for (const [amtS, l] of Object.entries(byAmt)) {
    if (new Set(l.map(ord)).size < 5) continue;
    const day = median(l.map(t => +t.date.slice(8)));
    const near = [], seenM = new Set();
    for (const t of l) if (dayDist(+t.date.slice(8), day) <= 5 && !seenM.has(ord(t))) { near.push(t); seenM.add(ord(t)); }
    if (near.length < 5 || new Set(near.map(t => t.cp)).size < 2) continue;
    const span = monthsBetween(ord(near[0]), ord(near[near.length - 1])).length;
    if (near.length / span < 0.6) continue;
    const cp = 'AMT ' + amtS;
    if (learned[cp] && !userKind(cp)) continue;
    addFixed(cp, +amtS, near, `${INRf(+amtS)} to different accounts`);
  }
  fixed.sort((a, b) => (a.ended - b.ended) || b.amount - a.amount);

  // Monthly totals per category (months with no spend count as zero).
  const cats = {};
  for (const c of ALL_CATS) cats[c.key] = { ...c, byMonth: Object.fromEntries(months.map(m => [m, 0])), total: 0, count: 0 };
  for (const t of out) { const c = cats[t.cat]; if (!c) continue; c.byMonth[t.date.slice(0, 7)] += t.amount; c.total += t.amount; c.count++; }

  // Recurring payments: same payee in at least 3 months and most months of its span, similar amounts.
  const byCp = {};
  for (const t of out) (byCp[t.cp] = byCp[t.cp] || []).push(t);
  const recurring = [];
  for (const [cp, list] of Object.entries(byCp)) {
    const mset = [...new Set(list.map(t => t.date.slice(0, 7)))];
    if (mset.length < 3) continue;
    const span = monthsBetween(mset[0], mset[mset.length - 1]).length;
    const monthly = mset.map(m => list.filter(t => t.date.startsWith(m)).reduce((a, t) => a + t.amount, 0));
    const med = median(monthly), spread = median(monthly.map(v => Math.abs(v - med))) / (med || 1);
    if (mset.length / span >= 0.6 && spread <= 0.15) recurring.push({ name: cp, cat: list[0].cat, monthly: med, months: mset.length, lastDate: list[list.length - 1].date });
  }
  recurring.sort((a, b) => b.monthly - a.monthly);

  const partialMonths = months.length < 3;

  // Suggestions: regular categories get a monthly limit; occasional ones get a monthly set-aside.
  const suggestions = fixed.map(f => ({ key: f.key, name: f.name, type: f.type, regular: true, fixed: true, commitment: f, typical: f.amount, average: f.amount, highest: f.amount, activeMonths: f.months, limit: Math.round(f.amount), off: f.ended }));
  for (const c of Object.values(cats)) {
    if (!c.total) continue;
    const vals = months.map(m => c.byMonth[m]), active = vals.filter(v => v > 0).length, share = active / months.length;
    const typical = median(vals), avg = c.total / months.length;
    const regular = share >= 0.5;
    // Regular: a month more than twice the usual is treated as a spike, so the limit follows normal months.
    const capped = vals.map(v => typical ? Math.min(v, typical * 2) : v), avgNormal = capped.reduce((a, v) => a + v, 0) / vals.length;
    const base = regular ? Math.max(typical, avgNormal) : avg; // occasional: spread the yearly total evenly
    suggestions.push({
      key: c.key, name: c.name, type: c.type, regular, typical: Math.round(typical), average: Math.round(avg),
      highest: Math.round(Math.max(...vals)), activeMonths: active, limit: roundUp(base, base > 5000 ? 500 : 100),
      fixed: ['rent', 'emi', 'insurance', 'savings'].includes(c.key), off: ['self', 'oneoff', 'partner'].includes(c.key),
    });
  }
  suggestions.sort((a, b) => (!!b.commitment - !!a.commitment) || (!!a.off - !!b.off) || (a.type === b.type ? b.limit - a.limit : a.type === 'save' ? 1 : -1));

  // Unclear payees worth a look (largest first).
  const review = Object.entries(byCp).filter(([, l]) => ['misc', 'people'].includes(l[0].cat))
    .map(([cp, l]) => ({ name: cp, cat: l[0].cat, total: Math.round(l.reduce((a, t) => a + t.amount, 0)), count: l.length, sample: l[0].desc }))
    .sort((a, b) => b.total - a.total).slice(0, 12);

  const big = out.filter(t => t.cat === 'oneoff').sort((a, b) => b.amount - a.amount).slice(0, 8)
    .map(t => ({ date: t.date, name: t.cp, amount: t.amount, cat: t.cat }));

  const n = months.length;
  const partner = { sent: Math.round(out.filter(t => t.cat === 'partner').reduce((a, t) => a + t.amount, 0) / n), got: Math.round(inc.filter(t => t.fromPartner).reduce((a, t) => a + t.amount, 0) / n) };
  const spentTotal = out.filter(t => !['self', 'partner'].includes(t.cat)).reduce((a, t) => a + t.amount, 0);
  const selfMonthly = Math.round((cats.self ? cats.self.total : 0) / months.length);
  return {
    from: months[0], to: months[months.length - 1], months: months.length, txnCount: use.length, partialMonths,
    firstDate: first, lastDate: last, salary: Math.round(salary), salaryFrom, incomeMonthly: Math.round(median(Object.values(incByMonth))),
    outMonthly: Math.round(spentTotal / months.length), selfMonthly, partner, bigLine, suggestions, recurring, review, big,
  };
}

// Merge transactions from several statements, dropping exact repeats (overlapping periods).
export function mergeTxns(lists) {
  const seen = new Set(), out = [];
  for (const t of lists.flat()) { const k = t.date + '|' + t.dir + '|' + t.amount.toFixed(2) + '|' + t.desc.slice(0, 60); if (!seen.has(k)) { seen.add(k); out.push(t); } }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/* ---------- read a file picked on the phone ---------- */
// Libraries load only when someone actually opens a statement.
let pdfjs = null;
async function loadPdf() {
  if (pdfjs) return pdfjs;
  pdfjs = await import('./vendor/pdf.min.js');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('vendor/pdf.worker.min.js', location.href).href;
  return pdfjs;
}
function loadXlsx() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  return new Promise((ok, bad) => {
    const s = document.createElement('script'); s.src = 'vendor/xlsx.full.min.js';
    s.onload = () => ok(window.XLSX); s.onerror = () => bad(new Error('Could not load the spreadsheet reader.'));
    document.head.appendChild(s);
  });
}

// Returns { txns } or throws an Error whose .code is 'password' / 'wrong-password' / 'empty'.
export async function readStatement(file, password) {
  const name = file.name.toLowerCase(), buf = await file.arrayBuffer();
  let txns, holder = '';
  if (name.endsWith('.pdf') || file.type === 'application/pdf') {
    const lib = await loadPdf();
    let pdf;
    try { pdf = await lib.getDocument({ data: new Uint8Array(buf), password: password || undefined, isEvalSupported: false }).promise; }
    catch (e) {
      if (e && e.name === 'PasswordException') { const err = new Error(password ? 'That password did not open the file.' : 'This statement is password-protected.'); err.code = password ? 'wrong-password' : 'password'; throw err; }
      throw new Error('This PDF could not be read.');
    }
    const lines = await linesFromPdf(pdf);
    pdf.destroy();
    txns = txnsFromLines(lines);
    holder = holderFrom(lines.slice(0, 60).map(l => l.cells.join(' ')));
    if (!txns.length && lines.length < 5) { const err = new Error('This PDF has no readable text. It may be a scanned image. Download the statement again from net banking as a PDF or Excel file.'); err.code = 'empty'; throw err; }
  } else if (/\.(xlsx|xls|csv|txt)$/.test(name)) {
    const X = await loadXlsx();
    const wb = name.endsWith('.csv') || name.endsWith('.txt') ? X.read(new TextDecoder().decode(buf), { type: 'string', cellDates: true }) : X.read(buf, { type: 'array', cellDates: true, password: password || undefined });
    txns = [];
    for (const sn of wb.SheetNames) { const rows = X.utils.sheet_to_json(wb.Sheets[sn], { header: 1, raw: false, defval: '' }); holder = holder || holderFrom(rows.slice(0, 60).map(r => r.join(' '))); txns = txns.concat(txnsFromTable(X.utils.sheet_to_json(wb.Sheets[sn], { header: 1, raw: true, defval: '' }))); }
  } else throw new Error('Use a PDF, Excel or CSV statement.');
  if (!txns.length) { const err = new Error('No transactions were found in this file. Try the Excel version of the statement from net banking.'); err.code = 'empty'; throw err; }
  return { txns, holder };
}
