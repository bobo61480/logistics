from pathlib import Path

p = Path('google-apps-script/GmailPipelineV2.gs')
s = p.read_text()


def once(old, new, label):
    global s
    n = s.count(old)
    if n != 1:
        raise SystemExit(f'{label}: expected one match, found {n}')
    s = s.replace(old, new, 1)

once('var GMAIL_V2_MAX_THREADS = 45;\n', 'var GMAIL_V2_MAX_THREADS = 12;\nvar GMAIL_V2_RUNTIME_BUDGET_MS = 210000;\n', 'bounded constants')

old = '''function processLogisticsEmailsV2() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return { skipped: "locked" };
  try {
    ensureGmailV2Trigger_();
    var labels = gmailV2Labels_();
    var queries = gmailV2Queries_();
    var threadsById = {};
    queries.forEach(function (query) {
      GmailApp.search(query, 0, GMAIL_V2_MAX_THREADS).forEach(function (thread) {
        threadsById[thread.getId()] = thread;
      });
    });

    var stats = { threads: 0, messages: 0, inserted: 0, updated: 0, noop: 0, pending: 0, errors: 0 };
    Object.keys(threadsById).slice(0, GMAIL_V2_MAX_THREADS).forEach(function (threadId) {
      var thread = threadsById[threadId];
      stats.threads++;
      var threadPending = false;
      var threadError = false;
      thread.getMessages().forEach(function (message) {
        if (gmailV2Seen_(message.getId())) return;
        if (new Date().getTime() - message.getDate().getTime() > GMAIL_V2_LOOKBACK_DAYS * 86400000) return;
        stats.messages++;
        try {
          var result = processLogisticsMessageV2_(message);
          stats.inserted += result.inserted;
          stats.updated += result.updated;
          stats.noop += result.noop;
          stats.pending += result.pending;
          threadPending = threadPending || result.pending > 0;
          gmailV2MarkSeen_(message.getId());
        } catch (err) {
          stats.errors++;
          threadError = true;
          writeLog_("GMAIL V2 ERROR", message.getId(), String(err && err.stack || err));
        }
      });
      if (threadError) thread.addLabel(labels.error);
      if (threadPending) thread.addLabel(labels.pending);
      if (!threadError) thread.addLabel(labels.processed);
    });

    if (stats.inserted || stats.updated) {
      SpreadsheetApp.flush();
      try { syncInventoryModule(); } catch (syncErr) { writeLog_("GMAIL V2 INVENTORY FOLLOWUP", "warn", String(syncErr)); }
    }
    writeLog_("GMAIL V2 RUN", GMAIL_PIPELINE_V2_VERSION, JSON.stringify(stats));
    return stats;
  } finally {
    lock.releaseLock();
  }
}
'''

new = '''function processLogisticsEmailsV2() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return { skipped: "locked" };
  var runStarted = Date.now();
  try {
    ensureGmailV2Trigger_();
    var labels = gmailV2Labels_();
    var queries = gmailV2Queries_();
    var threadsById = {};
    queries.forEach(function (query) {
      GmailApp.search(query, 0, GMAIL_V2_MAX_THREADS).forEach(function (thread) {
        threadsById[thread.getId()] = thread;
      });
    });

    var stats = {
      threads: 0, messages: 0, inserted: 0, updated: 0, noop: 0,
      pending: 0, errors: 0, deferredThreads: 0, budgetHit: false
    };
    var threadIds = Object.keys(threadsById).slice(0, GMAIL_V2_MAX_THREADS);
    for (var ti = 0; ti < threadIds.length; ti++) {
      if (Date.now() - runStarted >= GMAIL_V2_RUNTIME_BUDGET_MS) {
        stats.budgetHit = true;
        stats.deferredThreads += threadIds.length - ti;
        break;
      }
      var thread = threadsById[threadIds[ti]];
      stats.threads++;
      var threadPending = false;
      var threadError = false;
      var threadFinished = true;
      var messages = thread.getMessages();
      for (var mi = 0; mi < messages.length; mi++) {
        if (Date.now() - runStarted >= GMAIL_V2_RUNTIME_BUDGET_MS) {
          stats.budgetHit = true;
          stats.deferredThreads += 1 + Math.max(0, threadIds.length - ti - 1);
          threadFinished = false;
          break;
        }
        var message = messages[mi];
        if (gmailV2Seen_(message.getId())) continue;
        if (Date.now() - message.getDate().getTime() > GMAIL_V2_LOOKBACK_DAYS * 86400000) continue;
        stats.messages++;
        try {
          var result = processLogisticsMessageV2_(message);
          stats.inserted += result.inserted;
          stats.updated += result.updated;
          stats.noop += result.noop;
          stats.pending += result.pending;
          threadPending = threadPending || result.pending > 0;
          gmailV2MarkSeen_(message.getId());
        } catch (err) {
          stats.errors++;
          threadError = true;
          writeLog_("GMAIL V2 ERROR", message.getId(), String(err && err.stack || err));
        }
      }
      if (threadError) thread.addLabel(labels.error);
      if (threadPending) thread.addLabel(labels.pending);
      if (threadFinished && !threadError) thread.addLabel(labels.processed);
      if (!threadFinished) break;
    }

    if (stats.inserted || stats.updated) {
      SpreadsheetApp.flush();
      // Inventory has its own hourly trigger. Run the immediate rebuild only when there is
      // enough budget left to finish cleanly and still record this cycle's audit entry.
      if (Date.now() - runStarted < GMAIL_V2_RUNTIME_BUDGET_MS - 45000) {
        try { syncInventoryModule(); } catch (syncErr) { writeLog_("GMAIL V2 INVENTORY FOLLOWUP", "warn", String(syncErr)); }
      } else {
        writeLog_("GMAIL V2 INVENTORY FOLLOWUP", "deferred", "Hourly inventory sync will pick up Gmail source updates.");
      }
    }
    stats.elapsedMs = Date.now() - runStarted;
    writeLog_("GMAIL V2 RUN", GMAIL_PIPELINE_V2_VERSION, JSON.stringify(stats));
    return stats;
  } finally {
    lock.releaseLock();
  }
}
'''

once(old, new, 'processLogisticsEmailsV2 bounded loop')
p.write_text(s)
