/* MiMoni — 100% Offline-First Personal Money & Running Balance Engine */

const DB_NAME = 'MiMoniOfflineVaultDB';
const DB_VERSION = 1;

const state = {
  db: null,
  settings: {
    initialized: false,
    currency: '₹',
    startingBalance: 0,
    startingBank: 0,
    startingCash: 0,
    currentBalance: 0,
    bankBalance: 0,
    cashBalance: 0
  },
  transactions: [],
  tags: {}, // { tagName: { name, color } }
  activePocketFilter: 'ALL',
  activeTagFilter: null,
  searchQuery: '',
  sheetMode: 'DEDUCT', // 'DEDUCT' | 'ADD'
  sheetPocket: 'BANK',
  mathExpr: '0',
  currentTagColor: 'hsl(152, 78%, 52%)',
  lastDeletedTx: null,
  undoTimer: null,
  pendingOcrItems: []
};

/* --- 1. INDEXEDDB STORAGE LAYER --- */
function openVaultDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains('transactions')) {
        const txStore = db.createObjectStore('transactions', { keyPath: 'id' });
        txStore.createIndex('timestamp', 'timestamp', { unique: false });
      }
      if (!db.objectStoreNames.contains('tags')) {
        db.createObjectStore('tags', { keyPath: 'name' });
      }
      if (!db.objectStoreNames.contains('shared_queue')) {
        db.createObjectStore('shared_queue', { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function dbGet(storeName, key) {
  return new Promise((resolve, reject) => {
    const tx = state.db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function dbGetAll(storeName) {
  return new Promise((resolve, reject) => {
    const tx = state.db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

function dbPut(storeName, value) {
  return new Promise((resolve, reject) => {
    const tx = state.db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).put(value);
    tx.oncomplete = () => resolve(value);
    tx.onerror = () => reject(tx.error);
  });
}

function dbDelete(storeName, key) {
  return new Promise((resolve, reject) => {
    const tx = state.db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function dbClearStore(storeName) {
  return new Promise((resolve, reject) => {
    const tx = state.db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/* --- 2. RUNNING BALANCE RECALCULATION ENGINE --- */
async function recalculateRunningBalances() {
  const allTx = await dbGetAll('transactions');
  // Sort ascending chronologically to compute exact running balance snapshot for each entry
  allTx.sort((a, b) => a.timestamp - b.timestamp);

  let runningTotal = Number(state.settings.startingBalance) || 0;
  let runningBank = Number(state.settings.startingBank) || 0;
  let runningCash = Number(state.settings.startingCash) || 0;

  for (const item of allTx) {
    const amt = Number(item.amount) || 0;
    const delta = item.type === 'ADD' ? amt : -amt;
    item.previousBalance = runningTotal;
    runningTotal = Math.round((runningTotal + delta) * 100) / 100;
    item.runningBalance = runningTotal;

    if (item.pocket === 'CASH') {
      runningCash = Math.round((runningCash + delta) * 100) / 100;
    } else {
      runningBank = Math.round((runningBank + delta) * 100) / 100;
    }
    await dbPut('transactions', item);
  }

  state.settings.currentBalance = runningTotal;
  state.settings.bankBalance = runningBank;
  state.settings.cashBalance = runningCash;
  await dbPut('settings', { key: 'main', ...state.settings });

  // Reverse for newest-first UI display
  state.transactions = allTx.reverse();
}

/* --- 3. RANDOM VIBRANT HSL COLOR TAG GENERATOR --- */
function generateVibrantHSL() {
  const hue = Math.floor(Math.random() * 360);
  const sat = 74 + Math.floor(Math.random() * 16); // 74-90%
  const light = 54 + Math.floor(Math.random() * 10); // 54-64%
  return `hsl(${hue}, ${sat}%, ${light}%)`;
}

function ensureTagColor(tagName) {
  const clean = (tagName || 'General').trim();
  if (state.tags[clean]) {
    return state.tags[clean].color;
  }
  const newColor = generateVibrantHSL();
  state.tags[clean] = { name: clean, color: newColor };
  dbPut('tags', state.tags[clean]);
  return newColor;
}

/* --- 4. ANIMATED ROLLING NUMBER COUNTER --- */
let displayedHeroBalance = 0;
function animateBalanceCounter(targetValue) {
  const el = document.getElementById('rollingBalanceValue');
  if (!el) return;
  const startValue = displayedHeroBalance;
  const diff = targetValue - startValue;
  const duration = 420;
  const startTime = performance.now();

  function frame(now) {
    const progress = Math.min(1, (now - startTime) / duration);
    const eased = 1 - Math.pow(1 - progress, 3);
    const current = startValue + diff * eased;
    el.textContent = formatMoneyNumber(current);
    if (progress < 1) {
      requestAnimationFrame(frame);
    } else {
      displayedHeroBalance = targetValue;
      el.textContent = formatMoneyNumber(targetValue);
    }
  }
  requestAnimationFrame(frame);
}

function formatMoneyNumber(val) {
  const num = Number(val) || 0;
  return num.toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

/* --- 5. SAFE INLINE MATH KEYPAD EVALUATOR --- */
function evaluateMathExpression(expr) {
  const sanitized = String(expr || '0').replace(/[^0-9.+\-*/]/g, '');
  if (!sanitized) return 0;
  // Trim trailing operators for live preview
  const trimmed = sanitized.replace(/[+\-*/.]+$/, '');
  if (!trimmed) return 0;

  try {
    // Tokenize numbers and basic + - * / operators safely without eval
    const tokens = trimmed.match(/(\d+\.?\d*|\d*\.\d+|[+\-*/])/g);
    if (!tokens) return 0;

    // First pass: * and /
    const pass1 = [];
    let i = 0;
    while (i < tokens.length) {
      const t = tokens[i];
      if (t === '*' || t === '/') {
        const prev = parseFloat(pass1.pop() || '0');
        const next = parseFloat(tokens[i + 1] || '1');
        const res = t === '*' ? prev * next : (next !== 0 ? prev / next : 0);
        pass1.push(res);
        i += 2;
      } else {
        pass1.push(t);
        i += 1;
      }
    }

    // Second pass: + and -
    let result = parseFloat(pass1[0] || '0');
    let j = 1;
    while (j < pass1.length) {
      const op = pass1[j];
      const val = parseFloat(pass1[j + 1] || '0');
      if (op === '+') result += val;
      if (op === '-') result -= val;
      j += 2;
    }

    return isFinite(result) ? Math.max(0, Math.round(result * 100) / 100) : 0;
  } catch {
    return 0;
  }
}

/* --- 6. RENDER UI & TIMELINE --- */
function renderAppUI() {
  const cur = state.settings.currency || '₹';
  document.getElementById('currencySymbolHero').textContent = cur;
  document.getElementById('sheetCurrencySign').textContent = cur;

  let heroTarget = state.settings.currentBalance;
  if (state.activePocketFilter === 'BANK') heroTarget = state.settings.bankBalance;
  if (state.activePocketFilter === 'CASH') heroTarget = state.settings.cashBalance;
  animateBalanceCounter(heroTarget);

  document.getElementById('bankBalanceText').textContent = `${cur}${formatMoneyNumber(state.settings.bankBalance)}`;
  document.getElementById('cashBalanceText').textContent = `${cur}${formatMoneyNumber(state.settings.cashBalance)}`;

  // Calculate filtered metrics
  let totalIn = 0;
  let totalOut = 0;
  const filteredTx = state.transactions.filter((tx) => {
    if (state.activePocketFilter !== 'ALL' && tx.pocket !== state.activePocketFilter) return false;
    if (state.activeTagFilter && tx.tag !== state.activeTagFilter) return false;
    if (state.searchQuery) {
      const q = state.searchQuery.toLowerCase();
      const matchTag = (tx.tag || '').toLowerCase().includes(q);
      const matchNote = (tx.note || '').toLowerCase().includes(q);
      const matchAmt = String(tx.amount).includes(q);
      if (!matchTag && !matchNote && !matchAmt) return false;
    }
    return true;
  });

  for (const tx of filteredTx) {
    if (tx.type === 'ADD') totalIn += Number(tx.amount) || 0;
    else totalOut += Number(tx.amount) || 0;
  }

  document.getElementById('totalInflowText').textContent = `+${cur}${formatMoneyNumber(totalIn)}`;
  document.getElementById('totalOutflowText').textContent = `-${cur}${formatMoneyNumber(totalOut)}`;

  renderTagFilterBar();
  renderSavedTagsInSheet();
  renderTransactionsTimeline(filteredTx);
}

function renderTagFilterBar() {
  const container = document.getElementById('activeTagFilterRow');
  const tagList = Object.values(state.tags);
  if (tagList.length === 0) {
    container.innerHTML = '';
    return;
  }

  let html = `<button type="button" class="filter-tag-pill ${!state.activeTagFilter ? 'active' : ''}" data-filter-tag="">All Tags</button>`;
  for (const t of tagList) {
    const isAct = state.activeTagFilter === t.name ? 'active' : '';
    html += `
      <button type="button" class="filter-tag-pill ${isAct}" data-filter-tag="${escapeHtml(t.name)}">
        <span style="width:8px;height:8px;border-radius:50%;background:${t.color};display:inline-block;"></span>
        ${escapeHtml(t.name)}
      </button>
    `;
  }
  container.innerHTML = html;

  container.querySelectorAll('.filter-tag-pill').forEach((btn) => {
    btn.addEventListener('click', () => {
      const val = btn.getAttribute('data-filter-tag');
      state.activeTagFilter = val || null;
      renderAppUI();
    });
  });
}

function renderSavedTagsInSheet() {
  const strip = document.getElementById('savedTagChipsRow');
  const tagList = Object.values(state.tags);
  if (tagList.length === 0) {
    strip.innerHTML = '';
    return;
  }
  strip.innerHTML = tagList.map((t) => `
    <button type="button" class="saved-tag-chip tactile-btn" data-tag-name="${escapeHtml(t.name)}" data-tag-color="${t.color}" style="background:${t.color}22;color:${t.color};border-color:${t.color}55;">
      <span>●</span> ${escapeHtml(t.name)}
    </button>
  `).join('');

  strip.querySelectorAll('.saved-tag-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const name = chip.getAttribute('data-tag-name');
      const color = chip.getAttribute('data-tag-color');
      document.getElementById('tagInputField').value = name;
      state.currentTagColor = color;
      document.getElementById('currentTagColorSwatch').style.background = color;
    });
  });
}

function renderTransactionsTimeline(list) {
  const emptyBox = document.getElementById('emptyStateBox');
  const listEl = document.getElementById('transactionsList');
  const cur = state.settings.currency || '₹';

  if (list.length === 0) {
    emptyBox.classList.remove('hidden');
    listEl.innerHTML = '';
    return;
  }

  emptyBox.classList.add('hidden');
  listEl.innerHTML = list.map((tx) => {
    const isAdd = tx.type === 'ADD';
    const sign = isAdd ? '+' : '−';
    const amtClass = isAdd ? 'add' : 'deduct';
    const color = tx.tagColor || '#2ED573';
    const initial = (tx.tag || 'G').charAt(0).toUpperCase();
    const dateStr = new Date(tx.timestamp).toLocaleString([], {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });

    return `
      <div class="tx-swipe-wrapper" data-id="${tx.id}">
        <div class="tx-swipe-bg">
          <span class="dup-hint">⟳ Duplicate</span>
          <span class="del-hint">Delete ✕</span>
        </div>
        <article class="tx-card" data-id="${tx.id}">
          <div class="tx-left">
            <div class="tx-tag-avatar" style="background:${color}24;color:${color};border:1.5px solid ${color}66;">
              ${escapeHtml(initial)}
            </div>
            <div class="tx-meta">
              <div class="tx-title-row">
                <span class="tx-tag-badge" style="color:${color};">${escapeHtml(tx.tag)}</span>
                <span class="tx-pocket-pill">${tx.pocket || 'BANK'}</span>
                ${tx.receiptThumb ? '<span class="tx-receipt-badge">📷 Receipt</span>' : ''}
              </div>
              <div class="tx-note-sub">
                ${tx.note ? escapeHtml(tx.note) + ' • ' : ''}${dateStr}
              </div>
            </div>
          </div>
          <div class="tx-right">
            <div class="tx-amount ${amtClass}">${sign}${cur}${formatMoneyNumber(tx.amount)}</div>
            <div class="tx-running-snapshot">Bal: ${cur}${formatMoneyNumber(tx.runningBalance)}</div>
          </div>
        </article>
      </div>
    `;
  }).join('');

  attachSwipeAndTapHandlers();
}

/* --- 7. HORIZONTAL SWIPE GESTURES (RIGHT = DUPLICATE, LEFT = DELETE) --- */
function attachSwipeAndTapHandlers() {
  const cards = document.querySelectorAll('.tx-card');
  cards.forEach((card) => {
    let startX = 0;
    let currentX = 0;
    let isDragging = false;
    const id = card.getAttribute('data-id');

    card.addEventListener('touchstart', (e) => {
      startX = e.touches[0].clientX;
      currentX = startX;
      isDragging = true;
      card.style.transition = 'none';
    }, { passive: true });

    card.addEventListener('touchmove', (e) => {
      if (!isDragging) return;
      currentX = e.touches[0].clientX;
      const dx = currentX - startX;
      if (Math.abs(dx) > 8) {
        const clamped = Math.max(-130, Math.min(130, dx));
        card.style.transform = `translateX(${clamped}px)`;
      }
    }, { passive: true });

    card.addEventListener('touchend', async () => {
      if (!isDragging) return;
      isDragging = false;
      card.style.transition = 'transform 0.25s cubic-bezier(0.22, 1, 0.36, 1)';
      const dx = currentX - startX;

      if (dx > 85) {
        // Swipe Right -> Duplicate Transaction
        card.style.transform = 'translateX(0)';
        await duplicateTransactionById(id);
      } else if (dx < -85) {
        // Swipe Left -> Delete Transaction with Undo
        card.style.transform = 'translateX(-100%)';
        await deleteTransactionWithUndo(id);
      } else {
        card.style.transform = 'translateX(0)';
      }
    });

    // Tap to view attached receipt proof if available
    card.addEventListener('click', () => {
      const tx = state.transactions.find((t) => t.id === id);
      if (tx && tx.receiptThumb) {
        openReceiptModal(tx);
      }
    });
  });
}

async function duplicateTransactionById(id) {
  const orig = state.transactions.find((t) => t.id === id);
  if (!orig) return;
  const copy = {
    ...orig,
    id: 'tx_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
    timestamp: Date.now(),
    note: orig.note ? `${orig.note} (Copy)` : 'Duplicated entry'
  };
  await dbPut('transactions', copy);
  await recalculateRunningBalances();
  renderAppUI();
}

async function deleteTransactionWithUndo(id) {
  const target = state.transactions.find((t) => t.id === id);
  if (!target) return;
  state.lastDeletedTx = target;
  await dbDelete('transactions', id);
  await recalculateRunningBalances();
  renderAppUI();

  const toast = document.getElementById('undoToast');
  document.getElementById('undoToastText').textContent = `Deleted "${target.tag}" (${state.settings.currency}${formatMoneyNumber(target.amount)})`;
  toast.classList.add('visible');

  if (state.undoTimer) clearTimeout(state.undoTimer);
  state.undoTimer = setTimeout(() => {
    toast.classList.remove('visible');
    state.lastDeletedTx = null;
  }, 5000);
}

/* --- 8. QUICK-LOG SHEET & LIVE BALANCE PREVIEW --- */
function openQuickLogSheet() {
  state.mathExpr = '0';
  state.sheetMode = 'DEDUCT';
  state.currentTagColor = generateVibrantHSL();
  document.getElementById('currentTagColorSwatch').style.background = state.currentTagColor;
  document.getElementById('tagInputField').value = '';
  document.getElementById('noteInputField').value = '';
  syncSheetModeUI();
  updateMathDisplayAndLiveBalance();
  document.getElementById('quickLogSheetBackdrop').classList.remove('hidden');
}

function closeQuickLogSheet() {
  document.getElementById('quickLogSheetBackdrop').classList.add('hidden');
}

function syncSheetModeUI() {
  const deductBtn = document.getElementById('typeDeductBtn');
  const addBtn = document.getElementById('typeAddBtn');
  const saveBtn = document.getElementById('saveTransactionBtn');

  if (state.sheetMode === 'DEDUCT') {
    deductBtn.classList.add('active');
    addBtn.classList.remove('active');
    saveBtn.className = 'save-entry-btn deduct-mode tactile-btn';
    saveBtn.textContent = 'Deduct from Balance';
  } else {
    addBtn.classList.add('active');
    deductBtn.classList.remove('active');
    saveBtn.className = 'save-entry-btn add-mode tactile-btn';
    saveBtn.textContent = 'Add to Balance';
  }
  updateMathDisplayAndLiveBalance();
}

function updateMathDisplayAndLiveBalance() {
  const cur = state.settings.currency || '₹';
  const evaluated = evaluateMathExpression(state.mathExpr);
  document.getElementById('mathExpressionText').textContent = state.mathExpr;
  document.getElementById('mathEvaluatedPreview').textContent = `= ${cur}${formatMoneyNumber(evaluated)}`;

  const prevBal = Number(state.settings.currentBalance) || 0;
  const delta = state.sheetMode === 'ADD' ? evaluated : -evaluated;
  const nextBal = Math.round((prevBal + delta) * 100) / 100;

  document.getElementById('livePrevBalText').textContent = `${cur}${formatMoneyNumber(prevBal)}`;
  const newBalEl = document.getElementById('liveNewBalText');
  newBalEl.textContent = `${cur}${formatMoneyNumber(nextBal)}`;
  newBalEl.style.color = state.sheetMode === 'ADD' ? 'var(--mint-add)' : 'var(--coral-deduct)';
}

/* --- 9. 100% OFFLINE SCREENSHOT OCR PARSER (TESSERACT.JS + REGEX ENGINE) --- */
async function handleScreenshotFiles(fileList) {
  if (!fileList || fileList.length === 0) return;
  const drawer = document.getElementById('ocrDrawerBackdrop');
  const listEl = document.getElementById('ocrExtractedList');
  const fillEl = document.getElementById('ocrProgressFill');
  const pctEl = document.getElementById('ocrProgressPct');
  const statusEl = document.getElementById('ocrStatusSubtitle');

  drawer.classList.remove('hidden');
  listEl.innerHTML = '';
  state.pendingOcrItems = [];

  const files = Array.from(fileList);
  for (let idx = 0; idx < files.length; idx++) {
    const file = files[idx];
    statusEl.textContent = `Scanning image ${idx + 1} of ${files.length} offline...`;
    fillEl.style.width = '15%';
    pctEl.textContent = '15%';

    const thumbDataUrl = await compressReceiptThumbnail(file);
    let rawText = '';

    try {
      if (window.Tesseract) {
        const result = await window.Tesseract.recognize(file, 'eng', {
          logger: (m) => {
            if (m.status === 'recognizing text') {
              const p = Math.round((m.progress || 0) * 100);
              fillEl.style.width = `${p}%`;
              pctEl.textContent = `${p}%`;
            }
          }
        });
        rawText = (result && result.data && result.data.text) ? result.data.text : '';
      } else {
        rawText = file.name || 'Offline Receipt';
      }
    } catch (err) {
      console.warn('Tesseract fallback parser triggered:', err);
      rawText = file.name || 'Receipt Entry';
    }

    const parsedEntries = parseReceiptTextIntoTransactions(rawText, thumbDataUrl);
    state.pendingOcrItems.push(...parsedEntries);
  }

  fillEl.style.width = '100%';
  pctEl.textContent = '100%';
  statusEl.textContent = `Extracted ${state.pendingOcrItems.length} transaction(s). Review before saving:`;
  renderOcrReviewItems();
}

function compressReceiptThumbnail(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const maxW = 480;
        const scale = Math.min(1, maxW / img.width);
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', 0.68));
      };
      img.onerror = () => resolve('');
      img.src = e.target.result;
    };
    reader.onerror = () => resolve('');
    reader.readAsDataURL(file);
  });
}

function parseReceiptTextIntoTransactions(rawText, thumbDataUrl) {
  const cleanText = (rawText || '').replace(/\r/g, '\n');
  const lines = cleanText.split('\n').map((l) => l.trim()).filter(Boolean);

  const deductRegex = /\b(paid\s+to|sent\s+to|debited|dr\b|withdrawn|spent|payment\s+to)\b|-\s*[₹$€£]/i;
  const addRegex = /\b(received\s+from|credited|cr\b|added|refund|deposited|cashback)\b|\+\s*[₹$€£]/i;
  const amountRegex = /(?:₹|rs\.?|inr|\$|€|£)?\s*([0-9]{1,3}(?:,[0-9]{2,3})+(?:\.[0-9]{1,2})?|[0-9]+(?:\.[0-9]{1,2}))/gi;

  const extracted = [];
  let globalType = 'DEDUCT';
  if (addRegex.test(cleanText) && !deductRegex.test(cleanText)) {
    globalType = 'ADD';
  }

  // Search for multi-row or single-receipt amounts
  let candidateMerchant = 'Scanned Receipt';
  for (const line of lines) {
    const paidMatch = line.match(/(?:paid\s+to|sent\s+to|received\s+from|to|from)\s+([A-Za-z0-9 &._-]{2,28})/i);
    if (paidMatch && paidMatch[1]) {
      candidateMerchant = paidMatch[1].trim();
      break;
    }
  }

  const foundAmounts = [];
  for (const line of lines) {
    // Skip phone numbers, UPI IDs, or long transaction reference numbers
    if (/\b\d{10,16}\b/.test(line)) continue;
    let m;
    while ((m = amountRegex.exec(line)) !== null) {
      const rawNum = m[1].replace(/,/g, '');
      const val = parseFloat(rawNum);
      if (val > 0 && val < 10000000 && !String(val).match(/^202[0-9]$/)) {
        let lineType = globalType;
        if (addRegex.test(line)) lineType = 'ADD';
        if (deductRegex.test(line)) lineType = 'DEDUCT';
        foundAmounts.push({ amount: val, type: lineType, lineText: line });
      }
    }
  }

  if (foundAmounts.length === 0) {
    foundAmounts.push({
      amount: 100,
      type: globalType,
      lineText: 'Verify amount from screenshot'
    });
  }

  // Deduplicate identical amounts from the same receipt header+footer
  const uniqueMap = new Map();
  for (const item of foundAmounts) {
    const key = `${item.type}_${item.amount}`;
    if (!uniqueMap.has(key)) {
      uniqueMap.set(key, item);
    }
  }

  Array.from(uniqueMap.values()).slice(0, 6).forEach((entry) => {
    const tagColor = ensureTagColor(candidateMerchant);
    const isDuplicate = checkDuplicateTransaction(entry.amount, entry.type);
    extracted.push({
      tempId: 'ocr_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      selected: true,
      amount: entry.amount,
      type: entry.type,
      tag: candidateMerchant,
      tagColor,
      pocket: 'BANK',
      note: entry.lineText.slice(0, 50),
      receiptThumb: thumbDataUrl,
      rawText: cleanText.slice(0, 400),
      isDuplicate
    });
  });

  return extracted;
}

function checkDuplicateTransaction(amount, type) {
  const now = Date.now();
  return state.transactions.some((tx) => {
    const sameAmt = Math.abs(Number(tx.amount) - Number(amount)) < 0.01;
    const sameType = tx.type === type;
    const recent = Math.abs(now - tx.timestamp) < 1000 * 60 * 60 * 24; // within 24h
    return sameAmt && sameType && recent;
  });
}

function renderOcrReviewItems() {
  const listEl = document.getElementById('ocrExtractedList');
  listEl.innerHTML = state.pendingOcrItems.map((item, idx) => `
    <div class="ocr-item-card" data-idx="${idx}">
      <div class="ocr-item-top">
        <div style="display:flex;align-items:center;gap:8px;">
          <input type="checkbox" class="ocr-select-chk" data-idx="${idx}" ${item.selected ? 'checked' : ''}>
          ${item.receiptThumb ? `<img src="${item.receiptThumb}" class="ocr-thumb" alt="Receipt">` : ''}
          <span style="width:14px;height:14px;border-radius:50%;background:${item.tagColor};display:inline-block;"></span>
          <strong>Item #${idx + 1}</strong>
        </div>
        ${item.isDuplicate ? '<span class="dup-warn-badge">⚠ Duplicate Amount Detected</span>' : ''}
      </div>
      <div class="ocr-edit-grid">
        <input type="text" class="ocr-tag-input" data-idx="${idx}" value="${escapeHtml(item.tag)}" placeholder="Tag / Merchant">
        <input type="number" step="0.01" class="ocr-amt-input" data-idx="${idx}" value="${item.amount}">
        <button type="button" class="type-pill ${item.type === 'ADD' ? 'add' : 'deduct'} active ocr-type-toggle" data-idx="${idx}">
          ${item.type === 'ADD' ? '+ Cr' : '− Dr'}
        </button>
      </div>
    </div>
  `).join('');

  listEl.querySelectorAll('.ocr-select-chk').forEach((el) => {
    el.addEventListener('change', (e) => {
      const i = Number(e.target.getAttribute('data-idx'));
      state.pendingOcrItems[i].selected = e.target.checked;
    });
  });

  listEl.querySelectorAll('.ocr-tag-input').forEach((el) => {
    el.addEventListener('input', (e) => {
      const i = Number(e.target.getAttribute('data-idx'));
      state.pendingOcrItems[i].tag = e.target.value;
    });
  });

  listEl.querySelectorAll('.ocr-amt-input').forEach((el) => {
    el.addEventListener('input', (e) => {
      const i = Number(e.target.getAttribute('data-idx'));
      state.pendingOcrItems[i].amount = parseFloat(e.target.value) || 0;
    });
  });

  listEl.querySelectorAll('.ocr-type-toggle').forEach((btn) => {
    btn.addEventListener('click', () => {
      const i = Number(btn.getAttribute('data-idx'));
      const cur = state.pendingOcrItems[i].type;
      state.pendingOcrItems[i].type = cur === 'ADD' ? 'DEDUCT' : 'ADD';
      renderOcrReviewItems();
    });
  });
}

/* --- 10. BUILT-IN CANVAS PNG ICON & SCREENSHOT GENERATOR --- */
function generateAndDownloadAsset(fileName) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');

  if (fileName === 'screenshot-mobile.png') {
    canvas.width = 1080;
    canvas.height = 1920;
    ctx.fillStyle = '#0B0D12';
    ctx.fillRect(0, 0, 1080, 1920);
    ctx.fillStyle = '#151922';
    ctx.strokeStyle = '#2ED573';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.roundRect(60, 140, 960, 420, 48);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#2ED573';
    ctx.font = 'bold 88px sans-serif';
    ctx.fillText('MiMoni ₹24,850.00', 120, 370);
  } else {
    const size = fileName.includes('512') ? 512 : 192;
    const isMaskable = fileName.includes('maskable');
    canvas.width = size;
    canvas.height = size;

    ctx.fillStyle = '#0B0D12';
    ctx.fillRect(0, 0, size, size);

    const pad = isMaskable ? Math.round(size * 0.2) : Math.round(size * 0.08);
    const box = size - pad * 2;
    ctx.fillStyle = '#151922';
    ctx.strokeStyle = '#2ED573';
    ctx.lineWidth = Math.max(4, Math.round(size * 0.03));
    ctx.beginPath();
    ctx.roundRect(pad, pad, box, box, Math.round(box * 0.25));
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#2ED573';
    ctx.font = `900 ${Math.round(box * 0.52)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('M', size / 2, size / 2 + 4);
  }

  canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }, 'image/png');
}

/* --- 11. RECEIPT MODAL & RECONCILE HELPERS --- */
function openReceiptModal(tx) {
  document.getElementById('receiptModalTitle').textContent = `${tx.tag} (${state.settings.currency}${formatMoneyNumber(tx.amount)})`;
  document.getElementById('receiptProofImg').src = tx.receiptThumb;
  document.getElementById('receiptRawTextDump').textContent = tx.rawText || tx.note || 'Attached Receipt Proof';
  document.getElementById('receiptModalBackdrop').classList.remove('hidden');
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* --- 12. CHECK SHARED SCREENSHOT QUEUE FROM ANDROID SHARE SHEET --- */
async function checkAndroidShareTargetQueue() {
  try {
    const sharedItems = await dbGetAll('shared_queue');
    if (sharedItems && sharedItems.length > 0) {
      const files = sharedItems.map((entry) => entry.file).filter(Boolean);
      await dbClearStore('shared_queue');
      if (files.length > 0) {
        await handleScreenshotFiles(files);
      }
    }
  } catch (e) {
    console.warn('No shared queue items:', e);
  }
}

/* --- 13. INITIALIZATION & EVENT LISTENERS --- */
async function initMiMoniApp() {
  state.db = await openVaultDB();

  const savedSettings = await dbGet('settings', 'main');
  const savedTags = await dbGetAll('tags');
  savedTags.forEach((t) => {
    state.tags[t.name] = t;
  });

  if (!savedSettings || !savedSettings.initialized) {
    document.getElementById('onboardingModal').classList.remove('hidden');
  } else {
    state.settings = savedSettings;
    displayedHeroBalance = Number(state.settings.currentBalance) || 0;
    await recalculateRunningBalances();
    renderAppUI();
  }

  // Check if launched via Android Web Share Target
  if (window.location.search.includes('share_target=1')) {
    await checkAndroidShareTargetQueue();
    window.history.replaceState({}, document.title, './index.html');
  }

  bindUIEvents();
}

function bindUIEvents() {
  // Onboarding Split Checkbox
  const splitChk = document.getElementById('enablePocketSplitToggle');
  const splitBox = document.getElementById('pocketSplitInputs');
  splitChk.addEventListener('change', () => {
    splitBox.classList.toggle('hidden', !splitChk.checked);
  });

  // Onboarding Form Submit
  document.getElementById('onboardingForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const cur = document.getElementById('onboardCurrency').value;
    const total = parseFloat(document.getElementById('onboardTotalBalance').value) || 0;
    let bank = total;
    let cash = 0;

    if (splitChk.checked) {
      bank = parseFloat(document.getElementById('onboardBankPart').value) || 0;
      cash = parseFloat(document.getElementById('onboardCashPart').value) || 0;
    }

    state.settings = {
      initialized: true,
      currency: cur,
      startingBalance: bank + cash,
      startingBank: bank,
      startingCash: cash,
      currentBalance: bank + cash,
      bankBalance: bank,
      cashBalance: cash
    };

    await dbPut('settings', { key: 'main', ...state.settings });
    document.getElementById('onboardingModal').classList.add('hidden');
    await recalculateRunningBalances();
    renderAppUI();
  });

  // Pocket Selector Chips
  document.querySelectorAll('#pocketSelector .pocket-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#pocketSelector .pocket-chip').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.activePocketFilter = btn.getAttribute('data-pocket');
      renderAppUI();
    });
  });

  // Search Input
  document.getElementById('searchInput').addEventListener('input', (e) => {
    state.searchQuery = e.target.value.trim();
    renderAppUI();
  });

  // Open / Close Quick Log
  document.getElementById('openQuickLogBtn').addEventListener('click', openQuickLogSheet);
  document.getElementById('closeQuickLogBtn').addEventListener('click', closeQuickLogSheet);

  // Spent vs Received Toggle
  document.getElementById('typeDeductBtn').addEventListener('click', () => {
    state.sheetMode = 'DEDUCT';
    syncSheetModeUI();
  });
  document.getElementById('typeAddBtn').addEventListener('click', () => {
    state.sheetMode = 'ADD';
    syncSheetModeUI();
  });

  // Mini Pocket Selector inside Quick Log Sheet
  document.querySelectorAll('.mini-pocket-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.mini-pocket-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.sheetPocket = btn.getAttribute('data-pocket');
    });
  });

  // Shuffle Color Button
  document.getElementById('shuffleTagColorBtn').addEventListener('click', () => {
    state.currentTagColor = generateVibrantHSL();
    document.getElementById('currentTagColorSwatch').style.background = state.currentTagColor;
  });

  // Math Keypad Buttons
  document.querySelectorAll('#mathKeypad .key-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.getAttribute('data-key');
      if (key === 'BACK') {
        state.mathExpr = state.mathExpr.length > 1 ? state.mathExpr.slice(0, -1) : '0';
      } else if (['+', '-', '*', '/'].includes(key)) {
        const lastChar = state.mathExpr.slice(-1);
        if (['+', '-', '*', '/'].includes(lastChar)) {
          state.mathExpr = state.mathExpr.slice(0, -1) + key;
        } else {
          state.mathExpr += key;
        }
      } else {
        if (state.mathExpr === '0' && key !== '.') {
          state.mathExpr = key;
        } else {
          state.mathExpr += key;
        }
      }
      updateMathDisplayAndLiveBalance();
    });
  });

  document.getElementById('clearMathBtn').addEventListener('click', () => {
    state.mathExpr = '0';
    updateMathDisplayAndLiveBalance();
  });

  // Save Transaction from Quick Log
  document.getElementById('saveTransactionBtn').addEventListener('click', async () => {
    const amount = evaluateMathExpression(state.mathExpr);
    if (amount <= 0) return;

    const rawTag = document.getElementById('tagInputField').value.trim() || 'General';
    const note = document.getElementById('noteInputField').value.trim();

    // Save or update tag color
    state.tags[rawTag] = { name: rawTag, color: state.currentTagColor };
    await dbPut('tags', state.tags[rawTag]);

    const tx = {
      id: 'tx_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      amount,
      type: state.sheetMode,
      tag: rawTag,
      tagColor: state.currentTagColor,
      pocket: state.sheetPocket,
      note,
      timestamp: Date.now()
    };

    await dbPut('transactions', tx);
    await recalculateRunningBalances();
    closeQuickLogSheet();
    renderAppUI();
  });

  // Undo Delete Action
  document.getElementById('undoActionBtn').addEventListener('click', async () => {
    if (!state.lastDeletedTx) return;
    await dbPut('transactions', state.lastDeletedTx);
    state.lastDeletedTx = null;
    document.getElementById('undoToast').classList.remove('visible');
    await recalculateRunningBalances();
    renderAppUI();
  });

  // OCR File Upload
  document.getElementById('ocrFileInput').addEventListener('change', async (e) => {
    await handleScreenshotFiles(e.target.files);
    e.target.value = '';
  });

  document.getElementById('closeOcrDrawerBtn').addEventListener('click', () => {
    document.getElementById('ocrDrawerBackdrop').classList.add('hidden');
  });

  document.getElementById('commitOcrItemsBtn').addEventListener('click', async () => {
    const selected = state.pendingOcrItems.filter((item) => item.selected && item.amount > 0);
    for (const item of selected) {
      const cleanTag = (item.tag || 'Receipt').trim();
      const color = ensureTagColor(cleanTag);
      const tx = {
        id: 'tx_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
        amount: Number(item.amount),
        type: item.type,
        tag: cleanTag,
        tagColor: color,
        pocket: item.pocket || 'BANK',
        note: item.note || 'Scanned via Offline OCR',
        receiptThumb: item.receiptThumb || '',
        rawText: item.rawText || '',
        timestamp: Date.now()
      };
      await dbPut('transactions', tx);
    }
    document.getElementById('ocrDrawerBackdrop').classList.add('hidden');
    await recalculateRunningBalances();
    renderAppUI();
  });

  // Receipt Proof Modal Close
  document.getElementById('closeReceiptModalBtn').addEventListener('click', () => {
    document.getElementById('receiptModalBackdrop').classList.add('hidden');
  });

  // Reconcile Balance Modal
  const reconcileModal = document.getElementById('reconcileModalBackdrop');
  const reconcileInput = document.getElementById('reconcileActualInput');
  const reconcilePocket = document.getElementById('reconcilePocketSelect');
  const reconcilePreview = document.getElementById('reconcileDiffPreview');

  function updateReconcileDiff() {
    const pocket = reconcilePocket.value;
    const currentPocketBal = pocket === 'CASH' ? state.settings.cashBalance : state.settings.bankBalance;
    const actual = parseFloat(reconcileInput.value);
    if (isNaN(actual)) {
      reconcilePreview.textContent = `Current ${pocket} Balance: ${state.settings.currency}${formatMoneyNumber(currentPocketBal)}`;
      return;
    }
    const diff = Math.round((actual - currentPocketBal) * 100) / 100;
    const sign = diff >= 0 ? '+' : '';
    reconcilePreview.textContent = `Adjustment: ${sign}${state.settings.currency}${formatMoneyNumber(diff)}`;
  }

  document.getElementById('reconcileOpenBtn').addEventListener('click', () => {
    reconcileInput.value = '';
    updateReconcileDiff();
    reconcileModal.classList.remove('hidden');
  });

  document.getElementById('closeReconcileModalBtn').addEventListener('click', () => {
    reconcileModal.classList.add('hidden');
  });

  reconcileInput.addEventListener('input', updateReconcileDiff);
  reconcilePocket.addEventListener('change', updateReconcileDiff);

  document.getElementById('reconcileForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const pocket = reconcilePocket.value;
    const currentPocketBal = pocket === 'CASH' ? state.settings.cashBalance : state.settings.bankBalance;
    const actual = parseFloat(reconcileInput.value);
    if (isNaN(actual)) return;

    const diff = Math.round((actual - currentPocketBal) * 100) / 100;
    if (Math.abs(diff) < 0.01) {
      reconcileModal.classList.add('hidden');
      return;
    }

    const color = ensureTagColor('Reconcile');
    const tx = {
      id: 'tx_' + Date.now() + '_rec',
      amount: Math.abs(diff),
      type: diff > 0 ? 'ADD' : 'DEDUCT',
      tag: 'Reconcile',
      tagColor: color,
      pocket,
      note: `Balance reconciled to ${state.settings.currency}${formatMoneyNumber(actual)}`,
      timestamp: Date.now()
    };

    await dbPut('transactions', tx);
    await recalculateRunningBalances();
    reconcileModal.classList.add('hidden');
    renderAppUI();
  });

  // Settings Drawer & JSON Export/Import
  const settingsModal = document.getElementById('settingsModalBackdrop');
  document.getElementById('settingsOpenBtn').addEventListener('click', () => {
    settingsModal.classList.remove('hidden');
  });
  document.getElementById('closeSettingsModalBtn').addEventListener('click', () => {
    settingsModal.classList.add('hidden');
  });

  document.getElementById('exportJsonBtn').addEventListener('click', async () => {
    const payload = {
      app: 'MiMoni',
      exportedAt: new Date().toISOString(),
      settings: state.settings,
      tags: Object.values(state.tags),
      transactions: state.transactions
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `MiMoni-Backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  });

  document.getElementById('importJsonInput').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (ev) => {
      try {
        const data = JSON.parse(ev.target.result);
        if (!data || !data.settings || !Array.isArray(data.transactions)) {
          alert('Invalid MiMoni backup JSON file.');
          return;
        }
        await dbClearStore('transactions');
        await dbClearStore('tags');
        state.settings = data.settings;
        await dbPut('settings', { key: 'main', ...state.settings });

        state.tags = {};
        for (const t of (data.tags || [])) {
          state.tags[t.name] = t;
          await dbPut('tags', t);
        }
        for (const tx of data.transactions) {
          await dbPut('transactions', tx);
        }
        await recalculateRunningBalances();
        settingsModal.classList.add('hidden');
        renderAppUI();
      } catch (err) {
        alert('Failed to import JSON backup: ' + err.message);
      }
    };
    reader.readAsText(file);
  });

  // Built-in PNG Icon & Screenshot Generator Buttons
  document.querySelectorAll('.chip-download-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const targetName = btn.getAttribute('data-gen');
      generateAndDownloadAsset(targetName);
    });
  });

  // Factory Reset
  document.getElementById('factoryResetBtn').addEventListener('click', async () => {
    if (!confirm('Wipe all local transactions and reset your starting balance?')) return;
    await dbClearStore('transactions');
    await dbClearStore('tags');
    await dbClearStore('settings');
    window.location.reload();
  });
}

document.addEventListener('DOMContentLoaded', initMiMoniApp);
