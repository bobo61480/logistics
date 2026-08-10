from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"Expected exactly one match in {path}, found {count}: {old[:80]!r}")
    p.write_text(text.replace(old, new, 1))

# WMS -> WH Trucking Request: never write provenance/audit text into operational NOTE.
replace_once(
    "google-apps-script/Code.gs",
    '      const noteText = "Imported from WMS Stylekorean rows " + group.sourceRows.join(", ");\n',
    '',
)
replace_once(
    "google-apps-script/Code.gs",
    '        if (targetMap["NOTE"] !== undefined && !values[targetMap["NOTE"]]) {\n          values[targetMap["NOTE"]] = noteText;\n          changed = true;\n        }\n',
    '',
)
replace_once(
    "google-apps-script/Code.gs",
    '        if (targetMap["NOTE"] !== undefined) row[targetMap["NOTE"]] = noteText;\n',
    '',
)

# Gmail v2: preserve provenance in PIPELINE LOG/metadata only, never in IMPORTS/WH NOTES.
replace_once(
    "google-apps-script/GmailPipelineV2.gs",
    'var GMAIL_PIPELINE_V2_VERSION = "2026-08-10-v1";\n',
    'var GMAIL_PIPELINE_V2_VERSION = "2026-08-10-v2-no-operational-notes";\n',
)
replace_once(
    "google-apps-script/GmailPipelineV2.gs",
    'function emailNoteV2_(record) {\n  var subject = String(record._emailSubject || record.note || "").trim();\n  if (!subject) return "";\n  return "[EMAIL AUTO] " + subject.slice(0, 220);\n}\n',
    'function emailNoteV2_(record) {\n  // Keep Gmail provenance in PIPELINE LOG / message metadata only.\n  // Never import email subjects, attachment NOTES/REMARKS, or parser audit text\n  // into operational NOTES columns in IMPORTS or WH Trucking Request.\n  return "";\n}\n',
)

# Legacy Gmail helpers are retained for compatibility/manual invocation. Harden them too.
replace_once(
    "google-apps-script/GmailPipeline.gs",
    '  put(["NOTE", "REMARK", "비고"], (record.note || "") + " [auto: " + (record._sourceEmail || "email") + "]");\n',
    '',
)
replace_once(
    "google-apps-script/GmailPipeline.gs",
    '  put(["NOTE", "REMARK"], (record.note || "Imported from email") + " [auto: " + (record._sourceEmail || "email") + "]");\n',
    '',
)

# Guardrails: no automation provenance may remain as an operational note write.
combined = "\n".join(
    Path(p).read_text()
    for p in [
        "google-apps-script/Code.gs",
        "google-apps-script/GmailPipeline.gs",
        "google-apps-script/GmailPipelineV2.gs",
    ]
)
for forbidden in [
    'row[targetMap["NOTE"]] = noteText',
    'values[targetMap["NOTE"]] = noteText',
    'return "[EMAIL AUTO] "',
    'put(["NOTE", "REMARK", "비고"]',
    'put(["NOTE", "REMARK"]',
]:
    if forbidden in combined:
        raise SystemExit(f"Forbidden operational automation-note write remains: {forbidden}")

print("Automation-note suppression patch applied successfully.")
