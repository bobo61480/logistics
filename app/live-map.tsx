"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { geocode, geocodeLabel, type LatLng } from "./geo";

const LEAFLET_CSS = "https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.css";
const LEAFLET_JS = "https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js";
const TRACKING_ENDPOINT =
  process.env.NEXT_PUBLIC_LOGISTICS_TRACKING_URL ?? "/api/logistics/tracking";
const CONTINENTAL_US_CENTER: LatLng = [39.5, -98.35];
const PORT_LOOKUP: Record<string, { label: string; coords: LatLng }> = {
  LAX: { label: "Port of Los Angeles", coords: [33.7395, -118.2601] },
  LGB: { label: "Port of Long Beach", coords: [33.754, -118.2165] },
};

type Carrier = "ups" | "fedex" | "usps";

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

type TrackingResult = {
  carrier: Carrier;
  number: string;
  ok: boolean;
  configured: boolean;
  status?: string;
  city?: string;
  state?: string;
  country?: string;
  timestamp?: string;
  error?: string;
};

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
}: {
  milestones: MilestoneShipment[];
  trackable: TrackableShipment[];
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<any>(null);
  const layerRef = useRef<any>(null);
  const [ready, setReady] = useState(false);
  const [mapError, setMapError] = useState("");
  const [tracking, setTracking] = useState<Record<string, TrackingResult>>({});
  const [configured, setConfigured] = useState<Record<Carrier, boolean> | null>(null);
  const [trackingLoading, setTrackingLoading] = useState(false);

  const trackableKey = useMemo(
    () => trackable.map((item) => `${item.carrier}:${item.trackingNumber}`).join("|"),
    [trackable],
  );

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
    if (!trackable.length) {
      setConfigured((current) => current ?? { ups: false, fedex: false, usps: false });
      return;
    }
    let cancelled = false;
    setTrackingLoading(true);
    fetch(TRACKING_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requests: trackable.map((item) => ({ carrier: item.carrier, number: item.trackingNumber })),
      }),
    })
      .then((response) => response.json() as Promise<{ ok?: boolean; results?: TrackingResult[]; configured?: Record<Carrier, boolean> }>)
      .then((data) => {
        if (cancelled || !data?.ok) return;
        const byNumber: Record<string, TrackingResult> = {};
        (data.results ?? []).forEach((result) => {
          byNumber[`${result.carrier}:${result.number}`] = result;
        });
        setTracking(byNumber);
        setConfigured(data.configured ?? null);
      })
      .catch(() => {
        /* Tracking is best-effort — the map still shows inbound milestones without it. */
      })
      .finally(() => {
        if (!cancelled) setTrackingLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // trackableKey is a stable string fingerprint of trackable — safe dep
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackableKey]);

  useEffect(() => {
    if (!ready || !mapRef.current || !layerRef.current) return;
    const L = (window as any).L;
    layerRef.current.clearLayers();
    const bounds: LatLng[] = [];

    milestones.forEach((shipment) => {
      const origin = originForMode(shipment.mode);
      const destination = PORT_LOOKUP[shipment.pod ?? ""] ?? PORT_LOOKUP.LAX;
      const isAir = /air/i.test(shipment.mode ?? "");
      const icon = L.divIcon({
        className: "",
        html: `<span class="live-map-pin ${isAir ? "live-map-pin-air" : "live-map-pin-ocean"}">${isAir ? "✈️" : "🚢"}</span>`,
        iconSize: [22, 22],
      });
      L.marker(destination.coords, { icon })
        .bindPopup(
          `<strong>${shipment.title}</strong><br/>${shipment.mode ?? "Inbound"} · ${destination.label}` +
            `${shipment.vessel ? `<br/>Vessel: ${shipment.vessel}` : ""}` +
            `${shipment.eta ? `<br/>ETA: ${shipment.eta}` : ""}` +
            `${shipment.status ? `<br/>Status: ${shipment.status}` : ""}`,
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
          `<strong>${item.title}</strong><br/>${item.carrier.toUpperCase()} ${item.trackingNumber}` +
            `<br/>${[result.city, result.state].filter(Boolean).join(", ") || "Location unavailable"}` +
            `${result.status ? `<br/>${result.status}` : ""}` +
            `${result.timestamp ? `<br/><small>${new Date(result.timestamp).toLocaleString()}</small>` : ""}`,
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
          No carrier tracking connected yet — UPS/FedEx/USPS API credentials aren&apos;t configured, so parcel
          positions won&apos;t appear. Ocean/air port milestones above still work without them.
        </p>
      )}
      {trackingLoading && <p className="live-map-hint">Refreshing carrier tracking…</p>}
    </section>
  );
}
