import React, { useState, useMemo, useRef, useEffect } from "react";
import jsPDF from "jspdf";
import html2canvas from "html2canvas";

/* ---- Tulsi & Grace brand tokens (confirmed hex) ---- */
const COLORS = {
  cream: "#f0ece0",
  lavenderLight: "#e8d7e6",
  sage: "#8d7e97",
  azure: "#006a7f",
  lavender: "#bdb3c8",
  ink: "#2f2b26",
  white: "#ffffff",
};

const DISPLAY_FONT = "'Fraunces', 'Playfair Display', serif";
const BODY_FONT = "'Josefin Sans', sans-serif";
const DATA_FONT = "'IBM Plex Mono', monospace";

const FONT_IMPORT = "@import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,600&family=Josefin+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@500&display=swap');";

const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const DAY_LABELS = { MO:"Monday", TU:"Tuesday", WE:"Wednesday", TH:"Thursday", FR:"Friday", SA:"Saturday", SU:"Sunday" };
const WEEK_ORDER = ["MO","TU","WE","TH","FR","SA","SU"];

const US_HOLIDAYS_2026 = {
  "2026-01-01": "New Year's Day", "2026-01-19": "MLK Jr. Day", "2026-02-16": "Presidents' Day",
  "2026-05-25": "Memorial Day", "2026-06-19": "Juneteenth", "2026-07-04": "Independence Day",
  "2026-09-07": "Labor Day", "2026-10-12": "Columbus Day", "2026-11-11": "Veterans Day",
  "2026-11-26": "Thanksgiving", "2026-12-25": "Christmas Day",
};

const DEFAULT_CATEGORIES = [
  { id: "business", label: "Business", color: COLORS.azure },
  { id: "family", label: "Family", color: COLORS.sage },
  { id: "health", label: "Personal Health", color: "#a8677a" },
  { id: "learning", label: "Personal Learning", color: "#7a8f5c" },
];
// A rotating palette for new custom categories so each one gets a distinct color automatically
const NEW_CATEGORY_COLORS = ["#c98a3e", "#4f7a6b", "#9c5b8f", "#6b7fae", "#b3562f", "#5c8a3e"];

const STATUS = { ACTIVE: "active", COMPLETED: "completed", SOMEDAY: "someday", ARCHIVED: "archived" };

let uidCounter = 1;
const uid = () => `id-${uidCounter++}-${Math.random().toString(36).slice(2,7)}`;

