// --- CONFIGURATION CONSTANTS ---
const CLOUD_SAVE_PASSWORD = 'sdrgb';

// Replace with your actual deployed Google Apps Script Web App URL ending in /exec:
const HARDCODED_CLOUD_URL = 'https://script.google.com/macros/s/AKfycbzrb2YMw8Ko8EYpsPEnJdXmWZQr_krUyHzUvCksZDz69zJF2lniV-lxoRoGrq5VutRB7g/exec';

const STAGE_CONFIG = {
  1: { label: 'Day 1 Review', short: 'Day 1', class: 'badge-d1' },
  2: { label: 'Day 3 Review', short: 'Day 3', class: 'badge-d3' },
  3: { label: 'Day 7 Review', short: 'Day 7', class: 'badge-d7' },
  4: { label: 'Day 30 Review', short: 'Day 30', class: 'badge-d30' },
  5: { label: 'Mastered', short: 'Mastered', class: 'badge-master' }
};

const FORWARD_INTERVALS = {
  1: 2,
  2: 4,
  3: 23,
  4: 0
};

// Papers and their corresponding syllabus subjects
const PAPER_SUBJECTS = {
  'GS-1': ['History', 'Geography', 'Indian Society'],
  'GS-2': ['Polity', 'Governance', 'International Relations', 'Social Justice'],
  'GS-3': ['Economics', 'Agriculture', 'Internal Security', 'Environment', 'Disaster Management', 'Science and Technology'],
  'GS-4': [], // No specific subject
  'Essay': [], // No specific subject
  'Optional': ['Language', 'Literature'],
  'Prelims': ['History', 'Geography', 'Polity', 'International Relations', 'Economy', 'Environment', 'Science and Tech', 'Others']
};

const PAPERS_LIST = ['ALL', 'GS-1', 'GS-2', 'GS-3', 'GS-4', 'Essay', 'Optional', 'Prelims'];

const DB_KEY = 'mains_topics_store_v2';
const UNSAVED_FLAG_KEY = 'mains_unsaved_cloud_flag_v2';
const SYNCED_SNAPSHOT_KEY = 'mains_topics_synced_snapshot_v2';

let topics = [];
let currentPaperFilter = 'ALL';
let currentStageFilter = 'ALL'; // 'ALL', 1, 2, 3, 4
let activeDemotingTopicId = null;
let activeEditingTopicId = null;
let selectedDemoteStage = 1;
let hasUnsavedCloudChanges = false;
let isSyncInProgress = false;

// --- REVISION SESSION ENGINE STATE ---
let sessionState = {
  active: false,
  cards: [],
  currentIndex: 0,
  defaultCardDuration: 180, // 3 minutes per card
  secondsRemaining: 180,
  totalElapsedSeconds: 0,
  isPaused: false,
  timerInterval: null,
  timeSpentMap: {}, // id -> total seconds spent
  gradesMap: {} // id -> 'pass' | 'fail'
};

// --- AUDIO CHIME (WEB AUDIO API - 100% OFFLINE) ---
function playSessionAlert() {
  try {
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, audioCtx.currentTime); // A5
    osc.frequency.exponentialRampToValueAtTime(1174, audioCtx.currentTime + 0.35); // D6

    gain.gain.setValueAtTime(0.25, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.4);

    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.4);

    if (navigator.vibrate) {
      navigator.vibrate([200, 100, 250]);
    }
  } catch (e) {
    console.warn('Audio feedback error:', e);
  }
}

// --- CLOUD ENDPOINT VALIDATION ---
function getCloudEndpointStatus() {
  if (!HARDCODED_CLOUD_URL || HARDCODED_CLOUD_URL.trim() === '') {
    return {
      ok: false,
      category: 'APP CONFIG ERROR',
      message: 'Cloud Sheet URL is empty. Paste your Web App /exec URL into HARDCODED_CLOUD_URL in app.js.'
    };
  }
  if (HARDCODED_CLOUD_URL.includes('YOUR_DEPLOYMENT_ID') || HARDCODED_CLOUD_URL.includes('AKfycb...')) {
    return {
      ok: false,
      category: 'APP CONFIG ERROR',
      message: 'Cloud URL contains placeholder text. Replace it with your actual deployment ID.'
    };
  }
  if (!HARDCODED_CLOUD_URL.startsWith('https://script.google.com/macros/s/')) {
    return {
      ok: false,
      category: 'APP CONFIG ERROR',
      message: 'URL must start with "https://script.google.com/macros/s/".'
    };
  }
  if (!HARDCODED_CLOUD_URL.endsWith('/exec')) {
    return {
      ok: false,
      category: 'APP CONFIG ERROR',
      message: 'URL must end with "/exec".'
    };
  }
  return { ok: true };
}

// --- VISUAL VIEWPORT & KEYBOARD TRACKER ---
function setupVisualViewportSync() {
  if (!window.visualViewport) return;
  const updateViewport = () => {
    const vv = window.visualViewport;
    const keyboardHeight = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    document.documentElement.style.setProperty('--keyboard-height', `${keyboardHeight}px`);
    document.documentElement.style.setProperty('--visual-viewport-h', `${vv.height}px`);
  };
  window.visualViewport.addEventListener('resize', updateViewport);
  window.visualViewport.addEventListener('scroll', updateViewport);
  updateViewport();
}

window.addEventListener('DOMContentLoaded', async () => {
  setupVisualViewportSync();

  if (navigator.storage && navigator.storage.persist) {
    const isPersisted = await navigator.storage.persist();
    document.getElementById('storage-status')?.setAttribute('title', isPersisted ? 'Persistent' : 'Standard');
  }
  
  loadData();
  onPaperChange('add');
  renderAll();

  if (topics.length === 0) {
    autoSyncFromCloud();
  }

  document.getElementById('save-password-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') verifyAndSaveToCloud();
  });
});

window.addEventListener('beforeunload', (e) => {
  if (hasUnsavedCloudChanges) {
    e.preventDefault();
    e.returnValue = '';
    return '';
  }
});

function getTodayString() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function addDays(dateStr, days) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + parseInt(days, 10));
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function getDaysDiff(date1Str, date2Str) {
  const d1 = new Date(date1Str);
  const d2 = new Date(date2Str);
  return Math.floor((d2 - d1) / (1000 * 60 * 60 * 24));
}

