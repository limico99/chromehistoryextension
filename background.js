// ---------------------------------------------------------------------------
// 저장소 헬퍼
// ---------------------------------------------------------------------------
function loadRules() {
  return new Promise((resolve) => {
    chrome.storage.local.get({ scheduleRules: [] }, (data) => resolve(data.scheduleRules || []));
  });
}

function saveRules(rules) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ scheduleRules: rules }, resolve);
  });
}

// ---------------------------------------------------------------------------
// chrome.history API 콜백을 Promise로 감싸는 헬퍼
// ---------------------------------------------------------------------------
function historySearch(query) {
  return new Promise((resolve) => chrome.history.search(query, resolve));
}
function historyGetVisits(details) {
  return new Promise((resolve) => chrome.history.getVisits(details, resolve));
}
function historyDeleteRange(range) {
  return new Promise((resolve) => chrome.history.deleteRange(range, resolve));
}

// ---------------------------------------------------------------------------
// 다음 실행 시각 계산
// ---------------------------------------------------------------------------
const FREQ_MINUTES = { daily: 24 * 60, weekly: 7 * 24 * 60 };

function computeNextRun(rule, fromTime = Date.now()) {
  const [hh, mm] = (rule.time || '00:00').split(':').map(Number);

  if (rule.frequency === 'once') {
    const parts = (rule.date || '').split('-').map(Number);
    if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) return null;
    const [y, m, d] = parts;
    return new Date(y, m - 1, d, hh, mm, 0, 0).getTime();
  }

  if (rule.frequency === 'daily') {
    const now = new Date(fromTime);
    let next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm, 0, 0);
    if (next.getTime() <= fromTime) next = new Date(next.getTime() + 24 * 60 * 60 * 1000);
    return next.getTime();
  }

  if (rule.frequency === 'weekly') {
    const targetWeekday = Number(rule.weekday);
    const now = new Date(fromTime);
    let next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm, 0, 0);
    const diff = (targetWeekday - next.getDay() + 7) % 7;
    next = new Date(next.getTime() + diff * 24 * 60 * 60 * 1000);
    if (next.getTime() <= fromTime) next = new Date(next.getTime() + 7 * 24 * 60 * 60 * 1000);
    return next.getTime();
  }

  return null;
}

// ---------------------------------------------------------------------------
// 저장된 규칙을 기준으로 알람을 전부 재등록
//   - 규칙 추가/수정/삭제 시, 그리고 브라우저 시작/확장 설치 시 호출됩니다.
// ---------------------------------------------------------------------------
async function syncAlarms() {
  const rules = await loadRules();
  await chrome.alarms.clearAll();

  for (const rule of rules) {
    if (!rule.enabled) continue;
    const nextRun = computeNextRun(rule);
    if (!nextRun) continue;

    const alarmInfo = { when: nextRun };
    if (rule.frequency !== 'once') {
      alarmInfo.periodInMinutes = FREQ_MINUTES[rule.frequency];
    }
    chrome.alarms.create(rule.id, alarmInfo);
  }
}

// ---------------------------------------------------------------------------
// UTF-8 문자열 -> base64 (다운로드용 data URL 생성에 사용)
// ---------------------------------------------------------------------------
function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function backupBeforeCleanup(cutoff) {
  const urlItems = await historySearch({ text: '', startTime: 0, endTime: cutoff, maxResults: 10000 });
  const items = [];
  let idx = 0;
  const concurrency = 15;

  async function worker() {
    while (idx < urlItems.length) {
      const item = urlItems[idx++];
      let visits = [];
      try {
        visits = await historyGetVisits({ url: item.url });
      } catch (e) {
        continue;
      }
      for (const v of visits) {
        if (v.visitTime <= cutoff) {
          items.push({
            url: item.url,
            title: item.title || item.url,
            visitTime: v.visitTime,
            visitTimeLocal: new Date(v.visitTime).toLocaleString('ko-KR'),
          });
        }
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, urlItems.length || 1) }, worker));
  if (items.length === 0) return;

  const json = JSON.stringify(items, null, 2);
  const dataUrl = 'data:application/json;base64,' + utf8ToBase64(json);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');

  await new Promise((resolve) => {
    chrome.downloads.download(
      { url: dataUrl, filename: `history_backup_scheduled_${ts}.json`, saveAs: false },
      () => resolve()
    );
  });
}

// ---------------------------------------------------------------------------
// 실제 정리 실행 (보존일수 기준으로 그 이전 기록 삭제, 0이면 전체 삭제)
// ---------------------------------------------------------------------------
async function runCleanup(rule) {
  const now = Date.now();
  const retentionDays = Number(rule.retentionDays) || 0;
  const cutoff = retentionDays > 0 ? now - retentionDays * 24 * 60 * 60 * 1000 : now;

  if (rule.backup) {
    try {
      await backupBeforeCleanup(cutoff);
    } catch (e) {
      // 백업 실패해도 정리 자체는 계속 진행합니다.
    }
  }

  await historyDeleteRange({ startTime: 0, endTime: cutoff });
}

// ---------------------------------------------------------------------------
// 알람 발생 처리
// ---------------------------------------------------------------------------
chrome.alarms.onAlarm.addListener(async (alarm) => {
  const rules = await loadRules();
  const idx = rules.findIndex((r) => r.id === alarm.name);
  if (idx === -1) return;

  const rule = rules[idx];
  if (!rule.enabled) return;

  try {
    await runCleanup(rule);
    rule.lastRun = Date.now();
    rule.lastStatus = 'ok';
  } catch (e) {
    rule.lastRun = Date.now();
    rule.lastStatus = 'error';
  }

  if (rule.frequency === 'once') {
    rule.enabled = false;
  }

  rules[idx] = rule;
  await saveRules(rules);
});

// ---------------------------------------------------------------------------
// scheduler.js와의 메시지 통신
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'SYNC_ALARMS') {
    syncAlarms().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg && msg.type === 'RUN_RULE_NOW') {
    (async () => {
      const rules = await loadRules();
      const idx = rules.findIndex((r) => r.id === msg.ruleId);
      if (idx === -1) {
        sendResponse({ ok: false, error: '규칙을 찾을 수 없습니다.' });
        return;
      }
      try {
        await runCleanup(rules[idx]);
        rules[idx].lastRun = Date.now();
        rules[idx].lastStatus = 'ok';
        await saveRules(rules);
        sendResponse({ ok: true });
      } catch (e) {
        rules[idx].lastRun = Date.now();
        rules[idx].lastStatus = 'error';
        await saveRules(rules);
        sendResponse({ ok: false, error: String(e) });
      }
    })();
    return true;
  }
});

chrome.runtime.onInstalled.addListener(() => { syncAlarms(); });
chrome.runtime.onStartup.addListener(() => { syncAlarms(); });
