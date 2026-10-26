"use client";

import { useEffect, useState } from "react";
import { formatUpdated, type ProjectSummary } from "@/lib/corridor/storage";
import { cn } from "@/lib/utils";

type Props = {
  open: boolean;
  projects: ProjectSummary[];
  activeId: string | null;
  onClose: () => void;
  onOpen: (id: string) => void;
  onCreate: (name: string) => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  onDuplicate: (id: string) => void;
};

export function ProjectDrawer({ open, projects, activeId, onClose, onOpen, onCreate, onRename, onDelete, onDuplicate }: Props) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("Untitled Earthwork Project");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return (
    <>
      <button
        type="button"
        aria-label="Close projects"
        className={cn("fixed inset-0 z-[55] bg-black/45 transition-opacity", open ? "opacity-100" : "pointer-events-none opacity-0")}
        onClick={onClose}
      />
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-[60] flex w-72 flex-col border-r border-white/10 bg-[#101214] shadow-2xl transition-transform duration-200",
          open ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div className="flex items-center justify-between border-b border-white/[0.06] px-3 py-2">
          <div className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted">Projects</div>
          <button type="button" onClick={onClose} className="rounded px-2 py-1 text-[12px] text-muted hover:text-foreground">
            Close
          </button>
        </div>
        <ul className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2">
          {projects.length === 0 && <li className="px-2 py-3 text-[12px] text-muted">No saved projects yet.</li>}
          {projects.map((project) => {
            const active = project.id === activeId;
            return (
              <li key={project.id} className={cn("rounded-md px-2 py-2", active ? "bg-white/[0.06]" : "hover:bg-white/[0.03]")}>
                {renamingId === project.id ? (
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      const next = renameValue.trim();
                      if (next) onRename(project.id, next);
                      setRenamingId(null);
                    }}
                  >
                    <input
                      autoFocus
                      value={renameValue}
                      onChange={(event) => setRenameValue(event.target.value)}
                      className="w-full rounded border border-white/10 bg-transparent px-2 py-1 text-[13px] outline-none focus:border-accent"
                    />
                  </form>
                ) : (
                  <button type="button" onClick={() => onOpen(project.id)} className="block w-full text-left">
                    <div className={cn("text-[13px]", active ? "text-accent" : "text-foreground")}>{project.name}</div>
                    <div className="mt-0.5 text-[11px] text-muted">
                      {project.stationCount} {project.stationCount === 1 ? "station" : "stations"}
                    </div>
                    <div className="text-[11px] text-muted">{formatUpdated(project.updatedAt)}</div>
                  </button>
                )}
                <div className="mt-1 flex gap-2 text-[11px]">
                  <button type="button" className="text-muted hover:text-foreground" onClick={() => onDuplicate(project.id)}>
                    Duplicate
                  </button>
                  <button
                    type="button"
                    className="text-muted hover:text-foreground"
                    onClick={() => {
                      setRenamingId(project.id);
                      setRenameValue(project.name);
                    }}
                  >
                    Rename
                  </button>
                  <button
                    type="button"
                    className="text-muted hover:text-cut"
                    onClick={() => setConfirmDeleteId(project.id)}
                  >
                    Delete
                  </button>
                  {confirmDeleteId === project.id && (
                    <button type="button" className="text-cut" onClick={() => onDelete(project.id)}>
                      Confirm delete
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
        <div className="border-t border-white/[0.06] p-2">
          {creating ? (
            <form
              className="space-y-2"
              onSubmit={(event) => {
                event.preventDefault();
                onCreate(name.trim() || "Untitled Earthwork Project");
                setCreating(false);
                setName("Untitled Earthwork Project");
              }}
            >
              <label className="block text-[11px] text-muted" htmlFor="new-project-name">
                Project name
              </label>
              <input
                id="new-project-name"
                autoFocus
                value={name}
                onChange={(event) => setName(event.target.value)}
                className="w-full rounded-md border border-white/10 bg-transparent px-2 py-1.5 text-[13px] outline-none focus:border-accent"
              />
              <div className="flex gap-2">
                <button type="submit" className="rounded-md bg-accent px-2 py-1 text-[12px] font-medium text-black">
                  Create
                </button>
                <button type="button" onClick={() => setCreating(false)} className="rounded-md bg-white/10 px-2 py-1 text-[12px]">
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="w-full rounded-md bg-white/10 px-2 py-2 text-left text-[13px] hover:bg-white/15"
            >
              + New Project
            </button>
          )}
        </div>
      </aside>
    </>
  );
}
