const API_BASE =
  (import.meta as any).env?.VITE_API_URL || window.location.origin;

async function fetchJSON<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw { status: res.status, ...body };
  }
  return res.json();
}

export interface Ticket {
  id: number;
  faultType: string;
  spanStartPole: string | null;
  spanEndPole: string | null;
  dtId: string;
  feederId: string;
  lat: number;
  lon: number;
  pincode: string | null;
  affectedPoleCount: number;
  affectedHouseholds: number | null;
  confidence: number;
  confidenceReason: string;
  dispatchBrief: string | null;
  status: string;
  createdAt: string;
  acknowledgedAt: string | null;
  crewAssignedAt: string | null;
  resolvedAt: string | null;
  verifiedAt: string | null;
  closedAt: string | null;
}

export interface PoleData {
  poleId: string;
  lat: number;
  lon: number;
  feederId: string;
  dtId: string;
  ward: string | null;
  pincode: string | null;
  deviceId: string | null;
  topologySource: string;
  currentStatus: string | null;
}

export interface NetworkStats {
  poles: {
    total: number;
    live: number;
    dark: number;
    unknown: number;
  };
  transformers: number;
}

export interface DTInfo {
  dtId: string;
  feederId: string;
  lat: number;
  lon: number;
  poleCount: number;
  topologySource: string;
  rootPoles: string[];
  samplePoles: string[];
}

export interface NetworkInfo {
  totalDTs: number;
  totalPoles: number;
  dts: DTInfo[];
}

export const api = {
  // Network
  getPoles: () => fetchJSON<PoleData[]>("/api/network/poles"),
  getStats: () => fetchJSON<NetworkStats>("/api/network/stats"),
  getTransformers: () => fetchJSON<any[]>("/api/network/transformers"),

  // Tickets
  getTickets: () => fetchJSON<Ticket[]>("/api/tickets"),
  getTicket: (id: number) =>
    fetchJSON<Ticket & { affectedPoles: string[] }>(`/api/tickets/${id}`),
  updateTicketStatus: (id: number, status: string) =>
    fetchJSON<Ticket>(`/api/tickets/${id}/status`, {
      method: "PATCH",
      body: JSON.stringify({ status }),
    }),
  generateDispatchBrief: (id: number) =>
    fetchJSON<{ brief: string; source: string }>(`/api/tickets/${id}/dispatch-brief`, {
      method: "POST",
    }),

  // Simulator
  getNetworkInfo: () =>
    fetchJSON<NetworkInfo>("/api/simulator/network-info"),
  injectFault: (data: {
    faultType: string;
    dtId?: string;
    poleId?: string;
  }) =>
    fetchJSON<any>("/api/simulator/inject-fault", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  repair: (data: { dtId: string; poleIds?: string[] }) =>
    fetchJSON<any>("/api/simulator/repair", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  killSensor: (poleId: string) =>
    fetchJSON<any>("/api/simulator/kill-sensor", {
      method: "POST",
      body: JSON.stringify({ poleId }),
    }),

  // Scheduled outages
  getScheduledOutages: () => fetchJSON<any[]>("/api/scheduled-outages"),
  createScheduledOutage: (data: any) =>
    fetchJSON<any>("/api/scheduled-outages", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  // Health
  health: () => fetchJSON<{ status: string }>("/api/health"),
};
