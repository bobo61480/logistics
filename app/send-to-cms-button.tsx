"use client";

import { useState } from "react";

const CMS_WRITE_ENDPOINT =
  process.env.NEXT_PUBLIC_LOGISTICS_CMS_WRITE_URL ?? "/api/logistics/cms-write";

type SendState = "idle" | "confirm" | "sending" | "done" | "error";

/**
 * "Send to CMS" — the only CMS write control in the UI. Two-step by design:
 * the first click only arms an inline confirmation, the second click queues the
 * write. During the dry-run rollout the response is marked as simulated and CMS
 * is never contacted.
 */
export function SendToCmsButton({
  shipmentNo,
  invoice,
  customer,
  status,
}: {
  shipmentNo?: string;
  invoice?: string;
  customer?: string;
  status?: string;
}) {
  const [state, setState] = useState<SendState>("idle");
  const [message, setMessage] = useState("");

  if (!shipmentNo && !invoice) return null;

  const send = async () => {
    setState("sending");
    setMessage("");
    try {
      const response = await fetch(CMS_WRITE_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ operation: "sync_outbound_shipment", shipmentNo, invoice, customer, status }),
      });
      const result = (await response.json().catch(() => null)) as
        | { ok?: boolean; error?: string; dryRun?: boolean; deduplicated?: boolean }
        | null;
      if (!response.ok || result?.ok !== true) {
        throw new Error(result?.error || `Send to CMS failed (${response.status}).`);
      }
      setState("done");
      setMessage(
        result.dryRun
          ? "Queued (dry-run — CMS not contacted)"
          : result.deduplicated
            ? "Already queued"
            : "Queued for CMS",
      );
    } catch (error) {
      setState("error");
      setMessage(error instanceof Error ? error.message : "Send to CMS failed.");
    }
  };

  if (state === "done") {
    return <span className="cms-write-result cms-write-ok">{message}</span>;
  }

  return (
    <span className="cms-write-control">
      {state === "confirm" || state === "sending" ? (
        <>
          <button
            type="button"
            className="button primary cms-write-confirm"
            disabled={state === "sending"}
            onClick={send}
          >
            {state === "sending" ? "Sending…" : "Confirm send to CMS"}
          </button>
          <button
            type="button"
            className="cms-write-cancel"
            disabled={state === "sending"}
            onClick={() => setState("idle")}
          >
            Cancel
          </button>
        </>
      ) : (
        <button type="button" className="cms-write-button" onClick={() => setState("confirm")}>
          Send to CMS
        </button>
      )}
      {state === "error" ? <span className="cms-write-result cms-write-error">{message}</span> : null}
    </span>
  );
}
