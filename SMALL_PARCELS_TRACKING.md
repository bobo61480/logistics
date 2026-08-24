# Small Parcels Status Tracking

## Overview

The inbound schedule now includes **periodic status tracking for small parcels** to automatically monitor packages and update their status as they move through the delivery pipeline.

### What It Tracks

1. **SKW_Inbound Sheet** — Small package inventory
   - Packages marked as "SCHEDULED" or "WORK IN PROGRESS"
   - Checks if delivery date has been recorded
   - Automatically updates status to "DELIVERED" when received

2. **IMPORTS Sheet** — Main inbound schedule
<<<<<<< HEAD
<<<<<<< HEAD
   - Packages in "SCHEDULED" status (awaiting delivery)
   - Scans notes/remarks for tracking keywords
   - Updates status based on email notifications and tracking updates

### Schedule

- **Frequency:** Every 45 minutes
=======
   - Rows strictly below the `PARCELS` marker in `IMPORTS`
   - Uses the tracking number and the ETA/status note in the parcel section
   - Checks the official carrier page first (UPS/FedEx/USPS/DHL), then exact-tracking carrier email, then the sheet note
   - Writes changed `WEBSITE STATUS` and tracked ETA details back to the exact source row

### Schedule

- **Frequency:** Every hour
>>>>>>> 469241b300fe0aacf2c1ca2f59e316291ea5b49b
=======
   - Rows strictly below the `PARCELS` marker in `IMPORTS`
   - Uses the tracking number and the ETA/status note in the parcel section
   - Checks the official carrier page first (UPS/FedEx/USPS/DHL), then exact-tracking carrier email, then the sheet note
   - Writes changed `WEBSITE STATUS` and tracked ETA details back to the exact source row

### Schedule

- **Frequency:** Every hour
>>>>>>> 3073244f36fcf87c014806c9f3289c04cd8fd481
- **Trigger Function:** `trackSmallParcelsStatusUpdates()`
- **Pipeline Log:** All tracking runs logged in PIPELINE LOG tab

## How It Works

### SKW_Inbound Tracking

```
FOR each row in SKW_Inbound sheet:
  IF status = "SCHEDULED" OR "WORK IN PROGRESS":
    IF date_received is populated:
      UPDATE status to "DELIVERED"
      LOG row update
```

This automatically marks packages as delivered once they've been physically received.

<<<<<<< HEAD
<<<<<<< HEAD
### IMPORTS Schedule Tracking
=======
### IMPORTS `PARCELS` Section Tracking
>>>>>>> 469241b300fe0aacf2c1ca2f59e316291ea5b49b
=======
### IMPORTS `PARCELS` Section Tracking
>>>>>>> 3073244f36fcf87c014806c9f3289c04cd8fd481

```
FOR each row in IMPORTS sheet:
  IF status = "SCHEDULED":
    SCAN notes/remarks for tracking keywords:
      "delivered" → "DELIVERED"
      "received" → "RECEIVED"
      "shipped" → "SHIPPED"
      "in transit" → "SHIPPING"
      "customs" → "Customs Clearance"
      "fda" → "FDA Review/Hold"
    IF keyword found:
      UPDATE status to matched value
      LOG row update
```

Email notifications and manual notes are scanned for delivery/status updates.

## Status Updates Handled

| Keyword | New Status | Description |
|---------|-----------|-------------|
| delivered | DELIVERED | Package delivered to recipient |
| received | RECEIVED | Package received at facility |
| shipped | SHIPPED | Package dispatched from origin |
| in transit | SHIPPING | Package in transit |
| customs | Customs Clearance | Awaiting customs clearance |
| fda | FDA Review/Hold | Awaiting FDA review |

## Setup Required

### Step 1 — Enable Tracking

In the **Apps Script editor** (Extensions → Apps Script), run `setupAllTriggers()` once:

```javascript
setupAllTriggers()
```

<<<<<<< HEAD
<<<<<<< HEAD
This provisions 7 triggers including `trackSmallParcelsStatusUpdates` (every 45 min).
=======
This provisions 7 triggers including `trackSmallParcelsStatusUpdates` (hourly).
>>>>>>> 469241b300fe0aacf2c1ca2f59e316291ea5b49b
=======
This provisions 7 triggers including `trackSmallParcelsStatusUpdates` (hourly).
>>>>>>> 3073244f36fcf87c014806c9f3289c04cd8fd481

### Step 2 — Verify in Triggers View

Check **Triggers** (clock icon in left sidebar) — you should see:

