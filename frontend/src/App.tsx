// Operator Control Room Dashboard (React + Leaflet + Socket.io).
// Built for 2 AM control room operators: renders real-time grid map, ticket queue, ticket details with AI dispatch briefs, and fault simulator modal.

import { useState, useEffect, useCallback, useRef } from "react";
import {
  api,
  type Ticket,
  type PoleData,
  type NetworkStats,
  type NetworkInfo,
} from "./services/api";
import { useSocket } from "./hooks/useSocket";
import L from "leaflet";

/* ── Helpers ────────────────────────────────────────────────── */
const timeAgo = (ts: string): string => {
  const diff = Date.now() - new Date(ts).getTime();
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
};

const fmtFull = (ts: string): string =>
  new Date(ts).toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

const confClass = (c: number) =>
  c >= 0.75 ? "high" : c >= 0.5 ? "medium" : "low";

const NEXT: Record<string, string> = {
  detected: "acknowledged",
  acknowledged: "crew_assigned",
  crew_assigned: "resolved",
  resolved: "verified",
  verified: "closed",
};

const NEXT_LABEL: Record<string, string> = {
  detected: "Acknowledge",
  acknowledged: "Assign crew",
  crew_assigned: "Mark resolved",
  resolved: "Verify",
  verified: "Close",
};

/* ── Live clock ─────────────────────────────────────────────── */
function Clock() {
  const [t, setT] = useState(() =>
    new Date().toLocaleTimeString("en-IN", { hour12: false })
  );
  useEffect(() => {
    const id = setInterval(
      () => setT(new Date().toLocaleTimeString("en-IN", { hour12: false })),
      1000
    );
    return () => clearInterval(id);
  }, []);
  return <span className="header-clock">{t}</span>;
}

/* ══════════════════════════════════════════════════════════════
   APP
   ══════════════════════════════════════════════════════════════ */