function normalizePaper(paperStr) {
  if (!paperStr) return 'Prelims';
  const clean = paperStr.trim().toUpperCase();
  if (clean.includes('GS1') || clean.includes('GS-1')) return 'GS-1';
  if (clean.includes('GS2') || clean.includes('GS-2')) return 'GS-2';
  if (clean.includes('GS3') || clean.includes('GS-3')) return 'GS-3';
  if (clean.includes('GS4') || clean.includes('GS-4')) return 'GS-4';
  if (clean.includes('ESSAY')) return 'Essay';
  if (clean.includes('OPTIONAL') || clean.includes('OPT')) return 'Optional';
  if (clean.includes('PRELIMS') || clean.includes('PRE')) return 'Prelims';
  return 'Prelims';
}

function generateNextCardId(paper) {
  const norm = normalizePaper(paper);
  const regex = new RegExp(`^${norm}-(\\d+)$`, 'i');
  let highestNum = 0;

  topics.forEach(t => {
    if (!t.cardId) return;
    const match = t.cardId.trim().match(regex);
    if (match) {
      const currentNum = parseInt(match[1], 10);
      if (currentNum > highestNum) highestNum = currentNum;
    }
  });

  return `${norm}-${String(highestNum + 1).padStart(3, '0')}`;
}

// --- DYNAMIC SUBJECT SELECTION ---
function onPaperChange(mode) {
  const paperSelect = document.getElementById(mode === 'add' ? 'add-topic-paper' : 'edit-topic-paper');
  const subjectSelect = document.getElementById(mode === 'add' ? 'add-topic-subject' : 'edit-topic-subject');
  const subjectGroup = document.getElementById(mode === 'add' ? 'add-subject-group' : 'edit-subject-group');

  if (!paperSelect || !subjectSelect || !subjectGroup) return;

  const selectedPaper = normalizePaper(paperSelect.value);
  const subjects = PAPER_SUBJECTS[selectedPaper] || [];

  subjectSelect.innerHTML = '';

  if (subjects.length === 0) {
    subjectGroup.style.display = 'none';
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'None';
    subjectSelect.appendChild(opt);
  } else {
    subjectGroup.style.display = 'block';
    subjects.forEach(sub => {
      const opt = document.createElement('option');
      opt.value = sub;
      opt.textContent = sub;
      subjectSelect.appendChild(opt);
    });
  }
}

function loadData() {
  try {
    const raw = localStorage.getItem(DB_KEY);
    topics = raw ? JSON.parse(raw) : [];

    const today = getTodayString();
    let hasChanges = false;

    topics.forEach((t) => {
      if (!t.stage) t.stage = 1;
      if (!t.addedDate) t.addedDate = today;
      if (!t.lastReviewed) t.lastReviewed = t.addedDate;
      if (!t.failCount) t.failCount = 0;
      if (t.subject === undefined) t.subject = '';

      if (!t.cardId) {
        t.cardId = generateNextCardId(t.paper);
        hasChanges = true;
      }

      if (!t.nextDue && t.stage < 5) {
        t.nextDue = addDays(today, 1);
        hasChanges = true;
      }
    });

    if (hasChanges) {
      localStorage.setItem(DB_KEY, JSON.stringify(topics));
    }

    if (!localStorage.getItem(SYNCED_SNAPSHOT_KEY)) {
      localStorage.setItem(SYNCED_SNAPSHOT_KEY, JSON.stringify(topics));
    }

    hasUnsavedCloudChanges = localStorage.getItem(UNSAVED_FLAG_KEY) === 'true';
    updateSyncStatusUI();

  } catch (e) {
    console.error('Failed reading storage:', e);
    topics = [];
  }
}

function saveData() {
  localStorage.setItem(DB_KEY, JSON.stringify(topics));
  hasUnsavedCloudChanges = true;
  localStorage.setItem(UNSAVED_FLAG_KEY, 'true');
  updateSyncStatusUI();
  renderAll();
}

function updateSyncStatusUI() {
  const dot = document.getElementById('sync-dot');
  const text = document.getElementById('sync-status-text');
  const saveBtn = document.getElementById('header-save-btn');
  const discardBtn = document.getElementById('header-discard-btn');

  if (isSyncInProgress) {
    if (dot) dot.className = 'dot syncing';
    if (text) text.textContent = 'Syncing...';
    if (saveBtn) {
      saveBtn.className = 'btn-header-save unsaved';
      saveBtn.textContent = '⏳ Saving...';
      saveBtn.disabled = true;
    }
    return;
  }

  if (saveBtn) saveBtn.disabled = false;

  if (hasUnsavedCloudChanges) {
    if (dot) dot.className = 'dot unsaved';
    if (text) text.textContent = 'Unsaved Changes';
    if (saveBtn) {
      saveBtn.className = 'btn-header-save unsaved';
      saveBtn.textContent = '💾 Save to Sheet *';
    }
    if (discardBtn) discardBtn.classList.remove('hidden');
  } else {
    if (dot) dot.className = 'dot';
    if (text) text.textContent = 'Synced to Sheet';
    if (saveBtn) {
      saveBtn.className = 'btn-header-save synced';
      saveBtn.textContent = '✓ Saved to Sheet';
    }
    if (discardBtn) discardBtn.classList.add('hidden');
  }
}

function showToast(message, isError = false, showRetry = false) {
  const toast = document.getElementById('toast-container');
  const msgEl = document.getElementById('toast-message');
  const retryBtn = document.getElementById('toast-retry-btn');

  if (!toast || !msgEl) return;

  msgEl.textContent = message;
  toast.className = isError ? 'toast-container error' : 'toast-container';
  
  if (retryBtn) {
    if (showRetry) retryBtn.classList.remove('hidden');
    else retryBtn.classList.add('hidden');
  }

  toast.classList.remove('hidden');
  if (!isError) setTimeout(hideToast, 4000);
}

function hideToast() {
  document.getElementById('toast-container')?.classList.add('hidden');
}