function pad(n) { return n.toString().padStart(2, "0"); }
function toKey(d) { return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`; }

function getMonthGrid(year, month) {
  const firstOfMonth = new Date(year, month, 1);
  const startWeekday = (firstOfMonth.getDay() + 6) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells = [];
  for (let i = 0; i < startWeekday; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

function moonPhase(date) {
  const knownNewMoon = new Date(2000, 0, 6, 18, 14);
  const synodic = 29.53058867;
  const diffDays = (date - knownNewMoon) / 86400000;
  let phase = (diffDays % synodic) / synodic;
  if (phase < 0) phase += 1;
  if (phase < 0.03 || phase > 0.97) return { symbol: "●", label: "New Moon" };
  if (phase < 0.22) return { symbol: "◐", label: "Waxing Crescent" };
  if (phase < 0.28) return { symbol: "◑", label: "First Quarter" };
  if (phase < 0.47) return { symbol: "◒", label: "Waxing Gibbous" };
  if (phase < 0.53) return { symbol: "○", label: "Full Moon" };
  if (phase < 0.72) return { symbol: "◓", label: "Waning Gibbous" };
  if (phase < 0.78) return { symbol: "◐", label: "Last Quarter" };
  return { symbol: "◑", label: "Waning Crescent" };
}

function cyclePhaseForDate(date, cycleStart, cycleLength, periodLength) {
  if (!cycleStart) return null;
  const start = new Date(cycleStart + "T00:00:00");
  start.setHours(0,0,0,0);
  const d = new Date(date);
  d.setHours(0,0,0,0);
  let diff = Math.floor((d - start) / 86400000);
  if (diff < 0) {
    const cyclesBack = Math.ceil(Math.abs(diff) / cycleLength);
    diff += cyclesBack * cycleLength;
  }
  const dayInCycle = diff % cycleLength;
  const ovulationDay = cycleLength - 14;
  if (dayInCycle < periodLength) return { phase: "Menstrual", energy: "low" };
  if (dayInCycle < ovulationDay - 3) return { phase: "Follicular", energy: "rising" };
  if (dayInCycle <= ovulationDay + 1) return { phase: "Ovulatory", energy: "high" };
  return { phase: "Luteal", energy: "falling" };
}

// Expand a recurring event into concrete date keys within a visible month window
function expandRecurring(ev, year, month) {
  if (!ev.recurring || ev.recurring === "none") return [ev.date];
  const base = new Date(ev.date + "T00:00:00");
  const monthStart = new Date(year, month, 1);
  const monthEnd = new Date(year, month + 1, 0);
  const out = [];
  if (ev.recurring === "daily") {
    let cursor = new Date(Math.max(base, monthStart));
    while (cursor <= monthEnd) {
      out.push(toKey(cursor));
      cursor.setDate(cursor.getDate() + 1);
    }
  } else if (ev.recurring === "weekly") {
    let cursor = new Date(base);
    // walk forward/back to populate this month
    cursor.setDate(cursor.getDate() - 400); // safety back-window
    while (cursor <= monthEnd) {
      if (cursor >= monthStart && cursor >= base) out.push(toKey(cursor));
      cursor.setDate(cursor.getDate() + 7);
    }
  } else if (ev.recurring === "monthly") {
    if (base <= monthEnd) {
      const day = base.getDate();
      const lastDay = new Date(year, month + 1, 0).getDate();
      const candidate = new Date(year, month, Math.min(day, lastDay));
      if (candidate >= new Date(base.getFullYear(), base.getMonth(), base.getDate())) {
        out.push(toKey(candidate));
      }
    }
  } else if (ev.recurring === "yearly") {
    if (base.getMonth() === month) {
      const candidate = new Date(year, month, base.getDate());
      if (candidate >= base) out.push(toKey(candidate));
    }
  }
  return out;
}

const inputStyle = {
  width: "100%", boxSizing: "border-box", padding: "9px 11px", borderRadius: 9,
  border: `1px solid ${COLORS.lavenderLight}`, fontFamily: BODY_FONT, fontSize: 14,
  color: COLORS.ink, background: COLORS.white, outline: "none",
};
const labelStyle = { fontSize: 11, color: COLORS.sage, fontWeight: 600, letterSpacing: 0.4, display: "block", marginBottom: 4 };
const cardStyle = { background: COLORS.white, border: `1px solid ${COLORS.lavenderLight}`, borderRadius: 16, padding: 20 };

function Pill({ children, color, active, onClick }) {
  return (
    <button
      onClick={onClick}
      style={{
        border: `1px solid ${active ? color : COLORS.lavenderLight}`,
        background: active ? color : "transparent",
        color: active ? "#fff" : COLORS.ink,
        borderRadius: 999, padding: "5px 13px", fontSize: 12, fontWeight: 600,
        fontFamily: BODY_FONT, cursor: onClick ? "pointer" : "default", whiteSpace: "nowrap",
      }}
    >
      {children}
    </button>
  );
}

/* ---- Today tab helper components ---- */
function MoonAndCycleWidget({ cyclePhase }) {
  const phase = moonPhase(new Date());
  return (
    <div>
      <div style={{ fontSize: 44 }}>{phase.symbol}</div>
      <div style={{ fontFamily: DISPLAY_FONT, fontSize: 18, marginTop: 6 }}>{phase.label}</div>
      {cyclePhase && (
        <div style={{ marginTop: 10, display: "inline-block", padding: "4px 12px", borderRadius: 20, background: COLORS.cream, fontSize: 12.5 }}>
          Cycle: <strong>{cyclePhase}</strong>
        </div>
      )}
    </div>
  );
}

function LibraryConnect({ onConnect }) {
  const [key, setKey] = useState("");
  return (
    <div>
      <input type="text" placeholder="Library Key" value={key} onChange={e => setKey(e.target.value)}
        style={{ width: "100%", padding: 8, borderRadius: 8, border: `1px solid ${COLORS.lavenderLight}`, marginBottom: 8, boxSizing: "border-box", fontSize: 13.5 }} />
      <button onClick={() => key.trim() && onConnect(key.trim())} style={{ width: "100%", padding: 9, borderRadius: 8, border: "none", background: COLORS.sage, color: "#fff", fontWeight: 600, cursor: "pointer" }}>Connect</button>
    </div>
  );
}

function LibraryPicker({ books, onPick }) {
  const [query, setQuery] = useState("");
  const filtered = (query.trim() ? books.filter(b => (b.title + " " + (b.author || "")).toLowerCase().includes(query.trim().toLowerCase())) : books).slice(0, 8);
  return (
    <div>
      <input type="text" placeholder="Search title or author" value={query} onChange={e => setQuery(e.target.value)}
        style={{ width: "100%", padding: 8, borderRadius: 8, border: `1px solid ${COLORS.lavenderLight}`, marginBottom: 8, boxSizing: "border-box", fontSize: 13.5 }} />
      <div style={{ maxHeight: 200, overflowY: "auto" }}>
        {filtered.map(b => (
          <button key={b.id} onClick={() => onPick(b)} style={{ display: "block", width: "100%", textAlign: "center", border: "none", background: COLORS.cream, borderRadius: 8, padding: 8, marginBottom: 6, cursor: "pointer" }}>
            <div style={{ fontSize: 13.5, fontWeight: 600 }}>{b.title}</div>
            {b.author && <div style={{ fontSize: 12, opacity: 0.6 }}>{b.author}</div>}
          </button>
        ))}
        {filtered.length === 0 && <div style={{ fontSize: 12.5, opacity: 0.6, textAlign: "center" }}>No matches.</div>}
      </div>
    </div>
  );
}

function ReadingProgressInput({ initial, onSave }) {
  const [page, setPage] = useState(initial);
  useEffect(() => { setPage(initial); }, [initial]);
  return (
    <div style={{ display: "flex", gap: 8 }}>
      <input type="number" min="0" value={page} onChange={e => setPage(e.target.value)}
        style={{ flex: 1, padding: 8, borderRadius: 8, border: `1px solid ${COLORS.lavenderLight}`, fontSize: 13.5 }} />
      <button onClick={() => { const v = parseInt(page, 10); if (!isNaN(v) && v >= 0) onSave(v); }} style={{ padding: "8px 14px", borderRadius: 8, border: "none", background: COLORS.sage, color: "#fff", cursor: "pointer" }}>Save</button>
    </div>
  );
}

/* ---- Hour-by-hour grid: shared by Day and Week views ---- */
const GRID_HOUR_START = 6;   // 6 AM
const GRID_HOUR_END = 23;    // 11 PM
const GRID_PX_PER_HOUR = 48;
const GRID_HEIGHT = (GRID_HOUR_END - GRID_HOUR_START) * GRID_PX_PER_HOUR;

function timeToGridMinutes(t) {
  const [h, m] = t.split(":").map(Number);
  return (h - GRID_HOUR_START) * 60 + m;
}
function minutesToTop(mins) {
  const clamped = Math.max(0, Math.min(mins, (GRID_HOUR_END - GRID_HOUR_START) * 60));
  return (clamped / 60) * GRID_PX_PER_HOUR;
}
function formatHourLabel(h) {
  const period = h < 12 || h === 24 ? "AM" : "PM";
  let hour12 = h % 12;
  if (hour12 === 0) hour12 = 12;
  return `${hour12} ${period}`;
}

function HourGridColumn({ routines, items, categoryById, compact }) {
  const timedRoutines = routines.filter(r => r.startTime);
  const allDayRoutines = routines.filter(r => !r.startTime);
  const timedItems = items.filter(it => it.time);
  const untimedItems = items.filter(it => !it.time);

  return (
    <div>
      {allDayRoutines.length > 0 && (
        <div style={{ marginBottom: 4 }}>
          {allDayRoutines.map(r => (
            <div key={r.id} style={{ fontSize: compact ? 8.5 : 11, color: COLORS.lavender, fontWeight: 600 }}>
              ↻ {r.label}{r.items?.length > 0 && !compact ? ` — ${r.items.map(it => it.label).join(", ")}` : ""}
            </div>
          ))}
        </div>
      )}
      <div style={{
        position: "relative", height: GRID_HEIGHT,
        background: `repeating-linear-gradient(to bottom, ${COLORS.lavenderLight} 0, ${COLORS.lavenderLight} 1px, transparent 1px, transparent ${GRID_PX_PER_HOUR}px)`,
        borderTop: `1px solid ${COLORS.lavenderLight}`, borderBottom: `1px solid ${COLORS.lavenderLight}`,
      }}>
        {/* Routine envelopes: the named block spans its own start–end, sub-items render inside it */}
        {timedRoutines.map(r => {
          const startMin = timeToGridMinutes(r.startTime);
          const endMin = r.endTime ? timeToGridMinutes(r.endTime) : startMin + 30;
          const top = minutesToTop(startMin);
          const height = Math.max(minutesToTop(endMin) - top, compact ? 14 : 20);
          const timedSubItems = (r.items || []).filter(it => it.time);
          const untimedSubItems = (r.items || []).filter(it => !it.time);
          return (
            <div key={r.id} style={{
              position: "absolute", top, height, left: 1, right: "38%",
              background: "rgba(189,179,200,0.22)", border: `1px solid ${COLORS.lavender}`,
              borderLeft: `2.5px solid ${COLORS.lavender}`, borderRadius: 3, overflow: "hidden",
            }}>
              <div style={{ fontSize: compact ? 7 : 9.5, fontWeight: 700, color: COLORS.ink, padding: "1px 4px", background: "rgba(189,179,200,0.3)" }}>
                {r.label}
              </div>
              <div style={{ padding: "0 4px", position: "relative" }}>
                {untimedSubItems.map((it, ii) => (
                  <div key={it.id || ii} style={{ fontSize: compact ? 6.5 : 9, color: COLORS.ink, lineHeight: 1.35, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    • {it.label}
                  </div>
                ))}
                {timedSubItems.map((it, ii) => (
                  <div key={it.id || ii} style={{ fontSize: compact ? 6.5 : 9, color: COLORS.ink, fontWeight: 600, lineHeight: 1.35, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {it.time} {it.label}
                  </div>
                ))}
              </div>
            </div>
          );
        })}
        {timedItems.map((it, ii) => {
          const startMin = timeToGridMinutes(it.time);
          const endMin = startMin + (it.durationMin || 30);
          const top = minutesToTop(startMin);
          const height = Math.max(minutesToTop(endMin) - top, compact ? 12 : 16);
          const cat = it.category ? categoryById(it.category) : null;
          const color = cat ? cat.color : COLORS.azure;
          return (
            <div key={ii} title={it.label} style={{
              position: "absolute", top, height, left: "40%", right: 1,
              background: `${color}30`, borderLeft: `2.5px solid ${color}`,
              borderRadius: 3, padding: "1px 4px", overflow: "hidden",
              fontSize: compact ? 7.5 : 10.5, color: COLORS.ink, fontWeight: 600, lineHeight: 1.2,
            }}>
              {it.time} {it.label}
            </div>
          );
        })}
      </div>
      {untimedItems.length > 0 && (
        <div style={{ marginTop: 6 }}>
          {untimedItems.map((it, ii) => {
            const cat = it.category ? categoryById(it.category) : null;
            return (
              <div key={ii} style={{ fontSize: compact ? 8.5 : 11, color: cat ? cat.color : COLORS.ink, fontWeight: 600, marginTop: 2 }}>
                • {it.label}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function RootSystem() {
  const today = new Date();
  const [tab, setTab] = useState("today");
  const [isLoaded, setIsLoaded] = useState(false);
  const [undoState, setUndoState] = useState(null); // { message, restore } | null
  const undoTimerRef = useRef(null);
  function triggerUndo(message, restore) {
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
    setUndoState({ message, restore });
    undoTimerRef.current = setTimeout(() => setUndoState(null), 7000);
  }
  function performUndo() {
    if (undoState) undoState.restore();
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
    setUndoState(null);
  }
  const [saveStatus, setSaveStatus] = useState("idle"); // idle | saving | saved | error

  /* ---------- calendar theme customization ---------- */
  const [themeBg, setThemeBg] = useState(COLORS.cream);
  const [themeAccent, setThemeAccent] = useState(COLORS.sage);
  const [themeHighlight, setThemeHighlight] = useState(COLORS.azure);
  const [showCustomize, setShowCustomize] = useState(false);
  function resetTheme() { setThemeBg(COLORS.cream); setThemeAccent(COLORS.sage); setThemeHighlight(COLORS.azure); }

  /* ---------- shared data model ---------- */
  const [inboxText, setInboxText] = useState("");
  const [editingInboxId, setEditingInboxId] = useState(null);
  const [editingInboxText, setEditingInboxText] = useState("");
  const [inboxItems, setInboxItems] = useState([]); // {id, text, createdAt}
  const [tasks, setTasks] = useState([]); // {id, text, category, status, estMinutes, scheduledDate}
  const [editingTaskId, setEditingTaskId] = useState(null);
  const [editingTaskText, setEditingTaskText] = useState("");
  const [categories, setCategories] = useState(DEFAULT_CATEGORIES);
  const [newCategoryLabel, setNewCategoryLabel] = useState("");
  const categoryById = (id) => categories.find(c => c.id === id) || null;
  function addCategory() {
    const label = newCategoryLabel.trim();
    if (!label) return;
    const id = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || uid();
    if (categories.some(c => c.id === id)) return; // avoid duplicates
    const color = NEW_CATEGORY_COLORS[categories.length % NEW_CATEGORY_COLORS.length];
    setCategories([...categories, { id, label, color }]);
    setNewCategoryLabel("");
  }
  function removeCategory(id) {
    const cat = categories.find(c => c.id === id);
    const taskCount = tasks.filter(t => t.category === id).length;
    const eventCount = events.filter(e => e.category === id).length;
    if (taskCount + eventCount > 0) {
      const ok = window.confirm(
        `"${cat?.label}" is used on ${taskCount} task${taskCount === 1 ? "" : "s"} and ${eventCount} event${eventCount === 1 ? "" : "s"}. ` +
        `Deleting it won't delete those — they'll just lose their category label and color. Continue?`
      );
      if (!ok) return;
    }
    setCategories(categories.filter(c => c.id !== id));
    if (cat) {
      const idx = categories.findIndex(c => c.id === id);
      triggerUndo(`Deleted "${cat.label}"`, () => {
        setCategories(prev => {
          const copy = [...prev];
          copy.splice(idx, 0, cat);
          return copy;
        });
      });
    }
  }

  /* ---------- task list filter ---------- */
  const [taskFilterStatus, setTaskFilterStatus] = useState("all"); // all | pending | active | someday | completed | archived
  const [taskFilterCategory, setTaskFilterCategory] = useState("all");

  /* ---------- Today tab state ---------- */
  const [todayLog, setTodayLog] = useState([]); // [{date, answer}]
  const [todayDraft, setTodayDraft] = useState("");
  const [showPastAnswers, setShowPastAnswers] = useState(false);
  const [focusTaskId, setFocusTaskId] = useState("");
  const [focusMinutes, setFocusMinutes] = useState(20);
  const [focusRemaining, setFocusRemaining] = useState(null); // seconds, or null when not running
  const focusIntervalRef = useRef(null);
  const [readingBook, setReadingBook] = useState({ title: "", progress: 0, quote: "", note: "" });
  const [libraryKey, setLibraryKey] = useState("");
  const [libraryBooks, setLibraryBooks] = useState([]);
  const [libraryLoadState, setLibraryLoadState] = useState("idle"); // idle | loading | loaded | error
  const [linkedBookId, setLinkedBookId] = useState(null);
  const [cupFilled, setCupFilled] = useState([]); // array of cup category ids filled today, reset daily by date check
  const [cupDate, setCupDate] = useState(toKey(new Date()));

  const LIBRARY_URL = "https://root-restore-library-tracker.netlify.app/api/library";
  const CUP_CATEGORIES = ["Movement", "Nourish", "Rest", "Nature", "Connect", "Create", "Spirit", "Joy"];

  function toggleCup(cat) {
    setCupFilled(prev => prev.includes(cat) ? prev.filter(c => c !== cat) : [...prev, cat]);
  }

  function saveTodayAnswer() {
    const text = todayDraft.trim();
    if (!text) return;
    const dateKey = toKey(new Date());
    setTodayLog(prev => {
      const withoutToday = prev.filter(e => e.date !== dateKey);
      return [{ date: dateKey, answer: text }, ...withoutToday];
    });
  }

  function loadLibrary(key) {
    if (!key.trim() || libraryLoadState === "loading") return;
    setLibraryLoadState("loading");
    fetch(LIBRARY_URL + "?key=" + encodeURIComponent(key.trim()))
      .then(r => r.ok ? r.json() : Promise.reject(new Error("Library load failed")))
      .then(res => {
        setLibraryBooks((res.data && res.data.books) || []);
        setLibraryLoadState("loaded");
      })
      .catch(err => { console.error("Library load failed:", err); setLibraryLoadState("error"); });
  }

  function connectLibrary(key) {
    setLibraryKey(key);
    loadLibrary(key);
  }

  function linkBook(book) {
    setLinkedBookId(book.id);
    setReadingBook(prev => ({ ...prev, title: book.title, progress: book.totalPages ? Math.round(((book.currentPage || 0) / book.totalPages) * 100) : 0 }));
  }

  function unlinkBook() {
    setLinkedBookId(null);
  }

  function saveReadingProgressToLibrary(currentPage) {
    const key = libraryKey;
    if (!key || !linkedBookId) return;
    fetch(LIBRARY_URL + "?key=" + encodeURIComponent(key))
      .then(r => r.ok ? r.json() : Promise.reject(new Error("Library load failed")))
      .then(res => {
        const data = res.data;
        if (!data) throw new Error("No library data");
        const book = (data.books || []).find(b => b.id === linkedBookId);
        if (!book) throw new Error("Book not found in library");
        book.currentPage = currentPage;
        if (book.status === "to-read") book.status = "reading";
        return fetch(LIBRARY_URL + "?key=" + encodeURIComponent(key), {
          method: "PUT", headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        }).then(r => { if (!r.ok) throw new Error("Save failed"); return book.totalPages; });
      })
      .then(totalPages => {
        setReadingBook(prev => ({ ...prev, progress: totalPages ? Math.round((currentPage / totalPages) * 100) : prev.progress }));
        loadLibrary(key);
      })
      .catch(err => { console.error("Saving reading progress failed:", err); alert("Couldn't save your progress — please try again."); });
  }

  const linkedBook = libraryBooks.find(b => b.id === linkedBookId) || null;

  function startFocus() {
    if (focusIntervalRef.current) clearInterval(focusIntervalRef.current);
    setFocusRemaining(focusMinutes * 60);
    focusIntervalRef.current = setInterval(() => {
      setFocusRemaining(prev => {
        if (prev === null) return null;
        if (prev <= 1) {
          clearInterval(focusIntervalRef.current);
          if (focusTaskId) setTasks(ts => ts.map(t => t.id === focusTaskId ? { ...t, status: STATUS.COMPLETED } : t));
          return null;
        }
        return prev - 1;
      });
    }, 1000);
  }
  function stopFocus() {
    if (focusIntervalRef.current) clearInterval(focusIntervalRef.current);
    setFocusRemaining(null);
  }
  useEffect(() => () => { if (focusIntervalRef.current) clearInterval(focusIntervalRef.current); }, []);

  useEffect(() => {
    const todayKey = toKey(new Date());
    if (cupDate !== todayKey) { setCupFilled([]); setCupDate(todayKey); }
  }, []);

  /* ---------- calendar settings (from original Calendar Maker) ---------- */
  const [month, setMonth] = useState(today.getMonth());
  const [year, setYear] = useState(today.getFullYear());
  const [weekStart, setWeekStart] = useState("MO");
  const [quote, setQuote] = useState("Rest is not a reward for exhaustion. It is a requirement for a woman who intends to keep going.");
  const [author, setAuthor] = useState("Tulsi & Grace");
  const [savedQuotes, setSavedQuotes] = useState([{ id: uid(), text: "Rest is not a reward for exhaustion. It is a requirement for a woman who intends to keep going.", author: "Tulsi & Grace" }]);
  const [showQuotePanel, setShowQuotePanel] = useState(false);
  const [newQuoteText, setNewQuoteText] = useState("");
  const [newQuoteAuthor, setNewQuoteAuthor] = useState("");
  const [importQuotesText, setImportQuotesText] = useState("");
  function addQuote() {
    if (!newQuoteText.trim()) return;
    const q = { id: uid(), text: newQuoteText.trim(), author: newQuoteAuthor.trim() || "Unknown" };
    setSavedQuotes([...savedQuotes, q]);
    setQuote(q.text); setAuthor(q.author);
    setNewQuoteText(""); setNewQuoteAuthor("");
  }
  function importQuotes() {
    // one quote per line, format: "Quote text — Author" (em dash or hyphen separates author; author optional)
    const lines = importQuotesText.split("\n").map(l => l.trim()).filter(Boolean);
    if (lines.length === 0) return;
    const parsed = lines.map(line => {
      const parts = line.split(/\s+[—-]\s+/);
      if (parts.length >= 2) {
        return { id: uid(), text: parts.slice(0, -1).join(" - ").trim(), author: parts[parts.length - 1].trim() };
      }
      return { id: uid(), text: line, author: "Unknown" };
    });
    setSavedQuotes([...savedQuotes, ...parsed]);
    setImportQuotesText("");
  }
  function removeQuote(id) {
    const q = savedQuotes.find(x => x.id === id);
    const idx = savedQuotes.findIndex(x => x.id === id);
    setSavedQuotes(savedQuotes.filter(x => x.id !== id));
    if (q) {
      triggerUndo(`Removed a saved quote`, () => {
        setSavedQuotes(prev => { const copy = [...prev]; copy.splice(idx, 0, q); return copy; });
      });
    }
  }
  function useQuote(q) { setQuote(q.text); setAuthor(q.author); }
  const [showMoon, setShowMoon] = useState(true);
  const [showCycle, setShowCycle] = useState(true);
  const [showEnergy, setShowEnergy] = useState(true);
  const [cycleStart, setCycleStart] = useState("");
  const [cycleLength, setCycleLength] = useState(28);
  const [periodLength, setPeriodLength] = useState(5);
  const [includeHolidays, setIncludeHolidays] = useState(true);
  const [calendarView, setCalendarView] = useState("month"); // month | week | day
  const [selectedDay, setSelectedDay] = useState(today.getDate());
  const [openPanel, setOpenPanel] = useState("events");
  const [categoryFilter, setCategoryFilter] = useState("all");

  // manual (non-task) calendar events, each: {id, date, label, category, recurring, time}
  const [events, setEvents] = useState([]);
  const [newEvLabel, setNewEvLabel] = useState("");
  const [newEvDate, setNewEvDate] = useState("");
  const [newEvTime, setNewEvTime] = useState("");
  const [newEvCategory, setNewEvCategory] = useState("business");
  const [newEvRecurring, setNewEvRecurring] = useState("none");
  const [editingEventId, setEditingEventId] = useState(null);
  const [editEvLabel, setEditEvLabel] = useState("");
  const [editEvDate, setEditEvDate] = useState("");
  const [editEvTime, setEditEvTime] = useState("");
  const [editEvCategory, setEditEvCategory] = useState("business");
  const [editEvRecurring, setEditEvRecurring] = useState("none");
  function startEditEvent(ev) {
    setEditingEventId(ev.id);
    setEditEvLabel(ev.label);
    setEditEvDate(ev.date);
    setEditEvTime(ev.time || "");
    setEditEvCategory(ev.category || "business");
    setEditEvRecurring(ev.recurring || "none");
  }
  function saveEditEvent() {
    if (!editEvLabel.trim() || !editEvDate) { setEditingEventId(null); return; }
    updateEvent(editingEventId, { label: editEvLabel.trim(), date: editEvDate, time: editEvTime || null, category: editEvCategory, recurring: editEvRecurring });
    setEditingEventId(null);
  }

  /* ---------- routines: named time envelopes containing their own sub-items ---------- */
  const [routines, setRoutines] = useState([]); // {id, weekdays, label, startTime, endTime, items: [{id, label, time}]}
  const [showRoutinesOnMonth, setShowRoutinesOnMonth] = useState(false);
  const [showRoutinesOnWeek, setShowRoutinesOnWeek] = useState(true);
  const [newRoutineWeekdays, setNewRoutineWeekdays] = useState([]);
  const [newRoutineLabel, setNewRoutineLabel] = useState("");
  const [newRoutineStart, setNewRoutineStart] = useState("");
  const [newRoutineEnd, setNewRoutineEnd] = useState("");
  const [newRoutineItems, setNewRoutineItems] = useState([]);
  const [newItemLabel, setNewItemLabel] = useState("");
  const [newItemTime, setNewItemTime] = useState("");
  const [editingRoutineId, setEditingRoutineId] = useState(null);
  const [editRoutineWeekdays, setEditRoutineWeekdays] = useState([]);
  const [editRoutineLabel, setEditRoutineLabel] = useState("");
  const [editRoutineStart, setEditRoutineStart] = useState("");
  const [editRoutineEnd, setEditRoutineEnd] = useState("");
  const [editRoutineItems, setEditRoutineItems] = useState([]);
  const [editItemLabel, setEditItemLabel] = useState("");
  const [editItemTime, setEditItemTime] = useState("");

  // Normalizes older saved routines (single "weekday" field, no "items") to the current shape.
  function normalizeRoutine(r) {
    let out = r;
    if (!Array.isArray(r.weekdays)) {
      const weekdays = r.weekday === "daily" ? [...WEEK_ORDER] : r.weekday ? [r.weekday] : [...WEEK_ORDER];
      const { weekday, ...rest } = r;
      out = { ...rest, weekdays };
    }
    if (!Array.isArray(out.items)) out = { ...out, items: [] };
    return out;
  }

  function toggleNewRoutineDay(d) {
    setNewRoutineWeekdays(prev => prev.includes(d) ? prev.filter(x => x !== d) : [...prev, d]);
  }
  function toggleEditRoutineDay(d) {
    setEditRoutineWeekdays(prev => prev.includes(d) ? prev.filter(x => x !== d) : [...prev, d]);
  }
  function addNewRoutineItem() {
    if (!newItemLabel.trim()) return;
    setNewRoutineItems([...newRoutineItems, { id: uid(), label: newItemLabel.trim(), time: newItemTime || null }]);
    setNewItemLabel(""); setNewItemTime("");
  }
  function removeNewRoutineItem(id) {
    setNewRoutineItems(newRoutineItems.filter(it => it.id !== id));
  }
  function addEditRoutineItem() {
    if (!editItemLabel.trim()) return;
    setEditRoutineItems([...editRoutineItems, { id: uid(), label: editItemLabel.trim(), time: editItemTime || null }]);
    setEditItemLabel(""); setEditItemTime("");
  }
  function removeEditRoutineItem(id) {
    setEditRoutineItems(editRoutineItems.filter(it => it.id !== id));
  }
  function addRoutine() {
    if (!newRoutineLabel.trim() || newRoutineWeekdays.length === 0) return;
    setRoutines([...routines, {
      id: uid(), weekdays: newRoutineWeekdays, label: newRoutineLabel.trim(),
      startTime: newRoutineStart || null, endTime: newRoutineEnd || null, items: newRoutineItems,
    }]);
    setNewRoutineLabel(""); setNewRoutineStart(""); setNewRoutineEnd(""); setNewRoutineWeekdays([]); setNewRoutineItems([]);
  }
  function startEditRoutine(r) {
    const norm = normalizeRoutine(r);
    setEditingRoutineId(r.id);
    setEditRoutineWeekdays(norm.weekdays);
    setEditRoutineLabel(r.label);
    setEditRoutineStart(r.startTime || "");
    setEditRoutineEnd(r.endTime || "");
    setEditRoutineItems(norm.items);
  }
  function saveEditRoutine() {
    if (!editRoutineLabel.trim() || editRoutineWeekdays.length === 0) { setEditingRoutineId(null); return; }
    setRoutines(routines.map(r => r.id === editingRoutineId
      ? { ...r, weekdays: editRoutineWeekdays, weekday: undefined, label: editRoutineLabel.trim(), startTime: editRoutineStart || null, endTime: editRoutineEnd || null, items: editRoutineItems }
      : r));
    setEditingRoutineId(null);
  }
  function removeRoutine(id) {
    const r = routines.find(x => x.id === id);
    const idx = routines.findIndex(x => x.id === id);
    setRoutines(routines.filter(x => x.id !== id));
    if (r) {
      triggerUndo(`Deleted "${r.label}" from your routine`, () => {
        setRoutines(prev => { const copy = [...prev]; copy.splice(idx, 0, r); return copy; });
      });
    }
  }
  function routinesForWeekday(weekdayCode) {
    return routines
      .map(normalizeRoutine)
      .filter(r => r.weekdays.includes(weekdayCode))
      .sort((a, b) => (a.startTime || "99:99").localeCompare(b.startTime || "99:99"));
  }
  function weekdayCodeFor(date) {
    return WEEK_ORDER[(date.getDay() + 6) % 7];
  }
  function weekdaysLabel(weekdays) {
    if (weekdays.length === 7) return "Every day";
    return weekdays.map(d => DAY_LABELS[d].slice(0, 3)).join(", ");
  }

  /* ---------- cycle sync: pulled from the standalone Lunar & Cycle app ---------- */
  const LUNAR_APP_URL = "https://root-restore-lunar-cycle.netlify.app";
  const [cycleSynced, setCycleSynced] = useState(false);
  const [cycleSyncError, setCycleSyncError] = useState(false);
  const [cycleNotSetUp, setCycleNotSetUp] = useState(false);

  const printRef = useRef(null);

  /* ---------- persistence: load once on mount ---------- */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/.netlify/functions/data");
        const data = await res.json();
        if (cancelled || !data) { setIsLoaded(true); return; }
        if (data.inboxItems) setInboxItems(data.inboxItems);
        if (data.tasks) setTasks(data.tasks);
        if (data.categories) setCategories(data.categories);
        if (data.events) setEvents(data.events);
        if (data.savedQuotes) setSavedQuotes(data.savedQuotes);
        if (data.quote) setQuote(data.quote);
        if (data.author) setAuthor(data.author);
        if (data.weekStart) setWeekStart(data.weekStart);
        if (data.cycleStart !== undefined) setCycleStart(data.cycleStart);
        if (data.cycleLength) setCycleLength(data.cycleLength);
        if (data.periodLength) setPeriodLength(data.periodLength);
        if (data.includeHolidays !== undefined) setIncludeHolidays(data.includeHolidays);
        if (data.themeBg) setThemeBg(data.themeBg);
        if (data.themeAccent) setThemeAccent(data.themeAccent);
        if (data.themeHighlight) setThemeHighlight(data.themeHighlight);
        if (data.routines) setRoutines(data.routines);
        if (data.showRoutinesOnMonth !== undefined) setShowRoutinesOnMonth(data.showRoutinesOnMonth);
        if (data.showRoutinesOnWeek !== undefined) setShowRoutinesOnWeek(data.showRoutinesOnWeek);
        else if (data.showRoutinesOnGrid !== undefined) setShowRoutinesOnWeek(data.showRoutinesOnGrid); // migrate old single toggle
        if (data.todayLog) setTodayLog(data.todayLog);
        if (data.readingBook) setReadingBook(data.readingBook);
        if (data.libraryKey) { setLibraryKey(data.libraryKey); loadLibrary(data.libraryKey); }
        if (data.linkedBookId) setLinkedBookId(data.linkedBookId);
        if (data.cupFilled) setCupFilled(data.cupFilled);
        if (data.cupDate) setCupDate(data.cupDate);
      } catch (err) {
        // No saved data yet, or a read error — start fresh rather than block the app
        console.error("Could not load saved data:", err);
      } finally {
        if (!cancelled) setIsLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  /* ---------- persistence: debounced save on change ---------- */
  useEffect(() => {
    if (!isLoaded) return; // don't save the empty defaults over real data during load
    setSaveStatus("saving");
    const handle = setTimeout(async () => {
      try {
        const payload = {
          inboxItems, tasks, categories, events, savedQuotes, quote, author, weekStart,
          cycleStart, cycleLength, periodLength, includeHolidays, themeBg, themeAccent, themeHighlight,
          routines, showRoutinesOnMonth, showRoutinesOnWeek,
          todayLog, readingBook, libraryKey, linkedBookId, cupFilled, cupDate,
        };
        const res = await fetch("/.netlify/functions/data", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        setSaveStatus(res.ok ? "saved" : "error");
      } catch (err) {
        console.error("Save failed:", err);
        setSaveStatus("error");
      }
    }, 700);
    return () => clearTimeout(handle);
  }, [isLoaded, inboxItems, tasks, categories, events, savedQuotes, quote, author, weekStart, cycleStart, cycleLength, periodLength, includeHolidays, themeBg, themeAccent, themeHighlight, routines, showRoutinesOnMonth, showRoutinesOnWeek, todayLog, readingBook, libraryKey, linkedBookId, cupFilled, cupDate]);

  /* ---------- cycle sync: pull cycleStart/cycleLength/periodLength from the Lunar app ---------- */
  useEffect(() => {
    if (!isLoaded) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${LUNAR_APP_URL}/.netlify/functions/data`);
        const data = await res.json();
        if (cancelled) return;
        if (data && data.settings) {
          setCycleStart(data.settings.cycleStart || "");
          setCycleLength(data.settings.cycleLength || 28);
          setPeriodLength(data.settings.periodLength || 5);
          setCycleSynced(true);
          setCycleSyncError(false);
          setCycleNotSetUp(false);
        } else {
          // Reached the Lunar app fine, it just hasn't been set up yet — not an error.
          setCycleNotSetUp(true);
          setCycleSyncError(false);
        }
      } catch (err) {
        console.error("Could not sync cycle data from Lunar app:", err);
        if (!cancelled) setCycleSyncError(true);
      }
    })();
    return () => { cancelled = true; };
  }, [isLoaded]);

  /* ---------- inbox actions ---------- */
  function addInboxItem() {
    if (!inboxText.trim()) return;
    setInboxItems([{ id: uid(), text: inboxText.trim(), createdAt: Date.now() }, ...inboxItems]);
    setInboxText("");
  }
  function startEditInbox(item) {
    setEditingInboxId(item.id);
    setEditingInboxText(item.text);
  }
  function saveEditInbox() {
    if (!editingInboxText.trim()) { setEditingInboxId(null); return; }
    setInboxItems(inboxItems.map(i => i.id === editingInboxId ? { ...i, text: editingInboxText.trim() } : i));
    setEditingInboxId(null);
  }
  function removeInboxItem(id) {
    setInboxItems(inboxItems.filter(i => i.id !== id));
  }
  // sort: turn an inbox item into a task, or discard straight to archive
  function sortToTask(item, category) {
    setTasks([{ id: uid(), text: item.text, category, status: STATUS.ACTIVE, estMinutes: null, scheduledDate: null }, ...tasks]);
    removeInboxItem(item.id);
  }
  function sortToArchive(item) {
    setTasks([{ id: uid(), text: item.text, category: null, status: STATUS.ARCHIVED, estMinutes: null, scheduledDate: null }, ...tasks]);
    removeInboxItem(item.id);
  }

  /* ---------- task actions ---------- */
  function updateTask(id, patch) {
    setTasks(tasks.map(t => t.id === id ? { ...t, ...patch } : t));
  }
  function scheduleTask(id, date) {
    updateTask(id, { scheduledDate: date });
  }
  function scheduleTaskTime(id, time) {
    updateTask(id, { scheduleTime: time || null });
  }

  const tasksByStatus = useMemo(() => {
    const grouped = { [STATUS.ACTIVE]: [], [STATUS.COMPLETED]: [], [STATUS.SOMEDAY]: [], [STATUS.ARCHIVED]: [] };
    tasks.forEach(t => grouped[t.status]?.push(t));
    return grouped;
  }, [tasks]);

  /* ---------- calendar derived data ---------- */
  const orderedWeekDays = useMemo(() => {
    const idx = WEEK_ORDER.indexOf(weekStart);
    return [...WEEK_ORDER.slice(idx), ...WEEK_ORDER.slice(0, idx)];
  }, [weekStart]);

  const weeks = useMemo(() => getMonthGrid(year, month), [year, month]);
  const rotatedWeeks = useMemo(() => {
    const mondayIdx = WEEK_ORDER.indexOf("MO");
    const startIdx = WEEK_ORDER.indexOf(weekStart);
    const shift = (startIdx - mondayIdx + 7) % 7;
    if (shift === 0) return weeks;
    return weeks.map(w => [...w.slice(shift), ...w.slice(0, shift)]);
  }, [weeks, weekStart]);

  // unify manual events + scheduled tasks into one lookup: dateKey -> [{label, category, taskId?}]
  const itemsByDate = useMemo(() => {
    const map = {};
    events.forEach(ev => {
      expandRecurring(ev, year, month).forEach(key => {
        if (!map[key]) map[key] = [];
        map[key].push({ label: ev.label, category: ev.category, recurring: ev.recurring !== "none", time: ev.time || null });
      });
    });
    tasks.forEach(t => {
      if (t.scheduledDate) {
        if (!map[t.scheduledDate]) map[t.scheduledDate] = [];
        map[t.scheduledDate].push({ label: t.text, category: t.category, taskId: t.id, est: t.estMinutes, time: t.scheduleTime || null, durationMin: t.estMinutes || 30 });
      }
    });
    Object.keys(map).forEach(k => {
      if (categoryFilter !== "all") map[k] = map[k].filter(x => x.category === categoryFilter);
    });
    return map;
  }, [events, tasks, year, month, categoryFilter]);

  // Items across all 12 months of the selected year, for the year view
  const itemsByDateForYear = useMemo(() => {
    const map = {};
    for (let m = 0; m < 12; m++) {
      events.forEach(ev => {
        expandRecurring(ev, year, m).forEach(key => {
          if (!map[key]) map[key] = [];
          map[key].push({ label: ev.label, category: ev.category });
        });
      });
    }
    tasks.forEach(t => {
      if (t.scheduledDate && t.scheduledDate.startsWith(`${year}-`)) {
        if (!map[t.scheduledDate]) map[t.scheduledDate] = [];
        map[t.scheduledDate].push({ label: t.text, category: t.category, taskId: t.id });
      }
    });
    Object.keys(map).forEach(k => {
      if (categoryFilter !== "all") map[k] = map[k].filter(x => x.category === categoryFilter);
    });
    return map;
  }, [events, tasks, year, categoryFilter]);

  function addEvent() {
    if (!newEvDate || !newEvLabel) return;
    setEvents([...events, { id: uid(), date: newEvDate, time: newEvTime || null, label: newEvLabel, category: newEvCategory, recurring: newEvRecurring }]);
    setNewEvLabel(""); setNewEvDate(""); setNewEvTime("");
  }
  function updateEvent(id, patch) {
    setEvents(events.map(e => e.id === id ? { ...e, ...patch } : e));
  }
  function removeEvent(id) {
    const ev = events.find(e => e.id === id);
    const idx = events.findIndex(e => e.id === id);
    setEvents(events.filter(e => e.id !== id));
    if (ev) {
      triggerUndo(`Deleted "${ev.label}"`, () => {
        setEvents(prev => { const copy = [...prev]; copy.splice(idx, 0, ev); return copy; });
      });
    }
  }

  function holidayLabelsFor(day) {
    const key = `${year}-${pad(month+1)}-${pad(day)}`;
    return includeHolidays && US_HOLIDAYS_2026[key] ? [US_HOLIDAYS_2026[key]] : [];
  }

  function handlePrint() { window.print(); }

  const [downloadingPdf, setDownloadingPdf] = useState(false);
  async function downloadPDF() {
    if (!printRef.current) return;
    setDownloadingPdf(true);
    try {
      const canvas = await html2canvas(printRef.current, {
        scale: 2,
        backgroundColor: themeBg,
        onclone: (clonedDoc) => {
          clonedDoc.querySelectorAll(".no-print").forEach(el => { el.style.display = "none"; });
        },
      });
      const imgData = canvas.toDataURL("image/png");
      const orientation = canvas.width > canvas.height ? "landscape" : "portrait";
      const pdf = new jsPDF({ orientation, unit: "px", format: [canvas.width, canvas.height] });
      pdf.addImage(imgData, "PNG", 0, 0, canvas.width, canvas.height);
      const label = calendarView === "year" ? `${year}` : calendarView === "day" ? `day-${MONTHS[month]}-${selectedDay}-${year}` : calendarView === "week" ? `week-${MONTHS[month]}-${selectedDay}-${year}` : `${MONTHS[month]}-${year}`;
      pdf.save(`tulsi-grace-calendar-${label}.pdf`);
    } catch (err) {
      console.error("PDF export failed:", err);
    } finally {
      setDownloadingPdf(false);
    }
  }

  function svgWrap(totalW, totalH, bodyMarkup, titleText) {
    const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${totalW}" height="${totalH}" viewBox="0 0 ${totalW} ${totalH}">`;
    svg += `<rect width="${totalW}" height="${totalH}" fill="${themeBg}" />`;
    svg += `<text x="${totalW/2}" y="34" font-family="Georgia, serif" font-size="24" font-weight="600" fill="${COLORS.ink}" text-anchor="middle">${esc(titleText)}</text>`;
    svg += bodyMarkup;
    svg += `<text x="${totalW/2}" y="${totalH-8}" font-family="monospace" font-size="9" fill="${COLORS.sage}" text-anchor="middle">TULSIANDGRACE.COM</text>`;
    svg += `</svg>`;
    return svg;
  }
  function svgDownloadBlob(svg, filename) {
    const blob = new Blob([svg], { type: "image/svg+xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  function downloadSVG() {
    if (calendarView === "week") return downloadWeekSVG();
    if (calendarView === "day") return downloadDaySVG();
    if (calendarView === "year") return downloadYearSVG();
    return downloadMonthSVG();
  }

  function downloadMonthSVG() {
    const cellW = 110, cellH = 90, headerH = 70, padX = 20, padY = 20;
    const gridW = cellW * 7, gridH = cellH * rotatedWeeks.length;
    const totalW = gridW + padX * 2, totalH = gridH + headerH + padY * 2;
    let body = "";
    orderedWeekDays.forEach((d, i) => {
      const x = padX + i * cellW;
      body += `<rect x="${x}" y="${padY+headerH}" width="${cellW}" height="24" fill="${themeBg}" stroke="${COLORS.ink}" />`;
      body += `<text x="${x+cellW/2}" y="${padY+headerH+16}" font-family="Arial" font-size="10" fill="${COLORS.ink}" text-anchor="middle">${esc(DAY_LABELS[d].slice(0,3).toUpperCase())}</text>`;
    });
    rotatedWeeks.forEach((week, wi) => {
      week.forEach((day, di) => {
        const x = padX + di * cellW, y = padY + headerH + 24 + wi * (cellH - 24);
        body += `<rect x="${x}" y="${y}" width="${cellW}" height="${cellH-24}" fill="#ffffff" stroke="${COLORS.lavenderLight}" />`;
        if (day) {
          const key = `${year}-${pad(month+1)}-${pad(day)}`;
          const dayItems = itemsByDate[key] || [];
          body += `<text x="${x+8}" y="${y+16}" font-family="Arial" font-size="11" font-weight="700" fill="${COLORS.ink}">${day}</text>`;
          dayItems.slice(0, 3).forEach((it, ii) => {
            const cat = it.category ? categoryById(it.category) : null;
            const color = cat ? cat.color : COLORS.ink;
            const iy = y + 30 + ii * 13;
            body += `<circle cx="${x+10}" cy="${iy-3}" r="3" fill="${color}" />`;
            body += `<text x="${x+18}" y="${iy}" font-family="Arial" font-size="8" fill="${COLORS.ink}">${esc(it.label).slice(0, 14)}</text>`;
          });
        }
      });
    });
    const svg = svgWrap(totalW, totalH, body, `${MONTHS[month].toUpperCase()} ${year}`);
    svgDownloadBlob(svg, `tulsi-grace-calendar-${MONTHS[month]}-${year}.svg`);
  }

  function downloadWeekSVG() {
    const anchor = new Date(year, month, selectedDay);
    const anchorDow = (anchor.getDay() + 6) % 7;
    const weekDates = Array.from({length:7}, (_,i) => { const d = new Date(anchor); d.setDate(anchor.getDate() - anchorDow + i); return d; });
    const cellW = 140, cellH = 220, padX = 20, padY = 20, headerH = 50;
    const totalW = cellW * 7 + padX * 2, totalH = cellH + headerH + padY * 2;
    let body = "";
    weekDates.forEach((d, i) => {
      const x = padX + i * cellW, y = padY + headerH;
      const key = toKey(d);
      const cycle = showCycle && cycleStart ? cyclePhaseForDate(d, cycleStart, cycleLength, periodLength) : null;
      const dayItems = itemsByDate[key] || [];
      body += `<rect x="${x}" y="${y}" width="${cellW-6}" height="${cellH}" fill="#ffffff" stroke="${COLORS.lavenderLight}" />`;
      body += `<text x="${x+8}" y="${y+18}" font-family="Arial" font-size="11" font-weight="700" fill="${COLORS.ink}">${esc(DAY_LABELS[WEEK_ORDER[i]].slice(0,3).toUpperCase())} ${d.getDate()}</text>`;
      if (cycle) body += `<text x="${x+8}" y="${y+32}" font-family="Arial" font-size="8" fill="${COLORS.sage}">${esc(cycle.phase)}</text>`;
      dayItems.slice(0, 8).forEach((it, ii) => {
        const cat = it.category ? categoryById(it.category) : null;
        const color = cat ? cat.color : COLORS.ink;
        const iy = y + 48 + ii * 16;
        body += `<circle cx="${x+10}" cy="${iy-3}" r="3" fill="${color}" />`;
        body += `<text x="${x+18}" y="${iy}" font-family="Arial" font-size="8.5" fill="${COLORS.ink}">${esc(it.label).slice(0, 16)}</text>`;
      });
    });
    const svg = svgWrap(totalW, totalH, body, `WEEK OF ${MONTHS[weekDates[0].getMonth()].toUpperCase()} ${weekDates[0].getDate()}, ${weekDates[0].getFullYear()}`);
    svgDownloadBlob(svg, `tulsi-grace-week-${toKey(weekDates[0])}.svg`);
  }

  function downloadDaySVG() {
    const dateObj = new Date(year, month, selectedDay);
    const key = toKey(dateObj);
    const cycle = showCycle && cycleStart ? cyclePhaseForDate(dateObj, cycleStart, cycleLength, periodLength) : null;
    const dayItems = itemsByDate[key] || [];
    const totalW = 480, headerH = 60, padY = 20;
    const totalH = headerH + padY * 2 + 40 + dayItems.length * 26;
    let body = "";
    if (cycle) body += `<text x="240" y="${headerH+10}" font-family="Arial" font-size="12" fill="${COLORS.sage}" text-anchor="middle">${esc(cycle.phase)} phase · ${esc(cycle.energy)} energy</text>`;
    dayItems.forEach((it, ii) => {
      const cat = it.category ? categoryById(it.category) : null;
      const color = cat ? cat.color : COLORS.ink;
      const y = headerH + 40 + ii * 26;
      body += `<circle cx="30" cy="${y-4}" r="4" fill="${color}" />`;
      body += `<text x="42" y="${y}" font-family="Arial" font-size="13" fill="${COLORS.ink}">${esc(it.label)}${it.est ? ` — ${it.est} min` : ""}</text>`;
    });
    const svg = svgWrap(totalW, totalH, body, `${MONTHS[month].toUpperCase()} ${selectedDay}, ${year}`);
    svgDownloadBlob(svg, `tulsi-grace-day-${key}.svg`);
  }

  function downloadYearSVG() {
    const cols = 3, rows = 4, cellW = 220, cellH = 190, padX = 20, padY = 20, headerH = 50;
    const totalW = cellW * cols + padX * 2, totalH = cellH * rows + headerH + padY * 2;
    let body = "";
    MONTHS.forEach((mName, mi) => {
      const col = mi % cols, row = Math.floor(mi / cols);
      const x = padX + col * cellW, y = padY + headerH + row * cellH;
      const grid = getMonthGrid(year, mi);
      body += `<rect x="${x}" y="${y}" width="${cellW-10}" height="${cellH-10}" fill="#ffffff" stroke="${COLORS.lavenderLight}" />`;
      body += `<text x="${x+10}" y="${y+16}" font-family="Georgia, serif" font-size="12" font-weight="700" fill="${COLORS.ink}">${esc(mName)}</text>`;
      const dayCellW = (cellW-30) / 7;
      grid.forEach((week, wi) => {
        week.forEach((day, di) => {
          if (!day) return;
          const key = `${year}-${pad(mi+1)}-${pad(day)}`;
          const hasItems = itemsByDateForYear[key] && itemsByDateForYear[key].length > 0;
          const isHoliday = includeHolidays && US_HOLIDAYS_2026[key];
          const dx = x + 10 + di * dayCellW, dy = y + 28 + wi * 16;
          body += `<text x="${dx}" y="${dy}" font-family="Arial" font-size="6.5" fill="${COLORS.ink}">${day}</text>`;
          if (hasItems || isHoliday) {
            const cat = hasItems && itemsByDateForYear[key][0].category ? categoryById(itemsByDateForYear[key][0].category) : null;
            body += `<circle cx="${dx+4}" cy="${dy+4}" r="2" fill="${cat ? cat.color : COLORS.lavender}" />`;
          }
        });
      });
    });
    const svg = svgWrap(totalW, totalH, body, `${year}`);
    svgDownloadBlob(svg, `tulsi-grace-year-${year}.svg`);
  }

  /* ---------- data backup: export / import everything as JSON ---------- */
  function exportDataJSON() {
    const payload = {
      exportedAt: new Date().toISOString(),
      app: "tulsi-grace-system",
      inboxItems, tasks, categories, events, savedQuotes, quote, author, weekStart,
      cycleStart, cycleLength, periodLength, includeHolidays, themeBg, themeAccent, themeHighlight,
      routines, showRoutinesOnMonth, showRoutinesOnWeek,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `tulsi-grace-system-backup-${toKey(new Date())}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  const importFileRef = useRef(null);
  const [importStatus, setImportStatus] = useState(null); // null | "confirm" | "done" | "error"
  const [pendingImport, setPendingImport] = useState(null);
  function handleImportFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (!data || typeof data !== "object") throw new Error("Not a valid backup file");
        setPendingImport(data);
        setImportStatus("confirm");
      } catch (err) {
        console.error("Import failed:", err);
        setImportStatus("error");
        setTimeout(() => setImportStatus(null), 4000);
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  }
  function confirmImport() {
    const data = pendingImport;
    if (!data) return;
    if (data.inboxItems) setInboxItems(data.inboxItems);
    if (data.tasks) setTasks(data.tasks);
    if (data.categories) setCategories(data.categories);
    if (data.events) setEvents(data.events);
    if (data.savedQuotes) setSavedQuotes(data.savedQuotes);
    if (data.quote) setQuote(data.quote);
    if (data.author) setAuthor(data.author);
    if (data.weekStart) setWeekStart(data.weekStart);
    if (data.includeHolidays !== undefined) setIncludeHolidays(data.includeHolidays);
    if (data.themeBg) setThemeBg(data.themeBg);
    if (data.themeAccent) setThemeAccent(data.themeAccent);
    if (data.themeHighlight) setThemeHighlight(data.themeHighlight);
    if (data.routines) setRoutines(data.routines);
    if (data.showRoutinesOnMonth !== undefined) setShowRoutinesOnMonth(data.showRoutinesOnMonth);
    if (data.showRoutinesOnWeek !== undefined) setShowRoutinesOnWeek(data.showRoutinesOnWeek);
    // cycleStart/cycleLength/periodLength intentionally NOT restored — those stay
    // synced live from the Lunar & Cycle app, which remains the source of truth.
    setPendingImport(null);
    setImportStatus("done");
    setTimeout(() => setImportStatus(null), 4000);
  }
  function cancelImport() {
    setPendingImport(null);
    setImportStatus(null);
  }

  /* ================= RENDER ================= */
  return (
    <div style={{ fontFamily: BODY_FONT, background: COLORS.cream, minHeight: "100vh", padding: "28px 20px" }}>
      <style>{`
        ${FONT_IMPORT}
        * { box-sizing: border-box; }
        ::-webkit-scrollbar { width: 8px; height: 8px; }
        ::-webkit-scrollbar-thumb { background: ${COLORS.lavender}; border-radius: 8px; }
        button:focus-visible, input:focus-visible, textarea:focus-visible, select:focus-visible {
          outline: 2px solid ${COLORS.azure}; outline-offset: 2px;
        }
        @media print {
          .no-print { display: none !important; }
          .calendar-tab-grid { display: block !important; }
          body { background: white; }
        }
      `}</style>

      <div style={{ maxWidth: 1180, margin: "0 auto" }}>
        {/* Header */}
        <div style={{ marginBottom: 24, display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 10 }}>
          <div>
            <div style={{ fontFamily: DATA_FONT, fontSize: 11, letterSpacing: 2, color: COLORS.sage, marginBottom: 6 }}>
              TULSI &amp; GRACE · SIGNATURE SYSTEM
            </div>
            <h1 style={{ fontFamily: DISPLAY_FONT, fontWeight: 600, fontSize: 34, color: COLORS.ink, margin: 0 }}>
              Brain Inbox, Tasks &amp; Calendar
            </h1>
            <p style={{ color: COLORS.sage, fontSize: 14, marginTop: 6, maxWidth: 560 }}>
              Capture without deciding. Sort when you're ready. Schedule once it earns a place on the calendar.
            </p>
          </div>
          <div className="no-print" style={{ fontSize: 11.5, color: COLORS.sage, fontFamily: DATA_FONT, whiteSpace: "nowrap", marginTop: 4 }}>
            {saveStatus === "saving" && "Saving…"}
            {saveStatus === "saved" && "All changes saved"}
            {saveStatus === "error" && "Save failed — changes may not persist"}
          </div>
        </div>

        {!isLoaded && (
          <div style={{ textAlign: "center", color: COLORS.sage, padding: 60, fontFamily: BODY_FONT }}>
            Loading your saved data…
          </div>
        )}

        {isLoaded && (
        <>
        {/* Betterment Theme banner — links out to the standalone Betterment Theme app */}
        <a href="/betterment-theme.html" className="no-print" style={{
          display: "block", textDecoration: "none", marginBottom: 16, padding: "12px 18px",
          borderRadius: 11, border: `1px solid ${COLORS.lavenderLight}`, background: COLORS.lavenderLight,
          color: COLORS.ink, fontFamily: BODY_FONT,
        }}>
          <span style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em", opacity: 0.6 }}>Betterment Theme</span>
          <div style={{ fontFamily: DISPLAY_FONT, fontSize: 16, marginTop: 2 }}>Open this month's theme →</div>
        </a>

        {/* Tabs */}
        <div className="no-print" style={{ display: "flex", gap: 8, marginBottom: 20, flexWrap: "wrap" }}>
          {[
            { id: "today", label: "Today" },
            { id: "inbox", label: `Brain Inbox${inboxItems.length ? ` · ${inboxItems.length}` : ""}` },
            { id: "tasks", label: `Task Lists${tasksByStatus[STATUS.ACTIVE].length ? ` · ${tasksByStatus[STATUS.ACTIVE].length}` : ""}` },
            { id: "calendar", label: "Calendar" },
          ].map(t => (
            <button key={t.id} onClick={() => setTab(t.id)} style={{
              padding: "10px 18px", borderRadius: 11, border: `1px solid ${tab === t.id ? COLORS.sage : COLORS.lavenderLight}`,
              background: tab === t.id ? COLORS.sage : COLORS.white, color: tab === t.id ? "#fff" : COLORS.ink,
              fontFamily: DISPLAY_FONT, fontSize: 15, cursor: "pointer",
            }}>{t.label}</button>
          ))}
        </div>

        {/* ---------------- INBOX TAB ---------------- */}
        {tab === "today" && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }} className="today-grid">
            <div>
              <div style={{ background: COLORS.white, borderRadius: 16, padding: 24, marginBottom: 20 }}>
                <div style={{ fontSize: 12, letterSpacing: 1, textAlign: "center", color: COLORS.sage, textTransform: "uppercase", marginBottom: 4 }}>
                  {new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}
                </div>
                <div style={{ fontSize: 22, fontFamily: DISPLAY_FONT, textAlign: "center", marginBottom: 12 }}>How will I be 1% better today?</div>
                <textarea
                  value={todayDraft}
                  onChange={e => setTodayDraft(e.target.value)}
                  onBlur={saveTodayAnswer}
                  placeholder="One small, honest answer…"
                  rows={2}
                  style={{ width: "100%", padding: "10px 12px", borderRadius: 10, border: `1px solid ${COLORS.lavenderLight}`, fontFamily: BODY_FONT, fontSize: 14, boxSizing: "border-box" }}
                />
                {todayLog.length > 0 && (
                  <div style={{ marginTop: 10 }}>
                    <button onClick={() => setShowPastAnswers(s => !s)} style={{ background: "none", border: "none", color: COLORS.sage, fontSize: 12.5, cursor: "pointer", padding: 0 }}>
                      {showPastAnswers ? "Hide" : "Show"} past answers ({todayLog.length})
                    </button>
                    {showPastAnswers && (
                      <div style={{ marginTop: 8, maxHeight: 180, overflowY: "auto" }}>
                        {todayLog.map(entry => (
                          <div key={entry.date} style={{ fontSize: 12.5, padding: "6px 0", borderTop: `1px solid ${COLORS.lavenderLight}` }}>
                            <strong>{entry.date}:</strong> {entry.answer}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>

              <div style={{ background: COLORS.white, borderRadius: 16, padding: 24, marginBottom: 20 }}>
                <div style={{ fontSize: 13, fontWeight: 600, textAlign: "center", marginBottom: 12 }}>Today's Tasks</div>
                {tasksByStatus[STATUS.ACTIVE].slice(0, 8).map(t => (
                  <div key={t.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 0" }}>
                    <input type="checkbox" checked={false} onChange={() => setTasks(ts => ts.map(x => x.id === t.id ? { ...x, status: STATUS.COMPLETED } : x))} />
                    <span style={{ fontSize: 14 }}>{t.text}</span>
                  </div>
                ))}
                {tasksByStatus[STATUS.ACTIVE].length === 0 && <div style={{ fontSize: 13, color: COLORS.ink, opacity: 0.6, textAlign: "center" }}>No active tasks — add one from Task Lists or the Calendar.</div>}
              </div>

              <div style={{ background: COLORS.white, borderRadius: 16, padding: 24 }}>
                <div style={{ fontSize: 13, fontWeight: 600, textAlign: "center", marginBottom: 12 }}>Focus Timer</div>
                <div style={{ width: 130, height: 130, borderRadius: "50%", border: `2px solid ${COLORS.lavenderLight}`, margin: "0 auto 12px", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: DISPLAY_FONT, fontSize: 22 }}>
                  {focusRemaining !== null ? `${String(Math.floor(focusRemaining / 60)).padStart(2, "0")}:${String(focusRemaining % 60).padStart(2, "0")}` : `${String(focusMinutes).padStart(2, "0")}:00`}
                </div>
                <select value={focusTaskId} onChange={e => setFocusTaskId(e.target.value)} style={{ width: "100%", padding: 8, borderRadius: 8, border: `1px solid ${COLORS.lavenderLight}`, marginBottom: 10, fontSize: 13.5 }}>
                  <option value="">Choose a task</option>
                  {tasksByStatus[STATUS.ACTIVE].map(t => <option key={t.id} value={t.id}>{t.text}</option>)}
                </select>
                <div style={{ display: "flex", gap: 6, justifyContent: "center", marginBottom: 10 }}>
                  {[10, 20, 25, 45].map(m => (
                    <button key={m} onClick={() => setFocusMinutes(m)} style={{ padding: "6px 12px", borderRadius: 20, border: `1px solid ${focusMinutes === m ? COLORS.sage : COLORS.lavenderLight}`, background: focusMinutes === m ? COLORS.sage : COLORS.white, color: focusMinutes === m ? "#fff" : COLORS.ink, fontSize: 12.5, cursor: "pointer" }}>{m}m</button>
                  ))}
                </div>
                <button onClick={focusRemaining !== null ? stopFocus : startFocus} style={{ width: "100%", padding: 10, borderRadius: 10, border: "none", background: COLORS.sage, color: "#fff", fontWeight: 600, cursor: "pointer" }}>
                  {focusRemaining !== null ? "Stop" : "Start the timer"}
                </button>

                <div style={{ marginTop: 16, paddingTop: 16, borderTop: `1px solid ${COLORS.lavenderLight}` }}>
                  {!libraryKey ? (
                    <div>
                      <div style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: 1, color: COLORS.sage, marginBottom: 8 }}>Link to your library</div>
                      <LibraryConnect onConnect={connectLibrary} />
                    </div>
                  ) : !linkedBook ? (
                    <div>
                      <div style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: 1, color: COLORS.sage, marginBottom: 8 }}>Link from your library</div>
                      {libraryLoadState === "loading" && <div style={{ fontSize: 13, opacity: 0.7 }}>Loading your library…</div>}
                      {libraryLoadState === "error" && (
                        <div>
                          <div style={{ fontSize: 13, opacity: 0.7, marginBottom: 8 }}>Couldn't reach your library.</div>
                          <button onClick={() => loadLibrary(libraryKey)} style={{ width: "100%", padding: 8, borderRadius: 8, border: `1px solid ${COLORS.lavenderLight}`, background: COLORS.white }}>Try again</button>
                        </div>
                      )}
                      {libraryLoadState === "loaded" && <LibraryPicker books={libraryBooks} onPick={linkBook} />}
                    </div>
                  ) : (
                    <div>
                      <div style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: 1, color: COLORS.sage, marginBottom: 8 }}>Linked to your library</div>
                      <div style={{ fontSize: 14, fontWeight: 600 }}>{linkedBook.title}</div>
                      <div style={{ fontSize: 12.5, opacity: 0.7, marginBottom: 10 }}>
                        {linkedBook.totalPages ? `${linkedBook.currentPage || 0} of ${linkedBook.totalPages} pages` : "No page count set for this book"}
                      </div>
                      <ReadingProgressInput initial={linkedBook.currentPage || 0} onSave={saveReadingProgressToLibrary} />
                      <button onClick={unlinkBook} style={{ width: "100%", marginTop: 8, padding: 8, borderRadius: 8, border: `1px solid ${COLORS.lavenderLight}`, background: COLORS.white, fontSize: 12.5 }}>Change book</button>
                      <textarea
                        value={readingBook.quote}
                        onChange={e => setReadingBook(prev => ({ ...prev, quote: e.target.value }))}
                        placeholder="Favorite line or quote from today's reading…"
                        rows={2}
                        style={{ width: "100%", marginTop: 10, padding: "8px 10px", borderRadius: 8, border: `1px solid ${COLORS.lavenderLight}`, fontSize: 13, fontFamily: BODY_FONT, boxSizing: "border-box" }}
                      />
                      <textarea
                        value={readingBook.note}
                        onChange={e => setReadingBook(prev => ({ ...prev, note: e.target.value }))}
                        placeholder="Reading thoughts and notes from today…"
                        rows={2}
                        style={{ width: "100%", marginTop: 8, padding: "8px 10px", borderRadius: 8, border: `1px solid ${COLORS.lavenderLight}`, fontSize: 13, fontFamily: BODY_FONT, boxSizing: "border-box" }}
                      />
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div>
              <div style={{ background: COLORS.white, borderRadius: 16, padding: 24, marginBottom: 20, textAlign: "center" }}>
                <MoonAndCycleWidget cyclePhase={cycleStart ? cyclePhaseForDate(new Date(), cycleStart, cycleLength, periodLength)?.phase : null} />
                <a href="https://root-restore-lunar-cycle.netlify.app" target="_blank" rel="noreferrer" style={{ display: "inline-block", marginTop: 12, padding: "8px 16px", borderRadius: 20, border: `1px solid ${COLORS.azure}`, color: COLORS.azure, textDecoration: "none", fontSize: 13 }}>Open Lunar App</a>
              </div>

              <div style={{ background: COLORS.white, borderRadius: 16, padding: 24 }}>
                <div style={{ fontSize: 13, fontWeight: 600, textAlign: "center", marginBottom: 4 }}>Fill Your Cup</div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 12, marginBottom: 12 }}>
                  {CUP_CATEGORIES.map(cat => (
                    <button key={cat} onClick={() => toggleCup(cat)} style={{ padding: 10, borderRadius: 10, border: `1px solid ${cupFilled.includes(cat) ? COLORS.sage : COLORS.lavenderLight}`, background: cupFilled.includes(cat) ? COLORS.sage : COLORS.white, color: cupFilled.includes(cat) ? "#fff" : COLORS.ink, fontSize: 13, cursor: "pointer" }}>
                      {cat}
                    </button>
                  ))}
                </div>
                <div style={{ fontSize: 12, textAlign: "center", opacity: 0.7 }}>Today {cupFilled.length}/{CUP_CATEGORIES.length}</div>
              </div>
            </div>
          </div>
        )}

        {tab === "inbox" && (
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr)", gap: 16 }}>
            <div style={cardStyle}>
              <label style={labelStyle}>DROP A THOUGHT</label>
              <div style={{ display: "flex", gap: 10 }}>
                <input
                  style={inputStyle}
                  placeholder="Type it and move on — sort it later"
                  value={inboxText}
                  onChange={e => setInboxText(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && addInboxItem()}
                />
                <button onClick={addInboxItem} style={{
                  background: COLORS.sage, color: "#fff", border: "none", borderRadius: 9,
                  padding: "0 20px", fontFamily: DISPLAY_FONT, fontSize: 15, cursor: "pointer",
                }}>Drop it</button>
              </div>
            </div>

            <div style={cardStyle}>
              <label style={labelStyle}>YOUR CATEGORIES</label>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
                {categories.map(c => (
                  <span key={c.id} style={{ display: "flex", alignItems: "center", gap: 6, background: c.color, color: "#fff", borderRadius: 999, padding: "5px 10px 5px 13px", fontSize: 12, fontWeight: 600 }}>
                    {c.label}
                    {!DEFAULT_CATEGORIES.some(dc => dc.id === c.id) && (
                      <button onClick={() => removeCategory(c.id)} style={{ background: "none", border: "none", color: "#fff", cursor: "pointer", padding: 0, fontSize: 13, lineHeight: 1 }}>✕</button>
                    )}
                  </span>
                ))}
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <input
                  style={inputStyle}
                  placeholder="Add a category (e.g. Stationery)"
                  value={newCategoryLabel}
                  onChange={e => setNewCategoryLabel(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && addCategory()}
                />
                <button onClick={addCategory} style={{ background: COLORS.ink, color: "#fff", border: "none", borderRadius: 9, padding: "0 18px", fontFamily: BODY_FONT, fontWeight: 600, cursor: "pointer" }}>Add</button>
              </div>
            </div>

            <div>
              <div style={{ fontFamily: DISPLAY_FONT, fontSize: 18, color: COLORS.ink, margin: "4px 0 12px" }}>
                Waiting to be sorted {inboxItems.length > 0 && `(${inboxItems.length})`}
              </div>
              {inboxItems.length === 0 && (
                <div style={{ ...cardStyle, color: COLORS.sage, fontSize: 14, textAlign: "center", padding: 30 }}>
                  Inbox is clear. Drop the next thought whenever it lands.
                </div>
              )}
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {inboxItems.map(item => (
                  <div key={item.id} style={{ ...cardStyle, padding: 14 }}>
                    {editingInboxId === item.id ? (
                      <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
                        <input
                          autoFocus
                          style={{ ...inputStyle, flex: 1 }}
                          value={editingInboxText}
                          onChange={e => setEditingInboxText(e.target.value)}
                          onKeyDown={e => { if (e.key === "Enter") saveEditInbox(); if (e.key === "Escape") setEditingInboxId(null); }}
                          onBlur={saveEditInbox}
                        />
                      </div>
                    ) : (
                      <div style={{ display: "flex", alignItems: "flex-start", gap: 8, marginBottom: 10 }}>
                        <div style={{ fontSize: 15, color: COLORS.ink, flex: 1 }}>{item.text}</div>
                        <button onClick={() => startEditInbox(item)} title="Edit" style={{ background: "none", border: "none", color: COLORS.sage, cursor: "pointer", fontSize: 13, padding: 0 }}>✎</button>
                      </div>
                    )}
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                      <span style={{ fontSize: 11, color: COLORS.sage, fontWeight: 600, marginRight: 2 }}>SORT TO:</span>
                      {categories.map(c => (
                        <Pill key={c.id} color={c.color} onClick={() => sortToTask(item, c.id)}>{c.label}</Pill>
                      ))}
                      <Pill color={COLORS.ink} onClick={() => sortToArchive(item)}>Archive</Pill>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ---------------- TASKS TAB ---------------- */}
        {tab === "tasks" && (
          <div>
            <div style={{ ...cardStyle, marginBottom: 18, display: "flex", gap: 20, flexWrap: "wrap" }}>
              <div>
                <label style={labelStyle}>SHOW</label>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  <Pill color={COLORS.ink} active={taskFilterStatus === "all"} onClick={() => setTaskFilterStatus("all")}>All</Pill>
                  <Pill color={COLORS.sage} active={taskFilterStatus === "pending"} onClick={() => setTaskFilterStatus("pending")}>Pending</Pill>
                  <Pill color={COLORS.sage} active={taskFilterStatus === STATUS.ACTIVE} onClick={() => setTaskFilterStatus(STATUS.ACTIVE)}>Active</Pill>
                  <Pill color={COLORS.lavender} active={taskFilterStatus === STATUS.SOMEDAY} onClick={() => setTaskFilterStatus(STATUS.SOMEDAY)}>Someday</Pill>
                  <Pill color={COLORS.azure} active={taskFilterStatus === STATUS.COMPLETED} onClick={() => setTaskFilterStatus(STATUS.COMPLETED)}>Completed</Pill>
                  <Pill color={COLORS.ink} active={taskFilterStatus === STATUS.ARCHIVED} onClick={() => setTaskFilterStatus(STATUS.ARCHIVED)}>Archived</Pill>
                </div>
              </div>
              <div>
                <label style={labelStyle}>CATEGORY</label>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  <Pill color={COLORS.ink} active={taskFilterCategory === "all"} onClick={() => setTaskFilterCategory("all")}>All</Pill>
                  {categories.map(c => (
                    <Pill key={c.id} color={c.color} active={taskFilterCategory === c.id} onClick={() => setTaskFilterCategory(c.id)}>{c.label}</Pill>
                  ))}
                </div>
              </div>
            </div>

            {(() => {
              const statusesToShow =
                taskFilterStatus === "all" ? [STATUS.ACTIVE, STATUS.SOMEDAY, STATUS.COMPLETED, STATUS.ARCHIVED]
                : taskFilterStatus === "pending" ? [STATUS.ACTIVE, STATUS.SOMEDAY]
                : [taskFilterStatus];
              const anyResults = statusesToShow.some(sk => tasksByStatus[sk].filter(t => taskFilterCategory === "all" || t.category === taskFilterCategory).length > 0);
              if (!anyResults) {
                return (
                  <div style={{ ...cardStyle, color: COLORS.sage, fontSize: 14, textAlign: "center", padding: 30 }}>
                    Nothing matches this filter yet.
                  </div>
                );
              }
              return null;
            })()}

            {[STATUS.ACTIVE, STATUS.SOMEDAY, STATUS.COMPLETED, STATUS.ARCHIVED].filter(statusKey => {
              const statusesToShow =
                taskFilterStatus === "all" ? [STATUS.ACTIVE, STATUS.SOMEDAY, STATUS.COMPLETED, STATUS.ARCHIVED]
                : taskFilterStatus === "pending" ? [STATUS.ACTIVE, STATUS.SOMEDAY]
                : [taskFilterStatus];
              return statusesToShow.includes(statusKey);
            }).map(statusKey => {
              const labelMap = { active: "Active", someday: "Someday / Maybe", completed: "Completed", archived: "Archived" };
              const list = tasksByStatus[statusKey].filter(t => taskFilterCategory === "all" || t.category === taskFilterCategory);
              if (list.length === 0) return null;
              return (
                <div key={statusKey} style={{ marginBottom: 26 }}>
                  <div style={{ fontFamily: DISPLAY_FONT, fontSize: 18, color: COLORS.ink, marginBottom: 10 }}>
                    {labelMap[statusKey]} {list.length > 0 && `(${list.length})`}
                  </div>

                  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    {list.map(t => {
                      const cat = t.category ? categoryById(t.category) : null;
                      const isOverdue = statusKey === STATUS.ACTIVE && t.scheduledDate && t.scheduledDate < toKey(new Date());
                      return (
                        <div key={t.id} style={{ ...cardStyle, padding: 14, border: isOverdue ? "1px solid #c4786a" : cardStyle.border }}>
                          <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
                            {editingTaskId === t.id ? (
                              <input
                                autoFocus
                                style={{ ...inputStyle, flex: 1, minWidth: 180 }}
                                value={editingTaskText}
                                onChange={e => setEditingTaskText(e.target.value)}
                                onKeyDown={e => {
                                  if (e.key === "Enter") { if (editingTaskText.trim()) updateTask(t.id, { text: editingTaskText.trim() }); setEditingTaskId(null); }
                                  if (e.key === "Escape") setEditingTaskId(null);
                                }}
                                onBlur={() => { if (editingTaskText.trim()) updateTask(t.id, { text: editingTaskText.trim() }); setEditingTaskId(null); }}
                              />
                            ) : (
                              <div style={{ display: "flex", alignItems: "center", gap: 8, flex: 1, minWidth: 180 }}>
                                <div style={{ fontSize: 15, color: COLORS.ink }}>{t.text}</div>
                                <button onClick={() => { setEditingTaskId(t.id); setEditingTaskText(t.text); }} title="Edit" style={{ background: "none", border: "none", color: COLORS.sage, cursor: "pointer", fontSize: 12, padding: 0 }}>✎</button>
                              </div>
                            )}
                            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                              {isOverdue && <Pill color="#c4786a" active>Overdue</Pill>}
                              {cat && <Pill color={cat.color} active>{cat.label}</Pill>}
                            </div>
                          </div>
                          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginTop: 12 }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                              <span style={{ fontSize: 11, color: COLORS.sage, fontWeight: 600 }}>EST. MIN</span>
                              <input
                                type="number" placeholder="—"
                                style={{ ...inputStyle, width: 70, padding: "6px 8px" }}
                                value={t.estMinutes ?? ""}
                                onChange={e => updateTask(t.id, { estMinutes: e.target.value ? Number(e.target.value) : null })}
                              />
                            </div>
                            {statusKey === STATUS.ACTIVE && (
                              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                                <span style={{ fontSize: 11, color: COLORS.sage, fontWeight: 600 }}>SCHEDULE</span>
                                <input
                                  type="date" style={{ ...inputStyle, width: 150, padding: "6px 8px" }}
                                  value={t.scheduledDate || ""}
                                  onChange={e => scheduleTask(t.id, e.target.value || null)}
                                />
                                {t.scheduledDate && (
                                  <input
                                    type="time" title="Optional time \u2014 shows this task on the hour grid" style={{ ...inputStyle, width: 110, padding: "6px 8px" }}
                                    value={t.scheduleTime || ""}
                                    onChange={e => scheduleTaskTime(t.id, e.target.value)}
                                  />
                                )}
                              </div>
                            )}
                            <div style={{ display: "flex", gap: 6, marginLeft: "auto" }}>
                              {statusKey !== STATUS.COMPLETED && <Pill color={COLORS.azure} onClick={() => updateTask(t.id, { status: STATUS.COMPLETED })}>Complete</Pill>}
                              {statusKey !== STATUS.SOMEDAY && <Pill color={COLORS.lavender} onClick={() => updateTask(t.id, { status: STATUS.SOMEDAY })}>Someday</Pill>}
                              {statusKey !== STATUS.ARCHIVED && <Pill color={COLORS.ink} onClick={() => updateTask(t.id, { status: STATUS.ARCHIVED })}>Archive</Pill>}
                              {statusKey !== STATUS.ACTIVE && <Pill color={COLORS.sage} onClick={() => updateTask(t.id, { status: STATUS.ACTIVE })}>Reactivate</Pill>}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* ---------------- CALENDAR TAB ---------------- */}
        {tab === "calendar" && (
          <div className="calendar-tab-grid" style={{ display: "grid", gridTemplateColumns: "300px minmax(0,1fr)", gap: 20 }}>
            {/* Controls */}
            <div className="no-print">
              <div style={cardStyle}>
                <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
                  <select style={inputStyle} value={month} onChange={e => setMonth(Number(e.target.value))}>
                    {MONTHS.map((m, i) => <option key={m} value={i}>{m}</option>)}
                  </select>
                  <input type="number" style={{ ...inputStyle, width: 90 }} value={year} onChange={e => setYear(Number(e.target.value))} />
                </div>

                <label style={labelStyle}>VIEW</label>
                <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>
                  {["year","month","week","day"].map(v => (
                    <Pill key={v} color={COLORS.sage} active={calendarView === v} onClick={() => setCalendarView(v)}>{v[0].toUpperCase()+v.slice(1)}</Pill>
                  ))}
                </div>

                <label style={labelStyle}>FILTER BY CATEGORY</label>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 16 }}>
                  <Pill color={COLORS.ink} active={categoryFilter === "all"} onClick={() => setCategoryFilter("all")}>All</Pill>
                  {categories.map(c => (
                    <Pill key={c.id} color={c.color} active={categoryFilter === c.id} onClick={() => setCategoryFilter(c.id)}>{c.label}</Pill>
                  ))}
                </div>

                <details open style={{ marginBottom: 10 }}>
                  <summary style={{ ...labelStyle, cursor: "pointer" }}>ADD AN EVENT</summary>
                  <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
                    <input type="date" style={{ ...inputStyle, flex: 1.4 }} value={newEvDate} onChange={e => setNewEvDate(e.target.value)} />
                    <input type="time" style={{ ...inputStyle, flex: 1 }} value={newEvTime} onChange={e => setNewEvTime(e.target.value)} title="Optional — leave blank for an all-day event" />
                  </div>
                  <input placeholder="Event name" style={{ ...inputStyle, marginBottom: 6 }} value={newEvLabel} onChange={e => setNewEvLabel(e.target.value)} />
                  <select style={{ ...inputStyle, marginBottom: 6 }} value={newEvCategory} onChange={e => setNewEvCategory(e.target.value)}>
                    {categories.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
                  </select>
                  <label style={labelStyle}>RECURRING</label>
                  <select style={{ ...inputStyle, marginBottom: 8 }} value={newEvRecurring} onChange={e => setNewEvRecurring(e.target.value)}>
                    <option value="none">Does not repeat</option>
                    <option value="daily">Daily</option>
                    <option value="weekly">Weekly</option>
                    <option value="monthly">Monthly</option>
                    <option value="yearly">Yearly</option>
                  </select>
                  <button onClick={addEvent} style={{ width: "100%", background: COLORS.sage, color: "#fff", border: "none", borderRadius: 9, padding: "9px 0", fontFamily: DISPLAY_FONT, cursor: "pointer" }}>Add to calendar</button>
                </details>

                {events.length > 0 && (
                  <div style={{ marginTop: 14, maxHeight: 260, overflowY: "auto" }}>
                    {events.map(ev => (
                      <div key={ev.id} style={{ padding: "6px 0", borderBottom: `1px solid ${COLORS.lavenderLight}` }}>
                        {editingEventId === ev.id ? (
                          <div style={{ padding: "6px 0" }}>
                            <input style={{ ...inputStyle, marginBottom: 6, padding: "6px 8px" }} value={editEvLabel} onChange={e => setEditEvLabel(e.target.value)} placeholder="Event name" />
                            <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
                              <input type="date" style={{ ...inputStyle, flex: 1.4, padding: "6px 8px" }} value={editEvDate} onChange={e => setEditEvDate(e.target.value)} />
                              <input type="time" style={{ ...inputStyle, flex: 1, padding: "6px 8px" }} value={editEvTime} onChange={e => setEditEvTime(e.target.value)} />
                            </div>
                            <select style={{ ...inputStyle, marginBottom: 6, padding: "6px 8px" }} value={editEvCategory} onChange={e => setEditEvCategory(e.target.value)}>
                              {categories.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
                            </select>
                            <select style={{ ...inputStyle, marginBottom: 8, padding: "6px 8px" }} value={editEvRecurring} onChange={e => setEditEvRecurring(e.target.value)}>
                              <option value="none">Does not repeat</option>
                              <option value="daily">Daily</option>
                              <option value="weekly">Weekly</option>
                              <option value="monthly">Monthly</option>
                              <option value="yearly">Yearly</option>
                            </select>
                            <div style={{ display: "flex", gap: 6 }}>
                              <button onClick={saveEditEvent} style={{ flex: 1, background: COLORS.azure, color: "#fff", border: "none", borderRadius: 7, padding: "6px 0", fontSize: 12, cursor: "pointer" }}>Save</button>
                              <button onClick={() => setEditingEventId(null)} style={{ flex: 1, background: "none", border: `1px solid ${COLORS.sage}`, color: COLORS.sage, borderRadius: 7, padding: "6px 0", fontSize: 12, cursor: "pointer" }}>Cancel</button>
                            </div>
                          </div>
                        ) : (
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                            <span style={{ fontSize: 12.5 }}>{ev.label} — {ev.date}{ev.time ? ` at ${ev.time}` : ""}{ev.recurring !== "none" ? ` (${ev.recurring})` : ""}</span>
                            <div style={{ display: "flex", gap: 8 }}>
                              <button onClick={() => startEditEvent(ev)} title="Edit" style={{ background: "none", border: "none", color: COLORS.sage, cursor: "pointer", fontSize: 12 }}>✎</button>
                              <button onClick={() => removeEvent(ev.id)} title="Delete" style={{ background: "none", border: "none", color: COLORS.sage, cursor: "pointer" }}>✕</button>
                            </div>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div style={{ ...cardStyle, marginTop: 14 }}>
                <button onClick={() => setOpenPanel(openPanel === "routines" ? null : "routines")} style={{ width: "100%", textAlign: "left", background: "none", border: "none", cursor: "pointer", fontFamily: DISPLAY_FONT, fontSize: 15, color: COLORS.ink, padding: 0, marginBottom: openPanel === "routines" ? 12 : 0 }}>
                  Routines {routines.length > 0 && `(${routines.length})`} {openPanel === "routines" ? "▾" : "▸"}
                </button>
                {openPanel === "routines" && (
                  <>
                    <p style={{ fontSize: 12, color: COLORS.sage, marginTop: 0, marginBottom: 10 }}>
                      Your daily rhythm and scheduled blocks — class times, deep work, wind-down. Always shown on the Day view; choose separately whether they show on Week and Month.
                    </p>
                    <label style={{ fontSize: 13, display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
                      <input type="checkbox" checked={showRoutinesOnWeek} onChange={() => setShowRoutinesOnWeek(!showRoutinesOnWeek)} /> Show full routine timeline on Week view
                    </label>
                    <label style={{ fontSize: 13, display: "flex", alignItems: "center", gap: 6, marginBottom: 12 }}>
                      <input type="checkbox" checked={showRoutinesOnMonth} onChange={() => setShowRoutinesOnMonth(!showRoutinesOnMonth)} /> Show a small routine indicator on Month view
                    </label>

                    <details style={{ marginBottom: 10 }}>
                      <summary style={{ ...labelStyle, cursor: "pointer" }}>ADD A ROUTINE BLOCK</summary>
                      <label style={labelStyle}>WHICH DAYS</label>
                      <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 8 }}>
                        {WEEK_ORDER.map(d => (
                          <button key={d} type="button" onClick={() => toggleNewRoutineDay(d)} style={{
                            border: `1px solid ${newRoutineWeekdays.includes(d) ? COLORS.sage : COLORS.lavenderLight}`,
                            background: newRoutineWeekdays.includes(d) ? COLORS.sage : "transparent",
                            color: newRoutineWeekdays.includes(d) ? "#fff" : COLORS.ink,
                            borderRadius: 999, width: 34, height: 28, fontSize: 11, fontWeight: 700, cursor: "pointer",
                          }}>{DAY_LABELS[d].slice(0, 2)}</button>
                        ))}
                        <button type="button" onClick={() => setNewRoutineWeekdays(newRoutineWeekdays.length === 7 ? [] : [...WEEK_ORDER])} style={{
                          border: `1px solid ${COLORS.lavender}`, background: "transparent", color: COLORS.sage,
                          borderRadius: 999, padding: "0 10px", height: 28, fontSize: 11, fontWeight: 600, cursor: "pointer",
                        }}>{newRoutineWeekdays.length === 7 ? "Clear" : "Every day"}</button>
                      </div>
                      <input placeholder="Routine name (e.g. Deep Work Block)" style={{ ...inputStyle, marginBottom: 6 }} value={newRoutineLabel} onChange={e => setNewRoutineLabel(e.target.value)} />
                      <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
                        <div style={{ flex: 1 }}>
                          <label style={labelStyle}>START (OPTIONAL)</label>
                          <input type="time" style={inputStyle} value={newRoutineStart} onChange={e => setNewRoutineStart(e.target.value)} />
                        </div>
                        <div style={{ flex: 1 }}>
                          <label style={labelStyle}>END (OPTIONAL)</label>
                          <input type="time" style={inputStyle} value={newRoutineEnd} onChange={e => setNewRoutineEnd(e.target.value)} />
                        </div>
                      </div>

                      <label style={labelStyle}>WHAT HAPPENS DURING THIS ROUTINE (OPTIONAL)</label>
                      {newRoutineItems.length > 0 && (
                        <div style={{ marginBottom: 6 }}>
                          {newRoutineItems.map(it => (
                            <div key={it.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "3px 0" }}>
                              <span style={{ fontSize: 12 }}>{it.time ? `${it.time} — ` : ""}{it.label}</span>
                              <button onClick={() => removeNewRoutineItem(it.id)} style={{ background: "none", border: "none", color: COLORS.sage, cursor: "pointer", fontSize: 12 }}>✕</button>
                            </div>
                          ))}
                        </div>
                      )}
                      <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
                        <input placeholder="e.g. Stretch, Class, Breakfast" style={{ ...inputStyle, flex: 1.6, padding: "7px 9px" }} value={newItemLabel} onChange={e => setNewItemLabel(e.target.value)} onKeyDown={e => e.key === "Enter" && (e.preventDefault(), addNewRoutineItem())} />
                        <input type="time" style={{ ...inputStyle, flex: 1, padding: "7px 9px" }} value={newItemTime} onChange={e => setNewItemTime(e.target.value)} />
                        <button type="button" onClick={addNewRoutineItem} style={{ background: COLORS.lavender, color: "#fff", border: "none", borderRadius: 8, padding: "0 12px", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>+</button>
                      </div>

                      <button onClick={addRoutine} disabled={newRoutineWeekdays.length === 0 || !newRoutineLabel.trim()} style={{
                        width: "100%", background: COLORS.sage, color: "#fff", border: "none", borderRadius: 9, padding: "9px 0",
                        fontFamily: DISPLAY_FONT, cursor: "pointer", opacity: (newRoutineWeekdays.length === 0 || !newRoutineLabel.trim()) ? 0.5 : 1,
                      }}>Add routine block</button>
                    </details>

                    {routines.length > 0 && (
                      <div style={{ maxHeight: 300, overflowY: "auto" }}>
                        {routines.map(normalizeRoutine).map(r => (
                          <div key={r.id} style={{ padding: "6px 0", borderBottom: `1px solid ${COLORS.lavenderLight}` }}>
                            {editingRoutineId === r.id ? (
                              <div style={{ padding: "4px 0" }}>
                                <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 8 }}>
                                  {WEEK_ORDER.map(d => (
                                    <button key={d} type="button" onClick={() => toggleEditRoutineDay(d)} style={{
                                      border: `1px solid ${editRoutineWeekdays.includes(d) ? COLORS.sage : COLORS.lavenderLight}`,
                                      background: editRoutineWeekdays.includes(d) ? COLORS.sage : "transparent",
                                      color: editRoutineWeekdays.includes(d) ? "#fff" : COLORS.ink,
                                      borderRadius: 999, width: 32, height: 26, fontSize: 10.5, fontWeight: 700, cursor: "pointer",
                                    }}>{DAY_LABELS[d].slice(0, 2)}</button>
                                  ))}
                                  <button type="button" onClick={() => setEditRoutineWeekdays(editRoutineWeekdays.length === 7 ? [] : [...WEEK_ORDER])} style={{
                                    border: `1px solid ${COLORS.lavender}`, background: "transparent", color: COLORS.sage,
                                    borderRadius: 999, padding: "0 8px", height: 26, fontSize: 10.5, fontWeight: 600, cursor: "pointer",
                                  }}>{editRoutineWeekdays.length === 7 ? "Clear" : "Every day"}</button>
                                </div>
                                <input style={{ ...inputStyle, marginBottom: 6, padding: "6px 8px" }} value={editRoutineLabel} onChange={e => setEditRoutineLabel(e.target.value)} />
                                <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
                                  <input type="time" style={{ ...inputStyle, padding: "6px 8px" }} value={editRoutineStart} onChange={e => setEditRoutineStart(e.target.value)} />
                                  <input type="time" style={{ ...inputStyle, padding: "6px 8px" }} value={editRoutineEnd} onChange={e => setEditRoutineEnd(e.target.value)} />
                                </div>
                                <label style={{ ...labelStyle, fontSize: 10 }}>WHAT HAPPENS DURING THIS ROUTINE</label>
                                {editRoutineItems.length > 0 && (
                                  <div style={{ marginBottom: 6 }}>
                                    {editRoutineItems.map(it => (
                                      <div key={it.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "3px 0" }}>
                                        <span style={{ fontSize: 12 }}>{it.time ? `${it.time} — ` : ""}{it.label}</span>
                                        <button onClick={() => removeEditRoutineItem(it.id)} style={{ background: "none", border: "none", color: COLORS.sage, cursor: "pointer", fontSize: 12 }}>✕</button>
                                      </div>
                                    ))}
                                  </div>
                                )}
                                <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
                                  <input placeholder="e.g. Stretch, Class, Breakfast" style={{ ...inputStyle, flex: 1.6, padding: "6px 8px" }} value={editItemLabel} onChange={e => setEditItemLabel(e.target.value)} onKeyDown={e => e.key === "Enter" && (e.preventDefault(), addEditRoutineItem())} />
                                  <input type="time" style={{ ...inputStyle, flex: 1, padding: "6px 8px" }} value={editItemTime} onChange={e => setEditItemTime(e.target.value)} />
                                  <button type="button" onClick={addEditRoutineItem} style={{ background: COLORS.lavender, color: "#fff", border: "none", borderRadius: 8, padding: "0 12px", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>+</button>
                                </div>
                                <div style={{ display: "flex", gap: 6 }}>
                                  <button onClick={saveEditRoutine} style={{ flex: 1, background: COLORS.azure, color: "#fff", border: "none", borderRadius: 7, padding: "6px 0", fontSize: 12, cursor: "pointer" }}>Save</button>
                                  <button onClick={() => setEditingRoutineId(null)} style={{ flex: 1, background: "none", border: `1px solid ${COLORS.sage}`, color: COLORS.sage, borderRadius: 7, padding: "6px 0", fontSize: 12, cursor: "pointer" }}>Cancel</button>
                                </div>
                              </div>
                            ) : (
                              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                                <div style={{ minWidth: 0 }}>
                                  <div style={{ fontSize: 12.5, color: COLORS.ink }}>
                                    {r.startTime ? `${r.startTime}${r.endTime ? `–${r.endTime}` : ""} — ` : ""}{r.label}
                                  </div>
                                  <div style={{ fontSize: 10.5, color: COLORS.sage, marginTop: 1 }}>
                                    {weekdaysLabel(r.weekdays)}{r.items?.length > 0 ? ` · ${r.items.length} item${r.items.length === 1 ? "" : "s"}` : ""}
                                  </div>
                                </div>
                                <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
                                  <button onClick={() => startEditRoutine(r)} title="Edit" style={{ background: "none", border: "none", color: COLORS.sage, cursor: "pointer", fontSize: 12 }}>✎</button>
                                  <button onClick={() => removeRoutine(r.id)} title="Delete" style={{ background: "none", border: "none", color: COLORS.sage, cursor: "pointer" }}>✕</button>
                                </div>
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>

              <div style={{ ...cardStyle, marginTop: 14 }}>
                <button onClick={() => setOpenPanel(openPanel === "cycle" ? null : "cycle")} style={{ width: "100%", textAlign: "left", background: "none", border: "none", cursor: "pointer", fontFamily: DISPLAY_FONT, fontSize: 15, color: COLORS.ink, padding: 0, marginBottom: openPanel === "cycle" ? 12 : 0 }}>
                  Moon &amp; cycle {openPanel === "cycle" ? "▾" : "▸"}
                </button>
                {openPanel === "cycle" && (
                  <>
                    <div style={{ display: "flex", gap: 10, marginBottom: 8 }}>
                      <label style={{ fontSize: 13, display: "flex", alignItems: "center", gap: 6 }}>
                        <input type="checkbox" checked={showMoon} onChange={() => setShowMoon(!showMoon)} /> Moon phases
                      </label>
                    </div>
                    <label style={{ fontSize: 13, display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
                      <input type="checkbox" checked={showCycle} onChange={() => setShowCycle(!showCycle)} /> My cycle phases
                    </label>
                    {showCycle && (
                      <>
                        <div style={{
                          fontSize: 11.5, marginBottom: 10, padding: "8px 10px", borderRadius: 8,
                          background: cycleSyncError ? "#faf0ee" : "#f3f7f5",
                          color: cycleSyncError ? "#a8677a" : COLORS.sage,
                        }}>
                          {cycleSyncError
                            ? "Couldn't reach your Lunar & Cycle app — showing the last synced values."
                            : cycleNotSetUp
                              ? "Your Lunar & Cycle app hasn't been set up yet — nothing to sync."
                              : cycleSynced
                                ? "Synced from your Lunar & Cycle app."
                                : "Syncing…"}
                        </div>
                        <label style={labelStyle}>FIRST DAY OF LAST PERIOD</label>
                        <input type="date" disabled style={{ ...inputStyle, marginBottom: 10, background: COLORS.cream, color: COLORS.sage, cursor: "not-allowed" }} value={cycleStart} />
                        <label style={labelStyle}>CYCLE LENGTH (DAYS)</label>
                        <input type="number" disabled style={{ ...inputStyle, marginBottom: 10, background: COLORS.cream, color: COLORS.sage, cursor: "not-allowed" }} value={cycleLength} />
                        <label style={labelStyle}>PERIOD LENGTH (DAYS)</label>
                        <input type="number" disabled style={{ ...inputStyle, marginBottom: 10, background: COLORS.cream, color: COLORS.sage, cursor: "not-allowed" }} value={periodLength} />
                        <a href={LUNAR_APP_URL} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12, color: COLORS.azure, fontWeight: 600, textDecoration: "none" }}>
                          Edit cycle dates in the Lunar &amp; Cycle app →
                        </a>
                        <label style={{ fontSize: 13, display: "flex", alignItems: "center", gap: 6, marginTop: 12 }}>
                          <input type="checkbox" checked={showEnergy} onChange={() => setShowEnergy(!showEnergy)} /> Suggest low-energy days for admin, not deep work
                        </label>
                      </>
                    )}
                  </>
                )}
              </div>

              <div style={{ ...cardStyle, marginTop: 14 }}>
                <button onClick={() => setShowQuotePanel(!showQuotePanel)} style={{ width: "100%", textAlign: "left", background: "none", border: "none", cursor: "pointer", fontFamily: DISPLAY_FONT, fontSize: 15, color: COLORS.ink, padding: 0, marginBottom: showQuotePanel ? 12 : 0 }}>
                  Quotes &amp; headlines {showQuotePanel ? "▾" : "▸"}
                </button>
                {showQuotePanel && (
                  <>
                    <label style={labelStyle}>ADD ONE</label>
                    <input style={{ ...inputStyle, marginBottom: 6 }} placeholder="Quote or headline" value={newQuoteText} onChange={e => setNewQuoteText(e.target.value)} />
                    <input style={{ ...inputStyle, marginBottom: 6 }} placeholder="Author (optional)" value={newQuoteAuthor} onChange={e => setNewQuoteAuthor(e.target.value)} />
                    <button onClick={addQuote} style={{ width: "100%", background: themeAccent, color: "#fff", border: "none", borderRadius: 9, padding: "8px 0", fontFamily: BODY_FONT, fontWeight: 600, cursor: "pointer", marginBottom: 14 }}>Add &amp; use</button>

                    <label style={labelStyle}>IMPORT MULTIPLE</label>
                    <p style={{ fontSize: 11, color: COLORS.sage, margin: "0 0 6px" }}>One per line: "Quote text — Author"</p>
                    <textarea
                      style={{ ...inputStyle, marginBottom: 6, minHeight: 70, fontFamily: BODY_FONT, resize: "vertical" }}
                      value={importQuotesText}
                      onChange={e => setImportQuotesText(e.target.value)}
                      placeholder={"Small changes equal big results — Tulsi & Grace\nAnother favorite line — Author"}
                    />
                    <button onClick={importQuotes} style={{ width: "100%", background: "none", border: `1px solid ${themeAccent}`, color: themeAccent, borderRadius: 9, padding: "8px 0", fontFamily: BODY_FONT, fontWeight: 600, cursor: "pointer", marginBottom: 14 }}>Import list</button>

                    {savedQuotes.length > 0 && (
                      <div style={{ maxHeight: 160, overflowY: "auto" }}>
                        <label style={labelStyle}>SAVED — TAP TO USE</label>
                        {savedQuotes.map(q => (
                          <div key={q.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6, padding: "6px 0", borderBottom: `1px solid ${COLORS.lavenderLight}` }}>
                            <button onClick={() => useQuote(q)} style={{ background: "none", border: "none", textAlign: "left", cursor: "pointer", fontSize: 12, color: quote === q.text ? themeAccent : COLORS.ink, fontWeight: quote === q.text ? 700 : 400, flex: 1 }}>
                              "{q.text}" — {q.author}
                            </button>
                            <button onClick={() => removeQuote(q.id)} style={{ background: "none", border: "none", color: COLORS.sage, cursor: "pointer" }}>✕</button>
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>

              <div style={{ ...cardStyle, marginTop: 14 }}>
                <button onClick={() => setShowCustomize(!showCustomize)} style={{ width: "100%", textAlign: "left", background: "none", border: "none", cursor: "pointer", fontFamily: DISPLAY_FONT, fontSize: 15, color: COLORS.ink, padding: 0, marginBottom: showCustomize ? 12 : 0 }}>
                  Customize calendar {showCustomize ? "▾" : "▸"}
                </button>
                {showCustomize && (
                  <>
                    <label style={labelStyle}>BACKGROUND COLOR</label>
                    <div style={{ display: "flex", gap: 8, marginBottom: 10, alignItems: "center" }}>
                      <input type="color" value={themeBg} onChange={e => setThemeBg(e.target.value)} style={{ width: 40, height: 32, border: "none", padding: 0, background: "none" }} />
                      <input style={{ ...inputStyle, flex: 1 }} value={themeBg} onChange={e => setThemeBg(e.target.value)} />
                    </div>
                    <label style={labelStyle}>ACCENT COLOR</label>
                    <div style={{ display: "flex", gap: 8, marginBottom: 10, alignItems: "center" }}>
                      <input type="color" value={themeAccent} onChange={e => setThemeAccent(e.target.value)} style={{ width: 40, height: 32, border: "none", padding: 0, background: "none" }} />
                      <input style={{ ...inputStyle, flex: 1 }} value={themeAccent} onChange={e => setThemeAccent(e.target.value)} />
                    </div>
                    <label style={labelStyle}>HIGHLIGHT COLOR</label>
                    <div style={{ display: "flex", gap: 8, marginBottom: 12, alignItems: "center" }}>
                      <input type="color" value={themeHighlight} onChange={e => setThemeHighlight(e.target.value)} style={{ width: 40, height: 32, border: "none", padding: 0, background: "none" }} />
                      <input style={{ ...inputStyle, flex: 1 }} value={themeHighlight} onChange={e => setThemeHighlight(e.target.value)} />
                    </div>
                    <button onClick={resetTheme} style={{ background: "none", border: "none", color: COLORS.sage, fontFamily: BODY_FONT, fontWeight: 600, cursor: "pointer", padding: 0, fontSize: 13 }}>
                      Reset to brand default
                    </button>
                  </>
                )}
              </div>

              <div style={{ ...cardStyle, marginTop: 14 }}>
                <div style={{ fontFamily: DISPLAY_FONT, fontSize: 15, color: COLORS.ink, marginBottom: 10 }}>Backup &amp; restore</div>
                <p style={{ fontSize: 11.5, color: COLORS.sage, marginTop: 0, marginBottom: 10 }}>
                  Everything — inbox, tasks, categories, calendar events, quotes — in one file you can keep as insurance.
                </p>
                <button onClick={exportDataJSON} style={{ width: "100%", background: COLORS.sage, color: "#fff", border: "none", borderRadius: 9, padding: "9px 0", fontFamily: BODY_FONT, fontWeight: 600, cursor: "pointer", marginBottom: 8 }}>
                  Export backup (JSON)
                </button>
                <input ref={importFileRef} type="file" accept="application/json" onChange={handleImportFile} style={{ display: "none" }} />
                <button onClick={() => importFileRef.current?.click()} style={{ width: "100%", background: "none", border: `1px solid ${COLORS.sage}`, color: COLORS.sage, borderRadius: 9, padding: "9px 0", fontFamily: BODY_FONT, fontWeight: 600, cursor: "pointer" }}>
                  Restore from backup file
                </button>
                {importStatus === "confirm" && (
                  <div style={{ marginTop: 10, background: "#faf6f2", border: `1px solid ${COLORS.lavenderLight}`, borderRadius: 9, padding: 10 }}>
                    <p style={{ fontSize: 12, color: COLORS.ink, margin: "0 0 8px" }}>
                      This will replace your current inbox, tasks, categories, events, and quotes with what's in this backup file. Continue?
                    </p>
                    <div style={{ display: "flex", gap: 8 }}>
                      <button onClick={confirmImport} style={{ flex: 1, background: COLORS.azure, color: "#fff", border: "none", borderRadius: 8, padding: "7px 0", fontFamily: BODY_FONT, fontWeight: 600, cursor: "pointer", fontSize: 12.5 }}>Restore</button>
                      <button onClick={cancelImport} style={{ flex: 1, background: "none", border: `1px solid ${COLORS.sage}`, color: COLORS.sage, borderRadius: 8, padding: "7px 0", fontFamily: BODY_FONT, cursor: "pointer", fontSize: 12.5 }}>Cancel</button>
                    </div>
                  </div>
                )}
                {importStatus === "done" && <p style={{ fontSize: 12, color: COLORS.azure, marginTop: 8, marginBottom: 0 }}>Restored from backup.</p>}
                {importStatus === "error" && <p style={{ fontSize: 12, color: "#a8677a", marginTop: 8, marginBottom: 0 }}>That file couldn't be read as a backup.</p>}
              </div>

              <button onClick={downloadPDF} disabled={downloadingPdf} style={{
                width: "100%", marginTop: 14, padding: 14, background: themeHighlight, color: "#fff",
                border: "none", borderRadius: 12, fontFamily: DISPLAY_FONT, fontSize: 16, cursor: downloadingPdf ? "wait" : "pointer",
                opacity: downloadingPdf ? 0.7 : 1,
              }}>{downloadingPdf ? "Preparing PDF…" : "Download as PDF"}</button>

              <button onClick={handlePrint} style={{
                width: "100%", marginTop: 8, padding: 8, background: "none", color: themeHighlight,
                border: "none", fontFamily: BODY_FONT, fontSize: 12.5, cursor: "pointer", textDecoration: "underline",
              }}>Or open your browser's print dialog instead</button>

              <button onClick={downloadSVG} style={{
                width: "100%", marginTop: 10, padding: 14, background: "transparent", color: themeHighlight,
                border: `1.5px solid ${themeHighlight}`, borderRadius: 12, fontFamily: DISPLAY_FONT, fontSize: 16, cursor: "pointer",
              }}>Download {calendarView[0].toUpperCase()+calendarView.slice(1)} View as SVG</button>
            </div>

            {/* Preview */}
            <div ref={printRef} className="print-area" style={{ background: themeBg, borderRadius: 16, padding: 28, boxShadow: "0 10px 30px rgba(0,0,0,0.06)" }}>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", marginBottom: 18, gap: 6 }}>
                <h2 style={{ fontFamily: DISPLAY_FONT, fontWeight: 600, fontSize: 30, margin: 0, color: COLORS.ink }}>
                  {calendarView === "year" ? year : `${MONTHS[month].toUpperCase()} ${year}`}
                </h2>
                {quote && (
                  <p style={{ fontStyle: "italic", fontSize: 12.5, color: COLORS.sage, maxWidth: 460, margin: 0 }}>
                    "{quote}" — {author}
                  </p>
                )}
              </div>

              {calendarView !== "year" && (
                <div className="no-print" style={{ display: "flex", justifyContent: "center", gap: 14, flexWrap: "wrap", marginBottom: 16, fontSize: 11, color: COLORS.sage }}>
                  {categories.map(c => (
                    <span key={c.id} style={{ display: "flex", alignItems: "center", gap: 5 }}>
                      <span style={{ width: 8, height: 8, borderRadius: "50%", background: c.color, display: "inline-block" }} />
                      {c.label}
                    </span>
                  ))}
                </div>
              )}

              {calendarView === "year" && (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16 }}>
                  {MONTHS.map((mName, mi) => {
                    const grid = getMonthGrid(year, mi);
                    return (
                      <div key={mName} style={{ border: `1px solid ${COLORS.lavenderLight}`, borderRadius: 10, padding: 10 }}>
                        <button
                          onClick={() => { setMonth(mi); setCalendarView("month"); }}
                          style={{ background: "none", border: "none", cursor: "pointer", padding: 0, marginBottom: 6, fontFamily: DISPLAY_FONT, fontSize: 14, color: COLORS.ink, fontWeight: 600 }}
                        >
                          {mName}
                        </button>
                        <table style={{ borderCollapse: "collapse", width: "100%" }}>
                          <thead>
                            <tr>
                              {WEEK_ORDER.map(d => (
                                <th key={d} style={{ fontSize: 7, color: COLORS.sage, fontWeight: 600, padding: 1 }}>{d[0]}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {grid.map((week, wi) => (
                              <tr key={wi}>
                                {week.map((day, di) => {
                                  const key = day ? `${year}-${pad(mi+1)}-${pad(day)}` : null;
                                  const hasItems = key && itemsByDateForYear[key] && itemsByDateForYear[key].length > 0;
                                  const isHoliday = day && includeHolidays && US_HOLIDAYS_2026[`${year}-${pad(mi+1)}-${pad(day)}`];
                                  return (
                                    <td key={di} style={{ fontSize: 8.5, textAlign: "center", padding: 2, color: COLORS.ink, position: "relative" }}>
                                      {day || ""}
                                      {(hasItems || isHoliday) && (
                                        <div style={{ width: 3, height: 3, borderRadius: "50%", background: hasItems ? (itemsByDateForYear[key][0].category ? categoryById(itemsByDateForYear[key][0].category)?.color : COLORS.ink) : COLORS.lavender, margin: "1px auto 0" }} />
                                      )}
                                    </td>
                                  );
                                })}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    );
                  })}
                </div>
              )}

              {calendarView === "month" && (
                <table style={{ borderCollapse: "collapse", width: "100%", tableLayout: "fixed" }}>
                  <thead>
                    <tr>
                      {orderedWeekDays.map(d => (
                        <th key={d} style={{ border: `1px solid ${COLORS.ink}`, padding: 7, fontSize: 10.5, letterSpacing: 0.5, color: COLORS.ink, background: themeBg }}>
                          {DAY_LABELS[d].toUpperCase()}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rotatedWeeks.map((week, wi) => (
                      <tr key={wi}>
                        {week.map((day, di) => {
                          const dateObj = day ? new Date(year, month, day) : null;
                          const key = day ? `${year}-${pad(month+1)}-${pad(day)}` : null;
                          const moon = day && showMoon ? moonPhase(dateObj) : null;
                          const cycle = day && showCycle && cycleStart ? cyclePhaseForDate(dateObj, cycleStart, cycleLength, periodLength) : null;
                          const holidays = day ? holidayLabelsFor(day) : [];
                          const dayItems = key ? (itemsByDate[key] || []) : [];
                          const lowEnergy = showEnergy && cycle && (cycle.energy === "low" || cycle.energy === "falling");
                          const dominantCat = dayItems.find(it => it.category) ? categoryById(dayItems.find(it => it.category).category) : null;
                          const dayRoutineCount = showRoutinesOnMonth && day ? routinesForWeekday(weekdayCodeFor(dateObj)).length : 0;
                          return (
                            <td key={di} onClick={() => day && setSelectedDay(day)} style={{
                              border: `1px solid ${COLORS.lavenderLight}`, height: 96, verticalAlign: "top", padding: "6px 6px 6px 9px",
                              position: "relative", cursor: day ? "pointer" : "default",
                              background: lowEnergy ? "#faf6f2" : "transparent",
                              borderLeft: dominantCat ? `4px solid ${dominantCat.color}` : `1px solid ${COLORS.lavenderLight}`,
                            }}>
                              {day && (
                                <>
                                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, fontWeight: 600, color: COLORS.ink }}>
                                    <span>{day}</span>
                                    <span style={{ display: "flex", gap: 4, alignItems: "center" }}>
                                      {dayRoutineCount > 0 && (
                                        <span title={`${dayRoutineCount} routine block${dayRoutineCount === 1 ? "" : "s"}`} style={{ fontSize: 8.5, color: COLORS.lavender, fontWeight: 700 }}>
                                          ↻{dayRoutineCount}
                                        </span>
                                      )}
                                      {moon && ["New Moon","First Quarter","Full Moon","Last Quarter"].includes(moon.label) && (
                                        <span title={moon.label} style={{ color: COLORS.azure }}>{moon.symbol}</span>
                                      )}
                                    </span>
                                  </div>
                                  {holidays.map((l, li) => <div key={li} style={{ fontSize: 8.5, color: COLORS.sage, marginTop: 2 }}>{l}</div>)}
                                  {dayItems.slice(0, 2).map((it, ii) => {
                                    const cat = it.category ? categoryById(it.category) : null;
                                    return (
                                      <div key={ii} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 8.5, marginTop: 2, color: COLORS.ink, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                        <span style={{ width: 6, height: 6, borderRadius: "50%", background: cat ? cat.color : COLORS.ink, flexShrink: 0 }} />
                                        {it.label}
                                      </div>
                                    );
                                  })}
                                  {dayItems.length > 2 && <div style={{ fontSize: 8, color: COLORS.sage }}>+{dayItems.length - 2} more</div>}
                                  {cycle && (
                                    <div style={{ position: "absolute", bottom: 4, left: 6, fontSize: 7.5, letterSpacing: 0.4, color: COLORS.sage, fontWeight: 600 }}>
                                      {cycle.phase.toUpperCase()}
                                    </div>
                                  )}
                                </>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              {calendarView !== "month" && (
                <div>
                  <div className="no-print" style={{ display: "flex", gap: 8, marginBottom: 14, alignItems: "center" }}>
                    <label style={{ fontSize: 12, color: COLORS.sage, fontWeight: 600 }}>DAY</label>
                    <input type="number" min={1} max={31} style={{ ...inputStyle, width: 70 }} value={selectedDay} onChange={e => setSelectedDay(Number(e.target.value))} />
                  </div>
                  {calendarView === "day" && (() => {
                    const key = `${year}-${pad(month+1)}-${pad(selectedDay)}`;
                    const dateObj = new Date(year, month, selectedDay);
                    const cycle = showCycle && cycleStart ? cyclePhaseForDate(dateObj, cycleStart, cycleLength, periodLength) : null;
                    const dayItems = itemsByDate[key] || [];
                    const dayRoutines = routinesForWeekday(weekdayCodeFor(dateObj));
                    const hourList = Array.from({ length: GRID_HOUR_END - GRID_HOUR_START }, (_, i) => GRID_HOUR_START + i);
                    return (
                      <div>
                        <div style={{ fontFamily: DISPLAY_FONT, fontSize: 22, marginBottom: 4, color: COLORS.ink }}>{MONTHS[month]} {selectedDay}</div>
                        {cycle && <div style={{ fontSize: 12, color: COLORS.sage, marginBottom: 14 }}>{cycle.phase} phase · {cycle.energy} energy</div>}
                        <div style={{ display: "flex", gap: 10 }}>
                          <div style={{ width: 46, flexShrink: 0 }}>
                            {hourList.map(h => (
                              <div key={h} style={{ height: GRID_PX_PER_HOUR, fontSize: 10, color: COLORS.sage, transform: "translateY(-6px)" }}>
                                {formatHourLabel(h)}
                              </div>
                            ))}
                          </div>
                          <div style={{ flex: 1 }}>
                            <HourGridColumn routines={dayRoutines} items={dayItems} categoryById={categoryById} compact={false} />
                          </div>
                        </div>
                      </div>
                    );
                  })()}
                  {calendarView === "week" && (() => {
                    const anchor = new Date(year, month, selectedDay);
                    const anchorDow = (anchor.getDay() + 6) % 7;
                    const weekDates = Array.from({length:7}, (_,i) => {
                      const d = new Date(anchor); d.setDate(anchor.getDate() - anchorDow + i); return d;
                    });
                    const hourList = Array.from({ length: GRID_HOUR_END - GRID_HOUR_START }, (_, i) => GRID_HOUR_START + i);
                    return (
                      <div style={{ display: "flex", gap: 6 }}>
                        <div style={{ width: 38, flexShrink: 0, paddingTop: 24 }}>
                          {hourList.map(h => (
                            <div key={h} style={{ height: GRID_PX_PER_HOUR, fontSize: 8.5, color: COLORS.sage, transform: "translateY(-5px)" }}>
                              {formatHourLabel(h)}
                            </div>
                          ))}
                        </div>
                        <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 6, flex: 1 }}>
                          {weekDates.map((d, i) => {
                            const key = toKey(d);
                            const cycle = showCycle && cycleStart ? cyclePhaseForDate(d, cycleStart, cycleLength, periodLength) : null;
                            const dayItems = itemsByDate[key] || [];
                            const dayRoutines = showRoutinesOnWeek ? routinesForWeekday(weekdayCodeFor(d)) : [];
                            return (
                              <div key={i}>
                                <div style={{ fontSize: 10.5, fontWeight: 700, color: COLORS.ink }}>{DAY_LABELS[WEEK_ORDER[i]].slice(0,3).toUpperCase()} {d.getDate()}</div>
                                {cycle && <div style={{ fontSize: 8, color: COLORS.sage, marginBottom: 2 }}>{cycle.phase}</div>}
                                <HourGridColumn routines={dayRoutines} items={dayItems} categoryById={categoryById} compact={true} />
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })()}
                </div>
              )}

              <div style={{ marginTop: 18, fontSize: 9.5, color: COLORS.sage, letterSpacing: 0.5, fontFamily: DATA_FONT, textAlign: "center" }}>
                TULSIANDGRACE.COM
              </div>
            </div>
          </div>
        )}

        </>
        )}

        {undoState && (
          <div className="no-print" style={{
            position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)",
            background: COLORS.ink, color: "#fff", borderRadius: 12, padding: "12px 16px",
            display: "flex", alignItems: "center", gap: 14, boxShadow: "0 10px 30px rgba(0,0,0,0.25)",
            zIndex: 1000, fontFamily: BODY_FONT, fontSize: 14,
          }}>
            <span>{undoState.message}</span>
            <button onClick={performUndo} style={{
              background: "none", border: "none", color: COLORS.lavenderLight, fontWeight: 700,
              cursor: "pointer", fontFamily: BODY_FONT, fontSize: 14, textDecoration: "underline",
            }}>Undo</button>
          </div>
        )}
      </div>
    </div>
  );
}
