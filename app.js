/* MiMoni v6 — Multi-Profile + Planned Expenses Engine (Crash-Proof Edition) */

const DB_NAME = 'MiMoniOfflineVaultDB';
const DB_VERSION = 3; // Bumped to 3 to force DB upgrade if previous failed

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

/* --- 1. INDEXEDDB STORAGE LAYER (Safeguarded) --- */
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
      if (!db.objectStoreNames.contains('profiles')) db.createObjectStore('profiles', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('planned_expenses')) db.createObjectStore('planned_expenses', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => {
      alert("Database upgrade blocked. Please close all other MiMoni tabs and refresh.");
      window.location.reload();
    };
  });
}

function dbGetSafe(storeName, key) {
  return new Promise((resolve) => {
    try {
      if (!state.db.objectStoreNames.contains(storeName)) return resolve(null);
      const req = state.db.transaction(storeName, 'readonly').objectStore(storeName).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch (e) { resolve(null); }
  });
}

function dbGetAllSafe(storeName) {
  return new Promise((resolve) => {
    try {
      if (!state.db.objectStoreNames.contains(storeName)) return resolve([]);
      const req = state.db.transaction(storeName, 'readonly').objectStore(storeName).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    } catch (e) { resolve([]); }
  });
}

function dbPutSafe(storeName, value) {
  return new Promise((resolve) => {
    try {
      if (!state.db.objectStoreNames.contains(storeName)) return resolve(null);
      const tx = state.db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).put(value);
      tx.oncomplete = () => resolve(value);
      tx.onerror = () => resolve(null);
    } catch (e) { resolve(null); }
  });
}

function dbDeleteSafe(storeName, key) {
  return new Promise((resolve) => {
    try {
      if (!state.db.objectStoreNames.contains(storeName)) return resolve();
      const tx = state.db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch (e) { resolve(); }
  });
}

/* --- 2. MULTI-PROFILE LOAD & RECALCULATE --- */
async function loadCurrentProfileData() {
  const allProfiles = await dbGetAllSafe('profiles');
  if (allProfiles.length === 0) {
    const defProfile = { id: 'default', name: 'Main Profile', theme: 'dark' };
    await dbPutSafe('profiles', defProfile);
    state.profiles = [defProfile];
  } else {
    state.profiles = allProfiles;
  }
  
  if (!state.profiles.find(p => p.id === state.currentProfileId)) {
    state.currentProfileId = state.profiles[0].id;
    localStorage.setItem('mimoni_profile_id', state.currentProfileId);
  }

  const p = state.profiles.find(x => x.id === state.currentProfileId);
  const profileLabel = document.getElementById('activeProfileLabel');
  if (profileLabel) profileLabel.textContent = p.name;
  
  // Theme logic
  const isLight = p.theme === 'light';
  document.body.classList.toggle('light-theme', isLight);
  const themeMeta = document.getElementById('themeColorMeta');
  if (themeMeta) themeMeta.setAttribute('content', isLight ? '#F2F4F7' : '#0B0D12');

  // Load Settings and Migrate legacy v4 'main' settings so starting balances aren't wiped
  let savedSettings = await dbGetSafe('settings', 'settings_' + state.currentProfileId);
  if (!savedSettings && state.currentProfileId === 'default') {
    const legacySettings = await dbGetSafe('settings', 'main');
    if (legacySettings) {
      savedSettings = { ...legacySettings, key: 'settings_default' };
      await dbPutSafe('settings', savedSettings);
      await dbDeleteSafe('settings', 'main');
    }
  }

  if (savedSettings) {
    state.settings = savedSettings;
  } else {
    state.settings = {
      initialized: false, skippedSetup: false, currency: '₹',
      startingBalance: 0, startingBank: 0, startingCash: 0,
      currentBalance: 0, bankBalance: 0, cashBalance: 0
    };
  }

  const allTx = await dbGetAllSafe('transactions');
  state.transactions = allTx.filter(t => (t.profileId || 'default') === state.currentProfileId);
  
  const allPlanned = await dbGetAllSafe('planned_expenses');
  state.plannedExpenses = allPlanned.filter(pl => (pl.profileId || 'default') === state.currentProfileId).sort((a, b) => b.timestamp - a.timestamp);

  const allTags = await dbGetAllSafe('tags');
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
    await dbPutSafe('transactions', item);
  }

  state.settings.currentBalance = runningTotal;
  state.settings.bankBalance = runningBank;
  state.settings.cashBalance = runningCash;
  await dbPutSafe('settings', { key: 'settings_' + state.currentProfileId, ...state.settings });

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
  dbPutSafe('tags', state.tags[clean]);
  return newColor;
}

