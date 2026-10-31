// --- CONFIGURATION CONSTANTS ---
const CLOUD_SAVE_PASSWORD = 'sdrgb';

// Replace with your actual deployed Google Apps Script Web App URL ending in /exec:
   const HARDCODED_CLOUD_URL = 'https://script.google.com/macros/s/AKfycbxmPIx8jBMvjX0gtzpmbKfOWpYHixRpTiP87XU2M_hcySrn19e6FphErbzWCGHQL8z__g/exec';

const STAGE_CONFIG = {
  1: { label: 'Day 1 Review', short: 'Day 1', class: 'badge-d1' },
  2: { label: 'Day 3 Review', short: 'Day 3', class: 'badge-d3' },
  3: { label: 'Day 7 Review', short: 'Day 7', class: 'badge-d7' },
  4: { label: 'Day 30 Review', short: 'Day 30', class: 'badge-d30' },
  5: { label: 'Mastered', short: 'Mastered', class: 'badge-master' }
};

// Spaced Repetition forward intervals:
// Day 1 Review passed -> Day 3 (+2 days from Day 1)
// Day 3 Review passed -> Day 7 (+4 days from Day 3)
// Day 7 Review passed -> Day 30 (+23 days from Day 7)
const FORWARD_INTERVALS = {
  1: 2,
  2: 4,
  3: 23,
  4: 0
};

const PAPERS_LIST = ['ALL', 'GS-1', 'GS-2', 'GS-3', 'GS-4', 'Optional', 'Other'];

const DB_KEY = 'mains_topics_store_v1';
const UNSAVED_FLAG_KEY = 'mains_unsaved_cloud_flag_v1';
const SYNCED_SNAPSHOT_KEY = 'mains_topics_synced_snapshot_v1';

let topics = [];
let currentPaperFilter = 'ALL';
let activeDemotingTopicId = null;
let activeEditingTopicId = null;
let selectedDemoteStage = 1;
let hasUnsavedCloudChanges = false;
let isSyncInProgress = false;

// --- CLOUD ENDPOINT DIAGNOSTIC VALIDATOR ---
function getCloudEndpointStatus() {
  if (!HARDCODED_CLOUD_URL || HARDCODED_CLOUD_URL.trim() === '') {
    return {
      ok: false,
      category: 'APP CONFIG ERROR',
      message: 'Cloud Sheet URL is completely empty. Paste your Web App /exec URL into HARDCODED_CLOUD_URL in app.js.'
    };
  }

  if (HARDCODED_CLOUD_URL.includes('YOUR_DEPLOYMENT_ID') || HARDCODED_CLOUD_URL.includes('AKfycb...')) {
    return {
      ok: false,
      category: 'APP CONFIG ERROR',
      message: 'Cloud URL still contains placeholder text ("YOUR_DEPLOYMENT_ID"). Replace it with your actual deployment ID.'
    };
  }

  if (!HARDCODED_CLOUD_URL.startsWith('https://script.google.com/macros/s/')) {
    return {
      ok: false,
      category: 'APP CONFIG ERROR',
      message: 'Invalid URL scheme. Google Apps Script URLs must start with "https://script.google.com/macros/s/".'
    };
  }

  if (!HARDCODED_CLOUD_URL.endsWith('/exec')) {
    return {
      ok: false,
      category: 'APP CONFIG ERROR',
      message: 'URL must end with "/exec". If it ends in "/dev" or "/edit", redeploy as a Web App.'
    };
  }

  return { ok: true };
}

