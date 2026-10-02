"use client";

import { useRef, useState } from "react";

const ACCEPT: Record<string, string> = {
  paper: ".pdf,.png,.jpg,.jpeg,.webp",
  scheme: ".pdf,.png,.jpg,.jpeg",
};

// Upload card with drag-drop, progress, and ingest status polling.
export function UploadCard({
  examId,
  kind,
  title,
  hint,
  onDone,
}: {
  examId: string;
  kind: "paper" | "scheme";
  title: string;
  hint: string;
  onDone: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function upload(files: FileList | File[]) {
    const list = [...files];
    if (list.length === 0) return;
    setError(null);
    setUploading(true);
    try {
      const form = new FormData();
      for (const f of list) form.append("files", f);
      const res = await fetch(`/api/exams/${examId}/${kind}`, {
        method: "POST",
        body: form,
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Upload failed");
        return;
      }
      onDone();
    } catch {
      setError("Network error during upload");
    } finally {
      setUploading(false);
    }
  }

  return (
    <div
      className={[
        "rounded-[var(--radius-md)] border bg-surface p-5",
        dragging ? "border-accent" : "border-border",
      ].join(" ")}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        void upload(e.dataTransfer.files);
      }}
    >
      <h3 className="text-sm font-medium">{title}</h3>
      <p className="mt-1 text-xs text-foreground/60">{hint}</p>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT[kind]}
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files) void upload(e.target.files);
          e.target.value = "";
        }}
      />
      <button
        onClick={() => inputRef.current?.click()}
        disabled={uploading}
        className="mt-4 rounded-[var(--radius-sm)] bg-accent px-4 py-2 text-sm font-medium text-white transition-transform active:scale-[0.98] disabled:opacity-50"
      >
        {uploading ? "Uploading..." : "Choose files"}
      </button>
      {error && (
        <p role="alert" className="mt-3 text-xs text-bad">
          {error}
        </p>
      )}
    </div>
  );
}