function detectUngroupedDuplicateTags() {
  const counts = {};
  const canonicalNames = {};
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
      tx.tag = clean; tx.tagColor = unifiedColor; await dbPutSafe('transactions', tx);
    }
  }
  for (const pt of state.plannedExpenses) {
    if ((pt.tag || '').trim().toLowerCase() === key) {
      pt.tag = clean; pt.tagColor = unifiedColor; await dbPutSafe('planned_expenses', pt);
    }
  }

  state.tags[clean] = { name: clean, color: unifiedColor, grouped: true, expanded: false, profileId: state.currentProfileId };
  await dbPutSafe('tags', state.tags[clean]);
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
  
  const els = {
    curHero: document.getElementById('currencySymbolHero'),
    sheetCur: document.getElementById('sheetCurrencySign'),
    planCur: document.getElementById('planSheetCurrencySign'),
    setupBanner: document.getElementById('setupPromptBanner'),
    ungroupedBadge: document.getElementById('ungroupedBadge'),
    groupingBanner: document.getElementById('tagGroupingPromptBanner'),
    groupPromptTxt: document.getElementById('groupingPromptText'),
    heroBal: document.getElementById('rollingBalanceValue'),
    bankText: document.getElementById('bankBalanceText'),
    cashText: document.getElementById('cashBalanceText'),
    inText: document.getElementById('totalInflowText'),
    outText: document.getElementById('totalOutflowText'),
    planTotText: document.getElementById('plannedTotalBalanceText'),
    planResText: document.getElementById('plannedReservedText'),
    planAvailText: document.getElementById('plannedAvailableText'),
    planLiveAvailText: document.getElementById('planLiveAvailableText'),
    planList: document.getElementById('plannedList'),
    planEmpty: document.getElementById('plannedEmptyStateBox')
  };

  if (els.curHero) els.curHero.textContent = cur;
  if (els.sheetCur) els.sheetCur.textContent = cur;
  if (els.planCur) els.planCur.textContent = cur;

  if (els.setupBanner) els.setupBanner.classList.toggle('hidden', state.settings.initialized || !state.settings.skippedSetup);

  const ungroupedCandidates = detectUngroupedDuplicateTags();
  if (ungroupedCandidates.length > 0) {
    if (els.ungroupedBadge) els.ungroupedBadge.classList.remove('hidden');
    const firstCand = ungroupedCandidates.find(c => !state.dismissedGroupPrompts[c.key]);
    if (firstCand) {
      state.pendingGroupCandidate = firstCand;
      if (els.groupPromptTxt) els.groupPromptTxt.textContent = `Group ${firstCand.count} "${firstCand.name}" tags?`;
      if (els.groupingBanner) els.groupingBanner.classList.remove('hidden');
    } else {
      if (els.groupingBanner) els.groupingBanner.classList.add('hidden');
    }
  } else {
    if (els.ungroupedBadge) els.ungroupedBadge.classList.add('hidden');
    if (els.groupingBanner) els.groupingBanner.classList.add('hidden');
  }

  // View 1: Ledger
  animateBalanceCounter(state.settings.currentBalance);
  if (els.bankText) els.bankText.textContent = `${cur}${formatMoneyNumber(state.settings.bankBalance)}`;
  if (els.cashText) els.cashText.textContent = `${cur}${formatMoneyNumber(state.settings.cashBalance)}`;

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
  
  if (els.inText) els.inText.textContent = `+${cur}${formatMoneyNumber(totalIn)}`;
  if (els.outText) els.outText.textContent = `-${cur}${formatMoneyNumber(totalOut)}`;
  
  renderTransactionsTimeline(filteredTx);

  // View 2: Planned
  let totalPlanned = 0;
  state.plannedExpenses.forEach(p => totalPlanned += p.amount);
  const safeAvailable = Math.round((state.settings.currentBalance - totalPlanned)*100)/100;
  
  if (els.planTotText) els.planTotText.textContent = `${cur}${formatMoneyNumber(state.settings.currentBalance)}`;
  if (els.planResText) els.planResText.textContent = `-${cur}${formatMoneyNumber(totalPlanned)}`;
  if (els.planAvailText) els.planAvailText.textContent = `${cur}${formatMoneyNumber(Math.max(0, safeAvailable))}`;
  if (els.planLiveAvailText) els.planLiveAvailText.textContent = `${cur}${formatMoneyNumber(Math.max(0, safeAvailable))}`;
  
  if (state.plannedExpenses.length === 0) {
    if (els.planEmpty) els.planEmpty.classList.remove('hidden');
    if (els.planList) els.planList.innerHTML = '';
  } else {
    if (els.planEmpty) els.planEmpty.classList.add('hidden');
    if (els.planList) {
      els.planList.innerHTML = state.plannedExpenses.map(p => buildTransactionCardHTML(p, cur, true)).join('');
      attachSwipeAndTapHandlers(els.planList, true);
    }
  }

  // View 3: Tags
  renderDedicatedTagsPage(ungroupedCandidates);
}

