from pathlib import Path

path = Path('google-apps-script/GmailPipelineV2.gs')
text = path.read_text()

def replace_once(old, new, label):
    global text
    n = text.count(old)
    if n != 1:
        raise SystemExit(f'{label}: expected one match, found {n}')
    text = text.replace(old, new, 1)

replace_once(
'''  var vessel = text.match(/(?:VSL|VESSEL(?:\\s*\\/\\s*VOY)?)\\s*[:#-]?\\s*([A-Z][A-Z0-9 .-]{2,45}(?:\\d{3,4}[EW])?)/i);
  if (vessel) context.vessel = cleanVesselV2_(vessel[1]);

  if (/HAS BEEN COMPLETED|SHIPMENT[^\\n]{0,30}COMPLETED/i.test(text)) context.status = "Completed";
  else if (/HAS BEEN DELIVERED|\\bDELIVERED\\b/i.test(text) && !/DELIVERY REQUEST/i.test(text)) context.status = "Delivered";
  else if (/\\bRECEIVED\\b/i.test(text)) context.status = "Received";
  else if (/FDA.{0,20}(HOLD|DETAIN|REVIEW)/i.test(text)) context.status = "FDA Review/Hold";
  else if (/CUSTOMS.{0,20}(HOLD|CLEARANCE)/i.test(text)) context.status = "Customs Clearance";
  else if (/\\bIN TRANSIT\\b|\\bSHIPPED\\b/i.test(text)) context.status = "Shipping";
  else if (/RESCHEDULED|DELAYED/i.test(text)) context.status = "Delayed";
''',
'''  var vessel = text.match(/\\b(?:VSL|VESSEL(?:\\s*\\/\\s*VOY)?)\\b\\s*[:#-]?\\s*([^\\r\\n]{3,60})/i);
  if (vessel) {
    var vesselCandidate = cleanVesselV2_(vessel[1]);
    if (isPlausibleVesselV2_(vesselCandidate)) context.vessel = vesselCandidate;
  }

  // Never derive terminal status from a raw word anywhere in an email body. Legal
  // disclaimers commonly contain phrases such as "if you received this email in error".
  // Only explicit logistics-status phrases are allowed to change source status.
  context.status = explicitEmailStatusV2_(subject, body);
''',
'context status/vessel extraction')

replace_once(
'''function cleanVesselV2_(value) {
  return String(value || "").replace(/\\s{2,}/g, " ").replace(/[|,;].*$/, "").trim().slice(0, 60);
}
''',
'''function cleanVesselV2_(value) {
  return String(value || "").replace(/\\s{2,}/g, " ").replace(/[|,;].*$/, "").trim().slice(0, 60);
}

function isPlausibleVesselV2_(value) {
  var s = cleanVesselV2_(value);
  if (!s || s.length < 3) return false;
  if (/^(?:DELAY|DELAYS|DELAYED|STATUS|PENDING|RECEIVED|DELIVERED|COMPLETED|CUSTOMS|FDA|NOTES?|REMARKS?)$/i.test(s)) return false;
  // Air flight identifiers such as SQ-7408 / KE213 / OZ-202.
  if (/^[A-Z]{1,3}-?\\d{2,4}$/i.test(s)) return true;
  // Ocean vessel+voyage strings such as HMM DAON 0022E / SM YANTIAN 2605E.
  if (/\\b\\d{3,4}[EW]\\b/i.test(s) && /[A-Z]{2}/i.test(s)) return true;
  // Named vessels without a voyage must look like a real multi-token proper name,
  // not a prose/status fragment accidentally captured after the letters VSL.
  return s.length >= 6 && /\\s/.test(s) && !/\\b(?:ETA|ETD|DELAY|STATUS|CUSTOMS|FDA|DELIVERY|RECEIVED|COMPLETED)\\b/i.test(s);
}

function explicitEmailStatusV2_(subject, body) {
  var subj = String(subject || "").trim();
  var lines = String(body || "").split(/\\r?\\n/).map(function (line) { return line.trim(); }).filter(Boolean);
  // Only retain body lines that look operational. This deliberately excludes footer /
  // confidentiality prose even when it contains words such as received or delivered.
  var operational = lines.filter(function (line) {
    return /(?:STATUS|SHIPMENT|PACKAGE|DELIVER|TRANSIT|PICKED UP|PICKUP|FDA|CUSTOMS|HOLD|DETAIN|RELEASE|RESCHEDULE|DELAY|입고|배송|통관|보류|도착)/i.test(line);
  }).slice(0, 80);
  var signal = [subj].concat(operational).join("\\n");

  if (/\\bSHIPMENT\\b[^\\n]{0,60}\\bHAS BEEN COMPLETED\\b|\\bSTATUS\\s*[:=-]?\\s*COMPLETED\\b|배송\\s*완료/i.test(signal)) return "Completed";
  if (/\\b(?:PACKAGE|PACKAGES|SHIPMENT|DELIVERY)\\b[^\\n]{0,70}\\b(?:HAS BEEN\\s+)?DELIVERED\\b|\\bSTATUS\\s*[:=-]?\\s*DELIVERED\\b|배송(?:이|은|는)?\\s*완료/i.test(signal)) return "Delivered";
  if (/\\b(?:STATUS|CURRENT STATUS|WAREHOUSE STATUS)\\s*[:=-]?\\s*RECEIVED\\b|\\bSHIPMENT\\b[^\\n]{0,50}\\b(?:HAS BEEN\\s+)?RECEIVED\\b|입고\\s*완료|창고\\s*입고/i.test(signal)) return "Received";
  if (/FDA[^\\n]{0,40}\\b(?:HOLD|DETAINED?|REVIEW)\\b|FDA[^\\n]{0,30}보류/i.test(signal)) return "FDA Review/Hold";
  if (/CUSTOMS[^\\n]{0,40}\\b(?:HOLD|CLEARANCE PENDING|UNDER REVIEW)\\b|통관[^\\n]{0,30}(?:보류|검사|대기)/i.test(signal)) return "Customs Clearance";
  if (/\\b(?:STATUS\\s*[:=-]?\\s*)?(?:IN TRANSIT|SHIPPED)\\b|\\bSHIPMENT\\b[^\\n]{0,40}\\b(?:PICKED UP|SHIPPED)\\b/i.test(signal)) return "Shipping";
  if (/\\b(?:DELIVERY|ETA|SHIPMENT)\\b[^\\n]{0,60}\\b(?:RESCHEDULED|DELAYED)\\b|\\bRESCHEDULED DELIVERY\\b/i.test(signal)) return "Delayed";
  return "";
}
''',
'safe status helpers')