export function App() {
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [poles, setPoles] = useState<PoleData[]>([]);
  const [stats, setStats] = useState<NetworkStats | null>(null);
  const [networkInfo, setNetworkInfo] = useState<NetworkInfo | null>(null);
  const [selected, setSelected] = useState<Ticket | null>(null);
  const [tab, setTab] = useState<"incidents" | "simulator">("incidents");
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<{ msg: string; kind: string } | null>(null);

  /* sim state */
  const [simDt, setSimDt] = useState("");
  const [simPole, setSimPole] = useState("");
  const [simOut, setSimOut] = useState("");

  const normalizeTicket = (t: any): Ticket => {
    if (!t) return t;
    return {
      ...t,
      dtId: t.dtId || t.dt_id || "—",
      feederId: t.feederId || t.feeder_id || "—",
      spanStartPole: t.spanStartPole || t.span_start_pole || null,
      spanEndPole: t.spanEndPole || t.span_end_pole || null,
      pincode: t.pincode || t.pin_code || null,
      affectedPoleCount: Number(t.affectedPoleCount ?? t.affected_pole_count ?? 0),
      affectedHouseholds: t.affectedHouseholds ?? t.affected_households ?? 0,
      confidence: Number(t.confidence ?? 0),
      confidenceReason: t.confidenceReason || t.confidence_reason || "",
      dispatchBrief: t.dispatchBrief || t.dispatch_brief || null,
      status: t.status || "detected",
      createdAt: t.createdAt || t.created_at || new Date().toISOString(),
      acknowledgedAt: t.acknowledgedAt || t.acknowledged_at || null,
      crewAssignedAt: t.crewAssignedAt || t.crew_assigned_at || null,
      resolvedAt: t.resolvedAt || t.resolved_at || null,
      verifiedAt: t.verifiedAt || t.verified_at || null,
      closedAt: t.closedAt || t.closed_at || null,
    };
  };

  /* load */
  const load = useCallback(async () => {
    setLoading(false);
    api.getTickets()
      .then((td) => setTickets((td || []).map(normalizeTicket)))
      .catch((err) => console.error("Tickets error:", err));
    api.getStats().then((sd) => setStats(sd)).catch((err) => console.error("Stats error:", err));
    api.getNetworkInfo().then((ni) => setNetworkInfo(ni)).catch((err) => console.error("NetworkInfo error:", err));
    api.getPoles().then((pd) => setPoles(pd || [])).catch((err) => console.error("Poles error:", err));
  }, []);

  useEffect(() => { load(); }, [load]);

  /* real-time */
  useSocket("ticket:created", (t: any) => {
    const norm = normalizeTicket(t);
    setTickets((prev) => [norm, ...prev]);
    notify(`Fault detected — incident #${norm.id}`, "fault");
    refreshStats();
  });
  useSocket("ticket:updated", (t: any) => {
    const norm = normalizeTicket(t);
    setTickets((prev) => prev.map((x) => (x.id === norm.id ? norm : x)));
    if (selected?.id === norm.id) setSelected(norm);
    if (norm.status === "verified")
      notify(`Incident #${norm.id} verified — grid restored`, "success");
    refreshStats();
  });
  useSocket("poles:updated", () => { refreshPoles(); refreshStats(); });

  const refreshStats = async () => {
    try { setStats(await api.getStats()); } catch {}
  };
  const refreshPoles = async () => {
    try { setPoles(await api.getPoles()); } catch {}
  };

  const notify = (msg: string, kind: string) => {
    setToast({ msg, kind });
    setTimeout(() => setToast(null), 5000);
  };

  /* ticket actions */
  const advance = async (id: number, next: string) => {
    try {
      const u = await api.updateTicketStatus(id, next);
      setTickets((prev) => prev.map((t) => (t.id === id ? u : t)));
      if (selected?.id === id) setSelected(u);
      notify(`Incident #${id} — ${next.replace("_", " ")}`, "success");
    } catch (err: any) {
      notify(err.message || "Failed", "fault");
    }
  };

  /* sim */
  const injectFault = async (type: string) => {
    if (!simDt) { notify("Select a transformer", "fault"); return; }
    try {
      setSimOut("Running…");
      const r = await api.injectFault({ faultType: type, dtId: simDt, poleId: simPole || undefined });
      setSimOut(JSON.stringify(r, null, 2));
      setTimeout(load, 2000);
    } catch (e: any) { setSimOut(JSON.stringify(e, null, 2)); }
  };

  const repair = async () => {
    if (!simDt) { notify("Select a transformer", "fault"); return; }
    try {
      setSimOut("Running…");
      const r = await api.repair({ dtId: simDt });
      setSimOut(JSON.stringify(r, null, 2));
      setTimeout(load, 2000);
    } catch (e: any) { setSimOut(JSON.stringify(e, null, 2)); }
  };

  const killSensor = async () => {
    if (!simPole) { notify("Enter a pole ID", "fault"); return; }
    try {
      setSimOut("Running…");
      const r = await api.killSensor(simPole);
      setSimOut(JSON.stringify(r, null, 2));
      setTimeout(load, 2000);
    } catch (e: any) { setSimOut(JSON.stringify(e, null, 2)); }
  };

  const active = tickets.filter((t) => !["closed", "verified"].includes(t.status));

  /* loading */
  if (loading) {
    return (
      <div className="loading-screen">
        <div className="loading-ring" />
        <div className="loading-label">Connecting</div>
      </div>
    );
  }

  /* ── render ─────────────────────────────────────────────── */
  return (
    <div className="shell">

      {/* ── HEADER ──────────────────────────────────────── */}
      <header className="header">
        <div className="header-left">
          <span className="header-title">
            KSPDB Fault Control
            <span>Karnataka Power Distribution</span>
          </span>
          <div className="header-sep" />
          {stats && (
            <div className="status-strip">
              <div className="status-chip status-chip--live" title="Live poles">
                <span className="dot" />
                {stats.poles.live} live poles
              </div>
              <div className="status-chip" style={{ background: "rgba(255,255,255,0.06)", color: "#e2e8f0", borderColor: "rgba(255,255,255,0.12)" }} title="Distribution Transformers">
                ⚡ {stats.transformers || 80} DTs
              </div>
              <div className="status-chip" style={{ background: "rgba(255,255,255,0.06)", color: "#e2e8f0", borderColor: "rgba(255,255,255,0.12)" }} title="Grid Feeders">
                🔌 31 Feeders
              </div>
              {stats.poles.dark > 0 && (
                <div className="status-chip status-chip--dark" title="Dark poles">
                  <span className="dot" />
                  {stats.poles.dark} dark
                </div>
              )}
              {stats.poles.unknown > 0 && (
                <div className="status-chip status-chip--unk" title="Unknown">
                  <span className="dot" />
                  {stats.poles.unknown} unknown
                </div>
              )}
              {active.length > 0 && (
                <div className="status-chip status-chip--inc" title="Active incidents">
                  <span className="dot" />
                  {active.length} incident{active.length !== 1 ? "s" : ""}
                </div>
              )}
            </div>
          )}
        </div>
        <div className="header-right">
          <Clock />
        </div>
      </header>

      {/* ── WORKSPACE ───────────────────────────────────── */}
      <div className="workspace">

        {/* ── SIDEBAR ─────────────────────────────────── */}
        <aside className="sidebar">

          {/* Tabs */}
          <div className="sidebar-tabs">
            <button
              id="tab-incidents"
              className={`sidebar-tab${tab === "incidents" ? " active" : ""}`}
              onClick={() => setTab("incidents")}
            >
              Incidents
              {active.length > 0 && (
                <span className="tab-badge">{active.length}</span>
              )}
            </button>
            <button
              id="tab-simulator"
              className={`sidebar-tab${tab === "simulator" ? " active" : ""}`}
              onClick={() => setTab("simulator")}
            >
              Simulator
            </button>
          </div>

          {/* Body */}
          <div className="sidebar-body">

            {/* ── INCIDENTS TAB ───────────────────────── */}
            {tab === "incidents" && (
              <>
                {selected ? (

                  /* ── DETAIL VIEW ──────────────────── */
                  <div className="detail">
                    <div className="detail-header">
                      <div className="detail-nav">
                        <button
                          id="btn-back"
                          className="btn-back"
                          onClick={() => setSelected(null)}
                        >
                          ← Incidents{tickets.length > 1 ? ` (${tickets.length})` : ""}
                        </button>
                      </div>
                      <div className="detail-title-row">
                        <div>
                          <div className="detail-id">
                            #{String(selected.id).padStart(4, "0")}
                          </div>
                          <div className="detail-subline">
                            Detected {timeAgo(selected.createdAt)} ago &middot; {selected.feederId}
                          </div>
                        </div>
                        <div className="detail-badges">
                          <span className={`pill pill--${selected.status}`}>
                            <span className="dot" />
                            {selected.status.replace("_", " ")}
                          </span>
                          <span className={`pill pill--${selected.faultType}`}>
                            {selected.faultType}
                          </span>
                        </div>
                      </div>
                    </div>

                    <div className="detail-body">

                      {/* Location */}
                      <div className="section">
                        <div className="section-title">Location</div>
                        <div className="section-body">
                          <div className="kv-grid">
                            <div className="kv">
                              <span className="kv-key">Transformer</span>
                              <span className="kv-val">{selected.dtId || (selected as any).dt_id || "—"}</span>
                            </div>
                            <div className="kv">
                              <span className="kv-key">Feeder</span>
                              <span className="kv-val">{selected.feederId || (selected as any).feeder_id || "—"}</span>
                            </div>
                            <div className="kv">
                              <span className="kv-key">Coordinates</span>
                              <span className="kv-val">
                                {selected.lat ? selected.lat.toFixed(5) : "—"}, {selected.lon ? selected.lon.toFixed(5) : "—"}
                              </span>
                            </div>
                            <div className="kv">
                              <span className="kv-key">PIN Code</span>
                              <span className="kv-val">{selected.pincode || (selected as any).pin_code || "—"}</span>
                            </div>
                            {selected.spanStartPole && (
                              <div className="kv">
                                <span className="kv-key">Last live pole</span>
                                <span className="kv-val">{selected.spanStartPole}</span>
                              </div>
                            )}
                            {selected.spanEndPole && (
                              <div className="kv">
                                <span className="kv-key">First dark pole</span>
                                <span className="kv-val">{selected.spanEndPole}</span>
                              </div>
                            )}
                          </div>
                        </div>
                      </div>

                      {/* Impact */}
                      <div className="section">
                        <div className="section-title">Impact</div>
                        <div className="section-body">
                          <div className="kv-grid">
                            <div className="kv">
                              <span className="kv-key">Poles affected</span>
                              <span className="kv-val big red">{selected.affectedPoleCount ?? (selected as any).affected_pole_count ?? 0}</span>
                            </div>
                            <div className="kv">
                              <span className="kv-key">Households</span>
                              <span className="kv-val big amber">
                                ~{selected.affectedHouseholds ?? (selected as any).affected_households ?? "?"}
                              </span>
                            </div>
                          </div>
                        </div>
                      </div>

                      {/* Confidence */}
                      <div className="section">
                        <div className="section-title">Detection confidence</div>
                        <div className="section-body">
                          <div className="conf-row">
                            <span className="conf-label">Score</span>
                            <span className="conf-pct">
                              {(selected.confidence * 100).toFixed(0)}%
                            </span>
                          </div>
                          <div className="conf-track">
                            <div
                              className={`conf-fill ${confClass(selected.confidence)}`}
                              style={{ width: `${selected.confidence * 100}%` }}
                            />
                          </div>
                          {selected.confidenceReason && (
                            <div className="conf-reason">{selected.confidenceReason}</div>
                          )}
                        </div>
                      </div>

                      {/* Timeline */}
                      <div className="section">
                        <div className="section-title">Timeline</div>
                        <div className="section-body">
                          <div className="timeline">
                            <div className="tl-item">
                              <span className="tl-dot detected" />
                              <div className="tl-content">
                                <div className="tl-label">Detected</div>
                                <div className="tl-time">{fmtFull(selected.createdAt)}</div>
                              </div>
                            </div>
                            {selected.acknowledgedAt && (
                              <div className="tl-item">
                                <span className="tl-dot acknowledged" />
                                <div className="tl-content">
                                  <div className="tl-label">Acknowledged</div>
                                  <div className="tl-time">{fmtFull(selected.acknowledgedAt)}</div>
                                </div>
                              </div>
                            )}
                            {selected.crewAssignedAt && (
                              <div className="tl-item">
                                <span className="tl-dot crew" />
                                <div className="tl-content">
                                  <div className="tl-label">Crew assigned</div>
                                  <div className="tl-time">{fmtFull(selected.crewAssignedAt)}</div>
                                </div>
                              </div>
                            )}
                            {selected.resolvedAt && (
                              <div className="tl-item">
                                <span className="tl-dot resolved" />
                                <div className="tl-content">
                                  <div className="tl-label">Resolved</div>
                                  <div className="tl-time">{fmtFull(selected.resolvedAt)}</div>
                                </div>
                              </div>
                            )}
                            {selected.verifiedAt && (
                              <div className="tl-item">
                                <span className="tl-dot verified" />
                                <div className="tl-content">
                                  <div className="tl-label">Verified</div>
                                  <div className="tl-time">{fmtFull(selected.verifiedAt)}</div>
                                </div>
                              </div>
                            )}
                            {selected.closedAt && (
                              <div className="tl-item">
                                <span className="tl-dot closed" />
                                <div className="tl-content">
                                  <div className="tl-label">Closed</div>
                                  <div className="tl-time">{fmtFull(selected.closedAt)}</div>
                                </div>
                              </div>
                            )}
                          </div>
                        </div>
                      </div>

                      {/* Dispatch brief */}
                      <div className="section">
                        <div className="section-title">Dispatch brief</div>
                        <div className="section-body">
                          {selected.dispatchBrief ? (
                            <div className="brief-text">{selected.dispatchBrief}</div>
                          ) : (
                            <button
                              id="btn-gen-brief"
                              className="btn btn-block"
                              onClick={async () => {
                                try {
                                  notify("Generating brief…", "success");
                                  const r = await api.generateDispatchBrief(selected.id);
                                  const u = { ...selected, dispatchBrief: r.brief };
                                  setSelected(u);
                                  setTickets((prev) =>
                                    prev.map((t) => (t.id === u.id ? u : t))
                                  );
                                  notify(`Brief ready (${r.source})`, "success");
                                } catch (e: any) {
                                  notify(e.message || "Failed", "fault");
                                }
                              }}
                            >
                              Generate dispatch brief
                            </button>
                          )}
                        </div>
                      </div>

                    </div>

                    {/* Footer action */}
                    {NEXT[selected.status] && (
                      <div className="detail-footer">
                        <button
                          id="btn-advance"
                          className="btn btn-primary btn-lg btn-block"
                          onClick={() => advance(selected.id, NEXT[selected.status])}
                        >
                          {NEXT_LABEL[selected.status]}
                        </button>
                      </div>
                    )}
                  </div>

                ) : (

                  /* ── LIST VIEW ────────────────────── */
                  <div className="incident-list">
                    <div className="incident-list-meta">
                      <span className="incident-list-count">
                        {tickets.length === 0 ? "No incidents" : `${tickets.length} incident${tickets.length !== 1 ? "s" : ""}`}
                      </span>
                    </div>

                    {tickets.length === 0 ? (
                      <div className="empty">
                        <div className="empty-title">All clear</div>
                        <div className="empty-desc">
                          No active faults. The grid is operating normally.
                        </div>
                      </div>
                    ) : (
                      <>
                        {/* Column headers */}
                        <div className="incident-cols">
                          <span className="incident-col-label">ID</span>
                          <span className="incident-col-label">Fault / Location</span>
                          <span className="incident-col-label" style={{ textAlign: "right" }}>Status</span>
                          <span className="incident-col-label" style={{ textAlign: "right" }}>Age</span>
                        </div>

                        {tickets.map((t) => (
                          <div
                            key={t.id}
                            id={`incident-${t.id}`}
                            className={`incident-row s-${t.status}${(selected as Ticket | null)?.id === t.id ? " selected" : ""}`}
                            onClick={() => setSelected(t)}
                          >
                            <span className="inc-id">
                              #{String(t.id).padStart(4, "0")}
                            </span>
                            <div className="inc-main">
                              <div className="inc-type">{t.faultType} fault</div>
                              <div className="inc-loc">
                                {t.spanStartPole
                                  ? `${t.spanStartPole} → ${t.spanEndPole}`
                                  : t.dtId}
                                {t.pincode && ` · ${t.pincode}`}
                              </div>
                            </div>
                            <span className={`inc-status s-${t.status}`}>
                              {t.status.replace("_", " ")}
                            </span>
                            <span className="inc-age">{timeAgo(t.createdAt)}</span>
                          </div>
                        ))}
                      </>
                    )}
                  </div>
                )}
              </>
            )}

            {/* ── SIMULATOR TAB ───────────────────────── */}
            {tab === "simulator" && (
              <div className="sim">

                {/* Inject fault */}
                <div className="sim-block">
                  <div className="sim-block-header">
                    <div className="sim-block-title">Inject fault</div>
                    <div className="sim-block-desc">Simulate a grid failure</div>
                  </div>
                  <div className="sim-block-body">
                    <select
                      id="sim-dt-select"
                      className="sim-select"
                      value={simDt}
                      onChange={(e) => { setSimDt(e.target.value); setSimPole(""); }}
                    >
                      <option value="">Select transformer…</option>
                      {networkInfo?.dts.map((d: any) => (
                        <option key={d.dtId} value={d.dtId}>
                          {d.dtId} ({d.feederId}) — {d.poleCount} poles
                        </option>
                      ))}
                    </select>

                    {simDt && (
                      <select
                        id="sim-pole-select"
                        className="sim-select"
                        value={simPole}
                        onChange={(e) => setSimPole(e.target.value)}
                      >
                        <option value="">Select pole (span fault)…</option>
                        {networkInfo?.dts
                          .find((d: any) => d.dtId === simDt)
                          ?.samplePoles.map((p: string) => (
                            <option key={p} value={p}>{p}</option>
                          ))}
                      </select>
                    )}

                    <div className="sim-row">
                      <button
                        id="btn-span-fault"
                        className="btn btn-danger"
                        style={{ flex: 1 }}
                        onClick={() => injectFault("span")}
                        disabled={!simDt || !simPole}
                      >
                        Span fault
                      </button>
                      <button
                        id="btn-dt-fault"
                        className="btn btn-danger"
                        style={{ flex: 1 }}
                        onClick={() => injectFault("dt")}
                        disabled={!simDt}
                      >
                        DT fault
                      </button>
                    </div>
                  </div>
                </div>

                {/* Repair */}
                <div className="sim-block">
                  <div className="sim-block-header">
                    <div className="sim-block-title">Repair</div>
                    <div className="sim-block-desc">Restore all poles in selected transformer</div>
                  </div>
                  <div className="sim-block-body">
                    <button
                      id="btn-repair"
                      className="btn btn-success btn-block"
                      onClick={repair}
                      disabled={!simDt}
                    >
                      Repair {simDt || "—"}
                    </button>
                  </div>
                </div>

                {/* Kill sensor */}
                <div className="sim-block">
                  <div className="sim-block-header">
                    <div className="sim-block-title">Kill sensor</div>
                    <div className="sim-block-desc">Disable reporting; power remains on</div>
                  </div>
                  <div className="sim-block-body">
                    <input
                      id="sim-pole-input"
                      className="sim-select"
                      placeholder="Pole ID (e.g. P-000042)"
                      value={simPole}
                      onChange={(e) => setSimPole(e.target.value)}
                    />
                    <button
                      id="btn-kill-sensor"
                      className="btn btn-block"
                      onClick={killSensor}
                      disabled={!simPole}
                    >
                      Kill sensor
                    </button>
                  </div>
                </div>

                {simOut && <div className="sim-output">{simOut}</div>}
              </div>
            )}

          </div>
        </aside>

        {/* ── MAP ─────────────────────────────────────── */}
        <div className="map-wrap">
          <MapView
            poles={poles}
            tickets={tickets.filter((t) => t.status !== "closed")}
            selectedTicket={selected}
            onSelect={setSelected}
          />

          <div className="map-legend">
            <div className="map-legend-title">Legend</div>
            <div className="map-legend-row">
              <span className="map-legend-dot live" />
              Live pole
            </div>
            <div className="map-legend-row">
              <span className="map-legend-dot dark" />
              Dark pole
            </div>
            <div className="map-legend-row">
              <span className="map-legend-dot unknown" />
              Unknown
            </div>
            <div className="map-legend-row">
              <span className="map-legend-dot fault" />
              Fault location
            </div>
          </div>
        </div>
      </div>

      {/* ── TOAST ───────────────────────────────────── */}
      {toast && (
        <div className={`toast toast--${toast.kind}`} role="status">
          {toast.msg}
        </div>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════
   MAP COMPONENT
   ══════════════════════════════════════════════════════════════ */
function MapView({
  poles,
  tickets,
  selectedTicket,
  onSelect,
}: {
  poles: PoleData[];
  tickets: Ticket[];
  selectedTicket: Ticket | null;
  onSelect: (t: Ticket) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const poleLayer = useRef<L.LayerGroup | null>(null);
  const ticketLayer = useRef<L.LayerGroup | null>(null);
  const hasFitBounds = useRef(false);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = L.map(containerRef.current, {
      center: [12.97, 77.59],
      zoom: 13,
      zoomControl: true,
    });

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '© <a href="https://openstreetmap.org">OpenStreetMap</a>',
      maxZoom: 19,
    }).addTo(map);

    poleLayer.current = L.layerGroup().addTo(map);
    ticketLayer.current = L.layerGroup().addTo(map);
    mapRef.current = map;

    // Handle container resize automatically
    const observer = new ResizeObserver(() => {
      map.invalidateSize();
    });
    observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
      map.remove();
      mapRef.current = null;
    };
  }, []);

  /* Invalidate map size whenever selected ticket changes */
  useEffect(() => {
    if (!mapRef.current) return;
    const timer = setTimeout(() => {
      mapRef.current?.invalidateSize();
    }, 150);
    return () => clearTimeout(timer);
  }, [selectedTicket]);

  /* Pole markers */
  useEffect(() => {
    if (!poleLayer.current || poles.length === 0) return;
    poleLayer.current.clearLayers();

    const dark = poles.filter((p) => p.currentStatus === "dark");
    const unk = poles.filter((p) => p.currentStatus === "unknown");
    const live = poles.filter((p) => !p.currentStatus || p.currentStatus === "live");

    const visible = [...dark, ...unk, ...live.filter((_, i) => i % 5 === 0)];

    for (const p of visible) {
      const isDark = p.currentStatus === "dark";
      const isUnk = p.currentStatus === "unknown";
      const color = isDark ? "#ef4444" : isUnk ? "#f59e0b" : "#22c55e";

      L.circleMarker([p.lat, p.lon], {
        radius: isDark ? 5 : 3,
        fillColor: color,
        fillOpacity: isDark ? 0.9 : isUnk ? 0.7 : 0.4,
        stroke: false,
      })
        .bindTooltip(`${p.poleId}\n${p.currentStatus || "live"}\nDT: ${p.dtId}`, {
          direction: "top",
        })
        .addTo(poleLayer.current!);
    }

    if (mapRef.current && poles.length > 0 && !hasFitBounds.current) {
      try {
        const valid = poles.filter((p) => typeof p.lat === "number" && typeof p.lon === "number" && !isNaN(p.lat) && !isNaN(p.lon));
        if (valid.length > 0) {
          const bounds = L.latLngBounds(valid.map((p) => [p.lat, p.lon] as [number, number]));
          if (bounds.isValid()) {
            mapRef.current.fitBounds(bounds, { padding: [40, 40] });
            hasFitBounds.current = true;
          }
        }
      } catch (e) {
        console.error("Bounds error:", e);
      }
    }
  }, [poles]);

  /* Ticket markers */
  useEffect(() => {
    if (!ticketLayer.current) return;
    ticketLayer.current.clearLayers();

    for (const ticket of tickets) {
      if (typeof ticket.lat !== "number" || typeof ticket.lon !== "number" || isNaN(ticket.lat) || isNaN(ticket.lon)) continue;
      const isSel = selectedTicket?.id === ticket.id;

      L.circleMarker([ticket.lat, ticket.lon], {
        radius: isSel ? 14 : 10,
        fillColor: "#ef4444",
        fillOpacity: 0.2,
        color: "#ef4444",
        weight: isSel ? 2 : 1.5,
        opacity: isSel ? 1 : 0.75,
      })
        .bindTooltip(
          `Incident #${String(ticket.id).padStart(4, "0")}\n${ticket.faultType} fault\n${ticket.affectedPoleCount} poles`,
          { direction: "top" }
        )
        .on("click", () => onSelect(ticket))
        .addTo(ticketLayer.current!);
    }

    if (selectedTicket && mapRef.current && typeof selectedTicket.lat === "number" && typeof selectedTicket.lon === "number") {
      try {
        mapRef.current.setView([selectedTicket.lat, selectedTicket.lon], 16, {
          animate: true,
        });
      } catch (e) {
        console.error("SetView error:", e);
      }
    }
  }, [tickets, selectedTicket, onSelect]);

  return <div ref={containerRef} style={{ width: "100%", height: "100%" }} />;
}

export default App;
