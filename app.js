/* MiMoni v4 — 100% Offline-First Personal Money & Running Balance Engine */

const DB_NAME = 'MiMoniOfflineVaultDB';
const DB_VERSION = 1;

const state = {
  db: null,
  activeView: 'HOME', // 'HOME' | 'TAGS'
  settings: {
    initialized: false,
    skippedSetup: false,
    currency: '₹',
    startingBalance: 0,
    startingBank: 0,
    startingCash: 0,
    currentBalance: 0,
    bankBalance: 0,
    cashBalance: 0
  },
  transactions: [],
  tags: {}, // { name: { name, color, grouped: boolean, expanded: boolean } }
  activePocketFilter: 'ALL',
  searchQuery: '',
  tagPageSearchQuery: '',
  sheetMode: 'DEDUCT', // 'DEDUCT' | 'ADD'
  sheetPocket: 'BANK',
  mathExpr: '0',
  currentTagColor: 'hsl(152, 78%, 52%)',
  editingTxId: null,
  selectedDetailTxId: null,
  lastDeletedTx: null,
  undoTimer: null,
  pendingOcrItems: [],
  pendingGroupCandidate: null,
  dismissedGroupPrompts: {}
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

  state.transactions = allTx.reverse();
}

/* --- 3. RANDOM VIBRANT HSL COLOR TAG GENERATOR & TAG GROUPING ENGINE --- */
function generateVibrantHSL() {
  const hue = Math.floor(Math.random() * 360);
  const sat = 74 + Math.floor(Math.random() * 16);
  const light = 54 + Math.floor(Math.random() * 10);
  return `hsl(${hue}, ${sat}%, ${light}%)`;
}

function ensureTagColor(tagName) {
  const clean = (tagName || 'General').trim();
  const existing = Object.values(state.tags).find(
    (t) => t.name.toLowerCase() === clean.toLowerCase()
  );
  if (existing) {
    return existing.color;
  }
  const newColor = generateVibrantHSL();
  state.tags[clean] = { name: clean, color: newColor, grouped: false, expanded: false };
  dbPut('tags', state.tags[clean]);
  return newColor;
}

/* Detect same-name tags that have >=2 transactions and are not yet grouped */
function detectUngroupedDuplicateTags() {
  const counts = {};
  const canonicalNames = {};
  for (const tx of state.transactions) {
    const raw = (tx.tag || 'General').trim();
    const key = raw.toLowerCase();
    counts[key] = (counts[key] || 0) + 1;
    if (!canonicalNames[key]) canonicalNames[key] = raw;
  }

  const candidates = [];
  for (const key of Object.keys(counts)) {
    if (counts[key] >= 2) {
      const displayName = canonicalNames[key];
      const tagObj = state.tags[displayName] || Object.values(state.tags).find((t) => t.name.toLowerCase() === key);
      const isAlreadyGrouped = tagObj && tagObj.grouped === true;
      if (!isAlreadyGrouped) {
        candidates.push({ key, name: displayName, count: counts[key] });
      }
    }
  }
  return candidates;
}

async function groupTransactionsUnderTag(tagName) {
  const clean = (tagName || 'General').trim();
  const key = clean.toLowerCase();
  const unifiedColor = ensureTagColor(clean);

  for (const tx of state.transactions) {
    if ((tx.tag || '').trim().toLowerCase() === key) {
      tx.tag = clean;
      tx.tagColor = unifiedColor;
      await dbPut('transactions', tx);
    }
  }

  state.tags[clean] = {
    name: clean,
    color: unifiedColor,
    grouped: true,
    expanded: true
  };
  await dbPut('tags', state.tags[clean]);
  state.pendingGroupCandidate = null;
  renderAppUI();
}

