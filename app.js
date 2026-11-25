/* MiMoni v7 — Complete Multi-Profile, Planned Expenses & Offline OCR Engine */

const DB_NAME = 'MiMoniOfflineVaultDB';
const DB_VERSION = 4;

const state = {
  db: null,
  activeView: 'HOME',
  currentProfileId: localStorage.getItem('mimoni_profile_id') || 'default',
  profiles: [], 
  settings: {
    initialized: false, skippedSetup: false, currency: '₹',
    startingBalance: 0, startingBank: 0, startingCash: 0,
    currentBalance: 0, bankBalance: 0, cashBalance: 0
  },
  transactions: [],
  plannedExpenses: [],
  tags: {}, 
  activePocketFilter: 'ALL',
  searchQuery: '', tagPageSearchQuery: '',
  sheetMode: 'DEDUCT', sheetPocket: 'BANK', mathExpr: '0', currentTagColor: 'hsl(152, 78%, 52%)',
  planTagColor: 'hsl(210, 82%, 60%)',
  editingTxId: null, selectedDetailTxId: null, selectedDetailIsPlanned: false,
  lastDeletedTx: null, lastDeletedIsPlanned: false, undoTimer: null,
  pendingOcrItems: [], pendingGroupCandidate: null, dismissedGroupPrompts: {}
};

/* --- SAFE BOOTLOADER --- */
async function initMiMoniApp() {
  try {
    state.db = await openVaultDB();
    await loadCurrentProfileData();
    renderAppUI();
    bindUIEvents();
    if (window.location.search.includes('share_target=1')) {
      await checkAndroidShareTargetQueue();
      window.history.replaceState({}, document.title, './index.html');
    }
  } catch (error) {
    console.error("Boot error:", error);
  }
}

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
      if (!db.objectStoreNames.contains('profiles')) db.createObjectStore('profiles', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('planned_expenses')) db.createObjectStore('planned_expenses', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve(req.result);
  });
}

