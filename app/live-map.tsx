"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { geocode, geocodeLabel, type LatLng } from "./geo";

const LEAFLET_CSS = "https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.css";
const LEAFLET_JS = "https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js";
const TRACKING_ENDPOINT =
  process.env.NEXT_PUBLIC_LOGISTICS_TRACKING_URL ?? "/api/logistics/tracking";
// Must match tracking-command.ts's MAX_REQUESTS — the Worker silently drops anything past
// that many entries in a single call, so a board with more trackable parcels than this needs
// to split across multiple requests or the extras vanish from the map with no error.
const TRACKING_BATCH_SIZE = 25;
// Re-poll carrier tracking on this cadence — tracking-command.ts caches each
// carrier+number lookup for 15 minutes anyway, so polling more often than that
// wouldn't surface anything new, just spend rate-limit budget re-asking.
const TRACKING_POLL_MS = 2 * 60 * 60 * 1000;
const CONTINENTAL_US_CENTER: LatLng = [39.5, -98.35];
const PORT_LOOKUP: Record<string, { label: string; coords: LatLng }> = {
  LAX: { label: "Port of Los Angeles", coords: [33.7395, -118.2601] },
  LGB: { label: "Port of Long Beach", coords: [33.754, -118.2165] },
};
// Air imports share the same "LAX" pod code as ocean imports, but that code means the
// seaport for ocean and the airport for air — route air milestones here instead.
const AIRPORT_LOOKUP: Record<string, { label: string; coords: LatLng }> = {
  LAX: { label: "Los Angeles International Airport", coords: [33.9416, -118.4085] },
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export type Carrier = "ups" | "fedex" | "usps" | "dhl";

export type MilestoneShipment = {
  id: string;
  title: string;
  mode?: string;
  pod?: string;
  eta?: string;
  status?: string;
  vessel?: string;
};

export type TrackableShipment = {
  id: string;
  title: string;
  carrier: Carrier;
  trackingNumber: string;
  direction: "inbound" | "outbound";
  status?: string;
};

export type TrackingResult = {
  carrier: Carrier;
  number: string;
  ok: boolean;
  configured: boolean;
  status?: string;
  city?: string;
  state?: string;
  country?: string;
  timestamp?: string;
  trackingUrl?: string;
  error?: string;
};

/**
 * Shared carrier-tracking poll for TrackableShipment lists. Hoisted out of
 * LiveMapPanel so a page can fetch each carrier+number combination once and
 * hand the results to multiple cards (the map, the outbound small-parcel
 * schedule) instead of every consumer opening its own duplicate batch of
 * requests against the shared per-IP rate limiter.
 */
export function useParcelTracking(trackable: TrackableShipment[]) {
  const [tracking, setTracking] = useState<Record<string, TrackingResult>>({});
  const [configured, setConfigured] = useState<Record<Carrier, boolean> | null>(null);
  const [loading, setLoading] = useState(false);

  const trackableKey = useMemo(
    () => trackable.map((item) => `${item.carrier}:${item.trackingNumber}`).join("|"),
    [trackable],
  );

  useEffect(() => {
    if (!trackable.length) {
      setConfigured((current) => current ?? { ups: false, fedex: false, usps: false, dhl: false });
      return;
    }
    let cancelled = false;

    const poll = () => {
      setLoading(true);
      const unique = Array.from(
        new Map(trackable.map((item) => [`${item.carrier}:${item.trackingNumber}`, item])).values(),
      );
      const batches: TrackableShipment[][] = [];
      for (let i = 0; i < unique.length; i += TRACKING_BATCH_SIZE) {
        batches.push(unique.slice(i, i + TRACKING_BATCH_SIZE));
      }

      Promise.all(
        batches.map((batch) =>
          fetch(TRACKING_ENDPOINT, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              requests: batch.map((item) => ({ carrier: item.carrier, number: item.trackingNumber })),
            }),
          }).then((response) => response.json() as Promise<{ ok?: boolean; results?: TrackingResult[]; configured?: Record<Carrier, boolean> }>),
        ),
      )
        .then((batchResponses) => {
          if (cancelled) return;
          const byNumber: Record<string, TrackingResult> = {};
          let configuredResult: Record<Carrier, boolean> | null = null;
          batchResponses.forEach((data) => {
            if (!data?.ok) return;
            (data.results ?? []).forEach((result) => {
              byNumber[`${result.carrier}:${result.number}`] = result;
            });
            if (data.configured) configuredResult = data.configured;
          });
          setTracking(byNumber);
          setConfigured(configuredResult);
        })
        .catch(() => {
          /* Tracking is best-effort — cards still show scheduled data without it. */
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    };

    poll();
    const interval = window.setInterval(poll, TRACKING_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
    // trackableKey is a stable string fingerprint of trackable — safe dep
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackableKey]);

  return { tracking, configured, loading };
}

function originForMode(mode?: string): { label: string; coords: LatLng } {
  const isAir = /air/i.test(mode ?? "");
  return isAir
    ? { label: "Incheon, KR (air origin)", coords: geocode("Incheon", undefined, "KR") ?? [37.4563, 126.7052] }
    : { label: "Busan, KR (ocean origin)", coords: geocode("Busan", undefined, "KR") ?? [35.1796, 129.0756] };
}

function loadLeaflet(): Promise<any> {
  if (typeof window === "undefined") return Promise.reject(new Error("No window"));
  const w = window as any;
  if (w.L) return Promise.resolve(w.L);
  if (w.__leafletLoading) return w.__leafletLoading;

  w.__leafletLoading = new Promise((resolve, reject) => {
    if (!document.querySelector(`link[href="${LEAFLET_CSS}"]`)) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = LEAFLET_CSS;
      document.head.appendChild(link);
    }
    const script = document.createElement("script");
    script.src = LEAFLET_JS;
    script.async = true;
    script.onload = () => resolve((window as any).L);
    script.onerror = () => reject(new Error("Failed to load the map library"));
    document.body.appendChild(script);
  });
  return w.__leafletLoading;
}

