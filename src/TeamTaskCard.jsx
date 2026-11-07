import { ToolCallCard } from "./components/affect-ui/tool-call-card.tsx";
import { Robot } from "@phosphor-icons/react";
import "./team-task-card.css";

// Task purpose and public findings belong in the reader. Execution IDs, raw
// arguments, scheduling metrics and compiler traces stay in diagnostic tooling.
export function TeamTaskCard({
  task,
  runStatus,
  roleLabel,
  statusLabel,
  children,
}) {
  const active = ["queued", "running", "waiting", "submitted"].includes(
    task.status,
  );
  let state = task.status === "completed" ? "returned" : "unknown";
  let label = statusLabel || "待确认";
  if (active && runStatus === "running") {
    state = task.status === "running" ? "running" : "pending";
  } else if (active) {
    label = runStatus === "paused" ? "已暂停" : "待确认";
  } else if (task.status === "cancelled") {
    state = "cancelled";
  }
  return (
    <div className="team-task-card">
      <ToolCallCard
        key={`${task.id}/${task.version}`}
        name={task.title}
        summary={roleLabel}
        icon={<Robot size={16} />}
        status={state}
        statusLabel={label}
        showDuration={false}
        collapsible={false}
      />
    </div>
  );
}