function dbGetSafe(storeName, key) {
  return new Promise((resolve) => {
    try {
      if (!state.db.objectStoreNames.contains(storeName)) return resolve(null);
      const req = state.db.transaction(storeName, 'readonly').objectStore(storeName).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}

function dbGetAllSafe(storeName) {
  return new Promise((resolve) => {
    try {
      if (!state.db.objectStoreNames.contains(storeName)) return resolve([]);
      const req = state.db.transaction(storeName, 'readonly').objectStore(storeName).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    } catch { resolve([]); }
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
    } catch { resolve(null); }
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
    } catch { resolve(); }
  });
}

function dbClearStoreSafe(storeName) {
  return new Promise((resolve) => {
    try {
      if (!state.db.objectStoreNames.contains(storeName)) return resolve();
      const tx = state.db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch { resolve(); }
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
  if (profileLabel && p) profileLabel.textContent = p.name;
  
  // Apply Day / Night Theme
  const isLight = p && p.theme === 'light';
  document.body.classList.toggle('light-theme', isLight);
  const themeMeta = document.getElementById('themeColorMeta');
  if (themeMeta) themeMeta.setAttribute('content', isLight ? '#F2F4F8' : '#0B0D12');

  const dayBtn = document.getElementById('themeDayBtn');
  const nightBtn = document.getElementById('themeNightBtn');
  if (dayBtn && nightBtn) {
    dayBtn.classList.toggle('active', isLight);
    nightBtn.classList.toggle('active', !isLight);
  }

  // Load Settings & Migrate legacy 'main' settings if needed
  let savedSettings = await dbGetSafe('settings', 'settings_' + state.currentProfileId);
  if (!savedSettings && state.currentProfileId === 'default') {
    const legacySettings = await dbGetSafe('settings', 'main');
    if (legacySettings) {
      savedSettings = { ...legacySettings, key: 'settings_default' };
      await dbPutSafe('settings', savedSettings);
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

  state.transactions.reverse();
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

  state.tags[clean] = { name: clean, color: unifiedColor, grouped: true, expanded: true, profileId: state.currentProfileId };
  await dbPutSafe('tags', state.tags[clean]);
  state.pendingGroupCandidate = null;
  renderAppUI();
}

/* --- FORMATTERS --- */
function formatMoneyNumber(val) {
  return (Number(val) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function toLocalDatetimeInputString(ts) {
  const d = new Date(ts || Date.now());
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

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
        pass1.push(res); i += 2;
      } else { pass1.push(t); i += 1; }
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
  } catch { return 0; }
}

function escapeHtml(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* --- RENDER UI --- */
let displayedHeroBalance = 0;
function animateBalanceCounter(targetValue) {
  const el = document.getElementById('rollingBalanceValue');
  if (!el) return;
  const startValue = displayedHeroBalance;
  const diff = targetValue - startValue;
  const duration = 340;
  const startTime = performance.now();
  function frame(now) {
    const progress = Math.min(1, (now - startTime) / duration);
    const eased = 1 - Math.pow(1 - progress, 3);
    const current = startValue + diff * eased;
    el.textContent = formatMoneyNumber(current);
    if (progress < 1) { requestAnimationFrame(frame); } 
    else { displayedHeroBalance = targetValue; el.textContent = formatMoneyNumber(targetValue); }
  }
  requestAnimationFrame(frame);
}

function renderAppUI() {
  const cur = state.settings.currency || '₹';
  
  const els = {
    curHero: document.getElementById('currencySymbolHero'),
    heroLabel: document.getElementById('heroBalanceLabel'),
    sheetCur: document.getElementById('sheetCurrencySign'),
    planCur: document.getElementById('planSheetCurrencySign'),
    setupBanner: document.getElementById('setupPromptBanner'),
    ungroupedBadge: document.getElementById('ungroupedBadge'),
    groupingBanner: document.getElementById('tagGroupingPromptBanner'),
    groupPromptTxt: document.getElementById('groupingPromptText'),
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

  // View 1: Ledger & Pocket Filter (ALL vs BANK vs CASH)
  let heroTarget = state.settings.currentBalance;
  if (state.activePocketFilter === 'BANK') {
    heroTarget = state.settings.bankBalance;
    if (els.heroLabel) els.heroLabel.textContent = 'BANK POCKET BALANCE';
  } else if (state.activePocketFilter === 'CASH') {
    heroTarget = state.settings.cashBalance;
    if (els.heroLabel) els.heroLabel.textContent = 'CASH POCKET BALANCE';
  } else {
    if (els.heroLabel) els.heroLabel.textContent = 'CURRENT RUNNING BALANCE';
  }

  animateBalanceCounter(heroTarget);
  if (els.bankText) els.bankText.textContent = `${cur}${formatMoneyNumber(state.settings.bankBalance)}`;
  if (els.cashText) els.cashText.textContent = `${cur}${formatMoneyNumber(state.settings.cashBalance)}`;

  let totalIn = 0, totalOut = 0;
  const filteredTx = state.transactions.filter(tx => {
    const txPocket = tx.pocket || 'BANK';
    if (state.activePocketFilter !== 'ALL' && txPocket !== state.activePocketFilter) return false;
    if (state.searchQuery) {
      const q = state.searchQuery.toLowerCase();
      if (!String(tx.tag).toLowerCase().includes(q) && !String(tx.note).toLowerCase().includes(q) && !String(tx.amount).includes(q)) return false;
    }
    return true;
  });
  filteredTx.forEach(tx => { if (tx.type === 'ADD') totalIn += tx.amount; else totalOut += tx.amount; });
  
  if (els.inText) els.inText.textContent = `+${cur}${formatMoneyNumber(totalIn)}`;
  if (els.outText) els.outText.textContent = `-${cur}${formatMoneyNumber(totalOut)}`;
  
  renderSavedTagsInSheet();
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
  renderModernProfilesInSettings();
}

function renderSavedTagsInSheet() {
  const strip = document.getElementById('savedTagChipsRow');
  if (!strip) return;
  const tagList = Object.values(state.tags);
  if (tagList.length === 0) { strip.innerHTML = ''; return; }
  strip.innerHTML = tagList.map(t => `
    <button type="button" class="saved-tag-chip tactile-btn" data-tag-name="${escapeHtml(t.name)}" data-tag-color="${t.color}" style="background:${t.color}22;color:${t.color};border-color:${t.color}55;">
      <span>●</span> ${escapeHtml(t.name)}
    </button>
  `).join('');
  strip.querySelectorAll('.saved-tag-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      document.getElementById('tagInputField').value = chip.getAttribute('data-tag-name');
      state.currentTagColor = chip.getAttribute('data-tag-color');
      document.getElementById('currentTagColorSwatch').style.background = state.currentTagColor;
    });
  });
}

function renderModernProfilesInSettings() {
  const grid = document.getElementById('profilesCardsGrid');
  const countBadge = document.getElementById('profileCountBadge');
  const renameInput = document.getElementById('renameProfileInput');
  const activeAvatar = document.getElementById('activeProfileAvatarSettings');
  if (!grid) return;

  const activeProf = state.profiles.find(p => p.id === state.currentProfileId) || state.profiles[0];
  if (activeProf) {
    if (renameInput && document.activeElement !== renameInput) renameInput.value = activeProf.name;
    if (activeAvatar) activeAvatar.textContent = (activeProf.name || 'M').charAt(0).toUpperCase();
  }
  if (countBadge) countBadge.textContent = `${state.profiles.length} ${state.profiles.length === 1 ? 'Profile' : 'Profiles'}`;

  grid.innerHTML = state.profiles.map(p => {
    const isAct = p.id === state.currentProfileId;
    const initial = (p.name || 'P').charAt(0).toUpperCase();
    return `
      <div class="profile-item-card tactile-btn ${isAct ? 'active' : ''}" data-switch-profile="${p.id}">
        <div class="profile-card-left">
          <div class="profile-card-avatar">${escapeHtml(initial)}</div>
          <div>
            <div class="profile-card-name">${escapeHtml(p.name)}</div>
            <div class="profile-card-sub">${p.theme === 'light' ? '☀ Day Mode' : '🌙 Night Mode'}</div>
          </div>
        </div>
        ${isAct ? '<span class="profile-active-pill">● Active</span>' : '<span class="profile-switch-pill">Switch</span>'}
      </div>
    `;
  }).join('');

  grid.querySelectorAll('[data-switch-profile]').forEach(card => {
    card.addEventListener('click', async () => {
      const targetId = card.getAttribute('data-switch-profile');
      if (targetId && targetId !== state.currentProfileId) {
        state.currentProfileId = targetId;
        localStorage.setItem('mimoni_profile_id', state.currentProfileId);
        await loadCurrentProfileData();
        renderAppUI();
      }
    });
  });
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
              ${!isPlanned ? `<span class="tx-pocket-pill">${tx.pocket || 'BANK'}</span>` : ''}
              ${tx.receiptThumb ? '<span class="tx-receipt-badge">📷 Receipt</span>' : ''}
              ${isPlanned ? '<span class="tx-pocket-pill" style="background:var(--amber-warn);color:#000;">PLANNED</span>' : ''}
            </div>
            <div class="tx-note-sub">${tx.note ? escapeHtml(tx.note) + ' • ' + dateStr : subText}</div>
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
        <div class="unmerged-card-info"><strong>"${escapeHtml(c.name)}" (${c.count} transactions)</strong><div>Group them into a dropdown folder?</div></div>
        <button type="button" class="group-confirm-btn tactile-btn" data-merge-tag="${escapeHtml(c.name)}">Group (${c.count})</button>
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
      if (item.runningBalance !== undefined) g.net += (item.type === 'ADD' ? item.amount : -item.amount);
    } else {
      singleList.push(item);
    }
  });

  const countBadge = document.getElementById('totalTagsCountBadge');
  if (countBadge) countBadge.textContent = `${groupedMap.size + singleList.length} Items`;

  let html = [];
  if (groupedMap.size > 0) {
    html.push(`<div class="tags-section-divider"><span>Grouped Folders (Tap to Drop Down)</span><span>${groupedMap.size}</span></div>`);
    for (const g of groupedMap.values()) {
      const netColor = g.net >= 0 ? 'var(--mint-add)' : 'var(--coral-deduct)';
      html.push(`
        <div class="tag-group-card ${g.expanded?'expanded':''}">
          <button type="button" class="tag-group-header" data-toggle-group="${escapeHtml(g.name)}">
            <div class="tag-group-left">
              <span class="tag-group-dot" style="background:${g.color};"></span>
              <span class="tag-group-title" style="color:${g.color};">${escapeHtml(g.name)}</span>
              <span class="tag-group-count">${g.items.length} Transactions</span>
            </div>
            <div class="tag-group-right"><span class="tag-group-net" style="color:${netColor};">${cur}${formatMoneyNumber(Math.abs(g.net))}</span><span class="tag-group-chevron">▼</span></div>
          </button>
          <div class="tag-group-tx-list ${g.expanded?'':'hidden'}">
            ${g.items.map(i => buildTransactionCardHTML(i, cur, i.runningBalance === undefined)).join('')}
          </div>
        </div>`);
    }
  }

  if (singleList.length > 0) {
    html.push(`<div class="tags-section-divider"><span>Single & Individual Tags</span><span>${singleList.length}</span></div>`);
    singleList.forEach(i => {
      const color = i.tagColor || '#2ED573';
      const isP = i.runningBalance === undefined;
      html.push(`
        <div class="single-tag-entry-card">
          <div class="single-tag-pill-header">
            <div class="single-tag-name-wrap" style="color:${color};"><span class="tag-group-dot" style="background:${color};width:10px;height:10px;"></span>${escapeHtml(i.tag)}</div>
            <span class="single-tag-kind-badge">${isP ? 'Planned Tag' : 'Single Tag'}</span>
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
      <div class="detail-row"><span class="detail-label">Pocket</span><strong>${item.pocket || 'BANK'}</strong></div>
      <div class="detail-row"><span class="detail-label">Balance Change</span><strong>${cur}${formatMoneyNumber(item.previousBalance)} → ${cur}${formatMoneyNumber(item.runningBalance)}</strong></div>
    ` + infoHtml;
  }
  document.getElementById('txDetailInfoList').innerHTML = infoHtml;
  document.getElementById('plannedActionsRow').classList.toggle('hidden', !isPlanned);

  const receiptSec = document.getElementById('txDetailReceiptSection');
  if (receiptSec) {
    if (item.receiptThumb) {
      receiptSec.classList.remove('hidden');
      document.getElementById('txDetailReceiptImg').src = item.receiptThumb;
      document.getElementById('txDetailRawOcrText').textContent = item.rawText || 'Attached receipt.';
    } else {
      receiptSec.classList.add('hidden');
    }
  }

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
  if (editTx && editTx.type) { 
    state.editingTxId = editTx.id;
    state.mathExpr = String(editTx.amount);
    state.sheetMode = editTx.type || 'DEDUCT';
    state.sheetPocket = editTx.pocket || 'BANK';
    state.currentTagColor = editTx.tagColor || ensureTagColor(editTx.tag);
    document.getElementById('dateInputField').value = toLocalDatetimeInputString(editTx.timestamp);
    document.getElementById('tagInputField').value = editTx.tag || '';
    document.getElementById('noteInputField').value = editTx.note || '';
    document.getElementById('editingModeBanner').classList.remove('hidden');
  } else {
    state.editingTxId = null;
    state.mathExpr = '0'; 
    state.sheetMode = 'DEDUCT';
    state.sheetPocket = state.activePocketFilter === 'CASH' ? 'CASH' : 'BANK';
    state.currentTagColor = generateVibrantHSL();
    document.getElementById('dateInputField').value = toLocalDatetimeInputString(Date.now());
    document.getElementById('tagInputField').value = '';
    document.getElementById('noteInputField').value = '';
    document.getElementById('editingModeBanner').classList.add('hidden');
  }
  document.getElementById('currentTagColorSwatch').style.background = state.currentTagColor;
  document.querySelectorAll('#sheetPocketSwitch .mini-pocket-btn').forEach(b => {
    b.classList.toggle('active', b.getAttribute('data-pocket') === state.sheetPocket);
  });
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

  const prevBal = Number(state.settings.currentBalance) || 0;
  const delta = state.sheetMode === 'ADD' ? val : -val;
  const nextBal = Math.round((prevBal + delta) * 100) / 100;
  const prevEl = document.getElementById('livePrevBalText');
  const nextEl = document.getElementById('liveNewBalText');
  if (prevEl) prevEl.textContent = `${cur}${formatMoneyNumber(prevBal)}`;
  if (nextEl) {
    nextEl.textContent = `${cur}${formatMoneyNumber(nextBal)}`;
    nextEl.style.color = state.sheetMode === 'ADD' ? 'var(--mint-add)' : 'var(--coral-deduct)';
  }
}

/* --- PLAN EXPENSE SHEET --- */
function openPlanExpenseSheet() {
  state.mathExpr = '0'; state.editingTxId = null;
  state.planTagColor = generateVibrantHSL();
  document.getElementById('planTagColorSwatch').style.background = state.planTagColor;
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

function openPlannedSummaryModal() {
  const cur = state.settings.currency || '₹';
  let totalPlanned = 0;
  state.plannedExpenses.forEach(p => totalPlanned += (Number(p.amount) || 0));
  totalPlanned = Math.round(totalPlanned * 100) / 100;

  const actualBal = Math.round((Number(state.settings.currentBalance) || 0) * 100) / 100;
  const diff = Math.round((totalPlanned - actualBal) * 100) / 100;
  const count = state.plannedExpenses.length;

  document.getElementById('summaryTotalPlannedBig').textContent = `${cur}${formatMoneyNumber(totalPlanned)}`;
  document.getElementById('summaryPlannedCountText').textContent = `${count} ${count === 1 ? 'planned expense' : 'planned expenses'}`;
  document.getElementById('summaryActualBalText').textContent = `${cur}${formatMoneyNumber(actualBal)}`;
  document.getElementById('summaryReservedText').textContent = `${cur}${formatMoneyNumber(totalPlanned)}`;

  const statusRow = document.getElementById('summaryStatusRow');
  const exceedLabel = document.getElementById('summaryExceedLabel');
  const exceedVal = document.getElementById('summaryExceedValue');
  const helperNote = document.getElementById('summaryHelperNote');

  statusRow.classList.remove('exceeded', 'within');

  if (diff > 0) {
    statusRow.classList.add('exceeded');
    exceedLabel.textContent = 'Exceeds Balance By (Needed)';
    exceedVal.textContent = `+${cur}${formatMoneyNumber(diff)}`;
    exceedVal.style.color = 'var(--coral-deduct)';
    helperNote.textContent = `You need ${cur}${formatMoneyNumber(diff)} more than your current balance to cover all planned expenses.`;
  } else {
    const remaining = Math.abs(diff);
    statusRow.classList.add('within');
    exceedLabel.textContent = 'Within Balance (Remaining)';
    exceedVal.textContent = `${cur}${formatMoneyNumber(remaining)}`;
    exceedVal.style.color = 'var(--mint-add)';
    helperNote.textContent = `Your current balance covers all planned expenses with ${cur}${formatMoneyNumber(remaining)} to spare.`;
  }

  document.getElementById('plannedSummaryModalBackdrop').classList.remove('hidden');
}

/* --- RESTORED OFFLINE SCREENSHOT OCR SCANNER ENGINE --- */
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
  if (inspectorEl) inspectorEl.textContent = 'Enhancing screenshot contrast & running offline OCR...';
  state.pendingOcrItems = [];

  const files = Array.from(fileList);
  const allRawDumps = [];

  for (let idx = 0; idx < files.length; idx++) {
    const file = files[idx];
    statusEl.textContent = `Scanning screenshot ${idx + 1} of ${files.length}...`;
    fillEl.style.width = '15%';
    pctEl.textContent = '15%';

    const thumbDataUrl = await compressReceiptThumbnail(file);
    const preprocessed = await createPreprocessedOcrCanvases(file);

    let combinedRawText = '';
    try {
      if (window.Tesseract) {
        const res1 = await window.Tesseract.recognize(preprocessed.standardCanvas, 'eng', {
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
          const res2 = await window.Tesseract.recognize(preprocessed.invertedCanvas, 'eng');
          combinedRawText += '\n' + ((res2 && res2.data && res2.data.text) ? res2.data.text : '');
        }
      }
    } catch (err) {
      console.warn('OCR fallback:', err);
    }

    allRawDumps.push(`--- Screenshot #${idx + 1} ---\n${combinedRawText || '(No text detected)'}`);
    const parsedEntries = parseReceiptTextIntoTransactions(combinedRawText, thumbDataUrl);
    state.pendingOcrItems.push(...parsedEntries);
  }

  fillEl.style.width = '100%';
  pctEl.textContent = '100%';
  if (inspectorEl) inspectorEl.textContent = allRawDumps.join('\n\n');
  statusEl.textContent = `Extracted ${state.pendingOcrItems.length} item(s). Review or edit below before saving:`;
  renderOcrReviewItems();
}

function createPreprocessedOcrCanvases(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const targetW = Math.min(1600, Math.max(1000, img.width * 1.4));
        const scale = targetW / img.width;
        const targetH = Math.round(img.height * scale);

        const stdCanvas = document.createElement('canvas');
        stdCanvas.width = targetW; stdCanvas.height = targetH;
        const stdCtx = stdCanvas.getContext('2d');
        stdCtx.drawImage(img, 0, 0, targetW, targetH);

        const invCanvas = document.createElement('canvas');
        invCanvas.width = targetW; invCanvas.height = targetH;
        const invCtx = invCanvas.getContext('2d');
        invCtx.drawImage(img, 0, 0, targetW, targetH);

        try {
          const imgData = stdCtx.getImageData(0, 0, targetW, targetH);
          const data = imgData.data;
          const invDataObj = invCtx.getImageData(0, 0, targetW, targetH);
          const invData = invDataObj.data;

          let lumSum = 0, count = 0;
          for (let i = 0; i < data.length; i += 64) {
            lumSum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
            count++;
          }
          const isDarkBg = (lumSum / Math.max(1, count)) < 115;

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
        } catch (err) { console.warn(err); }
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
        const maxW = 480;
        const scale = Math.min(1, maxW / img.width);
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', 0.7));
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
  const rawLines = cleanText.split('\n').map(l => l.replace(/\s+/g, ' ').trim()).filter(l => l.length > 1);

  const ignoreLineRegex = /\b(utr|upi\s*transaction\s*id|transaction\s*id|google\s*transaction\s*id|ref\s*no|reference\s*id|ifsc|account\s*no|xxxx|kb\/s|vo\s*lte|5g|4g|battery)\b/i;
  const statusClockOrPctRegex = /^\d{1,2}:\d{2}(\s*[ap]m)?$|^\d{1,3}%$/i;
  const deductKeywords = /\b(paid\s+to|sent\s+to|debited|debit|dr\b|withdrawn|spent|payment\s+to|money\s+sent|paid\b|transfer\s+to)\b/i;
  const addKeywords = /\b(received\s+from|credited|credit|cr\b|added|refund|deposited|cashback|money\s+received|received\b)\b/i;

  let globalType = 'DEDUCT';
  if (addKeywords.test(cleanText) && !deductKeywords.test(cleanText)) globalType = 'ADD';

  let primaryCounterparty = '';
  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];
    const m = line.match(/(?:paid\s+to|sent\s+to|received\s+from|payment\s+to|transfer\s+to|to\s*:|from\s*:)\s*([A-Za-z][A-Za-z0-9 &._'-]{1,28})/i);
    if (m && m[1]) {
      const cand = m[1].replace(/\b(bank|upi|verified|okaxis|okhdfcbank|okicici|oksbi|ybl|paytm)\b/gi, '').trim();
      if (cand.length >= 2) { primaryCounterparty = cand; break; }
    }
  }

  const candidates = [];
  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];
    if (ignoreLineRegex.test(line) || statusClockOrPctRegex.test(line)) continue;

    const scrubbed = line
      .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\s*(?:am|pm)?\b/gi, ' ')
      .replace(/\b\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}\b/g, ' ')
      .replace(/\b\d{10,18}\b/g, ' ')
      .replace(/\b\d{1,3}%\b/g, ' ');

    const explicitRegex = /([+\-−])?\s*(?:₹|rs\.?|inr|\$|€|£)\s*([0-9]{1,3}(?:,[0-9]{2,3})+(?:\.[0-9]{1,2})?|[0-9]{1,7}(?:\.[0-9]{1,2})?)/gi;
    let match, matchedExplicit = false;
    while ((match = explicitRegex.exec(scrubbed)) !== null) {
      const val = parseFloat(match[2].replace(/,/g, ''));
      if (!isFinite(val) || val <= 0 || val > 5000000) continue;
      matchedExplicit = true;
      let rowType = globalType;
      if (match[1] === '+') rowType = 'ADD';
      else if (match[1] === '-' || match[1] === '−') rowType = 'DEDUCT';
      else if (addKeywords.test(line)) rowType = 'ADD';
      else if (deductKeywords.test(line)) rowType = 'DEDUCT';
      candidates.push({ amount: val, type: rowType, tag: primaryCounterparty || 'Scanned Receipt', lineText: line, score: 100 });
    }

    if (!matchedExplicit) {
      const fallbackRegex = /([+\-−])?\s*\b([0-9]{1,3}(?:,[0-9]{2,3})+(?:\.[0-9]{1,2})?|[0-9]{1,6}\.[0-9]{2})\b/g;
      while ((match = fallbackRegex.exec(scrubbed)) !== null) {
        const val = parseFloat(match[2].replace(/,/g, ''));
        if (!isFinite(val) || val <= 0 || val > 5000000 || (val >= 1990 && val <= 2035 && !match[2].includes('.'))) continue;
        let rowType = globalType;
        if (match[1] === '+') rowType = 'ADD';
        else if (match[1] === '-' || match[1] === '−') rowType = 'DEDUCT';
        candidates.push({ amount: val, type: rowType, tag: primaryCounterparty || 'Scanned Receipt', lineText: line, score: 75 });
      }
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  const uniqueResults = [];
  const seen = new Set();
  for (const c of candidates) {
    const key = `${c.type}_${c.amount}`;
    if (!seen.has(key)) { seen.add(key); uniqueResults.push(c); }
  }

  if (uniqueResults.length === 0) {
    uniqueResults.push({ amount: 0, type: globalType, tag: primaryCounterparty || 'Scanned Receipt', lineText: 'Enter amount from screenshot below' });
  }

  return uniqueResults.slice(0, 8).map(entry => ({
    tempId: 'ocr_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
    selected: true,
    amount: entry.amount,
    type: entry.type,
    tag: entry.tag,
    tagColor: ensureTagColor(entry.tag),
    pocket: 'BANK',
    note: entry.lineText.slice(0, 75),
    receiptThumb: thumbDataUrl,
    rawText: cleanText.slice(0, 800)
  }));
}

function renderOcrReviewItems() {
  const listEl = document.getElementById('ocrExtractedList');
  if (!listEl) return;
  listEl.innerHTML = state.pendingOcrItems.map((item, idx) => `
    <div class="ocr-item-card" data-idx="${idx}">
      <div class="ocr-item-top">
        <div style="display:flex;align-items:center;gap:8px;">
          <input type="checkbox" class="ocr-select-chk" data-idx="${idx}" ${item.selected ? 'checked' : ''}>
          ${item.receiptThumb ? `<img src="${item.receiptThumb}" class="ocr-thumb" alt="Receipt">` : ''}
          <span style="width:12px;height:12px;border-radius:50%;background:${item.tagColor};display:inline-block;"></span>
          <strong>Item #${idx + 1}</strong>
        </div>
      </div>
      <div class="ocr-edit-grid">
        <input type="text" class="ocr-tag-input" data-idx="${idx}" value="${escapeHtml(item.tag)}" placeholder="Tag / Merchant">
        <input type="number" step="0.01" class="ocr-amt-input" data-idx="${idx}" value="${item.amount || ''}" placeholder="Amount">
        <button type="button" class="type-pill ${item.type === 'ADD' ? 'add' : 'deduct'} active ocr-type-toggle" data-idx="${idx}">
          ${item.type === 'ADD' ? '+ Received' : '− Spent'}
        </button>
      </div>
      <div class="ocr-note-line">Line: "${escapeHtml(item.note)}"</div>
    </div>
  `).join('');

  listEl.querySelectorAll('.ocr-select-chk').forEach(el => el.addEventListener('change', e => {
    state.pendingOcrItems[Number(e.target.getAttribute('data-idx'))].selected = e.target.checked;
  }));
  listEl.querySelectorAll('.ocr-tag-input').forEach(el => el.addEventListener('input', e => {
    state.pendingOcrItems[Number(e.target.getAttribute('data-idx'))].tag = e.target.value;
  }));
  listEl.querySelectorAll('.ocr-amt-input').forEach(el => el.addEventListener('input', e => {
    state.pendingOcrItems[Number(e.target.getAttribute('data-idx'))].amount = parseFloat(e.target.value) || 0;
  }));
  listEl.querySelectorAll('.ocr-type-toggle').forEach(btn => btn.addEventListener('click', () => {
    const i = Number(btn.getAttribute('data-idx'));
    state.pendingOcrItems[i].type = state.pendingOcrItems[i].type === 'ADD' ? 'DEDUCT' : 'ADD';
    renderOcrReviewItems();
  }));
}

async function checkAndroidShareTargetQueue() {
  try {
    const sharedItems = await dbGetAllSafe('shared_queue');
    if (sharedItems && sharedItems.length > 0) {
      const files = sharedItems.map(entry => entry.file).filter(Boolean);
      await dbClearStoreSafe('shared_queue');
      if (files.length > 0) await handleScreenshotFiles(files);
    }
  } catch (e) { console.warn(e); }
}

/* --- EVENT BINDING HELPER --- */
function bindEvt(id, evt, cb) {
  const el = document.getElementById(id);
  if (el) el.addEventListener(evt, cb);
}

function bindUIEvents() {
  bindEvt('navHomeBtn', 'click', () => switchAppView('HOME'));
  bindEvt('navPlannedBtn', 'click', () => switchAppView('PLANNED'));
  bindEvt('navTagsBtn', 'click', () => switchAppView('TAGS'));

  // FIXED: Bank & Cash Pocket Selector Chips on Main Hero Card
  document.querySelectorAll('#pocketSelector .pocket-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#pocketSelector .pocket-chip').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.activePocketFilter = btn.getAttribute('data-pocket') || 'ALL';
      renderAppUI();
    });
  });

  // FIXED: Bank & Cash Mini Pocket Switch inside Quick-Log Sheet
  document.querySelectorAll('#sheetPocketSwitch .mini-pocket-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#sheetPocketSwitch .mini-pocket-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.sheetPocket = btn.getAttribute('data-pocket') || 'BANK';
    });
  });

  // Settings Modal Open / Close
  bindEvt('settingsOpenBtn', 'click', () => {
    renderModernProfilesInSettings();
    document.getElementById('settingsModalBackdrop').classList.remove('hidden');
  });
  bindEvt('closeSettingsModalBtn', 'click', () => document.getElementById('settingsModalBackdrop').classList.add('hidden'));

  // Day / Night Segmented Toggle Buttons
  async function setProfileTheme(targetTheme) {
    const p = state.profiles.find(x => x.id === state.currentProfileId);
    if (p) {
      p.theme = targetTheme;
      await dbPutSafe('profiles', p);
      await loadCurrentProfileData();
      renderAppUI();
    }
  }
  bindEvt('themeDayBtn', 'click', () => setProfileTheme('light'));
  bindEvt('themeNightBtn', 'click', () => setProfileTheme('dark'));

  // Rename Active Profile (Main Profile or any profile)
  bindEvt('saveProfileNameBtn', 'click', async () => {
    const input = document.getElementById('renameProfileInput');
    const newName = (input ? input.value : '').trim();
    if (!newName) return;
    const p = state.profiles.find(x => x.id === state.currentProfileId);
    if (p) {
      p.name = newName;
      await dbPutSafe('profiles', p);
      await loadCurrentProfileData();
      renderAppUI();
      const btn = document.getElementById('saveProfileNameBtn');
      if (btn) {
        btn.textContent = 'Saved ✓';
        setTimeout(() => { btn.textContent = 'Rename'; }, 1400);
      }
    }
  });

  // Add New Profile Inline
  bindEvt('createNewProfileBtn', 'click', async () => {
    const input = document.getElementById('newProfileNameInput');
    let name = (input ? input.value : '').trim();
    if (!name) name = prompt("Enter new profile name:") || '';
    if (name && name.trim()) {
      const p = { id: 'prof_' + Date.now(), name: name.trim(), theme: 'dark' };
      await dbPutSafe('profiles', p);
      if (input) input.value = '';
      state.currentProfileId = p.id;
      localStorage.setItem('mimoni_profile_id', state.currentProfileId);
      await loadCurrentProfileData();
      renderAppUI();
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
        state.settings = data.settings; await dbPutSafe('settings', { key: 'settings_' + state.currentProfileId, ...state.settings });
        for (const t of (data.tags||[])) { t.profileId = state.currentProfileId; state.tags[t.name] = t; await dbPutSafe('tags', t); }
        for (const tx of (data.transactions||[])) { tx.profileId = state.currentProfileId; await dbPutSafe('transactions', tx); }
        for (const pl of (data.plannedExpenses||[])) { pl.profileId = state.currentProfileId; await dbPutSafe('planned_expenses', pl); }
        await loadCurrentProfileData();
        document.getElementById('settingsModalBackdrop').classList.add('hidden');
        renderAppUI();
      } catch (err) { alert('Failed to import JSON backup: ' + err.message); }
    };
    reader.readAsText(file);
  });

  // Onboarding
  const splitChk = document.getElementById('enablePocketSplitToggle');
  if (splitChk) {
    splitChk.addEventListener('change', () => {
      document.getElementById('pocketSplitInputs').classList.toggle('hidden', !splitChk.checked);
    });
  }
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
  bindEvt('openQuickLogBtn', 'click', () => openQuickLogSheet(null));
  bindEvt('closeQuickLogBtn', 'click', () => document.getElementById('quickLogSheetBackdrop').classList.add('hidden'));
  bindEvt('cancelEditModeBtn', 'click', () => document.getElementById('quickLogSheetBackdrop').classList.add('hidden'));
  bindEvt('typeDeductBtn', 'click', () => { state.sheetMode = 'DEDUCT'; syncSheetModeUI(); });
  bindEvt('typeAddBtn', 'click', () => { state.sheetMode = 'ADD'; syncSheetModeUI(); });
  bindEvt('shuffleTagColorBtn', 'click', () => {
    state.currentTagColor = generateVibrantHSL();
    document.getElementById('currentTagColorSwatch').style.background = state.currentTagColor;
  });
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
    
    state.tags[tag] = { name: tag, color: state.currentTagColor, grouped: state.tags[tag] ? state.tags[tag].grouped : false, expanded: true, profileId: state.currentProfileId };
    await dbPutSafe('tags', state.tags[tag]);

    const tx = {
      id: state.editingTxId || ('tx_' + Date.now()), amount, type: state.sheetMode, tag, tagColor: state.currentTagColor,
      pocket: state.sheetPocket, note: document.getElementById('noteInputField').value,
      timestamp: isFinite(ts) ? ts : Date.now(), profileId: state.currentProfileId
    };
    await dbPutSafe('transactions', tx);
    await loadCurrentProfileData();
    document.getElementById('quickLogSheetBackdrop').classList.add('hidden');
    renderAppUI();
  });

  // Planned Expenses
  bindEvt('openPlanSheetBtn', 'click', openPlanExpenseSheet);
  bindEvt('plannedReservedBtn', 'click', openPlannedSummaryModal);
  bindEvt('closePlannedSummaryBtn', 'click', () => document.getElementById('plannedSummaryModalBackdrop').classList.add('hidden'));
  bindEvt('closePlanSheetBtn', 'click', () => document.getElementById('planExpenseSheetBackdrop').classList.add('hidden'));
  bindEvt('planShuffleColorBtn', 'click', () => {
    state.planTagColor = generateVibrantHSL();
    document.getElementById('planTagColorSwatch').style.background = state.planTagColor;
  });
  bindEvt('planClearMathBtn', 'click', () => { state.mathExpr = '0'; syncPlanSheetUI(); });
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
    // Planned expenses are allowed to exceed total actual balance
    const tag = document.getElementById('planTagInputField').value.trim() || 'Planned';
    const px = {
      id: 'plan_' + Date.now(), amount, type: 'DEDUCT', tag, tagColor: state.planTagColor || ensureTagColor(tag),
      note: document.getElementById('planNoteInputField').value,
      timestamp: Date.now(), profileId: state.currentProfileId
    };
    await dbPutSafe('planned_expenses', px);
    await loadCurrentProfileData();
    document.getElementById('planExpenseSheetBackdrop').classList.add('hidden');
    renderAppUI();
  });

  // FIXED: Screenshot OCR File Upload & Commit Bindings
  bindEvt('ocrFileInput', 'change', async (e) => {
    await handleScreenshotFiles(e.target.files);
    e.target.value = '';
  });
  bindEvt('closeOcrDrawerBtn', 'click', () => document.getElementById('ocrDrawerBackdrop').classList.add('hidden'));
  bindEvt('addManualOcrRowBtn', 'click', () => {
    const firstThumb = state.pendingOcrItems[0] ? state.pendingOcrItems[0].receiptThumb : '';
    state.pendingOcrItems.push({
      tempId: 'ocr_manual_' + Date.now(), selected: true, amount: 0, type: 'DEDUCT',
      tag: 'Receipt Entry', tagColor: generateVibrantHSL(), pocket: 'BANK',
      note: 'Manual screenshot entry', receiptThumb: firstThumb, rawText: ''
    });
    renderOcrReviewItems();
  });
  bindEvt('commitOcrItemsBtn', 'click', async () => {
    const selected = state.pendingOcrItems.filter(item => item.selected && Number(item.amount) > 0);
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
        timestamp: Date.now(),
        profileId: state.currentProfileId
      };
      await dbPutSafe('transactions', tx);
    }
    document.getElementById('ocrDrawerBackdrop').classList.add('hidden');
    await loadCurrentProfileData();
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
  
  // Reconcile
  bindEvt('reconcileOpenBtn', 'click', () => {
    document.getElementById('reconcileModalBackdrop').classList.remove('hidden');
  });
  bindEvt('closeReconcileModalBtn', 'click', () => {
    document.getElementById('reconcileModalBackdrop').classList.add('hidden');
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
    await loadCurrentProfileData();
    document.getElementById('reconcileModalBackdrop').classList.add('hidden');
    renderAppUI();
  });

  // Search
  bindEvt('searchInput', 'input', (e) => { state.searchQuery = e.target.value.trim(); renderAppUI(); });
  bindEvt('tagPageSearchInput', 'input', (e) => { state.tagPageSearchQuery = e.target.value.trim(); renderAppUI(); });
}

document.addEventListener('DOMContentLoaded', initMiMoniApp);
