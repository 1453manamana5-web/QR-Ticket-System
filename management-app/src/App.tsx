import { useEffect, useMemo, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import type { Event, ReceptionRecord, ReceptionSettings, Ticket } from "@qr-ticket-system/shared";
import { publishEventBundle, saveEventMetadata, type PublishedEventBundle } from "./eventPublisher";
import TicketDesigner from "./TicketDesigner";
import { deleteEvent as deleteFirebaseEvent, deleteMember as deleteFirebaseMember, deleteTicket as deleteFirebaseTicket, deleteTerminal, loadAnalysis, loadAppSettings, loadMembers, loadReceptionSettings, loadTerminals, saveAnalysis, saveAppSettings, saveManagementTerminalHeartbeat, saveMember, saveReceptionSettings, saveTicket, saveTickets, saveTerminal, subscribeEvents, subscribeReceptionRecords, subscribeTerminals, subscribeTickets } from "./firebaseData";

const baseEvent: Event = {
  eventId: "",
  eventName: "",
  eventDate: "",
  startTime: "",
  endTime: "",
  eventStatus: "preparing",
  dataVersion: 1,
};

type AnalysisRecord = {
  eventId: string;
  eventName: string;
  eventDate: string;
  total: number;
  unused: number;
  inside: number;
  exited: number;
  savedAt: string;
};

function loadAnalysisHistory(): AnalysisRecord[] {
  try {
    const raw = localStorage.getItem("qr-ticket-analysis-history");
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

const navigationGroups = [
  {
    label: "メイン",
    items: [
      { label: "ホーム", icon: "home" },
      { label: "イベント管理", icon: "event" },
      { label: "チケット管理", icon: "ticket" },
    ],
  },
  {
    label: "運用",
    items: [
      { label: "端末管理", icon: "terminal" },
      { label: "部員管理", icon: "members", comingSoon: true },
    ],
  },
  {
    label: "確認",
    items: [
      { label: "分析", icon: "analysis" },
    ],
  },
  {
    label: "システム",
    items: [
      { label: "設定", icon: "settings" },
    ],
  },
];

const statusLabel: Record<Event["eventStatus"], string> = {
  preparing: "準備中",
  ready: "受付可能",
  active: "開催中",
  finalizing: "終了処理中",
  finished: "終了",
};

function createEventId() {
  const now = new Date();
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("");
  const random = crypto.getRandomValues(new Uint32Array(1))[0].toString(36).toUpperCase().slice(0, 4);
  return `EV-${stamp}-${random}`;
}

function createTickets(eventId: string, count: number, startNumber = 1, prefix = "TKT"): Ticket[] {
  return Array.from({ length: count }, (_, index) => {
    const ticketNumber = startNumber + index;
    const id = `${prefix}${String(ticketNumber).padStart(6, "0")}`;
    return {
      ticketId: id,
      eventId,
      basicInfo: { ticketNumber },
      currentStatus: "unused",
      valid: true,
      updatedAt: new Date().toISOString(),
    };
  });
}

function ticketQrValue(eventId: string, ticket: Ticket) {
  return JSON.stringify({
    type: "qr-ticket",
    eventId,
    ticketId: ticket.ticketId,
    ticketNumber: ticket.basicInfo.ticketNumber,
  });
}

function nextStatus(status: Event["eventStatus"]): Event["eventStatus"] {
  if (status === "preparing") return "ready";
  if (status === "ready") return "active";
  if (status === "active") return "finalizing";
  if (status === "finalizing") return "finished";
  return "finished";
}

function getAutomaticEventStatus(target: Event): Event["eventStatus"] | null {
  const startAt = new Date(target.eventDate + "T" + target.startTime + ":00");
  const endAt = new Date(target.eventDate + "T" + target.endTime + ":00");
  if (Number.isNaN(startAt.getTime()) || Number.isNaN(endAt.getTime())) return null;

  const now = new Date();
  if (now >= endAt && target.eventStatus !== "finalizing" && target.eventStatus !== "finished") return "finalizing";
  if (now >= startAt && (target.eventStatus === "preparing" || target.eventStatus === "ready")) return "active";
  return null;
}


export default function App() {
  const [page, setPage] = useState("ホーム");
  const [event, setEvent] = useState<Event>(baseEvent);
  const [eventHistory, setEventHistory] = useState<Event[]>(() => {
    try {
      const raw = localStorage.getItem("qr-ticket-event-history");
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((item: Event) => item?.eventId);
    } catch {
      return [];
    }
  });
  const [selectedHistoryEventId, setSelectedHistoryEventId] = useState("");
  const [analysisHistory, setAnalysisHistory] = useState<AnalysisRecord[]>(loadAnalysisHistory);
  const [selectedAnalysisEventId, setSelectedAnalysisEventId] = useState("");
  const [newEventModalOpen, setNewEventModalOpen] = useState(false);
  const [newEventName, setNewEventName] = useState("");
  const [newEventDate, setNewEventDate] = useState("");
  const [newStartTime, setNewStartTime] = useState("10:00");
  const [newEndTime, setNewEndTime] = useState("16:00");
  const [bundle, setBundle] = useState<PublishedEventBundle | null>(null);
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [receptionRecords, setReceptionRecords] = useState<ReceptionRecord[]>([]);
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState("");
  const [eventName, setEventName] = useState("");
  const [eventDate, setEventDate] = useState("");
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");
  const [ticketCount, setTicketCount] = useState(500);
  const [ticketPrefix, setTicketPrefix] = useState("TKT");
  const [ticketStartNumber, setTicketStartNumber] = useState(1);
  const [ticketTitle, setTicketTitle] = useState("入場チケット");
  const [savedEventName, setSavedEventName] = useState("");
  const [settings, setSettings] = useState<ReceptionSettings>({
    entryEnabled: true,
    exitEnabled: true,
    reentryEnabled: true,
  });
  type AppSettings = {
    volume: number;
    successSound: boolean;
    voiceGuidance: boolean;
    controlAssist: boolean;
    deviceName: string;
    aiLabEnabled: boolean;
  };
  const defaultAppSettings: AppSettings = {
    volume: 70,
    successSound: true,
    voiceGuidance: false,
    controlAssist: false,
    deviceName: "受付端末",
    aiLabEnabled: false,
  };
  const [appSettings, setAppSettings] = useState<AppSettings>(() => {
    try {
      const raw = localStorage.getItem("qr-ticket-app-settings");
      if (!raw) return defaultAppSettings;
      return { ...defaultAppSettings, ...JSON.parse(raw) };
    } catch {
      return defaultAppSettings;
    }
  });
  const [settingsNotice, setSettingsNotice] = useState("");
  const [aiLabMenuOpen, setAiLabMenuOpen] = useState(false);
  const [aiLabPanel, setAiLabPanel] = useState<"受付分析" | "システム診断" | "改善提案" | "警告履歴" | null>(null);
  type AiLabWarning = { id: string; eventId: string; title: string; detail: string; detectedAt: string };
  const [aiLabWarnings, setAiLabWarnings] = useState<AiLabWarning[]>(() => {
    try {
      const raw = localStorage.getItem("qr-ticket-ai-lab-warnings");
      return raw ? (JSON.parse(raw) as AiLabWarning[]) : [];
    } catch {
      return [];
    }
  });
  const aiLabDiagnostics = useMemo(() => {
    const findings: Array<{ id: string; title: string; detail: string }> = [];
    const ticketIds = new Set<string>();
    const duplicateTicketIds = new Set<string>();
    for (const ticket of tickets) {
      if (!ticket.ticketId) {
        findings.push({ id: "ticket-missing-id", title: "チケットID未設定", detail: "IDがないチケットが含まれています。受付判定の前にチケットデータを確認してください。" });
      } else if (ticketIds.has(ticket.ticketId)) {
        duplicateTicketIds.add(ticket.ticketId);
      } else {
        ticketIds.add(ticket.ticketId);
      }
      if (ticket.eventId && ticket.eventId !== event.eventId) {
        findings.push({ id: "ticket-event-mismatch-" + ticket.ticketId, title: "イベントID不一致", detail: "別イベントに属するチケットが現在の一覧に含まれています。" });
      }
      if (!["unused", "inside", "exited"].includes(ticket.currentStatus)) {
        findings.push({ id: "ticket-status-" + (ticket.ticketId || "unknown"), title: "チケット状態が不正", detail: "チケット「" + (ticket.ticketId || "ID不明") + "」の状態を確認してください。" });
      }
    }
    for (const ticketId of duplicateTicketIds) {
      findings.push({ id: "ticket-duplicate-" + ticketId, title: "チケットID重複", detail: "同じID「" + ticketId + "」が複数のチケットに使われています。" });
    }
    const recordIds = new Set<string>();
    for (const record of receptionRecords) {
      if (!record.recordId) {
        findings.push({ id: "record-missing-id-" + String(record.ticketId || "unknown") + "-" + String(record.timestamp || ""), title: "受付記録ID未設定", detail: "受付記録にIDがありません。同期時の重複防止を確認してください。" });
      } else if (recordIds.has(record.recordId)) {
        findings.push({ id: "record-duplicate-" + record.recordId, title: "受付記録ID重複", detail: "受付記録ID「" + record.recordId + "」が重複しています。" });
      } else {
        recordIds.add(record.recordId);
      }
      if (!record.timestamp || !Number.isFinite(Date.parse(record.timestamp))) {
        findings.push({ id: "record-time-" + (record.recordId || record.ticketId || "unknown"), title: "受付時刻が不正", detail: "時刻を解釈できない受付記録があります。" });
      }
      if (record.eventId && record.eventId !== event.eventId) {
        findings.push({ id: "record-event-mismatch-" + (record.recordId || record.ticketId), title: "受付記録のイベント不一致", detail: "別イベントに属する受付記録が混在しています。" });
      }
      if (record.ticketId && !tickets.some(ticket => ticket.ticketId === record.ticketId)) {
        findings.push({ id: "record-ticket-missing-" + (record.recordId || record.ticketId), title: "チケット参照先なし", detail: "受付記録が参照するチケット「" + record.ticketId + "」が現在のチケット一覧にありません。同期状況を確認してください。" });
      }
    }
    return findings;
  }, [event.eventId, tickets, receptionRecords]);
  useEffect(() => {
    if (!appSettings.aiLabEnabled || !event.eventId || aiLabDiagnostics.length === 0) return;
    const now = new Date().toISOString();
    setAiLabWarnings(current => {
      const existing = new Set(current.map(item => item.eventId + "::" + item.id));
      const additions = aiLabDiagnostics
        .filter(item => !existing.has(event.eventId + "::" + item.id))
        .map(item => ({ ...item, eventId: event.eventId, detectedAt: now }));
      if (additions.length === 0) return current;
      const next = [...additions, ...current].slice(0, 100);
      try { localStorage.setItem("qr-ticket-ai-lab-warnings", JSON.stringify(next)); } catch (reason) { console.warn("AI試験警告履歴を保存できませんでした", reason); }
      return next;
    });
  }, [appSettings.aiLabEnabled, event.eventId, aiLabDiagnostics]);


  const [ticketQuery, setTicketQuery] = useState("");
  const [ticketStatusFilter, setTicketStatusFilter] = useState<"all" | "unused" | "inside" | "exited">("all");
  const [ticketCreateModalOpen, setTicketCreateModalOpen] = useState(false);
  const [ticketDesignModalOpen, setTicketDesignModalOpen] = useState(false);
  const [ticketQrModalTicket, setTicketQrModalTicket] = useState<Ticket | null>(null);
  const [ticketListOpen, setTicketListOpen] = useState(false);
  const [members, setMembers] = useState<Array<{ memberId: string; memberNumber: number; name: string }>>([]);
  const [memberName, setMemberName] = useState("");
  const [memberRegistrationOpen, setMemberRegistrationOpen] = useState(false);
  const [memberQuery, setMemberQuery] = useState("");
  const [selectedMemberIds, setSelectedMemberIds] = useState<string[]>([]);
  const [memberBulkModalOpen, setMemberBulkModalOpen] = useState(false);
  const [memberBulkText, setMemberBulkText] = useState("");
  const [memberQrModal, setMemberQrModal] = useState<{ memberId: string; memberNumber: number; name: string } | null>(null);
  type TerminalStatus = "online" | "offline" | "pending";
  type TerminalMode = "入口受付" | "出口受付" | "停止";
  type ManagedTerminal = {
    terminalId: string;
    name: string;
    type: "Web / iPad" | "Web / PC";
    mode: TerminalMode;
    desiredMode?: TerminalMode;
    status: TerminalStatus;
    approved: boolean;
    lastSeen: string | null;
    networkMbps: number | null;
    battery: number | null;
    role?: "management" | "reception" | "both";
    admin?: boolean;
    subAdmin?: boolean;
    managementApproved?: boolean;
    receptionApproved?: boolean;
    syncPendingCount?: number;
  };
  const defaultTerminals: ManagedTerminal[] = [];

  const [terminals, setTerminals] = useState<ManagedTerminal[]>(() => {
    try {
      const raw = localStorage.getItem("qr-ticket-managed-terminals-v2");
      if (!raw) return defaultTerminals;
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : defaultTerminals;
    } catch {
      return defaultTerminals;
    }
  });
  const [selectedTerminalId, setSelectedTerminalId] = useState<string | null>(null);
  const [terminalNotice, setTerminalNotice] = useState("");
  const [forceTerminalRegistration, setForceTerminalRegistration] = useState(false);
  const [terminalDataHydrated, setTerminalDataHydrated] = useState(false);
  const [firebaseDeviceId, setFirebaseDeviceId] = useState(() => {
    const key = "qr-ticket-terminal-id";
    const legacyKey = "qr-ticket-device-id";
    const existing = localStorage.getItem(key) || localStorage.getItem(legacyKey);
    if (existing) {
      localStorage.setItem(key, existing);
      return existing;
    }
    const created = `T-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
    localStorage.setItem(key, created);
    return created;
  });
  const firebaseEventHydratedRef = useRef(false);
  const firebaseTicketHydratedRef = useRef(false);
  const deletedEventIdsRef = useRef(new Set<string>());

  useEffect(() => {
    localStorage.setItem("qr-ticket-event-history", JSON.stringify(eventHistory));
  }, [eventHistory]);

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    try {
      unsubscribe = subscribeEvents(events => {
        const realEvents = events.filter(item => item.eventId && !deletedEventIdsRef.current.has(item.eventId));
        firebaseEventHydratedRef.current = true;
        setEventHistory(realEvents);
        setEvent(current => {
          return realEvents.find(item => item.eventId === current.eventId) ?? realEvents[0] ?? baseEvent;
        });
      }, reason => console.error("Firebase event subscription failed", reason));
    } catch (reason) {
      console.error("Firebase event subscription failed", reason);
    }
    return () => unsubscribe?.();
  }, []);

  useEffect(() => {
    firebaseTicketHydratedRef.current = false;
    if (!event.eventId) {
      setTickets([]);
      return;
    }
    let unsubscribe: (() => void) | undefined;
    try {
      unsubscribe = subscribeTickets(event.eventId, remoteTickets => {
        firebaseTicketHydratedRef.current = true;
        setTickets(remoteTickets);
      }, reason => console.error("Firebase ticket subscription failed", reason));
    } catch (reason) {
      console.error("Firebase ticket subscription failed", reason);
    }
    return () => unsubscribe?.();
  }, [event.eventId]);
  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    if (!event.eventId) {
      setReceptionRecords([]);
      return;
    }
    try {
      unsubscribe = subscribeReceptionRecords(event.eventId, records => {
        setReceptionRecords(records as ReceptionRecord[]);
      }, reason => console.error("Firebase reception record subscription failed", reason));
    } catch (reason) {
      console.error("Firebase reception record subscription failed", reason);
    }
    return () => unsubscribe?.();
  }, [event.eventId]);

  useEffect(() => {
    void deleteFirebaseEvent("DEMO-2027").catch(reason => {
      console.error("Legacy demo event cleanup failed", reason);
    });
    setEventHistory(current => current.filter(item => item.eventId));
    setAnalysisHistory(current => current.filter(item => item.eventId));
    try {
      const raw = localStorage.getItem("qr-ticket-event-history");
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          localStorage.setItem("qr-ticket-event-history", JSON.stringify(parsed.filter((item: Event) => item?.eventId)));
        }
      }
    } catch (reason) {
      console.error("Event history cleanup failed", reason);
    }
  }, []);

  useEffect(() => {
    localStorage.setItem("qr-ticket-managed-terminals-v2", JSON.stringify(terminals));
  }, [terminals]);

  useEffect(() => {
    localStorage.setItem("qr-ticket-analysis-history", JSON.stringify(analysisHistory));
  }, [analysisHistory]);
  useEffect(() => {
    localStorage.setItem("qr-ticket-app-settings", JSON.stringify(appSettings));
    void saveAppSettings(firebaseDeviceId, appSettings).catch(reason => console.error("Firebase app settings save failed", reason));
  }, [appSettings, firebaseDeviceId]);

  useEffect(() => {
    void loadAppSettings(firebaseDeviceId).then(remote => {
      if (remote) setAppSettings(current => ({ ...current, ...remote } as AppSettings));
    }).catch(reason => console.error("Firebase app settings load failed", reason));
  }, [firebaseDeviceId]);

  useEffect(() => {
    if (!event.eventId) {
      setSettings({ entryEnabled: true, exitEnabled: true, reentryEnabled: true });
      setMembers([]);
      setAnalysisHistory([]);
      return;
    }
    void loadReceptionSettings(event.eventId).then(remote => {
      if (remote) setSettings(remote);
    }).catch(reason => console.error("Firebase reception settings load failed", reason));
    void loadMembers(event.eventId).then(remote => setMembers(remote)).catch(reason => console.error("Firebase member load failed", reason));
    void loadAnalysis(event.eventId).then(remote => setAnalysisHistory(remote)).catch(reason => console.error("Firebase analysis load failed", reason));
  }, [event.eventId]);

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    setTerminalDataHydrated(false);

    void loadTerminals().then(remote => {
      setTerminals(remote);
      setTerminalDataHydrated(true);
    }).catch(reason => {
      console.error("Firebase terminal load failed", reason);
      setTerminalDataHydrated(true);
    });

    try {
      unsubscribe = subscribeTerminals(remote => {
        setTerminals(remote);
        setTerminalDataHydrated(true);
      }, reason => {
        console.error("Firebase terminal subscription failed", reason);
        setTerminalDataHydrated(true);
      });
    } catch (reason) {
      console.error("Firebase terminal subscription failed", reason);
      setTerminalDataHydrated(true);
    }

    return () => unsubscribe?.();
  }, []);

  const ownManagementTerminalApproved = terminals.some(
    terminal =>
      terminal.terminalId === firebaseDeviceId &&
      (terminal.role === "management" || terminal.role === "both") &&
      terminal.approved,
  );

  useEffect(() => {
    if (!terminalDataHydrated || !ownManagementTerminalApproved) return;

    const heartbeat = () => {
      void saveManagementTerminalHeartbeat(firebaseDeviceId).catch(reason => {
        console.error("管理端末ハートビートに失敗しました", reason);
      });
    };

    heartbeat();
    const interval = window.setInterval(heartbeat, 10000);
    return () => window.clearInterval(interval);
  }, [terminalDataHydrated, firebaseDeviceId, ownManagementTerminalApproved]);


  const saveAnalysisSnapshot = (targetEvent: Event = event) => {
    const record: AnalysisRecord = {
      eventId: targetEvent.eventId,
      eventName: targetEvent.eventName,
      eventDate: targetEvent.eventDate,
      total: ticketStats.total,
      unused: ticketStats.unused,
      inside: ticketStats.inside,
      exited: ticketStats.exited,
      savedAt: new Date().toISOString(),
    };
    setAnalysisHistory(current => [record, ...current.filter(item => item.eventId !== record.eventId)]);
    setSelectedAnalysisEventId(record.eventId);
    void saveAnalysis(record).catch(reason => console.error("Firebase analysis save failed", reason));
  };

  const eventStatus = event.eventStatus;
  const ticketStats = useMemo(() => ({
    total: tickets.length,
    unused: tickets.filter(ticket => ticket.currentStatus === "unused").length,
    inside: tickets.filter(ticket => ticket.currentStatus === "inside").length,
    exited: tickets.filter(ticket => ticket.currentStatus === "exited").length,
  }), [tickets]);


  useEffect(() => {
    if (eventHistory[0]?.eventId !== event.eventId) return;

    const finishEvent = async () => {
      const receptionTerminals = terminals.filter(
        terminal => terminal.role === "reception" || terminal.role === "both",
      );
      const allReceptionDataSynced = receptionTerminals.every(
        terminal => terminal.syncPendingCount === 0,
      );

      if (!allReceptionDataSynced) {
        setTerminalNotice("受付データを回収しています。すべての受付端末の同期が完了するまで終了処理中のまま待機します。");
        return;
      }

      saveAnalysisSnapshot(event);
      const released = terminals.map(terminal => {
        if (terminal.role !== "reception" && terminal.role !== "both") return terminal;
        const managementApproved = terminal.role === "both"
          ? Boolean(terminal.managementApproved ?? terminal.approved)
          : false;
        return {
          ...terminal,
          approved: managementApproved,
          managementApproved,
          receptionApproved: false,
          syncPendingCount: 0,
          status: managementApproved ? ("offline" as TerminalStatus) : ("pending" as TerminalStatus),
          mode: "停止" as TerminalMode,
          desiredMode: "停止" as TerminalMode,
        };
      });

      try {
        await Promise.all(released.map(terminal => saveTerminal(terminal)));
        setTerminals(released);
        setSelectedTerminalId(null);
        setTerminalNotice("受付データの回収が完了しました。受付機能の認証を解除しました。");
        const finished = { ...event, eventStatus: "finished" as const };
        setEvent(finished);
        setEventHistory(current =>
          current.map(item => item.eventId === finished.eventId ? finished : item),
        );
        setSelectedHistoryEventId(finished.eventId);
        await saveEventMetadata(finished);
      } catch (reason) {
        console.error("Terminal release after event finalization failed", reason);
        setError("イベント終了時の端末認証解除に失敗しました。端末管理を確認してください。");
      }
    };

    const syncAutomaticStatus = () => {
      const next = getAutomaticEventStatus(event);

      if (next === "finalizing") {
        if (event.eventStatus !== "finalizing") {
          const updated = { ...event, eventStatus: "finalizing" as const };
          setEvent(updated);
          setEventHistory(current =>
            current.map(item => item.eventId === updated.eventId ? updated : item),
          );
          setSelectedHistoryEventId(updated.eventId);
          setTerminalNotice("終了時刻になりました。受付端末からデータを回収しています。");
          void saveEventMetadata(updated).catch(reason => {
            console.error(reason);
            setError("イベント状態をFirebaseへ保存できませんでした。Firestoreの権限を確認してください。");
          });
        }
        return;
      }

      if (event.eventStatus === "finalizing") {
        void finishEvent();
        return;
      }

      if (!next || next === event.eventStatus) return;

      const updated = { ...event, eventStatus: next };
      setEvent(updated);
      setEventHistory(current =>
        current.map(item => item.eventId === updated.eventId ? updated : item),
      );
      setSelectedHistoryEventId(updated.eventId);
      void saveEventMetadata(updated).catch(reason => {
        console.error(reason);
        setError("イベント状態をFirebaseへ保存できませんでした。Firestoreの権限を確認してください。");
      });
    };

    syncAutomaticStatus();
    const timer = window.setInterval(syncAutomaticStatus, 5000);
    return () => window.clearInterval(timer);
  }, [event, eventHistory, ticketStats, terminals]);

  const filteredTickets = useMemo(() => {
    const query = ticketQuery.trim().toLowerCase();
    return tickets.filter(ticket => {
      const matchesQuery = !query ||
        ticket.ticketId.toLowerCase().includes(query) ||
        String(ticket.basicInfo.ticketNumber).includes(query);
      const matchesStatus = ticketStatusFilter === "all" || ticket.currentStatus === ticketStatusFilter;
      return matchesQuery && matchesStatus;
    });
  }, [tickets, ticketQuery, ticketStatusFilter]);

  const saveEvent = async () => {
    if (publishing) return;
    const normalizedName = eventName.trim();
    if (!event.eventId) {
      setError("先にイベントを作成してください。");
      return;
    }
    if (!eventDate || !startTime || !endTime) {
      setError("開催日・開始時刻・終了時刻を入力してください。");
      return;
    }
    if (startTime >= endTime) {
      setError("終了時刻は開始時刻より後にしてください。");
      return;
    }

    // チケットの発行・枚数管理は「チケット管理」に一本化する。
    // イベント保存では既存のチケットをそのまま公開し、自動生成・再生成は行わない。
    const preparedTickets = tickets;

    const updatedEvent: Event = {
      ...event,
      eventName: normalizedName,
      eventDate,
      startTime,
      endTime,
    };

    setPublishing(true);
    setEvent(updatedEvent);
    setEventHistory(current => current.map(item => item.eventId === event.eventId ? updatedEvent : item));
    setSelectedHistoryEventId(updatedEvent.eventId);
    setSavedEventName(normalizedName);
    setTickets(preparedTickets);
    setError("");

    try {
      const result = await publishEventBundle(updatedEvent, settings, preparedTickets);
      setBundle(result);
    } catch (reason) {
      console.error(reason);
      setError("イベント情報をFirebaseへ保存・公開できませんでした。Firebase設定とFirestoreの権限を確認してください。");
    } finally {
      setPublishing(false);
    }
  };

  const openNewEventModal = () => {
    const today = new Date().toISOString().slice(0, 10);
    setNewEventName("新しいイベント");
    setNewEventDate(today);
    setNewStartTime("10:00");
    setNewEndTime("16:00");
    setError("");
    setNewEventModalOpen(true);
  };

  const closeNewEventModal = () => {
    setNewEventModalOpen(false);
  };

  const createNewEvent = () => {
    const normalizedName = newEventName.trim();
    if (!normalizedName || !newEventDate || !newStartTime || !newEndTime) {
      setError("イベント名・開催日・開始時刻・終了時刻を入力してください。");
      return;
    }
    if (newStartTime >= newEndTime) {
      setError("終了時刻は開始時刻より後にしてください。");
      return;
    }

    const next: Event = {
      eventId: createEventId(),
      eventName: normalizedName,
      eventDate: newEventDate,
      startTime: newStartTime,
      endTime: newEndTime,
      eventStatus: "preparing",
      dataVersion: 1,
    };

    saveAnalysisSnapshot(event);
    setEvent(next);
    setEventHistory(current => [next, ...current.filter(item => item.eventId !== next.eventId)]);
    setSelectedHistoryEventId(next.eventId);
    setEventName(next.eventName);
    setEventDate(next.eventDate);
    setStartTime(next.startTime);
    setEndTime(next.endTime);
    setSavedEventName(next.eventName);
    setBundle(null);
    setTickets([]);
    setError("");
    setNewEventModalOpen(false);
    setPage("イベント管理");
    void saveEventMetadata(next).catch(reason => {
      console.error(reason);
      setError("新しいイベントをFirebaseへ保存できませんでした。");
    });
  };

  const changeEventStatus = (status: Event["eventStatus"]) => {
    if (status === "finished") saveAnalysisSnapshot(event);
    const updated = { ...event, eventStatus: status };
    setEvent(updated);
    setEventHistory(current => current.map(item => item.eventId === updated.eventId ? updated : item));
    setSelectedHistoryEventId(updated.eventId);
    setError("");
    void saveEventMetadata(updated).catch(reason => {
      console.error(reason);
      setError("イベント状態をFirebaseへ保存できませんでした。Firestoreの権限を確認してください。");
    });
  };

  const selectHistoryEvent = (selected: Event) => {
    setEvent(selected);
    setEventName(selected.eventName);
    setEventDate(selected.eventDate);
    setStartTime(selected.startTime);
    setEndTime(selected.endTime);
    setSavedEventName(selected.eventName);
    setSelectedHistoryEventId(selected.eventId);
    setSelectedAnalysisEventId(selected.eventId);
    setBundle(null);
    setTickets([]);
    setError("");
  };

  const deleteHistoryEvent = async (eventId: string) => {
    const target = eventHistory.find(item => item.eventId === eventId);
    if (!target) return;
    if (!window.confirm("「" + target.eventName + "」をイベント履歴から削除しますか？")) return;

    const remaining = eventHistory.filter(item => item.eventId !== eventId);
    if (remaining.length === 0) {
      setError("最後のイベントは削除できません。新しいイベントを作成してから削除してください。");
      return;
    }

    setError("");
    deletedEventIdsRef.current.add(eventId);
    try {
      // Firebase側の削除完了を待ってから画面側も更新する。
      // onSnapshotの古いスナップショットで削除済みイベントが一瞬復活するのを防ぐ。
      await deleteFirebaseEvent(eventId);
      setEventHistory(remaining);
      selectHistoryEvent(remaining[0]);
    } catch (reason) {
      deletedEventIdsRef.current.delete(eventId);
      console.error(reason);
      setError("イベントをFirebaseから削除できませんでした。権限・接続を確認してください。");
    }
  };

  const generateTickets = async () => {
    const count = Math.min(5000, Math.max(1, ticketCount));
    const prefix = ticketPrefix.trim().replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 12) || "TKT";
    setTicketPrefix(prefix);

    const existingMaxNumber = tickets.reduce((max, ticket) => {
      const number = Number(ticket.basicInfo.ticketNumber);
      return Number.isFinite(number) ? Math.max(max, number) : max;
    }, 0);
    const startNumber = Math.max(1, existingMaxNumber + 1);
    setTicketStartNumber(startNumber);

    const generated = createTickets(event.eventId, count, startNumber, prefix);
    const merged = [...tickets, ...generated];
    setTickets(merged);
    setTicketStatusFilter("all");
    setError("");
    try {
      await saveTickets(event.eventId, merged);
    } catch (reason) {
      console.error(reason);
      setError("チケットをFirebaseへ保存できませんでした。Firestoreの権限を確認してください。");
    }
  };

  const updateTicketStatus = (ticketId: string, status: Ticket["currentStatus"]) => {
    const target = tickets.find(ticket => ticket.ticketId === ticketId);
    if (!target) return;
    const nextTicket = { ...target, currentStatus: status, updatedAt: new Date().toISOString() };
    setTickets(current => current.map(ticket => ticket.ticketId === ticketId ? nextTicket : ticket));
    void saveTicket(event.eventId, nextTicket).catch(reason => {
      console.error(reason);
      setError("チケット状態をFirebaseへ保存できませんでした。");
    });
  };

  const toggleTicketValidity = (ticketId: string) => {
    const target = tickets.find(ticket => ticket.ticketId === ticketId);
    if (!target) return;
    const nextTicket = { ...target, valid: !target.valid, updatedAt: new Date().toISOString() };
    setTickets(current => current.map(ticket => ticket.ticketId === ticketId ? nextTicket : ticket));
    void saveTicket(event.eventId, nextTicket).catch(reason => {
      console.error(reason);
      setError("チケットの有効状態をFirebaseへ保存できませんでした。");
    });
  };

  const deleteTicket = (ticketId: string) => {
    if (!window.confirm("このチケットを削除しますか？")) return;
    setTickets(current => current.filter(ticket => ticket.ticketId !== ticketId));
    void deleteFirebaseTicket(event.eventId, ticketId).catch(reason => {
      console.error(reason);
      setError("チケットをFirebaseから削除できませんでした。");
    });
  };

  const eventDataQrValue = bundle ? JSON.stringify({
    type: "qr-ticket-event-auth",
    eventId: bundle.event.eventId,
    eventName: bundle.event.eventName,
    dataVersion: bundle.event.dataVersion,
    authToken: bundle.authToken,
  }) : "";

  const updateAppSetting = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    setAppSettings(current => ({ ...current, [key]: value }));
    setSettingsNotice("設定を保存しました。");
    window.setTimeout(() => setSettingsNotice(""), 1800);
  };

  const resetAppSettings = () => {
    setAppSettings(defaultAppSettings);
    setSettingsNotice("設定を初期状態に戻しました。");
  };

  const exportBackup = () => {
    const backup = {
      version: 1,
      exportedAt: new Date().toISOString(),
      appSettings,
      receptionSettings: settings,
      eventHistory,
      analysisHistory,
      tickets,
      members,
    };
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `qr-ticket-backup-${new Date().toISOString().slice(0,10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    setSettingsNotice("バックアップを保存しました。");
  };

  const importBackup = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json,.json";
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const parsed = JSON.parse(String(reader.result));
          if (!parsed || typeof parsed !== "object") throw new Error("invalid");
          if (parsed.appSettings) setAppSettings({ ...defaultAppSettings, ...parsed.appSettings });
          if (parsed.receptionSettings) setSettings({ ...settings, ...parsed.receptionSettings });
          if (Array.isArray(parsed.eventHistory) && parsed.eventHistory.length) setEventHistory(parsed.eventHistory);
          if (Array.isArray(parsed.analysisHistory)) setAnalysisHistory(parsed.analysisHistory);
          if (Array.isArray(parsed.tickets)) setTickets(parsed.tickets);
          if (Array.isArray(parsed.members)) setMembers(parsed.members);
          setSettingsNotice("バックアップを復元しました。");
        } catch {
          setError("バックアップファイルを読み込めませんでした。");
        }
      };
      reader.readAsText(file);
    };
    input.click();
  };

  const resetAllData = () => {
    if (!window.confirm("すべてのローカルデータを初期化します。イベント履歴・分析履歴・チケット・部員情報・設定が削除されます。実行しますか？")) return;
    [
      "qr-ticket-event-history",
      "qr-ticket-analysis-history",
      "qr-ticket-app-settings",
    ].forEach(key => localStorage.removeItem(key));
    setEvent(baseEvent);
    setEventHistory([]);
    setAnalysisHistory([]);
    setSelectedHistoryEventId("");
    setSelectedAnalysisEventId("");
    setTickets([]);
    setMembers([]);
    setAppSettings(defaultAppSettings);
    setSettings({ entryEnabled: true, exitEnabled: true, reentryEnabled: true });
    if (event.eventId) {
      void saveReceptionSettings(event.eventId, { entryEnabled: true, exitEnabled: true, reentryEnabled: true }).catch(reason => console.error(reason));
    }
    setBundle(null);
    setSettingsNotice("ローカルデータを初期化しました。");
  };

  const addMember = () => {
    const normalized = memberName.trim();
    if (!normalized) return;
    const nextNumber = members.reduce((max, member) => Math.max(max, member.memberNumber), 0) + 1;
    const nextMember = {
      memberId: `MBR-${String(nextNumber).padStart(4, "0")}`,
      memberNumber: nextNumber,
      name: normalized,
    };
    setMembers(current => [...current, nextMember]);
    void saveMember(event.eventId, nextMember).catch(reason => { console.error(reason); setError("部員情報をFirebaseへ保存できませんでした。"); });
    setMemberName("");
  };

  const updateMemberName = (memberId: string, name: string) => {
    const target = members.find(member => member.memberId === memberId);
    if (!target) return;
    const nextMember = { ...target, name };
    setMembers(current => current.map(member => member.memberId === memberId ? nextMember : member));
    void saveMember(event.eventId, nextMember).catch(reason => { console.error(reason); setError("部員情報をFirebaseへ保存できませんでした。"); });
  };

  const deleteMember = (memberId: string) => {
    const target = members.find(member => member.memberId === memberId);
    if (!target || !window.confirm(`「${target.name}」を部員一覧から削除しますか？`)) return;
    setMembers(current => current.filter(member => member.memberId !== memberId));
    void deleteFirebaseMember(event.eventId, memberId).catch(reason => { console.error(reason); setError("部員情報をFirebaseから削除できませんでした。"); });
  };

  const toggleMemberSelection = (memberId: string) => {
    setSelectedMemberIds(current => current.includes(memberId) ? current.filter(id => id !== memberId) : [...current, memberId]);
  };

  const toggleAllFilteredMembers = () => {
    setSelectedMemberIds(current => {
      const ids = filteredMembers.map(member => member.memberId);
      const allSelected = ids.length > 0 && ids.every(id => current.includes(id));
      return allSelected ? current.filter(id => !ids.includes(id)) : Array.from(new Set([...current, ...ids]));
    });
  };

  const applyBulkMemberNames = () => {
    const names = memberBulkText.split(/\r?\n/).map(name => name.trim());
    const orderedIds = filteredMembers.filter(member => selectedMemberIds.includes(member.memberId)).map(member => member.memberId);
    if (!orderedIds.length || names.length !== orderedIds.length || names.some(name => !name)) return;
    setMembers(current => current.map(member => {
      const index = orderedIds.indexOf(member.memberId);
      return index >= 0 ? { ...member, name: names[index] } : member;
    }));
    const nextMembers = members.map(member => {
      const index = orderedIds.indexOf(member.memberId);
      return index >= 0 ? { ...member, name: names[index] } : member;
    });
    void Promise.all(nextMembers.filter(member => orderedIds.includes(member.memberId)).map(member => saveMember(event.eventId, member))).catch(reason => console.error("Firebase member bulk save failed", reason));
    setSelectedMemberIds([]);
    setMemberBulkText("");
    setMemberBulkModalOpen(false);
  };

  const filteredMembers = useMemo(() => {
    const query = memberQuery.trim().toLowerCase();
    return members.filter(member =>
      !query ||
      member.name.toLowerCase().includes(query) ||
      member.memberId.toLowerCase().includes(query) ||
      String(member.memberNumber).includes(query),
    );
  }, [members, memberQuery]);

  const releaseOwnReception = async () => {
    const currentTerminal = terminals.find(terminal => terminal.terminalId === firebaseDeviceId);
    if (!currentTerminal || currentTerminal.terminalId !== firebaseDeviceId) return;
    if (currentTerminal.role !== "reception" && currentTerminal.role !== "both") return;

    const updatedTerminal: ManagedTerminal = {
      ...currentTerminal,
      role: "management",
      mode: "停止",
      receptionApproved: false,
      lastSeen: new Date().toISOString(),
    };

    setTerminals(current =>
      current.map(terminal =>
        terminal.terminalId === firebaseDeviceId ? updatedTerminal : terminal
      )
    );

    try {
      await saveTerminal(updatedTerminal);
      setSelectedTerminalId(null);
      setTerminalNotice("この端末の受付を解除しました。");
    } catch (reason) {
      console.error("受付解除に失敗しました", reason);
      setTerminalNotice("受付解除を保存できませんでした。");
    }
  };

  const updateOwnTerminalName = (name: string) => {
    updateAppSetting("deviceName", name);

    const currentTerminal = terminals.find(terminal =>
      terminal.terminalId === firebaseDeviceId &&
      (terminal.role === "management" || terminal.role === "both")
    );
    if (!currentTerminal) return;

    const normalizedName = name.trim() || "管理端末";
    const updatedTerminal: ManagedTerminal = {
      ...currentTerminal,
      name: normalizedName,
      lastSeen: new Date().toISOString(),
    };

    setTerminals(current =>
      current.map(terminal =>
        terminal.terminalId === firebaseDeviceId ? updatedTerminal : terminal
      )
    );
    void saveTerminal(updatedTerminal).catch(reason => {
      console.error("Firebase terminal name update failed", reason);
      setTerminalNotice("端末名をFirebaseへ保存できませんでした。");
    });
  };

  const approveTerminal = async (terminalId: string) => {
    const operator = terminals.find(terminal => terminal.terminalId === firebaseDeviceId);
    if (!operator?.admin && !operator?.subAdmin) { setTerminalNotice("端末の承認権限がありません。"); return; }
    try {
      const remoteTerminals = await loadTerminals();
      const target = remoteTerminals.find(terminal => terminal.terminalId === terminalId);
      if (!target) {
        setTerminalNotice("承認対象の端末がFirebaseに見つかりません。");
        return;
      }

      const isReceptionRequest = target.role === "reception" || target.role === "both";
      const isManagementRequest = target.role === "management" || target.role === "both";
      const updatedTerminal = {
        ...target,
        approved: true,
        managementApproved: isManagementRequest ? true : target.managementApproved === true,
        receptionApproved: isReceptionRequest ? true : target.receptionApproved === true,
        status: "offline" as TerminalStatus,
      };
      await saveTerminal(updatedTerminal);
      setTerminals(current => current.map(terminal => terminal.terminalId === terminalId ? updatedTerminal : terminal));
      setTerminalNotice("端末を承認しました。受付端末側にも自動反映されます。");
      setSelectedTerminalId(terminalId);
    } catch (reason) {
      console.error("Firebase terminal approval failed", reason);
      setTerminalNotice("端末の承認に失敗しました。Firebaseへの接続を確認してください。");
    }
  };

  const setTerminalMode = (terminalId: string, mode: TerminalMode) => {
    const operator = terminals.find(terminal => terminal.terminalId === firebaseDeviceId);
    if (!operator?.admin && !operator?.subAdmin) { setTerminalNotice("端末の操作権限がありません。"); return; }
    const target = terminals.find(terminal => terminal.terminalId === terminalId);
    if (!target || target.status !== "online" || !target.approved) {
      setTerminalNotice("端末が見つからないため、リモート操作を実行できません。");
      return;
    }
    const updatedTerminal = { ...target, mode, desiredMode: mode, desiredModeUpdatedAt: new Date().toISOString() };
    setTerminals(current => current.map(terminal => terminal.terminalId === terminalId ? updatedTerminal : terminal));
    void saveTerminal(updatedTerminal).catch(reason => console.error("Firebase terminal save failed", reason));
    setTerminalNotice(`${target.name}を「${mode}」に変更しました。`);
  };

  const deleteManagedTerminal = async (terminalId: string) => {
    const operator = terminals.find(terminal => terminal.terminalId === firebaseDeviceId);
    if (!operator?.admin && !operator?.subAdmin) { setTerminalNotice("端末の削除権限がありません。"); return; }
    if (terminalId === firebaseDeviceId) {
      setTerminalNotice("自分の端末は削除できません。");
      return;
    }

    const target = terminals.find(terminal => terminal.terminalId === terminalId);
    if (!target) return;
    if (target.admin) {
      setTerminalNotice("管理者端末は削除できません。");
      return;
    }
    if (!window.confirm(`「${target.name}」を端末一覧から削除しますか？`)) return;

    setTerminals(current => current.filter(terminal => terminal.terminalId !== terminalId));
    if (selectedTerminalId === terminalId) setSelectedTerminalId(null);

    try {
      await deleteTerminal(terminalId);
      setTerminalNotice(`「${target.name}」を削除しました。`);
    } catch (reason) {
      console.error("Firebase terminal deletion failed", reason);
      setTerminalNotice("端末をFirebaseから削除できませんでした。");
      try {
        const remoteTerminals = await loadTerminals();
        setTerminals(remoteTerminals);
      } catch (reloadReason) {
        console.error("Firebase terminal reload failed", reloadReason);
      }
    }
  };

  const setSubAdmin = async (terminalId: string, enabled: boolean) => {
    const operator = terminals.find(terminal => terminal.terminalId === firebaseDeviceId);
    if (!operator?.admin) { setTerminalNotice("副管理者の設定は管理者のみ行えます。"); return; }
    const target = terminals.find(terminal => terminal.terminalId === terminalId);
    if (!target || target.admin || target.terminalId === firebaseDeviceId) return;
    const updatedTerminal: ManagedTerminal = { ...target, subAdmin: enabled };
    try {
      await saveTerminal(updatedTerminal);
      setTerminals(current => current.map(terminal => terminal.terminalId === terminalId ? updatedTerminal : terminal));
      setTerminalNotice(enabled ? `「${target.name}」を副管理者に設定しました。` : `「${target.name}」の副管理者設定を解除しました。`);
    } catch (reason) {
      console.error("Firebase sub-admin update failed", reason);
      setTerminalNotice("副管理者の設定をFirebaseへ保存できませんでした。");
    }
  };
  const registerOwnTerminal = async () => {
    try {
      const remoteTerminals = await loadTerminals();
      const legacyTerminalId = localStorage.getItem("qr-ticket-device-id");
      const existing = remoteTerminals.find(terminal => terminal.terminalId === firebaseDeviceId);
      const legacyExisting = legacyTerminalId && legacyTerminalId !== firebaseDeviceId
        ? remoteTerminals.find(terminal => terminal.terminalId === legacyTerminalId)
        : undefined;

      // 旧管理アプリと受付アプリで別IDになっていた端末を、現在の共通IDへ統合する。
      if (legacyTerminalId && legacyExisting) {
        const base = existing ?? legacyExisting;
        const legacyHasReceptionRole = legacyExisting.role === "reception" || legacyExisting.role === "both";
        const existingHasReceptionRole = existing?.role === "reception" || existing?.role === "both";
        const mergedRole: ManagedTerminal["role"] =
          legacyHasReceptionRole || existingHasReceptionRole ? "both" : "management";
        const merged: ManagedTerminal = {
          ...base,
          terminalId: firebaseDeviceId,
          name: appSettings.deviceName || existing?.name || legacyExisting.name || "管理端末",
          role: mergedRole,
          admin: Boolean(existing?.admin || legacyExisting.admin || (!remoteTerminals.some(terminal => terminal.admin === true))),
          approved: Boolean(existing?.managementApproved ?? existing?.approved ?? legacyExisting.managementApproved ?? legacyExisting.approved),
          managementApproved: Boolean(existing?.managementApproved ?? existing?.approved ?? legacyExisting.managementApproved ?? legacyExisting.approved),
          receptionApproved: Boolean(existing?.receptionApproved ?? legacyExisting.receptionApproved ?? (legacyHasReceptionRole || existingHasReceptionRole ? (existing?.approved ?? legacyExisting.approved) : false)),
          status: existing?.status ?? legacyExisting.status ?? "pending",
          lastSeen: new Date().toISOString(),
          networkMbps: existing?.networkMbps ?? legacyExisting.networkMbps ?? null,
          battery: existing?.battery ?? legacyExisting.battery ?? null,
        };

        await saveTerminal(merged);
        await deleteTerminal(legacyTerminalId);
        localStorage.setItem("qr-ticket-terminal-id", firebaseDeviceId);
        localStorage.setItem("qr-ticket-device-id", firebaseDeviceId);

        const mergedTerminals = remoteTerminals
          .filter(terminal => terminal.terminalId !== legacyTerminalId && terminal.terminalId !== firebaseDeviceId)
          .concat(merged);
        setTerminals(mergedTerminals);
        setForceTerminalRegistration(false);
        setSelectedTerminalId(firebaseDeviceId);
        setTerminalNotice("旧管理・受付の重複登録を統合し、この端末を1つの共通アカウントにしました。");
        return;
      }

      if (existing) {
        const isSharedTerminal = existing.role === "reception" || existing.role === "both";
        const hasAdmin = remoteTerminals.some(terminal => terminal.admin === true);
        const updatedExisting: ManagedTerminal = {
          ...existing,
          name: appSettings.deviceName || existing.name || "管理端末",
          role: isSharedTerminal ? "both" : (existing.role ?? "management"),
          admin: Boolean(existing.admin || (!hasAdmin && (existing.role === "management" || existing.role === "both"))),
          managementApproved: Boolean(existing.managementApproved ?? existing.approved),
          receptionApproved: Boolean(existing.receptionApproved ?? ((existing.role === "reception" || existing.role === "both") ? existing.approved : false)),
          lastSeen: new Date().toISOString(),
        };
        await saveTerminal(updatedExisting);
        localStorage.setItem("qr-ticket-device-id", firebaseDeviceId);
        setTerminals(current => current.map(terminal => terminal.terminalId === firebaseDeviceId ? updatedExisting : terminal));
        setForceTerminalRegistration(false);
        setSelectedTerminalId(existing.terminalId);
        setTerminalNotice(
          isSharedTerminal
            ? (existing.approved ? "この端末は管理・受付で共通登録されています。" : "この端末の管理・受付共通登録を申請しました。")
            : (existing.approved ? "この端末はすでに承認されています。" : "この端末はすでに登録申請されています。")
        );
        return;
      }

      const managementTerminals = remoteTerminals.filter(terminal => terminal.role === "management" || terminal.role === "both");
      const isFirstManagementTerminal = managementTerminals.length === 0;
      const terminal: ManagedTerminal = {
        terminalId: firebaseDeviceId,
        name: appSettings.deviceName || "管理端末",
        type: "Web / iPad",
        mode: "停止",
        status: isFirstManagementTerminal ? "online" : "pending",
        approved: isFirstManagementTerminal,
        managementApproved: isFirstManagementTerminal,
        receptionApproved: false,
        lastSeen: new Date().toISOString(),
        networkMbps: null,
        battery: null,
        role: "management",
        admin: isFirstManagementTerminal,
      };

      await saveTerminal(terminal);
      localStorage.setItem("qr-ticket-device-id", firebaseDeviceId);
      setTerminals(current => [...current.filter(item => item.terminalId !== firebaseDeviceId), terminal]);
      setForceTerminalRegistration(false);
      setSelectedTerminalId(terminal.terminalId);
      setTerminalNotice(
        isFirstManagementTerminal
          ? "最初の管理端末として自動承認されました。"
          : "この端末の登録申請を送信しました。管理者の承認を待ってください。"
      );
    } catch (reason) {
      console.error("Firebase terminal registration failed", reason);
      setTerminalNotice("Firebaseへの接続を確認してください。");
    }
  };

  const refreshTerminalState = () => {
    setTerminalNotice("端末状態を確認しました。未接続の端末は「見つかりません」と表示します。");
  };

  const pageContent = () => {
    if (page === "イベント管理") return <section className="event-management-screen">
      <div className="event-management-hero">
        <div><small>EVENT MANAGEMENT</small><h2>イベント管理</h2><p>開催するイベントの情報・状態・公開設定をまとめて管理します。</p></div>
        <button className="primary-action event-new-button" onClick={openNewEventModal}>＋ 新しいイベント</button>
      </div>

      {selectedHistoryEventId && event.eventId && <section className="event-current-card">
        <div className="event-current-heading">
          <div><small>現在のイベント</small><h3>{event.eventName}</h3><span className="event-current-id">{event.eventId}</span></div>
          <span className={"event-status-badge " + eventStatus}>{statusLabel[eventStatus]}</span>
        </div>
        <div className="event-current-info">
          <div><span>開催日</span><strong>{event.eventDate}</strong></div>
          <div><span>受付時間</span><strong>{event.startTime} – {event.endTime}</strong></div>
          <div><span>チケット</span><strong>{ticketStats.total}枚</strong></div>
          <div><span>公開状態</span><strong className={bundle ? "event-published" : ""}>{bundle ? "Firebaseへ公開済み" : "未公開"}</strong></div>
        </div>
        <div className="event-primary-actions">
          <button className="primary-action" disabled={publishing} onClick={() => void saveEvent()}>
            {publishing ? "保存・公開中…" : "保存してFirebaseへ公開"}
          </button>
        </div>
      </section>}

      <div className="event-management-grid">
        <section className="event-history-panel">
          <div className="event-section-heading"><div><small>EVENT LIST</small><h3>イベント一覧</h3></div><span>{eventHistory.length}件</span></div>
          <div className="event-history-list">
            {eventHistory.map(item => {
              const selected = item.eventId === selectedHistoryEventId;
              return <div className={selected ? "event-history-card selected" : "event-history-card"} key={item.eventId}>
                <button className="event-history-main" onClick={() => selectHistoryEvent(item)}>
                  <div><b>{item.eventName}</b><small>{item.eventDate} ・ {item.startTime}–{item.endTime}</small><span>{item.eventId}</span></div>
                </button>
                {selected && <div className="event-history-actions">
                  <div>
                    <button className="danger-action" onClick={() => deleteHistoryEvent(item.eventId)}>削除</button>
                  </div>
                </div>}
              </div>;
            })}
          </div>
        </section>

        {selectedHistoryEventId && event.eventId && <section className="event-details-panel">
          <div className="event-section-heading"><div><small>EVENT DETAILS</small><h3>イベント情報</h3></div><span>編集</span></div>
          <div className="form-grid event-form-grid">
            <label>イベント名<input value={eventName} onChange={e => setEventName(e.target.value)} /></label>
            <label>開催日<input type="date" value={eventDate} onChange={e => setEventDate(e.target.value)} /></label>
            <label>開始時刻<input type="time" value={startTime} onChange={e => setStartTime(e.target.value)} /></label>
            <label>終了時刻<input type="time" value={endTime} onChange={e => setEndTime(e.target.value)} /></label>
            <label>イベントID<input value={event.eventId} onChange={e => setEvent(current => ({ ...current, eventId: e.target.value }))} /></label>
            <label>データバージョン<input value={event.dataVersion} disabled /></label>
          </div>
          <button className="primary-action event-save-button" disabled={publishing} onClick={() => void saveEvent()}>
            {publishing ? "保存・公開中…" : "保存してFirebaseへ公開"}
          </button>
        </section>}
      </div>

      <section className="event-status-panel">
        <div className="event-section-heading"><div><small>EVENT STATUS</small><h3>イベント状態</h3></div><span>現在：{statusLabel[eventStatus]}</span></div>
        <div className="status-stepper">
          {(["preparing", "ready", "active", "finalizing", "finished"] as Event["eventStatus"][]).map(status => (
            <button key={status} className={eventStatus === status ? "status-step active" : "status-step"} onClick={() => changeEventStatus(status)}>
              <b>{statusLabel[status]}</b><span>{status}</span>
            </button>
          ))}
        </div>
      </section>

      {error && <div className="notice error">{error}</div>}
      {bundle && <div className="notice success">イベントデータはFirebaseへ公開済みです。受付端末は下のQRで認証できます。</div>}
      {bundle && <section className="auth-card event-auth-card">
        <div><small>EVENT AUTHENTICATION</small><h2>イベントデータQR</h2><p>受付アプリで読み取ると、このイベントのデータを受付端末へ準備します。</p><p className="token">{bundle.authToken}</p><button className="secondary" onClick={() => window.print()}>イベントデータQRを印刷</button></div>
        <div className="qr-box"><QRCodeSVG value={eventDataQrValue} size={220} includeMargin /></div>
      </section>}
    </section>;

    if (page === "チケット管理") return <>
      <div className="ticket-screen">
        <main className="ticket-home-grid">
          <section className="ticket-home-card ticket-operation-card">
            <div className="ticket-home-label">TICKET TOOLS</div>
            <h2>チケット操作</h2>
            <div className="ticket-operation-buttons">
              <button className="ticket-tool-button ticket-tool-create" onClick={() => setTicketCreateModalOpen(true)}>
                <span className="tool-icon"><PlusIcon /></span>
                <span><small>CREATE TICKETS</small><b>チケットを新規発行</b></span>
              </button>
              <button className="ticket-tool-button ticket-tool-design" onClick={() => setTicketDesignModalOpen(true)}>
                <span className="tool-icon"><PaletteIcon /></span>
                <span><small>DESIGN & PRINT</small><b>デザイン・印刷</b></span>
              </button>
            </div>
          </section>

          <button className="ticket-home-card ticket-list-launch" onClick={() => setTicketListOpen(true)}>
            <div className="ticket-list-launch-top">
              <div>
                <div className="ticket-home-label">ALL TICKETS</div>
                <h2>チケット一覧</h2>
              </div>
              <span className="ticket-launch-arrow">→</span>
            </div>
            <div className="ticket-list-launch-bottom">
              <span>QR番号・状態・操作を確認</span>
              <strong>{tickets.length || 0}<small>件</small></strong>
            </div>
          </button>

          <section className="ticket-home-card ticket-status-card">
            <div className="ticket-status-heading">
              <div><div className="ticket-home-label">TICKET STATUS</div><h2>チケット状況</h2></div>
              <strong>{ticketStats.total}<span>枚</span></strong>
            </div>
            <div className="ticket-status-grid">
              <div className="ticket-status-box unused"><span>未使用</span><strong>{ticketStats.unused}</strong><em>枚</em></div>
              <div className="ticket-status-box inside"><span>入場中</span><strong>{ticketStats.inside}</strong><em>枚</em></div>
              <div className="ticket-status-box used"><span>使用済み</span><strong>{ticketStats.exited}</strong><em>枚</em></div>
              <div className="ticket-status-box invalid"><span>無効</span><strong>{tickets.filter(ticket => !ticket.valid).length}</strong><em>枚</em></div>
            </div>
            <div className="ticket-sync-state"><i />リアルタイム同期中</div>
          </section>
        </main>

        {ticketListOpen && <div className="ticket-list-overlay" onMouseDown={() => setTicketListOpen(false)}>
        <section className="ticket-list-fullscreen" onMouseDown={e => e.stopPropagation()}>
          <header className="ticket-list-fullscreen-header">
            <div><div className="ticket-home-label">ALL TICKETS</div><h2>チケット一覧</h2></div>
            <button className="ticket-list-close" onClick={() => setTicketListOpen(false)}>×</button>
          </header>
          <div className="ticket-list-toolbar">
            <div className="ticket-search-box"><SearchIcon /><input placeholder="QR番号を検索" value={ticketQuery} onChange={e => setTicketQuery(e.target.value)} /></div>
            <div className="ticket-filter-box"><FilterIcon /><select value={ticketStatusFilter} onChange={e => setTicketStatusFilter(e.target.value as typeof ticketStatusFilter)}>
              <option value="all">すべての状態</option><option value="unused">未使用</option><option value="inside">入場中</option><option value="exited">使用済み</option>
            </select></div>
            <div className="ticket-list-total">全<strong>{tickets.length}</strong>件</div>
          </div>
          {tickets.length > 0 ? <div className="ticket-screen-table ticket-full-table">
            <div className="ticket-screen-table-head"><span>QR番号</span><span>状態</span><span>操作</span></div>
            {filteredTickets.map(ticket => (
              <div className="ticket-screen-row" key={ticket.ticketId}>
                <div className="ticket-number-cell"><span className="mini-qr"><QrIcon /></span><strong>{ticket.ticketId}</strong></div>
                <select className={`ticket-status-select status-${ticket.currentStatus}`} value={ticket.currentStatus} onChange={e => updateTicketStatus(ticket.ticketId, e.target.value as Ticket["currentStatus"])}>
                  <option value="unused">未使用</option><option value="inside">入場中</option><option value="exited">使用済み</option>
                </select>
                <div className="ticket-row-actions">
                  <button className="ticket-row-view" onClick={() => setTicketQrModalTicket(ticket)}>QR表示</button>
                  <button className="ticket-row-disable" onClick={() => toggleTicketValidity(ticket.ticketId)}>{ticket.valid ? "無効化" : "有効化"}</button>
                  <button className="ticket-row-delete" onClick={() => deleteTicket(ticket.ticketId)}>削除</button>
                </div>
              </div>
            ))}
          </div> : <div className="ticket-list-empty"><h3>チケットがありません</h3><p>「チケットを新規発行」からQRチケットを作成してください。</p></div>}
        </section>
      </div>}

      {ticketCreateModalOpen && <div className="ticket-modal-backdrop" onMouseDown={() => setTicketCreateModalOpen(false)}>
        <div className="ticket-modal" onMouseDown={e => e.stopPropagation()}>
          <button className="ticket-modal-close" onClick={() => setTicketCreateModalOpen(false)}>×</button>
          <small>CREATE TICKETS</small><h2>チケットを新規発行</h2><p>番号とQRコードをまとめて生成します。</p>
          <div className="ticket-modal-grid">
            <label>チケットタイトル<input value={ticketTitle} onChange={e => setTicketTitle(e.target.value)} /></label>
            <label>発行枚数<input type="number" min="1" max="5000" value={ticketCount} onChange={e => {
              const value = e.target.value;
              setTicketCount(value === "" ? 0 : Math.min(5000, Math.max(0, Number(value) || 0)));
            }} /></label>
            <label>番号プレフィックス<input value={ticketPrefix} maxLength={12} onChange={e => setTicketPrefix(e.target.value)} /></label>
            <label>開始番号<input type="number" value={tickets.length ? Math.max(...tickets.map(ticket => Number(ticket.basicInfo.ticketNumber) || 0)) + 1 : 1} disabled /></label>
          </div>
          <div className="ticket-modal-actions">
            <button className="secondary" onClick={() => setTicketCreateModalOpen(false)}>キャンセル</button>
            <button className="ticket-modal-primary" onClick={() => { void generateTickets(); setTicketCreateModalOpen(false); }}>QR・チケットを発行</button>
          </div>
        </div>
      </div>}

      {ticketDesignModalOpen && <TicketDesigner
        eventName={event.eventName}
        tickets={tickets.map(ticket => ({
          id: ticket.ticketId,
          qrNumber: String(ticket.basicInfo.ticketNumber).padStart(6, "0"),
          status: ticket.currentStatus,
          valid: ticket.valid,
        }))}
        qrValue={ticket => {
          const source = tickets.find(item => item.ticketId === ticket.id);
          return source ? ticketQrValue(event.eventId, source) : "";
        }}
        onClose={() => setTicketDesignModalOpen(false)}
      />}

      {ticketQrModalTicket && <div className="ticket-modal-backdrop" onMouseDown={() => setTicketQrModalTicket(null)}>
        <div className="ticket-modal ticket-qr-modal" onMouseDown={e => e.stopPropagation()}>
          <button className="ticket-modal-close" onClick={() => setTicketQrModalTicket(null)} aria-label="閉じる">×</button>
          <div className="ticket-qr-modal-heading">
            <div className="ticket-qr-modal-icon"><QrIcon /></div>
            <div><small>TICKET QR CODE</small><h2>チケットQRコード</h2></div>
          </div>
          <div className="ticket-qr-large">
            <QRCodeSVG value={ticketQrValue(event.eventId, ticketQrModalTicket)} size={280} includeMargin />
          </div>
          <strong className="ticket-qr-number">{ticketQrModalTicket.ticketId}</strong>
          <div className={`ticket-qr-status ticket-qr-status-${ticketQrModalTicket.currentStatus}`}>
            <span>●</span>{ticketQrModalTicket.currentStatus === "inside" ? "入場中" : ticketQrModalTicket.currentStatus === "exited" ? "使用済み" : "未使用"}
          </div>
          <p className="ticket-qr-help">このQRコードを入口・出口受付で読み取れます。</p>
          <div className="ticket-modal-actions">
            <button className="secondary ticket-qr-close-button" onClick={() => setTicketQrModalTicket(null)}>閉じる</button>
          </div>
        </div>
      </div>}
      </div>
    </>;

    if (page === "端末管理") {
      const ownTerminal = terminals.find(terminal => terminal.terminalId === firebaseDeviceId);
      if (!ownTerminal) {
        return <div className="terminal-registration-screen">
          <section className="terminal-registration-card">
            <div className="terminal-registration-badge">TERMINAL REGISTRATION</div>
            <h2>端末登録申請</h2>
            <p>この端末を管理アプリとして使用するため、最初に登録申請を送信してください。</p>

            <div className="terminal-registration-preview">
              <div>
                <span>端末種別</span>
                <strong>Web / iPad</strong>
              </div>
              <div>
                <span>端末ID</span>
                <strong className="terminal-mono">{firebaseDeviceId}</strong>
              </div>
            </div>

            <label className="terminal-registration-name">
              <span>端末名</span>
              <input
                value={appSettings.deviceName}
                onChange={e => updateOwnTerminalName(e.target.value)}
                placeholder="例：入口受付 iPad"
              />
            </label>

            <div className="terminal-registration-flow">
              <div><b>1</b><span>端末情報を確認</span></div>
              <div><b>2</b><span>登録申請を送信</span></div>
              <div><b>3</b><span>管理者が承認</span></div>
            </div>

            <button className="primary-action terminal-registration-submit" onClick={registerOwnTerminal}>
              この端末を登録申請
            </button>
            {terminalNotice && <div className="terminal-notice">{terminalNotice}</div>}
          </section>
        </div>;
      }

      const onlineCount = terminals.filter(terminal => terminal.status === "online" && terminal.approved).length;
      const pendingTerminals = terminals.filter(terminal => !terminal.approved || terminal.status === "pending" || ((terminal.role === "reception" || terminal.role === "both") && terminal.receptionApproved !== true));
      const approvedTerminals = terminals.filter(terminal => terminal.approved && terminal.status !== "pending");
      const pendingCount = pendingTerminals.length;
      const notFoundCount = approvedTerminals.filter(terminal => terminal.status !== "online").length;

      return <div className="terminal-management-screen">
        <section className="terminal-hero">
          <div>
            <small>TERMINAL MANAGEMENT</small>
            <h2>端末管理</h2>
            <p>受付端末の登録・認証・接続状態・受付状態を一か所で管理します。</p>
          </div>
          <div className="terminal-hero-actions">
            <button className="secondary" onClick={refreshTerminalState}>状態を更新</button>
            <button className="primary-action" onClick={registerOwnTerminal} disabled={terminals.some(terminal => terminal.terminalId === firebaseDeviceId && (terminal.approved || terminal.status === "pending"))}>＋ この端末を登録</button>
            <button className="secondary" onClick={() => setPage("イベント管理")}>イベント認証QR</button>
          </div>
        </section>

        <section className="terminal-summary-grid">
          <div className="terminal-summary-card"><small>REGISTERED</small><strong>{approvedTerminals.length}</strong><span>登録済み端末</span></div>
          <div className="terminal-summary-card online"><small>ONLINE</small><strong>{onlineCount}</strong><span>接続中</span></div>
          <div className="terminal-summary-card pending"><small>APPROVAL</small><strong>{pendingCount}</strong><span>承認待ち</span></div>
          <div className="terminal-summary-card not-found"><small>NOT FOUND</small><strong>{notFoundCount}</strong><span>見つかりません</span></div>
        </section>

        <section className="terminal-own-card">
          <div className="terminal-section-heading">
            <div><small>MY TERMINAL</small><h3>自分の端末</h3><p>この端末を受付端末として登録します。登録後、管理者の承認を受けて運用を開始します。</p></div>
            <span className="terminal-state-badge pending">登録前</span>
          </div>
          <div className="terminal-own-grid">
            <label className="terminal-name-editor">
              <span>端末名</span>
              <input value={appSettings.deviceName} onChange={e => updateOwnTerminalName(e.target.value)} />
            </label>
            <div><span>端末種別</span><strong>Web / iPad</strong></div>
            <div><span>端末ID</span><strong className="terminal-mono">この端末</strong></div>
            <div><span>接続状態</span><strong className="terminal-state-text online">ブラウザ動作中</strong></div>
          </div>
        </section>

        <section className="terminal-list-card terminal-pending-card">
          <div className="terminal-section-heading">
            <div><small>PENDING APPROVAL</small><h3>承認待ち端末</h3><p>新しく登録申請された端末は、ここで承認してから登録済み端末に移動します。</p></div>
            <span className="terminal-section-count">{pendingCount}台</span>
          </div>

          {pendingTerminals.length ? (
            <div className="terminal-list">
              {pendingTerminals.map(terminal => (
                <article className="managed-terminal-card pending-card" key={terminal.terminalId}>
                  <div className="managed-terminal-main">
                    <div className="managed-terminal-icon">iPad</div>
                    <div className="managed-terminal-title">
                      <div>
                        <h4>{terminal.name}</h4>
                        <span className="terminal-mono">{terminal.terminalId}</span>
                      </div>
                      <span className="terminal-state-badge pending">承認待ち</span>
                    </div>
                    <div className="managed-terminal-meta">
                      <div><span>端末種別</span><strong>{terminal.type}</strong></div>
                      <div><span>受付状態</span><strong>{terminal.mode}</strong></div>
                      <div><span>申請時接続</span><strong>{terminal.lastSeen ? terminal.lastSeen : "未接続"}</strong></div>
                    </div>
                  </div>

                  <div className="managed-terminal-footer">
                    <div className="terminal-network">
                      <span>通信速度</span>
                      {terminal.networkMbps !== null ? (
                        <strong>{terminal.networkMbps.toFixed(1)} Mbps</strong>
                      ) : (
                        <strong>—</strong>
                      )}
                    </div>
                    <div className="managed-terminal-actions">
                      <button className="primary-action" disabled={!canManageTerminals} onClick={() => approveTerminal(terminal.terminalId)}>承認する</button>
                      {canManageTerminals && terminal.terminalId !== firebaseDeviceId && !terminal.admin && (
                        <button className="danger-action" onClick={() => void deleteManagedTerminal(terminal.terminalId)}>削除</button>
                      )}
                    </div>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <div className="terminal-empty-state">
              <strong>承認待ちの端末はありません</strong>
              <span>端末から登録申請が届くと、ここに表示されます。</span>
            </div>
          )}
        </section>

        <section className="terminal-list-card">
          <div className="terminal-section-heading">
            <div><small>REGISTERED TERMINALS</small><h3>登録済み端末</h3><p>承認済みの受付端末を管理します。他端末の名前は管理画面から変更せず、端末側で設定します。</p></div>
            <span className="terminal-section-count">{approvedTerminals.length}台</span>
          </div>

          {approvedTerminals.length ? (
            <div className="terminal-list">
              {approvedTerminals.map(terminal => {
                const isOnline = terminal.status === "online" && terminal.approved;
                return <article className={(selectedTerminalId === terminal.terminalId ? "managed-terminal-card selected" : "managed-terminal-card") + (terminal.admin ? " admin-terminal" : "") + (terminal.subAdmin ? " sub-admin-terminal" : "")} key={terminal.terminalId}>
                  <div className="managed-terminal-main">
                    <div className="managed-terminal-icon">iPad</div>
                    <div className="managed-terminal-title">
                      <div>
                        <h4>{terminal.name}</h4>
                        <span className="terminal-mono">{terminal.terminalId}</span>
                      </div>
                      <div className="managed-terminal-role-row" style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 8, flexWrap: "wrap" }}>
                        {terminal.admin && <span className="terminal-role-badge admin">管理者</span>}
                        {!terminal.admin && terminal.subAdmin && <span className="terminal-role-badge sub-admin">副管理者</span>}
                        <span className={terminal.role === "both" ? "terminal-role-badge both" : terminal.role === "management" ? "terminal-role-badge management" : "terminal-role-badge reception"}>
                          {terminal.role === "both" ? "管理・受付" : terminal.role === "management" ? "管理アプリ" : "受付アプリ"}
                        </span>
                        <span className={isOnline ? "terminal-state-badge online" : "terminal-state-badge offline"}>
                          {isOnline ? "接続中" : "見つかりません"}
                        </span>
                      </div>
                    </div>
                    <div className="managed-terminal-meta">
                      <div><span>端末種別</span><strong>{terminal.type}</strong></div>
                      <div><span>受付状態</span><strong>{terminal.mode}</strong></div>
                      <div><span>最終接続</span><strong>{terminal.lastSeen ? terminal.lastSeen : "未接続"}</strong></div>
                    </div>
                  </div>

                  <div className="managed-terminal-footer">
                    <div className="terminal-network">
                      <span>通信速度</span>
                      {terminal.networkMbps !== null ? (
                        <strong>{terminal.networkMbps.toFixed(1)} Mbps</strong>
                      ) : (
                        <strong>—</strong>
                      )}
                      <div className="terminal-network-bars" aria-label="通信速度">
                        {[1,2,3,4,5,6].map(level => <i key={level} className={terminal.networkMbps !== null && terminal.networkMbps >= level * 3 ? "active" : ""} />)}
                      </div>
                    </div>
                    <div className="managed-terminal-actions">
                      {(terminal.role === "reception" || terminal.role === "both") && canManageTerminals && (
                        <button className="secondary" onClick={() => setSelectedTerminalId(selectedTerminalId === terminal.terminalId ? null : terminal.terminalId)}>操作パネル</button>
                      )}
                      {terminal.terminalId === firebaseDeviceId && (terminal.role === "reception" || terminal.role === "both") && (
                        <button className="danger-action" onClick={() => void releaseOwnReception()}>受付を解除</button>
                      )}
                      {canManageTerminals && ownTerminal?.admin && terminal.terminalId !== firebaseDeviceId && !terminal.admin && (
                        <button className={terminal.subAdmin ? "secondary sub-admin-action" : "secondary"} onClick={() => void setSubAdmin(terminal.terminalId, !terminal.subAdmin)}>
                          {terminal.subAdmin ? "副管理者を解除" : "副管理者に設定"}
                        </button>
                      )}
                      {canManageTerminals && terminal.terminalId !== firebaseDeviceId && (
                        <button className="danger-action" onClick={() => void deleteManagedTerminal(terminal.terminalId)}>削除</button>
                      )}
                    </div>
                  </div>

                  {selectedTerminalId === terminal.terminalId && (
                    <div className="terminal-control-panel">
                      <div className="terminal-control-heading">
                        <div><small>REMOTE CONTROL</small><h4>{terminal.name}を操作</h4></div>
                        {!isOnline && <span>端末が見つからないため操作できません</span>}
                      </div>
                      <div className="terminal-control-grid">
                        <button disabled={!isOnline} onClick={() => setTerminalMode(terminal.terminalId, "入口受付")}>入口受付</button>
                        <button disabled={!isOnline} onClick={() => setTerminalMode(terminal.terminalId, "出口受付")}>出口受付</button>
                        <button disabled={!isOnline} onClick={() => setTerminalMode(terminal.terminalId, "停止")}>受付停止</button>
                        <button disabled={!isOnline} onClick={() => setTerminalMode(terminal.terminalId, terminal.mode)}>現在状態を再適用</button>
                      </div>
                      <div className="terminal-control-note">※ リモート操作は端末が実際に接続されたときだけ有効になります。未接続時は誤操作を防ぐため無効化しています。</div>
                    </div>
                  )}
                </article>;
              })}
            </div>
          ) : (
            <div className="terminal-empty-state">
              <strong>登録済みの端末はありません</strong>
              <span>承認した端末はここに表示されます。</span>
            </div>
          )}
        </section>

        {terminalNotice && <div className="notice success terminal-notice">{terminalNotice}</div>}
      </div>;
    }

    if (page === "部員管理") return <>
      <section className="panel member-management-panel">
        <div className="panel-title">
          <div><small>MEMBER MANAGEMENT</small><h2>部員管理</h2><p>部員名と認証用の部員番号をまとめて管理します。</p></div>
          <span className="pill">{members.length}人</span>
        </div>

        <div className="member-summary">
          <div><small>REGISTERED MEMBERS</small><strong>{members.length}</strong><span>登録部員</span></div>
          <div><small>AUTHENTICATION</small><strong>{members.length}</strong><span>認証QR発行可能</span></div>
        </div>

        <div className="member-register-launch">
          <div>
            <small>MEMBER REGISTRATION</small>
            <strong>部員を登録</strong>
            <span>新しい部員を登録して、部員番号を発行します。</span>
          </div>
          <button className="primary-action" onClick={() => { setMemberName(""); setMemberRegistrationOpen(true); }}>＋ 部員を登録</button>
        </div>

        <div className="member-toolbar">
          <div>
            <small>MEMBER LIST</small>
            <h3>部員一覧</h3>
          </div>
          <div className="member-toolbar-actions">
            <label className="member-search">
              <SearchIcon />
              <input placeholder="名前・部員番号を検索" value={memberQuery} onChange={e => setMemberQuery(e.target.value)} />
            </label>
            <button className="secondary member-bulk-button" disabled={!selectedMemberIds.length} onClick={() => { setMemberBulkText(""); setMemberBulkModalOpen(true); }}>まとめて変更</button>
          </div>

        </div>

        {members.length ? (
          <div className="member-table">
            <div className="member-table-head"><span className="member-check-cell"><input type="checkbox" checked={filteredMembers.length > 0 && filteredMembers.every(member => selectedMemberIds.includes(member.memberId))} onChange={toggleAllFilteredMembers} aria-label="表示中の部員をすべて選択" /></span><span>部員番号</span><span>氏名</span><span>認証QR</span><span>操作</span></div>
            {filteredMembers.map(member => (
              <div className="member-row" key={member.memberId}><div className="member-check-cell"><input type="checkbox" checked={selectedMemberIds.includes(member.memberId)} onChange={() => toggleMemberSelection(member.memberId)} aria-label={`${member.memberNumber}番を選択`} /></div>
                <div>
                  <strong>{member.memberId}</strong>
                  <small>#{String(member.memberNumber).padStart(3, "0")}</small>
                </div>
                <input
                  className="member-name-input"
                  value={member.name}
                  onChange={e => updateMemberName(member.memberId, e.target.value)}
                  aria-label={`${member.memberId}の氏名`}
                />
                <button className="member-qr-button" onClick={() => setMemberQrModal(member)}>QR表示</button>
                <button className="member-delete-button" onClick={() => deleteMember(member.memberId)}>削除</button>
              </div>
            ))}
            {!filteredMembers.length && <div className="member-empty-filter">検索条件に一致する部員はいません。</div>}
          </div>
        ) : (
          <div className="empty member-empty">
            <h3>部員を登録してください</h3>
            <p>部員名を入力して追加すると、部員番号と認証QRが自動で発行されます。</p>
          </div>
        )}
      </section>

      {memberBulkModalOpen && <div className="member-registration-backdrop" onMouseDown={() => setMemberBulkModalOpen(false)}>
        <section className="member-registration-modal member-bulk-modal" onMouseDown={e => e.stopPropagation()}>
          <button className="member-registration-close" onClick={() => setMemberBulkModalOpen(false)} aria-label="閉じる">×</button>
          <div className="member-registration-heading"><small>BULK MEMBER EDIT</small><h2>部員名をまとめて変更</h2><p>選択した部員の順番に合わせて、1行に1人ずつ入力してください。</p></div>
          <div className="member-bulk-info">{selectedMemberIds.length}人を変更</div>
          <textarea className="member-bulk-textarea" value={memberBulkText} onChange={e => setMemberBulkText(e.target.value)} placeholder={filteredMembers.filter(member => selectedMemberIds.includes(member.memberId)).map(member => member.name || "未登録").join("\n")} rows={Math.max(5, selectedMemberIds.length)} />
          <div className="member-bulk-order">{filteredMembers.filter(member => selectedMemberIds.includes(member.memberId)).map(member => <span key={member.memberId}>#{member.memberNumber}</span>)}</div>
          <div className="member-registration-actions"><button className="secondary" onClick={() => setMemberBulkModalOpen(false)}>キャンセル</button><button className="primary-action" disabled={memberBulkText.split(/\r?\n/).filter(name => name.trim()).length !== selectedMemberIds.length} onClick={applyBulkMemberNames}>変更を適用</button></div>
        </section>
      </div>}

      {memberRegistrationOpen && <div className="member-registration-backdrop" onMouseDown={() => setMemberRegistrationOpen(false)}>
        <section className="member-registration-modal" onMouseDown={e => e.stopPropagation()}>
          <button className="member-registration-close" onClick={() => setMemberRegistrationOpen(false)} aria-label="閉じる">×</button>
          <div className="member-registration-heading">
            <small>MEMBER REGISTRATION</small>
            <h2>部員を登録</h2>
            <p>部員名を入力すると、部員番号が自動で発行されます。</p>
          </div>
          <label className="member-registration-field">
            <span>部員名</span>
            <input
              autoFocus
              placeholder="例：山田 太郎"
              value={memberName}
              onChange={e => setMemberName(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") { addMember(); setMemberRegistrationOpen(false); } }}
            />
          </label>
          <div className="member-registration-preview">
            <span>発行される部員番号</span>
            <strong>MBR-{String(members.reduce((max, member) => Math.max(max, member.memberNumber), 0) + 1).padStart(4, "0")}</strong>
          </div>
          <div className="member-registration-actions">
            <button className="secondary" onClick={() => setMemberRegistrationOpen(false)}>キャンセル</button>
            <button className="primary-action" disabled={!memberName.trim()} onClick={() => { addMember(); setMemberRegistrationOpen(false); }}>部員を登録</button>
          </div>
        </section>
      </div>}

      {memberQrModal && <div className="member-qr-backdrop" onMouseDown={() => setMemberQrModal(null)}>
        <section className="member-qr-modal" onMouseDown={e => e.stopPropagation()}>
          <button className="member-qr-close" onClick={() => setMemberQrModal(null)} aria-label="閉じる">×</button>
          <div className="member-qr-heading">
            <div className="member-qr-icon"><QrIcon /></div>
            <div><small>MEMBER AUTHENTICATION</small><h2>部員認証QR</h2></div>
          </div>
          <div className="member-qr-code">
            <QRCodeSVG
              value={JSON.stringify({
                type: "member-auth",
                eventId: event.eventId,
                memberId: memberQrModal.memberId,
                memberNumber: memberQrModal.memberNumber,
                name: memberQrModal.name,
              })}
              size={260}
              includeMargin
            />
          </div>
          <strong>{memberQrModal.name}</strong>
          <span>{memberQrModal.memberId}</span>
          <p>このQRを部員認証に使用できます。</p>
          <div className="member-qr-actions">
            <button className="secondary" onClick={() => window.print()}>印刷</button>
            <button className="secondary" onClick={() => setMemberQrModal(null)}>閉じる</button>
          </div>
        </section>
      </div>}
    </>;

    if (page === "分析") {
      const selectedRecord = analysisHistory.find(item => item.eventId === selectedAnalysisEventId);
      const isCurrentAnalysis = !selectedRecord || selectedAnalysisEventId === event.eventId;
      const analyzedTotal = isCurrentAnalysis ? ticketStats.inside + ticketStats.exited : selectedRecord.total - selectedRecord.unused;
      const total = isCurrentAnalysis ? ticketStats.total : selectedRecord.total;
      const unused = isCurrentAnalysis ? ticketStats.unused : selectedRecord.unused;
      const inside = isCurrentAnalysis ? ticketStats.inside : selectedRecord.inside;
      const exited = isCurrentAnalysis ? ticketStats.exited : selectedRecord.exited;
      const utilization = total > 0 ? Math.round((analyzedTotal / total) * 100) : 0;
      const insideRate = analyzedTotal > 0 ? Math.round((inside / analyzedTotal) * 100) : 0;
      const exitedRate = analyzedTotal > 0 ? Math.round((exited / analyzedTotal) * 100) : 0;
      const analysisEventName = isCurrentAnalysis ? event.eventName : selectedRecord.eventName;
      const analysisEventDate = isCurrentAnalysis ? event.eventDate : selectedRecord.eventDate;

      return <div className="analysis-screen">
        <section className="analysis-summary">
          <div className="analysis-summary-heading">
            <div><small>ANALYSIS OVERVIEW</small><h2>イベント分析</h2><p>{analysisEventName} ・ {analysisEventDate}</p></div>
            <span className="analysis-live"><i />リアルタイム集計</span>
          </div>
          <div className="analysis-metrics">
            <div className="analysis-metric primary"><small>来場者数</small><strong>{analyzedTotal}</strong><span>人</span><b>入場済み + 退場済み</b></div>
            <div className="analysis-metric"><small>現在の会場内</small><strong>{inside}</strong><span>人</span><b>{insideRate}% が会場内</b></div>
            <div className="analysis-metric"><small>退場者数</small><strong>{exited}</strong><span>人</span><b>{exitedRate}% が退場済み</b></div>
            <div className="analysis-metric"><small>チケット利用率</small><strong>{utilization}</strong><span>%</span><b>{analyzedTotal} / {total} 枚</b></div>
          </div>
        </section>

        <section className="analysis-history-panel">
          <div className="analysis-history-heading">
            <div><small>PAST EVENTS</small><h3>過去のイベントデータ</h3></div>
            <button className="secondary" onClick={() => saveAnalysisSnapshot()}>{isCurrentAnalysis ? "現在のデータを保存" : "現在のイベントを保存"}</button>
          </div>
          {analysisHistory.length === 0 ? (
            <div className="analysis-history-empty">まだ保存された過去データはありません。イベント終了時に保存すると、あとから確認できます。</div>
          ) : (
            <div className="analysis-history-list">
              {analysisHistory.map(record => (
                <button key={record.eventId} className={selectedAnalysisEventId === record.eventId ? "analysis-history-item selected" : "analysis-history-item"} onClick={() => setSelectedAnalysisEventId(record.eventId)}>
                  <span><b>{record.eventName}</b><small>{record.eventDate} ・ 利用 {record.total - record.unused}人</small></span>
                  <strong>{record.total}枚</strong>
                </button>
              ))}
              <button className={selectedAnalysisEventId === event.eventId ? "analysis-history-item selected current" : "analysis-history-item current"} onClick={() => setSelectedAnalysisEventId(event.eventId)}>
                <span><b>{event.eventName}</b><small>{event.eventDate} ・ 現在のイベント</small></span>
                <strong>現在</strong>
              </button>
            </div>
          )}
        </section>

        <div className="analysis-grid">
          <section className="analysis-card analysis-chart-card">
            <div className="analysis-card-heading"><div><small>VISITOR FLOW</small><h3>時間帯別来場者数</h3></div><span>受付記録から集計</span></div>
            <div className="analysis-empty-chart">
              <div className="analysis-y-axis"><span>多</span><span>中</span><span>少</span></div>
              <div className="analysis-chart-area">
                {(() => {
                  const startHour = Number(event.startTime.slice(0, 2));
                  const endHour = Number(event.endTime.slice(0, 2));
                  const hours = Array.from({ length: Math.max(1, endHour - startHour + 1) }, (_, index) => startHour + index);
                  const counts = hours.map(hour => receptionRecords.filter(record => {
                    if (record.type !== "entry") return false;
                    return new Date(record.timestamp).getHours() === hour;
                  }).length);
                  const max = Math.max(1, ...counts);
                  return <>
                    <div className="analysis-y-axis"><span>{max}</span><span>{Math.ceil(max / 2)}</span><span>0</span></div>
                    <div className="analysis-live-bars">
                      {hours.map((hour, index) => (
                        <div className="analysis-live-bar-column" key={hour}>
                          <div className="analysis-live-bar-track"><div className="analysis-live-bar" style={{ height: `${(counts[index] / max) * 100}%` }} /></div>
                          <span>{String(hour).padStart(2, "0")}:00</span><b>{counts[index]}</b>
                        </div>
                      ))}
                    </div>
                  </>;
                })()}
              </div>
            </div>
          </section>

          <section className="analysis-card">
            <div className="analysis-card-heading"><div><small>TICKET STATUS</small><h3>チケット利用状況</h3></div><span>{total}枚</span></div>
            <div className="analysis-status-list">
              <div className="analysis-status-row"><div><span className="analysis-status-dot unused" /><b>未使用</b><strong>{ticketStats.unused}</strong></div><div className="analysis-progress"><i style={{width: total ? `${(unused / total) * 100}%` : "0%"}} /></div></div>
              <div className="analysis-status-row"><div><span className="analysis-status-dot inside" /><b>入場中</b><strong>{ticketStats.inside}</strong></div><div className="analysis-progress"><i style={{width: total ? `${(inside / total) * 100}%` : "0%"}} /></div></div>
              <div className="analysis-status-row"><div><span className="analysis-status-dot exited" /><b>退場済み</b><strong>{ticketStats.exited}</strong></div><div className="analysis-progress"><i style={{width: total ? `${(exited / total) * 100}%` : "0%"}} /></div></div>
            </div>
            <div className="analysis-total-box"><span>利用済み</span><strong>{analyzedTotal}枚</strong><small>全チケットの {utilization}%</small></div>
          </section>

          <section className="analysis-card analysis-chart-card">
            <div className="analysis-card-heading"><div><small>VENUE CAPACITY</small><h3>会場内人数の推移</h3></div><span>現在 {inside}人</span></div>
            {(() => {
              const timeline = receptionRecords
                .filter(record => (record.type === "entry" || record.type === "exit") && typeof record.timestamp === "string")
                .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
              if (!timeline.length) return <div className="analysis-capacity-empty"><div><strong>まだ推移データがありません</strong><span>入退場記録が蓄積されると、会場内人数の変化を確認できます。</span></div></div>;
              let current = 0;
              const points = timeline.map(record => {
                current += record.type === "entry" ? 1 : -1;
                return { timestamp: record.timestamp, value: Math.max(0, current) };
              });
              const max = Math.max(1, ...points.map(point => point.value));
              return <div className="analysis-capacity-chart">
                <div className="analysis-capacity-current"><span>現在</span><strong>{current}人</strong></div>
                <div className="analysis-capacity-bars">
                  {points.slice(-24).map((point, index) => (
                    <div className="analysis-capacity-bar-column" key={point.timestamp + index}>
                      <div className="analysis-capacity-bar-track"><div className="analysis-capacity-bar" style={{ height: `${(point.value / max) * 100}%` }} /></div>
                      <span>{new Date(point.timestamp).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })}</span>
                    </div>
                  ))}
                </div>
              </div>;
            })()}
          </section>

          <section className="analysis-card">
            <div className="analysis-card-heading"><div><small>REPORT</small><h3>データ操作</h3></div></div>
            <div className="analysis-actions">
              <button className="secondary" disabled>データを保存</button>
              <button className="secondary" disabled>CSV出力</button>
            </div>
            <p className="analysis-note">現在は画面上のイベントデータを基に集計しています。受付記録の保存・同期機能を接続すると、時間帯別の詳細分析とCSV出力が利用できます。</p>
          </section>
        </div>
      </div>;
    }

    if (page === "設定") return <div className="settings-screen">
      <section className="settings-hero">
        <div><small>SYSTEM SETTINGS</small><h2>設定</h2><p>受付端末・受付動作・データ管理・実験機能をまとめて管理します。</p></div>
        <span className="settings-device-pill">{appSettings.deviceName}</span>
      </section>

      <section className="settings-section">
        <div className="settings-section-heading"><small>DEVICE</small><h3>端末設定</h3><p>この端末の識別情報を管理します。</p></div>
        <div className="settings-card">
          <label className="settings-input-row"><div><b>端末名</b><small>管理画面で表示する端末名</small></div><input value={appSettings.deviceName} onChange={e => updateAppSetting("deviceName", e.target.value)} /></label>
          <div className="settings-info-grid">
            <div><span>端末種別</span><strong>Web / iPad</strong></div>
            <div><span>イベント</span><strong>{event.eventName}</strong></div>
            <div><span>イベントID</span><strong>{event.eventId}</strong></div>
            <div><span>接続状態</span><strong className="settings-state-ok">ブラウザ動作中</strong></div>
          </div>
        </div>
      </section>

      <section className="settings-section">
        <div className="settings-section-heading"><small>DATA</small><h3>データ</h3><p>バックアップ、復元、現在の保存状態を確認します。</p></div>
        <div className="settings-card">
          <div className="settings-info-grid">
            <div><span>イベント履歴</span><strong>{eventHistory.length}件</strong></div>
            <div><span>分析データ</span><strong>{analysisHistory.length}件</strong></div>
            <div><span>チケット</span><strong>{tickets.length || ticketCount}枚</strong></div>
            <div><span>部員データ</span><strong>{members.length}人</strong></div>
          </div>
          <div className="settings-data-actions"><button className="secondary" onClick={exportBackup}>バックアップを保存</button><button className="secondary" onClick={importBackup}>バックアップを復元</button></div>
        </div>
      </section>

      <section className="settings-section">
        <div className="settings-section-heading"><small>TEST LAB</small><h3>試験機能</h3><p>試験用の機能です。本番のQR認証判定には使用しません。</p></div>
        <div className="settings-card">
          <Setting title="試験機能をオンにする" text="ONにすると試験用の実験メニューを表示します" checked={appSettings.aiLabEnabled} onChange={() => updateAppSetting("aiLabEnabled", !appSettings.aiLabEnabled)} />
          <div className={appSettings.aiLabEnabled ? "settings-experiment unlocked" : "settings-experiment"}><span>実験機能</span><strong>{appSettings.aiLabEnabled ? "有効" : "無効"}</strong></div>
        </div>
      </section>

      <section className="settings-section settings-danger">
        <div className="settings-section-heading"><small>SYSTEM</small><h3>システム</h3><p>初期化はこの端末に保存されたデータにのみ適用されます。</p></div>
        <div className="settings-card">
          <div className="settings-danger-row"><div><b>すべてのデータを初期化</b><small>イベント履歴・分析履歴・チケット・部員情報・設定を削除します。</small></div><button className="danger-action" onClick={resetAllData}>データを初期化</button></div>
          <div className="settings-actions"><button className="secondary" onClick={resetAppSettings}>設定を初期状態に戻す</button></div>
        </div>
      </section>

      {settingsNotice && <div className="settings-toast">{settingsNotice}</div>}
      {error && <div className="notice error">{error}</div>}
    </div>;

    return <>
      <section className="hero">
        <div><small>EVENT CONTROL CENTER</small><h2>{savedEventName}</h2><p>{event.eventDate} {event.startTime}–{event.endTime} ・ {event.eventId} ・ {statusLabel[eventStatus]} ・ チケット {ticketStats.total}枚</p></div>
        <span className={bundle ? "pill ok" : "pill"}>{bundle ? "公開済み" : statusLabel[eventStatus]}</span>
      </section>
      <div className="metrics">
        <Metric title="チケット" value={String(ticketStats.total)} sub="枚" />
        <Metric title="入場中" value={String(ticketStats.inside)} sub="人" />
        <Metric title="公開状態" value={bundle ? "OK" : "—"} sub="Firebase" />
      </div>
      <section className="panel">
        <small>QUICK ACTION</small><h2>よく使う操作</h2>
        <div className="quick">
          <button onClick={() => setPage("イベント管理")}>イベントを管理 <b>›</b></button>
          <button onClick={() => setPage("チケット管理")}>チケットを確認 <b>›</b></button>
          <button onClick={() => setPage("端末管理")}>受付端末を管理 <b>›</b></button>
          <button onClick={() => setPage("分析")}>分析を見る <b>›</b></button>
        </div>
      </section>
    </>;
  };

function RangeSetting({label,value,suffix,min,max,onChange}:{label:string;value:number;suffix:string;min:number;max:number;onChange:(value:number)=>void}) {
  return <label className="ticket-design-range">
    <span>{label}</span>
    <input
      type="range"
      min={min}
      max={max}
      value={value}
      onChange={e => onChange(Number(e.target.value))}
      aria-label={label}
    />
    <strong>{value}{suffix}</strong>
  </label>;
}

function TicketIcon(){return <svg viewBox="0 0 48 48" aria-hidden="true"><path d="M8 13h32v22H8z"/><path d="M14 13v7m0 8v7M34 13v7m0 8v7"/><path d="M21 18h8v12h-8z"/></svg>;}
function PlusIcon(){return <svg viewBox="0 0 32 32" aria-hidden="true"><path d="M16 7v18M7 16h18"/></svg>;}
function PaletteIcon(){return <svg viewBox="0 0 32 32" aria-hidden="true"><path d="M16 5C9.9 5 5 9.5 5 15.2 5 20 8.6 23 13 23h2.5c1.8 0 2.6 2.3 1.6 3.6-.4.5 0 .9.7.9C24.2 27.5 27 22.2 27 16c0-6.1-4.9-11-11-11Z"/><circle cx="10.5" cy="14" r="1.2"/><circle cx="15" cy="10.5" r="1.2"/><circle cx="21" cy="11.5" r="1.2"/><circle cx="23" cy="17" r="1.2"/></svg>;}
function SearchIcon(){return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></svg>;}
function FilterIcon(){return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M7 12h10M10 18h4"/></svg>;}
function QrIcon(){return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h6v6H4zm10 0h6v6h-6zM4 14h6v6H4zM14 14h3v3h-3zm5 0h1v1h-1zm-5 5h1v1h-1zm3-2h3v3h-3z"/></svg>;}
function BackIcon(){return <svg viewBox="0 0 28 28" aria-hidden="true"><path d="M18 5 7 14l11 9M8 14h15"/></svg>;}
function NavIcon({type}:{type:string}){
  if(type==="home") return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/></svg>;
  if(type==="event") return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4M17 3v4M3 10h18M7 14h4M7 17h7"/></svg>;
  if(type==="ticket") return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16v4a2 2 0 0 0 0 4v4H4v-4a2 2 0 0 0 0-4z"/><path d="M9 6v12"/></svg>;
  if(type==="terminal") return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="3" width="14" height="18" rx="3"/><path d="M9 7h6M9 17h6"/></svg>;
  if(type==="members") return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8" r="3"/><path d="M3 20c.4-4 2.2-6 6-6s5.6 2 6 6M17 11a3 3 0 1 0 0-6M17 14c2.5 0 4 2 4 6"/></svg>;
  if(type==="analysis") return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20V10M10 20V4M16 20v-7M22 20V7"/><path d="M2 20h21"/></svg>;
  return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-1.8 1.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.1h-2.5V20a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1-1.8-1.8.1-.1A1.7 1.7 0 0 0 8.1 15a1.7 1.7 0 0 0-1.6-1H6v-2.5h.5a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1 1.8-1.8.1.1a1.7 1.7 0 0 0 1.9.3 1.7 1.7 0 0 0 1-1.6V5H15v.5a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9.3l.1-.1 1.8 1.8-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.5V14h-.5a1.7 1.7 0 0 0-1.6 1Z"/></svg>;
}

  if (!terminalDataHydrated) {
    return <div className="terminal-registration-screen terminal-registration-fullscreen">
      <section className="terminal-registration-card">
        <div className="terminal-registration-badge">TERMINAL REGISTRATION</div>
        <h1>端末情報を確認しています</h1>
        <p>Firebaseから端末の登録状態を確認しています。</p>
      </section>
    </div>;
  }

  const ownTerminal = terminals.find(terminal =>
    terminal.terminalId === firebaseDeviceId &&
    (terminal.role === "management" || terminal.role === "both")
  );
  const canManageTerminals = Boolean(ownTerminal?.admin || ownTerminal?.subAdmin);
  if (forceTerminalRegistration || !ownTerminal) {
    return <div className="terminal-registration-screen terminal-registration-fullscreen">
      <section className="terminal-registration-card">
        <div className="terminal-registration-badge">TERMINAL REGISTRATION</div>
        <h2>端末登録申請</h2>
        <p>この端末を管理端末として使用するため、最初に登録申請を送信してください。受付アプリも同じ端末登録を共有できます。</p>
        <div className="terminal-registration-preview">
          <div><span>端末種別</span><strong>Web / iPad</strong></div>
          <div><span>端末ID</span><strong className="terminal-mono">{firebaseDeviceId}</strong></div>
        </div>
        <label className="terminal-registration-name">
          <span>端末名</span>
          <input value={appSettings.deviceName} onChange={e => updateOwnTerminalName(e.target.value)} placeholder="例：入口受付 iPad" />
        </label>
        <div className="terminal-registration-flow">
          <div><b>1</b><span>端末情報を確認</span></div>
          <div><b>2</b><span>登録申請を送信</span></div>
          <div><b>3</b><span>管理者が承認</span></div>
        </div>
        <button className="primary-action terminal-registration-submit" onClick={registerOwnTerminal}>この端末を登録申請</button>
        {terminalNotice && <div className="terminal-notice">{terminalNotice}</div>}
      </section>
    </div>;
  }

  if (!ownTerminal.approved || ownTerminal.status === "pending") {
    return <div className="terminal-registration-screen terminal-registration-fullscreen">
      <section className="terminal-registration-card">
        <div className="terminal-registration-badge">TERMINAL REGISTRATION</div>
        <h2>承認待ち</h2>
        <p>端末登録申請を受け付けました。管理者の承認が完了するまで管理画面は利用できません。</p>
        <div className="terminal-registration-preview">
          <div><span>端末名</span><strong>{ownTerminal.name}</strong></div>
          <div><span>端末ID</span><strong className="terminal-mono">{ownTerminal.terminalId}</strong></div>
          <div><span>状態</span><strong>管理者の承認待ち</strong></div>
        </div>
        <div className="terminal-registration-flow">
          <div><b>✓</b><span>端末情報を確認</span></div>
          <div><b>✓</b><span>登録申請を送信</span></div>
          <div><b>3</b><span>管理者が承認</span></div>
        </div>
        <p className="terminal-registration-waiting-note">承認されると、この画面が自動的に管理画面へ切り替わります。</p>
        <p className="terminal-registration-waiting-note">この端末の登録は自分では削除できません。必要な場合は管理画面から対応してください。</p>
      </section>
    </div>;
  }

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark">QR</div>
        <div><small>QR TICKET SYSTEM</small><strong>管理アプリ</strong></div>
      </div>
      <div className="event-mini">
        <small>現在のイベント</small>
        <b>{savedEventName}</b>
        <span>● {statusLabel[eventStatus]}</span>
      </div>
      <nav className="sidebar-nav">
        {navigationGroups.map(group => (
          <div className="sidebar-group" key={group.label}>
            <div className="sidebar-group-title"><strong>{group.label}</strong><span /></div>
            <div className="sidebar-group-items">
              {group.items.map(item => (
                <button key={item.label} disabled={item.comingSoon} className={`${page === item.label ? "active" : ""} ${item.comingSoon ? "coming-soon" : ""}`} onClick={() => { if (!item.comingSoon) setPage(item.label); }}>
                  <span className="sidebar-item-icon"><NavIcon type={item.icon} /></span>
                  <span className="sidebar-item-label">{item.label}</span>
                  {item.comingSoon && <small className="sidebar-coming-soon">近日公開</small>}
                </button>
              ))}
            </div>
          </div>
        ))}
      </nav>
    </aside>
    <main className="management-main">
      <header className="management-header">
        <div><small>管理画面</small><h1>{page}</h1></div>
        <div className="header-actions"><span className={bundle ? "pill ok" : "pill"}>{bundle ? "公開済み" : statusLabel[eventStatus]}</span></div>
      </header>
      {pageContent()}
    </main>

    {newEventModalOpen && <div className="modal-backdrop" role="presentation" onMouseDown={closeNewEventModal}>
      <div className="new-event-modal" role="dialog" aria-modal="true" aria-labelledby="new-event-title" onMouseDown={e => e.stopPropagation()}>
        <div className="new-event-modal-header">
          <div><small>NEW EVENT</small><h2 id="new-event-title">新しいイベントを作成</h2><p>イベントの基本情報を入力してください。</p></div>
          <button className="modal-close" aria-label="閉じる" onClick={closeNewEventModal}>×</button>
        </div>
        <div className="form-grid new-event-form">
          <label>イベント名<input autoFocus value={newEventName} onChange={e => setNewEventName(e.target.value)} /></label>
          <label>開催日<input type="date" value={newEventDate} onChange={e => setNewEventDate(e.target.value)} /></label>
          <label>開始時刻<input type="time" value={newStartTime} onChange={e => setNewStartTime(e.target.value)} /></label>
          <label>終了時刻<input type="time" value={newEndTime} onChange={e => setNewEndTime(e.target.value)} /></label>
        </div>
        {error && <div className="notice error">{error}</div>}
        <div className="modal-actions">
          <button className="secondary" onClick={closeNewEventModal}>キャンセル</button>
          <button className="primary-action" onClick={createNewEvent}>イベントを作成</button>
        </div>
      </div>
    </div>}

    {appSettings.aiLabEnabled && <div className="ai-lab-widget">
      {aiLabPanel && <section className="ai-lab-detail" role="dialog" aria-label={aiLabPanel}>
        <div className="ai-lab-detail-heading">
          <div><span className="ai-lab-eyebrow">ON-DEVICE ANALYSIS</span><h2>{aiLabPanel}</h2></div>
          <button className="ai-lab-close" aria-label="閉じる" onClick={() => setAiLabPanel(null)}>×</button>
        </div>
        {aiLabPanel === "受付分析" && <div className="ai-lab-detail-content">
          <div className="ai-lab-stat"><span>受付記録</span><strong>{receptionRecords.filter(record => record.type === "entry" || record.type === "exit").length}件</strong></div>
          <div className="ai-lab-stat"><span>チケット総数</span><strong>{ticketStats.total}枚</strong></div>
          <div className="ai-lab-stat"><span>入場中</span><strong>{ticketStats.inside}人</strong></div>
          <p>現在端末で参照できるイベントデータを集計しています。複数端末の全記録が同期済みとは限りません。</p>
        </div>}
        {aiLabPanel === "システム診断" && <div className="ai-lab-detail-content">
          <div className="ai-lab-diagnostic-row"><span>イベント</span><strong>{event.eventId ? "選択済み" : "未選択"}</strong></div>
          <div className="ai-lab-diagnostic-row"><span>チケットデータ</span><strong>{tickets.length ? tickets.length + "件確認" : "0件"}</strong></div>
          <div className="ai-lab-diagnostic-row"><span>受付記録</span><strong>{receptionRecords.length}件確認</strong></div>
          <div className="ai-lab-diagnostic-row"><span>検知した問題</span><strong className={aiLabDiagnostics.length ? "ai-lab-status-warning" : "ai-lab-status-ok"}>{aiLabDiagnostics.length ? aiLabDiagnostics.length + "件" : "問題は検知されていません"}</strong></div>
          <div className="ai-lab-diagnostic-row"><span>外部AI接続</span><strong>使用しない</strong></div>
          {aiLabDiagnostics.length > 0 ? <div className="ai-lab-findings-list">{aiLabDiagnostics.map(item => <div className="ai-lab-finding" key={item.id}><strong>{item.title}</strong><span>{item.detail}</span></div>)}</div> : <div className="ai-lab-diagnostic-ok"><span>✓</span><div><strong>基本チェックを通過</strong><small>現在読み込まれているデータに、実装済みのチェック項目で問題は見つかりませんでした。</small></div></div>}
          <p>これは読み込まれたデータに対する基本診断です。通信品質や端末そのものの完全な診断を保証するものではありません。</p>
        </div>
        {aiLabPanel === "改善提案" && <div className="ai-lab-detail-content">
          <p>現時点では診断用ログの種類が限られているため、確実な改善提案を生成できるだけの根拠がありません。</p>
          <div className="ai-lab-suggestion"><strong>次の改善ステップ</strong><span>読み取り処理時間・保存結果・通信エラーを記録し、イベントごとの傾向比較を有効にします。</span></div>
        </div>}
        {aiLabPanel === "警告履歴" && <div className="ai-lab-detail-content">
          {aiLabWarnings.filter(item => item.eventId === event.eventId).length ? <div className="ai-lab-warning-history">
            <div className="ai-lab-warning-history-summary"><strong>{aiLabWarnings.filter(item => item.eventId === event.eventId).length}件</strong><span>このイベントで記録された警告（最大100件を保存）</span></div>
            {aiLabWarnings.filter(item => item.eventId === event.eventId).map(item => <article className="ai-lab-warning-entry" key={item.eventId + item.id}>
              <div className="ai-lab-warning-entry-top"><strong>{item.title}</strong><time>{new Date(item.detectedAt).toLocaleString("ja-JP")}</time></div><p>{item.detail}</p>
            </article>)}
          </div> : <div className="ai-lab-empty"><span className="ai-lab-empty-icon">✓</span><strong>このイベントの警告はありません</strong><span>基本診断で問題が検知されると、ここに履歴として保存されます。</span></div>}
        </div>
      </section>}
      {aiLabMenuOpen && <div className="ai-lab-glass-menu" role="menu" aria-label="AI受付分析メニュー">
        <div className="ai-lab-menu-title"><span className="ai-lab-eyebrow">AI TEST LAB</span><strong>AI受付分析</strong><small>端末内で動作する試験機能</small></div>
        {(["受付分析", "システム診断", "改善提案", "警告履歴"] as const).map((item, index) => <button key={item} role="menuitem" className="ai-lab-menu-item" onClick={() => { setAiLabPanel(item); setAiLabMenuOpen(false); }}>
          <span className="ai-lab-menu-icon">{["▥", "⌁", "✧", "◉"][index]}</span><span>{item}</span><span className="ai-lab-menu-chevron">›</span>
        </button>)}
      </div>}
      <button className={`ai-lab-fab ${aiLabMenuOpen ? "is-open" : ""}`} aria-label={aiLabMenuOpen ? "AI試験メニューを閉じる" : "AI試験メニューを開く"} aria-expanded={aiLabMenuOpen} onClick={() => { setAiLabMenuOpen(open => !open); setAiLabPanel(null); }}>
        <span className="ai-lab-fab-glint" /><span className="ai-lab-fab-icon">✧</span>
      </button>
    </div>}
  </div>;
}

function Metric({ title, value, sub }: { title: string; value: string; sub: string }) {
  return <div className="metric"><small>{title}</small><strong>{value}</strong><span>{sub}</span></div>;
}

function Terminal({ name, mode, onAction }: { name: string; mode: string; onAction: () => void }) {
  return <div className="terminal">
    <div><b>{name}</b><small>{mode} ・ イベント未認証</small></div>
    <div className="terminal-actions"><span className="pill">未接続</span><button className="secondary" onClick={onAction}>操作</button></div>
  </div>;
}

function Setting({ title, text, checked, onChange }: { title: string; text: string; checked: boolean; onChange: () => void }) {
  return <div className="setting"><div><b>{title}</b><small>{text}</small></div><input type="checkbox" checked={checked} onChange={onChange} /></div>;
}