function switchAppView(viewName) {
  state.activeView = viewName;
  ['HOME','PLANNED','TAGS'].forEach(v => {
    const page = document.getElementById(v.toLowerCase() + 'PageView');
    if (page) page.classList.toggle('hidden', viewName !== v);
    const navBtn = document.getElementById('nav' + v.charAt(0) + v.slice(1).toLowerCase() + 'Btn');
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
  if (!emptyBox || !listEl) return;
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
  
  if (!suggestionBox || !container) return;

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

  const countBadge = document.getElementById('totalTagsCountBadge');
  if (countBadge) countBadge.textContent = `${groupedMap.size + singleList.length} Items`;

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
    if (tagMeta) { tagMeta.expanded = !tagMeta.expanded; dbPutSafe('tags', tagMeta); renderAppUI(); }
  }));
  attachSwipeAndTapHandlers(container, null);
}

/* --- SWIPE & TAP --- */
function attachSwipeAndTapHandlers(rootEl, forcePlanned = null) {
  if (!rootEl) return;
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
  
  if (isPlanned) await dbDeleteSafe('planned_expenses', id);
  else await dbDeleteSafe('transactions', id);
  
  await loadCurrentProfileData();
  renderAppUI();

  const toast = document.getElementById('undoToast');
  document.getElementById('undoToastText').textContent = `Deleted ${isPlanned?'plan':'entry'} "${target.tag}"`;
  toast.classList.add('visible');
  if (state.undoTimer) clearTimeout(state.undoTimer);
  state.undoTimer = setTimeout(() => toast.classList.remove('visible'), 5000);
}