```
Function: trackSmallParcelsStatusUpdates
Source: Time-driven
Trigger type: Time-based trigger
<<<<<<< HEAD
<<<<<<< HEAD
Schedule: 45 minutes
=======
Schedule: Every hour
>>>>>>> 469241b300fe0aacf2c1ca2f59e316291ea5b49b
=======
Schedule: Every hour
>>>>>>> 3073244f36fcf87c014806c9f3289c04cd8fd481
```

### Step 3 — Monitor Pipeline Log

After the first run, check **PIPELINE LOG** tab in LOGISTICS MASTER 2026:

```
[HH:MM:SS] trackSmallParcelsStatusUpdates() — Tracked small parcels: 5 packages, 2 updated
```

## Examples

### Example 1: SKW_Inbound Auto-Update

**Before:**
| SKW_Inbound | ... | STATUS | DATE_RECEIVED |
|-------------|-----|--------|---------------|
| Row 10 | ... | SCHEDULED | 2026-08-07 |

<<<<<<< HEAD
<<<<<<< HEAD
**After (45 minutes later):**
=======
**After (the next hourly tracking cycle):**
>>>>>>> 469241b300fe0aacf2c1ca2f59e316291ea5b49b
=======
**After (the next hourly tracking cycle):**
>>>>>>> 3073244f36fcf87c014806c9f3289c04cd8fd481
| SKW_Inbound | ... | STATUS | DATE_RECEIVED |
|-------------|-----|--------|---------------|
| Row 10 | ... | DELIVERED | 2026-08-07 |

✅ Automatically marked as DELIVERED because DATE_RECEIVED is populated.

### Example 2: IMPORTS Email Update

**Before:**
| IMPORTS | ... | STATUS | NOTE |
|---------|-----|--------|------|
| Row 42 | ... | SCHEDULED | Order #12345 placed |

**Email arrives:**
```
Subject: Package Shipped - #12345
Body: Your order has been shipped and is in transit.
```

**After (email processed and status checked):**
| IMPORTS | ... | STATUS | NOTE |
|---------|-----|--------|------|
| Row 42 | ... | SHIPPING | Order #12345 placed [email: shipped] |

✅ Status updated to SHIPPING because email contains "shipped" and notes mention "in transit".

## Logging & Monitoring

### View Tracking Activity

1. Open LOGISTICS MASTER 2026 spreadsheet
2. Go to **PIPELINE LOG** tab
3. Search for `SMALL_PARCEL_TRACKING` entries
4. Each entry shows: `Tracked small parcels: X packages, Y updated`

### Manual Test

In the Apps Script editor, run:

```javascript
trackSmallParcelsStatusUpdates()
```

Check the **Execution log** (below editor) for results:
```
Tracked small parcels: 23 packages, 3 updated
SKW_Inbound row 10 status updated to DELIVERED
IMPORTS row 42 status updated to SHIPPING
...
```

## Troubleshooting

### No Updates Happening

1. **Trigger not registered:** Run `setupAllTriggers()` in Apps Script editor
2. **No packages in SCHEDULED status:** Create test data in SKW_Inbound or IMPORTS
3. **Notes/remarks empty:** Tracking relies on manual updates or email keywords — populate these fields

### Status Not Updating Correctly

- Verify column names match expected headers (STATUS, WEBSITE STATUS, DATE_RECEIVED, NOTE, REMARK)
- Check PIPELINE LOG for error messages
- Review notes/remarks for keyword matches

### Too Frequent / Not Frequent Enough

To change the schedule, edit `Triggers.gs`:

```javascript
// Every 45 minutes (current)
{ handler: "trackSmallParcelsStatusUpdates", minutes: 45 }

// Change to every 30 minutes:
{ handler: "trackSmallParcelsStatusUpdates", minutes: 30 }

// Then run setupAllTriggers() to apply
```

## Related Documentation

- `TIME_DRIVEN_AUDIT.md` — All scheduled jobs and triggers
- `google-apps-script/DEPLOY.md` — Apps Script setup guide
- `google-apps-script/InventorySync.gs` — Implementation details

## Future Enhancements

Potential improvements for tracking:

1. **Carrier API Integration** — Query UPS/FedEx/DHL APIs for real-time tracking
2. **Email Header Parsing** — Extract tracking numbers and carrier info from shipping notifications
3. **Delivery Confirmation Webhook** — Accept POST requests from carriers
4. **Status History** — Track all status changes in separate audit log
5. **Alert Notifications** — Email team when packages are delayed or stuck

