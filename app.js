/* MiMoni v5 — Multi-Profile + Planned Expenses Engine */

const DB_NAME = 'MiMoniOfflineVaultDB';
const DB_VERSION = 2; // Bumped for Planned Expenses store

const state = {
  db: null,
  activeView: 'HOME', // 'HOME' | 'PLANNED' | 'TAGS'
  currentProfileId: localStorage.getItem('mimoni_profile_id') || 'default',
  profiles: [], // { id, name, theme }
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
  plannedExpenses: [],
  tags: {}, 
  activePocketFilter: 'ALL',
  searchQuery: '',
  tagPageSearchQuery: '',
  
  // Sheet state
  sheetMode: 'DEDUCT', 
  sheetPocket: 'BANK',
  mathExpr: '0',
  currentTagColor: 'hsl(152, 78%, 52%)',
  editingTxId: null,
  selectedDetailTxId: null,
  selectedDetailIsPlanned: false,

  lastDeletedTx: null,
  lastDeletedIsPlanned: false,
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
      if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('transactions')) {
        const txStore = db.createObjectStore('transactions', { keyPath: 'id' });
        txStore.createIndex('timestamp', 'timestamp', { unique: false });
      }
      if (!db.objectStoreNames.contains('tags')) db.createObjectStore('tags', { keyPath: 'name' });
      if (!db.objectStoreNames.contains('shared_queue')) db.createObjectStore('shared_queue', { keyPath: 'id' });
      
      // New in v5
      if (!db.objectStoreNames.contains('profiles')) db.createObjectStore('profiles', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('planned_expenses')) db.createObjectStore('planned_expenses', { keyPath: 'id' });
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

/* --- 2. MULTI-PROFILE LOAD & RECALCULATE --- */
async function loadCurrentProfileData() {
  const allProfiles = await dbGetAll('profiles');
  if (allProfiles.length === 0) {
    const defProfile = { id: 'default', name: 'Main Profile', theme: 'dark' };
    await dbPut('profiles', defProfile);
    state.profiles = [defProfile];
  } else {
    state.profiles = allProfiles;
  }
  
  if (!state.profiles.find(p => p.id === state.currentProfileId)) {
    state.currentProfileId = state.profiles[0].id;
    localStorage.setItem('mimoni_profile_id', state.currentProfileId);
  }

  const p = state.profiles.find(x => x.id === state.currentProfileId);
  document.getElementById('activeProfileLabel').textContent = p.name;
  
  // Theme logic
  const isLight = p.theme === 'light';
  document.body.classList.toggle('light-theme', isLight);
  document.getElementById('themeColorMeta').setAttribute('content', isLight ? '#F2F4F7' : '#0B0D12');

  const savedSettings = await dbGet('settings', 'settings_' + state.currentProfileId);
  if (savedSettings) {
    state.settings = savedSettings;
  } else {
    // Reset settings in memory if new profile
    state.settings = {
      initialized: false, skippedSetup: false, currency: '₹',
      startingBalance: 0, startingBank: 0, startingCash: 0,
      currentBalance: 0, bankBalance: 0, cashBalance: 0
    };
  }

  const allTx = await dbGetAll('transactions');
  state.transactions = allTx.filter(t => (t.profileId || 'default') === state.currentProfileId);
  
  const allPlanned = await dbGetAll('planned_expenses');
  state.plannedExpenses = allPlanned.filter(p => (p.profileId || 'default') === state.currentProfileId).sort((a, b) => b.timestamp - a.timestamp);

  const allTags = await dbGetAll('tags');
  state.tags = {};
  allTags.forEach(t => {
    if ((t.profileId || 'default') === state.currentProfileId) {
      state.tags[t.name] = t;
    }
  });

  await recalculateRunningBalances();
}

async function recalculateRunningBalances() {
  state.transactions.sort((a, b) => a.timestamp - b.timestamp);

  let runningTotal = Number(state.settings.startingBalance) || 0;
  let runningBank = Number(state.settings.startingBank) || 0;
  let runningCash = Number(state.settings.startingCash) || 0;

  for (const item of state.transactions) {
    const amt = Number(item.amount) || 0;
    const delta = item.type === 'ADD' ? amt : -amt;
    item.previousBalance = runningTotal;
    runningTotal = Math.round((runningTotal + delta) * 100) / 100;
    item.runningBalance = runningTotal;

    if (item.pocket === 'CASH') runningCash = Math.round((runningCash + delta) * 100) / 100;
    else runningBank = Math.round((runningBank + delta) * 100) / 100;
    
    item.profileId = state.currentProfileId;
    await dbPut('transactions', item);
  }

  state.settings.currentBalance = runningTotal;
  state.settings.bankBalance = runningBank;
  state.settings.cashBalance = runningCash;
  await dbPut('settings', { key: 'settings_' + state.currentProfileId, ...state.settings });

  state.transactions.reverse(); // Display newest first
}