/* --- QUICK LOG ACTUAL --- */
function openQuickLogSheet(editTx = null) {
  if (editTx && editTx.type) { // If it's a real tx object
    state.editingTxId = editTx.id;
    state.mathExpr = String(editTx.amount);
    state.sheetMode = editTx.type || 'DEDUCT';
    document.getElementById('dateInputField').value = toLocalDatetimeInputString(editTx.timestamp);
    document.getElementById('tagInputField').value = editTx.tag || '';
    document.getElementById('noteInputField').value = editTx.note || '';
  } else {
    state.editingTxId = null;
    state.mathExpr = '0'; 
    state.sheetMode = 'DEDUCT'; 
    document.getElementById('dateInputField').value = toLocalDatetimeInputString(Date.now());
    document.getElementById('tagInputField').value = '';
    document.getElementById('noteInputField').value = '';
  }
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

/* --- EVENT BINDING HELPER --- */
function bindEvt(id, evt, cb) {
  const el = document.getElementById(id);
  if (el) el.addEventListener(evt, cb);
}

/* --- INIT & EVENTS --- */
async function initMiMoniApp() {
  try {
    state.db = await openVaultDB();
    await loadCurrentProfileData();
    renderAppUI(); // FIX: GUARANTEED CALL ON LOAD
    bindUIEvents();
  } catch (e) {
    console.warn("MiMoni Initialization issue handled gracefully:", e);
  }
}

function bindUIEvents() {
  // Navigation
  bindEvt('navHomeBtn', 'click', () => switchAppView('HOME'));
  bindEvt('navPlannedBtn', 'click', () => switchAppView('PLANNED'));
  bindEvt('navTagsBtn', 'click', () => switchAppView('TAGS'));

  // Profiles & Settings
  const pfSelect = document.getElementById('profileSelectDropdown');
  bindEvt('settingsOpenBtn', 'click', () => {
    if (pfSelect) pfSelect.innerHTML = state.profiles.map(p => `<option value="${p.id}" ${p.id===state.currentProfileId?'selected':''}>${escapeHtml(p.name)}</option>`).join('');
    document.getElementById('settingsModalBackdrop').classList.remove('hidden');
  });
  bindEvt('closeSettingsModalBtn', 'click', () => document.getElementById('settingsModalBackdrop').classList.add('hidden'));
  
  if (pfSelect) {
    pfSelect.addEventListener('change', async (e) => {
      state.currentProfileId = e.target.value;
      localStorage.setItem('mimoni_profile_id', state.currentProfileId);
      await loadCurrentProfileData();
      renderAppUI();
    });
  }
  
  bindEvt('createNewProfileBtn', 'click', async () => {
    const name = prompt("Enter new profile name:");
    if (name && name.trim()) {
      const p = { id: 'prof_'+Date.now(), name: name.trim(), theme: 'dark' };
      await dbPutSafe('profiles', p);
      state.currentProfileId = p.id;
      localStorage.setItem('mimoni_profile_id', state.currentProfileId);
      await loadCurrentProfileData();
      document.getElementById('settingsModalBackdrop').classList.add('hidden');
      renderAppUI();
    }
  });

  bindEvt('themeToggleBtn', 'click', async () => {
    const p = state.profiles.find(x => x.id === state.currentProfileId);
    if (p) {
      p.theme = p.theme === 'light' ? 'dark' : 'light';
      await dbPutSafe('profiles', p);
      await loadCurrentProfileData();
    }
  });

  bindEvt('factoryResetBtn', 'click', async () => {
    if (confirm("Wipe all transactions and plans for THIS profile?")) {
      const txs = await dbGetAllSafe('transactions');
      for (const t of txs) if ((t.profileId||'default') === state.currentProfileId) await dbDeleteSafe('transactions', t.id);
      const pls = await dbGetAllSafe('planned_expenses');
      for (const p of pls) if ((p.profileId||'default') === state.currentProfileId) await dbDeleteSafe('planned_expenses', p.id);
      await loadCurrentProfileData();
      renderAppUI();
      document.getElementById('settingsModalBackdrop').classList.add('hidden');
    }
  });

  // Export / Import
  bindEvt('exportJsonBtn', 'click', async () => {
    const payload = { app: 'MiMoni', exportedAt: new Date().toISOString(), settings: state.settings, tags: Object.values(state.tags), transactions: state.transactions, plannedExpenses: state.plannedExpenses };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `MiMoni-Backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  });
  
  bindEvt('importJsonInput', 'change', (e) => {
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = async (ev) => {
      try {
        const data = JSON.parse(ev.target.result);
        if (!data || !data.settings) throw new Error("Invalid file");
        await dbClearStore('transactions'); await dbClearStore('tags'); await dbClearStore('planned_expenses');
        state.settings = data.settings; await dbPutSafe('settings', { key: 'settings_' + state.currentProfileId, ...state.settings });
        state.tags = {}; for (const t of (data.tags||[])) { t.profileId = state.currentProfileId; state.tags[t.name] = t; await dbPutSafe('tags', t); }
        for (const tx of (data.transactions||[])) { tx.profileId = state.currentProfileId; await dbPutSafe('transactions', tx); }
        for (const pl of (data.plannedExpenses||[])) { pl.profileId = state.currentProfileId; await dbPutSafe('planned_expenses', pl); }
        await recalculateRunningBalances();
        document.getElementById('settingsModalBackdrop').classList.add('hidden');
        renderAppUI();
      } catch (err) { alert('Failed to import JSON backup: ' + err.message); }
    };
    reader.readAsText(file);
  });

  // Onboarding
  bindEvt('reopenOnboardingFromSettingsBtn', 'click', () => {
    document.getElementById('settingsModalBackdrop').classList.add('hidden');
    document.getElementById('onboardingModal').classList.remove('hidden');
  });
  bindEvt('editStartingBalInlineBtn', 'click', () => document.getElementById('onboardingModal').classList.remove('hidden'));
  bindEvt('openSetupFromBannerBtn', 'click', () => document.getElementById('onboardingModal').classList.remove('hidden'));
  bindEvt('closeOnboardingModalBtn', 'click', () => document.getElementById('onboardingModal').classList.add('hidden'));
  bindEvt('skipOnboardingBtn', 'click', () => document.getElementById('onboardingModal').classList.add('hidden'));
  bindEvt('onboardingForm', 'submit', async (e) => {
    e.preventDefault();
    const cur = document.getElementById('onboardCurrency').value;
    const total = parseFloat(document.getElementById('onboardTotalBalance').value) || 0;
    const split = document.getElementById('enablePocketSplitToggle').checked;
    const bank = split ? (parseFloat(document.getElementById('onboardBankPart').value) || 0) : total;
    const cash = split ? (parseFloat(document.getElementById('onboardCashPart').value) || 0) : 0;
    state.settings = { ...state.settings, initialized: true, skippedSetup: false, currency: cur, startingBalance: bank+cash, startingBank: bank, startingCash: cash };
    await dbPutSafe('settings', { key: 'settings_' + state.currentProfileId, ...state.settings });
    document.getElementById('onboardingModal').classList.add('hidden');
    await recalculateRunningBalances();
    renderAppUI();
  });

  // Actual Quick Log & Edit
  bindEvt('openQuickLogBtn', 'click', openQuickLogSheet);
  bindEvt('closeQuickLogBtn', 'click', () => document.getElementById('quickLogSheetBackdrop').classList.add('hidden'));
  bindEvt('cancelEditModeBtn', 'click', () => document.getElementById('quickLogSheetBackdrop').classList.add('hidden'));
  bindEvt('typeDeductBtn', 'click', () => { state.sheetMode = 'DEDUCT'; syncSheetModeUI(); });
  bindEvt('typeAddBtn', 'click', () => { state.sheetMode = 'ADD'; syncSheetModeUI(); });
  document.querySelectorAll('#mathKeypad .key-btn').forEach(b => b.addEventListener('click', () => {
    const k = b.getAttribute('data-key');
    if (k === 'BACK') state.mathExpr = state.mathExpr.length > 1 ? state.mathExpr.slice(0,-1) : '0';
    else if (['+','-','*','/'].includes(k)) { if (!['+','-','*','/'].includes(state.mathExpr.slice(-1))) state.mathExpr += k; }
    else state.mathExpr = (state.mathExpr === '0' && k !== '.') ? k : state.mathExpr + k;
    syncSheetModeUI();
  }));
  bindEvt('clearMathBtn', 'click', () => { state.mathExpr = '0'; syncSheetModeUI(); });
  bindEvt('saveTransactionBtn', 'click', async () => {
    const amount = evaluateMathExpression(state.mathExpr);
    if (amount <= 0) return;
    const tag = document.getElementById('tagInputField').value.trim() || 'General';
    const dtVal = document.getElementById('dateInputField').value;
    const ts = dtVal ? new Date(dtVal).getTime() : Date.now();
    const tx = {
      id: state.editingTxId || ('tx_' + Date.now()), amount, type: state.sheetMode, tag, tagColor: ensureTagColor(tag),
      pocket: state.sheetPocket, note: document.getElementById('noteInputField').value,
      timestamp: isFinite(ts) ? ts : Date.now(), profileId: state.currentProfileId
    };
    await dbPutSafe('transactions', tx);
    await recalculateRunningBalances();
    document.getElementById('quickLogSheetBackdrop').classList.add('hidden');
    renderAppUI();
  });

  // Planned Expenses
  bindEvt('openPlanSheetBtn', 'click', openPlanExpenseSheet);
  bindEvt('closePlanSheetBtn', 'click', () => document.getElementById('planExpenseSheetBackdrop').classList.add('hidden'));
  document.querySelectorAll('#planMathKeypad .key-btn').forEach(b => b.addEventListener('click', () => {
    const k = b.getAttribute('data-key');
    if (k === 'BACK') state.mathExpr = state.mathExpr.length > 1 ? state.mathExpr.slice(0,-1) : '0';
    else if (['+','-','*','/'].includes(k)) { if (!['+','-','*','/'].includes(state.mathExpr.slice(-1))) state.mathExpr += k; }
    else state.mathExpr = (state.mathExpr === '0' && k !== '.') ? k : state.mathExpr + k;
    syncPlanSheetUI();
  }));
  bindEvt('savePlannedBtn', 'click', async () => {
    const amount = evaluateMathExpression(state.mathExpr);
    if (amount <= 0) return;
    let totalPlanned = 0; state.plannedExpenses.forEach(p => totalPlanned += p.amount);
    const available = state.settings.currentBalance - totalPlanned;
    if (amount > available) { alert(`Cannot plan! Exceeds available balance by ${state.settings.currency}${formatMoneyNumber(amount - available)}.`); return; }
    const tag = document.getElementById('planTagInputField').value.trim() || 'Planned';
    const px = {
      id: 'plan_' + Date.now(), amount, type: 'DEDUCT', tag, tagColor: ensureTagColor(tag),
      note: document.getElementById('planNoteInputField').value,
      timestamp: Date.now(), profileId: state.currentProfileId
    };
    await dbPutSafe('planned_expenses', px);
    await loadCurrentProfileData();
    document.getElementById('planExpenseSheetBackdrop').classList.add('hidden');
    renderAppUI();
  });

  // Details Modal (Edit / Delete)
  bindEvt('closeTxDetailModalBtn', 'click', () => document.getElementById('txDetailModalBackdrop').classList.add('hidden'));
  bindEvt('editTxFromDetailBtn', 'click', () => {
    document.getElementById('txDetailModalBackdrop').classList.add('hidden');
    const tx = state.transactions.find(t => t.id === state.selectedDetailTxId);
    if (tx) openQuickLogSheet(tx);
  });
  bindEvt('deleteTxFromDetailBtn', 'click', async () => {
    document.getElementById('txDetailModalBackdrop').classList.add('hidden');
    await deleteTransactionWithUndo(state.selectedDetailTxId, state.selectedDetailIsPlanned);
  });
  bindEvt('undoActionBtn', 'click', async () => {
    if (!state.lastDeletedTx) return;
    if (state.lastDeletedIsPlanned) await dbPutSafe('planned_expenses', state.lastDeletedTx);
    else await dbPutSafe('transactions', state.lastDeletedTx);
    state.lastDeletedTx = null;
    document.getElementById('undoToast').classList.remove('visible');
    await loadCurrentProfileData();
    renderAppUI();
  });

  // Post Planned to Ledger
  bindEvt('postPlannedToLedgerBtn', 'click', () => {
    document.getElementById('txDetailModalBackdrop').classList.add('hidden');
    document.getElementById('postLedgerDate').value = toLocalDatetimeInputString(Date.now());
    document.getElementById('postToLedgerModalBackdrop').classList.remove('hidden');
  });
  bindEvt('closePostLedgerBtn', 'click', () => document.getElementById('postToLedgerModalBackdrop').classList.add('hidden'));
  bindEvt('postToLedgerForm', 'submit', async (e) => {
    e.preventDefault();
    const plannedId = state.selectedDetailTxId;
    const pItem = state.plannedExpenses.find(p => p.id === plannedId);
    if (!pItem) return;
    await dbDeleteSafe('planned_expenses', plannedId);
    const dateVal = document.getElementById('postLedgerDate').value;
    const ts = dateVal ? new Date(dateVal).getTime() : Date.now();
    const tx = {
      id: 'tx_' + Date.now(), amount: pItem.amount, type: 'DEDUCT', tag: pItem.tag, tagColor: pItem.tagColor,
      pocket: document.getElementById('postLedgerPocket').value, note: pItem.note,
      timestamp: isFinite(ts) ? ts : Date.now(), profileId: state.currentProfileId
    };
    await dbPutSafe('transactions', tx);
    await loadCurrentProfileData();
    document.getElementById('postToLedgerModalBackdrop').classList.add('hidden');
    switchAppView('HOME'); 
  });

  // OCR Fallbacks
  bindEvt('closeOcrDrawerBtn', 'click', () => {
    const el = document.getElementById('ocrDrawerBackdrop');
    if (el) el.classList.add('hidden');
  });
  
  // Reconcile
  bindEvt('reconcileOpenBtn', 'click', () => {
    const el = document.getElementById('reconcileModalBackdrop');
    if (el) el.classList.remove('hidden');
  });
  bindEvt('closeReconcileModalBtn', 'click', () => {
    const el = document.getElementById('reconcileModalBackdrop');
    if (el) el.classList.add('hidden');
  });
  bindEvt('reconcileForm', 'submit', async (e) => {
    e.preventDefault();
    const pocket = document.getElementById('reconcilePocketSelect').value;
    const currentPocketBal = pocket === 'CASH' ? state.settings.cashBalance : state.settings.bankBalance;
    const actual = parseFloat(document.getElementById('reconcileActualInput').value);
    if (isNaN(actual)) return;
    const diff = Math.round((actual - currentPocketBal) * 100) / 100;
    if (Math.abs(diff) < 0.01) { document.getElementById('reconcileModalBackdrop').classList.add('hidden'); return; }
    const tx = { id: 'tx_' + Date.now() + '_rec', amount: Math.abs(diff), type: diff > 0 ? 'ADD' : 'DEDUCT', tag: 'Reconcile', tagColor: ensureTagColor('Reconcile'), pocket, note: `Reconciled to ${state.settings.currency}${formatMoneyNumber(actual)}`, timestamp: Date.now(), profileId: state.currentProfileId };
    await dbPutSafe('transactions', tx);
    await recalculateRunningBalances();
    document.getElementById('reconcileModalBackdrop').classList.add('hidden');
    renderAppUI();
  });

  // Tags Page Search
  bindEvt('searchInput', 'input', (e) => { state.searchQuery = e.target.value.trim(); renderAppUI(); });
  bindEvt('tagPageSearchInput', 'input', (e) => { state.tagPageSearchQuery = e.target.value.trim(); renderAppUI(); });
}

document.addEventListener('DOMContentLoaded', initMiMoniApp);
