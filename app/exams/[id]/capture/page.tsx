"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ErrorState } from "@/components/workflow";

interface Student {
  id: string;
  rollNo: string;
  name: string;
  answerSheets: Array<{ id: string; status: string; _count: { pages: number } }>;
}
interface Page {
  id: string;
  pageNo: number;
  qcFlags: string[];
  rotation: number;
}

const QC_LABEL: Record<string, string> = {
  blur: "Blurry",
  "low-resolution": "Low res",
  "possibly-blank": "Possibly blank",
  "duplicate-suspected": "Duplicate?",
  "qc-failed": "QC failed",
};

export default function CapturePage({ params }: { params: Promise<{ id: string }> }) {
  const [examId, setExamId] = useState<string | null>(null);
  const [students, setStudents] = useState<Student[]>([]);
  const [activeStudent, setActiveStudent] = useState<Student | null>(null);
  const [sheetId, setSheetId] = useState<string | null>(null);
  const [pages, setPages] = useState<Page[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [newRoll, setNewRoll] = useState("");
  const [newName, setNewName] = useState("");
  const [camOn, setCamOn] = useState(false);
  const [camError, setCamError] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    void params.then((p) => setExamId(p.id));
  }, [params]);

  const loadStudents = useCallback(async () => {
    if (!examId) return;
    const res = await fetch(`/api/exams/${examId}/students`);
    const json = await res.json();
    if (res.ok) setStudents(json.students);
    else setError(json.error ?? "Could not load students");
  }, [examId]);

  const loadSheet = useCallback(async (sid: string) => {
    const res = await fetch(`/api/sheets/${sid}`);
    const json = await res.json();
    if (res.ok) {
      setSheetId(json.sheet.id);
      setPages(json.sheet.pages);
    }
  }, []);

  useEffect(() => {
    void loadStudents();
  }, [loadStudents]);

  async function ensureSheet(student: Student): Promise<string | null> {
    const existing = student.answerSheets[0];
    if (existing) {
      setSheetId(existing.id);
      await loadSheet(existing.id);
      return existing.id;
    }
    const res = await fetch(`/api/exams/${examId}/sheets`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ studentId: student.id }),
    });
    const json = await res.json();
    if (!res.ok) {
      setError(json.error ?? "Could not create sheet");
      return null;
    }
    setSheetId(json.sheet.id);
    setPages([]);
    await loadStudents();
    return json.sheet.id;
  }

  function selectStudent(s: Student) {
    setActiveStudent(s);
    setPages([]);
    setSheetId(null);
    void ensureSheet(s);
  }

  async function addStudent() {
    if (!examId || !newRoll.trim() || !newName.trim()) return;
    const res = await fetch(`/api/exams/${examId}/students`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ students: [{ rollNo: newRoll.trim(), name: newName.trim() }] }),
    });
    const json = await res.json();
    if (!res.ok) {
      setError(json.error ?? "Could not add student");
      return;
    }
    setNewRoll("");
    setNewName("");
    await loadStudents();
    selectStudent(json.students[0]);
  }

  async function startCamera() {
    setCamError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment", width: { ideal: 1920 } },
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setCamOn(true);
    } catch {
      setCamError("Could not access the camera. Check browser permissions or use file upload.");
    }
  }

  function stopCamera() {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setCamOn(false);
  }

  useEffect(() => () => stopCamera(), []);

  async function uploadBlob(blob: Blob) {
    if (!sheetId) {
      setError("Select a student first");
      return;
    }
    setCapturing(true);
    try {
      const form = new FormData();
      form.append("file", blob, "capture.jpg");
      const res = await fetch(`/api/sheets/${sheetId}/pages`, { method: "POST", body: form });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? "Capture failed");
        return;
      }
      setPages((p) => [...p, json.page]);
    } catch {
      setError("Network error during capture");
    } finally {
      setCapturing(false);
    }
  }

  function capture() {
    const video = videoRef.current;
    if (!video || video.videoWidth === 0) return;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d")?.drawImage(video, 0, 0);
    canvas.toBlob((b) => b && void uploadBlob(b), "image/jpeg", 0.9);
  }

  async function movePage(page: Page, dir: -1 | 1) {
    if (!sheetId) return;
    const res = await fetch(`/api/sheets/${sheetId}/pages/${page.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pageNo: page.pageNo + dir }),
    });
    if (res.ok && sheetId) await loadSheet(sheetId);
  }

  async function deletePage(page: Page) {
    if (!sheetId || !window.confirm(`Delete page ${page.pageNo}?`)) return;
    const res = await fetch(`/api/sheets/${sheetId}/pages/${page.id}`, { method: "DELETE" });
    if (res.ok && sheetId) await loadSheet(sheetId);
  }

  async function rotatePage(page: Page) {
    if (!sheetId) return;
    const res = await fetch(`/api/sheets/${sheetId}/pages/${page.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rotation: (page.rotation + 90) % 360 }),
    });
    if (res.ok && sheetId) await loadSheet(sheetId);
  }

  const filtered = students.filter(
    (s) =>
      s.rollNo.toLowerCase().includes(search.toLowerCase()) ||
      s.name.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <header className="mb-6">
        <Link href={examId ? `/exams/${examId}` : "/"} className="text-xs text-foreground/60 hover:text-foreground">
          &larr; Exam overview
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Capture answer sheets</h1>
        <p className="mt-1 text-sm text-foreground/60">
          Pick a student, capture each page with the camera. Pages keep their order; nothing is auto-deleted.
        </p>
      </header>

      {error && (
        <div className="mb-4">
          <ErrorState message={error} onRetry={() => setError(null)} />
        </div>
      )}

      <div className="flex gap-6">
        {/* Students */}
        <aside className="w-72 shrink-0">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search roll no or name"
            className="mb-3 w-full rounded-[var(--radius-sm)] border border-border bg-background px-3 py-2 text-sm focus:border-accent focus:outline-none"
            aria-label="Search students"
          />
          <ul className="max-h-[60vh] space-y-1 overflow-y-auto">
            {filtered.map((s) => (
              <li key={s.id}>
                <button
                  onClick={() => selectStudent(s)}
                  className={[
                    "w-full rounded-[var(--radius-sm)] px-3 py-2 text-left text-sm",
                    activeStudent?.id === s.id ? "bg-accent-soft font-medium" : "hover:bg-surface-muted",
                  ].join(" ")}
                >
                  <span className="mark font-semibold">{s.rollNo}</span>
                  <span className="ml-2 text-foreground/70">{s.name}</span>
                  <span className="ml-2 text-xs text-foreground/50">
                    {s.answerSheets[0] ? `${s.answerSheets[0]._count.pages} pages` : "no sheet"}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <div className="mt-4 rounded-[var(--radius-md)] border border-border bg-surface p-3">
            <p className="mb-2 text-xs font-medium">Add student</p>
            <input
              value={newRoll}
              onChange={(e) => setNewRoll(e.target.value)}
              placeholder="Roll no"
              className="mb-2 w-full rounded-[var(--radius-sm)] border border-border bg-background px-2 py-1.5 text-sm"
            />
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Name"
              className="mb-2 w-full rounded-[var(--radius-sm)] border border-border bg-background px-2 py-1.5 text-sm"
            />
            <button
              onClick={addStudent}
              className="w-full rounded-[var(--radius-sm)] bg-accent px-3 py-1.5 text-sm font-medium text-white"
            >
              Add
            </button>
          </div>
        </aside>

        {/* Capture */}
        <section className="min-w-0 flex-1">
          {!activeStudent ? (
            <div className="rounded-[var(--radius-md)] border border-dashed border-border-strong bg-surface p-10 text-center text-sm text-foreground/60">
              Select a student to start capturing.
            </div>
          ) : (
            <>
              <div className="mb-4 flex items-center justify-between">
                <h2 className="text-sm font-medium">
                  <span className="mark">{activeStudent.rollNo}</span>
                  <span className="ml-2">{activeStudent.name}</span>
                  <span className="ml-2 text-xs text-foreground/50">{pages.length} pages</span>
                </h2>
                <div className="flex gap-2">
                  {!camOn ? (
                    <button
                      onClick={startCamera}
                      className="rounded-[var(--radius-sm)] bg-accent px-4 py-2 text-sm font-medium text-white"
                    >
                      Start camera
                    </button>
                  ) : (
                    <button
                      onClick={stopCamera}
                      className="rounded-[var(--radius-sm)] border border-border px-4 py-2 text-sm"
                    >
                      Stop camera
                    </button>
                  )}
                  <label className="cursor-pointer rounded-[var(--radius-sm)] border border-border px-4 py-2 text-sm hover:bg-surface-muted">
                    Upload file
                    <input
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) void uploadBlob(f);
                        e.target.value = "";
                      }}
                    />
                  </label>
                </div>
              </div>

              {camError && (
                <p role="alert" className="mb-3 text-xs text-bad">{camError}</p>
              )}

              {camOn && (
                <div className="mb-4 overflow-hidden rounded-[var(--radius-md)] border border-border bg-black">
                  <video ref={videoRef} className="max-h-[50vh] w-full object-contain" playsInline muted />
                  <div className="flex justify-center bg-surface p-3">
                    <button
                      onClick={capture}
                      disabled={capturing}
                      className="rounded-full bg-accent px-8 py-3 text-sm font-medium text-white transition-transform active:scale-95 disabled:opacity-50"
                    >
                      {capturing ? "Saving..." : "Capture page"}
                    </button>
                  </div>
                </div>
              )}

              {pages.length === 0 ? (
                <div className="rounded-[var(--radius-md)] border border-dashed border-border-strong bg-surface p-10 text-center text-sm text-foreground/60">
                  No pages captured yet. Use the camera or file upload above.
                </div>
              ) : (
                <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
                  {pages.map((p) => (
                    <li key={p.id} className="rounded-[var(--radius-md)] border border-border bg-surface p-2">
                      <div className="relative">
                        {/* eslint-disable-next-line @next/next/no-img-element -- dynamic /api image */}
                        <img
                          src={`/api/pages/${p.id}?thumb=1`}
                          alt={`Page ${p.pageNo}`}
                          className="aspect-[3/4] w-full rounded-[var(--radius-sm)] object-cover"
                          loading="lazy"
                        />
                        <span className="mark absolute left-2 top-2 rounded bg-black/70 px-2 py-0.5 text-xs font-semibold text-white">
                          {p.pageNo}
                        </span>
                      </div>
                      {p.qcFlags.length > 0 && (
                        <div className="mt-1 flex flex-wrap gap-1">
                          {p.qcFlags.map((f) => (
                            <span key={f} className="rounded-full bg-review-bg px-2 py-0.5 text-[11px] font-medium text-review">
                              {QC_LABEL[f] ?? f}
                            </span>
                          ))}
                        </div>
                      )}
                      <div className="mt-1 flex gap-1 text-xs">
                        <button onClick={() => movePage(p, -1)} disabled={p.pageNo === 1} className="rounded px-2 py-1 hover:bg-surface-muted disabled:opacity-30" title="Move earlier">↑</button>
                        <button onClick={() => movePage(p, 1)} disabled={p.pageNo === pages.length} className="rounded px-2 py-1 hover:bg-surface-muted disabled:opacity-30" title="Move later">↓</button>
                        <button onClick={() => rotatePage(p)} className="rounded px-2 py-1 hover:bg-surface-muted" title="Rotate 90°">⟳</button>
                        <button onClick={() => deletePage(p)} className="ml-auto rounded px-2 py-1 text-bad hover:bg-bad-bg" title="Delete page">✕</button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </section>
      </div>
    </main>
  );
}