/* --- 4. ANIMATED ROLLING NUMBER COUNTER --- */
let displayedHeroBalance = 0;
function animateBalanceCounter(targetValue) {
  const el = document.getElementById('rollingBalanceValue');
  if (!el) return;
  const startValue = displayedHeroBalance;
  const diff = targetValue - startValue;
  const duration = 380;
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

function toLocalDatetimeInputString(ts) {
  const d = new Date(ts || Date.now());
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/* --- 5. SAFE INLINE MATH KEYPAD EVALUATOR --- */
function evaluateMathExpression(expr) {
  const sanitized = String(expr || '0').replace(/[^0-9.+\-*/]/g, '');
  if (!sanitized) return 0;
  const trimmed = sanitized.replace(/[+\-*/.]+$/, '');
  if (!trimmed) return 0;

  try {
    const tokens = trimmed.match(/(\d+\.?\d*|\d*\.\d+|[+\-*/])/g);
    if (!tokens) return 0;

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

/* --- 6. RENDER UI, BANNERS, HOME TIMELINE & DEDICATED TAGS PAGE --- */
function renderAppUI() {
  const cur = state.settings.currency || '₹';
  document.getElementById('currencySymbolHero').textContent = cur;
  document.getElementById('sheetCurrencySign').textContent = cur;

  const setupBanner = document.getElementById('setupPromptBanner');
  if (!state.settings.initialized && state.settings.skippedSetup) {
    setupBanner.classList.remove('hidden');
  } else {
    setupBanner.classList.add('hidden');
  }

  const ungroupedCandidates = detectUngroupedDuplicateTags();
  const ungroupedBadge = document.getElementById('ungroupedBadge');
  const groupingBanner = document.getElementById('tagGroupingPromptBanner');

  if (ungroupedCandidates.length > 0) {
    ungroupedBadge.classList.remove('hidden');
    ungroupedBadge.textContent = String(ungroupedCandidates.length);
    const firstCandidate = ungroupedCandidates.find((c) => !state.dismissedGroupPrompts[c.key]);
    if (firstCandidate) {
      state.pendingGroupCandidate = firstCandidate;
      document.getElementById('groupingPromptText').textContent =
        `Same tag "${firstCandidate.name}" used ${firstCandidate.count} times. Group into a single "${firstCandidate.name}" tag folder?`;
      groupingBanner.classList.remove('hidden');
    } else {
      groupingBanner.classList.add('hidden');
    }
  } else {
    ungroupedBadge.classList.add('hidden');
    groupingBanner.classList.add('hidden');
  }

  let heroTarget = state.settings.currentBalance;
  if (state.activePocketFilter === 'BANK') heroTarget = state.settings.bankBalance;
  if (state.activePocketFilter === 'CASH') heroTarget = state.settings.cashBalance;
  animateBalanceCounter(heroTarget);

  document.getElementById('bankBalanceText').textContent = `${cur}${formatMoneyNumber(state.settings.bankBalance)}`;
  document.getElementById('cashBalanceText').textContent = `${cur}${formatMoneyNumber(state.settings.cashBalance)}`;

  let totalIn = 0;
  let totalOut = 0;
  const filteredTx = state.transactions.filter((tx) => {
    if (state.activePocketFilter !== 'ALL' && tx.pocket !== state.activePocketFilter) return false;
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

  renderSavedTagsInSheet();
  renderTransactionsTimeline(filteredTx);
  renderDedicatedTagsPage(ungroupedCandidates);
}

function switchAppView(viewName) {
  state.activeView = viewName;
  const homeView = document.getElementById('homePageView');
  const tagsView = document.getElementById('tagsPageView');
  const navHome = document.getElementById('navHomeBtn');
  const navTags = document.getElementById('navTagsBtn');

  if (viewName === 'TAGS') {
    homeView.classList.add('hidden');
    tagsView.classList.remove('hidden');
    navHome.classList.remove('active');
    navTags.classList.add('active');
  } else {
    tagsView.classList.add('hidden');
    homeView.classList.remove('hidden');
    navTags.classList.remove('active');
    navHome.classList.add('active');
  }
  renderAppUI();
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

function buildTransactionCardHTML(tx, cur) {
  const isAdd = tx.type === 'ADD';
  const sign = isAdd ? '+' : '−';
  const amtClass = isAdd ? 'add' : 'deduct';
  const color = tx.tagColor || '#2ED573';
  const tagName = (tx.tag && tx.tag.trim()) ? tx.tag.trim() : 'General';
  const initial = tagName.charAt(0).toUpperCase();
  const dateStr = new Date(tx.timestamp).toLocaleString([], {
    year: 'numeric',
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
              <span class="tx-tag-badge" style="color:${color};background:${color}1F;border:1px solid ${color}55;">
                ● ${escapeHtml(tagName)}
              </span>
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
  listEl.innerHTML = list.map((tx) => buildTransactionCardHTML(tx, cur)).join('');
  attachSwipeAndTapHandlers(listEl);
}

/* --- 7. DEDICATED TAGS SECTION (UNLIMITED SCROLLABLE + CLEAR DROPDOWN GROUPS + FULL SINGLE CARDS) --- */
function renderDedicatedTagsPage(ungroupedCandidates) {
  const suggestionBox = document.getElementById('unmergedTagsSuggestionBox');
  const container = document.getElementById('tagsGroupsContainer');
  const countBadge = document.getElementById('totalTagsCountBadge');
  const cur = state.settings.currency || '₹';
  const q = (state.tagPageSearchQuery || '').toLowerCase();

  // 1. Prompt Banner for Same-Name Tags that the user hasn't grouped yet
  if (ungroupedCandidates && ungroupedCandidates.length > 0) {
    suggestionBox.innerHTML = ungroupedCandidates.map((cand) => `
      <div class="unmerged-card">
        <div class="unmerged-card-info">
          <strong>"${escapeHtml(cand.name)}" (${cand.count} transactions)</strong>
          <div>Same tag name detected. Group all ${cand.count} transactions into a single dropdown tag group?</div>
        </div>
        <button type="button" class="group-confirm-btn tactile-btn" data-merge-tag="${escapeHtml(cand.name)}">Group (${cand.count})</button>
      </div>
    `).join('');

    suggestionBox.querySelectorAll('[data-merge-tag]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const tagName = btn.getAttribute('data-merge-tag');
        groupTransactionsUnderTag(tagName);
      });
    });
  } else {
    suggestionBox.innerHTML = '';
  }

  if (state.transactions.length === 0) {
    countBadge.textContent = '0 Tags';
    container.innerHTML = `
      <div class="empty-state">
        <h2>No Tagged Transactions Yet</h2>
        <p>Create as many tags as you want—every single tag and grouped tag folder will be listed and scrollable here.</p>
      </div>
    `;
    return;
  }

  const matchingTx = state.transactions.filter((tx) => {
    if (!q) return true;
    return (
      (tx.tag || '').toLowerCase().includes(q) ||
      (tx.note || '').toLowerCase().includes(q) ||
      String(tx.amount).includes(q)
    );
  });

  const groupedFoldersMap = new Map();
  const singleOrUnmergedList = [];

  const tagCounts = {};
  for (const tx of state.transactions) {
    const k = (tx.tag || 'General').trim().toLowerCase();
    tagCounts[k] = (tagCounts[k] || 0) + 1;
  }

  for (const tx of matchingTx) {
    const rawName = (tx.tag || 'General').trim();
    const lower = rawName.toLowerCase();
    const tagMeta = state.tags[rawName] || Object.values(state.tags).find((t) => t.name.toLowerCase() === lower);
    const isExplicitlyGrouped = Boolean(tagMeta && tagMeta.grouped && tagCounts[lower] >= 2);

    if (isExplicitlyGrouped) {
      if (!groupedFoldersMap.has(lower)) {
        groupedFoldersMap.set(lower, {
          key: lower,
          name: tagMeta ? tagMeta.name : rawName,
          color: (tagMeta && tagMeta.color) || tx.tagColor || '#2ED573',
          expanded: Boolean(tagMeta && tagMeta.expanded),
          items: [],
          netAmount: 0
        });
      }
      const folder = groupedFoldersMap.get(lower);
      folder.items.push(tx);
      const amt = Number(tx.amount) || 0;
      folder.netAmount += tx.type === 'ADD' ? amt : -amt;
    } else {
      singleOrUnmergedList.push(tx);
    }
  }

  const totalDisplayedUnits = groupedFoldersMap.size + singleOrUnmergedList.length;
  countBadge.textContent = `${totalDisplayedUnits} ${totalDisplayedUnits === 1 ? 'Tag Item' : 'Tag Items'}`;

  const htmlParts = [];

  // Section A: Grouped Repeating Tags (Dropdown Folders)
  if (groupedFoldersMap.size > 0) {
    htmlParts.push(`
      <div class="tags-section-divider">
        <span>Grouped Repeating Tags (Tap Group to Drop Down)</span>
        <span>${groupedFoldersMap.size} Groups</span>
      </div>
    `);

    for (const g of groupedFoldersMap.values()) {
      const sign = g.netAmount >= 0 ? '+' : '−';
      const netColor = g.netAmount >= 0 ? 'var(--mint-add)' : 'var(--coral-deduct)';
      const expandedClass = g.expanded ? 'expanded' : '';
      const txWord = g.items.length === 1 ? 'Transaction' : 'Transactions';

      htmlParts.push(`
        <div class="tag-group-card ${expandedClass}" data-group-name="${escapeHtml(g.name)}">
          <button type="button" class="tag-group-header" data-toggle-group="${escapeHtml(g.name)}" aria-expanded="${g.expanded ? 'true' : 'false'}">
            <div class="tag-group-left">
              <span class="tag-group-dot" style="background:${g.color};"></span>
              <span class="tag-group-title" style="color:${g.color};">${escapeHtml(g.name)}</span>
              <span class="tag-group-count">${g.items.length} ${txWord}</span>
            </div>
            <div class="tag-group-right">
              <span class="tag-group-net" style="color:${netColor};">${sign}${cur}${formatMoneyNumber(Math.abs(g.netAmount))}</span>
              <span class="tag-group-chevron">▼</span>
            </div>
          </button>
          <div class="tag-group-tx-list ${g.expanded ? '' : 'hidden'}">
            ${g.items.map((tx) => buildTransactionCardHTML(tx, cur)).join('')}
          </div>
        </div>
      `);
    }
  }

  // Section B: All Single / Individual Non-Repeating Tagged Transactions
  if (singleOrUnmergedList.length > 0) {
    htmlParts.push(`
      <div class="tags-section-divider">
        <span>Single & Individual Tagged Transactions</span>
        <span>${singleOrUnmergedList.length} Transactions</span>
      </div>
    `);

    for (const tx of singleOrUnmergedList) {
      const rawName = (tx.tag || 'General').trim();
      const lower = rawName.toLowerCase();
      const color = tx.tagColor || '#2ED573';
      const countForThisTag = tagCounts[lower] || 1;
      const isRepeatingUnmerged = countForThisTag >= 2;

      htmlParts.push(`
        <div class="single-tag-entry-card">
          <div class="single-tag-pill-header">
            <div class="single-tag-name-wrap" style="color:${color};">
              <span class="tag-group-dot" style="background:${color};width:11px;height:11px;"></span>
              <span>${escapeHtml(rawName)}</span>
            </div>
            ${
              isRepeatingUnmerged
                ? `<button type="button" class="group-confirm-btn tactile-btn" style="padding:4px 10px;font-size:0.68rem;" data-merge-tag-inline="${escapeHtml(rawName)}">Group (${countForThisTag} Transactions)</button>`
                : `<span class="single-tag-kind-badge">1 Transaction • Single Tag</span>`
            }
          </div>
          ${buildTransactionCardHTML(tx, cur)}
        </div>
      `);
    }
  }

  htmlParts.push(`
    <div class="end-of-tags-marker">
      — Showing all ${totalDisplayedUnits} tag group(s) & tagged transaction(s) —
    </div>
  `);

  container.innerHTML = htmlParts.join('');

  // Toggle expand/minimize on grouped tag folders
  container.querySelectorAll('[data-toggle-group]').forEach((hdr) => {
    hdr.addEventListener('click', () => {
      const name = hdr.getAttribute('data-toggle-group');
      const lower = name.toLowerCase();
      let tagMeta = state.tags[name] || Object.values(state.tags).find((t) => t.name.toLowerCase() === lower);
      if (!tagMeta) {
        tagMeta = { name, color: ensureTagColor(name), grouped: true, expanded: true };
        state.tags[name] = tagMeta;
      } else {
        tagMeta.expanded = !tagMeta.expanded;
      }
      dbPut('tags', tagMeta);
      renderAppUI();
    });
  });

  // Inline group button for repeating unmerged tags
  container.querySelectorAll('[data-merge-tag-inline]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const name = btn.getAttribute('data-merge-tag-inline');
      groupTransactionsUnderTag(name);
    });
  });

  attachSwipeAndTapHandlers(container);
}

/* --- 8. SWIPE GESTURES & TAP FOR FULL TRANSACTION DETAILS DIALOG CARD --- */
function attachSwipeAndTapHandlers(rootEl) {
  const cards = (rootEl || document).querySelectorAll('.tx-card');
  cards.forEach((card) => {
    let startX = 0;
    let currentX = 0;
    let isDragging = false;
    let movedSignificantly = false;
    const id = card.getAttribute('data-id');

    card.addEventListener('touchstart', (e) => {
      startX = e.touches[0].clientX;
      currentX = startX;
      isDragging = true;
      movedSignificantly = false;
      card.style.transition = 'none';
    }, { passive: true });

    card.addEventListener('touchmove', (e) => {
      if (!isDragging) return;
      currentX = e.touches[0].clientX;
      const dx = currentX - startX;
      if (Math.abs(dx) > 10) {
        movedSignificantly = true;
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
        card.style.transform = 'translateX(0)';
        await duplicateTransactionById(id);
      } else if (dx < -85) {
        card.style.transform = 'translateX(-100%)';
        await deleteTransactionWithUndo(id);
      } else {
        card.style.transform = 'translateX(0)';
      }
    });

    card.addEventListener('click', () => {
      if (movedSignificantly) return;
      openTransactionDetailsModal(id);
    });
  });
}

function openTransactionDetailsModal(txId) {
  const tx = state.transactions.find((t) => t.id === txId);
  if (!tx) return;
  state.selectedDetailTxId = tx.id;

  const cur = state.settings.currency || '₹';
  const isAdd = tx.type === 'ADD';
  const sign = isAdd ? '+' : '−';
  const color = tx.tagColor || '#2ED573';
  const tagName = (tx.tag && tx.tag.trim()) ? tx.tag.trim() : 'General';

  document.getElementById('txDetailTypeBadge').textContent = isAdd ? 'RECEIVED (+) TRANSACTION' : 'SPENT (−) TRANSACTION';
  const avatar = document.getElementById('txDetailAvatar');
  avatar.textContent = tagName.charAt(0).toUpperCase();
  avatar.style.background = `${color}24`;
  avatar.style.color = color;
  avatar.style.border = `1.5px solid ${color}66`;

  const titleEl = document.getElementById('txDetailModalTitle');
  titleEl.textContent = tagName;
  titleEl.style.color = color;

  const tagPillEl = document.getElementById('txDetailTagPillText');
  if (tagPillEl) {
    tagPillEl.textContent = `● ${tagName}`;
    tagPillEl.style.color = color;
  }

  const amtEl = document.getElementById('txDetailAmountBig');
  amtEl.textContent = `${sign}${cur}${formatMoneyNumber(tx.amount)}`;
  amtEl.style.color = isAdd ? 'var(--mint-add)' : 'var(--coral-deduct)';

  const fullDate = new Date(tx.timestamp).toLocaleString([], {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
  document.getElementById('txDetailDateText').textContent = fullDate;
  document.getElementById('txDetailPocketText').textContent = tx.pocket || 'BANK';
  document.getElementById('txDetailRunningBalText').textContent =
    `${cur}${formatMoneyNumber(tx.previousBalance)} → ${cur}${formatMoneyNumber(tx.runningBalance)}`;
  document.getElementById('txDetailNoteText').textContent =
    tx.note && tx.note.trim() ? tx.note : 'No additional notes recorded for this entry.';

  const receiptSec = document.getElementById('txDetailReceiptSection');
  if (tx.receiptThumb) {
    receiptSec.classList.remove('hidden');
    document.getElementById('txDetailReceiptImg').src = tx.receiptThumb;
    document.getElementById('txDetailRawOcrText').textContent = tx.rawText || 'No raw OCR text stored.';
  } else {
    receiptSec.classList.add('hidden');
  }

  document.getElementById('txDetailModalBackdrop').classList.remove('hidden');
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

/* --- 9. QUICK-LOG & EDIT SHEET WITH DATE PICKER --- */
function openQuickLogSheet(editTx = null) {
  if (editTx) {
    state.editingTxId = editTx.id;
    state.mathExpr = String(editTx.amount);
    state.sheetMode = editTx.type || 'DEDUCT';
    state.sheetPocket = editTx.pocket || 'BANK';
    state.currentTagColor = editTx.tagColor || ensureTagColor(editTx.tag);
    document.getElementById('currentTagColorSwatch').style.background = state.currentTagColor;
    document.getElementById('tagInputField').value = editTx.tag || '';
    document.getElementById('noteInputField').value = editTx.note || '';
    document.getElementById('dateInputField').value = toLocalDatetimeInputString(editTx.timestamp);
    document.getElementById('editingModeBanner').classList.remove('hidden');
  } else {
    state.editingTxId = null;
    state.mathExpr = '0';
    state.sheetMode = 'DEDUCT';
    state.sheetPocket = 'BANK';
    state.currentTagColor = generateVibrantHSL();
    document.getElementById('currentTagColorSwatch').style.background = state.currentTagColor;
    document.getElementById('tagInputField').value = '';
    document.getElementById('noteInputField').value = '';
    document.getElementById('dateInputField').value = toLocalDatetimeInputString(Date.now());
    document.getElementById('editingModeBanner').classList.add('hidden');
  }

  document.querySelectorAll('.mini-pocket-btn').forEach((b) => {
    b.classList.toggle('active', b.getAttribute('data-pocket') === state.sheetPocket);
  });

  syncSheetModeUI();
  updateMathDisplayAndLiveBalance();
  document.getElementById('quickLogSheetBackdrop').classList.remove('hidden');
}

function closeQuickLogSheet() {
  state.editingTxId = null;
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
    saveBtn.textContent = state.editingTxId ? 'Update Spent Entry' : 'Deduct from Balance';
  } else {
    addBtn.classList.add('active');
    deductBtn.classList.remove('active');
    saveBtn.className = 'save-entry-btn add-mode tactile-btn';
    saveBtn.textContent = state.editingTxId ? 'Update Received Entry' : 'Add to Balance';
  }
  updateMathDisplayAndLiveBalance();
}

function updateMathDisplayAndLiveBalance() {
  const cur = state.settings.currency || '₹';
  const evaluated = evaluateMathExpression(state.mathExpr);
  document.getElementById('mathExpressionText').textContent = state.mathExpr;
  document.getElementById('mathEvaluatedPreview').textContent = `= ${cur}${formatMoneyNumber(evaluated)}`;

  let baseBal = Number(state.settings.currentBalance) || 0;
  if (state.editingTxId) {
    const oldTx = state.transactions.find((t) => t.id === state.editingTxId);
    if (oldTx) {
      const oldDelta = oldTx.type === 'ADD' ? Number(oldTx.amount) : -Number(oldTx.amount);
      baseBal = Math.round((baseBal - oldDelta) * 100) / 100;
    }
  }

  const delta = state.sheetMode === 'ADD' ? evaluated : -evaluated;
  const nextBal = Math.round((baseBal + delta) * 100) / 100;

  document.getElementById('livePrevBalText').textContent = `${cur}${formatMoneyNumber(baseBal)}`;
  const newBalEl = document.getElementById('liveNewBalText');
  newBalEl.textContent = `${cur}${formatMoneyNumber(nextBal)}`;
  newBalEl.style.color = state.sheetMode === 'ADD' ? 'var(--mint-add)' : 'var(--coral-deduct)';
}

/* --- 10. HIGH-ACCURACY OFFLINE SCREENSHOT OCR ENGINE --- */
async function handleScreenshotFiles(fileList) {
  if (!fileList || fileList.length === 0) return;
  const drawer = document.getElementById('ocrDrawerBackdrop');
  const listEl = document.getElementById('ocrExtractedList');
  const fillEl = document.getElementById('ocrProgressFill');
  const pctEl = document.getElementById('ocrProgressPct');
  const statusEl = document.getElementById('ocrStatusSubtitle');
  const inspectorEl = document.getElementById('ocrInspectorContent');

  drawer.classList.remove('hidden');
  listEl.innerHTML = '';
  inspectorEl.textContent = 'Running dual-pass canvas contrast enhancement and OCR...';
  state.pendingOcrItems = [];

  const files = Array.from(fileList);
  const allRawDumps = [];

  for (let idx = 0; idx < files.length; idx++) {
    const file = files[idx];
    statusEl.textContent = `Enhancing & scanning screenshot ${idx + 1} of ${files.length}...`;
    fillEl.style.width = '12%';
    pctEl.textContent = '12%';

    const thumbDataUrl = await compressReceiptThumbnail(file);
    const preprocessedBlobs = await createPreprocessedOcrCanvases(file);

    let combinedRawText = '';
    try {
      if (window.Tesseract) {
        const res1 = await window.Tesseract.recognize(preprocessedBlobs.standardCanvas, 'eng', {
          logger: (m) => {
            if (m.status === 'recognizing text') {
              const p = Math.min(95, Math.round((m.progress || 0) * 85) + 10);
              fillEl.style.width = `${p}%`;
              pctEl.textContent = `${p}%`;
            }
          }
        });
        combinedRawText = (res1 && res1.data && res1.data.text) ? res1.data.text : '';

        if (combinedRawText.replace(/\s+/g, '').length < 25) {
          const res2 = await window.Tesseract.recognize(preprocessedBlobs.invertedCanvas, 'eng');
          const text2 = (res2 && res2.data && res2.data.text) ? res2.data.text : '';
          combinedRawText += '\n' + text2;
        }
      }
    } catch (err) {
      console.warn('OCR engine error:', err);
    }

    allRawDumps.push(`--- Screenshot #${idx + 1} ---\n${combinedRawText || '(No text detected)'}`);
    const parsedEntries = parseReceiptTextIntoTransactions(combinedRawText, thumbDataUrl);
    state.pendingOcrItems.push(...parsedEntries);
  }

  fillEl.style.width = '100%';
  pctEl.textContent = '100%';
  inspectorEl.textContent = allRawDumps.join('\n\n');
  statusEl.textContent = `Found ${state.pendingOcrItems.length} transaction(s). Verify or edit any field below before saving:`;
  renderOcrReviewItems();
}

function createPreprocessedOcrCanvases(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const targetW = Math.min(1800, Math.max(1080, img.width * 1.5));
        const scale = targetW / img.width;
        const targetH = Math.round(img.height * scale);

        const stdCanvas = document.createElement('canvas');
        stdCanvas.width = targetW;
        stdCanvas.height = targetH;
        const stdCtx = stdCanvas.getContext('2d');
        stdCtx.drawImage(img, 0, 0, targetW, targetH);

        const invCanvas = document.createElement('canvas');
        invCanvas.width = targetW;
        invCanvas.height = targetH;
        const invCtx = invCanvas.getContext('2d');
        invCtx.drawImage(img, 0, 0, targetW, targetH);

        try {
          const imgData = stdCtx.getImageData(0, 0, targetW, targetH);
          const data = imgData.data;
          const invDataObj = invCtx.getImageData(0, 0, targetW, targetH);
          const invData = invDataObj.data;

          let lumSum = 0;
          const sampleStep = 16;
          let count = 0;
          for (let i = 0; i < data.length; i += 4 * sampleStep) {
            lumSum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
            count++;
          }
          const avgLum = lumSum / Math.max(1, count);
          const isDarkBg = avgLum < 115;

          for (let i = 0; i < data.length; i += 4) {
            const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
            let norm = isDarkBg ? 255 - lum : lum;
            norm = norm < 145 ? Math.max(0, (norm - 40) * 0.8) : Math.min(255, norm * 1.15);
            data[i] = data[i + 1] = data[i + 2] = norm;

            const alt = isDarkBg ? lum : 255 - lum;
            invData[i] = invData[i + 1] = invData[i + 2] = alt > 135 ? 255 : 0;
          }

          stdCtx.putImageData(imgData, 0, 0);
          invCtx.putImageData(invDataObj, 0, 0);
        } catch (err) {
          console.warn('Canvas pixel preprocessing skipped:', err);
        }

        resolve({ standardCanvas: stdCanvas, invertedCanvas: invCanvas });
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

function compressReceiptThumbnail(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const maxW = 520;
        const scale = Math.min(1, maxW / img.width);
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', 0.72));
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
  const rawLines = cleanText
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l.length > 1);

  const ignoreLineRegex = /\b(utr|upi\s*transaction\s*id|transaction\s*id|google\s*transaction\s*id|ref\s*no|reference\s*id|ifsc|account\s*no|xxxx|kb\/s|vo\s*lte|5g|4g|battery)\b/i;
  const statusClockOrPctRegex = /^\d{1,2}:\d{2}(\s*[ap]m)?$|^\d{1,3}%$/i;

  const deductKeywords = /\b(paid\s+to|sent\s+to|debited|debit|dr\b|withdrawn|spent|payment\s+to|money\s+sent|paid\b|transfer\s+to|bill\s+paid)\b/i;
  const addKeywords = /\b(received\s+from|credited|credit|cr\b|added|refund|deposited|cashback|money\s+received|received\b)\b/i;

  let globalType = 'DEDUCT';
  const hasAdd = addKeywords.test(cleanText);
  const hasDeduct = deductKeywords.test(cleanText);
  if (hasAdd && !hasDeduct) globalType = 'ADD';
  if (hasDeduct && !hasAdd) globalType = 'DEDUCT';

  let primaryCounterparty = '';
  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];
    const m = line.match(/(?:paid\s+to|sent\s+to|received\s+from|payment\s+to|transfer\s+to|to\s*:|from\s*:)\s*([A-Za-z][A-Za-z0-9 &._'-]{1,28})/i);
    if (m && m[1]) {
      const candidate = m[1].replace(/\b(bank|upi|verified|okaxis|okhdfcbank|okicici|oksbi|ybl|paytm)\b/gi, '').trim();
      if (candidate.length >= 2) {
        primaryCounterparty = candidate;
        break;
      }
    }
    if (/^(paid\s+to|sent\s+to|received\s+from|to)$/i.test(line) && rawLines[i + 1]) {
      const nextCand = rawLines[i + 1].replace(/[^A-Za-z0-9 &._'-]/g, '').trim();
      if (nextCand.length >= 2 && !/^\d+$/.test(nextCand)) {
        primaryCounterparty = nextCand.slice(0, 28);
        break;
      }
    }
  }

  const candidates = [];

  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];
    if (ignoreLineRegex.test(line) || statusClockOrPctRegex.test(line)) continue;

    const scrubbed = line
      .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\s*(?:am|pm)?\b/gi, ' ')
      .replace(/\b\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}\b/g, ' ')
      .replace(/\b\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{2,4}\b/gi, ' ')
      .replace(/\b\d{10,18}\b/g, ' ')
      .replace(/\b\d{1,3}%\b/g, ' ');

    const explicitRegex = /([+\-−])?\s*(?:₹|rs\.?|inr|\$|€|£)\s*([0-9]{1,3}(?:,[0-9]{2,3})+(?:\.[0-9]{1,2})?|[0-9]{1,7}(?:\.[0-9]{1,2})?)/gi;
    let match;
    let matchedExplicitOnLine = false;

    while ((match = explicitRegex.exec(scrubbed)) !== null) {
      const signChar = match[1] || '';
      const rawNum = match[2].replace(/,/g, '');
      const val = parseFloat(rawNum);
      if (!isFinite(val) || val <= 0 || val > 5000000) continue;

      matchedExplicitOnLine = true;
      let rowType = globalType;
      if (signChar === '+') rowType = 'ADD';
      else if (signChar === '-' || signChar === '−') rowType = 'DEDUCT';
      else if (addKeywords.test(line)) rowType = 'ADD';
      else if (deductKeywords.test(line)) rowType = 'DEDUCT';

      const rowTag = extractCounterpartyFromRow(line, rawLines[i - 1], rawLines[i + 1]) || primaryCounterparty || 'Scanned Entry';

      candidates.push({
        amount: val,
        type: rowType,
        tag: rowTag,
        lineText: line,
        score: 100
      });
    }

    if (!matchedExplicitOnLine) {
      const fallbackRegex = /([+\-−])?\s*\b([0-9]{1,3}(?:,[0-9]{2,3})+(?:\.[0-9]{1,2})?|[0-9]{1,6}\.[0-9]{2})\b/g;
      while ((match = fallbackRegex.exec(scrubbed)) !== null) {
        const signChar = match[1] || '';
        const rawNum = match[2].replace(/,/g, '');
        const val = parseFloat(rawNum);
        if (!isFinite(val) || val <= 0 || val > 5000000) continue;
        if (val >= 1990 && val <= 2035 && !rawNum.includes('.')) continue;

        let rowType = globalType;
        if (signChar === '+') rowType = 'ADD';
        else if (signChar === '-' || signChar === '−') rowType = 'DEDUCT';
        else if (addKeywords.test(line)) rowType = 'ADD';
        else if (deductKeywords.test(line)) rowType = 'DEDUCT';

        const rowTag = extractCounterpartyFromRow(line, rawLines[i - 1], rawLines[i + 1]) || primaryCounterparty || 'Scanned Entry';

        candidates.push({
          amount: val,
          type: rowType,
          tag: rowTag,
          lineText: line,
          score: 75
        });
      }

      const standaloneInt = scrubbed.trim().match(/^([+\-−])?\s*([0-9]{2,6})$/);
      if (standaloneInt && i < 12) {
        let rawDigits = standaloneInt[2];
        let val = parseFloat(rawDigits);
        if (val > 0 && !(val >= 1990 && val <= 2035)) {
          let rowType = globalType;
          if (standaloneInt[1] === '+') rowType = 'ADD';
          if (standaloneInt[1] === '-' || standaloneInt[1] === '−') rowType = 'DEDUCT';
          candidates.push({
            amount: val,
            type: rowType,
            tag: primaryCounterparty || 'Scanned Entry',
            lineText: line,
            score: 55
          });
        }
      }
    }
  }

  candidates.sort((a, b) => b.score - a.score);

  const uniqueResults = [];
  const seenKeys = new Set();
  for (const c of candidates) {
    const isGlitchPrefix = uniqueResults.some(
      (existing) =>
        existing.score >= 75 &&
        c.score < 75 &&
        (String(c.amount) === '2' + String(existing.amount) || String(c.amount) === '7' + String(existing.amount))
    );
    if (isGlitchPrefix) continue;

    const key = `${c.type}_${c.amount}_${c.tag.toLowerCase()}`;
    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      uniqueResults.push(c);
    }
  }

  if (uniqueResults.length === 0) {
    uniqueResults.push({
      amount: 0,
      type: globalType,
      tag: primaryCounterparty || 'Receipt Entry',
      lineText: 'Enter amount from screenshot below'
    });
  }

  return uniqueResults.slice(0, 10).map((entry) => {
    const tagColor = ensureTagColor(entry.tag);
    const isDuplicate = entry.amount > 0 ? checkDuplicateTransaction(entry.amount, entry.type) : false;
    return {
      tempId: 'ocr_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      selected: true,
      amount: entry.amount,
      type: entry.type,
      tag: entry.tag,
      tagColor,
      pocket: 'BANK',
      note: entry.lineText.slice(0, 75),
      receiptThumb: thumbDataUrl,
      rawText: cleanText.slice(0, 800),
      isDuplicate
    };
  });
}

function extractCounterpartyFromRow(line, prevLine) {
  const cleaned = line
    .replace(/([+\-−])?\s*(?:₹|rs\.?|inr|\$|€|£)?\s*[0-9,]+(?:\.[0-9]{1,2})?/gi, '')
    .replace(/\b(paid\s+to|sent\s+to|received\s+from|debited|credited|dr|cr|successful|completed|upi)\b/gi, '')
    .replace(/[^A-Za-z0-9 &._'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (cleaned.length >= 2 && cleaned.length <= 26 && /[A-Za-z]{2,}/.test(cleaned)) {
    return cleaned;
  }
  if (prevLine && /^[A-Za-z][A-Za-z0-9 &._'-]{2,24}$/.test(prevLine.trim())) {
    return prevLine.trim();
  }
  return '';
}

function checkDuplicateTransaction(amount, type) {
  const now = Date.now();
  return state.transactions.some((tx) => {
    const sameAmt = Math.abs(Number(tx.amount) - Number(amount)) < 0.01;
    const sameType = tx.type === type;
    const recent = Math.abs(now - tx.timestamp) < 1000 * 60 * 60 * 24;
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
          <span style="width:13px;height:13px;border-radius:50%;background:${item.tagColor};display:inline-block;"></span>
          <strong>Transaction #${idx + 1}</strong>
        </div>
        ${item.isDuplicate ? '<span class="dup-warn-badge">⚠ Duplicate Amount</span>' : ''}
      </div>
      <div class="ocr-edit-grid">
        <input type="text" class="ocr-tag-input" data-idx="${idx}" value="${escapeHtml(item.tag)}" placeholder="Name Tag / Merchant">
        <input type="number" step="0.01" class="ocr-amt-input" data-idx="${idx}" value="${item.amount || ''}" placeholder="Amount">
        <button type="button" class="type-pill ${item.type === 'ADD' ? 'add' : 'deduct'} active ocr-type-toggle" data-idx="${idx}">
          ${item.type === 'ADD' ? '+ Received' : '− Spent'}
        </button>
      </div>
      <div class="ocr-note-line">Scanned line: "${escapeHtml(item.note || 'Manual row')}"</div>
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

/* --- 11. BUILT-IN CANVAS PNG ICON & SCREENSHOT GENERATOR --- */
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

  if (savedSettings) {
    state.settings = { ...state.settings, ...savedSettings };
  }

  if (!state.settings.initialized && !state.settings.skippedSetup) {
    openOnboardingSetupModal();
  }

  displayedHeroBalance = Number(state.settings.currentBalance) || 0;
  await recalculateRunningBalances();
  renderAppUI();

  if (window.location.search.includes('share_target=1')) {
    await checkAndroidShareTargetQueue();
    window.history.replaceState({}, document.title, './index.html');
  }

  bindUIEvents();
}

function openOnboardingSetupModal() {
  document.getElementById('onboardCurrency').value = state.settings.currency || '₹';
  document.getElementById('onboardTotalBalance').value =
    state.settings.startingBalance ? String(state.settings.startingBalance) : '';
  document.getElementById('onboardBankPart').value =
    state.settings.startingBank ? String(state.settings.startingBank) : '';
  document.getElementById('onboardCashPart').value =
    state.settings.startingCash ? String(state.settings.startingCash) : '';
  document.getElementById('onboardingModal').classList.remove('hidden');
}

async function dismissOnboardingAndEnterApp() {
  if (!state.settings.initialized) {
    state.settings.skippedSetup = true;
    await dbPut('settings', { key: 'main', ...state.settings });
  }
  document.getElementById('onboardingModal').classList.add('hidden');
  renderAppUI();
}

function bindUIEvents() {
  // Bottom Navigation Bar Tabs (Ledger vs Tags)
  document.getElementById('navHomeBtn').addEventListener('click', () => switchAppView('HOME'));
  document.getElementById('navTagsBtn').addEventListener('click', () => switchAppView('TAGS'));

  // Onboarding Split Checkbox
  const splitChk = document.getElementById('enablePocketSplitToggle');
  const splitBox = document.getElementById('pocketSplitInputs');
  splitChk.addEventListener('change', () => {
    splitBox.classList.toggle('hidden', !splitChk.checked);
  });

  // Close / Skip Onboarding Buttons & Reopen Prompts
  document.getElementById('closeOnboardingModalBtn').addEventListener('click', dismissOnboardingAndEnterApp);
  document.getElementById('skipOnboardingBtn').addEventListener('click', dismissOnboardingAndEnterApp);
  document.getElementById('openSetupFromBannerBtn').addEventListener('click', openOnboardingSetupModal);
  document.getElementById('editStartingBalInlineBtn').addEventListener('click', openOnboardingSetupModal);
  document.getElementById('reopenOnboardingFromSettingsBtn').addEventListener('click', () => {
    document.getElementById('settingsModalBackdrop').classList.add('hidden');
    openOnboardingSetupModal();
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
      ...state.settings,
      initialized: true,
      skippedSetup: false,
      currency: cur,
      startingBalance: bank + cash,
      startingBank: bank,
      startingCash: cash
    };

    await dbPut('settings', { key: 'main', ...state.settings });
    document.getElementById('onboardingModal').classList.add('hidden');
    await recalculateRunningBalances();
    renderAppUI();
  });

  // Smart Tag Grouping Prompt Banner Actions
  document.getElementById('confirmGroupTagBtn').addEventListener('click', async () => {
    if (state.pendingGroupCandidate) {
      await groupTransactionsUnderTag(state.pendingGroupCandidate.name);
      switchAppView('TAGS');
    }
  });

  document.getElementById('dismissGroupTagBtn').addEventListener('click', () => {
    if (state.pendingGroupCandidate) {
      state.dismissedGroupPrompts[state.pendingGroupCandidate.key] = true;
      state.pendingGroupCandidate = null;
      renderAppUI();
    }
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

  // Search Inputs (Ledger & Tags Page)
  document.getElementById('searchInput').addEventListener('input', (e) => {
    state.searchQuery = e.target.value.trim();
    renderAppUI();
  });

  document.getElementById('tagPageSearchInput').addEventListener('input', (e) => {
    state.tagPageSearchQuery = e.target.value.trim();
    renderAppUI();
  });

  // Open / Close Quick Log
  document.getElementById('openQuickLogBtn').addEventListener('click', () => openQuickLogSheet(null));
  document.getElementById('closeQuickLogBtn').addEventListener('click', closeQuickLogSheet);
  document.getElementById('cancelEditModeBtn').addEventListener('click', closeQuickLogSheet);

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

  // Save or Update Transaction from Quick Log Sheet
  document.getElementById('saveTransactionBtn').addEventListener('click', async () => {
    const amount = evaluateMathExpression(state.mathExpr);
    if (amount <= 0) return;

    const rawTag = document.getElementById('tagInputField').value.trim() || 'General';
    const note = document.getElementById('noteInputField').value.trim();
    const dateVal = document.getElementById('dateInputField').value;
    const chosenTimestamp = dateVal ? new Date(dateVal).getTime() : Date.now();

    const existingTag = state.tags[rawTag] || Object.values(state.tags).find((t) => t.name.toLowerCase() === rawTag.toLowerCase());
    const canonicalName = existingTag ? existingTag.name : rawTag;

    state.tags[canonicalName] = {
      name: canonicalName,
      color: state.currentTagColor,
      grouped: existingTag ? Boolean(existingTag.grouped) : false,
      expanded: existingTag ? Boolean(existingTag.expanded) : false
    };
    await dbPut('tags', state.tags[canonicalName]);

    if (state.editingTxId) {
      const oldTx = state.transactions.find((t) => t.id === state.editingTxId);
      if (oldTx) {
        const updatedTx = {
          ...oldTx,
          amount,
          type: state.sheetMode,
          tag: canonicalName,
          tagColor: state.currentTagColor,
          pocket: state.sheetPocket,
          note,
          timestamp: isFinite(chosenTimestamp) ? chosenTimestamp : oldTx.timestamp
        };
        await dbPut('transactions', updatedTx);
      }
    } else {
      const tx = {
        id: 'tx_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
        amount,
        type: state.sheetMode,
        tag: canonicalName,
        tagColor: state.currentTagColor,
        pocket: state.sheetPocket,
        note,
        timestamp: isFinite(chosenTimestamp) ? chosenTimestamp : Date.now()
      };
      await dbPut('transactions', tx);
    }

    await recalculateRunningBalances();
    closeQuickLogSheet();
    renderAppUI();
  });

  // Transaction Details Modal Actions
  document.getElementById('closeTxDetailModalBtn').addEventListener('click', () => {
    document.getElementById('txDetailModalBackdrop').classList.add('hidden');
  });

  document.getElementById('editTxFromDetailBtn').addEventListener('click', () => {
    const tx = state.transactions.find((t) => t.id === state.selectedDetailTxId);
    document.getElementById('txDetailModalBackdrop').classList.add('hidden');
    if (tx) openQuickLogSheet(tx);
  });

  document.getElementById('deleteTxFromDetailBtn').addEventListener('click', async () => {
    const id = state.selectedDetailTxId;
    document.getElementById('txDetailModalBackdrop').classList.add('hidden');
    if (id) await deleteTransactionWithUndo(id);
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

  // OCR File Upload & Manual Add Row
  document.getElementById('ocrFileInput').addEventListener('change', async (e) => {
    await handleScreenshotFiles(e.target.files);
    e.target.value = '';
  });

  document.getElementById('addManualOcrRowBtn').addEventListener('click', () => {
    const firstThumb = state.pendingOcrItems[0] ? state.pendingOcrItems[0].receiptThumb : '';
    state.pendingOcrItems.push({
      tempId: 'ocr_manual_' + Date.now(),
      selected: true,
      amount: 0,
      type: 'DEDUCT',
      tag: 'Receipt Entry',
      tagColor: generateVibrantHSL(),
      pocket: 'BANK',
      note: 'Added from screenshot',
      receiptThumb: firstThumb,
      rawText: '',
      isDuplicate: false
    });
    renderOcrReviewItems();
  });

  document.getElementById('closeOcrDrawerBtn').addEventListener('click', () => {
    document.getElementById('ocrDrawerBackdrop').classList.add('hidden');
  });

  document.getElementById('commitOcrItemsBtn').addEventListener('click', async () => {
    const selected = state.pendingOcrItems.filter((item) => item.selected && Number(item.amount) > 0);
    if (selected.length === 0) {
      alert('Please enter a valid amount greater than 0 for at least one checked row.');
      return;
    }
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