export function LiveMapPanel({
  milestones,
  trackable,
  tracking,
  configured,
  trackingLoading,
}: {
  milestones: MilestoneShipment[];
  trackable: TrackableShipment[];
  tracking: Record<string, TrackingResult>;
  configured: Record<Carrier, boolean> | null;
  trackingLoading: boolean;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<any>(null);
  const layerRef = useRef<any>(null);
  const [ready, setReady] = useState(false);
  const [mapError, setMapError] = useState("");

  useEffect(() => {
    let cancelled = false;
    loadLeaflet()
      .then(() => {
        if (cancelled || !containerRef.current || mapRef.current) return;
        const L = (window as any).L;
        const map = L.map(containerRef.current, { scrollWheelZoom: false }).setView(CONTINENTAL_US_CENTER, 4);
        L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
          attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
          maxZoom: 18,
        }).addTo(map);
        layerRef.current = L.layerGroup().addTo(map);
        mapRef.current = map;
        setReady(true);
      })
      .catch((error) => setMapError(error instanceof Error ? error.message : "Map failed to load"));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!ready || !mapRef.current || !layerRef.current) return;
    const L = (window as any).L;
    layerRef.current.clearLayers();
    const bounds: LatLng[] = [];

    milestones.forEach((shipment) => {
      const origin = originForMode(shipment.mode);
      const isAir = /air/i.test(shipment.mode ?? "");
      const destination = (isAir ? AIRPORT_LOOKUP[shipment.pod ?? ""] : undefined)
        ?? PORT_LOOKUP[shipment.pod ?? ""]
        ?? PORT_LOOKUP.LAX;
      const icon = L.divIcon({
        className: "",
        html: `<span class="live-map-pin ${isAir ? "live-map-pin-air" : "live-map-pin-ocean"}">${isAir ? "✈️" : "🚢"}</span>`,
        iconSize: [22, 22],
      });
      L.marker(destination.coords, { icon })
        .bindPopup(
          `<strong>${escapeHtml(shipment.title)}</strong><br/>${escapeHtml(shipment.mode ?? "Inbound")} · ${escapeHtml(destination.label)}` +
            `${shipment.vessel ? `<br/>Vessel: ${escapeHtml(shipment.vessel)}` : ""}` +
            `${shipment.eta ? `<br/>ETA: ${escapeHtml(shipment.eta)}` : ""}` +
            `${shipment.status ? `<br/>Status: ${escapeHtml(shipment.status)}` : ""}`,
        )
        .addTo(layerRef.current);
      L.polyline([origin.coords, destination.coords], { color: isAir ? "#2563eb" : "#0e7490", weight: 2, dashArray: "4 6", opacity: 0.7 })
        .addTo(layerRef.current);
      bounds.push(origin.coords, destination.coords);
    });

    trackable.forEach((item) => {
      const result = tracking[`${item.carrier}:${item.trackingNumber}`];
      if (!result?.ok) return;
      const coords = geocode(result.city, result.state, result.country);
      if (!coords) return;
      const icon = L.divIcon({
        className: "",
        html: `<span class="live-map-pin live-map-pin-parcel">📦</span>`,
        iconSize: [20, 20],
      });
      L.marker(coords, { icon })
        .bindPopup(
          `<strong>${escapeHtml(item.title)}</strong><br/>${escapeHtml(item.carrier.toUpperCase())} ${escapeHtml(item.trackingNumber)}` +
            `<br/>${escapeHtml([result.city, result.state].filter(Boolean).join(", ")) || "Location unavailable"}` +
            `${result.status ? `<br/>${escapeHtml(result.status)}` : ""}` +
            `${result.timestamp ? `<br/><small>${escapeHtml(new Date(result.timestamp).toLocaleString())}</small>` : ""}` +
            `${result.trackingUrl ? `<br/><a href="${escapeHtml(result.trackingUrl)}" target="_blank" rel="noreferrer">Open official carrier tracking ↗</a>` : ""}` +
            `${result.carrier === "dhl" ? "<br/><small>Delivered by Deutsche Post DHL Group</small>" : ""}`,
        )
        .addTo(layerRef.current);
      bounds.push(coords);
    });

    if (bounds.length) {
      const L2 = (window as any).L;
      mapRef.current.fitBounds(L2.latLngBounds(bounds).pad(0.25), { maxZoom: 6 });
    }
  }, [ready, milestones, trackable, tracking]);

  const trackedCount = trackable.filter((item) => tracking[`${item.carrier}:${item.trackingNumber}`]?.ok).length;
  const anyCarrierConfigured = configured ? Object.values(configured).some(Boolean) : true;

  return (
    <section className="inventory-panel live-map-panel" aria-label="Live Shipment Map">
      <div className="panel-heading inventory-heading">
        <div>
          <p className="eyebrow">INBOUND MILESTONES · OUTBOUND LAST-KNOWN SCAN</p>
          <h2>Live Shipment Map</h2>
        </div>
        <div className="inventory-total">
          <strong>{milestones.length + trackedCount}</strong>
          <span>pinned</span>
        </div>
      </div>
      {mapError && <p className="live-map-error">{mapError}</p>}
      <div className="live-map-container" ref={containerRef} />
      <div className="live-map-legend">
        <span><span className="live-map-pin live-map-pin-ocean" aria-hidden="true">🚢</span> Ocean import (port milestone)</span>
        <span><span className="live-map-pin live-map-pin-air" aria-hidden="true">✈️</span> Air import (port milestone)</span>
        <span><span className="live-map-pin live-map-pin-parcel" aria-hidden="true">📦</span> Parcel — last carrier scan</span>
      </div>
      {!anyCarrierConfigured && trackable.length > 0 && (
        <p className="live-map-hint">
          No carrier tracking connected yet — UPS/FedEx/USPS/DHL API credentials aren&apos;t configured, so parcel
          positions won&apos;t appear. Ocean/air port milestones above still work without them.
        </p>
      )}
      {trackingLoading && <p className="live-map-hint">Refreshing carrier tracking…</p>}
    </section>
  );
}