/* --- TAG HELPERS --- */
function generateVibrantHSL() {
  return `hsl(${Math.floor(Math.random() * 360)}, ${74 + Math.floor(Math.random() * 16)}%, ${54 + Math.floor(Math.random() * 10)}%)`;
}

function ensureTagColor(tagName) {
  const clean = (tagName || 'General').trim();
  const existing = Object.values(state.tags).find(t => t.name.toLowerCase() === clean.toLowerCase());
  if (existing) return existing.color;
  const newColor = generateVibrantHSL();
  state.tags[clean] = { name: clean, color: newColor, grouped: false, expanded: false, profileId: state.currentProfileId };
  dbPut('tags', state.tags[clean]);
  return newColor;
}

function detectUngroupedDuplicateTags() {
  const counts = {};
  const canonicalNames = {};
  // Count from both Actual and Planned
  const allItems = [...state.transactions, ...state.plannedExpenses];
  for (const item of allItems) {
    const raw = (item.tag || 'General').trim();
    const key = raw.toLowerCase();
    counts[key] = (counts[key] || 0) + 1;
    if (!canonicalNames[key]) canonicalNames[key] = raw;
  }
  const candidates = [];
  for (const key of Object.keys(counts)) {
    if (counts[key] >= 2) {
      const displayName = canonicalNames[key];
      const tagObj = state.tags[displayName] || Object.values(state.tags).find(t => t.name.toLowerCase() === key);
      if (!tagObj || !tagObj.grouped) {
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
      tx.tag = clean; tx.tagColor = unifiedColor; await dbPut('transactions', tx);
    }
  }
  for (const pt of state.plannedExpenses) {
    if ((pt.tag || '').trim().toLowerCase() === key) {
      pt.tag = clean; pt.tagColor = unifiedColor; await dbPut('planned_expenses', pt);
    }
  }

  state.tags[clean] = { name: clean, color: unifiedColor, grouped: true, expanded: false, profileId: state.currentProfileId };
  await dbPut('tags', state.tags[clean]);
  state.pendingGroupCandidate = null;
  renderAppUI();
}

/* --- FORMATTERS --- */
function formatMoneyNumber(val) {
  return (Number(val) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/* --- RENDER UI --- */
function renderAppUI() {
  const cur = state.settings.currency || '₹';
  document.getElementById('currencySymbolHero').textContent = cur;
  document.getElementById('sheetCurrencySign').textContent = cur;
  document.getElementById('planSheetCurrencySign').textContent = cur;

  // Banner checks
  const setupBanner = document.getElementById('setupPromptBanner');
  setupBanner.classList.toggle('hidden', state.settings.initialized || !state.settings.skippedSetup);

  const ungroupedCandidates = detectUngroupedDuplicateTags();
  const ungroupedBadge = document.getElementById('ungroupedBadge');
  const groupingBanner = document.getElementById('tagGroupingPromptBanner');

  if (ungroupedCandidates.length > 0) {
    ungroupedBadge.classList.remove('hidden');
    const firstCand = ungroupedCandidates.find(c => !state.dismissedGroupPrompts[c.key]);
    if (firstCand) {
      state.pendingGroupCandidate = firstCand;
      document.getElementById('groupingPromptText').textContent = `Group ${firstCand.count} "${firstCand.name}" tags?`;
      groupingBanner.classList.remove('hidden');
    } else {
      groupingBanner.classList.add('hidden');
    }
  } else {
    ungroupedBadge.classList.add('hidden');
    groupingBanner.classList.add('hidden');
  }

  // View 1: Ledger
  const heroBal = document.getElementById('rollingBalanceValue');
  if (heroBal) heroBal.textContent = formatMoneyNumber(state.settings.currentBalance);
  document.getElementById('bankBalanceText').textContent = `${cur}${formatMoneyNumber(state.settings.bankBalance)}`;
  document.getElementById('cashBalanceText').textContent = `${cur}${formatMoneyNumber(state.settings.cashBalance)}`;

  let totalIn = 0, totalOut = 0;
  const filteredTx = state.transactions.filter(tx => {
    if (state.activePocketFilter !== 'ALL' && tx.pocket !== state.activePocketFilter) return false;
    if (state.searchQuery) {
      const q = state.searchQuery.toLowerCase();
      if (!String(tx.tag).toLowerCase().includes(q) && !String(tx.note).toLowerCase().includes(q) && !String(tx.amount).includes(q)) return false;
    }
    return true;
  });
  filteredTx.forEach(tx => { if (tx.type === 'ADD') totalIn += tx.amount; else totalOut += tx.amount; });
  document.getElementById('totalInflowText').textContent = `+${cur}${formatMoneyNumber(totalIn)}`;
  document.getElementById('totalOutflowText').textContent = `-${cur}${formatMoneyNumber(totalOut)}`;
  renderTransactionsTimeline(filteredTx);

  // View 2: Planned
  let totalPlanned = 0;
  state.plannedExpenses.forEach(p => totalPlanned += p.amount);
  const safeAvailable = Math.round((state.settings.currentBalance - totalPlanned)*100)/100;
  
  document.getElementById('plannedTotalBalanceText').textContent = `${cur}${formatMoneyNumber(state.settings.currentBalance)}`;
  document.getElementById('plannedReservedText').textContent = `-${cur}${formatMoneyNumber(totalPlanned)}`;
  document.getElementById('plannedAvailableText').textContent = `${cur}${formatMoneyNumber(Math.max(0, safeAvailable))}`;
  document.getElementById('planLiveAvailableText').textContent = `${cur}${formatMoneyNumber(Math.max(0, safeAvailable))}`;
  
  const plannedList = document.getElementById('plannedList');
  const pEmpty = document.getElementById('plannedEmptyStateBox');
  if (state.plannedExpenses.length === 0) {
    pEmpty.classList.remove('hidden');
    plannedList.innerHTML = '';
  } else {
    pEmpty.classList.add('hidden');
    plannedList.innerHTML = state.plannedExpenses.map(p => buildTransactionCardHTML(p, cur, true)).join('');
    attachSwipeAndTapHandlers(plannedList, true);
  }

  // View 3: Tags
  renderDedicatedTagsPage(ungroupedCandidates);
}

function switchAppView(viewName) {
  state.activeView = viewName;
  ['HOME','PLANNED','TAGS'].forEach(v => {
    document.getElementById(v.toLowerCase() + 'PageView').classList.toggle('hidden', viewName !== v);
    let navBtn = document.getElementById('nav' + v.charAt(0) + v.slice(1).toLowerCase() + 'Btn');
    if (navBtn) navBtn.classList.toggle('active', viewName === v);
  });
  renderAppUI();
}

function buildTransactionCardHTML(tx, cur, isPlanned = false) {
  const isAdd = tx.type === 'ADD';
  const sign = isAdd && !isPlanned ? '+' : '−';
  const amtClass = isAdd && !isPlanned ? 'add' : 'deduct';
  const color = tx.tagColor || '#2ED573';
  const tagName = (tx.tag && tx.tag.trim()) ? tx.tag.trim() : 'General';
  const dateStr = new Date(tx.timestamp).toLocaleString([], { year: 'numeric', month: 'short', day: 'numeric' });
  const subText = isPlanned ? `Planned on ${dateStr}` : `${tx.pocket || 'BANK'} • ${dateStr}`;

  return `
    <div class="tx-swipe-wrapper" data-id="${tx.id}" data-planned="${isPlanned}">
      <div class="tx-swipe-bg"><span class="dup-hint"></span><span class="del-hint">Delete ✕</span></div>
      <article class="tx-card" data-id="${tx.id}" data-planned="${isPlanned}">
        <div class="tx-left">
          <div class="tx-tag-avatar" style="background:${color}24;color:${color};border:1.5px solid ${color}66;">${escapeHtml(tagName.charAt(0).toUpperCase())}</div>
          <div class="tx-meta">
            <div class="tx-title-row">
              <span class="tx-tag-badge" style="color:${color};background:${color}1F;border:1px solid ${color}55;">● ${escapeHtml(tagName)}</span>
              ${tx.receiptThumb ? '<span class="tx-receipt-badge">📷 Receipt</span>' : ''}
              ${isPlanned ? '<span class="tx-pocket-pill" style="background:var(--amber-warn);color:#000;">PLANNED</span>' : ''}
            </div>
            <div class="tx-note-sub">${tx.note ? escapeHtml(tx.note) : subText}</div>
          </div>
        </div>
        <div class="tx-right">
          <div class="tx-amount ${amtClass}">${sign}${cur}${formatMoneyNumber(tx.amount)}</div>
          ${!isPlanned ? `<div class="tx-running-snapshot">Bal: ${cur}${formatMoneyNumber(tx.runningBalance)}</div>` : ''}
        </div>
      </article>
    </div>`;
}

function renderTransactionsTimeline(list) {
  const emptyBox = document.getElementById('emptyStateBox');
  const listEl = document.getElementById('transactionsList');
  if (list.length === 0) {
    emptyBox.classList.remove('hidden'); listEl.innerHTML = ''; return;
  }
  emptyBox.classList.add('hidden');
  listEl.innerHTML = list.map(tx => buildTransactionCardHTML(tx, state.settings.currency || '₹')).join('');
  attachSwipeAndTapHandlers(listEl, false);
}

function renderDedicatedTagsPage(ungroupedCandidates) {
  const suggestionBox = document.getElementById('unmergedTagsSuggestionBox');
  const container = document.getElementById('tagsGroupsContainer');
  const cur = state.settings.currency || '₹';
  const q = (state.tagPageSearchQuery || '').toLowerCase();

  if (ungroupedCandidates.length > 0) {
    suggestionBox.innerHTML = ungroupedCandidates.map(c => `
      <div class="unmerged-card">
        <div class="unmerged-card-info"><strong>"${escapeHtml(c.name)}" (${c.count} uses)</strong><div>Group them into a folder?</div></div>
        <button type="button" class="group-confirm-btn tactile-btn" data-merge-tag="${escapeHtml(c.name)}">Group</button>
      </div>`).join('');
    suggestionBox.querySelectorAll('[data-merge-tag]').forEach(b => b.addEventListener('click', () => groupTransactionsUnderTag(b.getAttribute('data-merge-tag'))));
  } else suggestionBox.innerHTML = '';

  const allItems = [...state.transactions, ...state.plannedExpenses];
  if (allItems.length === 0) {
    container.innerHTML = `<div class="empty-state"><h2>No Tags Yet</h2><p>Tags will appear here automatically.</p></div>`;
    return;
  }

  const tagCounts = {};
  allItems.forEach(i => { const k = (i.tag||'').toLowerCase(); tagCounts[k] = (tagCounts[k]||0)+1; });

  const groupedMap = new Map();
  const singleList = [];

  allItems.filter(i => !q || (i.tag||'').toLowerCase().includes(q) || (i.note||'').toLowerCase().includes(q)).forEach(item => {
    const rawName = (item.tag || 'General').trim();
    const lower = rawName.toLowerCase();
    const tagMeta = state.tags[rawName] || Object.values(state.tags).find(t => t.name.toLowerCase() === lower);
    const isGrouped = tagMeta && tagMeta.grouped && tagCounts[lower] >= 2;

    if (isGrouped) {
      if (!groupedMap.has(lower)) {
        groupedMap.set(lower, { name: tagMeta.name, color: tagMeta.color, expanded: tagMeta.expanded, items: [], net: 0 });
      }
      const g = groupedMap.get(lower);
      g.items.push(item);
      if (!item.isPlanned) g.net += (item.type === 'ADD' ? item.amount : -item.amount);
    } else {
      singleList.push(item);
    }
  });

  document.getElementById('totalTagsCountBadge').textContent = `${groupedMap.size + singleList.length} Items`;

  let html = [];
  if (groupedMap.size > 0) {
    html.push(`<div class="tags-section-divider"><span>Grouped Folders</span></div>`);
    for (const g of groupedMap.values()) {
      const netColor = g.net >= 0 ? 'var(--mint-add)' : 'var(--coral-deduct)';
      html.push(`
        <div class="tag-group-card ${g.expanded?'expanded':''}">
          <button type="button" class="tag-group-header" data-toggle-group="${escapeHtml(g.name)}">
            <div class="tag-group-left">
              <span class="tag-group-dot" style="background:${g.color};"></span>
              <span class="tag-group-title" style="color:${g.color};">${escapeHtml(g.name)}</span>
              <span class="tag-group-count">${g.items.length} items</span>
            </div>
            <div class="tag-group-right"><span class="tag-group-net" style="color:${netColor};">${cur}${formatMoneyNumber(Math.abs(g.net))}</span><span class="tag-group-chevron">▼</span></div>
          </button>
          <div class="tag-group-tx-list ${g.expanded?'':'hidden'}">
            ${g.items.map(i => buildTransactionCardHTML(i, cur, i.type === 'PLANNED' || !i.runningBalance)).join('')}
          </div>
        </div>`);
    }
  }

  if (singleList.length > 0) {
    html.push(`<div class="tags-section-divider"><span>Single Tags</span></div>`);
    singleList.forEach(i => {
      const color = i.tagColor || '#2ED573';
      const isP = !i.runningBalance;
      html.push(`
        <div class="single-tag-entry-card">
          <div class="single-tag-pill-header">
            <div class="single-tag-name-wrap" style="color:${color};"><span class="tag-group-dot" style="background:${color};width:10px;height:10px;"></span>${escapeHtml(i.tag)}</div>
          </div>
          ${buildTransactionCardHTML(i, cur, isP)}
        </div>`);
    });
  }

  container.innerHTML = html.join('');
  container.querySelectorAll('[data-toggle-group]').forEach(b => b.addEventListener('click', () => {
    const name = b.getAttribute('data-toggle-group');
    const tagMeta = state.tags[name] || Object.values(state.tags).find(t => t.name.toLowerCase() === name.toLowerCase());
    if (tagMeta) { tagMeta.expanded = !tagMeta.expanded; dbPut('tags', tagMeta); renderAppUI(); }
  }));
  attachSwipeAndTapHandlers(container, null); // Mixed list
}

/* --- SWIPE & TAP --- */
function attachSwipeAndTapHandlers(rootEl, forcePlanned = null) {
  rootEl.querySelectorAll('.tx-card').forEach(card => {
    let startX = 0, currentX = 0, isDragging = false, moved = false;
    const id = card.getAttribute('data-id');
    const isPlanned = forcePlanned !== null ? forcePlanned : (card.getAttribute('data-planned') === 'true');

    card.addEventListener('touchstart', e => { startX = e.touches[0].clientX; currentX = startX; isDragging = true; moved = false; card.style.transition = 'none'; }, {passive:true});
    card.addEventListener('touchmove', e => {
      if (!isDragging) return;
      currentX = e.touches[0].clientX;
      if (Math.abs(currentX - startX) > 10) { moved = true; card.style.transform = `translateX(${Math.max(-130, Math.min(0, currentX - startX))}px)`; }
    }, {passive:true});
    card.addEventListener('touchend', async () => {
      if (!isDragging) return;
      isDragging = false; card.style.transition = 'transform 0.25s ease';
      if (currentX - startX < -85) {
        card.style.transform = 'translateX(-100%)';
        await deleteTransactionWithUndo(id, isPlanned);
      } else { card.style.transform = 'translateX(0)'; }
    });

    card.addEventListener('click', () => { if (!moved) openTransactionDetailsModal(id, isPlanned); });
  });
}

function openTransactionDetailsModal(id, isPlanned) {
  const item = isPlanned ? state.plannedExpenses.find(x => x.id === id) : state.transactions.find(x => x.id === id);
  if (!item) return;
  state.selectedDetailTxId = id;
  state.selectedDetailIsPlanned = isPlanned;
  const cur = state.settings.currency || '₹';
  
  document.getElementById('txDetailTypeBadge').textContent = isPlanned ? 'PLANNED EXPENSE' : (item.type==='ADD' ? 'RECEIVED (+)' : 'SPENT (−)');
  document.getElementById('txDetailModalTitle').textContent = item.tag || 'General';
  document.getElementById('txDetailModalTitle').style.color = item.tagColor || '#2ED573';
  document.getElementById('txDetailAvatar').textContent = (item.tag||'G').charAt(0).toUpperCase();
  document.getElementById('txDetailAvatar').style.background = (item.tagColor||'#2ED573') + '24';
  document.getElementById('txDetailAvatar').style.color = item.tagColor||'#2ED573';
  
  document.getElementById('txDetailAmountBig').textContent = (isPlanned || item.type==='DEDUCT' ? '-' : '+') + cur + formatMoneyNumber(item.amount);
  document.getElementById('txDetailAmountBig').style.color = (isPlanned || item.type==='DEDUCT') ? 'var(--coral-deduct)' : 'var(--mint-add)';

  const dateStr = new Date(item.timestamp).toLocaleString();
  
  let infoHtml = `
    <div class="detail-row"><span class="detail-label">Name Tag</span><strong>${escapeHtml(item.tag)}</strong></div>
    <div class="detail-row"><span class="detail-label">Created/Date</span><strong>${dateStr}</strong></div>
    <div class="detail-row detail-note-block"><span class="detail-label">Notes</span><p>${escapeHtml(item.note||'No notes.')}</p></div>
  `;
  if (!isPlanned) {
    infoHtml = `
      <div class="detail-row"><span class="detail-label">Pocket</span><strong>${item.pocket}</strong></div>
      <div class="detail-row"><span class="detail-label">Balance Change</span><strong>${cur}${formatMoneyNumber(item.previousBalance)} → ${cur}${formatMoneyNumber(item.runningBalance)}</strong></div>
    ` + infoHtml;
  }
  document.getElementById('txDetailInfoList').innerHTML = infoHtml;
  document.getElementById('plannedActionsRow').classList.toggle('hidden', !isPlanned);

  document.getElementById('txDetailModalBackdrop').classList.remove('hidden');
}

async function deleteTransactionWithUndo(id, isPlanned) {
  const arr = isPlanned ? state.plannedExpenses : state.transactions;
  const target = arr.find(t => t.id === id);
  if (!target) return;
  
  state.lastDeletedTx = target;
  state.lastDeletedIsPlanned = isPlanned;
  
  if (isPlanned) await dbDelete('planned_expenses', id);
  else await dbDelete('transactions', id);
  
  await loadCurrentProfileData();

  const toast = document.getElementById('undoToast');
  document.getElementById('undoToastText').textContent = `Deleted ${isPlanned?'plan':'entry'} "${target.tag}"`;
  toast.classList.add('visible');
  if (state.undoTimer) clearTimeout(state.undoTimer);
  state.undoTimer = setTimeout(() => toast.classList.remove('visible'), 5000);
}

/* --- QUICK LOG ACTUAL --- */
function openQuickLogSheet() {
  state.mathExpr = '0'; state.sheetMode = 'DEDUCT'; state.editingTxId = null;
  document.getElementById('dateInputField').value = toLocalDatetimeInputString(Date.now());
  document.getElementById('tagInputField').value = '';
  document.getElementById('noteInputField').value = '';
  syncSheetModeUI();
  document.getElementById('quickLogSheetBackdrop').classList.remove('hidden');
}
function syncSheetModeUI() {
  document.getElementById('typeDeductBtn').classList.toggle('active', state.sheetMode === 'DEDUCT');
  document.getElementById('typeAddBtn').classList.toggle('active', state.sheetMode === 'ADD');
  document.getElementById('saveTransactionBtn').className = `save-entry-btn tactile-btn ${state.sheetMode === 'DEDUCT' ? 'deduct-mode' : 'add-mode'}`;
  
  const cur = state.settings.currency || '₹';
  const val = evaluateMathExpression(state.mathExpr);
  document.getElementById('mathExpressionText').textContent = state.mathExpr;
  document.getElementById('mathEvaluatedPreview').textContent = `= ${cur}${formatMoneyNumber(val)}`;
}

/* --- PLAN EXPENSE SHEET --- */
function openPlanExpenseSheet() {
  state.mathExpr = '0'; state.editingTxId = null;
  document.getElementById('planTagInputField').value = '';
  document.getElementById('planNoteInputField').value = '';
  syncPlanSheetUI();
  document.getElementById('planExpenseSheetBackdrop').classList.remove('hidden');
}
function syncPlanSheetUI() {
  const cur = state.settings.currency || '₹';
  const val = evaluateMathExpression(state.mathExpr);
  document.getElementById('planMathExpressionText').textContent = state.mathExpr;
  document.getElementById('planMathEvaluatedPreview').textContent = `= ${cur}${formatMoneyNumber(val)}`;
}

/* --- INIT & EVENTS --- */
async function initMiMoniApp() {
  state.db = await openVaultDB();
  await loadCurrentProfileData();
  bindUIEvents();
}

function bindUIEvents() {
  document.getElementById('navHomeBtn').addEventListener('click', () => switchAppView('HOME'));
  document.getElementById('navPlannedBtn').addEventListener('click', () => switchAppView('PLANNED'));
  document.getElementById('navTagsBtn').addEventListener('click', () => switchAppView('TAGS'));

  // Profiles & Settings
  const pfSelect = document.getElementById('profileSelectDropdown');
  document.getElementById('settingsOpenBtn').addEventListener('click', () => {
    pfSelect.innerHTML = state.profiles.map(p => `<option value="${p.id}" ${p.id===state.currentProfileId?'selected':''}>${escapeHtml(p.name)}</option>`).join('');
    document.getElementById('settingsModalBackdrop').classList.remove('hidden');
  });
  document.getElementById('closeSettingsModalBtn').addEventListener('click', () => document.getElementById('settingsModalBackdrop').classList.add('hidden'));
  
  pfSelect.addEventListener('change', async (e) => {
    state.currentProfileId = e.target.value;
    localStorage.setItem('mimoni_profile_id', state.currentProfileId);
    await loadCurrentProfileData();
    renderAppUI();
  });
  
  document.getElementById('createNewProfileBtn').addEventListener('click', async () => {
    const name = prompt("Enter new profile name:");
    if (name && name.trim()) {
      const p = { id: 'prof_'+Date.now(), name: name.trim(), theme: 'dark' };
      await dbPut('profiles', p);
      state.currentProfileId = p.id;
      localStorage.setItem('mimoni_profile_id', state.currentProfileId);
      await loadCurrentProfileData();
      document.getElementById('settingsModalBackdrop').classList.add('hidden');
      renderAppUI();
    }
  });

  document.getElementById('themeToggleBtn').addEventListener('click', async () => {
    const p = state.profiles.find(x => x.id === state.currentProfileId);
    p.theme = p.theme === 'light' ? 'dark' : 'light';
    await dbPut('profiles', p);
    await loadCurrentProfileData();
  });

  document.getElementById('factoryResetBtn').addEventListener('click', async () => {
    if (confirm("Wipe all transactions and plans for THIS profile?")) {
      const txs = await dbGetAll('transactions');
      for (const t of txs) if ((t.profileId||'default') === state.currentProfileId) await dbDelete('transactions', t.id);
      const pls = await dbGetAll('planned_expenses');
      for (const p of pls) if ((p.profileId||'default') === state.currentProfileId) await dbDelete('planned_expenses', p.id);
      await loadCurrentProfileData();
      renderAppUI();
      document.getElementById('settingsModalBackdrop').classList.add('hidden');
    }
  });

  // Onboarding
  document.getElementById('reopenOnboardingFromSettingsBtn').addEventListener('click', () => {
    document.getElementById('settingsModalBackdrop').classList.add('hidden');
    document.getElementById('onboardingModal').classList.remove('hidden');
  });
  document.getElementById('closeOnboardingModalBtn').addEventListener('click', () => document.getElementById('onboardingModal').classList.add('hidden'));
  document.getElementById('skipOnboardingBtn').addEventListener('click', () => document.getElementById('onboardingModal').classList.add('hidden'));
  document.getElementById('onboardingForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const cur = document.getElementById('onboardCurrency').value;
    const total = parseFloat(document.getElementById('onboardTotalBalance').value) || 0;
    const split = document.getElementById('enablePocketSplitToggle').checked;
    const bank = split ? (parseFloat(document.getElementById('onboardBankPart').value) || 0) : total;
    const cash = split ? (parseFloat(document.getElementById('onboardCashPart').value) || 0) : 0;
    state.settings = { ...state.settings, initialized: true, skippedSetup: false, currency: cur, startingBalance: bank+cash, startingBank: bank, startingCash: cash };
    await dbPut('settings', { key: 'settings_' + state.currentProfileId, ...state.settings });
    document.getElementById('onboardingModal').classList.add('hidden');
    await recalculateRunningBalances();
    renderAppUI();
  });

  // Actual Quick Log
  document.getElementById('openQuickLogBtn').addEventListener('click', openQuickLogSheet);
  document.getElementById('closeQuickLogBtn').addEventListener('click', () => document.getElementById('quickLogSheetBackdrop').classList.add('hidden'));
  document.getElementById('typeDeductBtn').addEventListener('click', () => { state.sheetMode = 'DEDUCT'; syncSheetModeUI(); });
  document.getElementById('typeAddBtn').addEventListener('click', () => { state.sheetMode = 'ADD'; syncSheetModeUI(); });
  document.querySelectorAll('#mathKeypad .key-btn').forEach(b => b.addEventListener('click', () => {
    const k = b.getAttribute('data-key');
    if (k === 'BACK') state.mathExpr = state.mathExpr.length > 1 ? state.mathExpr.slice(0,-1) : '0';
    else if (['+','-','*','/'].includes(k)) { if (!['+','-','*','/'].includes(state.mathExpr.slice(-1))) state.mathExpr += k; }
    else state.mathExpr = (state.mathExpr === '0' && k !== '.') ? k : state.mathExpr + k;
    syncSheetModeUI();
  }));
  document.getElementById('clearMathBtn').addEventListener('click', () => { state.mathExpr = '0'; syncSheetModeUI(); });
  document.getElementById('saveTransactionBtn').addEventListener('click', async () => {
    const amount = evaluateMathExpression(state.mathExpr);
    if (amount <= 0) return;
    const tag = document.getElementById('tagInputField').value.trim() || 'General';
    const tx = {
      id: 'tx_' + Date.now(), amount, type: state.sheetMode, tag, tagColor: ensureTagColor(tag),
      pocket: 'BANK', note: document.getElementById('noteInputField').value,
      timestamp: Date.now(), profileId: state.currentProfileId
    };
    await dbPut('transactions', tx);
    await loadCurrentProfileData();
    document.getElementById('quickLogSheetBackdrop').classList.add('hidden');
    renderAppUI();
  });

  // Planned Expenses
  document.getElementById('openPlanSheetBtn').addEventListener('click', openPlanExpenseSheet);
  document.getElementById('closePlanSheetBtn').addEventListener('click', () => document.getElementById('planExpenseSheetBackdrop').classList.add('hidden'));
  document.querySelectorAll('#planMathKeypad .key-btn').forEach(b => b.addEventListener('click', () => {
    const k = b.getAttribute('data-key');
    if (k === 'BACK') state.mathExpr = state.mathExpr.length > 1 ? state.mathExpr.slice(0,-1) : '0';
    else if (['+','-','*','/'].includes(k)) { if (!['+','-','*','/'].includes(state.mathExpr.slice(-1))) state.mathExpr += k; }
    else state.mathExpr = (state.mathExpr === '0' && k !== '.') ? k : state.mathExpr + k;
    syncPlanSheetUI();
  }));
  document.getElementById('savePlannedBtn').addEventListener('click', async () => {
    const amount = evaluateMathExpression(state.mathExpr);
    if (amount <= 0) return;
    
    let totalPlanned = 0;
    state.plannedExpenses.forEach(p => totalPlanned += p.amount);
    const available = state.settings.currentBalance - totalPlanned;
    
    if (amount > available) {
      alert(`Cannot plan this expense! It exceeds your available balance by ${state.settings.currency}${formatMoneyNumber(amount - available)}.`);
      return;
    }

    const tag = document.getElementById('planTagInputField').value.trim() || 'Planned';
    const px = {
      id: 'plan_' + Date.now(), amount, type: 'DEDUCT', tag, tagColor: ensureTagColor(tag),
      note: document.getElementById('planNoteInputField').value,
      timestamp: Date.now(), profileId: state.currentProfileId
    };
    await dbPut('planned_expenses', px);
    await loadCurrentProfileData();
    document.getElementById('planExpenseSheetBackdrop').classList.add('hidden');
    renderAppUI();
  });

  // Modals & Details
  document.getElementById('closeTxDetailModalBtn').addEventListener('click', () => document.getElementById('txDetailModalBackdrop').classList.add('hidden'));
  document.getElementById('deleteTxFromDetailBtn').addEventListener('click', async () => {
    document.getElementById('txDetailModalBackdrop').classList.add('hidden');
    await deleteTransactionWithUndo(state.selectedDetailTxId, state.selectedDetailIsPlanned);
  });
  document.getElementById('undoActionBtn').addEventListener('click', async () => {
    if (!state.lastDeletedTx) return;
    if (state.lastDeletedIsPlanned) await dbPut('planned_expenses', state.lastDeletedTx);
    else await dbPut('transactions', state.lastDeletedTx);
    state.lastDeletedTx = null;
    document.getElementById('undoToast').classList.remove('visible');
    await loadCurrentProfileData();
    renderAppUI();
  });

  // Post Planned to Ledger
  document.getElementById('postPlannedToLedgerBtn').addEventListener('click', () => {
    document.getElementById('txDetailModalBackdrop').classList.add('hidden');
    document.getElementById('postLedgerDate').value = toLocalDatetimeInputString(Date.now());
    document.getElementById('postToLedgerModalBackdrop').classList.remove('hidden');
  });
  document.getElementById('closePostLedgerBtn').addEventListener('click', () => document.getElementById('postToLedgerModalBackdrop').classList.add('hidden'));
  document.getElementById('postToLedgerForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const plannedId = state.selectedDetailTxId;
    const pItem = state.plannedExpenses.find(p => p.id === plannedId);
    if (!pItem) return;
    
    await dbDelete('planned_expenses', plannedId);
    const dateVal = document.getElementById('postLedgerDate').value;
    const ts = dateVal ? new Date(dateVal).getTime() : Date.now();
    
    const tx = {
      id: 'tx_' + Date.now(), amount: pItem.amount, type: 'DEDUCT', tag: pItem.tag, tagColor: pItem.tagColor,
      pocket: document.getElementById('postLedgerPocket').value, note: pItem.note,
      timestamp: isFinite(ts) ? ts : Date.now(), profileId: state.currentProfileId
    };
    await dbPut('transactions', tx);
    await loadCurrentProfileData();
    document.getElementById('postToLedgerModalBackdrop').classList.add('hidden');
    switchAppView('HOME'); // Take user to ledger to see it
  });

}
document.addEventListener('DOMContentLoaded', initMiMoniApp);