// --- DYNAMIC VISUAL VIEWPORT & KEYBOARD TRACKER ---
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
    document.getElementById('storage-status')?.setAttribute('title', isPersisted ? 'Persistent Engine' : 'Standard Local');
  }
  
  loadData();
  renderAll();

  // If local storage is empty, auto-pull data directly from Google Sheet on startup
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
  if (!paperStr) return 'Other';
  const clean = paperStr.trim().toUpperCase();
  if (clean.includes('GS1') || clean.includes('GS-1')) return 'GS-1';
  if (clean.includes('GS2') || clean.includes('GS-2')) return 'GS-2';
  if (clean.includes('GS3') || clean.includes('GS-3')) return 'GS-3';
  if (clean.includes('GS4') || clean.includes('GS-4')) return 'GS-4';
  if (clean.includes('OPTIONAL') || clean.includes('OPT')) return 'Optional';
  return 'Other';
}

// Collide-safe card generator: parses highest integer suffix across dataset
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

// --- TOAST NOTIFICATIONS ---
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

  if (!isError) {
    setTimeout(hideToast, 4000);
  }
}

function hideToast() {
  document.getElementById('toast-container')?.classList.add('hidden');
}

// Auto-syncs from cloud on startup when local storage is empty
async function autoSyncFromCloud() {
  const endpointCheck = getCloudEndpointStatus();
  if (!endpointCheck.ok) {
    if (HARDCODED_CLOUD_URL && HARDCODED_CLOUD_URL.trim() !== '') {
      showToast(`[Startup Sync] ${endpointCheck.message}`, true, false);
    }
    return;
  }

  const statusText = document.getElementById('sync-status-text');
  const dot = document.getElementById('sync-dot');
  
  if (statusText) statusText.textContent = 'Syncing from Sheet...';
  if (dot) dot.className = 'dot syncing';

  try {
    const fetchUrl = `${HARDCODED_CLOUD_URL}?password=${encodeURIComponent(CLOUD_SAVE_PASSWORD)}`;
    const res = await fetch(fetchUrl);
    
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const data = await res.json();

    if (Array.isArray(data) && data.length > 0) {
      const today = getTodayString();
      
      topics = data.map((t, idx) => {
        const pNorm = normalizePaper(t.paper);
        return {
          id: t.id || ('T-' + Date.now() + '-' + idx),
          cardId: t.cardId || `${pNorm}-${String(idx + 1).padStart(3, '0')}`,
          title: t.title,
          paper: t.paper || 'GS-1',
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
      showToast(`✓ Auto-synced ${topics.length} cards from Google Sheet`);
    } else {
      updateSyncStatusUI();
    }
  } catch (err) {
    console.warn('Auto-sync failed:', err);
    updateSyncStatusUI();
    if (navigator.onLine) {
      showToast('[Auto-Sync Failed] Unable to read from Sheet. Check your URL deployment.', true, false);
    }
  }
}

// Manual pull trigger from settings tab
async function pullFromCloud() {
  const endpointCheck = getCloudEndpointStatus();
  if (!endpointCheck.ok) {
    showToast(`[${endpointCheck.category}] ${endpointCheck.message}`, true, false);
    return;
  }

  const btn = document.getElementById('btn-pull-cloud');
  const origText = btn ? btn.textContent : '';
  if (btn) {
    btn.textContent = '⏳ Fetching from Sheet...';
    btn.disabled = true;
  }

  try {
    const fetchUrl = `${HARDCODED_CLOUD_URL}?password=${encodeURIComponent(CLOUD_SAVE_PASSWORD)}`;
    const response = await fetch(fetchUrl);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} (${response.statusText || 'Server Error'})`);
    }

    const data = await response.json();

    if (data && data.error === 'UNAUTHORIZED') {
      showToast('Unauthorized access. Verify CLOUD_SAVE_PASSWORD in app.js matches AUTH_KEY in Code.gs.', true, false);
      return;
    }

    if (!Array.isArray(data)) {
      showToast('Invalid data structure received from Google Sheet.', true, false);
      return;
    }

    if (data.length === 0) {
      showToast('The Google Sheet currently contains no topics.', false, false);
      return;
    }

    const confirmed = confirm(`Found ${data.length} topics in your Google Sheet.\n\nOverwrite local app storage with this data?`);
    if (!confirmed) return;

    const today = getTodayString();

    topics = data.map((t, idx) => {
      const pNorm = normalizePaper(t.paper);
      return {
        id: t.id || ('T-' + Date.now() + '-' + idx),
        cardId: t.cardId || `${pNorm}-${String(idx + 1).padStart(3, '0')}`,
        title: t.title,
        paper: t.paper || 'GS-1',
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
    showToast(`✓ Restored ${topics.length} topics from Sheet`);

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

function discardLocalChanges() {
  if (!hasUnsavedCloudChanges) return;

  const confirmed = confirm(
    'Discard all local changes?\n\nThis will revert all topics and revisions back to the last state saved to your Google Sheet.'
  );
  if (!confirmed) return;

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

// --- NON-BLOCKING OPTIMISTIC SAVE WITH VERIFIED ACKNOWLEDGEMENT & DIAGNOSTICS ---
async function verifyAndSaveToCloud(isRetry = false) {
  if (isSyncInProgress) {
    showToast('A sync is already running in background...');
    return;
  }

  // STEP 1: Verify user password
  let enteredPass = '';
  const passInput = document.getElementById('save-password-input');

  if (!isRetry) {
    enteredPass = passInput?.value.trim() || '';
    if (enteredPass !== CLOUD_SAVE_PASSWORD) {
      const errorEl = document.getElementById('password-error-msg');
      if (errorEl) {
        errorEl.textContent = 'USER AUTH ERROR: Incorrect password. Sheet was not modified.';
        errorEl.classList.remove('hidden');
      }
      passInput?.focus();
      return;
    }
  } else {
    enteredPass = CLOUD_SAVE_PASSWORD;
  }

  // STEP 2: Pre-flight App Configuration Check
  const endpointCheck = getCloudEndpointStatus();
  if (!endpointCheck.ok) {
    closePasswordModal();
    showToast(`[${endpointCheck.category}] ${endpointCheck.message}`, true, false);
    return;
  }

  // STEP 3: Client Data Guard
  if (!topics || topics.length === 0) {
    closePasswordModal();
    showToast('[APP SAFEGUARD] Local topic list is empty. Cloud overwrite blocked to prevent data loss.', true, false);
    return;
  }

  // Unblock UI immediately
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
      throw {
        category: 'GOOGLE SERVER ERROR',
        message: `HTTP ${response.status} (${response.statusText || 'Endpoint returned error'}). Verify your Script deployment is active.`
      };
    }

    const responseText = await response.text();
    let result;

    try {
      result = JSON.parse(responseText);
    } catch (parseErr) {
      if (responseText.includes('accounts.google.com') || responseText.includes('ServiceLogin')) {
        throw {
          category: 'PERMISSIONS ERROR',
          message: 'Google blocked the request with a login screen. Under "Deploy > Manage Deployments", set "Who has access" to "Anyone".'
        };
      }
      throw {
        category: 'ENDPOINT ERROR',
        message: `Google Script returned invalid response: "${responseText.slice(0, 60)}". Check if URL points to the right script.`
      };
    }

    // Backend logical validation
    if (!result.success) {
      throw {
        category: 'SHEET PROCESSING ERROR',
        message: result.error || 'Apps Script rejected payload.'
      };
    }

    // SUCCESS CONFIRMED BY GOOGLE SHEET
    localStorage.setItem(SYNCED_SNAPSHOT_KEY, JSON.stringify(topics));
    hasUnsavedCloudChanges = false;
    localStorage.removeItem(UNSAVED_FLAG_KEY);
    showToast(`✓ Sheet updated successfully (${result.count} cards committed)`);

  } catch (err) {
    console.error('Save failed:', err);

    hasUnsavedCloudChanges = true;
    localStorage.setItem(UNSAVED_FLAG_KEY, 'true');

    let category = err.category || 'NETWORK ERROR';
    let message = err.message || err.toString();

    // Catch generic TypeError: Failed to fetch
    if (message.includes('Failed to fetch') || message.includes('NetworkError')) {
      if (!navigator.onLine) {
        category = 'DEVICE OFFLINE';
        message = 'No active internet connection. Your changes remain saved locally.';
      } else {
        category = 'URL / ENDPOINT ERROR';
        message = 'Could not reach Apps Script. Check if the URL deployment ID is valid and accessible.';
      }
    }

    showToast(`[${category}] ${message}`, true, true);
  } finally {
    isSyncInProgress = false;
    updateSyncStatusUI();
  }
}

// --- ADD TOPIC: DAY 0 DONE TODAY, DAY 1 DUE TOMORROW ---
function addNewTopic() {
  const title = document.getElementById('add-topic-title').value.trim();
  const paper = document.getElementById('add-topic-paper').value;
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
    stage: 1, // Ready for Day 1 revision
    addedDate: today, // Day 0 studied today
    lastReviewed: today,
    nextDue: addDays(today, 1), // Day 1 revision is due TOMORROW
    failCount: 0
  };

  topics.unshift(newEntry);
  saveData();

  document.getElementById('add-topic-title').value = '';
  document.getElementById('add-card-id').value = '';
  closeAddModal();
  showToast(`Added [${cardId}] • Day 1 due tomorrow`);
}

// --- PASS: ADVANCE THROUGH 1 -> 3 -> 7 -> 30 CYCLE ---
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

  const confirmed = confirm(
    `Take a Rest Day?\n\nPostpone all ${pending.length} pending topics by +1 day so your queue clears for today?`
  );
  if (!confirmed) return;

  const tomorrow = addDays(today, 1);
  pending.forEach(t => {
    t.nextDue = tomorrow;
  });

  saveData();
  showToast(`Postponed ${pending.length} topics by +1 day`);
}

function openDemoteModal(id) {
  const topic = topics.find(t => t.id === id);
  if (!topic) return;

  activeDemotingTopicId = id;
  document.getElementById('demote-topic-title').textContent = `[${topic.cardId}] ${topic.title} (${STAGE_CONFIG[topic.stage].label})`;

  if (topic.stage >= 3) {
    selectDemoteStage(2);
  } else {
    selectDemoteStage(1);
  }

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
  document.querySelectorAll('.bucket-btn').forEach(btn => btn.classList.remove('active'));
  document.getElementById(`bucket-btn-${stageNum}`).classList.add('active');

  let defaultDays = 1;
  if (stageNum === 2) defaultDays = 3;
  if (stageNum === 3) defaultDays = 7;

  document.getElementById('demote-interval-input').value = defaultDays;
  updateDemoteDatePreview();
}

function updateDemoteDatePreview() {
  const days = parseInt(document.getElementById('demote-interval-input').value, 10) || 1;
  const today = getTodayString();
  const nextDate = addDays(today, days);
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

function openEditModal(id) {
  const topic = topics.find(t => t.id === id);
  if (!topic) return;

  activeEditingTopicId = id;
  document.getElementById('edit-card-id').value = topic.cardId || '';
  document.getElementById('edit-topic-title').value = topic.title || '';
  document.getElementById('edit-topic-paper').value = topic.paper || 'GS-1';
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
  const newStage = parseInt(document.getElementById('edit-topic-stage').value, 10);
  const newDue = document.getElementById('edit-topic-due').value;

  if (!newTitle) return;

  topic.title = newTitle;
  topic.cardId = newCardId || topic.cardId;
  topic.paper = newPaper;
  topic.stage = newStage;

  if (newStage === 5) {
    topic.nextDue = null;
  } else {
    topic.nextDue = newDue || addDays(getTodayString(), 1);
  }

  closeEditModal();
  saveData();
}

function deleteCurrentTopic() {
  if (!activeEditingTopicId) return;
  if (!confirm('Are you sure you want to delete this topic from the pipeline?')) return;

  topics = topics.filter(t => t.id !== activeEditingTopicId);
  closeEditModal();
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
    container.innerHTML = `
      <div class="empty-state" style="padding: 24px 8px;">
        <p>No revisions scheduled for tomorrow.</p>
      </div>
    `;
  } else {
    tomorrowTopics.sort((a, b) => a.stage - b.stage);
    container.innerHTML = tomorrowTopics.map(t => `
      <div class="forecast-item">
        <div class="forecast-item-left">
          <span class="card-id-tag">${escapeHtml(t.cardId || 'NO-ID')}</span>
          <div style="min-width:0;">
            <div class="forecast-item-title">${escapeHtml(t.title)}</div>
            <div class="forecast-item-meta">${escapeHtml(t.paper)}</div>
          </div>
        </div>
        <span class="badge ${STAGE_CONFIG[t.stage].class}">
          ${STAGE_CONFIG[t.stage].label}
        </span>
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

function openAddModal() {
  document.body.style.overflow = 'hidden';
  document.getElementById('add-modal').classList.add('open');
}

function closeAddModal() {
  document.activeElement?.blur();
  document.getElementById('add-modal').classList.remove('open');
  document.body.style.overflow = '';
}

function closeModalOnBg(e, modalId) {
  if (e.target.id === modalId) {
    document.activeElement?.blur();
    document.getElementById(modalId).classList.remove('open');
    document.body.style.overflow = '';
  }
}

function renderAll() {
  renderPaperFilterBar();
  renderTodayQueue();
  renderPipeline();
  updateCounts();
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

  const counts = { ALL: dueTopics.length, 'GS-1': 0, 'GS-2': 0, 'GS-3': 0, 'GS-4': 0, Optional: 0, Other: 0 };
  dueTopics.forEach(t => {
    const norm = normalizePaper(t.paper);
    if (counts[norm] !== undefined) counts[norm]++;
    else counts.Other++;
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

  let due = topics.filter(t => t.stage < 5 && t.nextDue && t.nextDue <= today);

  if (currentPaperFilter !== 'ALL') {
    due = due.filter(t => normalizePaper(t.paper) === currentPaperFilter);
  }

  due.sort((a, b) => (a.nextDue > b.nextDue ? 1 : -1));

  if (due.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <h3>Queue Cleared</h3>
        <p>No pending revisions for this filter. All scheduled cards are completed.</p>
      </div>
    `;
    return;
  }

  container.innerHTML = due.map(t => {
    const overdueDays = getDaysDiff(t.nextDue, today);
    const overdueBadge = overdueDays > 0 ? `<span class="badge badge-overdue">${overdueDays}d overdue</span>` : '';
    const leechBadge = t.failCount >= 3 ? `<span class="badge badge-leech">⚠️ Leech (${t.failCount})</span>` : '';

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
    (t.cardId && t.cardId.toLowerCase().includes(search))
  );

  if (filtered.length === 0) {
    container.innerHTML = `<div class="empty-state"><p>No topics matching criteria.</p></div>`;
    return;
  }

  container.innerHTML = filtered.map(t => {
    const leechBadge = t.failCount >= 3 ? `<span class="badge badge-leech">⚠️ Leech (${t.failCount})</span>` : '';
    return `
      <div class="topic-card">
        <div class="card-top">
          <div class="topic-header-area">
            <span class="card-id-tag">${escapeHtml(t.cardId || 'NO-ID')}</span>
            <div class="topic-name">${escapeHtml(t.title)}</div>
          </div>
          <div class="badge-group">
            ${leechBadge}
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
              cardId: item.cardId || generateNextCardId(item.paper || 'GS-1'),
              title: item.title || item.topic || 'Untitled Topic',
              paper: item.paper || item.subject || 'GS-1',
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
      alert('Invalid JSON file format.');
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