// --- CLOUD SYNC: PULL (7 SHEETS) ---
async function pullFromCloud() {
  const endpointCheck = getCloudEndpointStatus();
  if (!endpointCheck.ok) {
    showToast(`[${endpointCheck.category}] ${endpointCheck.message}`, true, false);
    return;
  }

  const btn = document.getElementById('btn-pull-cloud');
  const origText = btn ? btn.textContent : '';
  if (btn) {
    btn.textContent = '⏳ Fetching 7 Sheets...';
    btn.disabled = true;
  }

  try {
    const fetchUrl = `${HARDCODED_CLOUD_URL}?password=${encodeURIComponent(CLOUD_SAVE_PASSWORD)}`;
    const response = await fetch(fetchUrl);

    if (!response.ok) {
      throw new Error(`HTTP Error ${response.status}`);
    }

    const data = await response.json();

    if (data && data.error === 'UNAUTHORIZED') {
      showToast('Unauthorized access. Verify password.', true, false);
      return;
    }

    if (!Array.isArray(data)) {
      showToast('Invalid data structure returned by Google Sheet.', true, false);
      return;
    }

    if (data.length === 0) {
      showToast('Google Sheet contains 0 cards.', false, false);
      return;
    }

    const confirmed = confirm(`Found ${data.length} total topics across your 7 sheets.\n\nOverwrite local app storage with this data?`);
    if (!confirmed) return;

    const today = getTodayString();

    topics = data.map((t, idx) => {
      const pNorm = normalizePaper(t.paper);
      return {
        id: t.id || ('T-' + Date.now() + '-' + idx),
        cardId: t.cardId || `${pNorm}-${String(idx + 1).padStart(3, '0')}`,
        title: t.title,
        paper: t.paper || pNorm,
        subject: t.subject || '',
        stage: parseInt(t.stage, 10) || 1,
        addedDate: t.addedDate || today,
        lastReviewed: t.lastReviewed || today,
        nextDue: t.nextDue || (parseInt(t.stage, 10) === 5 ? null : addDays(today, 1)),
        failCount: parseInt(t.failCount, 10) || 0
      };
    });

    localStorage.setItem(DB_KEY, JSON.stringify(topics));
    localStorage.setItem(SYNCED_SNAPSHOT_KEY, JSON.stringify(topics));
    hasUnsavedCloudChanges = false;
    localStorage.removeItem(UNSAVED_FLAG_KEY);

    updateSyncStatusUI();
    renderAll();
    switchTab('today');
    showToast(`✓ Restored ${topics.length} topics from 7 sheets`);

  } catch (err) {
    console.error('Pull failed:', err);
    showToast(`[PULL FAILED] ${err.message || err.toString()}`, true, false);
  } finally {
    if (btn) {
      btn.textContent = origText;
      btn.disabled = false;
    }
  }
}

async function autoSyncFromCloud() {
  const endpointCheck = getCloudEndpointStatus();
  if (!endpointCheck.ok) return;

  try {
    const fetchUrl = `${HARDCODED_CLOUD_URL}?password=${encodeURIComponent(CLOUD_SAVE_PASSWORD)}`;
    const res = await fetch(fetchUrl);
    if (!res.ok) return;

    const data = await res.json();
    if (Array.isArray(data) && data.length > 0) {
      const today = getTodayString();
      topics = data.map((t, idx) => {
        const pNorm = normalizePaper(t.paper);
        return {
          id: t.id || ('T-' + Date.now() + '-' + idx),
          cardId: t.cardId || `${pNorm}-${String(idx + 1).padStart(3, '0')}`,
          title: t.title,
          paper: t.paper || pNorm,
          subject: t.subject || '',
          stage: parseInt(t.stage, 10) || 1,
          addedDate: t.addedDate || today,
          lastReviewed: t.lastReviewed || today,
          nextDue: t.nextDue || (parseInt(t.stage, 10) === 5 ? null : addDays(today, 1)),
          failCount: parseInt(t.failCount, 10) || 0
        };
      });

      localStorage.setItem(DB_KEY, JSON.stringify(topics));
      localStorage.setItem(SYNCED_SNAPSHOT_KEY, JSON.stringify(topics));
      hasUnsavedCloudChanges = false;
      localStorage.removeItem(UNSAVED_FLAG_KEY);

      updateSyncStatusUI();
      renderAll();
      showToast(`✓ Auto-synced ${topics.length} cards across 7 sheets`);
    }
  } catch (e) {
    console.warn('Auto-sync skipped:', e);
  }
}

// --- CLOUD SYNC: PUSH (7 SHEETS) ---
async function verifyAndSaveToCloud(isRetry = false) {
  if (isSyncInProgress) {
    showToast('A sync is already running in background...');
    return;
  }

  let enteredPass = '';
  const passInput = document.getElementById('save-password-input');

  if (!isRetry) {
    enteredPass = passInput?.value.trim() || '';
    if (enteredPass !== CLOUD_SAVE_PASSWORD) {
      const errorEl = document.getElementById('password-error-msg');
      if (errorEl) {
        errorEl.textContent = 'USER AUTH ERROR: Incorrect password.';
        errorEl.classList.remove('hidden');
      }
      passInput?.focus();
      return;
    }
  } else {
    enteredPass = CLOUD_SAVE_PASSWORD;
  }

  const endpointCheck = getCloudEndpointStatus();
  if (!endpointCheck.ok) {
    closePasswordModal();
    showToast(`[${endpointCheck.category}] ${endpointCheck.message}`, true, false);
    return;
  }

  if (!topics || topics.length === 0) {
    closePasswordModal();
    showToast('[SAFEGUARD] Local list is empty. Push blocked.', true, false);
    return;
  }

  closePasswordModal();
  isSyncInProgress = true;
  hideToast();
  updateSyncStatusUI();

  const payloadSnapshot = JSON.stringify({
    password: enteredPass,
    data: topics
  });

  try {
    const response = await fetch(HARDCODED_CLOUD_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: payloadSnapshot
    });

    if (!response.ok) {
      throw { category: 'GOOGLE SERVER ERROR', message: `HTTP ${response.status}` };
    }

    const responseText = await response.text();
    let result;
    try {
      result = JSON.parse(responseText);
    } catch (parseErr) {
      if (responseText.includes('accounts.google.com') || responseText.includes('ServiceLogin')) {
        throw { category: 'PERMISSIONS ERROR', message: 'Set Web App access to "Anyone".' };
      }
      throw { category: 'ENDPOINT ERROR', message: `Invalid server output: ${responseText.slice(0, 60)}` };
    }

    if (!result.success) {
      throw { category: 'SHEET ERROR', message: result.error || 'Server rejected save.' };
    }

    localStorage.setItem(SYNCED_SNAPSHOT_KEY, JSON.stringify(topics));
    hasUnsavedCloudChanges = false;
    localStorage.removeItem(UNSAVED_FLAG_KEY);
    showToast(`✓ Saved: ${result.count} cards committed across 7 sheets`);

  } catch (err) {
    console.error('Save failed:', err);
    hasUnsavedCloudChanges = true;
    localStorage.setItem(UNSAVED_FLAG_KEY, 'true');

    let category = err.category || 'NETWORK ERROR';
    let message = err.message || err.toString();

    if (message.includes('Failed to fetch') || message.includes('NetworkError')) {
      category = navigator.onLine ? 'URL ERROR' : 'DEVICE OFFLINE';
      message = navigator.onLine ? 'Could not reach Google Apps Script.' : 'No active internet connection.';
    }

    showToast(`[${category}] ${message}`, true, true);
  } finally {
    isSyncInProgress = false;
    updateSyncStatusUI();
  }
}

