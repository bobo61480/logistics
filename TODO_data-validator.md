# Data validation review

- [x] DATA-001 Reject snapshots missing the two core Logistics Master sources.
- [x] DATA-002 JSON-serialize every persisted part and fail on non-serializable data.
- [x] DATA-003 Bound every database part below 256 KiB and cap statement count.
- [x] DATA-004 Verify part count and contiguous chunks before decoding a current snapshot.
- [x] DATA-005 Preserve source health and KPI error provenance with every snapshot.
- [ ] DATA-006 Compare a production D1 payload with the live Sheets payload after activation.