replace_once(
'''  values[12] = record.vessel || "";
''',
'''  values[12] = isPlausibleVesselV2_(record.vessel) ? record.vessel : "";
''',
'new inbound vessel guard')

replace_once(
'''  set(13, record.vessel, true);
''',
'''  if (isPlausibleVesselV2_(record.vessel)) set(13, record.vessel, true);
''',
'existing inbound vessel guard')

replace_once(
'''  if (record.status) {
    var current = String(oldRow[27] || "").trim();
    var terminal = /^(SHIPPED|DELIVERED|RECEIVED|CANCELLED|COMPLETED)$/i.test(current);
    if (!terminal || /^(DELIVERED|RECEIVED|COMPLETED)$/i.test(record.status)) set(28, record.status, true);
  }
''',
'''  if (record.status) {
    var current = String(oldRow[27] || "").trim();
    var terminal = /^(SHIPPED|DELIVERED|RECEIVED|CANCELLED|COMPLETED)$/i.test(current);
    // Carrier/email automation may advance an active row, but never rewrite a source
    // row that is already terminal. This prevents Delivered/Received/Completed churn.
    if (!terminal) set(28, record.status, true);
  }
''',
'inbound terminal protection')

replace_once(
'''    if (record.status) set(21, record.status, true);
''',
'''    if (record.status) {
      var currentOutbound = String(old[20] || "").trim();
      if (!/^(SHIPPED|DELIVERED|RECEIVED|CANCELLED|COMPLETED)$/i.test(currentOutbound)) set(21, record.status, true);
    }
''',
'outbound terminal protection')

replace_once(
'''function formatEmailStatusRowV2_(sheet, rowNumber, status) {
  var done = /^(SHIPPED|DELIVERED|RECEIVED|CANCELLED|COMPLETED)$/i.test(String(status || "").trim());
  var range = sheet.getRange(rowNumber, 1, 1, sheet.getLastColumn());
  if (done) range.setBackground("#E8EAED").setFontColor("#5F6368");
}
''',
'''function formatEmailStatusRowV2_(sheet, rowNumber, status) {
  var done = /^(SHIPPED|DELIVERED|RECEIVED|CANCELLED|COMPLETED)$/i.test(String(status || "").trim());
  var range = sheet.getRange(rowNumber, 1, 1, sheet.getLastColumn());
  if (done) range.setBackground("#E8EAED").setFontColor("#5F6368");
  else range.setBackground(null).setFontColor(null);
}
''',
'active row formatting restore')

path.write_text(text)