function discardLocalChanges() {
  if (!hasUnsavedCloudChanges) return;
  if (!confirm('Discard all local changes?\n\nReverts to last saved snapshot.')) return;

  const lastSnapshot = localStorage.getItem(SYNCED_SNAPSHOT_KEY);
  if (lastSnapshot) {
    topics = JSON.parse(lastSnapshot);
    localStorage.setItem(DB_KEY, JSON.stringify(topics));
  }
  hasUnsavedCloudChanges = false;
  localStorage.removeItem(UNSAVED_FLAG_KEY);
  updateSyncStatusUI();
  renderAll();
  showToast('Reverted to last saved snapshot');
}

// --- ADD TOPIC (DAY 0 LOGGED, DAY 1 TOMORROW) ---
function addNewTopic() {
  const title = document.getElementById('add-topic-title').value.trim();
  const paper = document.getElementById('add-topic-paper').value;
  const subject = document.getElementById('add-topic-subject').value || '';
  let cardId = document.getElementById('add-card-id').value.trim();

  if (!title) return;

  const today = getTodayString();
  if (!cardId) {
    cardId = generateNextCardId(paper);
  }

  const newEntry = {
    id: (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : ('T-' + Date.now()),
    cardId: cardId,
    title: title,
    paper: paper,
    subject: subject,
    stage: 1,
    addedDate: today,
    lastReviewed: today,
    nextDue: addDays(today, 1),
    failCount: 0
  };

  topics.unshift(newEntry);
  saveData();

  document.getElementById('add-topic-title').value = '';
  document.getElementById('add-card-id').value = '';
  closeAddModal();
  showToast(`Added [${cardId}] • Day 1 due tomorrow`);
}

function handlePass(id) {
  const topic = topics.find(t => t.id === id);
  if (!topic) return;

  const today = getTodayString();
  topic.lastReviewed = today;

  if (topic.stage < 4) {
    const nextInterval = FORWARD_INTERVALS[topic.stage] || 1;
    topic.stage += 1;
    topic.nextDue = addDays(today, nextInterval);
  } else {
    topic.stage = 5;
    topic.nextDue = null;
  }
  saveData();
}

function shiftPendingPlusOneDay() {
  const today = getTodayString();
  const pending = topics.filter(t => t.stage < 5 && t.nextDue && t.nextDue <= today);

  if (pending.length === 0) {
    alert("No pending topics in today's queue to shift.");
    return;
  }

  if (!confirm(`Postpone all ${pending.length} pending topics by +1 day?`)) return;

  const tomorrow = addDays(today, 1);
  pending.forEach(t => t.nextDue = tomorrow);

  saveData();
  showToast(`Postponed ${pending.length} topics by +1 day`);
}

// --- STAGE FILTERING FOR TODAY'S QUEUE ---
function toggleStageFilter(stageNum) {
  if (currentStageFilter === stageNum) {
    currentStageFilter = 'ALL';
  } else {
    currentStageFilter = stageNum;
  }
  updateStageFilterUI();
  renderTodayQueue();
}

function setStageFilter(stageVal) {
  currentStageFilter = stageVal;
  updateStageFilterUI();
  renderTodayQueue();
}

function updateStageFilterUI() {
  // Update Stat Cards active style
  [1, 2, 3, 4].forEach(st => {
    const cardEl = document.getElementById(`card-stat-d${st === 1 ? '1' : st === 2 ? '3' : st === 3 ? '7' : '30'}`);
    if (cardEl) {
      if (currentStageFilter === st) cardEl.classList.add('active-filter');
      else cardEl.classList.remove('active-filter');
    }
  });

  // Update Pill Buttons
  document.querySelectorAll('.stage-filter-bar .filter-chip').forEach(chip => chip.classList.remove('active'));
  if (currentStageFilter === 'ALL') {
    document.getElementById('chip-stage-all')?.classList.add('active');
  } else {
    document.getElementById(`chip-stage-${currentStageFilter}`)?.classList.add('active');
  }
}

// --- CATEGORY SUMS CALCULATION (REQ 4) ---
function updateCategorySums() {
  let gs123 = 0;
  let ethics = 0;
  let essay = 0;
  let optional = 0;
  let prelims = 0;

  topics.forEach(t => {
    const p = normalizePaper(t.paper);
    if (p === 'GS-1' || p === 'GS-2' || p === 'GS-3') gs123++;
    else if (p === 'GS-4') ethics++;
    else if (p === 'Essay') essay++;
    else if (p === 'Optional') optional++;
    else if (p === 'Prelims') prelims++;
  });

  document.getElementById('cat-sum-gs123').textContent = gs123;
  document.getElementById('cat-sum-ethics').textContent = ethics;
  document.getElementById('cat-sum-essay').textContent = essay;
  document.getElementById('cat-sum-optional').textContent = optional;
  document.getElementById('cat-sum-prelims').textContent = prelims;
  document.getElementById('cat-sum-total').textContent = topics.length;
}

function filterPipelineByCategory(cat) {
  const searchInput = document.getElementById('search-input');
  if (cat === 'ALL') {
    searchInput.value = '';
  } else if (cat === 'GS123') {
    searchInput.value = 'GS-';
  } else {
    searchInput.value = cat;
  }
  renderPipeline();
}

// --- TIMED REVISION SESSION ENGINE (REQ 5) ---
function getFilteredDueTopics() {
  const today = getTodayString();
  let due = topics.filter(t => t.stage < 5 && t.nextDue && t.nextDue <= today);

  if (currentPaperFilter !== 'ALL') {
    due = due.filter(t => normalizePaper(t.paper) === currentPaperFilter);
  }
  if (currentStageFilter !== 'ALL') {
    due = due.filter(t => t.stage === currentStageFilter);
  }
  return due.sort((a, b) => (a.nextDue > b.nextDue ? 1 : -1));
}

function startRevisionSession() {
  const due = getFilteredDueTopics();
  if (due.length === 0) {
    alert('No cards currently match the active filter.');
    return;
  }

  sessionState.active = true;
  sessionState.cards = JSON.parse(JSON.stringify(due));
  sessionState.currentIndex = 0;
  sessionState.totalElapsedSeconds = 0;
  sessionState.timeSpentMap = {};
  sessionState.gradesMap = {};
  sessionState.isPaused = false;

  // Initialize grade state as 'pass' by default
  sessionState.cards.forEach(c => {
    sessionState.timeSpentMap[c.id] = 0;
    sessionState.gradesMap[c.id] = 'pass';
  });

  document.getElementById('main-navigation').classList.add('hidden');
  document.getElementById('view-today').classList.add('hidden');
  document.getElementById('view-pipeline').classList.add('hidden');
  document.getElementById('view-settings').classList.add('hidden');
  document.getElementById('view-revision-analysis').classList.add('hidden');
  document.getElementById('view-revision-session').classList.remove('hidden');

  loadSessionCard(0);
  startSessionTimer();
}

function loadSessionCard(index) {
  if (index < 0 || index >= sessionState.cards.length) return;

  sessionState.currentIndex = index;
  sessionState.secondsRemaining = sessionState.defaultCardDuration;

  const card = sessionState.cards[index];
  document.getElementById('session-current-idx').textContent = index + 1;
  document.getElementById('session-total-idx').textContent = sessionState.cards.length;

  const fillPct = Math.round(((index + 1) / sessionState.cards.length) * 100);
  document.getElementById('session-progress-fill').style.width = `${fillPct}%`;

  document.getElementById('session-card-id').textContent = card.cardId || 'NO-ID';
  document.getElementById('session-paper-badge').textContent = card.paper;

  const subBadge = document.getElementById('session-subject-badge');
  if (card.subject) {
    subBadge.textContent = card.subject;
    subBadge.classList.remove('hidden');
  } else {
    subBadge.classList.add('hidden');
  }

  document.getElementById('session-stage-badge').textContent = STAGE_CONFIG[card.stage].label;
  document.getElementById('session-card-title').textContent = card.title;

  document.getElementById('btn-session-prev').disabled = (index === 0);
  document.getElementById('btn-session-next').textContent = 
    (index === sessionState.cards.length - 1) ? 'Finish & Analyze ➔' : 'Next Card ⏭';

  updateTimerDisplay();
}

function startSessionTimer() {
  if (sessionState.timerInterval) clearInterval(sessionState.timerInterval);

  sessionState.timerInterval = setInterval(() => {
    if (sessionState.isPaused) return;

    sessionState.secondsRemaining--;
    sessionState.totalElapsedSeconds++;

    const currCard = sessionState.cards[sessionState.currentIndex];
    if (currCard) {
      sessionState.timeSpentMap[currCard.id] = (sessionState.timeSpentMap[currCard.id] || 0) + 1;
    }

    updateTimerDisplay();

    // End of 3 minutes for current card
    if (sessionState.secondsRemaining <= 0) {
      playSessionAlert();
      if (sessionState.currentIndex < sessionState.cards.length - 1) {
        goToNextSessionCard();
      } else {
        finishSessionAndAnalyze();
      }
    }
  }, 1000);
}

function updateTimerDisplay() {
  const m = Math.floor(sessionState.secondsRemaining / 60);
  const s = sessionState.secondsRemaining % 60;
  const digitsEl = document.getElementById('timer-digits');
  digitsEl.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;

  if (sessionState.secondsRemaining <= 30) {
    digitsEl.classList.add('warning');
  } else {
    digitsEl.classList.remove('warning');
  }

  // Elapsed total
  const em = Math.floor(sessionState.totalElapsedSeconds / 60);
  const es = sessionState.totalElapsedSeconds % 60;
  document.getElementById('session-elapsed-timer').textContent = 
    `${String(em).padStart(2, '0')}:${String(es).padStart(2, '0')}`;
}

function togglePauseSession() {
  sessionState.isPaused = !sessionState.isPaused;
  const btn = document.getElementById('btn-timer-pause');
  const label = document.getElementById('timer-state-label');

  if (sessionState.isPaused) {
    btn.textContent = '▶ Resume';
    label.textContent = 'TIMER PAUSED';
  } else {
    btn.textContent = '⏸ Pause';
    label.textContent = 'REVISION DRILL ACTIVE';
  }
}

function adjustSessionTime(deltaSec) {
  sessionState.secondsRemaining = Math.max(5, sessionState.secondsRemaining + deltaSec);
  updateTimerDisplay();
}

function goToPrevSessionCard() {
  if (sessionState.currentIndex > 0) {
    loadSessionCard(sessionState.currentIndex - 1);
  }
}

function goToNextSessionCard() {
  if (sessionState.currentIndex < sessionState.cards.length - 1) {
    loadSessionCard(sessionState.currentIndex + 1);
  } else {
    finishSessionAndAnalyze();
  }
}

function abortRevisionSession() {
  if (!confirm('Exit revision session early? Progress will not be recorded.')) return;
  clearInterval(sessionState.timerInterval);
  sessionState.active = false;
  document.getElementById('view-revision-session').classList.add('hidden');
  document.getElementById('main-navigation').classList.remove('hidden');
  document.getElementById('view-today').classList.remove('hidden');
  renderTodayQueue();
}

// --- ANALYSIS & GRADING SCREEN (POST REVISION) ---
function finishSessionAndAnalyze() {
  clearInterval(sessionState.timerInterval);

  document.getElementById('view-revision-session').classList.add('hidden');
  document.getElementById('view-revision-analysis').classList.remove('hidden');

  const totalMin = Math.floor(sessionState.totalElapsedSeconds / 60);
  const totalSec = sessionState.totalElapsedSeconds % 60;
  document.getElementById('analysis-summary-subtitle').textContent = 
    `${sessionState.cards.length} Topics Reviewed in ${totalMin}m ${String(totalSec).padStart(2, '0')}s`;

  renderAnalysisList();
}

function renderAnalysisList() {
  const container = document.getElementById('analysis-cards-list');
  container.innerHTML = sessionState.cards.map((c) => {
    const spentSec = sessionState.timeSpentMap[c.id] || 0;
    const sm = Math.floor(spentSec / 60);
    const ss = spentSec % 60;
    const grade = sessionState.gradesMap[c.id] || 'pass';

    return `
      <div class="analysis-item-card">
        <div class="analysis-item-top">
          <div>
            <span class="card-id-tag">${escapeHtml(c.cardId)}</span>
            <strong style="margin-left:6px; font-size:0.95rem;">${escapeHtml(c.title)}</strong>
          </div>
          <span style="font-family:monospace; font-size:0.8rem; color:var(--accent);">
            ⏱️ ${String(sm).padStart(2, '0')}:${String(ss).padStart(2, '0')}
          </span>
        </div>
        <div style="font-size:0.75rem; color:var(--text-muted); margin-bottom:8px;">
          ${escapeHtml(c.paper)} ${c.subject ? '• ' + escapeHtml(c.subject) : ''} • Current: ${STAGE_CONFIG[c.stage].short}
        </div>
        <div class="analysis-grade-row">
          <button class="btn-grade ${grade === 'pass' ? 'passed' : ''}" onclick="setCardSessionGrade('${c.id}', 'pass')">
            ✓ Pass (Advance)
          </button>
          <button class="btn-grade ${grade === 'fail' ? 'failed' : ''}" onclick="setCardSessionGrade('${c.id}', 'fail')">
            ✕ Fail (Demote)
          </button>
        </div>
      </div>
    `;
  }).join('');
}

function setCardSessionGrade(cardId, grade) {
  sessionState.gradesMap[cardId] = grade;
  renderAnalysisList();
}

function markAllSessionGrading(grade) {
  sessionState.cards.forEach(c => {
    sessionState.gradesMap[c.id] = grade;
  });
  renderAnalysisList();
}

function commitSessionGrading() {
  const today = getTodayString();
  let passedCount = 0;
  let failedCount = 0;

  sessionState.cards.forEach(c => {
    const topic = topics.find(t => t.id === c.id);
    if (!topic) return;

    const grade = sessionState.gradesMap[c.id] || 'pass';
    topic.lastReviewed = today;

    if (grade === 'pass') {
      passedCount++;
      if (topic.stage < 4) {
        const interval = FORWARD_INTERVALS[topic.stage] || 1;
        topic.stage += 1;
        topic.nextDue = addDays(today, interval);
      } else {
        topic.stage = 5;
        topic.nextDue = null;
      }
    } else {
      failedCount++;
      topic.failCount = (topic.failCount || 0) + 1;
      topic.stage = (topic.stage >= 3) ? 2 : 1;
      topic.nextDue = addDays(today, topic.stage === 2 ? 3 : 1);
    }
  });

  saveData();

  sessionState.active = false;
  document.getElementById('view-revision-analysis').classList.add('hidden');
  document.getElementById('main-navigation').classList.remove('hidden');
  document.getElementById('view-today').classList.remove('hidden');

  showToast(`✓ Session saved: ${passedCount} Passed, ${failedCount} Demoted`);
}

// --- MODAL CONTROLS ---
function openAddModal() {
  document.body.style.overflow = 'hidden';
  onPaperChange('add');
  document.getElementById('add-modal').classList.add('open');
}
function closeAddModal() {
  document.activeElement?.blur();
  document.getElementById('add-modal').classList.remove('open');
  document.body.style.overflow = '';
}

function openEditModal(id) {
  const topic = topics.find(t => t.id === id);
  if (!topic) return;

  activeEditingTopicId = id;
  document.getElementById('edit-card-id').value = topic.cardId || '';
  document.getElementById('edit-topic-title').value = topic.title || '';
  document.getElementById('edit-topic-paper').value = topic.paper || 'GS-1';

  onPaperChange('edit');
  document.getElementById('edit-topic-subject').value = topic.subject || '';
  document.getElementById('edit-topic-stage').value = topic.stage || 1;

  const dueInput = document.getElementById('edit-topic-due');
  const dueGroup = document.getElementById('edit-due-date-group');

  if (topic.stage === 5) {
    dueGroup.style.display = 'none';
    dueInput.value = '';
  } else {
    dueGroup.style.display = 'block';
    dueInput.value = topic.nextDue || addDays(getTodayString(), 1);
  }

  document.body.style.overflow = 'hidden';
  document.getElementById('edit-modal').classList.add('open');
}

function onEditStageChange() {
  const stage = parseInt(document.getElementById('edit-topic-stage').value, 10);
  const dueGroup = document.getElementById('edit-due-date-group');
  const dueInput = document.getElementById('edit-topic-due');
  const today = getTodayString();

  if (stage === 5) {
    dueGroup.style.display = 'none';
    dueInput.value = '';
  } else {
    dueGroup.style.display = 'block';
    if (stage === 1) dueInput.value = addDays(today, 1);
    else if (stage === 2) dueInput.value = addDays(today, 3);
    else if (stage === 3) dueInput.value = addDays(today, 7);
    else if (stage === 4) dueInput.value = addDays(today, 30);
  }
}

function closeEditModal() {
  document.activeElement?.blur();
  document.getElementById('edit-modal').classList.remove('open');
  document.body.style.overflow = '';
  activeEditingTopicId = null;
}

function saveTopicEdits() {
  if (!activeEditingTopicId) return;
  const topic = topics.find(t => t.id === activeEditingTopicId);
  if (!topic) return;

  const newTitle = document.getElementById('edit-topic-title').value.trim();
  const newCardId = document.getElementById('edit-card-id').value.trim();
  const newPaper = document.getElementById('edit-topic-paper').value;
  const newSubject = document.getElementById('edit-topic-subject').value;
  const newStage = parseInt(document.getElementById('edit-topic-stage').value, 10);
  const newDue = document.getElementById('edit-topic-due').value;

  if (!newTitle) return;

  topic.title = newTitle;
  topic.cardId = newCardId || topic.cardId;
  topic.paper = newPaper;
  topic.subject = newSubject;
  topic.stage = newStage;
  topic.nextDue = (newStage === 5) ? null : (newDue || addDays(getTodayString(), 1));

  closeEditModal();
  saveData();
}

function deleteCurrentTopic() {
  if (!activeEditingTopicId) return;
  if (!confirm('Are you sure you want to delete this topic?')) return;

  topics = topics.filter(t => t.id !== activeEditingTopicId);
  closeEditModal();
  saveData();
}

function openDemoteModal(id) {
  const topic = topics.find(t => t.id === id);
  if (!topic) return;

  activeDemotingTopicId = id;
  document.getElementById('demote-topic-title').textContent = `[${topic.cardId}] ${topic.title}`;
  selectDemoteStage(topic.stage >= 3 ? 2 : 1);

  document.body.style.overflow = 'hidden';
  document.getElementById('demote-modal').classList.add('open');
}

function closeDemoteModal() {
  document.activeElement?.blur();
  document.getElementById('demote-modal').classList.remove('open');
  document.body.style.overflow = '';
  activeDemotingTopicId = null;
}

function selectDemoteStage(stageNum) {
  selectedDemoteStage = stageNum;
  document.querySelectorAll('.bucket-btn').forEach(b => b.classList.remove('active'));
  document.getElementById(`bucket-btn-${stageNum}`)?.classList.add('active');

  const defaultDays = (stageNum === 1) ? 1 : (stageNum === 2 ? 3 : 7);
  document.getElementById('demote-interval-input').value = defaultDays;
  updateDemoteDatePreview();
}

function updateDemoteDatePreview() {
  const days = parseInt(document.getElementById('demote-interval-input').value, 10) || 1;
  const nextDate = addDays(getTodayString(), days);
  document.getElementById('demote-preview-date').textContent = `${nextDate} (+${days}d)`;
}

function confirmDemotion() {
  if (!activeDemotingTopicId) return;
  const topic = topics.find(t => t.id === activeDemotingTopicId);
  if (!topic) return;

  const days = parseInt(document.getElementById('demote-interval-input').value, 10) || 1;
  const today = getTodayString();

  topic.stage = selectedDemoteStage;
  topic.lastReviewed = today;
  topic.nextDue = addDays(today, days);
  topic.failCount = (topic.failCount || 0) + 1;

  closeDemoteModal();
  saveData();
}

function openTomorrowModal() {
  const today = getTodayString();
  const tomorrow = addDays(today, 1);
  const tomorrowTopics = topics.filter(t => t.stage < 5 && t.nextDue === tomorrow);

  document.getElementById('tomorrow-modal-subtitle').textContent = 
    `Scheduled for ${tomorrow} • Total: ${tomorrowTopics.length} topics`;

  const container = document.getElementById('tomorrow-list');
  if (tomorrowTopics.length === 0) {
    container.innerHTML = `<div class="empty-state" style="padding:20px;"><p>No revisions tomorrow.</p></div>`;
  } else {
    tomorrowTopics.sort((a, b) => a.stage - b.stage);
    container.innerHTML = tomorrowTopics.map(t => `
      <div class="forecast-item">
        <div>
          <span class="card-id-tag">${escapeHtml(t.cardId)}</span>
          <strong style="margin-left:6px; font-size:0.9rem;">${escapeHtml(t.title)}</strong>
          <div style="font-size:0.72rem; color:var(--text-muted); margin-top:2px;">
            ${escapeHtml(t.paper)} ${t.subject ? '• ' + escapeHtml(t.subject) : ''}
          </div>
        </div>
        <span class="badge ${STAGE_CONFIG[t.stage].class}">${STAGE_CONFIG[t.stage].short}</span>
      </div>
    `).join('');
  }

  document.body.style.overflow = 'hidden';
  document.getElementById('tomorrow-modal').classList.add('open');
}

function closeTomorrowModal() {
  document.activeElement?.blur();
  document.getElementById('tomorrow-modal').classList.remove('open');
  document.body.style.overflow = '';
}

function openPasswordModal() {
  const modal = document.getElementById('password-modal');
  const passInput = document.getElementById('save-password-input');
  const errorEl = document.getElementById('password-error-msg');

  if (errorEl) errorEl.classList.add('hidden');
  if (passInput) passInput.value = '';

  document.body.style.overflow = 'hidden';
  modal.classList.add('open');
  setTimeout(() => passInput?.focus(), 120);
}

function closePasswordModal() {
  document.activeElement?.blur();
  document.getElementById('password-modal').classList.remove('open');
  document.body.style.overflow = '';
}

function closeModalOnBg(e, modalId) {
  if (e.target.id === modalId) {
    document.activeElement?.blur();
    document.getElementById(modalId).classList.remove('open');
    document.body.style.overflow = '';
  }
}

// --- RENDERING VIEWS ---
function renderAll() {
  renderPaperFilterBar();
  updateStageFilterUI();
  renderTodayQueue();
  renderPipeline();
  updateCounts();
  updateCategorySums();
}

function setPaperFilter(paper) {
  currentPaperFilter = paper;
  renderPaperFilterBar();
  renderTodayQueue();
}

function renderPaperFilterBar() {
  const container = document.getElementById('paper-filter-container');
  const today = getTodayString();
  const dueTopics = topics.filter(t => t.stage < 5 && t.nextDue && t.nextDue <= today);

  const counts = { ALL: dueTopics.length };
  PAPERS_LIST.slice(1).forEach(p => counts[p] = 0);

  dueTopics.forEach(t => {
    const norm = normalizePaper(t.paper);
    if (counts[norm] !== undefined) counts[norm]++;
  });

  container.innerHTML = PAPERS_LIST.map(p => `
    <button class="filter-chip ${currentPaperFilter === p ? 'active' : ''}" onclick="setPaperFilter('${p}')">
      ${p} <span class="chip-count">${counts[p] || 0}</span>
    </button>
  `).join('');
}

function updateCounts() {
  const today = getTodayString();
  const tomorrow = addDays(today, 1);
  const dueTopics = topics.filter(t => t.stage < 5 && t.nextDue && t.nextDue <= today);

  document.getElementById('due-count').textContent = dueTopics.length;
  document.getElementById('total-count').textContent = topics.length;

  let counts = { 1: 0, 2: 0, 3: 0, 4: 0 };
  dueTopics.forEach(t => { if (counts[t.stage] !== undefined) counts[t.stage]++; });

  document.getElementById('stat-d1').textContent = counts[1];
  document.getElementById('stat-d3').textContent = counts[2];
  document.getElementById('stat-d7').textContent = counts[3];
  document.getElementById('stat-d30').textContent = counts[4];

  const tomorrowCount = topics.filter(t => t.stage < 5 && t.nextDue === tomorrow).length;
  document.getElementById('stat-tomorrow').textContent = tomorrowCount;
}

function renderTodayQueue() {
  const container = document.getElementById('due-list');
  const today = getTodayString();
  const due = getFilteredDueTopics();

  // Update session start card count
  const sessionCountEl = document.getElementById('session-card-count');
  const sessionBtn = document.getElementById('btn-start-session');
  if (sessionCountEl) sessionCountEl.textContent = due.length;
  if (sessionBtn) sessionBtn.disabled = (due.length === 0);

  if (due.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <h3>Queue Cleared</h3>
        <p>No pending cards matching current filter.</p>
      </div>
    `;
    return;
  }

  container.innerHTML = due.map(t => {
    const overdueDays = getDaysDiff(t.nextDue, today);
    const overdueBadge = overdueDays > 0 ? `<span class="badge badge-overdue">${overdueDays}d overdue</span>` : '';
    const leechBadge = t.failCount >= 3 ? `<span class="badge badge-leech">⚠️ Leech (${t.failCount})</span>` : '';
    const subjectBadge = t.subject ? `<span class="badge badge-subject">${escapeHtml(t.subject)}</span>` : '';

    return `
      <div class="topic-card">
        <div class="card-top">
          <div class="topic-header-area">
            <span class="card-id-tag">${escapeHtml(t.cardId || 'NO-ID')}</span>
            <div class="topic-name">${escapeHtml(t.title)}</div>
          </div>
          <div class="badge-group">
            ${leechBadge}
            ${overdueBadge}
            ${subjectBadge}
            <span class="badge ${STAGE_CONFIG[t.stage].class}">${STAGE_CONFIG[t.stage].label}</span>
          </div>
        </div>
        <div class="meta-line">
          <span>${escapeHtml(t.paper)} • Due: ${t.nextDue}</span>
          <span class="edit-trigger" onclick="openEditModal('${t.id}')">Edit / Transfer</span>
        </div>
        <div class="actions">
          <button class="btn btn-fail" onclick="openDemoteModal('${t.id}')">✕ Demote / Fail</button>
          <button class="btn btn-pass" onclick="handlePass('${t.id}')">✓ Passed (Advance)</button>
        </div>
      </div>
    `;
  }).join('');
}

function renderPipeline() {
  const container = document.getElementById('pipeline-list');
  const search = (document.getElementById('search-input').value || '').toLowerCase();

  const filtered = topics.filter(t => 
    t.title.toLowerCase().includes(search) || 
    t.paper.toLowerCase().includes(search) ||
    (t.subject && t.subject.toLowerCase().includes(search)) ||
    (t.cardId && t.cardId.toLowerCase().includes(search))
  );

  if (filtered.length === 0) {
    container.innerHTML = `<div class="empty-state"><p>No topics matching criteria.</p></div>`;
    return;
  }

  container.innerHTML = filtered.map(t => {
    const leechBadge = t.failCount >= 3 ? `<span class="badge badge-leech">⚠️ Leech (${t.failCount})</span>` : '';
    const subjectBadge = t.subject ? `<span class="badge badge-subject">${escapeHtml(t.subject)}</span>` : '';

    return `
      <div class="topic-card">
        <div class="card-top">
          <div class="topic-header-area">
            <span class="card-id-tag">${escapeHtml(t.cardId || 'NO-ID')}</span>
            <div class="topic-name">${escapeHtml(t.title)}</div>
          </div>
          <div class="badge-group">
            ${leechBadge}
            ${subjectBadge}
            <span class="badge ${STAGE_CONFIG[t.stage].class}">${STAGE_CONFIG[t.stage].label}</span>
          </div>
        </div>
        <div class="meta-line">
          <span>${escapeHtml(t.paper)} • Added: ${t.addedDate} • ${t.stage === 5 ? 'Mastered' : `Due: ${t.nextDue}`}</span>
          <span class="edit-trigger" onclick="openEditModal('${t.id}')">Edit</span>
        </div>
      </div>
    `;
  }).join('');
}

function switchTab(tab) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('view-today').classList.add('hidden');
  document.getElementById('view-pipeline').classList.add('hidden');
  document.getElementById('view-settings').classList.add('hidden');
  document.getElementById('view-revision-session').classList.add('hidden');
  document.getElementById('view-revision-analysis').classList.add('hidden');
  document.getElementById('main-navigation').classList.remove('hidden');

  if (tab === 'today') {
    document.querySelector('.tab-btn:nth-child(1)').classList.add('active');
    document.getElementById('view-today').classList.remove('hidden');
  } else if (tab === 'pipeline') {
    document.querySelector('.tab-btn:nth-child(2)').classList.add('active');
    document.getElementById('view-pipeline').classList.remove('hidden');
  } else {
    document.querySelector('.tab-btn:nth-child(3)').classList.add('active');
    document.getElementById('view-settings').classList.remove('hidden');
  }
}

function escapeHtml(str) {
  return (str || '').replace(/[&<>'"]/g, tag => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  }[tag] || tag));
}

function exportDataJSON() {
  const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(topics, null, 2));
  const anchor = document.createElement('a');
  anchor.setAttribute("href", dataStr);
  anchor.setAttribute("download", `mains_pipeline_backup_${getTodayString()}.json`);
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

function importDataJSON(event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = function(e) {
    try {
      const parsed = JSON.parse(e.target.result);
      if (Array.isArray(parsed)) {
        const today = getTodayString();
        const existingIds = new Set(topics.map(t => t.id));
        let addedCount = 0;

        parsed.forEach((item) => {
          const id = item.id || ('T-' + Date.now() + '-' + Math.random().toString(36).substr(2, 5));
          if (!existingIds.has(id)) {
            const stage = item.stage !== undefined ? item.stage : 1;
            topics.push({
              id: id,
              cardId: item.cardId || generateNextCardId(item.paper || 'Prelims'),
              title: item.title || item.topic || 'Untitled Topic',
              paper: item.paper || 'Prelims',
              subject: item.subject || '',
              stage: stage,
              addedDate: item.addedDate || today,
              lastReviewed: item.lastReviewed || today,
              nextDue: item.nextDue || addDays(today, 1),
              failCount: item.failCount || 0
            });
            existingIds.add(id);
            addedCount++;
          }
        });

        saveData();
        showToast(`Imported ${addedCount} topics`);
      }
    } catch (err) {
      alert('Invalid JSON file.');
    }
  };
  reader.readAsText(file);
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').then(reg => {
      reg.onupdatefound = () => {
        const installingWorker = reg.installing;
        installingWorker.onstatechange = () => {
          if (installingWorker.state === 'installed' && navigator.serviceWorker.controller) {
            window.location.reload();
          }
        };
      };
    });
  });
}